import fs from "fs/promises";
import path from "path";
import type {
  OrchestratorStatus,
  ActiveAgent,
  ActiveTaskConfig,
  CodingAgentResult,
  ReviewAgentResult,
  TestResults,
  PendingFeedbackCategorization,
} from "@opensprint/shared";
import {
  OPENSPRINT_PATHS,
  BACKOFF_FAILURE_THRESHOLD,
  MAX_PRIORITY_BEFORE_BLOCK,
  resolveTestCommand,
  DEFAULT_REVIEW_MODE,
  getCodingAgentForComplexity,
} from "@opensprint/shared";
import { BeadsService, type BeadsIssue } from "./beads.service.js";
import { ProjectService } from "./project.service.js";
import { agentService } from "./agent.service.js";
import { triggerDeploy } from "./deploy-trigger.service.js";
import { BranchManager, RebaseConflictError } from "./branch-manager.js";
import { gitCommitQueue } from "./git-commit-queue.service.js";
import { ContextAssembler } from "./context-assembler.js";
import { SessionManager } from "./session-manager.js";
import { shouldInvokeSummarizer, buildSummarizerPrompt, countWords } from "./summarizer.service.js";
import type { TaskContext } from "./context-assembler.js";
import { TestRunner } from "./test-runner.js";
import { orphanRecoveryService } from "./orphan-recovery.service.js";
import { activeAgentsService } from "./active-agents.service.js";
import { FeedbackService } from "./feedback.service.js";
import { broadcastToProject, sendAgentOutputToProject } from "../websocket/index.js";
import { writeJsonAtomic } from "../utils/file-utils.js";
import { TimerRegistry } from "./timer-registry.js";
import { AgentLifecycleManager, type AgentRunState } from "./agent-lifecycle.js";
import {
  CrashRecoveryService,
  type PersistedOrchestratorState as CrashPersistedState,
} from "./crash-recovery.service.js";
import { normalizeCodingStatus, normalizeReviewStatus } from "./result-normalizers.js";
import { getPlanComplexityForTask } from "./plan-complexity.js";

/**
 * Failure types for smarter recovery routing.
 * Only agent-attributable failures count toward progressive backoff.
 */
type FailureType =
  | "test_failure"
  | "review_rejection"
  | "agent_crash"
  | "timeout"
  | "no_result"
  | "merge_conflict"
  | "coding_failure";

/** Failures caused by infrastructure, not the agent's work quality */
const INFRA_FAILURE_TYPES: FailureType[] = ["agent_crash", "timeout", "merge_conflict"];

/** Max number of free infrastructure retries before counting toward backoff */
const MAX_INFRA_RETRIES = 2;

interface RetryContext {
  previousFailure?: string;
  reviewFeedback?: string;
  useExistingBranch?: boolean;
  /** Full test runner output from the previous attempt */
  previousTestOutput?: string;
  /** Git diff from the previous attempt */
  previousDiff?: string;
  /** Type of failure that triggered this retry */
  failureType?: FailureType;
}

/** Watchdog interval: 5 minutes (PRDv2 §5.7) */
const WATCHDOG_INTERVAL_MS = 60 * 1000;

/** Polling interval for monitoring orphaned agent processes during crash recovery */

// ─── State Persistence Types (PRDv2 §5.8) ───

/**
 * Serializable orchestrator state persisted to `.opensprint/orchestrator-state.json`.
 * Written atomically on every state transition so the backend can recover after a crash.
 */
type PersistedOrchestratorState = CrashPersistedState;

/** Check whether a PID is still running */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Extract epic ID from task ID (e.g. bd-a3f8.2 -> bd-a3f8). Returns null if not a child task. */
function extractEpicId(id: string | undefined | null): string | null {
  if (id == null || typeof id !== "string") return null;
  const lastDot = id.lastIndexOf(".");
  if (lastDot <= 0) return null;
  return id.slice(0, lastDot);
}

/** Format review rejection result into actionable feedback for the coding agent retry prompt. Exported for testing. */
export function formatReviewFeedback(result: ReviewAgentResult): string {
  const parts: string[] = [];
  if (result.summary) {
    parts.push(result.summary);
  }
  if (result.issues && result.issues.length > 0) {
    parts.push("\n\nIssues to address:");
    for (const issue of result.issues) {
      parts.push(`\n- ${issue}`);
    }
  }
  if (result.notes?.trim()) {
    parts.push(`\n\nNotes: ${result.notes.trim()}`);
  }
  if (parts.length === 0) {
    return "Review rejected (no details provided by review agent).";
  }
  return parts.join("");
}

/** Results carried over from coding phase to review/merge */
interface PhaseResult {
  codingDiff: string;
  codingSummary: string;
  testResults: TestResults | null;
  testOutput: string;
}

interface OrchestratorState {
  status: OrchestratorStatus;
  /** True when the orchestrator loop is actively running (internal tracking, not exposed) */
  loopActive: boolean;
  /** Centralized timer registry — all timers go here for clean teardown */
  timers: TimerRegistry;
  /** Agent process state shared with AgentLifecycleManager */
  agent: AgentRunState;
  attempt: number;
  /** Results from the last coding phase (diff, summary, test output) */
  phaseResult: PhaseResult;
  /** Branch name of the currently active task (for persistence) */
  activeBranchName: string | null;
  /** Title of the current task (for persistence/logging) */
  activeTaskTitle: string | null;
  /** Filesystem path of the active task's git worktree (null when idle) */
  activeWorktreePath: string | null;
  /** Number of infrastructure-caused retries for the current task (not counted toward backoff) */
  infraRetries: number;
  /** Feedback items awaiting categorization (PRDv2 §5.8) */
  pendingFeedbackCategorizations: PendingFeedbackCategorization[];
}

/** Discriminated union for orchestrator state transitions */
type TransitionTarget =
  | {
      to: "start_task";
      taskId: string;
      taskTitle: string | null;
      branchName: string;
      attempt: number;
      queueDepth: number;
    }
  | { to: "enter_review"; taskId: string; queueDepth: number }
  | { to: "complete"; taskId: string }
  | { to: "fail" };

/**
 * Build orchestrator service.
 * Manages the single-agent build loop: poll bd ready -> assign -> spawn agent -> monitor -> handle result.
 */
export class OrchestratorService {
  private state = new Map<string, OrchestratorState>();
  private beads = new BeadsService();
  private projectService = new ProjectService();
  private branchManager = new BranchManager();
  private contextAssembler = new ContextAssembler();
  private sessionManager = new SessionManager();
  private testRunner = new TestRunner();
  private feedbackService = new FeedbackService();
  private lifecycleManager = new AgentLifecycleManager();
  private crashRecovery = new CrashRecoveryService();

