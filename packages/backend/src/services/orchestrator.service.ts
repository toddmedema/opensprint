import fs from "fs/promises";
import path from "path";
import type {
  OrchestratorStatus,
  ActiveAgent,
  CodingAgentResult,
  ReviewAgentResult,
  TestResults,
  PendingFeedbackCategorization,
  AgentConfig,
} from "@opensprint/shared";
import {
  AGENT_INACTIVITY_TIMEOUT_MS,
  OPENSPRINT_PATHS,
  resolveTestCommand,
  DEFAULT_REVIEW_MODE,
  type ReviewAngle,
  getAgentForPlanningRole,
  getAgentName,
  getAgentNameForRole,
  getAgentForComplexity,
  getProviderForAgentType,
  AGENT_NAMES,
  AGENT_NAMES_BY_ROLE,
  OPEN_QUESTION_BLOCK_REASON,
  REVIEW_ANGLE_OPTIONS,
  type PlanComplexity,
  type AgentSuspendReason,
} from "@opensprint/shared";
import { taskStore as taskStoreSingleton, type StoredTask } from "./task-store.service.js";
import { ProjectService } from "./project.service.js";
import { agentService, createProcessGroupHandle } from "./agent.service.js";
import { BranchManager, WorktreeBranchInUseError } from "./branch-manager.js";
import { ContextAssembler } from "./context-assembler.js";
import { SessionManager } from "./session-manager.js";
import { getCombinedInstructions } from "./agent-instructions.service.js";
import { buildSummarizerPrompt, countWords } from "./summarizer.service.js";
import type { TaskContext } from "./context-assembler.js";
import { TestRunner } from "./test-runner.js";
import { activeAgentsService } from "./active-agents.service.js";
import { recoveryService, type RecoveryHost, type GuppAssignment } from "./recovery.service.js";
import { FeedbackService } from "./feedback.service.js";
import { notificationService } from "./notification.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { getErrorMessage } from "../utils/error-utils.js";
import { extractJsonFromAgentResponse } from "../utils/json-extract.js";
import { assertSafeTaskWorktreePath } from "../utils/path-safety.js";
import { TimerRegistry } from "./timer-registry.js";
import { AgentLifecycleManager, type AgentRunState } from "./agent-lifecycle.js";
import { heartbeatService } from "./heartbeat.service.js";
import { FileScopeAnalyzer, type FileScope } from "./file-scope-analyzer.js";
import { TaskScheduler } from "./task-scheduler.js";
import { normalizeCodingStatus, normalizeReviewStatus } from "./result-normalizers.js";
import { eventLogService } from "./event-log.service.js";
import { createLogger } from "../utils/logger.js";
import { PhaseExecutorService, type PhaseExecutorHost } from "./phase-executor.service.js";
import { FailureHandlerService, type FailureHandlerHost } from "./failure-handler.service.js";
import { MergeCoordinatorService, type MergeCoordinatorHost } from "./merge-coordinator.service.js";
import {
  TaskPhaseCoordinator,
  type TestOutcome,
  type ReviewOutcome,
} from "./task-phase-coordinator.js";
import { reviewSynthesizerService } from "./review-synthesizer.service.js";
import { validateTransition } from "./task-state-machine.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { getNextKey } from "./api-key-resolver.service.js";
import { isExhausted, clearExhausted } from "./api-key-exhausted.service.js";
import { getComplexityForAgent } from "./plan-complexity.js";
import {
  buildTaskLastExecutionSummary,
  compactExecutionText,
  persistTaskLastExecutionSummary,
} from "./task-execution-summary.js";
import {
  assertGitIdentityConfigured,
  ensureBaseBranchExists,
  inspectGitRepoState,
  RepoPreflightError,
  resolveBaseBranch,
} from "../utils/git-repo-state.js";
import {
  buildOrchestratorTestStatusContent,
  getOrchestratorTestStatusFsPath,
} from "./orchestrator-test-status.js";

const log = createLogger("orchestrator");

import type { FailureType, RetryContext } from "./orchestrator-phase-context.js";

/** Loop kicker interval: 60s — restarts idle orchestrator loop (distinct from 5-min WatchdogService health patrol). */
const LOOP_KICKER_INTERVAL_MS = 60 * 1000;

/** If runLoop is blocked in an await longer than this, force recovery so nudge can start a fresh loop (avoids agents "hanging" for hours). */
const LOOP_STUCK_GUARD_MS = 5 * 60 * 1000;
/** Temporary throttle: start at most one new coder per loop pass while no_result failures are under investigation. */
const MAX_NEW_TASKS_PER_LOOP = 1;

/**
 * GUPP-style assignment file: everything an agent needs to self-start.
 * Written before agent spawn so crash recovery can simply re-read and re-spawn.
 */
export interface TaskAssignment {
  taskId: string;
  projectId: string;
  phase: "coding" | "review";
  branchName: string;
  worktreePath: string;
  promptPath: string;
  agentConfig: AgentConfig;
  attempt: number;
  retryContext?: RetryContext;
  createdAt: string;
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

const REVIEW_AGENT_ID_DELIMITER = "--review--";
const REVIEW_ANGLE_ACTIVE_LABELS: Record<ReviewAngle, string> = {
  security: "Security",
  performance: "Performance",
  test_coverage: "Test Coverage",
  code_quality: "Code Quality",
  design_ux_accessibility: "Design/UX",
};

function buildReviewAgentId(taskId: string, angle: string): string {
  return `${taskId}${REVIEW_AGENT_ID_DELIMITER}${angle}`;
}

/** Results carried over from coding phase to review/merge */
interface PhaseResult {
  codingDiff: string;
  codingSummary: string;
  testResults: TestResults | null;
  testOutput: string;
}

interface ReviewAgentSlotState {
  angle: ReviewAngle;
  agent: AgentRunState;
  timers: TimerRegistry;
}

// ─── Slot-based State Model (v2) ───

/** Per-task agent slot. Encapsulates all state for one active agent. */
export interface AgentSlot {
  taskId: string;
  taskTitle: string | null;
  branchName: string;
  worktreePath: string | null;
  agent: AgentRunState;
  phase: "coding" | "review";
  attempt: number;
  phaseResult: PhaseResult;
  infraRetries: number;
  timers: TimerRegistry;
  reviewAgents?: Map<ReviewAngle, ReviewAgentSlotState>;
  fileScope?: FileScope;
  /** Coordinator for joining parallel test + review when both are enabled. */
  phaseCoordinator?: TaskPhaseCoordinator;
  /** Display name for this slot (e.g. "Frodo", "Boromir"); set at start_task or enter_review. */
  assignee?: string;
}

interface OrchestratorState {
  status: OrchestratorStatus;
  loopActive: boolean;
  /** Incremented each runLoop start; used so a stale (stuck) run doesn't clear loopActive when a recovered run is active */
  loopRunId: number;
  globalTimers: TimerRegistry;
  slots: Map<string, AgentSlot>;
  /** Cached Summarizer output per taskId; reused on retries, cleared when slot is removed */
  summarizerCache: Map<string, TaskContext>;
  pendingFeedbackCategorizations: PendingFeedbackCategorization[];
  /** Monotonic index for next coder name (Frodo, Samwise, …); advanced when starting a task and after reattach. */
  nextCoderIndex: number;
  /** Monotonic index for next reviewer name (Boromir, Imrahil, …); advanced when entering review. */
  nextReviewerIndex: number;
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
      /** Slot to add after validation; not in state yet so currentPhase stays "idle". */
      slot: AgentSlot;
    }
  | { to: "enter_review"; taskId: string; queueDepth: number; assignee: string }
  | { to: "complete"; taskId: string }
  | { to: "fail"; taskId: string };

/** Persisted counters (lightweight replacement for orchestrator-state.json) */
interface OrchestratorCounters {
  totalDone: number;
  totalFailed: number;
  queueDepth: number;
}

/**
 * Build orchestrator service.
 * Manages the multi-agent build loop: poll bd ready -> assign -> spawn agent -> monitor -> handle result.
 * Supports concurrent coder agents via slot-based state model.
 */
export class OrchestratorService {
  private state = new Map<string, OrchestratorState>();
  private taskStore = taskStoreSingleton;
  private projectService = new ProjectService();
  private branchManager = new BranchManager();
  private contextAssembler = new ContextAssembler();
  private sessionManager = new SessionManager();
  private testRunner = new TestRunner();
  private feedbackService = new FeedbackService();
  private lifecycleManager = new AgentLifecycleManager();
  private fileScopeAnalyzer = new FileScopeAnalyzer();
  private taskScheduler = new TaskScheduler(this.taskStore);
  /** Cached repoPath per project (avoids async lookup in synchronous transition()) */
  private repoPathCache = new Map<string, string>();
  /** Cached effective maxSlots per project (branches mode forces 1; avoids async lookup in nudge()) */
  private maxSlotsCache = new Map<string, number>();
  private failureHandler = new FailureHandlerService(this as unknown as FailureHandlerHost);
  private mergeCoordinator = new MergeCoordinatorService(this as unknown as MergeCoordinatorHost);

  private phaseExecutor = new PhaseExecutorService(this as unknown as PhaseExecutorHost, {
    handleCodingDone: (a, b, c, d, e) => this.handleCodingDone(a, b, c, d, e),
    handleReviewDone: (a, b, c, d, e, f) => this.handleReviewDone(a, b, c, d, e, f),
    handleTaskFailure: (a, b, c, d, e, f, g, h) =>
      this.failureHandler.handleTaskFailure(a, b, c, d, e, f, g as FailureType | undefined, h),
    handleApiKeysExhausted: (a, b, c, d, provider) =>
      this.handleApiKeysExhausted(a, b, c, d, provider),
  });

  private getState(projectId: string): OrchestratorState {
    if (!this.state.has(projectId)) {
      this.state.set(projectId, {
        status: this.defaultStatus(),
        loopActive: false,
        loopRunId: 0,
        globalTimers: new TimerRegistry(),
        slots: new Map(),
        summarizerCache: new Map(),
        pendingFeedbackCategorizations: [],
        nextCoderIndex: 0,
        nextReviewerIndex: 0,
      });
    }
    return this.state.get(projectId)!;
  }

