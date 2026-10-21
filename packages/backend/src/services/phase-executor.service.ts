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
  type AgentConfig,
  type PlanComplexity,
  type ProjectSettings,
} from "@opensprint/shared";
import type { StoredTask } from "./task-store.service.js";
import {
  RebaseConflictError,
  RebaseContinueBlockedError,
  type BranchManager,
} from "./branch-manager.js";
import type { ContextAssembler } from "./context-assembler.js";
import type { SessionManager } from "./session-manager.js";
import type { TestRunner } from "./test-runner.js";
import type { AgentLifecycleManager } from "./agent-lifecycle.js";
import type { TaskContext } from "./context-assembler.js";
import { shouldInvokeSummarizer } from "./summarizer.service.js";
import { getComplexityForAgent } from "./plan-complexity.js";
import { agentIdentityService, buildAgentAttemptId } from "./agent-identity.service.js";
import { eventLogService } from "./event-log.service.js";
import { writeJsonAtomic } from "../utils/file-utils.js";
import { assertSafeTaskWorktreePath } from "../utils/path-safety.js";
import { getNextKey } from "./api-key-resolver.service.js";
import { markExhausted } from "./api-key-exhausted.service.js";
import type {
  AgentSlotLike,
  PhaseExecutorCallbacks,
  ReviewRetryTarget,
  RetryContext,
  TaskAssignmentLike,
} from "./orchestrator-phase-context.js";
import type { AgentRunState } from "./agent-lifecycle.js";
import { TimerRegistry } from "./timer-registry.js";
import { createLogger } from "../utils/logger.js";
import { fireAndForget } from "../utils/fire-and-forget.js";
import { RepoPreflightError, resolveBaseBranch } from "../utils/git-repo-state.js";
import { resolveExecuteReplayMetadata } from "./execute-replay-metadata.service.js";
import { getMergeQualityGateCommands } from "./merge-quality-gates.js";
import { isWorktreeCheckoutUsable, IncompleteWorktreeError } from "../utils/worktree-health.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";

const log = createLogger("phase-executor");

/** Keep in sync with `MAX_PRE_VALIDATION_REBASE_MERGER_ROUNDS` in orchestrator.service.ts. */
const MAX_RETRY_PATH_REBASE_MERGER_ROUNDS = 12;