  private getState(projectId: string): OrchestratorState {
    if (!this.state.has(projectId)) {
      this.state.set(projectId, {
        status: this.defaultStatus(),
        loopActive: false,
        timers: new TimerRegistry(),
        agent: {
          activeProcess: null,
          lastOutputTime: 0,
          outputLog: [],
          outputLogBytes: 0,
          startedAt: "",
          exitHandled: false,
          killedDueToTimeout: false,
        },
        attempt: 1,
        phaseResult: { codingDiff: "", codingSummary: "", testResults: null, testOutput: "" },
        activeBranchName: null,
        activeTaskTitle: null,
        activeWorktreePath: null,
        infraRetries: 0,
        pendingFeedbackCategorizations: [],
      });
    }
    return this.state.get(projectId)!;
  }

  private defaultStatus(): OrchestratorStatus {
    return {
      currentTask: null,
      currentPhase: null,
      queueDepth: 0,
      totalDone: 0,
      totalFailed: 0,
    };
  }

  /**
   * Centralized state transition with logging and broadcasting.
   *
   * All phase transitions flow through here to ensure consistent state
   * mutations, structured logging, and WebSocket broadcasts.
   */
  private transition(projectId: string, t: TransitionTarget): void {
    const state = this.getState(projectId);
    const prev = state.status.currentPhase ?? "idle";

    switch (t.to) {
      case "start_task":
        state.status.currentTask = t.taskId;
        state.status.currentPhase = "coding";
        state.activeBranchName = t.branchName;
        state.activeTaskTitle = t.taskTitle;
        state.activeWorktreePath = null;
        state.attempt = t.attempt;
        broadcastToProject(projectId, {
          type: "task.updated",
          taskId: t.taskId,
          status: "in_progress",
          assignee: "agent-1",
        });
        broadcastToProject(projectId, {
          type: "execute.status",
          currentTask: t.taskId,
          currentPhase: "coding",
          queueDepth: t.queueDepth,
        });
        break;

      case "enter_review":
        state.status.currentPhase = "review";
        broadcastToProject(projectId, {
          type: "task.updated",
          taskId: t.taskId,
          status: "in_progress",
          assignee: "agent-1",
        });
        broadcastToProject(projectId, {
          type: "execute.status",
          currentTask: t.taskId,
          currentPhase: "review",
          queueDepth: t.queueDepth,
        });
        break;

      case "complete":
        state.status.totalDone += 1;
        this.resetTaskState(state);
        broadcastToProject(projectId, {
          type: "task.updated",
          taskId: t.taskId,
          status: "closed",
          assignee: null,
        });
        break;

      case "fail":
        state.status.totalFailed += 1;
        this.resetTaskState(state);
        break;
    }

    console.log(
      `[orchestrator] Transition [${projectId}]: ${prev} → ${t.to} (task: ${state.status.currentTask ?? "none"})`
    );
  }

  /** Clear all task-related fields when returning to idle */
  private resetTaskState(state: OrchestratorState): void {
    state.status.currentTask = null;
    state.status.currentPhase = null;
    state.activeBranchName = null;
    state.activeTaskTitle = null;
    state.activeWorktreePath = null;
  }

  // ─── State Persistence (PRDv2 §5.8) ───

  /**
   * Persist current orchestrator state to `.opensprint/orchestrator-state.json`.
   * Uses atomic write (tmp + rename) to prevent corruption.
   */
  private async persistState(projectId: string, repoPath: string): Promise<void> {
    const state = this.getState(projectId);
    const persisted: PersistedOrchestratorState = {
      projectId,
      currentTaskId: state.status.currentTask,
      currentTaskTitle: state.activeTaskTitle,
      currentPhase: state.status.currentPhase,
      branchName: state.activeBranchName,
      worktreePath: state.activeWorktreePath,
      agentPid: state.agent.activeProcess?.pid ?? null,
      attempt: state.attempt,
      startedAt: state.agent.startedAt || null,
      lastTransition: new Date().toISOString(),
      lastOutputTimestamp: state.agent.lastOutputTime || null,
      queueDepth: state.status.queueDepth,
      totalDone: state.status.totalDone,
      totalFailed: state.status.totalFailed,
    };

    const statePath = path.join(repoPath, OPENSPRINT_PATHS.orchestratorState);
    try {
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      await writeJsonAtomic(statePath, persisted);
    } catch (err) {
      console.warn("[orchestrator] Failed to persist state:", err);
    }
  }

  /** Load persisted state from disk (returns null if none exists or is unreadable) */
  private async loadPersistedState(repoPath: string): Promise<PersistedOrchestratorState | null> {
    const statePath = path.join(repoPath, OPENSPRINT_PATHS.orchestratorState);
    try {
      const raw = await fs.readFile(statePath, "utf-8");
      return JSON.parse(raw) as PersistedOrchestratorState;
    } catch {
      return null;
    }
  }

  /** Clear persisted state (task completed or recovered) */
  private async clearPersistedState(repoPath: string): Promise<void> {
    const statePath = path.join(repoPath, OPENSPRINT_PATHS.orchestratorState);
    try {
      await fs.unlink(statePath);
    } catch {
      // File may not exist
    }
  }

  // ─── Crash Recovery (PRDv2 §5.8) — delegates to CrashRecoveryService ───

  private getCrashRecoveryCallbacks() {
    return {
      clearPersistedState: (rp: string) => this.clearPersistedState(rp),
      persistState: (pid: string, rp: string) => this.persistState(pid, rp),
      handleCodingDone: (pid: string, rp: string, t: BeadsIssue, bn: string, ec: number | null) =>
        this.handleCodingDone(pid, rp, t, bn, ec),
      handleReviewDone: (pid: string, rp: string, t: BeadsIssue, bn: string, ec: number | null) =>
        this.handleReviewDone(pid, rp, t, bn, ec),
      handleTaskFailure: (
        pid: string,
        rp: string,
        t: BeadsIssue,
        bn: string,
        reason: string,
        tr: TestResults | null,
        ft: string
      ) => this.handleTaskFailure(pid, rp, t, bn, reason, tr, ft as FailureType),
      executeReviewPhase: (pid: string, rp: string, t: BeadsIssue, bn: string) =>
        this.executeReviewPhase(pid, rp, t, bn),
      performMergeAndDone: (pid: string, rp: string, t: BeadsIssue, bn: string) =>
        this.performMergeAndDone(pid, rp, t, bn),
    };
  }

  private getCrashRecoveryDeps() {
    return {
      beads: this.beads,
      projectService: this.projectService,
      branchManager: this.branchManager,
      sessionManager: this.sessionManager,
      testRunner: this.testRunner,
    };
  }