  private defaultStatus(): OrchestratorStatus {
    return {
      activeTasks: [],
      queueDepth: 0,
      totalDone: 0,
      totalFailed: 0,
    };
  }

  /** Create a new AgentSlot for a task (optionally with assignee for recovery). */
  private createSlot(
    taskId: string,
    taskTitle: string | null,
    branchName: string,
    attempt: number,
    assignee?: string
  ): AgentSlot {
    return {
      taskId,
      taskTitle,
      branchName,
      worktreePath: null,
      agent: {
        activeProcess: null,
        lastOutputTime: 0,
        lastOutputAtIso: undefined,
        outputLog: [],
        outputLogBytes: 0,
        outputParseBuffer: "",
        activeToolCallIds: new Set<string>(),
        activeToolCallSummaries: new Map<string, string | null>(),
        startedAt: new Date().toISOString(),
        exitHandled: false,
        killedDueToTimeout: false,
        lifecycleState: "running",
        suspendedAtIso: undefined,
        suspendReason: undefined,
        suspendDeadlineMs: undefined,
      },
      phase: "coding",
      attempt,
      phaseResult: { codingDiff: "", codingSummary: "", testResults: null, testOutput: "" },
      infraRetries: 0,
      timers: new TimerRegistry(),
      ...(assignee != null && { assignee }),
    };
  }

  /** Build activeTasks array from current slots for status/broadcast */
  private buildActiveTasks(state: OrchestratorState): OrchestratorStatus["activeTasks"] {
    const tasks: OrchestratorStatus["activeTasks"] = [];
    for (const slot of state.slots.values()) {
      if (slot.phase === "review" && slot.reviewAgents && slot.reviewAgents.size > 0) {
        for (const reviewAgent of slot.reviewAgents.values()) {
          const angleLabel =
            REVIEW_ANGLE_ACTIVE_LABELS[reviewAgent.angle] ??
            REVIEW_ANGLE_OPTIONS.find((o) => o.value === reviewAgent.angle)?.label ??
            reviewAgent.angle;
          tasks.push({
            taskId: slot.taskId,
            phase: slot.phase,
            startedAt: reviewAgent.agent.startedAt || new Date().toISOString(),
            state: reviewAgent.agent.lifecycleState,
            id: buildReviewAgentId(slot.taskId, reviewAgent.angle),
            name: `Reviewer (${angleLabel})`,
            ...(reviewAgent.agent.lastOutputAtIso
              ? { lastOutputAt: reviewAgent.agent.lastOutputAtIso }
              : {}),
            ...(reviewAgent.agent.suspendedAtIso
              ? { suspendedAt: reviewAgent.agent.suspendedAtIso }
              : {}),
            ...(reviewAgent.agent.suspendReason
              ? { suspendReason: reviewAgent.agent.suspendReason }
              : {}),
          });
        }
        continue;
      }
      tasks.push({
        taskId: slot.taskId,
        phase: slot.phase,
        startedAt: slot.agent.startedAt || new Date().toISOString(),
        state: slot.agent.lifecycleState,
        ...(slot.agent.lastOutputAtIso ? { lastOutputAt: slot.agent.lastOutputAtIso } : {}),
        ...(slot.agent.suspendedAtIso ? { suspendedAt: slot.agent.suspendedAtIso } : {}),
        ...(slot.agent.suspendReason ? { suspendReason: slot.agent.suspendReason } : {}),
      });
    }
    return tasks;
  }

  /**
   * Centralized state transition with logging and broadcasting.
   */
  private transition(projectId: string, t: TransitionTarget): void {
    const state = this.getState(projectId);
    const existingSlot = state.slots.get(t.taskId);
    const currentPhase = existingSlot?.phase ?? "idle";
    validateTransition(t.taskId, currentPhase, t.to);

    switch (t.to) {
      case "start_task": {
        state.slots.set(t.taskId, t.slot);
        broadcastToProject(projectId, {
          type: "execute.status",
          activeTasks: this.buildActiveTasks(state),
          queueDepth: t.queueDepth,
        });
        break;
      }

      case "enter_review": {
        const slot = state.slots.get(t.taskId);
        if (slot) {
          slot.phase = "review";
          slot.assignee = t.assignee;
        }
        broadcastToProject(projectId, {
          type: "task.updated",
          taskId: t.taskId,
          status: "in_progress",
          assignee: t.assignee,
        });
        broadcastToProject(projectId, {
          type: "execute.status",
          activeTasks: this.buildActiveTasks(state),
          queueDepth: t.queueDepth,
        });
        break;
      }

      case "complete":
        state.status.totalDone += 1;
        this.removeSlot(state, t.taskId);
        broadcastToProject(projectId, {
          type: "execute.status",
          activeTasks: this.buildActiveTasks(state),
          queueDepth: state.status.queueDepth,
        });
        break;

      case "fail":
        state.status.totalFailed += 1;
        this.removeSlot(state, t.taskId);
        broadcastToProject(projectId, {
          type: "execute.status",
          activeTasks: this.buildActiveTasks(state),
          queueDepth: state.status.queueDepth,
        });
        break;
    }

    const activeTask = state.slots.get(t.taskId);
    log.info(`Transition [${projectId}]: → ${t.to} (task: ${t.taskId})`);

    const repoPath = this.repoPathCache.get(projectId);
    if (repoPath) {
      eventLogService
        .append(repoPath, {
          timestamp: new Date().toISOString(),
          projectId,
          taskId: t.taskId,
          event: `transition.${t.to}`,
          data: { attempt: activeTask?.attempt },
        })
        .catch(() => {});
    }
  }

  private killProcessIfActive(agent: AgentRunState): void {
    if (!agent.activeProcess) return;
    try {
      agent.activeProcess.kill();
    } catch {
      // Process may already be dead
    }
    agent.activeProcess = null;
  }

  private cleanupReviewAgents(slot: AgentSlot): void {
    if (!slot.reviewAgents) return;
    for (const reviewAgent of slot.reviewAgents.values()) {
      reviewAgent.timers.clearAll();
      this.killProcessIfActive(reviewAgent.agent);
    }
    slot.reviewAgents = undefined;
  }

  /** Remove a slot and clean up its per-slot timers and summarizer cache. Kills active agent process if any. */
  private removeSlot(state: OrchestratorState, taskId: string): void {
    const slot = state.slots.get(taskId);
    if (slot) {
      slot.timers.clearAll();
      this.killProcessIfActive(slot.agent);
      this.cleanupReviewAgents(slot);
      state.slots.delete(taskId);
      state.summarizerCache.delete(taskId);
    }
    state.status.activeTasks = this.buildActiveTasks(state);
  }

  /** Delete assignment.json for a task (from main repo or from given base path e.g. worktree) */
  private async deleteAssignment(repoPath: string, taskId: string): Promise<void> {
    await this.deleteAssignmentAt(repoPath, taskId, undefined);
  }

  private async deleteAssignmentAt(
    repoPath: string,
    taskId: string,
    basePath: string | undefined
  ): Promise<void> {
    const pathsToDelete = [repoPath];
    if (basePath && path.resolve(basePath) !== path.resolve(repoPath)) {
      pathsToDelete.push(basePath);
    }
    for (const root of pathsToDelete) {
      const assignmentPath = path.join(
        root,
        OPENSPRINT_PATHS.active,
        taskId,
        OPENSPRINT_PATHS.assignment
      );
      try {
        await fs.unlink(assignmentPath);
      } catch {
        // File may not exist
      }
    }
  }

  // ─── Counters Persistence (SQL-only) ───

  private async persistCounters(projectId: string, _repoPath: string): Promise<void> {
    const state = this.getState(projectId);
    const now = new Date().toISOString();
    try {
      await taskStoreSingleton.runWrite(async (client) => {
        await client.execute(
          `INSERT INTO orchestrator_counters (project_id, total_done, total_failed, queue_depth, updated_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT(project_id) DO UPDATE SET
             total_done = excluded.total_done,
             total_failed = excluded.total_failed,
             queue_depth = excluded.queue_depth,
             updated_at = excluded.updated_at`,
          [
            projectId,
            state.status.totalDone,
            state.status.totalFailed,
            state.status.queueDepth,
            now,
          ]
        );
      });
    } catch (err) {
      log.warn("Failed to persist counters", { err });
    }
  }

  private async loadCounters(repoPath: string): Promise<OrchestratorCounters | null> {
    const project = await this.projectService.getProjectByRepoPath(repoPath);
    if (!project) return null;
    const client = await taskStoreSingleton.getDb();
    const row = await client.queryOne(
      "SELECT total_done, total_failed, queue_depth FROM orchestrator_counters WHERE project_id = $1",
      [project.id]
    );
    if (!row) return null;
    return {
      totalDone: row.total_done as number,
      totalFailed: row.total_failed as number,
      queueDepth: row.queue_depth as number,
    };
  }

  // ─── Crash Recovery (GUPP-style: scan assignment.json files) ───

  /**
   * If the project no longer exists (e.g. removed from index), clean up slot and return false.
   * Used when onDone runs after a project was deleted so we don't throw PROJECT_NOT_FOUND.
   */
  private async cleanupSlotIfProjectGone(
    projectId: string,
    repoPath: string,
    taskId: string,
    state: OrchestratorState,
    slot: AgentSlot | undefined,
    context: string
  ): Promise<boolean> {
    try {
      await this.projectService.getProject(projectId);
      return true;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code !== ErrorCodes.PROJECT_NOT_FOUND) throw err;
      log.warn("Project no longer exists; cleaning up task slot", {
        projectId,
        taskId,
        context,
      });
      const wtPath = slot?.worktreePath ?? repoPath;
      await heartbeatService.deleteHeartbeat(wtPath, taskId).catch(() => {});
      if (slot?.worktreePath && slot.worktreePath !== repoPath) {
        try {
          await this.branchManager.removeTaskWorktree(repoPath, taskId, slot.worktreePath);
        } catch {
          // Best effort; worktree may already be gone
        }
      }
      await this.deleteAssignmentAt(repoPath, taskId, slot?.worktreePath ?? undefined);
      if (slot) this.removeSlot(state, taskId);
      return false;
    }
  }

