/**
 * PhaseExecutor — executes coding and review phases.
 * Extracted from OrchestratorService for clarity and testability.
 */

import fs from "fs/promises";
import path from "path";
import type { ActiveTaskConfig, ReviewAngle } from "@opensprint/shared";
import {
  OPENSPRINT_PATHS,
  resolveTestCommand,
  getAgentForComplexity,
  getProviderForAgentType,
  type PlanComplexity,
} from "@opensprint/shared";
import type { StoredTask } from "./task-store.service.js";
import type { BranchManager } from "./branch-manager.js";
import type { ContextAssembler } from "./context-assembler.js";
import type { SessionManager } from "./session-manager.js";
import type { TestRunner } from "./test-runner.js";
import type { AgentLifecycleManager } from "./agent-lifecycle.js";
import type { TaskContext } from "./context-assembler.js";
import { shouldInvokeSummarizer } from "./summarizer.service.js";
import { getComplexityForAgent } from "./plan-complexity.js";
import { agentIdentityService } from "./agent-identity.service.js";
import { eventLogService } from "./event-log.service.js";
import { writeJsonAtomic } from "../utils/file-utils.js";
import { assertSafeTaskWorktreePath } from "../utils/path-safety.js";
import { getNextKey } from "./api-key-resolver.service.js";
import { markExhausted } from "./api-key-exhausted.service.js";
import type {
  AgentSlotLike,
  PhaseExecutorCallbacks,
  RetryContext,
  TaskAssignmentLike,
} from "./orchestrator-phase-context.js";
import type { AgentRunState } from "./agent-lifecycle.js";
import { TimerRegistry } from "./timer-registry.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("phase-executor");

export interface PhaseExecutorHost {
  getState(projectId: string): {
    slots: Map<string, { agent: AgentRunState; timers: TimerRegistry } & AgentSlotLike>;
    status: { queueDepth: number };
  };
  taskStore: import("./task-store.service.js").TaskStoreService;
  projectService: import("./project.service.js").ProjectService;
  branchManager: BranchManager;
  contextAssembler: ContextAssembler;
  sessionManager: SessionManager;
  testRunner: TestRunner;
  lifecycleManager: AgentLifecycleManager;
  persistCounters(projectId: string, repoPath: string): Promise<void>;
  preflightCheck(
    repoPath: string,
    wtPath: string,
    taskId: string,
    reviewAngles?: ReviewAngle[]
  ): Promise<void>;
  runSummarizer(
    projectId: string,
    settings: import("@opensprint/shared").ProjectSettings,
    taskId: string,
    context: TaskContext,
    repoPath: string,
    planComplexity?: PlanComplexity
  ): Promise<TaskContext>;
  getCachedSummarizerContext(projectId: string, taskId: string): TaskContext | undefined;
  setCachedSummarizerContext(projectId: string, taskId: string, context: TaskContext): void;
  buildReviewHistory(repoPath: string, taskId: string): Promise<string>;
  onAgentStateChange(projectId: string): () => void;
}

export class PhaseExecutorService {
  constructor(
    private host: PhaseExecutorHost,
    private callbacks: PhaseExecutorCallbacks
  ) {}

  private createAgentRunState(startedAt: string): AgentRunState {
    return {
      activeProcess: null,
      lastOutputTime: 0,
      lastOutputAtIso: undefined,
      outputLog: [],
      outputLogBytes: 0,
      outputParseBuffer: "",
      activeToolCallIds: new Set<string>(),
      activeToolCallSummaries: new Map<string, string | null>(),
      startedAt,
      exitHandled: false,
      killedDueToTimeout: false,
      lifecycleState: "running",
      suspendedAtIso: undefined,
      suspendReason: undefined,
      suspendDeadlineMs: undefined,
    };
  }