  private async recoverFromPersistedState(
    projectId: string,
    repoPath: string,
    persisted: PersistedOrchestratorState
  ): Promise<void> {
    const state = this.getState(projectId);
    await this.crashRecovery.recoverFromPersistedState(
      projectId,
      repoPath,
      persisted,
      state,
      this.getCrashRecoveryDeps(),
      this.getCrashRecoveryCallbacks()
    );
  }

  // ─── Lifecycle ───

  /**
   * Stop the orchestrator for a project, tearing down all timers and killing any
   * active agent process. Used when repoPath changes to allow a clean restart.
   */
  stopProject(projectId: string): void {
    const state = this.state.get(projectId);
    if (!state) return;

    console.log(`[orchestrator] Stopping orchestrator for project ${projectId}`);

    state.timers.clearAll();

    if (state.agent.activeProcess) {
      if (state.status.currentTask) {
        activeAgentsService.unregister(state.status.currentTask);
      }
      try {
        state.agent.activeProcess.kill();
      } catch {
        // Process may already be dead
      }
      state.agent.activeProcess = null;
    }

    state.loopActive = false;
    this.state.delete(projectId);

    console.log(`[orchestrator] Orchestrator stopped for project ${projectId}`);
  }

  /** Stop all running orchestrators (for graceful shutdown). */
  stopAll(): void {
    for (const projectId of [...this.state.keys()]) {
      this.stopProject(projectId);
    }
  }

  /**
   * Initialize the always-on orchestrator for a project (PRDv2 §5.7).
   * Called once on backend boot. Checks for persisted state and recovers if needed,
   * then starts the loop and the 5-minute watchdog (PRDv2 §5.8).
   */
  async ensureRunning(projectId: string): Promise<OrchestratorStatus> {
    await this.projectService.getProject(projectId);
    const state = this.getState(projectId);
    const repoPath = await this.projectService.getRepoPath(projectId);

    // Orphan recovery: reset in_progress tasks with agent assignee but no active process
    const persisted = await this.loadPersistedState(repoPath);
    const excludeTaskId =
      persisted?.currentTaskId && persisted.agentPid && isPidAlive(persisted.agentPid)
        ? persisted.currentTaskId
        : undefined;
    let orphanResult: { recovered: string[] };
    try {
      orphanResult = await orphanRecoveryService.recoverOrphanedTasks(repoPath, excludeTaskId);
    } catch (err) {
      console.error("[orchestrator] Orphan recovery failed:", err);
      orphanResult = { recovered: [] };
    }
    // Stale heartbeat recovery: identify orphaned tasks via heartbeat files > 2 min old
    let staleHeartbeatResult: { recovered: string[] };
    try {
      staleHeartbeatResult = await orphanRecoveryService.recoverFromStaleHeartbeats(
        repoPath,
        excludeTaskId
      );
    } catch (err) {
      console.error("[orchestrator] Stale heartbeat recovery failed:", err);
      staleHeartbeatResult = { recovered: [] };
    }
    const recovered = [...new Set([...orphanResult.recovered, ...staleHeartbeatResult.recovered])];
    if (recovered.length > 0) {
      console.warn(
        `[orchestrator] Recovered ${recovered.length} orphaned task(s) on startup: ${recovered.join(", ")}`
      );
    }

    // Crash recovery: check for persisted state from a previous run
    if (persisted && persisted.currentTaskId) {
      await this.recoverFromPersistedState(projectId, repoPath, persisted);
    } else if (persisted) {
      // Persisted state exists but no active task — restore counters and clean up
      state.status.totalDone =
        persisted.totalDone ?? (persisted as { totalCompleted?: number }).totalCompleted ?? 0;
      state.status.totalFailed = persisted.totalFailed;
      await this.clearPersistedState(repoPath);
    }

    // Start watchdog timer if not already running
    if (!state.timers.has("watchdog")) {
      state.timers.setInterval(
        "watchdog",
        () => {
          this.nudge(projectId);
        },
        WATCHDOG_INTERVAL_MS
      );
      console.log("[orchestrator] Watchdog started (60s interval) for project", projectId);
    }

    // Kick off the loop if idle (recovery may have left it active for PID-alive monitoring)
    if (!state.loopActive) {
      this.nudge(projectId);
    }

    return state.status;
  }

  /**
   * Event-driven dispatch trigger (PRDv2 §5.7).
   * Called on: agent completion, feedback submission, "Build it!" click, watchdog tick.
   * If the loop is idle (no active task, no pending loop timer), starts the loop.
   */
  nudge(projectId: string): void {
    const state = this.getState(projectId);

    // Don't start a second loop if one is already active, has an agent running, or is scheduled
    if (state.loopActive || state.timers.has("loop") || state.agent.activeProcess) {
      return;
    }

    console.log("[orchestrator] Nudge received, starting loop for project", projectId);
    this.runLoop(projectId);
  }

  /** Get orchestrator status */
  async getStatus(projectId: string): Promise<OrchestratorStatus> {
    await this.projectService.getProject(projectId);
    const state = this.getState(projectId);
    return {
      ...state.status,
      worktreePath: state.activeWorktreePath ?? null,
      pendingFeedbackCategorizations: state.pendingFeedbackCategorizations ?? [],
    };
  }

  /**
   * Get live agent output for a task when it is the current orchestrator task.
   * Returns empty string when task is not running or has no output.
   */
  async getLiveOutput(projectId: string, taskId: string): Promise<string> {
    await this.projectService.getProject(projectId);
    const state = this.getState(projectId);
    if (state.status.currentTask !== taskId || !state.agent.outputLog.length) {
      return "";
    }
    return state.agent.outputLog.join("");
  }

  /**
   * Get active agents for the project (from central ActiveAgentsService registry).
   */
  async getActiveAgents(projectId: string): Promise<ActiveAgent[]> {
    await this.projectService.getProject(projectId);
    return activeAgentsService.list(projectId);
  }

  // ─── Main Orchestrator Loop ───