  /**
   * Remove slots whose task no longer exists in task store (e.g. archived).
   * Called before building active tasks so getStatus/getActiveAgents never report phantom agents.
   * When validTaskIds is provided (e.g. from listTasks), avoids a second listAll call.
   * When listAll returns no tasks but we have slots, we skip reconciliation to avoid killing
   * agents on transient empty results (wrong DB, connection issue, or external wipe).
   */
  private async reconcileStaleSlots(projectId: string, validTaskIds?: Set<string>): Promise<void> {
    const state = this.getState(projectId);
    if (state.slots.size === 0) return;

    const validIds =
      validTaskIds ??
      new Set(
        (await this.taskStore.listAll(projectId)).map((i) => i.id).filter(Boolean) as string[]
      );

    // Do not treat slots as stale when the task list is empty. Empty list can mean real deletion
    // (e.g. another process) or a transient/wrong-DB result; killing agents on empty list causes
    // "tasks disappeared then orchestrator killed agents" with no way to recover.
    if (validIds.size === 0) {
      log.warn("Skipping stale-slot reconciliation: listAll returned 0 tasks but we have slots", {
        projectId,
        slotCount: state.slots.size,
        slotTaskIds: [...state.slots.keys()],
      });
      return;
    }

    const repoPath = await this.projectService.getRepoPath(projectId);
    let removed = false;

    for (const [taskId, slot] of [...state.slots]) {
      if (validIds.has(taskId)) continue;
      log.warn("Removing stale slot: task no longer in task store", { projectId, taskId });
      if (slot.agent.activeProcess) {
        try {
          slot.agent.activeProcess.kill();
        } catch {
          /* may be dead */
        }
        slot.agent.activeProcess = null;
      }
      const wtPath = slot.worktreePath ?? repoPath;
      await heartbeatService.deleteHeartbeat(wtPath, taskId);
      if (slot.worktreePath && slot.worktreePath !== repoPath) {
        try {
          await this.branchManager.removeTaskWorktree(repoPath, taskId, slot.worktreePath);
        } catch {
          // Best effort; worktree may already be gone
        }
      }
      await this.deleteAssignmentAt(repoPath, taskId, slot.worktreePath ?? undefined);
      this.removeSlot(state, taskId);
      removed = true;
    }

    if (removed) {
      broadcastToProject(projectId, {
        type: "execute.status",
        activeTasks: this.buildActiveTasks(state),
        queueDepth: state.status.queueDepth,
      });
    }
  }

  /**
   * Kill an agent by ID (taskId for Execute agents). Returns true if the agent was
   * found and terminated, false if not in slots (e.g. planning agent or already gone).
   * Used by the Kill button in the agents dropdown for agents running >30 minutes.
   */
  async killAgent(projectId: string, agentId: string): Promise<boolean> {
    const state = this.getState(projectId);
    const slot = state.slots.get(agentId);
    if (slot) {
      await this.stopTaskAndFreeSlot(projectId, agentId);
      return true;
    }

    for (const reviewSlot of state.slots.values()) {
      if (!reviewSlot.reviewAgents || reviewSlot.reviewAgents.size === 0) continue;
      for (const [angle, reviewAgent] of reviewSlot.reviewAgents.entries()) {
        if (buildReviewAgentId(reviewSlot.taskId, angle) !== agentId) continue;
        this.killProcessIfActive(reviewAgent.agent);
        return true;
      }
    }
    return false;
  }

  /**
   * If the task has an active agent, kill it and free the slot; then nudge the loop.
   * Used when the user marks a task done so the slot is freed for other work.
   */
  async stopTaskAndFreeSlot(projectId: string, taskId: string): Promise<void> {
    const state = this.getState(projectId);
    const slot = state.slots.get(taskId);
    if (!slot) return;

    log.info("Stopping agent for user-marked-done task", { projectId, taskId });
    if (slot.agent.activeProcess) {
      try {
        slot.agent.activeProcess.kill();
      } catch {
        // Process may already be dead
      }
      slot.agent.activeProcess = null;
    }
    try {
      const repoPath = await this.projectService.getRepoPath(projectId);
      const wtPath = slot.worktreePath ?? repoPath;
      await heartbeatService.deleteHeartbeat(wtPath, taskId);
      if (slot.worktreePath && slot.worktreePath !== repoPath) {
        try {
          await this.branchManager.removeTaskWorktree(repoPath, taskId, slot.worktreePath);
        } catch {
          // Best effort; worktree may already be gone
        }
      }
      await this.deleteAssignmentAt(repoPath, taskId, slot.worktreePath ?? undefined);
    } catch (err) {
      log.warn("Cleanup on stopTaskAndFreeSlot failed, still freeing slot", {
        projectId,
        taskId,
        err,
      });
    }
    this.removeSlot(state, taskId);

    broadcastToProject(projectId, {
      type: "execute.status",
      activeTasks: this.buildActiveTasks(state),
      queueDepth: state.status.queueDepth,
    });
    this.nudge(projectId);
  }

  // ─── Lifecycle ───

  stopProject(projectId: string): void {
    const state = this.state.get(projectId);
    if (!state) return;

    log.info(`Stopping orchestrator for project ${projectId}`);

    state.globalTimers.clearAll();

    for (const slot of state.slots.values()) {
      slot.timers.clearAll();
      const preserveAgents = process.env.OPENSPRINT_PRESERVE_AGENTS === "1";
      if (!preserveAgents) this.killProcessIfActive(slot.agent);
      else slot.agent.activeProcess = null;
      if (slot.reviewAgents) {
        for (const reviewAgent of slot.reviewAgents.values()) {
          reviewAgent.timers.clearAll();
          if (!preserveAgents) this.killProcessIfActive(reviewAgent.agent);
          else reviewAgent.agent.activeProcess = null;
        }
      }
    }

    state.loopActive = false;
    this.state.delete(projectId);

    log.info(`Orchestrator stopped for project ${projectId}`);
  }

  stopAll(): void {
    for (const projectId of [...this.state.keys()]) {
      this.stopProject(projectId);
    }
  }

  private emitExecuteStatus(projectId: string): void {
    const state = this.getState(projectId);
    broadcastToProject(projectId, {
      type: "execute.status",
      activeTasks: this.buildActiveTasks(state),
      queueDepth: state.status.queueDepth,
    });
  }

  private onAgentStateChange(projectId: string): () => void {
    return () => {
      this.emitExecuteStatus(projectId);
    };
  }

  private shouldStartRecoveredAgentSuspended(
    lastOutputTimestamp: number | undefined,
    fallbackReason: AgentSuspendReason = "backend_restart"
  ): AgentSuspendReason | undefined {
    if (
      typeof lastOutputTimestamp !== "number" ||
      Date.now() - lastOutputTimestamp <= AGENT_INACTIVITY_TIMEOUT_MS
    ) {
      return undefined;
    }
    return fallbackReason;
  }

  private async reattachRecoveredCodingTask(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    assignment: GuppAssignment,
    options?: { suspendReason?: AgentSuspendReason }
  ): Promise<boolean> {
    const state = this.getState(projectId);
    const existingSlot = state.slots.get(task.id);
    if (existingSlot) {
      if (options?.suspendReason) {
        await this.lifecycleManager.markSuspended(
          {
            projectId,
            taskId: task.id,
            repoPath,
            phase: "coding",
            wtPath: assignment.worktreePath,
            branchName: assignment.branchName,
            promptPath: assignment.promptPath,
            agentConfig: assignment.agentConfig as AgentConfig,
            attempt: assignment.attempt,
            agentLabel: existingSlot.taskTitle ?? task.id,
            role: "coder",
            onDone: (code) =>
              this.handleCodingDone(projectId, repoPath, task, assignment.branchName, code),
            onStateChange: this.onAgentStateChange(projectId),
          },
          existingSlot.agent,
          options.suspendReason
        );
      }
      return true;
    }

    log.info("Recovery: re-attaching to running agent", { taskId: task.id });
    const assignee = task.assignee ?? getAgentName(0);
    const slot = this.createSlot(
      task.id,
      task.title ?? null,
      assignment.branchName,
      assignment.attempt,
      assignee
    );
    slot.worktreePath = assignment.worktreePath;
    slot.agent.startedAt = assignment.createdAt;

    broadcastToProject(projectId, {
      type: "agent.started",
      taskId: task.id,
      phase: "coding",
      branchName: assignment.branchName,
      startedAt: assignment.createdAt,
    });
    this.transition(projectId, {
      to: "start_task",
      taskId: task.id,
      taskTitle: slot.taskTitle,
      branchName: assignment.branchName,
      attempt: assignment.attempt,
      queueDepth: state.status.queueDepth,
      slot,
    });

    const coderIdx = AGENT_NAMES.indexOf(task.assignee as (typeof AGENT_NAMES)[number]);
    if (coderIdx >= 0) state.nextCoderIndex = Math.max(state.nextCoderIndex, coderIdx + 1);

    const heartbeat = await heartbeatService.readHeartbeat(assignment.worktreePath, task.id);
    if (!heartbeat?.processGroupLeaderPid) return false;
    const handle = createProcessGroupHandle(heartbeat.processGroupLeaderPid);
    const initialSuspendReason =
      options?.suspendReason ??
      this.shouldStartRecoveredAgentSuspended(heartbeat.lastOutputTimestamp);

    await this.lifecycleManager.resumeMonitoring(
      handle,
      {
        projectId,
        taskId: task.id,
        repoPath,
        phase: "coding",
        wtPath: assignment.worktreePath,
        branchName: assignment.branchName,
        promptPath: assignment.promptPath,
        agentConfig: assignment.agentConfig as AgentConfig,
        attempt: assignment.attempt,
        agentLabel: slot.taskTitle ?? task.id,
        role: "coder",
        onDone: (code) =>
          this.handleCodingDone(projectId, repoPath, task, assignment.branchName, code),
        onStateChange: this.onAgentStateChange(projectId),
      },
      slot.agent,
      slot.timers,
      {
        initialSuspendReason,
        recoveredLastOutputTimeMs: heartbeat.lastOutputTimestamp,
      }
    );
    return true;
  }