  async executeCodingPhase(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    slot: AgentSlotLike & { agent: AgentRunState; timers: TimerRegistry },
    retryContext?: RetryContext
  ): Promise<void> {
    const settings = await this.host.projectService.getSettings(projectId);
    const branchName = slot.branchName;
    const gitWorkingMode = settings.gitWorkingMode ?? "worktree";
    const baseBranch =
      gitWorkingMode === "worktree"
        ? (settings.worktreeBaseBranch ?? "main")
        : "main";

    // Pre-flight: ensure API key available before any heavy work
    const complexity = await getComplexityForAgent(projectId, repoPath, task, this.host.taskStore);
    const agentConfig = getAgentForComplexity(settings, complexity);
    const provider = getProviderForAgentType(agentConfig.type);
    if (provider) {
      const resolved = await getNextKey(projectId, provider);
      if (!resolved || !resolved.key.trim()) {
        log.warn("No API key available for provider, stopping queue", {
          projectId,
          taskId: task.id,
          provider,
        });
        markExhausted(projectId, provider);
        if (this.callbacks.handleApiKeysExhausted) {
          await this.callbacks.handleApiKeysExhausted(
            projectId,
            repoPath,
            task,
            branchName,
            provider
          );
        }
        return;
      }
    }

    try {
      let wtPath: string;
      if (gitWorkingMode === "branches") {
        if (!retryContext?.useExistingBranch) {
          await this.host.branchManager.syncMainWithOrigin(repoPath, baseBranch);
        }
        await this.host.branchManager.createOrCheckoutBranch(repoPath, branchName, baseBranch);
        wtPath = repoPath;
        await this.host.branchManager.ensureRepoNodeModules(repoPath);
      } else {
        if (!retryContext?.useExistingBranch) {
          await this.host.branchManager.syncMainWithOrigin(repoPath, baseBranch);
        }
        wtPath = await this.host.branchManager.createTaskWorktree(repoPath, task.id, baseBranch);
        assertSafeTaskWorktreePath(repoPath, task.id, wtPath);
      }
      (slot as { worktreePath: string | null }).worktreePath = wtPath;

      if (retryContext?.useExistingBranch) {
        await this.host.branchManager.waitForGitReady(wtPath);
        try {
          await this.host.branchManager.rebaseOntoMain(wtPath, baseBranch);
          log.info("Rebased existing branch onto base before retry", {
            taskId: task.id,
            baseBranch,
          });
        } catch {
          const conflictedFiles = await this.host.branchManager
            .getConflictedFiles(wtPath)
            .catch(() => []);
          await this.host.branchManager.rebaseAbort(wtPath);
          await this.host.taskStore.setConflictFiles(projectId, task.id, conflictedFiles);
          await this.host.taskStore.setMergeStage(projectId, task.id, "rebase_before_merge");
          log.info("Rebase onto main had conflicts, agent will work from diverged state", {
            taskId: task.id,
            conflictedFiles,
          });
        }
      }

      await this.host.preflightCheck(repoPath, wtPath, task.id, undefined);

      let context: TaskContext = await this.host.contextAssembler.buildContext(
        projectId,
        repoPath,
        task.id,
        this.host.taskStore,
        this.host.branchManager,
        { task, baseBranch }
      );

      if (shouldInvokeSummarizer(context)) {
        const cached = retryContext && this.host.getCachedSummarizerContext(projectId, task.id);
        if (cached) {
          context = cached;
          log.info("Using cached Summarizer context for retry", { taskId: task.id });
        } else {
          const planComplexity = await getComplexityForAgent(
            projectId,
            repoPath,
            task,
            this.host.taskStore
          );
          context = await this.host.runSummarizer(
            projectId,
            settings,
            task.id,
            context,
            repoPath,
            planComplexity
          );
          this.host.setCachedSummarizerContext(projectId, task.id, context);
        }
      }

      const config: ActiveTaskConfig = {
        invocation_id: task.id,
        agent_role: "coder",
        taskId: task.id,
        repoPath: wtPath,
        branch: branchName,
        testCommand: resolveTestCommand(settings) || 'echo "No test command configured"',
        attempt: slot.attempt,
        phase: "coding",
        previousFailure: retryContext?.previousFailure ?? null,
        reviewFeedback: retryContext?.reviewFeedback ?? null,
        previousTestOutput: retryContext?.previousTestOutput ?? null,
        previousDiff: retryContext?.previousDiff ?? null,
        useExistingBranch: retryContext?.useExistingBranch ?? false,
        hilConfig: settings.hilConfig,
        aiAutonomyLevel: settings.aiAutonomyLevel,
      };

      await this.host.contextAssembler.assembleTaskDirectory(wtPath, task.id, config, context);

      const taskDir = this.host.sessionManager.getActiveDir(wtPath, task.id);
      const promptPath = path.join(taskDir, "prompt.md");

      const complexity = await getComplexityForAgent(
        projectId,
        repoPath,
        task,
        this.host.taskStore
      );
      let agentConfig = getAgentForComplexity(settings, complexity);

      if (retryContext?.failureType && slot.attempt > 1) {
        const recentAttempts = await agentIdentityService.getRecentAttempts(repoPath, task.id);
        agentConfig = agentIdentityService.selectAgentForRetry(
          settings,
          task.id,
          slot.attempt,
          retryContext.failureType,
          complexity,
          recentAttempts
        );
      }

      const assignment: TaskAssignmentLike = {
        taskId: task.id,
        projectId,
        phase: "coding",
        branchName,
        worktreePath: wtPath,
        promptPath,
        agentConfig,
        attempt: slot.attempt,
        retryContext,
        createdAt: new Date().toISOString(),
      };
      // Set startedAt before agent spawn so getActiveAgents returns correct elapsed time from first frame (no 0s flash)
      slot.agent.startedAt = assignment.createdAt;
      await writeJsonAtomic(path.join(taskDir, OPENSPRINT_PATHS.assignment), assignment);
      // Also write to main repo so crash recovery finds it (worktree base can differ after restart via os.tmpdir())
      const mainRepoActiveDir = this.host.sessionManager.getActiveDir(repoPath, task.id);
      await fs.mkdir(mainRepoActiveDir, { recursive: true });
      await writeJsonAtomic(path.join(mainRepoActiveDir, OPENSPRINT_PATHS.assignment), assignment);

      this.host.lifecycleManager.run(
        {
          projectId,
          taskId: task.id,
          repoPath,
          phase: "coding",
          wtPath,
          branchName,
          promptPath,
          agentConfig,
          attempt: slot.attempt,
          agentLabel: slot.taskTitle ?? task.id,
          role: "coder",
          onDone: (code) =>
            this.callbacks.handleCodingDone(projectId, repoPath, task, branchName, code),
          onStateChange: this.host.onAgentStateChange(projectId),
        },
        slot.agent,
        slot.timers
      );

      eventLogService
        .append(repoPath, {
          timestamp: new Date().toISOString(),
          projectId,
          taskId: task.id,
          event: "agent.spawned",
          data: { phase: "coding", model: agentConfig.model, attempt: slot.attempt },
        })
        .catch(() => {});

      await this.host.persistCounters(projectId, repoPath);
    } catch (error) {
      log.error(`Coding phase failed for task ${task.id}`, { error });
      await this.callbacks.handleTaskFailure(
        projectId,
        repoPath,
        task,
        branchName,
        String(error),
        null,
        "agent_crash"
      );
    }
  }