  private async runLoop(projectId: string): Promise<void> {
    const state = this.getState(projectId);

    // Mark the loop as active to prevent duplicate loops
    state.loopActive = true;
    state.timers.clear("loop");

    try {
      const repoPath = await this.projectService.getRepoPath(projectId);

      // 1. Poll bd ready for next task
      let readyTasks = await this.beads.ready(repoPath);

      // Filter out Plan approval gate tasks — they are closed by user "Build It!", not by agents
      readyTasks = readyTasks.filter((t) => (t.title ?? "") !== "Plan approval gate");
      // Filter out epics — they are containers, not work items; agents implement tasks/bugs
      readyTasks = readyTasks.filter((t) => (t.issue_type ?? t.type) !== "epic");
      // Filter out blocked tasks — they require user intervention to unblock (PRDv2 §9.1)
      // Use beads native blocked status (bd update --status blocked); bd ready may exclude them but filter as safety
      readyTasks = readyTasks.filter((t) => (t.status as string) !== "blocked");

      state.status.queueDepth = readyTasks.length;

      if (readyTasks.length === 0) {
        console.log("[orchestrator] No ready tasks, going idle", { projectId });
        state.loopActive = false;
        broadcastToProject(projectId, {
          type: "execute.status",
          currentTask: null,
          queueDepth: 0,
        });
        return;
      }

      // 2. Pick the highest-priority task (pre-flight: verify all blockers are closed)
      //    Fetch the status map once so the loop doesn't call listAll per task.
      const statusMap = await this.beads.getStatusMap(repoPath);
      let task: BeadsIssue | null = null;
      for (const t of readyTasks) {
        const allClosed = await this.beads.areAllBlockersClosed(repoPath, t.id, statusMap);
        if (allClosed) {
          task = t;
          break;
        }
        console.log("[orchestrator] Skipping task (blockers not all closed)", {
          projectId,
          taskId: t.id,
          title: t.title,
        });
      }
      if (!task) {
        console.log("[orchestrator] No task with all blockers closed, going idle", {
          projectId,
        });
        state.loopActive = false;
        broadcastToProject(projectId, {
          type: "execute.status",
          currentTask: null,
          queueDepth: 0,
        });
        return;
      }
      console.log("[orchestrator] Picking task", { projectId, taskId: task.id, title: task.title });

      // 3. Assign the task
      await this.beads.update(repoPath, task.id, {
        status: "in_progress",
        assignee: "agent-1",
      });

      // PRD §5.9: Beads export at checkpoint after claim
      gitCommitQueue.enqueue({
        type: "beads_export",
        repoPath,
        summary: `claimed ${task.id}`,
      });

      // Load cumulative attempt count from bead metadata (PRDv2 §9.1)
      const cumulativeAttempts = await this.beads.getCumulativeAttempts(repoPath, task.id);

      this.transition(projectId, {
        to: "start_task",
        taskId: task.id,
        taskTitle: task.title ?? null,
        branchName: `opensprint/${task.id}`,
        attempt: cumulativeAttempts + 1,
        queueDepth: readyTasks.length - 1,
      });

      // Persist state: idle → coding transition (PRDv2 §5.8)
      await this.persistState(projectId, repoPath);

      // agent.started (with startedAt) is broadcast from executeCodingPhase after agent spawn

      // 4. Verify main WT is on main (assertion, not corrective checkout)
      await this.branchManager.ensureOnMain(repoPath);

      // 5. Execute the coding phase (creates worktree, no checkout in main WT)
      await this.executeCodingPhase(projectId, repoPath, task, undefined);
    } catch (error) {
      console.error(`Orchestrator loop error for project ${projectId}:`, error);
      // Retry loop after delay
      state.loopActive = false;
      state.timers.setTimeout("loop", () => this.runLoop(projectId), 10000);
    }
  }