  private async resumeRecoveredReviewPhase(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    assignment: GuppAssignment,
    options: { pidAlive: boolean; suspendReason?: AgentSuspendReason }
  ): Promise<boolean> {
    const state = this.getState(projectId);
    const settings = await this.projectService.getSettings(projectId);
    const reviewMode = settings.reviewMode ?? DEFAULT_REVIEW_MODE;
    if (reviewMode === "never") return false;

    try {
      await fs.access(assignment.worktreePath);
    } catch {
      return false;
    }

    const reviewAngles = [
      ...new Set((settings.reviewAngles ?? []).filter(Boolean)),
    ] as ReviewAngle[];
    if (options.pidAlive && reviewAngles.length > 0) {
      log.warn("Recovery: cannot safely reattach multi-angle review with live reviewer PID", {
        taskId: task.id,
        reviewAngles,
      });
      return false;
    }

    const heartbeat = options.pidAlive
      ? await heartbeatService.readHeartbeat(assignment.worktreePath, task.id)
      : null;
    const handle = heartbeat?.processGroupLeaderPid
      ? createProcessGroupHandle(heartbeat.processGroupLeaderPid)
      : null;
    if (options.pidAlive && !handle) return false;

    const existingSlot = state.slots.get(task.id);
    if (existingSlot) {
      if (options.suspendReason) {
        await this.lifecycleManager.markSuspended(
          {
            projectId,
            taskId: task.id,
            repoPath,
            phase: "review",
            wtPath: assignment.worktreePath,
            branchName: assignment.branchName,
            promptPath: assignment.promptPath,
            agentConfig: assignment.agentConfig as AgentConfig,
            attempt: assignment.attempt,
            agentLabel: existingSlot.taskTitle ?? task.id,
            role: "reviewer",
            onDone: (code) =>
              this.handleReviewDone(projectId, repoPath, task, assignment.branchName, code),
            onStateChange: this.onAgentStateChange(projectId),
          },
          existingSlot.agent,
          options.suspendReason
        );
      }
      return true;
    }

    const baseBranch = await resolveBaseBranch(repoPath, settings.worktreeBaseBranch);
    let changedFiles: string[] = [];
    try {
      changedFiles = await this.branchManager.getChangedFiles(
        repoPath,
        assignment.branchName,
        baseBranch
      );
    } catch {
      // Fall back to the configured/full suite
    }

    const reviewerList = AGENT_NAMES_BY_ROLE.reviewer ?? [];
    const reviewerAssignee =
      typeof task.assignee === "string" && reviewerList.includes(task.assignee)
        ? task.assignee
        : getAgentNameForRole("reviewer", state.nextReviewerIndex);
    const reviewerIdx = reviewerList.indexOf(reviewerAssignee);
    if (reviewerIdx >= 0)
      state.nextReviewerIndex = Math.max(state.nextReviewerIndex, reviewerIdx + 1);
    else state.nextReviewerIndex += 1;

    const slot = this.createSlot(
      task.id,
      task.title ?? null,
      assignment.branchName,
      assignment.attempt,
      reviewerAssignee
    );
    slot.worktreePath = assignment.worktreePath;
    slot.agent.startedAt = assignment.createdAt;
    state.slots.set(task.id, slot);
    this.transition(projectId, {
      to: "enter_review",
      taskId: task.id,
      queueDepth: state.status.queueDepth,
      assignee: reviewerAssignee,
    });
    await this.persistCounters(projectId, repoPath);

    await this.startReviewCoordinatorAndTests(
      projectId,
      repoPath,
      task,
      assignment.branchName,
      settings,
      changedFiles
    );

    eventLogService
      .append(repoPath, {
        timestamp: new Date().toISOString(),
        projectId,
        taskId: task.id,
        event: "recovery.review_resumed",
        data: {
          attempt: assignment.attempt,
          mode: handle ? "reattach" : "respawn",
          reviewAngles,
        },
      })
      .catch(() => {});

    await this.clearRateLimitNotifications(projectId);

    if (handle) {
      broadcastToProject(projectId, {
        type: "agent.started",
        taskId: task.id,
        phase: "review",
        branchName: assignment.branchName,
        startedAt: assignment.createdAt,
      });
      const initialSuspendReason =
        options.suspendReason ??
        this.shouldStartRecoveredAgentSuspended(heartbeat?.lastOutputTimestamp);
      await this.lifecycleManager.resumeMonitoring(
        handle,
        {
          projectId,
          taskId: task.id,
          repoPath,
          phase: "review",
          wtPath: assignment.worktreePath,
          branchName: assignment.branchName,
          promptPath: assignment.promptPath,
          agentConfig: assignment.agentConfig as AgentConfig,
          attempt: assignment.attempt,
          agentLabel: slot.taskTitle ?? task.id,
          role: "reviewer",
          onDone: (code) =>
            this.handleReviewDone(projectId, repoPath, task, assignment.branchName, code),
          onStateChange: this.onAgentStateChange(projectId),
        },
        slot.agent,
        slot.timers,
        {
          initialSuspendReason,
          recoveredLastOutputTimeMs: heartbeat?.lastOutputTimestamp,
        }
      );
      return true;
    }

    await this.executeReviewPhase(projectId, repoPath, task, assignment.branchName);
    return true;
  }

  /** Build a RecoveryHost for the unified RecoveryService */
  private buildRecoveryHost(): RecoveryHost {
    return {
      getSlottedTaskIds: (projectId: string) => this.getSlottedTaskIds(projectId),
      getActiveAgentIds: (projectId: string) =>
        activeAgentsService.list(projectId).map((a) => a.id),
      reattachSlot: async (
        projectId: string,
        repoPath: string,
        task: StoredTask,
        assignment: GuppAssignment
      ): Promise<boolean> =>
        this.reattachRecoveredCodingTask(projectId, repoPath, task, assignment),
      resumeReviewPhase: async (
        projectId: string,
        repoPath: string,
        task: StoredTask,
        assignment: GuppAssignment,
        options: { pidAlive: boolean }
      ): Promise<boolean> =>
        this.resumeRecoveredReviewPhase(projectId, repoPath, task, assignment, options),
      handleRecoverableHeartbeatGap: async (
        projectId: string,
        repoPath: string,
        task: StoredTask,
        assignment: GuppAssignment
      ): Promise<boolean> => {
        if (assignment.phase === "review") {
          return this.resumeRecoveredReviewPhase(projectId, repoPath, task, assignment, {
            pidAlive: true,
            suspendReason: "heartbeat_gap",
          });
        }
        return this.reattachRecoveredCodingTask(projectId, repoPath, task, assignment, {
          suspendReason: "heartbeat_gap",
        });
      },
      removeStaleSlot: async (
        projectId: string,
        taskId: string,
        repoPath: string
      ): Promise<void> => {
        const state = this.getState(projectId);
        const slot = state.slots.get(taskId);
        if (!slot) return;

        if (slot.agent.activeProcess) {
          try {
            slot.agent.activeProcess.kill();
          } catch {
            // Process may already be dead
          }
          slot.agent.activeProcess = null;
        }
        const wtPath = slot.worktreePath ?? repoPath;
        await heartbeatService.deleteHeartbeat(wtPath, taskId);
        if (slot.worktreePath && slot.worktreePath !== repoPath) {
          try {
            await this.branchManager.removeTaskWorktree(repoPath, taskId, slot.worktreePath);
          } catch {
            // Best effort; worktree may already be gone
          }
        }
        await this.deleteAssignmentAt(repoPath, taskId, slot.worktreePath ?? undefined);
        this.removeSlot(state, taskId);
      },
    };
  }

  getRecoveryHost(): RecoveryHost {
    return this.buildRecoveryHost();
  }

  async ensureRunning(projectId: string): Promise<OrchestratorStatus> {
    await this.projectService.getProject(projectId);
    const state = this.getState(projectId);
    const repoPath = await this.projectService.getRepoPath(projectId);
    this.repoPathCache.set(projectId, repoPath);

    // Restore counters from DB before recovery so recovery increment is not overwritten
    const counters = await this.loadCounters(repoPath);
    if (counters) {
      state.status.totalDone = counters.totalDone;
      state.status.totalFailed = counters.totalFailed;
    }

    // Unified recovery: GUPP + orphan + heartbeat + git locks + slot reconciliation
    try {
      const recoveryResult = await recoveryService.runFullRecovery(
        projectId,
        repoPath,
        this.buildRecoveryHost(),
        { includeGupp: true }
      );
      if (recoveryResult.reattached.length > 0) {
        log.info("Re-attached to running agent(s) after restart", {
          projectId,
          taskIds: recoveryResult.reattached,
        });
      }
      if (recoveryResult.requeued.length > 0) {
        log.warn(`Recovered ${recoveryResult.requeued.length} orphaned/stale task(s) on startup`);
        state.status.totalFailed += recoveryResult.requeued.length;
        await this.persistCounters(projectId, repoPath);
      }
    } catch (err) {
      log.error("Recovery failed", { err });
    }

    // Cache effective maxSlots for synchronous nudge() (branches mode forces 1)
    try {
      const settings = await this.projectService.getSettings(projectId);
      const maxSlots =
        settings.gitWorkingMode === "branches" ? 1 : (settings.maxConcurrentCoders ?? 1);
      this.maxSlotsCache.set(projectId, maxSlots);
    } catch {
      this.maxSlotsCache.set(projectId, 1);
    }

    // Start loop kicker timer if not already running (nudges when idle; distinct from WatchdogService)
    if (!state.globalTimers.has("loopKicker")) {
      state.globalTimers.setInterval(
        "loopKicker",
        () => {
          this.nudge(projectId);
        },
        LOOP_KICKER_INTERVAL_MS
      );
      log.info("Loop kicker started (60s interval) for project", { projectId });
    }

    if (!state.loopActive) {
      this.nudge(projectId);
    }

    return state.status;
  }

  nudge(projectId: string): void {
    const state = this.getState(projectId);

    const maxSlots = this.maxSlotsCache.get(projectId) ?? 1;
    const slotsFull = state.slots.size >= maxSlots;

    if (state.loopActive || state.globalTimers.has("loop")) {
      return;
    }

    if (slotsFull) {
      // Analyst doesn't use a slot; allow loop to run when there's pending feedback
      this.feedbackService
        .getNextPendingFeedbackId(projectId)
        .then((nextId) => {
          const s = this.getState(projectId);
          if (nextId && !s.loopActive && !s.globalTimers.has("loop")) {
            log.info("Nudge (pending feedback), starting loop for project", { projectId });
            this.runLoop(projectId);
          }
        })
        .catch(() => {});
      return;
    }

    log.info("Nudge received, starting loop for project", { projectId });
    this.runLoop(projectId);
  }