  async executeReviewPhase(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string
  ): Promise<void> {
    const state = this.host.getState(projectId);
    const slot = state.slots.get(task.id);
    if (!slot) {
      log.warn("executeReviewPhase: no slot found for task", { taskId: task.id });
      return;
    }
    const settings = await this.host.projectService.getSettings(projectId);
    const gitWorkingMode = settings.gitWorkingMode ?? "worktree";
    const baseBranch =
      gitWorkingMode === "worktree"
        ? (settings.worktreeBaseBranch ?? "main")
        : "main";
    const wtPath = slot.worktreePath ?? repoPath;
    if (wtPath !== repoPath) {
      assertSafeTaskWorktreePath(repoPath, task.id, wtPath);
    }
    const reviewAngles = [
      ...new Set((settings.reviewAngles ?? []).filter(Boolean)),
    ] as ReviewAngle[];
    const useAngleSpecificReview = reviewAngles.length > 0;

    try {
      await this.host.preflightCheck(
        repoPath,
        wtPath,
        task.id,
        settings.reviewAngles && settings.reviewAngles.length > 0
          ? settings.reviewAngles
          : undefined
      );

      const config: ActiveTaskConfig = {
        invocation_id: task.id,
        agent_role: "reviewer",
        taskId: task.id,
        repoPath: wtPath,
        branch: branchName,
        testCommand: resolveTestCommand(settings) || 'echo "No test command configured"',
        attempt: slot.attempt,
        phase: "review",
        previousFailure: null,
        reviewFeedback: null,
        hilConfig: settings.hilConfig,
        aiAutonomyLevel: settings.aiAutonomyLevel,
        ...(settings.reviewAngles &&
          settings.reviewAngles.length > 0 && { reviewAngles: settings.reviewAngles }),
      };

      const taskDir = this.host.sessionManager.getActiveDir(wtPath, task.id);
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, "config.json"), JSON.stringify(config, null, 2));

      const context = await this.host.contextAssembler.buildContext(
        projectId,
        repoPath,
        task.id,
        this.host.taskStore,
        this.host.branchManager,
        { task, baseBranch }
      );

      context.reviewHistory = await this.host.buildReviewHistory(repoPath, task.id);
      context.branchDiff = await this.host.branchManager.captureBranchDiff(
        repoPath,
        branchName,
        baseBranch
      );

      await this.host.contextAssembler.assembleTaskDirectory(wtPath, task.id, config, context);

      const complexity = await getComplexityForAgent(
        projectId,
        repoPath,
        task,
        this.host.taskStore
      );
      const agentConfig = getAgentForComplexity(settings, complexity);

      // Pre-flight: ensure API key available before spawning review agent
      const provider = getProviderForAgentType(agentConfig.type);
      if (provider) {
        const resolved = await getNextKey(projectId, provider);
        if (!resolved || !resolved.key.trim()) {
          log.warn("No API key available for review agent, stopping queue", {
            projectId,
            taskId: task.id,
            provider,
          });
          markExhausted(projectId, provider);
          if (this.callbacks.handleApiKeysExhausted) {
            await this.callbacks.handleApiKeysExhausted(
              projectId,
              repoPath,
              task,
              branchName,
              provider
            );
          }
          return;
        }
      }