  private async executeCodingPhase(
    projectId: string,
    repoPath: string,
    task: BeadsIssue,
    retryContext?: RetryContext
  ): Promise<void> {
    const state = this.getState(projectId);
    const settings = await this.projectService.getSettings(projectId);
    const branchName = `opensprint/${task.id}`;

    try {
      const wtPath = await this.branchManager.createTaskWorktree(repoPath, task.id);
      state.activeWorktreePath = wtPath;

      await this.preflightCheck(repoPath, wtPath, task.id);

      let context: TaskContext = await this.contextAssembler.buildContext(
        repoPath,
        task.id,
        this.beads,
        this.branchManager
      );

      if (shouldInvokeSummarizer(context)) {
        context = await this.runSummarizer(projectId, settings, task.id, context);
      }

      const config: ActiveTaskConfig = {
        invocation_id: task.id,
        agent_role: "coder",
        taskId: task.id,
        repoPath: wtPath,
        branch: branchName,
        testCommand: resolveTestCommand(settings) || 'echo "No test command configured"',
        attempt: state.attempt,
        phase: "coding",
        previousFailure: retryContext?.previousFailure ?? null,
        reviewFeedback: retryContext?.reviewFeedback ?? null,
        previousTestOutput: retryContext?.previousTestOutput ?? null,
        previousDiff: retryContext?.previousDiff ?? null,
        useExistingBranch: retryContext?.useExistingBranch ?? false,
      };

      await this.contextAssembler.assembleTaskDirectory(wtPath, task.id, config, context);

      const taskDir = this.sessionManager.getActiveDir(wtPath, task.id);
      const promptPath = path.join(taskDir, "prompt.md");

      const complexity = await getPlanComplexityForTask(repoPath, task);
      const agentConfig = getCodingAgentForComplexity(settings, complexity);

      this.lifecycleManager.run(
        {
          projectId,
          taskId: task.id,
          phase: "coding",
          wtPath,
          branchName,
          promptPath,
          agentConfig,
          agentLabel: state.activeTaskTitle ?? task.id,
          role: "coder",
          onDone: (code) => this.handleCodingDone(projectId, repoPath, task, branchName, code),
        },
        state.agent,
        state.timers
      );

      await this.persistState(projectId, repoPath);
    } catch (error) {
      console.error(`Coding phase failed for task ${task.id}:`, error);
      await this.handleTaskFailure(
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

  private async handleCodingDone(
    projectId: string,
    repoPath: string,
    task: BeadsIssue,
    branchName: string,
    exitCode: number | null
  ): Promise<void> {
    const state = this.getState(projectId);
    const wtPath = state.activeWorktreePath ?? repoPath;

    const result = (await this.sessionManager.readResult(
      wtPath,
      task.id
    )) as CodingAgentResult | null;

    if (result && result.status) {
      normalizeCodingStatus(result);
    }

    if (!result) {
      const failureType: FailureType = state.agent.killedDueToTimeout
        ? "timeout"
        : exitCode === 143 || exitCode === 137
          ? "agent_crash"
          : "no_result";
      state.agent.killedDueToTimeout = false;
      await this.handleTaskFailure(
        projectId,
        repoPath,
        task,
        branchName,
        `Agent exited with code ${exitCode} without producing a result`,
        null,
        failureType
      );
      return;
    }

    if (result.status === "success") {
      state.phaseResult.codingDiff = await this.branchManager.captureBranchDiff(
        repoPath,
        branchName
      );
      state.phaseResult.codingSummary = result.summary ?? "";

      const settings = await this.projectService.getSettings(projectId);
      const testCommand = resolveTestCommand(settings) || undefined;
      let changedFiles: string[] = [];
      try {
        changedFiles = await this.branchManager.getChangedFiles(repoPath, branchName);
      } catch {
        // Fall back to full suite
      }
      const scopedResult = await this.testRunner.runScopedTests(wtPath, changedFiles, testCommand);
      state.phaseResult.testOutput = scopedResult.rawOutput;

      if (scopedResult.failed > 0) {
        await this.handleTaskFailure(
          projectId,
          repoPath,
          task,
          branchName,
          `Tests failed: ${scopedResult.failed} failed, ${scopedResult.passed} passed`,
          scopedResult,
          "test_failure"
        );
        return;
      }

      state.phaseResult.testResults = scopedResult;

      await this.branchManager.commitWip(wtPath, task.id);

      const reviewMode = settings.reviewMode ?? DEFAULT_REVIEW_MODE;

      if (reviewMode === "never") {
        await this.performMergeAndDone(projectId, repoPath, task, branchName);
      } else {
        this.transition(projectId, {
          to: "enter_review",
          taskId: task.id,
          queueDepth: state.status.queueDepth,
        });
        await this.persistState(projectId, repoPath);
        await this.executeReviewPhase(projectId, repoPath, task, branchName);
      }
    } else {
      const reason = result.summary || `Agent exited with code ${exitCode}`;
      await this.handleTaskFailure(
        projectId,
        repoPath,
        task,
        branchName,
        reason,
        null,
        "coding_failure"
      );
    }
  }

  private async executeReviewPhase(
    projectId: string,
    repoPath: string,
    task: BeadsIssue,
    branchName: string
  ): Promise<void> {
    const state = this.getState(projectId);
    const settings = await this.projectService.getSettings(projectId);
    const wtPath = state.activeWorktreePath ?? repoPath;

    try {
      const config: ActiveTaskConfig = {
        invocation_id: task.id,
        agent_role: "reviewer",
        taskId: task.id,
        repoPath: wtPath,
        branch: branchName,
        testCommand: resolveTestCommand(settings) || 'echo "No test command configured"',
        attempt: state.attempt,
        phase: "review",
        previousFailure: null,
        reviewFeedback: null,
      };

      const taskDir = this.sessionManager.getActiveDir(wtPath, task.id);
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, "config.json"), JSON.stringify(config, null, 2));

      const context = await this.contextAssembler.buildContext(
        repoPath,
        task.id,
        this.beads,
        this.branchManager
      );
      await this.contextAssembler.assembleTaskDirectory(wtPath, task.id, config, context);

      const promptPath = path.join(taskDir, "prompt.md");

      const complexity = await getPlanComplexityForTask(repoPath, task);
      const agentConfig = getCodingAgentForComplexity(settings, complexity);

      this.lifecycleManager.run(
        {
          projectId,
          taskId: task.id,
          phase: "review",
          wtPath,
          branchName,
          promptPath,
          agentConfig,
          agentLabel: state.activeTaskTitle ?? task.id,
          role: "reviewer",
          onDone: (code) => this.handleReviewDone(projectId, repoPath, task, branchName, code),
        },
        state.agent,
        state.timers
      );

      await this.persistState(projectId, repoPath);
    } catch (error) {
      console.error(`Review phase failed for task ${task.id}:`, error);
      await this.handleTaskFailure(
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

  private async handleReviewDone(
    projectId: string,
    repoPath: string,
    task: BeadsIssue,
    branchName: string,
    exitCode: number | null
  ): Promise<void> {
    const state = this.getState(projectId);
    const wtPath = state.activeWorktreePath ?? repoPath;
    const result = (await this.sessionManager.readResult(
      wtPath,
      task.id
    )) as ReviewAgentResult | null;

    if (result && result.status) {
      normalizeReviewStatus(result);
    }

    if (result && result.status === "approved") {
      await this.performMergeAndDone(projectId, repoPath, task, branchName);
    } else if (result && result.status === "rejected") {
      const reason = `Review rejected: ${result.issues?.join("; ") || result.summary || "No details provided"}`;
      const reviewFeedback = formatReviewFeedback(result);

      let gitDiff = "";
      try {
        const branchDiff = await this.branchManager.captureBranchDiff(repoPath, branchName);
        const uncommittedDiff = await this.branchManager.captureUncommittedDiff(wtPath);
        gitDiff = [branchDiff, uncommittedDiff]
          .filter(Boolean)
          .join("\n\n--- Uncommitted changes ---\n\n");
      } catch {
        // Best-effort capture
      }

      const session = await this.sessionManager.createSession(repoPath, {
        taskId: task.id,
        attempt: state.attempt,
        agentType: (await this.projectService.getSettings(projectId)).codingAgent.type,
        agentModel: (await this.projectService.getSettings(projectId)).codingAgent.model || "",
        gitBranch: branchName,
        status: "rejected",
        outputLog: state.agent.outputLog.join(""),
        failureReason: result.summary || "Review rejected (no summary provided)",
        gitDiff: gitDiff || undefined,
        startedAt: state.agent.startedAt,
      });
      await this.sessionManager.archiveSession(repoPath, task.id, state.attempt, session, wtPath);

      await this.handleTaskFailure(
        projectId,
        repoPath,
        task,
        branchName,
        reason,
        null,
        "review_rejection",
        reviewFeedback
      );
    } else {
      const failureType: FailureType = state.agent.killedDueToTimeout
        ? "timeout"
        : exitCode === 143 || exitCode === 137
          ? "agent_crash"
          : "no_result";
      state.agent.killedDueToTimeout = false;
      await this.handleTaskFailure(
        projectId,
        repoPath,
        task,
        branchName,
        `Review agent exited with code ${exitCode} without producing a valid result`,
        null,
        failureType
      );
    }
  }

  /**
   * Merge to main, close task, archive session, clean up.
   * Shared by both the direct-merge path (reviewMode: "never") and the review-approved path.
   */
  private async performMergeAndDone(
    projectId: string,
    repoPath: string,
    task: BeadsIssue,
    branchName: string
  ): Promise<void> {
    const state = this.getState(projectId);
    const wtPath = state.activeWorktreePath ?? repoPath;

    // Wait for any lingering git operations in the worktree to finish
    await this.branchManager.waitForGitReady(wtPath);

    // Commit any remaining changes in worktree before merge
    await this.branchManager.commitWip(wtPath, task.id);

    // Merge to main via serialized queue (PRD §5.9)
    try {
      await gitCommitQueue.enqueueAndWait({
        type: "worktree_merge",
        repoPath,
        branchName,
        taskTitle: task.title || task.id,
      });
    } catch (mergeErr) {
      console.warn("[orchestrator] Merge to main failed:", mergeErr);
      const merged = await this.branchManager.verifyMerge(repoPath, branchName);
      if (!merged) {
        await this.handleTaskFailure(
          projectId,
          repoPath,
          task,
          branchName,
          `Merge to main failed: ${mergeErr}`,
          null,
          "merge_conflict"
        );
        return;
      }
    }

    // Close the task in beads
    await this.beads.close(
      repoPath,
      task.id,
      state.phaseResult.codingSummary || "Implemented and tested"
    );

    // PRD §5.9: Orchestrator manages beads persistence explicitly via export at checkpoints
    gitCommitQueue.enqueue({
      type: "beads_export",
      repoPath,
      summary: `closed ${task.id}`,
    });

    const session = await this.sessionManager.createSession(repoPath, {
      taskId: task.id,
      attempt: state.attempt,
      agentType: (await this.projectService.getSettings(projectId)).codingAgent.type,
      agentModel: (await this.projectService.getSettings(projectId)).codingAgent.model || "",
      gitBranch: branchName,
      status: "approved",
      outputLog: state.agent.outputLog.join(""),
      gitDiff: state.phaseResult.codingDiff,
      summary: state.phaseResult.codingSummary || undefined,
      testResults: state.phaseResult.testResults ?? undefined,
      startedAt: state.agent.startedAt,
    });
    await this.sessionManager.archiveSession(repoPath, task.id, state.attempt, session, wtPath);

    // Clean up worktree then delete branch
    await this.branchManager.removeTaskWorktree(repoPath, task.id);
    await this.branchManager.deleteBranch(repoPath, branchName);

    // Push main to remote so completed work reaches origin.
    // If rebase conflicts with origin/main, spawn a merger agent to resolve them.
    await this.pushMainWithMergerFallback(projectId, repoPath);

    this.transition(projectId, { to: "complete", taskId: task.id });

    // Clear persisted state: task completed successfully (PRDv2 §5.8)
    await this.clearPersistedState(repoPath);

    // PRD §10.2: Auto-resolve feedback when all its created tasks are Done
    this.feedbackService.checkAutoResolveOnTaskDone(projectId, task.id).catch((err) => {
      console.warn(`[orchestrator] Auto-resolve feedback on task done failed for ${task.id}:`, err);
    });

    broadcastToProject(projectId, {
      type: "agent.completed",
      taskId: task.id,
      status: "approved",
      testResults: state.phaseResult.testResults,
    });

    // PRD §7.5.3: Auto-deploy on epic completion — only when all epic tasks are Done and config enabled
    const epicId = extractEpicId(task.id);
    if (epicId) {
      const allIssues = await this.beads.listAll(repoPath);
      const implTasks = allIssues.filter(
        (i) =>
          i.id.startsWith(epicId + ".") &&
          !i.id.endsWith(".0") &&
          (i.issue_type ?? i.type) !== "epic"
      );
      const allClosed =
        implTasks.length > 0 && implTasks.every((i) => (i.status as string) === "closed");
      if (allClosed) {
        const settings = await this.projectService.getSettings(projectId);
        if (settings.deployment.autoDeployOnEpicCompletion) {
          triggerDeploy(projectId).catch((err) => {
            console.warn(
              `[orchestrator] Auto-deploy on epic completion failed for ${projectId}:`,
              err
            );
          });
        }
      }
    }

    // Mark loop as idle, then re-trigger after a short delay to let git settle
    state.loopActive = false;
    state.timers.setTimeout(
      "loop",
      () => {
        this.nudge(projectId);
      },
      3000
    );
  }

  /**
   * Push main to remote, spawning a merger agent to resolve rebase conflicts if needed.
   * On unrecoverable failure, logs a warning but does not throw — the task is already
   * done; we just couldn't push yet.
   */
  private async pushMainWithMergerFallback(projectId: string, repoPath: string): Promise<void> {
    try {
      await this.branchManager.pushMain(repoPath);
    } catch (err) {
      if (!(err instanceof RebaseConflictError)) {
        console.warn("[orchestrator] pushMain failed (non-conflict):", err);
        return;
      }

      // If git auto-resolved all conflicts (no unmerged files), check whether a rebase
      // is actually in progress. The rebase command can fail for non-conflict reasons
      // (e.g. already up-to-date divergence, completed despite exit code), leaving no
      // rebase state on disk. In that case, just push directly.
      if (err.conflictedFiles.length === 0) {
        const rebaseActive = await this.branchManager.isRebaseInProgress(repoPath);
        if (!rebaseActive) {
          console.log(
            "[orchestrator] Rebase error with no conflicts and no rebase in progress, attempting direct push"
          );
          try {
            await this.branchManager.pushMainToOrigin(repoPath);
            console.log("[orchestrator] Direct push succeeded after rebase error");
            return;
          } catch (pushErr) {
            console.warn("[orchestrator] Direct push after rebase error failed:", pushErr);
            return;
          }
        }

        console.log("[orchestrator] Rebase paused with no unmerged files, continuing directly");
        try {
          await this.branchManager.rebaseContinue(repoPath);
          await this.branchManager.pushMainToOrigin(repoPath);
          console.log("[orchestrator] Auto-resolved rebase continued, push succeeded");
          return;
        } catch (contErr) {
          console.warn(
            "[orchestrator] rebaseContinue failed, falling through to merger agent:",
            contErr
          );
        }
      }

      console.log(
        `[orchestrator] Rebase conflict in ${err.conflictedFiles.length} file(s), spawning merger agent`
      );

      try {
        const resolved = await this.spawnMergerAgent(projectId, repoPath, err.conflictedFiles);
        if (resolved) {
          await this.branchManager.pushMainToOrigin(repoPath);
          console.log("[orchestrator] Merger agent resolved conflicts, push succeeded");
        } else {
          console.warn("[orchestrator] Merger agent failed to resolve conflicts, aborting rebase");
          await this.branchManager.rebaseAbort(repoPath);
        }
      } catch (mergeErr) {
        console.warn("[orchestrator] Merger agent error, aborting rebase:", mergeErr);
        await this.branchManager.rebaseAbort(repoPath);
      }
    }
  }

  /**
   * Spawn a merger agent to resolve rebase conflicts. Returns true if resolution succeeded.
   * The agent runs synchronously (we await its exit) since this is part of the push flow.
   */
  private async spawnMergerAgent(
    projectId: string,
    repoPath: string,
    conflictedFiles: string[]
  ): Promise<boolean> {
    const settings = await this.projectService.getSettings(projectId);
    const conflictDiff = await this.branchManager.getConflictDiff(repoPath);

    const prompt = this.contextAssembler.generateMergeConflictPrompt({
      conflictedFiles,
      conflictDiff,
    });

    // Write prompt to a temporary file in .opensprint/
    const mergerDir = path.join(repoPath, OPENSPRINT_PATHS.active, "_merger");
    await fs.mkdir(mergerDir, { recursive: true });
    const promptPath = path.join(mergerDir, "prompt.md");
    await fs.writeFile(promptPath, prompt);

    const resultPath = path.join(repoPath, ".opensprint", "merge-result.json");
    try {
      await fs.unlink(resultPath);
    } catch {
      // May not exist
    }

    const mergerId = `_merger:${projectId}`;

    const state = this.getState(projectId);

    return new Promise<boolean>((resolve) => {
      const mergerOutputLog: string[] = [];

      const handle = agentService.invokeMergerAgent(promptPath, settings.codingAgent, {
        cwd: repoPath,
        tracking: {
          id: mergerId,
          projectId,
          phase: "execute",
          role: "merger",
          label: "Resolving merge conflicts",
        },
        onOutput: (chunk: string) => {
          mergerOutputLog.push(chunk);
          sendAgentOutputToProject(projectId, "_merger", chunk);
        },
        onExit: async (code: number | null) => {
          state.timers.clear("mergerTimeout");
          console.log(`[orchestrator] Merger agent exited with code ${code}`);

          // Clean up prompt dir
          await fs.rm(mergerDir, { recursive: true, force: true }).catch(() => {});

          // Check if rebase is still in progress (agent failed to complete it)
          const rebaseStillActive = await this.branchManager.isRebaseInProgress(repoPath);
          if (rebaseStillActive) {
            resolve(false);
            return;
          }

          // Read result.json if agent wrote one — its status is authoritative
          try {
            const raw = await fs.readFile(resultPath, "utf-8");
            const result = JSON.parse(raw) as { status: string; summary?: string };
            await fs.unlink(resultPath).catch(() => {});
            if (result.status === "success") {
              console.log(`[orchestrator] Merger agent: ${result.summary ?? "conflicts resolved"}`);
              resolve(true);
            } else {
              console.warn(`[orchestrator] Merger agent reported status: ${result.status}`);
              resolve(false);
            }
            return;
          } catch {
            // No result file — fall back to exit code
          }

          resolve(code === 0 && !rebaseStillActive);
        },
      });

      // Safety timeout: kill merger after 5 minutes
      state.timers.setTimeout(
        "mergerTimeout",
        () => {
          console.warn("[orchestrator] Merger agent timed out after 5 minutes");
          handle.kill();
        },
        300_000
      );
    });
  }

  /**
   * Progressive backoff error handler (PRDv2 §9.1) with failure classification.
   *
   * Key improvements:
   *   - Infrastructure failures (crash, timeout, merge_conflict) get free retries
   *     and don't count toward the progressive backoff budget.
   *   - On immediate retries, the branch and worktree are PRESERVED so the agent
   *     can build on its previous work rather than starting from scratch.
   *   - On demotion points (every 3rd backoff-eligible failure), branch is deleted
   *     for a clean slate.
   *   - Richer retry context: test output, diff, and failure type are passed to
   *     the next coding attempt.
   */
  private async handleTaskFailure(
    projectId: string,
    repoPath: string,
    task: BeadsIssue,
    branchName: string,
    reason: string,
    testResults?: TestResults | null,
    failureType: FailureType = "coding_failure",
    reviewFeedback?: string
  ): Promise<void> {
    const state = this.getState(projectId);
    const cumulativeAttempts = state.attempt;
    const wtPath = state.activeWorktreePath;
    const isInfraFailure = INFRA_FAILURE_TYPES.includes(failureType);

    console.error(
      `Task ${task.id} failed [${failureType}] (attempt ${cumulativeAttempts}): ${reason}`
    );

    // Capture diff before any cleanup (for richer retry context and session archive)
    let previousDiff = "";
    let gitDiff = "";
    try {
      const branchDiff = await this.branchManager.captureBranchDiff(repoPath, branchName);
      previousDiff = branchDiff;
      let uncommittedDiff = "";
      if (wtPath) {
        uncommittedDiff = await this.branchManager.captureUncommittedDiff(wtPath);
      }
      gitDiff = [branchDiff, uncommittedDiff]
        .filter(Boolean)
        .join("\n\n--- Uncommitted changes ---\n\n");
    } catch {
      // Branch may not exist
    }

    // Archive failure session (always, even on immediate retry)
    const session = await this.sessionManager.createSession(repoPath, {
      taskId: task.id,
      attempt: cumulativeAttempts,
      agentType: (await this.projectService.getSettings(projectId)).codingAgent.type,
      agentModel: (await this.projectService.getSettings(projectId)).codingAgent.model || "",
      gitBranch: branchName,
      status: "failed",
      outputLog: state.agent.outputLog.join(""),
      failureReason: reason,
      testResults: testResults ?? undefined,
      gitDiff: gitDiff || undefined,
      startedAt: state.agent.startedAt,
    });
    await this.sessionManager.archiveSession(
      repoPath,
      task.id,
      cumulativeAttempts,
      session,
      wtPath ?? undefined
    );

    // Add failure comment for audit trail (PRD §7.3.2: rejection feedback as bead comment)
    const commentText =
      failureType === "review_rejection" && reviewFeedback
        ? `Review rejected (attempt ${cumulativeAttempts}):\n\n${reviewFeedback.slice(0, 2000)}`
        : `Attempt ${cumulativeAttempts} failed [${failureType}]: ${reason.slice(0, 500)}`;
    await this.beads
      .comment(repoPath, task.id, commentText)
      .catch((err) => console.warn("[orchestrator] Failed to add failure comment:", err));

    // Infrastructure failures get free retries (up to MAX_INFRA_RETRIES)
    if (isInfraFailure && state.infraRetries < MAX_INFRA_RETRIES) {
      state.infraRetries += 1;
      state.attempt = cumulativeAttempts + 1;
      console.log(
        `[orchestrator] Infrastructure retry ${state.infraRetries}/${MAX_INFRA_RETRIES} for ${task.id} [${failureType}]`
      );

      // Clean up worktree but keep the branch for retry
      if (wtPath) {
        await this.branchManager.removeTaskWorktree(repoPath, task.id);
        state.activeWorktreePath = null;
      }

      await this.persistState(projectId, repoPath);
      await this.executeCodingPhase(projectId, repoPath, task, {
        previousFailure: reason,
        reviewFeedback,
        useExistingBranch: true,
        previousDiff,
        previousTestOutput: state.phaseResult.testOutput || undefined,
        failureType,
      });
      return;
    }

    // Reset infra retry counter for agent-attributable failures
    if (!isInfraFailure) {
      state.infraRetries = 0;
    }

    // Persist cumulative attempt count on the bead issue (PRDv2 §9.1)
    await this.beads.setCumulativeAttempts(repoPath, task.id, cumulativeAttempts);

    const isDemotionPoint = cumulativeAttempts % BACKOFF_FAILURE_THRESHOLD === 0;

    if (!isDemotionPoint) {
      // Immediate retry — KEEP the branch so agent builds on previous work
      if (wtPath) {
        await this.branchManager.removeTaskWorktree(repoPath, task.id);
        state.activeWorktreePath = null;
      }

      state.attempt = cumulativeAttempts + 1;
      console.log(
        `[orchestrator] Retrying ${task.id} (attempt ${state.attempt}), preserving branch`
      );

      await this.persistState(projectId, repoPath);

      await this.executeCodingPhase(projectId, repoPath, task, {
        previousFailure: reason,
        reviewFeedback,
        useExistingBranch: true,
        previousDiff,
        previousTestOutput: state.phaseResult.testOutput || undefined,
        failureType,
      });
    } else {
      // Demotion point: clean slate — delete branch and worktree
      if (wtPath) {
        await this.branchManager.removeTaskWorktree(repoPath, task.id);
        state.activeWorktreePath = null;
      }
      await this.branchManager.deleteBranch(repoPath, branchName);

      const currentPriority = task.priority ?? 2;

      if (currentPriority >= MAX_PRIORITY_BEFORE_BLOCK) {
        await this.blockTask(projectId, repoPath, task, cumulativeAttempts, reason);
      } else {
        const newPriority = currentPriority + 1;
        console.log(
          `[orchestrator] Demoting ${task.id} priority ${currentPriority} → ${newPriority} after ${cumulativeAttempts} failures`
        );

        try {
          await this.beads.update(repoPath, task.id, {
            status: "open",
            assignee: "",
            priority: newPriority,
          });
        } catch {
          // Task may already be in the right state
        }

        this.transition(projectId, { to: "fail" });
        await this.clearPersistedState(repoPath);

        broadcastToProject(projectId, {
          type: "task.updated",
          taskId: task.id,
          status: "open",
          assignee: null,
        });
        broadcastToProject(projectId, {
          type: "agent.completed",
          taskId: task.id,
          status: "failed",
          testResults: null,
        });

        state.loopActive = false;
        state.timers.setTimeout(
          "loop",
          () => {
            this.nudge(projectId);
          },
          2000
        );
      }
    }
  }

  // ─── Helpers ───

  /** Run Summarizer agent to condense context when thresholds exceeded (PRD §7.3.2, §12.3.5) */
  private async runSummarizer(
    projectId: string,
    settings: { planningAgent: import("@opensprint/shared").AgentConfig },
    taskId: string,
    context: TaskContext
  ): Promise<TaskContext> {
    const depCount = context.dependencyOutputs.length;
    const planWordCount = countWords(context.planContent);
    const summarizerPrompt = buildSummarizerPrompt(taskId, context, depCount, planWordCount);
    const systemPrompt = `You are the Summarizer agent for OpenSprint (PRD §12.3.5). Condense context into a focused summary when it exceeds size thresholds.`;
    const summarizerId = `summarizer-${projectId}-${taskId}-${Date.now()}`;

    try {
      const summarizerResponse = await agentService.invokePlanningAgent({
        config: settings.planningAgent,
        messages: [{ role: "user", content: summarizerPrompt }],
        systemPrompt,
        tracking: {
          id: summarizerId,
          projectId,
          phase: "execute",
          role: "summarizer",
          label: "Context condensation",
        },
      });

      const jsonMatch = summarizerResponse.content.match(/\{[\s\S]*"status"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]) as { status: string; summary?: string };
          if (parsed.status === "success" && parsed.summary?.trim()) {
            console.log(`[orchestrator] Summarizer condensed context for task ${taskId}`);
            return {
              ...context,
              planContent: parsed.summary.trim(),
              prdExcerpt:
                "Context condensed by Summarizer (thresholds exceeded). See plan.md for full context.",
              dependencyOutputs: [],
            };
          }
        } catch {
          // Fall through: use raw context if Summarizer output unparseable
        }
      }
    } catch (err) {
      console.warn(
        `[orchestrator] Summarizer failed for ${taskId}, using raw context:`,
        err instanceof Error ? err.message : err
      );
    }
    return context;
  }

  private async preflightCheck(repoPath: string, wtPath: string, taskId: string): Promise<void> {
    // 1. Ensure git is ready (no stale locks)
    await this.branchManager.waitForGitReady(wtPath);

    // 2. Ensure node_modules symlink is intact
    try {
      await fs.access(path.join(wtPath, "node_modules"));
    } catch {
      console.warn("[orchestrator] Pre-flight: node_modules missing, re-symlinking");
      await this.branchManager.symlinkNodeModules(repoPath, wtPath);
    }

    // 3. Clear stale result.json from a previous run
    await this.sessionManager.clearResult(wtPath, taskId);
  }

  /**
   * Block a task after progressive backoff exhaustion (PRDv2 §9.1).
   * Sets beads status to blocked via bd update --status blocked; emits task.blocked.
   */
  private async blockTask(
    projectId: string,
    repoPath: string,
    task: BeadsIssue,
    cumulativeAttempts: number,
    reason: string
  ): Promise<void> {
    const state = this.getState(projectId);

    console.log(
      `[orchestrator] Blocking ${task.id} after ${cumulativeAttempts} cumulative failures at max priority`
    );

    try {
      await this.beads.update(repoPath, task.id, {
        status: "blocked",
        assignee: "",
      });
    } catch (err) {
      console.warn("[orchestrator] Failed to block task:", err);
    }

    this.transition(projectId, { to: "fail" });
    await this.clearPersistedState(repoPath);

    broadcastToProject(projectId, {
      type: "task.blocked",
      taskId: task.id,
      reason: `Blocked after ${cumulativeAttempts} failed attempts: ${reason.slice(0, 300)}`,
      cumulativeAttempts,
    });
    broadcastToProject(projectId, {
      type: "task.updated",
      taskId: task.id,
      status: "blocked",
      assignee: null,
    });
    broadcastToProject(projectId, {
      type: "agent.completed",
      taskId: task.id,
      status: "failed",
      testResults: null,
    });

    // Mark loop idle and schedule next iteration
    state.loopActive = false;
    state.timers.setTimeout(
      "loop",
      () => {
        this.nudge(projectId);
      },
      2000
    );
  }
}

/** Shared orchestrator instance for build routes and task list (kanban phase override) */
export const orchestratorService = new OrchestratorService();