  async getStatus(
    projectId: string,
    options?: { validTaskIds?: Set<string> }
  ): Promise<OrchestratorStatus> {
    await this.projectService.getProject(projectId);
    await this.reconcileStaleSlots(projectId, options?.validTaskIds);
    const state = this.getState(projectId);
    const pendingIds = await this.feedbackService.listPendingFeedbackIds(projectId);
    const pendingFeedbackCategorizations: PendingFeedbackCategorization[] = pendingIds.map(
      (feedbackId) => ({ feedbackId })
    );
    return {
      ...state.status,
      activeTasks: this.buildActiveTasks(state),
      worktreePath:
        state.slots.size === 1 ? ([...state.slots.values()][0]?.worktreePath ?? null) : null,
      pendingFeedbackCategorizations,
    };
  }

  /**
   * Return all task IDs that currently have an active orchestrator slot.
   * Used by the watchdog to avoid treating in-flight tasks as orphans during
   * the gap between coding agent exit and review agent spawn.
   */
  getSlottedTaskIds(projectId: string): string[] {
    const state = this.state.get(projectId);
    if (!state) return [];
    return [...state.slots.keys()];
  }

  /** Invalidate maxSlots cache for a project (e.g. after settings change). Next runLoop will refresh. */
  invalidateMaxSlotsCache(projectId: string): void {
    this.maxSlotsCache.delete(projectId);
  }

  /**
   * Refresh maxSlots from settings and nudge. Use when settings are saved so nudge sees the new
   * maxConcurrentCoders immediately (e.g. increasing max agents spawns new agents right away).
   */
  async refreshMaxSlotsAndNudge(projectId: string): Promise<void> {
    try {
      const settings = await this.projectService.getSettings(projectId);
      const maxSlots =
        settings.gitWorkingMode === "branches" ? 1 : (settings.maxConcurrentCoders ?? 1);
      this.maxSlotsCache.set(projectId, maxSlots);
    } catch {
      this.maxSlotsCache.set(projectId, 1);
    }
    this.nudge(projectId);
  }

  async getLiveOutput(projectId: string, taskId: string): Promise<string> {
    await this.projectService.getProject(projectId);
    const state = this.getState(projectId);
    const slot = state.slots.get(taskId);
    if (!slot) {
      return "";
    }
    if (slot.agent.outputLog.length > 0) {
      return slot.agent.outputLog.join("");
    }
    // Slot exists but in-memory buffer empty: read from output log file if present
    const repoPath = await this.projectService.getRepoPath(projectId);
    const basePath = slot.worktreePath ?? repoPath;
    const outputLogPath = path.join(
      basePath,
      OPENSPRINT_PATHS.active,
      taskId,
      OPENSPRINT_PATHS.agentOutputLog
    );
    try {
      return await fs.readFile(outputLogPath, "utf-8");
    } catch {
      return "";
    }
  }

  async getActiveAgents(projectId: string): Promise<ActiveAgent[]> {
    await this.projectService.getProject(projectId);
    await this.reconcileStaleSlots(projectId);
    const state = this.getState(projectId);

    const agents: ActiveAgent[] = [];

    // Execute agents — derived from slots (single source of truth)
    for (const slot of state.slots.values()) {
      if (slot.phase === "review" && slot.reviewAgents && slot.reviewAgents.size > 0) {
        for (const reviewAgent of slot.reviewAgents.values()) {
          const optionLabel =
            REVIEW_ANGLE_OPTIONS.find((o) => o.value === reviewAgent.angle)?.label ??
            reviewAgent.angle;
          const angleLabel = REVIEW_ANGLE_ACTIVE_LABELS[reviewAgent.angle] ?? optionLabel;
          agents.push({
            id: buildReviewAgentId(slot.taskId, reviewAgent.angle),
            taskId: slot.taskId,
            phase: "review",
            role: "reviewer",
            label: slot.taskTitle ?? slot.taskId,
            startedAt: reviewAgent.agent.startedAt || new Date().toISOString(),
            branchName: slot.branchName,
            name: angleLabel,
            state: reviewAgent.agent.lifecycleState,
            ...(reviewAgent.agent.lastOutputAtIso
              ? { lastOutputAt: reviewAgent.agent.lastOutputAtIso }
              : {}),
            ...(reviewAgent.agent.suspendedAtIso
              ? { suspendedAt: reviewAgent.agent.suspendedAtIso }
              : {}),
            ...(reviewAgent.agent.suspendReason
              ? { suspendReason: reviewAgent.agent.suspendReason }
              : {}),
          });
        }
        continue;
      }
      agents.push({
        id: slot.taskId,
        taskId: slot.taskId,
        phase: slot.phase,
        role: slot.phase === "review" ? "reviewer" : "coder",
        label: slot.taskTitle ?? slot.taskId,
        startedAt: slot.agent.startedAt || new Date().toISOString(),
        branchName: slot.branchName,
        ...(slot.assignee != null && slot.assignee.trim() !== "" && { name: slot.assignee.trim() }),
        state: slot.agent.lifecycleState,
        ...(slot.agent.lastOutputAtIso ? { lastOutputAt: slot.agent.lastOutputAtIso } : {}),
        ...(slot.agent.suspendedAtIso ? { suspendedAt: slot.agent.suspendedAtIso } : {}),
        ...(slot.agent.suspendReason ? { suspendReason: slot.agent.suspendReason } : {}),
      });
    }

    // Planning agents (Dreamer, Planner, etc.) — tracked by agentService via activeAgentsService
    const slottedIds = new Set(agents.map((a) => a.id));
    for (const a of activeAgentsService.list(projectId)) {
      if (!slottedIds.has(a.id)) agents.push(a);
    }

    return agents;
  }

  // ─── Main Orchestrator Loop ───

  private async dispatchTask(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    slotQueueDepth: number
  ): Promise<void> {
    const state = this.getState(projectId);
    log.info("Picking task", { projectId, taskId: task.id, title: task.title });

    const assignee = getAgentName(state.nextCoderIndex);
    state.nextCoderIndex += 1;

    await this.taskStore.update(projectId, task.id, {
      status: "in_progress",
      assignee,
    });
    const cumulativeAttempts = this.taskStore.getCumulativeAttemptsFromIssue(task);
    const branchName = `opensprint/${task.id}`;

    const slot = this.createSlot(
      task.id,
      task.title ?? null,
      branchName,
      cumulativeAttempts + 1,
      assignee
    );
    slot.fileScope = await this.fileScopeAnalyzer.predict(
      projectId,
      repoPath,
      task,
      this.taskStore
    );

    this.transition(projectId, {
      to: "start_task",
      taskId: task.id,
      taskTitle: task.title ?? null,
      branchName,
      attempt: cumulativeAttempts + 1,
      queueDepth: slotQueueDepth,
      slot,
    });

    await this.persistCounters(projectId, repoPath);
    const settings = await this.projectService.getSettings(projectId);
    const baseBranch = await resolveBaseBranch(repoPath, settings.worktreeBaseBranch);
    await this.branchManager.ensureOnMain(repoPath, baseBranch);
    await this.executeCodingPhase(projectId, repoPath, task, slot, undefined);
  }