export interface PhaseExecutorHost {
  getState(projectId: string): {
    slots: Map<string, { agent: AgentRunState; timers: TimerRegistry } & AgentSlotLike>;
    status: { queueDepth: number };
  };
  hasActiveTask(projectId: string, taskId: string): boolean;
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
    baseBranch?: string,
    reviewAngles?: ReviewAngle[],
    clearGeneralResult?: boolean
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
  runMergerAgentAndWait(options: {
    projectId: string;
    cwd: string;
    config: AgentConfig;
    phase: "rebase_before_merge" | "merge_to_main" | "push_rebase";
    taskId: string;
    branchName: string;
    conflictedFiles: string[];
    testCommand?: string;
    mergeQualityGates?: string[];
    baseBranch?: string;
  }): Promise<boolean>;
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
      activeToolCallStartedAtMs: new Map<string, number>(),
      startedAt,
      firstOutputAtIso: undefined,
      exitHandled: false,
      killedDueToTimeout: false,
      lifecycleState: "running",
      suspendedAtIso: undefined,
      suspendReason: undefined,
      suspendDeadlineMs: undefined,
    };
  }

  private formatRepoPreflightFailure(error: RepoPreflightError): string {
    const commands =
      Array.isArray(error.commands) && error.commands.length > 0
        ? ` Suggested commands: ${error.commands.join(" ; ")}`
        : "";
    return `[${error.code}] ${error.message}${commands}`;
  }

  private static readonly PREFLIGHT_ERROR_CODES: ReadonlySet<string> = new Set([
    ErrorCodes.GIT_BASE_BRANCH_INVALID,
    ErrorCodes.GIT_CHECKOUT_CONFLICT,
    ErrorCodes.GIT_REF_MISSING,
    ErrorCodes.GIT_REMOTE_UNREACHABLE,
  ]);

  private classifyPhaseError(error: unknown): {
    failureType: "repo_preflight" | "workspace_invalid" | "agent_crash";
    failureReason: string;
  } {
    if (error instanceof RepoPreflightError) {
      return {
        failureType: "repo_preflight",
        failureReason: this.formatRepoPreflightFailure(error),
      };
    }
    if (error instanceof IncompleteWorktreeError) {
      return {
        failureType: "workspace_invalid",
        failureReason: String(error),
      };
    }
    if (error instanceof AppError && PhaseExecutorService.PREFLIGHT_ERROR_CODES.has(error.code)) {
      const details = error.details as Record<string, unknown> | undefined;
      const detail = details?.detail ? ` (${String(details.detail).slice(0, 200)})` : "";
      return {
        failureType: "repo_preflight",
        failureReason: `[${error.code}] ${error.message}${detail}`,
      };
    }
    return {
      failureType: "agent_crash",
      failureReason: String(error),
    };
  }

  private isTaskStillActive(projectId: string, taskId: string): boolean {
    return this.host.hasActiveTask(projectId, taskId);
  }

  private isBaselineQualityGateTask(task: StoredTask): boolean {
    const record = task as Record<string, unknown>;
    return (
      record.source === "self-improvement" &&
      (record.selfImprovementKind === "baseline-quality-gate" ||
        record.baselineQualityGateSource === "merge-quality-gate-baseline")
    );
  }

  /**
   * Some retry paths reuse an existing task worktree. If that path was cleaned up in the
   * meantime, assembling `.opensprint/active/...` can recreate only runtime files and leave
   * no source checkout. Guard against that by requiring a valid git checkout marker.
   */
  private async hasUsableExistingWorktree(repoPath: string, wtPath: string): Promise<boolean> {
    return isWorktreeCheckoutUsable(repoPath, wtPath);
  }

  /**
   * Run merger + rebase --continue rounds until the retry-path rebase completes or the task fails.
   * @returns false if merge_conflict was reported via handleTaskFailure (caller should return).
   */
  private async resolveRetryRebaseConflictsWithMerger(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    wtPath: string,
    baseBranch: string,
    branchName: string,
    initialConflict: RebaseConflictError,
    settings: ProjectSettings
  ): Promise<boolean> {
    const mergerConfig = settings.simpleComplexityAgent as AgentConfig;
    const mergerTestCommand = resolveTestCommand(settings) || undefined;
    const mergerQualityGates = getMergeQualityGateCommands(settings.toolchainProfile);

    let rebaseConflict: RebaseConflictError | null = initialConflict;
    let round = 0;

    while (rebaseConflict) {
      round += 1;
      const conflictedFiles = rebaseConflict.conflictedFiles;
      if (round > MAX_RETRY_PATH_REBASE_MERGER_ROUNDS) {
        await this.host.branchManager.rebaseAbort(wtPath).catch((err: unknown) => {
          log.warn("rebase abort failed", {
            err: err instanceof Error ? err.message : String(err),
          });
        });
        await this.host.taskStore.setConflictFiles(projectId, task.id, conflictedFiles);
        await this.host.taskStore.setMergeStage(projectId, task.id, "rebase_before_merge");
        await this.callbacks.handleTaskFailure(
          projectId,
          repoPath,
          task,
          branchName,
          `Rebase onto ${baseBranch} before coding retry: unresolved after ${MAX_RETRY_PATH_REBASE_MERGER_ROUNDS} merger rounds (conflicts: ${conflictedFiles.join(", ")})`,
          null,
          "merge_conflict"
        );
        return false;
      }

      log.info("Retry-path rebase conflict, invoking merger agent", {
        taskId: task.id,
        branchName,
        conflictedFiles,
        round,
      });
      await this.host.taskStore.setConflictFiles(projectId, task.id, conflictedFiles);
      if (round === 1) {
        await this.host.taskStore.setMergeStage(projectId, task.id, "rebase_before_merge");
      }

      const resolved = await this.host.runMergerAgentAndWait({
        projectId,
        cwd: wtPath,
        config: mergerConfig,
        phase: "rebase_before_merge",
        taskId: task.id,
        branchName,
        conflictedFiles,
        testCommand: mergerTestCommand,
        mergeQualityGates: mergerQualityGates,
        baseBranch,
      });
      if (!resolved) {
        await this.host.branchManager.rebaseAbort(wtPath).catch((err: unknown) => {
          log.warn("rebase abort failed", {
            err: err instanceof Error ? err.message : String(err),
          });
        });
        await this.callbacks.handleTaskFailure(
          projectId,
          repoPath,
          task,
          branchName,
          `Rebase onto ${baseBranch} before coding retry: merger could not resolve conflicts (${conflictedFiles.join(", ")})`,
          null,
          "merge_conflict"
        );
        return false;
      }

      fireAndForget(
        eventLogService.append(repoPath, {
          timestamp: new Date().toISOString(),
          projectId,
          taskId: task.id,
          event: "merge.resolved",
          data: {
            stage: "rebase_before_merge",
            branchName,
            conflictedFiles,
            resolvedBy: "merger",
            round,
            context: "coding_retry",
          },
        }),
        "phase-executor:merge.resolved"
      );

      try {
        await this.host.branchManager.rebaseContinue(wtPath);
        rebaseConflict = null;
      } catch (continueErr) {
        if (continueErr instanceof RebaseConflictError) {
          rebaseConflict = continueErr;
        } else if (continueErr instanceof RebaseContinueBlockedError) {
          const d = continueErr.diagnostics;
          if (
            (d.cause === "preflight_unmerged" || d.cause === "preflight_staged_markers") &&
            d.conflictedFiles.length > 0
          ) {
            log.info("merge.merger_rebase_continue_skipped_preflight", {
              taskId: task.id,
              branchName,
              round,
              conflictedFiles: d.conflictedFiles,
              rebaseMetadataPresent: d.rebaseMetadataPresent,
              context: "coding_retry",
            });
            rebaseConflict = new RebaseConflictError(d.conflictedFiles);
          } else {
            await this.host.branchManager.rebaseAbort(wtPath).catch((err: unknown) => {
              log.warn("rebase abort failed", {
                err: err instanceof Error ? err.message : String(err),
              });
            });
            await this.callbacks.handleTaskFailure(
              projectId,
              repoPath,
              task,
              branchName,
              `Rebase onto ${baseBranch} before coding retry: ${continueErr.message}`,
              null,
              "merge_conflict"
            );
            return false;
          }
        } else {
          const cf = await this.host.branchManager.getConflictedFiles(wtPath);
          if (cf.length > 0) {
            rebaseConflict = new RebaseConflictError(cf);
          } else {
            await this.host.branchManager.rebaseAbort(wtPath).catch((err: unknown) => {
              log.warn("rebase abort failed", {
                err: err instanceof Error ? err.message : String(err),
              });
            });
            throw continueErr;
          }
        }
      }
    }

    await this.host.taskStore.setConflictFiles(projectId, task.id, []);
    await this.host.taskStore.setMergeStage(projectId, task.id, null);
    log.info("Rebased existing branch onto base before retry (after merger)", {
      taskId: task.id,
      baseBranch,
    });
    return true;
  }

  private promptHasActionableQualityGateContext(promptContent: string): boolean {
    const markers = [
      "Failed command:",
      "First actionable error:",
      "Failure reason:",
      "Condensed gate output:",
      "Quality Gate Failure",
    ];
    return markers.some((marker) => promptContent.includes(marker));
  }

  async executeCodingPhase(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    slot: AgentSlotLike & { agent: AgentRunState; timers: TimerRegistry },
    retryContext?: RetryContext
  ): Promise<void> {
    if (!this.isTaskStillActive(projectId, task.id)) {
      return;
    }

    const settings = await this.host.projectService.getSettings(projectId);
    const branchName = slot.branchName;
    const gitWorkingMode = settings.gitWorkingMode ?? "worktree";
    const baseBranch = await resolveBaseBranch(repoPath, settings.worktreeBaseBranch);

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
      slot.retryContext = retryContext;
      if (!this.isTaskStillActive(projectId, task.id)) {
        return;
      }

      let wtPath: string;
      if (gitWorkingMode === "branches") {
        if (!retryContext?.useExistingBranch) {
          await this.host.branchManager.syncMainWithOrigin(repoPath, baseBranch);
        }
        if (!this.isTaskStillActive(projectId, task.id)) {
          return;
        }
        await this.host.branchManager.createOrCheckoutBranch(repoPath, branchName, baseBranch);
        wtPath = repoPath;
        await this.host.branchManager.ensureRepoNodeModules(repoPath);
      } else {
        if (!retryContext?.useExistingBranch) {
          await this.host.branchManager.syncMainWithOrigin(repoPath, baseBranch);
        }
        if (!this.isTaskStillActive(projectId, task.id)) {
          return;
        }
        const worktreeOptions =
          slot.worktreeKey != null
            ? { worktreeKey: slot.worktreeKey, branchName: slot.branchName }
            : undefined;
        const canReuseExistingWorktree =
          retryContext?.useExistingBranch === true &&
          retryContext.structuredOutputRepairAttempted === true &&
          typeof slot.worktreePath === "string" &&
          slot.worktreePath.trim() !== "";
        if (canReuseExistingWorktree) {
          const candidatePath = slot.worktreePath!;
          assertSafeTaskWorktreePath(repoPath, task.id, candidatePath);
          if (await this.hasUsableExistingWorktree(repoPath, candidatePath)) {
            wtPath = candidatePath;
          } else {
            log.warn("Existing retry worktree is missing checkout files; recreating", {
              taskId: task.id,
              branchName: slot.branchName,
              worktreePath: candidatePath,
            });
            wtPath = await this.host.branchManager.createTaskWorktree(
              repoPath,
              task.id,
              baseBranch,
              worktreeOptions
            );
            assertSafeTaskWorktreePath(repoPath, task.id, wtPath);
          }
        } else {
          wtPath = await this.host.branchManager.createTaskWorktree(
            repoPath,
            task.id,
            baseBranch,
            worktreeOptions
          );
          assertSafeTaskWorktreePath(repoPath, task.id, wtPath);
        }
      }
      (slot as { worktreePath: string | null }).worktreePath = wtPath;

      if (!this.isTaskStillActive(projectId, task.id)) {
        return;
      }

      if (wtPath !== repoPath) {
        const wtUsable = await this.hasUsableExistingWorktree(repoPath, wtPath);
        if (!wtUsable) {
          log.error("Fail-closed: worktree unusable after creation/validation", {
            taskId: task.id,
            worktreePath: wtPath,
          });
          await this.callbacks.handleTaskFailure(
            projectId,
            repoPath,
            task,
            branchName,
            `Worktree at ${wtPath} is not usable after setup (missing .git or source files). ` +
              "Blocking task to prevent dispatch to a broken workspace.",
            null,
            "workspace_invalid"
          );
          return;
        }
      }

      if (retryContext?.useExistingBranch && !retryContext.structuredOutputRepairAttempted) {
        await this.host.branchManager.waitForGitReady(wtPath);
        let rebaseConflict: RebaseConflictError | null = null;
        try {
          await this.host.branchManager.rebaseOntoMain(wtPath, baseBranch);
          log.info("Rebased existing branch onto base before retry", {
            taskId: task.id,
            baseBranch,
          });
        } catch (e) {
          if (e instanceof RebaseConflictError) {
            rebaseConflict = e;
          } else {
            throw e;
          }
        }
        if (rebaseConflict) {
          const rebaseOk = await this.resolveRetryRebaseConflictsWithMerger(
            projectId,
            repoPath,
            task,
            wtPath,
            baseBranch,
            branchName,
            rebaseConflict,
            settings
          );
          if (!rebaseOk) {
            return;
          }
        }
      }

      await this.host.preflightCheck(repoPath, wtPath, task.id, baseBranch, undefined);
      if (!this.isTaskStillActive(projectId, task.id)) {
        return;
      }

      let context: TaskContext = await this.host.contextAssembler.buildContext(
        projectId,
        repoPath,
        task.id,
        this.host.taskStore,
        this.host.branchManager,
        { task, baseBranch }
      );
      if (!this.isTaskStillActive(projectId, task.id)) {
        return;
      }

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
      if (!this.isTaskStillActive(projectId, task.id)) {
        return;
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
        previousTestFailures: retryContext?.previousTestFailures ?? null,
        previousDiff: retryContext?.previousDiff ?? null,
        failureHistory: retryContext?.failureHistory ?? null,
        qualityGateDetail: retryContext?.qualityGateDetail ?? null,
        useExistingBranch: retryContext?.useExistingBranch ?? false,
        agenticRepairEnabled: settings.agenticRepairEnabled !== false,
        structuredOutputRepairAttempted: retryContext?.structuredOutputRepairAttempted ?? false,
        hilConfig: settings.hilConfig,
        aiAutonomyLevel: settings.aiAutonomyLevel,
      };

      await this.host.contextAssembler.assembleTaskDirectory(wtPath, task.id, config, context);
      if (!this.isTaskStillActive(projectId, task.id)) {
        return;
      }

      const taskDir = this.host.sessionManager.getActiveDir(wtPath, task.id);
      const promptPath = path.join(taskDir, "prompt.md");

      if (this.isBaselineQualityGateTask(task)) {
        const promptContent = await fs.readFile(promptPath, "utf-8").catch(() => "");
        if (!this.promptHasActionableQualityGateContext(promptContent)) {
          log.warn(
            "Baseline quality gate task has no actionable error context in prompt; blocking",
            {
              taskId: task.id,
              attempt: slot.attempt,
            }
          );
          this.callbacks.handleTaskFailure(
            projectId,
            repoPath,
            task,
            branchName,
            "Baseline quality gate remediation task has no actionable error information (no failed command, error line, or test file). " +
              "Blocking to prevent empty-diff retries.",
            null,
            "coding_failure"
          );
          return;
        }
      }

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

      const replayMetadata = await resolveExecuteReplayMetadata(
        projectId,
        settings,
        repoPath,
        baseBranch
      );

      const assignment: TaskAssignmentLike = {
        taskId: task.id,
        projectId,
        phase: "coding",
        branchName,
        worktreeKey: slot.worktreeKey ?? task.id,
        worktreePath: wtPath,
        promptPath,
        agentConfig,
        attempt: slot.attempt,
        retryContext,
        createdAt: new Date().toISOString(),
        ...(replayMetadata && { replayMetadata }),
      };
      // Set startedAt before agent spawn so getActiveAgents returns correct elapsed time from first frame (no 0s flash)
      slot.agent.startedAt = assignment.createdAt;
      await writeJsonAtomic(path.join(taskDir, OPENSPRINT_PATHS.assignment), assignment);
      // Also write to main repo so crash recovery finds it (worktree base can differ after restart via os.tmpdir())
      const mainRepoActiveDir = this.host.sessionManager.getActiveDir(repoPath, task.id);
      await fs.mkdir(mainRepoActiveDir, { recursive: true });
      await writeJsonAtomic(path.join(mainRepoActiveDir, OPENSPRINT_PATHS.assignment), assignment);

      if (!this.isTaskStillActive(projectId, task.id)) {
        return;
      }

      const agentId = buildAgentAttemptId(agentConfig, "coder");
      slot.activeAgentConfig = agentConfig;
      try {
        await agentIdentityService.recordAttemptStarted(repoPath, {
          taskId: task.id,
          agentId,
          role: "coder",
          model: agentConfig.model ?? "unknown",
          attempt: slot.attempt,
          startedAt: assignment.createdAt,
        });
      } catch (err) {
        log.warn("Failed to record coder attempt start for Agent Log", { err });
      }

      await this.host.lifecycleManager.run(
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
          isStillActive: () => this.host.getState(projectId).slots.get(task.id) === slot,
          onDone: (code) =>
            this.callbacks.handleCodingDone(projectId, repoPath, task, branchName, code),
          onStateChange: this.host.onAgentStateChange(projectId),
        },
        slot.agent,
        slot.timers
      );

      fireAndForget(
        eventLogService.append(repoPath, {
          timestamp: new Date().toISOString(),
          projectId,
          taskId: task.id,
          event: "agent.spawned",
          data: {
            phase: "coding",
            model: agentConfig.model,
            attempt: slot.attempt,
            attemptId: slot.attemptId,
            attemptStartedAt: slot.agent.startedAt ?? null,
            queueLagMs: Number.isFinite(Date.parse(slot.agent.startedAt ?? ""))
              ? Math.max(0, Date.now() - Date.parse(slot.agent.startedAt ?? ""))
              : null,
          },
        }),
        "phase-executor:agent.spawned"
      );

      await this.host.persistCounters(projectId, repoPath);
    } catch (error) {
      if (!this.isTaskStillActive(projectId, task.id)) {
        log.info("Skipping coding-phase failure after task was canceled", {
          projectId,
          taskId: task.id,
        });
        return;
      }
      log.error(`Coding phase failed for task ${task.id}`, {
        projectId,
        taskId: task.id,
        branchName,
        error,
      });
      const { failureType, failureReason } = this.classifyPhaseError(error);
      await this.callbacks.handleTaskFailure(
        projectId,
        repoPath,
        task,
        branchName,
        failureReason,
        null,
        failureType
      );
    }
  }

  async executeReviewPhase(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    retryContext?: RetryContext,
    reviewTarget?: ReviewRetryTarget
  ): Promise<void> {
    const state = this.host.getState(projectId);
    const slot = state.slots.get(task.id);
    if (!slot) {
      log.warn("executeReviewPhase: no slot found for task", { projectId, taskId: task.id });
      return;
    }
    const settings = await this.host.projectService.getSettings(projectId);
    const baseBranch = await resolveBaseBranch(repoPath, settings.worktreeBaseBranch);
    const wtPath = slot.worktreePath ?? repoPath;
    if (wtPath !== repoPath) {
      assertSafeTaskWorktreePath(repoPath, task.id, wtPath);
    }
    slot.retryContext = retryContext;
    const configuredReviewAngles = [
      ...new Set((settings.reviewAngles ?? []).filter(Boolean)),
    ] as ReviewAngle[];
    const targetAngle =
      reviewTarget && reviewTarget !== "general" ? (reviewTarget as ReviewAngle) : undefined;
    const runOnlyGeneralReview = reviewTarget === "general";
    const reviewAngles = targetAngle ? [targetAngle] : configuredReviewAngles;
    const includeGeneralReview =
      !runOnlyGeneralReview &&
      !targetAngle &&
      settings.includeGeneralReview === true &&
      reviewAngles.length > 0;
    const useAngleSpecificReview = !runOnlyGeneralReview && reviewAngles.length > 0;

    try {
      await this.host.preflightCheck(
        repoPath,
        wtPath,
        task.id,
        baseBranch,
        useAngleSpecificReview ? reviewAngles : undefined,
        !targetAngle
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
        previousFailure: retryContext?.previousFailure ?? null,
        reviewFeedback: retryContext?.reviewFeedback ?? null,
        useExistingBranch: retryContext?.useExistingBranch ?? false,
        agenticRepairEnabled: settings.agenticRepairEnabled !== false,
        structuredOutputRepairAttempted: retryContext?.structuredOutputRepairAttempted ?? false,
        hilConfig: settings.hilConfig,
        aiAutonomyLevel: settings.aiAutonomyLevel,
        ...(reviewAngles.length > 0 && { reviewAngles }),
        ...(includeGeneralReview && { includeGeneralReview: true }),
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
      slot.activeAgentConfig = agentConfig;

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

      const replayMetadata = await resolveExecuteReplayMetadata(
        projectId,
        settings,
        repoPath,
        baseBranch
      );

      const assignment: TaskAssignmentLike = {
        taskId: task.id,
        projectId,
        phase: "review",
        branchName,
        worktreeKey: slot.worktreeKey ?? task.id,
        worktreePath: wtPath,
        promptPath:
          includeGeneralReview || !useAngleSpecificReview
            ? path.join(taskDir, "prompt.md")
            : path.join(taskDir, "review-angles", reviewAngles[0]!, "prompt.md"),
        agentConfig,
        attempt: slot.attempt,
        createdAt: new Date().toISOString(),
        ...(replayMetadata && { replayMetadata }),
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

      const runGeneralAgent = async () => {
        const agentId = buildAgentAttemptId(agentConfig, "reviewer", {
          reviewScope: "general",
        });
        try {
          await agentIdentityService.recordAttemptStarted(repoPath, {
            taskId: task.id,
            agentId,
            role: "reviewer",
            model: agentConfig.model ?? "unknown",
            attempt: slot.attempt,
            startedAt: assignment.createdAt,
          });
        } catch (err) {
          log.warn("Failed to record reviewer attempt start for Agent Log (general)", { err });
        }
        await this.host.lifecycleManager.run(
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
            isStillActive: () => this.host.getState(projectId).slots.get(task.id) === slot,
            onDone: (code) =>
              this.callbacks.handleReviewDone(projectId, repoPath, task, branchName, code),
            onStateChange: this.host.onAgentStateChange(projectId),
          },
          slot.agent,
          slot.timers
        );
        fireAndForget(
          eventLogService.append(repoPath, {
            timestamp: new Date().toISOString(),
            projectId,
            taskId: task.id,
            event: "agent.spawned",
            data: {
              phase: "review",
              model: agentConfig.model,
              attempt: slot.attempt,
              attemptId: slot.attemptId,
              attemptStartedAt: slot.agent.startedAt ?? null,
              queueLagMs: Number.isFinite(Date.parse(slot.agent.startedAt ?? ""))
                ? Math.max(0, Date.now() - Date.parse(slot.agent.startedAt ?? ""))
                : null,
            },
          }),
          "phase-executor:agent.spawned"
        );
      };

      if (includeGeneralReview || runOnlyGeneralReview) {
        slot.includeGeneralReview = true;
        await runGeneralAgent();
      }

      if (useAngleSpecificReview) {
        slot.reviewAgents = targetAngle ? (slot.reviewAgents ?? new Map()) : new Map();
        const runAnglesSequentiallyForStability =
          process.env.OPENSPRINT_SERIALIZE_CURSOR_REVIEW_ANGLES === "1" &&
          agentConfig.type === "cursor" &&
          reviewAngles.length > 1;
        const pendingAngles = runAnglesSequentiallyForStability ? [...reviewAngles] : [];

        const spawnAngleReviewer = async (angle: ReviewAngle): Promise<void> => {
          const angleDir = path.join(taskDir, "review-angles", angle);
          const anglePromptPath = path.join(angleDir, "prompt.md");
          const angleAssignment: TaskAssignmentLike = {
            ...assignment,
            promptPath: anglePromptPath,
            angle,
          };

          await fs.mkdir(angleDir, { recursive: true });
          await writeJsonAtomic(path.join(angleDir, OPENSPRINT_PATHS.assignment), angleAssignment);

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

          const agentId = buildAgentAttemptId(agentConfig, "reviewer", {
            reviewScope: angle,
          });
          try {
            await agentIdentityService.recordAttemptStarted(repoPath, {
              taskId: task.id,
              agentId,
              role: "reviewer",
              model: agentConfig.model ?? "unknown",
              attempt: slot.attempt,
              startedAt: angleAssignment.createdAt,
            });
          } catch (err) {
            log.warn("Failed to record reviewer attempt start for Agent Log (angle)", {
              err,
              angle,
            });
          }

          await this.host.lifecycleManager.run(
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
              isStillActive: () => this.host.getState(projectId).slots.get(task.id) === slot,
              onDone: async (code) => {
                await this.callbacks.handleReviewDone(
                  projectId,
                  repoPath,
                  task,
                  branchName,
                  code,
                  angle
                );

                if (!runAnglesSequentiallyForStability) return;

                const currentSlot = this.host.getState(projectId).slots.get(task.id);
                if (!currentSlot) {
                  return;
                }
                const nextAngle = pendingAngles.shift();
                if (!nextAngle) return;

                try {
                  await spawnAngleReviewer(nextAngle);
                } catch (error) {
                  log.error("Failed to spawn serialized review angle", {
                    projectId,
                    taskId: task.id,
                    angle: nextAngle,
                    error,
                  });
                  await this.callbacks.handleTaskFailure(
                    projectId,
                    repoPath,
                    task,
                    branchName,
                    `Failed to spawn review angle '${nextAngle}': ${String(error)}`,
                    null,
                    "agent_crash"
                  );
                }
              },
              onStateChange: this.host.onAgentStateChange(projectId),
              outputLogPath: angleOutputLogPath,
              heartbeatSubpath: angleHeartbeatSubpath,
            },
            angleAgent,
            angleTimers
          );

          const angleStartedAt = angleAgent.startedAt ?? slot.agent.startedAt ?? null;
          fireAndForget(
            eventLogService.append(repoPath, {
              timestamp: new Date().toISOString(),
              projectId,
              taskId: task.id,
              event: "agent.spawned",
              data: {
                phase: "review",
                model: agentConfig.model,
                attempt: slot.attempt,
                attemptId: slot.attemptId,
                angle,
                attemptStartedAt: angleStartedAt,
                queueLagMs:
                  angleStartedAt && Number.isFinite(Date.parse(angleStartedAt))
                    ? Math.max(0, Date.now() - Date.parse(angleStartedAt))
                    : null,
              },
            }),
            "phase-executor:agent.spawned"
          );
        };

        if (runAnglesSequentiallyForStability) {
          log.info("Running cursor review angles sequentially for stability", {
            projectId,
            taskId: task.id,
            reviewAngles,
          });
          const firstAngle = pendingAngles.shift();
          if (firstAngle) {
            await spawnAngleReviewer(firstAngle);
          }
        } else {
          await Promise.all(reviewAngles.map(async (angle) => spawnAngleReviewer(angle)));
        }
      } else if (!runOnlyGeneralReview) {
        slot.reviewAgents = undefined;
        const agentId = buildAgentAttemptId(agentConfig, "reviewer", {
          reviewScope: "general",
        });
        try {
          await agentIdentityService.recordAttemptStarted(repoPath, {
            taskId: task.id,
            agentId,
            role: "reviewer",
            model: agentConfig.model ?? "unknown",
            attempt: slot.attempt,
            startedAt: assignment.createdAt,
          });
        } catch (err) {
          log.warn("Failed to record reviewer attempt start for Agent Log (single)", { err });
        }
        await this.host.lifecycleManager.run(
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
            isStillActive: () => this.host.getState(projectId).slots.get(task.id) === slot,
            onDone: (code) =>
              this.callbacks.handleReviewDone(projectId, repoPath, task, branchName, code),
            onStateChange: this.host.onAgentStateChange(projectId),
          },
          slot.agent,
          slot.timers
        );

        fireAndForget(
          eventLogService.append(repoPath, {
            timestamp: new Date().toISOString(),
            projectId,
            taskId: task.id,
            event: "agent.spawned",
            data: {
              phase: "review",
              model: agentConfig.model,
              attempt: slot.attempt,
              attemptId: slot.attemptId,
              attemptStartedAt: slot.agent.startedAt ?? null,
              queueLagMs: Number.isFinite(Date.parse(slot.agent.startedAt ?? ""))
                ? Math.max(0, Date.now() - Date.parse(slot.agent.startedAt ?? ""))
                : null,
            },
          }),
          "phase-executor:agent.spawned"
        );
      }

      await this.host.persistCounters(projectId, repoPath);
    } catch (error) {
      log.error(`Review phase failed for task ${task.id}`, {
        projectId,
        taskId: task.id,
        branchName,
        error,
      });
      const { failureType, failureReason } = this.classifyPhaseError(error);
      await this.callbacks.handleTaskFailure(
        projectId,
        repoPath,
        task,
        branchName,
        failureReason,
        null,
        failureType
      );
    }
  }
}