      const assignment: TaskAssignmentLike = {
        taskId: task.id,
        projectId,
        phase: "review",
        branchName,
        worktreePath: wtPath,
        promptPath: useAngleSpecificReview
          ? path.join(taskDir, "review-angles", reviewAngles[0]!, "prompt.md")
          : path.join(taskDir, "prompt.md"),
        agentConfig,
        attempt: slot.attempt,
        createdAt: new Date().toISOString(),
      };
      // Set startedAt before agent spawn so getActiveAgents returns correct elapsed time from first frame (no 0s flash)
      slot.agent.startedAt = assignment.createdAt;
      await writeJsonAtomic(path.join(taskDir, OPENSPRINT_PATHS.assignment), assignment);
      const mainRepoActiveDirReview = this.host.sessionManager.getActiveDir(repoPath, task.id);
      await fs.mkdir(mainRepoActiveDirReview, { recursive: true });
      await writeJsonAtomic(
        path.join(mainRepoActiveDirReview, OPENSPRINT_PATHS.assignment),
        assignment
      );

      if (useAngleSpecificReview) {
        slot.reviewAgents = new Map();
        await Promise.all(
          reviewAngles.map(async (angle) => {
            const angleDir = path.join(taskDir, "review-angles", angle);
            const anglePromptPath = path.join(angleDir, "prompt.md");
            const angleAssignment: TaskAssignmentLike = {
              ...assignment,
              promptPath: anglePromptPath,
              angle,
            };

            await fs.mkdir(angleDir, { recursive: true });
            await writeJsonAtomic(
              path.join(angleDir, OPENSPRINT_PATHS.assignment),
              angleAssignment
            );

            const mainRepoAngleDir = path.join(mainRepoActiveDirReview, "review-angles", angle);
            await fs.mkdir(mainRepoAngleDir, { recursive: true });
            await writeJsonAtomic(
              path.join(mainRepoAngleDir, OPENSPRINT_PATHS.assignment),
              angleAssignment
            );

            const angleAgent = this.createAgentRunState(angleAssignment.createdAt);
            const angleTimers = new TimerRegistry();
            slot.reviewAgents?.set(angle, { angle, agent: angleAgent, timers: angleTimers });

            const angleOutputLogPath = path.join(
              wtPath,
              OPENSPRINT_PATHS.active,
              task.id,
              "review-angles",
              angle,
              OPENSPRINT_PATHS.agentOutputLog
            );
            const angleHeartbeatSubpath = `review-angles/${angle}`;

            this.host.lifecycleManager.run(
              {
                projectId,
                taskId: task.id,
                repoPath,
                phase: "review",
                wtPath,
                branchName,
                promptPath: anglePromptPath,
                agentConfig,
                attempt: slot.attempt,
                agentLabel: slot.taskTitle ?? task.id,
                role: "reviewer",
                onDone: (code) =>
                  this.callbacks.handleReviewDone(
                    projectId,
                    repoPath,
                    task,
                    branchName,
                    code,
                    angle
                  ),
                onStateChange: this.host.onAgentStateChange(projectId),
                outputLogPath: angleOutputLogPath,
                heartbeatSubpath: angleHeartbeatSubpath,
              },
              angleAgent,
              angleTimers
            );

            eventLogService
              .append(repoPath, {
                timestamp: new Date().toISOString(),
                projectId,
                taskId: task.id,
                event: "agent.spawned",
                data: { phase: "review", model: agentConfig.model, attempt: slot.attempt, angle },
              })
              .catch(() => {});
          })
        );
      } else {
        slot.reviewAgents = undefined;
        this.host.lifecycleManager.run(
          {
            projectId,
            taskId: task.id,
            repoPath,
            phase: "review",
            wtPath,
            branchName,
            promptPath: path.join(taskDir, "prompt.md"),
            agentConfig,
            attempt: slot.attempt,
            agentLabel: slot.taskTitle ?? task.id,
            role: "reviewer",
            onDone: (code) =>
              this.callbacks.handleReviewDone(projectId, repoPath, task, branchName, code),
            onStateChange: this.host.onAgentStateChange(projectId),
          },
          slot.agent,
          slot.timers
        );

        eventLogService
          .append(repoPath, {
            timestamp: new Date().toISOString(),
            projectId,
            taskId: task.id,
            event: "agent.spawned",
            data: { phase: "review", model: agentConfig.model, attempt: slot.attempt },
          })
          .catch(() => {});
      }

      await this.host.persistCounters(projectId, repoPath);
    } catch (error) {
      log.error(`Review phase failed for task ${task.id}`, { error });
      await this.callbacks.handleTaskFailure(
        projectId,
        repoPath,
        task,
        branchName,
        String(error),
        null,
        "agent_crash"
      );
    }
  }
}