  private async runLoop(projectId: string): Promise<void> {
    const state = this.getState(projectId);

    const myRunId = (state.loopRunId ?? 0) + 1;
    state.loopRunId = myRunId;
    state.loopActive = true;
    state.globalTimers.clear("loop");

    // If runLoop blocks in an await (e.g. context assembly, task store, network), the 60s loop kicker
    // keeps calling nudge() but nudge returns early because loopActive is true. This guard forces
    // recovery after LOOP_STUCK_GUARD_MS so a fresh runLoop can start and agents can make progress.
    state.globalTimers.setTimeout(
      "loopStuckGuard",
      () => {
        if (state.loopRunId !== myRunId) return;
        log.warn("Orchestrator loop stuck (timeout), recovering so work can resume", {
          projectId,
          stuckRunId: myRunId,
        });
        state.loopRunId = myRunId + 1;
        state.loopActive = false;
        this.nudge(projectId);
      },
      LOOP_STUCK_GUARD_MS
    );

    try {
      // Gastown-style mailbox: process one queued feedback (Analyst) before coding work
      // Atomic claim prevents duplicate processing when multiple loop runs race
      const nextFeedbackId = await this.feedbackService.claimNextPendingFeedbackId(projectId);
      if (nextFeedbackId) {
        log.info("Processing queued feedback with Analyst", {
          projectId,
          feedbackId: nextFeedbackId,
        });
        try {
          await this.feedbackService.processFeedbackWithAnalyst(projectId, nextFeedbackId);
          // Broadcast execute.status so UI updates pendingFeedbackCategorizations immediately
          // (feedback.updated is emitted by FeedbackService; this syncs the "Categorizing" state)
          const status = await this.getStatus(projectId);
          broadcastToProject(projectId, {
            type: "execute.status",
            activeTasks: status.activeTasks,
            queueDepth: status.queueDepth,
            ...(status.pendingFeedbackCategorizations && {
              pendingFeedbackCategorizations: status.pendingFeedbackCategorizations,
            }),
          });
        } catch (err) {
          log.error("Analyst failed for queued feedback; leaving in inbox for retry", {
            projectId,
            feedbackId: nextFeedbackId,
            err,
          });
        }
        if (state.loopRunId === myRunId) state.loopActive = false;
        this.nudge(projectId);
        return;
      }

      const repoPath = await this.projectService.getRepoPath(projectId);
      const settings = await this.projectService.getSettings(projectId);
      const maxSlots =
        settings.gitWorkingMode === "branches" ? 1 : (settings.maxConcurrentCoders ?? 1);
      this.maxSlotsCache.set(projectId, maxSlots);

      const { tasks: readyTasksRaw, allIssues } =
        await this.taskStore.readyWithStatusMap(projectId);

      let readyTasks = readyTasksRaw.filter((t) => (t.issue_type ?? t.type) !== "epic");
      readyTasks = readyTasks.filter((t) => (t.issue_type ?? t.type) !== "chore");
      readyTasks = readyTasks.filter((t) => (t.status as string) !== "blocked");
      // Exclude tasks that already have an active slot
      readyTasks = readyTasks.filter((t) => !state.slots.has(t.id));

      state.status.queueDepth = readyTasks.length;

      const slotsAvailable = maxSlots - state.slots.size;
      if (readyTasks.length === 0 || slotsAvailable <= 0) {
        log.info("No ready tasks or no slots available, going idle", {
          projectId,
          readyTasks: readyTasks.length,
          slotsAvailable,
        });
        if (state.loopRunId === myRunId) state.loopActive = false;
        broadcastToProject(projectId, {
          type: "execute.status",
          activeTasks: this.buildActiveTasks(state),
          queueDepth: state.status.queueDepth,
        });
        return;
      }

      const selected = await this.taskScheduler.selectTasks(
        projectId,
        repoPath,
        readyTasks,
        state.slots,
        maxSlots,
        {
          allIssues,
          unknownScopeStrategy: settings.unknownScopeStrategy ?? "conservative",
        }
      );

      // Re-check exhausted providers: if getNextKey returns a key now, clear exhausted
      for (const provider of ["ANTHROPIC_API_KEY", "CURSOR_API_KEY", "OPENAI_API_KEY"] as const) {
        if (isExhausted(projectId, provider)) {
          const resolved = await getNextKey(projectId, provider);
          if (resolved?.key?.trim()) {
            clearExhausted(projectId, provider);
            log.info("API keys available again, cleared exhausted", { projectId, provider });
          }
        }
      }

      // Filter out tasks whose required provider is exhausted
      const dispatchableTasks: typeof selected = [];
      for (const st of selected) {
        const complexity = await getComplexityForAgent(
          projectId,
          repoPath,
          st.task,
          this.taskStore
        );
        const agentConfig = getAgentForComplexity(settings, complexity);
        const provider = getProviderForAgentType(agentConfig.type);
        if (provider && isExhausted(projectId, provider)) {
          log.info("Skipping task: provider exhausted", {
            projectId,
            taskId: st.task.id,
            provider,
          });
          continue;
        }
        dispatchableTasks.push(st);
      }

      const dispatchBatch = dispatchableTasks.slice(0, MAX_NEW_TASKS_PER_LOOP);
      if (dispatchableTasks.length > dispatchBatch.length) {
        log.info("Dispatch capped for stability; deferring additional ready tasks", {
          projectId,
          selectedTasks: dispatchableTasks.length,
          dispatchingNow: dispatchBatch.length,
        });
      }

      if (dispatchableTasks.length === 0) {
        log.info("No dispatchable tasks after conflict-aware scheduling or provider exhaustion", {
          projectId,
          readyTasks: readyTasks.length,
          activeSlots: state.slots.size,
        });
        if (state.loopRunId === myRunId) state.loopActive = false;
        broadcastToProject(projectId, {
          type: "execute.status",
          activeTasks: this.buildActiveTasks(state),
          queueDepth: state.status.queueDepth,
        });
        return;
      }

      for (let i = 0; i < dispatchBatch.length; i++) {
        const selectedTask = dispatchBatch[i]!;
        try {
          await this.dispatchTask(
            projectId,
            repoPath,
            selectedTask.task,
            Math.max(0, selected.length - (i + 1))
          );
        } catch (error) {
          if (error instanceof WorktreeBranchInUseError) {
            const failedTask = selectedTask.task;
            log.warn("Worktree branch in use by active agent, failing task and freeing slot", {
              projectId,
              taskId: failedTask.id,
              otherPath: error.otherPath,
              otherTaskId: error.otherTaskId,
            });
            this.removeSlot(state, failedTask.id);
            try {
              await this.taskStore.update(projectId, failedTask.id, {
                status: "open",
                assignee: "",
              });
            } catch (revertErr) {
              log.warn("Failed to revert task status", {
                taskId: failedTask.id,
                err: revertErr,
              });
            }
            broadcastToProject(projectId, {
              type: "agent.completed",
              taskId: failedTask.id,
              status: "failed",
              testResults: null,
              reason: error.message.slice(0, 500),
            });
            broadcastToProject(projectId, {
              type: "execute.status",
              activeTasks: this.buildActiveTasks(state),
              queueDepth: state.status.queueDepth,
            });
            continue;
          }
          throw error;
        }
      }

      // Mark loop as idle so nudge can fire again for additional slots
      if (state.loopRunId === myRunId) state.loopActive = false;
    } catch (error) {
      log.error(`Orchestrator loop error for project ${projectId}`, { error });
      if (state.loopRunId === myRunId) {
        state.loopActive = false;
        state.globalTimers.setTimeout("loop", () => this.runLoop(projectId), 10000);
      }
    } finally {
      state.globalTimers.clear("loopStuckGuard");
    }
  }

  private async executeCodingPhase(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    slot: AgentSlot,
    retryContext?: RetryContext
  ): Promise<void> {
    return this.phaseExecutor.executeCodingPhase(projectId, repoPath, task, slot, retryContext);
  }

  private async handleApiKeysExhausted(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    provider: import("@opensprint/shared").ApiKeyProvider
  ): Promise<void> {
    const state = this.getState(projectId);
    const slot = state.slots.get(task.id);
    if (!slot) return;

    const providerDisplay =
      provider === "ANTHROPIC_API_KEY"
        ? "Anthropic"
        : provider === "CURSOR_API_KEY"
          ? "Cursor"
          : "OpenAI";
    const message = `Your API key(s) for ${providerDisplay} have hit their limit. Please increase your budget or add another key.`;

    // Avoid duplicate notifications for same project+provider
    const existing = await notificationService.listByProject(projectId);
    const alreadyNotified = existing.some(
      (n) => n.kind === "api_blocked" && n.sourceId === `api-keys-${provider}`
    );
    let notification: Awaited<ReturnType<typeof notificationService.createApiBlocked>> | null =
      null;
    if (!alreadyNotified) {
      notification = await notificationService.createApiBlocked({
        projectId,
        source: "execute",
        sourceId: `api-keys-${provider}`,
        message,
        errorCode: "rate_limit",
      });
    } else {
      log.info("Skipping duplicate API-blocked notification", { projectId, provider });
    }
    if (notification) {
      broadcastToProject(projectId, {
        type: "notification.added",
        notification: {
          id: notification.id,
          projectId: notification.projectId,
          source: notification.source,
          sourceId: notification.sourceId,
          questions: notification.questions,
          status: notification.status,
          createdAt: notification.createdAt,
          resolvedAt: notification.resolvedAt,
          kind: "api_blocked",
          errorCode: notification.errorCode,
        },
      });
    }

    await this.taskStore.update(projectId, task.id, { status: "open", assignee: "" });
    const wtPath = slot.worktreePath ?? repoPath;
    await heartbeatService.deleteHeartbeat(wtPath, task.id).catch(() => {});
    if (slot.worktreePath && slot.worktreePath !== repoPath) {
      try {
        await this.branchManager.removeTaskWorktree(repoPath, task.id, slot.worktreePath);
      } catch {
        // Best effort
      }
    }
    await this.deleteAssignmentAt(repoPath, task.id, slot.worktreePath ?? undefined);
    this.removeSlot(state, task.id);
    broadcastToProject(projectId, {
      type: "execute.status",
      activeTasks: this.buildActiveTasks(state),
      queueDepth: state.status.queueDepth,
    });
    await this.persistCounters(projectId, repoPath);
  }

  private async handleCodingDone(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    exitCode: number | null
  ): Promise<void> {
    const state = this.getState(projectId);
    const slot = state.slots.get(task.id);
    if (!slot) {
      log.warn("handleCodingDone: no slot found for task", { taskId: task.id });
      return;
    }
    if (
      !(await this.cleanupSlotIfProjectGone(
        projectId,
        repoPath,
        task.id,
        state,
        slot,
        "handleCodingDone"
      ))
    ) {
      return;
    }
    const wtPath = slot.worktreePath ?? repoPath;

    const readResultWithTimeout = async (): Promise<CodingAgentResult | null> => {
      const timeoutMs = 15_000;
      return (await Promise.race([
        this.sessionManager.readResult(wtPath, task.id),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("readResult timeout")), timeoutMs)
        ),
      ]).catch((err) => {
        log.warn("readResult failed or timed out", { taskId: task.id, err });
        return null;
      })) as CodingAgentResult | null;
    };

    const result = await readResultWithTimeout();

    if (result && result.status) {
      normalizeCodingStatus(result);
    }

    if (!result) {
      const failureType: FailureType = slot.agent.killedDueToTimeout
        ? "timeout"
        : exitCode === 143 || exitCode === 137
          ? "agent_crash"
          : "no_result";
      slot.agent.killedDueToTimeout = false;
      await this.failureHandler.handleTaskFailure(
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
      const settings = await this.projectService.getSettings(projectId);
      const baseBranch = await resolveBaseBranch(repoPath, settings.worktreeBaseBranch);
      slot.phaseResult.codingDiff = await this.branchManager.captureBranchDiff(
        repoPath,
        branchName,
        baseBranch
      );
      slot.phaseResult.codingSummary = result.summary ?? "";

      const testCommand = resolveTestCommand(settings) || undefined;
      let changedFiles: string[] = [];
      try {
        changedFiles = await this.branchManager.getChangedFiles(
          repoPath,
          branchName,
          baseBranch
        );
      } catch {
        // Fall back to full suite
      }

      const reviewMode = settings.reviewMode ?? DEFAULT_REVIEW_MODE;

      if (reviewMode === "never") {
        const scopedResult = await this.testRunner.runScopedTests(
          wtPath,
          changedFiles,
          testCommand
        );
        slot.phaseResult.testOutput = scopedResult.rawOutput;
        if (scopedResult.failed > 0) {
          await this.failureHandler.handleTaskFailure(
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
        slot.phaseResult.testResults = scopedResult;
        await this.branchManager.commitWip(wtPath, task.id);
        await this.clearRateLimitNotifications(projectId);
        await this.mergeCoordinator.performMergeAndDone(projectId, repoPath, task, branchName);
      } else {
        // Review + tests in parallel, joined via TaskPhaseCoordinator
        const reviewerAssignee = getAgentNameForRole("reviewer", state.nextReviewerIndex);
        state.nextReviewerIndex += 1;
        this.transition(projectId, {
          to: "enter_review",
          taskId: task.id,
          queueDepth: state.status.queueDepth,
          assignee: reviewerAssignee,
        });
        await this.persistCounters(projectId, repoPath);
        await this.startReviewCoordinatorAndTests(
          projectId,
          repoPath,
          task,
          branchName,
          settings,
          changedFiles
        );

        // Fire-and-forget: review agent spawned, reports to coordinator via handleReviewDone
        await this.clearRateLimitNotifications(projectId);
        await this.executeReviewPhase(projectId, repoPath, task, branchName);
      }
    } else {
      // Agent question protocol: when Coder returns failed + open_questions, create notification and block task
      const rawOpenQuestions = result.open_questions ?? result.openQuestions;
      const openQuestions: Array<{ id: string; text: string }> = Array.isArray(rawOpenQuestions)
        ? rawOpenQuestions
            .filter(
              (q: unknown) =>
                q && typeof q === "object" && typeof (q as { text?: unknown }).text === "string"
            )
            .map((q: unknown) => {
              const qq = q as { id?: string; text: string };
              return {
                id:
                  typeof qq.id === "string"
                    ? qq.id
                    : `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                text: String(qq.text).trim(),
              };
            })
        : [];

      if (openQuestions.length > 0) {
        const notification = await notificationService.create({
          projectId,
          source: "execute",
          sourceId: task.id,
          questions: openQuestions.map((q) => ({ id: q.id, text: q.text })),
        });
        broadcastToProject(projectId, {
          type: "notification.added",
          notification: {
            id: notification.id,
            projectId: notification.projectId,
            source: notification.source,
            sourceId: notification.sourceId,
            questions: notification.questions,
            status: notification.status,
            createdAt: notification.createdAt,
            resolvedAt: notification.resolvedAt,
            kind: "open_question",
          },
        });
        await this.taskStore.update(projectId, task.id, {
          assignee: "",
          status: "blocked",
          block_reason: OPEN_QUESTION_BLOCK_REASON,
        });
        const wtPath = slot.worktreePath ?? repoPath;
        await heartbeatService.deleteHeartbeat(wtPath, task.id).catch(() => {});
        if (slot.worktreePath && slot.worktreePath !== repoPath) {
          try {
            await this.branchManager.removeTaskWorktree(repoPath, task.id, slot.worktreePath);
          } catch {
            // Best effort
          }
        }
        await this.deleteAssignment(repoPath, task.id);
        this.removeSlot(state, task.id);
        broadcastToProject(projectId, {
          type: "execute.status",
          activeTasks: this.buildActiveTasks(state),
          queueDepth: state.status.queueDepth,
        });
        await this.persistCounters(projectId, repoPath);
        return;
      }

      const reason = result.summary || `Agent exited with code ${exitCode}`;
      await this.failureHandler.handleTaskFailure(
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

  /**
   * Clear rate limit notifications when system is demonstrably working
   * (review agent starting or coding success with reviewMode=never).
   */
  private async clearRateLimitNotifications(projectId: string): Promise<void> {
    try {
      const resolved = await notificationService.resolveRateLimitNotifications(projectId);
      for (const n of resolved) {
        broadcastToProject(projectId, {
          type: "notification.resolved",
          notificationId: n.id,
          projectId,
          source: n.source,
          sourceId: n.sourceId,
        });
      }
    } catch (err) {
      log.warn("Failed to clear rate limit notifications", { projectId, err });
    }
  }

  private async startReviewCoordinatorAndTests(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    settings: import("@opensprint/shared").ProjectSettings,
    changedFiles: string[]
  ): Promise<void> {
    const slot = this.getState(projectId).slots.get(task.id);
    if (!slot) return;
    const wtPath = slot.worktreePath ?? repoPath;
    const testCommand = resolveTestCommand(settings) || undefined;
    const angles = (settings.reviewAngles ?? []).filter(Boolean);
    await this.writeReviewTestStatus(
      task.id,
      repoPath,
      wtPath,
      buildOrchestratorTestStatusContent({
        status: "pending",
        testCommand,
      })
    );
    const coordinator = new TaskPhaseCoordinator(
      task.id,
      (testOutcome, reviewOutcome) =>
        this.resolveTestAndReview(
          projectId,
          repoPath,
          task,
          branchName,
          testOutcome,
          reviewOutcome
        ),
      {
        reviewAngles: settings.reviewAngles,
        ...(angles.length > 1 && {
          synthesizeReviewResults: async (outcomes) => {
            const angleInputs = [...outcomes.entries()]
              .filter(([, o]) => o.result && (o.status === "approved" || o.status === "rejected"))
              .map(([angle, o]) => ({ angle, result: o.result! }));
            if (angleInputs.length === 0) {
              const first = outcomes.values().next().value;
              return first ?? { status: "no_result" as const, result: null, exitCode: null };
            }
            const synthesized = await reviewSynthesizerService.synthesize(
              projectId,
              repoPath,
              task,
              angleInputs,
              this.taskStore
            );
            return {
              status: synthesized.status as "approved" | "rejected",
              result: synthesized,
              exitCode: 0,
            };
          },
        }),
      }
    );
    slot.phaseCoordinator = coordinator;

    this.testRunner
      .runScopedTests(wtPath, changedFiles, testCommand)
      .then(async (scopedResult) => {
        const sl = this.getState(projectId).slots.get(task.id);
        if (!sl) {
          await this.writeReviewTestStatus(
            task.id,
            repoPath,
            wtPath,
            buildOrchestratorTestStatusContent({
              status: "error",
              testCommand,
              errorMessage: "Slot removed during tests",
            })
          );
          coordinator.setTestOutcome({
            status: "error",
            errorMessage: "Slot removed during tests",
          });
          return;
        }
        sl.phaseResult.testOutput = scopedResult.rawOutput;
        if (scopedResult.failed > 0) {
          const validationCommand = scopedResult.executedCommand ?? testCommand;
          await this.writeReviewTestStatus(
            task.id,
            repoPath,
            wtPath,
            buildOrchestratorTestStatusContent({
              status: "failed",
              testCommand: validationCommand,
              results: scopedResult,
              rawOutput: scopedResult.rawOutput,
            })
          );
          coordinator.setTestOutcome({
            status: "failed",
            results: scopedResult,
            rawOutput: scopedResult.rawOutput,
          });
        } else {
          sl.phaseResult.testResults = scopedResult;
          await this.branchManager.commitWip(wtPath, task.id);
          const validationCommand = scopedResult.executedCommand ?? testCommand;
          await this.writeReviewTestStatus(
            task.id,
            repoPath,
            wtPath,
            buildOrchestratorTestStatusContent({
              status: "passed",
              testCommand: validationCommand,
              results: scopedResult,
            })
          );
          coordinator.setTestOutcome({ status: "passed", results: scopedResult });
        }
      })
      .catch((err) => {
        log.error("Background tests failed for task", { taskId: task.id, err });
        void this.writeReviewTestStatus(
          task.id,
          repoPath,
          wtPath,
          buildOrchestratorTestStatusContent({
            status: "error",
            testCommand,
            errorMessage: String(err),
          })
        );
        coordinator.setTestOutcome({ status: "error", errorMessage: String(err) });
      });
  }

  private async writeReviewTestStatus(
    taskId: string,
    repoPath: string,
    wtPath: string,
    content: string
  ): Promise<void> {
    const bases = new Set([repoPath, wtPath]);
    await Promise.all(
      [...bases].map(async (basePath) => {
        const statusPath = getOrchestratorTestStatusFsPath(basePath, taskId);
        await fs.mkdir(path.dirname(statusPath), { recursive: true });
        await fs.writeFile(statusPath, content, "utf-8");
      })
    );
  }

  private async executeReviewPhase(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string
  ): Promise<void> {
    return this.phaseExecutor.executeReviewPhase(projectId, repoPath, task, branchName);
  }

  private async readReviewResult(
    wtPath: string,
    taskId: string,
    angle?: string
  ): Promise<ReviewAgentResult | null> {
    if (!angle) {
      return (await this.sessionManager.readResult(wtPath, taskId)) as ReviewAgentResult | null;
    }
    const angleResultPath = path.join(
      wtPath,
      OPENSPRINT_PATHS.active,
      taskId,
      "review-angles",
      angle,
      "result.json"
    );
    try {
      const raw = await fs.readFile(angleResultPath, "utf-8");
      return JSON.parse(raw) as ReviewAgentResult;
    } catch {
      return null;
    }
  }

  private async handleReviewDone(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    exitCode: number | null,
    angle?: ReviewAngle
  ): Promise<void> {
    const state = this.getState(projectId);
    const slot = state.slots.get(task.id);
    if (!slot) {
      log.warn("handleReviewDone: no slot found for task", { taskId: task.id });
      return;
    }
    if (
      !(await this.cleanupSlotIfProjectGone(
        projectId,
        repoPath,
        task.id,
        state,
        slot,
        "handleReviewDone"
      ))
    ) {
      return;
    }
    const wtPath = slot.worktreePath ?? repoPath;
    const result = await this.readReviewResult(wtPath, task.id, angle);

    if (result && result.status) {
      normalizeReviewStatus(result);
    }

    const reviewAgentState = angle ? slot.reviewAgents?.get(angle) : undefined;
    const killedDueToTimeout =
      reviewAgentState?.agent.killedDueToTimeout ?? slot.agent.killedDueToTimeout;

    // If coordinated with tests, report outcome and let the coordinator decide
    if (slot.phaseCoordinator) {
      const status: ReviewOutcome["status"] =
        result?.status === "approved"
          ? "approved"
          : result?.status === "rejected"
            ? "rejected"
            : "no_result";
      slot.phaseCoordinator.setReviewOutcome({ status, result, exitCode }, angle);
      if (angle) {
        slot.reviewAgents?.delete(angle as ReviewAngle);
        if (slot.reviewAgents && slot.reviewAgents.size === 0) {
          slot.reviewAgents = undefined;
        }
      }
      return;
    }

    // Non-coordinated path (reviewMode="never" doesn't reach here, but defensive)
    if (result && result.status === "approved") {
      await this.mergeCoordinator.performMergeAndDone(projectId, repoPath, task, branchName);
    } else if (result && result.status === "rejected") {
      await this.handleReviewRejection(projectId, repoPath, task, branchName, result);
    } else {
      const failureType: FailureType = killedDueToTimeout
        ? "timeout"
        : exitCode === 143 || exitCode === 137
          ? "agent_crash"
          : "no_result";
      slot.agent.killedDueToTimeout = false;
      if (reviewAgentState) reviewAgentState.agent.killedDueToTimeout = false;
      await this.failureHandler.handleTaskFailure(
        projectId,
        repoPath,
        task,
        branchName,
        angle
          ? `Review agent (${angle}) exited with code ${exitCode} without producing a valid result`
          : `Review agent exited with code ${exitCode} without producing a valid result`,
        null,
        failureType
      );
    }
  }

  /**
   * Single resolution point for coordinated test + review.
   * Called by TaskPhaseCoordinator when both outcomes are available.
   */
  private async resolveTestAndReview(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    testOutcome: TestOutcome,
    reviewOutcome: ReviewOutcome
  ): Promise<void> {
    const state = this.getState(projectId);
    const slot = state.slots.get(task.id);
    if (!slot) return;

    // Test failure takes priority over review outcome
    if (testOutcome.status === "failed") {
      const r = testOutcome.results!;
      await this.failureHandler.handleTaskFailure(
        projectId,
        repoPath,
        task,
        branchName,
        `Tests failed: ${r.failed} failed, ${r.passed} passed`,
        r,
        "test_failure"
      );
      return;
    }
    if (testOutcome.status === "error") {
      await this.failureHandler.handleTaskFailure(
        projectId,
        repoPath,
        task,
        branchName,
        testOutcome.errorMessage ?? "Test runner error",
        null,
        "test_failure"
      );
      return;
    }

    // Tests passed — decide based on review
    if (reviewOutcome.status === "approved") {
      await this.mergeCoordinator.performMergeAndDone(projectId, repoPath, task, branchName);
    } else if (reviewOutcome.status === "rejected") {
      await this.handleReviewRejection(
        projectId,
        repoPath,
        task,
        branchName,
        reviewOutcome.result!
      );
    } else {
      const failureType: FailureType = "no_result";
      await this.failureHandler.handleTaskFailure(
        projectId,
        repoPath,
        task,
        branchName,
        "One or more review agents exited without producing a valid result",
        null,
        failureType
      );
    }
  }

  private async handleReviewRejection(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    result: ReviewAgentResult
  ): Promise<void> {
    const state = this.getState(projectId);
    const slot = state.slots.get(task.id);
    if (!slot) return;
    const wtPath = slot.worktreePath ?? repoPath;

    const reason = `Review rejected: ${result.issues?.join("; ") || result.summary || "No details provided"}`;
    const reviewFeedback = formatReviewFeedback(result);
    const rejectionSummary = buildTaskLastExecutionSummary({
      attempt: slot.attempt,
      outcome: "rejected",
      phase: "review",
      failureType: "review_rejection",
      summary: compactExecutionText(reason, 500),
    });

    const settings = await this.projectService.getSettings(projectId);
    const baseBranch = await resolveBaseBranch(repoPath, settings.worktreeBaseBranch);
    let gitDiff = "";
    try {
      const branchDiff = await this.branchManager.captureBranchDiff(
        repoPath,
        branchName,
        baseBranch
      );
      const uncommittedDiff = await this.branchManager.captureUncommittedDiff(wtPath);
      gitDiff = [branchDiff, uncommittedDiff]
        .filter(Boolean)
        .join("\n\n--- Uncommitted changes ---\n\n");
    } catch {
      // Best-effort capture
    }
    const session = await this.sessionManager.createSession(repoPath, {
      taskId: task.id,
      attempt: slot.attempt,
      agentType: settings.simpleComplexityAgent.type,
      agentModel: settings.simpleComplexityAgent.model || "",
      gitBranch: branchName,
      status: "rejected",
      outputLog: slot.agent.outputLog.join(""),
      failureReason: result.summary || "Review rejected (no summary provided)",
      gitDiff: gitDiff || undefined,
      startedAt: slot.agent.startedAt,
    });
    await this.sessionManager.archiveSession(repoPath, task.id, slot.attempt, session, wtPath);
    await persistTaskLastExecutionSummary(this.taskStore, projectId, task.id, rejectionSummary);
    eventLogService
      .append(repoPath, {
        timestamp: new Date().toISOString(),
        projectId,
        taskId: task.id,
        event: "review.rejected",
        data: {
          attempt: slot.attempt,
          phase: "review",
          failureType: "review_rejection",
          model: settings.simpleComplexityAgent.model ?? null,
          summary: rejectionSummary.summary,
          reason,
          nextAction: "Retry coding with review feedback",
        },
      })
      .catch(() => {});

    await this.failureHandler.handleTaskFailure(
      projectId,
      repoPath,
      task,
      branchName,
      reason,
      null,
      "review_rejection",
      reviewFeedback
    );
  }

  private async buildReviewHistory(repoPath: string, taskId: string): Promise<string> {
    try {
      const sessions = await this.sessionManager.listSessions(repoPath, taskId);
      const rejections = sessions
        .filter((s) => s.status === "rejected")
        .sort((a, b) => a.attempt - b.attempt);

      if (rejections.length === 0) return "";

      const parts: string[] = [];
      for (const session of rejections) {
        parts.push(`### Attempt ${session.attempt} — Rejected`);
        if (session.failureReason) {
          parts.push(`\n**Reason:** ${session.failureReason}`);
        }
        parts.push("");
      }
      return parts.join("\n");
    } catch {
      return "";
    }
  }

  // ─── Helpers ───

  getCachedSummarizerContext(projectId: string, taskId: string): TaskContext | undefined {
    return this.getState(projectId).summarizerCache.get(taskId);
  }

  setCachedSummarizerContext(projectId: string, taskId: string, context: TaskContext): void {
    this.getState(projectId).summarizerCache.set(taskId, context);
  }

  private async runSummarizer(
    projectId: string,
    settings: import("@opensprint/shared").ProjectSettings,
    taskId: string,
    context: TaskContext,
    repoPath: string,
    planComplexity?: PlanComplexity
  ): Promise<TaskContext> {
    const depCount = context.dependencyOutputs.length;
    const planWordCount = countWords(context.planContent);
    const summarizerPrompt = buildSummarizerPrompt(taskId, context, depCount, planWordCount);
    const baseSystemPrompt = `You are the Summarizer agent for OpenSprint (PRD §12.3.5). Condense context into a focused summary when it exceeds size thresholds. Produce JSON only. No markdown outside the summary field.`;
    const systemPrompt = `${baseSystemPrompt}\n\n${await getCombinedInstructions(repoPath, "summarizer")}`;
    const summarizerId = `summarizer-${projectId}-${taskId}-${Date.now()}`;

    try {
      const summarizerResponse = await agentService.invokePlanningAgent({
        projectId,
        config: getAgentForPlanningRole(settings, "summarizer", planComplexity),
        messages: [{ role: "user", content: summarizerPrompt }],
        systemPrompt,
        cwd: repoPath,
        tracking: {
          id: summarizerId,
          projectId,
          phase: "execute",
          role: "summarizer",
          label: "Context condensation",
        },
      });

      const parsed = extractJsonFromAgentResponse<{ status: string; summary?: string }>(
        summarizerResponse.content,
        "status"
      );
      if (parsed && parsed.status === "success" && parsed.summary?.trim()) {
        log.info("Summarizer condensed context for task", { taskId });
        return {
          ...context,
          planContent: parsed.summary.trim(),
          prdExcerpt:
            "Context condensed by Summarizer (thresholds exceeded). See plan.md for full context.",
          dependencyOutputs: [],
        };
      }
    } catch (err) {
      log.warn("Summarizer failed, using raw context", {
        taskId,
        err: getErrorMessage(err),
      });
    }
    return context;
  }

  private async preflightCheck(
    repoPath: string,
    wtPath: string,
    taskId: string,
    baseBranch?: string,
    reviewAngles?: ReviewAngle[]
  ): Promise<void> {
    if (wtPath !== repoPath) {
      assertSafeTaskWorktreePath(repoPath, taskId, wtPath);
    }
    await this.branchManager.waitForGitReady(wtPath);
    const repoState = await inspectGitRepoState(repoPath, baseBranch);
    try {
      assertGitIdentityConfigured(repoState.identity, { appError: false });
    } catch (error) {
      if (error instanceof RepoPreflightError) {
        throw error;
      }
      throw new RepoPreflightError(String(error), ErrorCodes.GIT_IDENTITY_REQUIRED);
    }
    try {
      await ensureBaseBranchExists(repoPath, repoState.baseBranch);
    } catch (error) {
      throw new RepoPreflightError(
        error instanceof Error ? error.message : String(error),
        ErrorCodes.GIT_BASE_BRANCH_INVALID
      );
    }

    try {
      await fs.access(path.join(wtPath, "node_modules"));
    } catch {
      if (wtPath === repoPath) {
        log.warn("Pre-flight: node_modules missing, ensuring in repo (Branches mode)");
        await this.branchManager.ensureRepoNodeModules(repoPath);
      } else {
        log.warn("Pre-flight: node_modules missing, re-symlinking");
        await this.branchManager.symlinkNodeModules(repoPath, wtPath);
      }
    }

    if (reviewAngles && reviewAngles.length > 0) {
      for (const angle of reviewAngles) {
        await this.sessionManager.clearResult(wtPath, taskId, angle);
      }
    } else {
      await this.sessionManager.clearResult(wtPath, taskId);
    }
  }

  /** MergeCoordinatorHost: run merger agent to resolve conflicts; returns true if agent exited 0 */
  async runMergerAgentAndWait(options: {
    projectId: string;
    cwd: string;
    config: AgentConfig;
    phase: "rebase_before_merge" | "merge_to_main" | "push_rebase";
    taskId: string;
    branchName: string;
    conflictedFiles: string[];
    testCommand?: string;
  }): Promise<boolean> {
    return agentService.runMergerAgentAndWait(options);
  }
}

/** Shared orchestrator instance for build routes and task list (kanban phase override) */
export const orchestratorService = new OrchestratorService();
