import fs from "fs/promises";
import path from "path";
import type {
  GitMergeQueueSnapshot,
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
  getFailureTypeTitle,
  OPENSPRINT_PATHS,
  resolveTestCommand,
  DEFAULT_REVIEW_MODE,
  type ReviewAngle,
  getAgentForPlanningRole,
  getAgentName,
  getAgentNameForRole,
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
import { BranchManager } from "./branch-manager.js";
import { ContextAssembler } from "./context-assembler.js";
import type { SessionManager } from "./session-manager.js";
import { getCombinedInstructions } from "./agent-instructions.service.js";
import { buildSummarizerPrompt, countWords } from "./summarizer.service.js";
import type { TaskContext } from "./context-assembler.js";
import { TestRunner, type ScopedTestResult } from "./test-runner.js";
import { activeAgentsService } from "./active-agents.service.js";
import { recoveryService, type RecoveryHost, type GuppAssignment } from "./recovery.service.js";
import { FeedbackService } from "./feedback.service.js";
import { notificationService } from "./notification.service.js";
import { maybeAutoRespond } from "./open-question-autoresolve.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { broadcastAuthoritativeTaskUpdated } from "../task-store-events.js";
import { getErrorMessage } from "../utils/error-utils.js";
import { extractJsonFromAgentResponse } from "../utils/json-extract.js";
import { assertSafeTaskWorktreePath } from "../utils/path-safety.js";
import { TimerRegistry } from "./timer-registry.js";
import { AgentLifecycleManager, type AgentRunState } from "./agent-lifecycle.js";
import { heartbeatService } from "./heartbeat.service.js";
import { FileScopeAnalyzer, type FileScope } from "./file-scope-analyzer.js";
import { TaskScheduler } from "./task-scheduler.js";
import { eventLogService } from "./event-log.service.js";
import { createLogger } from "../utils/logger.js";
import { filterAgentOutput } from "../utils/agent-output-filter.js";
import { PhaseExecutorService, type PhaseExecutorHost } from "./phase-executor.service.js";
import { agentIdentityService } from "./agent-identity.service.js";
import { FailureHandlerService, type FailureHandlerHost } from "./failure-handler.service.js";
import {
  MergeCoordinatorService,
  type MergeCoordinatorHost,
  type MergeQualityGateFailure,
  type MergeQualityGateRunOptions,
} from "./merge-coordinator.service.js";
import { runMergeQualityGates as runMergeQualityGatesShared } from "./merge-quality-gate-runner.js";
import { getMergeQualityGateCommands } from "./merge-quality-gates.js";
import {
  TaskPhaseCoordinator,
  type TestOutcome,
  type ReviewOutcome,
} from "./task-phase-coordinator.js";
import { reviewSynthesizerService } from "./review-synthesizer.service.js";
import { validateTransition } from "./task-state-machine.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { isExhausted } from "./api-key-exhausted.service.js";
import { invokeStructuredPlanningAgent } from "./structured-agent-output.service.js";
import {
  buildTaskLastExecutionSummary,
  compactExecutionText,
  persistTaskLastExecutionSummary,
} from "./task-execution-summary.js";
import {
  ensureGitIdentityConfigured,
  ensureBaseBranchExists,
  inspectGitRepoState,
  RepoPreflightError,
  resolveBaseBranch,
} from "../utils/git-repo-state.js";
import {
  buildOrchestratorTestStatusContent,
  getOrchestratorTestStatusFsPath,
  getOrchestratorTestStatusStateFsPath,
  parseOrchestratorTestStatusContent,
  type PersistedOrchestratorTestStatus,
} from "./orchestrator-test-status.js";
import { isSelfImprovementRunInProgress } from "./self-improvement-runner.service.js";
import { gitCommitQueue } from "./git-commit-queue.service.js";
import {
  OrchestratorStatusService,
  buildReviewAgentId,
  REVIEW_ANGLE_ACTIVE_LABELS,
  type StateForStatus,
  type OrchestratorCounters,
} from "./orchestrator-status.service.js";
import { OrchestratorLoopService } from "./orchestrator-loop.service.js";
import {
  buildOrchestratorRecoveryHost,
  type OrchestratorRecoveryHost,
} from "./orchestrator-recovery.service.js";
import {
  OrchestratorDispatchService,
  type OrchestratorDispatchHost,
} from "./orchestrator-dispatch.service.js";
import {
  extractNoResultReasonFromLogs,
  buildReviewNoResultFailureReason,
  synthesizeCodingResultFromOutput,
} from "./no-result-reason.service.js";
import {
  describeStructuredOutputProblem,
  parseCodingAgentResult,
  parseReviewAgentResult,
} from "./agent-result-validation.js";

const log = createLogger("orchestrator");

import type {
  FailureType,
  ReviewRetryTarget,
  RetryContext,
  RetryQualityGateDetail,
  TaskAssignmentLike,
} from "./orchestrator-phase-context.js";

/** Loop kicker interval: 60s — restarts idle orchestrator loop (distinct from 5-min WatchdogService health patrol). */
const LOOP_KICKER_INTERVAL_MS = 60 * 1000;
const CODING_RESULT_EXPECTED_SHAPE =
  'a JSON object like {"status":"success","summary":"..."} or {"status":"failed","summary":"...","open_questions":[{"id":"q1","text":"..."}]}';
const REVIEW_RESULT_EXPECTED_SHAPE =
  'a JSON object like {"status":"approved","summary":"..."} or {"status":"rejected","summary":"...","issues":["..."],"notes":"..."}';

/**
 * GUPP-style assignment file: everything an agent needs to self-start.
 * Written before agent spawn so crash recovery can simply re-read and re-spawn.
 */
export interface TaskAssignment {
  taskId: string;
  projectId: string;
  phase: "coding" | "review";
  branchName: string;
  /** Worktree key (task.id or epic_<epicId>). Persisted so recovery uses same branch/worktree. */
  worktreeKey?: string;
  worktreePath: string;
  promptPath: string;
  agentConfig: AgentConfig;
  attempt: number;
  retryContext?: RetryContext;
  createdAt: string;
  replayMetadata?: {
    baseCommitSha: string;
    behaviorVersionId?: string;
    templateVersionId?: string;
  };
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
  validationCommand?: string | null;
  qualityGateDetail?: RetryQualityGateDetail | null;
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
  /** When set (per_epic + epic task), worktree is keyed by this (e.g. epic_<epicId>); else worktree key is taskId. */
  worktreeKey?: string;
  worktreePath: string | null;
  agent: AgentRunState;
  phase: "coding" | "review";
  attempt: number;
  phaseResult: PhaseResult;
  infraRetries: number;
  timers: TimerRegistry;
  reviewAgents?: Map<ReviewAngle, ReviewAgentSlotState>;
  /** When true, slot.agent is the general reviewer and reviewAgents are angle-specific (both run in parallel). */
  includeGeneralReview?: boolean;
  fileScope?: FileScope;
  /** Coordinator for joining parallel test + review when both are enabled. */
  phaseCoordinator?: TaskPhaseCoordinator;
  /** Display name for this slot (e.g. "Frodo", "Boromir"); set at start_task or enter_review. */
  assignee?: string;
  retryContext?: RetryContext;
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

/**
 * Build orchestrator service.
 * Manages the multi-agent build loop: poll bd ready -> assign -> spawn agent -> monitor -> handle result.
 * Supports concurrent coder agents via slot-based state model.
 */
export class OrchestratorService {
  private state = new Map<string, OrchestratorState>();
  private taskStore = taskStoreSingleton;
  private _projectService: ProjectService | null = null;
  private branchManager = new BranchManager();
  private _contextAssembler: ContextAssembler | null = null;
  private _sessionManager: SessionManager | null = null;
  private get sessionManager(): SessionManager {
    const sm = this._sessionManager;
    if (!sm) throw new Error("OrchestratorService: sessionManager not injected");
    return sm;
  }
  /** Injected by composition root so a single SessionManager is shared. */
  setSessionManager(sm: SessionManager): void {
    this._sessionManager = sm;
  }
  private testRunner = new TestRunner();
  private _feedbackService: FeedbackService | null = null;
  private lifecycleManager = new AgentLifecycleManager();
  private fileScopeAnalyzer = new FileScopeAnalyzer();
  private taskScheduler = new TaskScheduler(this.taskStore);
  /** Cached repoPath per project (avoids async lookup in synchronous transition()) */
  private repoPathCache = new Map<string, string>();
  /** Cached effective maxSlots per project (branches mode forces 1; avoids async lookup in nudge()) */
  private maxSlotsCache = new Map<string, number>();
  private failureHandler = new FailureHandlerService(this as unknown as FailureHandlerHost);
  private mergeCoordinator = new MergeCoordinatorService(this as unknown as MergeCoordinatorHost);
  private _statusService: OrchestratorStatusService | null = null;
  private get statusService(): OrchestratorStatusService {
    if (!this._statusService)
      this._statusService = new OrchestratorStatusService(this.taskStore, this.projectService);
    return this._statusService;
  }
  private loopService = new OrchestratorLoopService(
    this as unknown as import("./orchestrator-loop.service.js").OrchestratorLoopHost
  );
  private dispatchService = new OrchestratorDispatchService(
    this as unknown as OrchestratorDispatchHost
  );

  private get projectService(): ProjectService {
    if (!this._projectService) this._projectService = new ProjectService();
    return this._projectService;
  }
  private get contextAssembler(): ContextAssembler {
    if (!this._contextAssembler) this._contextAssembler = new ContextAssembler();
    return this._contextAssembler;
  }
  private get feedbackService(): FeedbackService {
    if (!this._feedbackService) this._feedbackService = new FeedbackService();
    return this._feedbackService;
  }

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

  /** Git worktree_merge queue for execute.status / HTTP (empty when repo path unknown). */
  private getGitMergeQueueSnapshot(projectId: string): GitMergeQueueSnapshot {
    const repoPath = this.repoPathCache.get(projectId);
    if (!repoPath) {
      return { activeTaskId: null, pendingTaskIds: [] };
    }
    return gitCommitQueue.getMergeQueueSnapshotForRepo(repoPath);
  }

  hasActiveTask(projectId: string, taskId: string): boolean {
    return this.state.get(projectId)?.slots.has(taskId) ?? false;
  }

  private defaultStatus(): OrchestratorStatus {
    return {
      activeTasks: [],
      queueDepth: 0,
      totalDone: 0,
      totalFailed: 0,
      baselineStatus: "unknown",
      baselineCheckedAt: null,
      baselineFailureSummary: null,
      mergeValidationStatus: "healthy",
      mergeValidationFailureSummary: null,
      dispatchPausedReason: null,
    };
  }

  /** Create a new AgentSlot for a task (optionally with assignee for recovery). */
  private createSlot(
    taskId: string,
    taskTitle: string | null,
    branchName: string,
    attempt: number,
    assignee?: string,
    worktreeKey?: string
  ): AgentSlot {
    return {
      taskId,
      taskTitle,
      branchName,
      ...(worktreeKey != null && { worktreeKey }),
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
      phaseResult: {
        codingDiff: "",
        codingSummary: "",
        testResults: null,
        testOutput: "",
        validationCommand: null,
        qualityGateDetail: null,
      },
      infraRetries: 0,
      timers: new TimerRegistry(),
      ...(assignee != null && { assignee }),
    };
  }

  /** Build activeTasks array from current slots for status/broadcast */
  private buildActiveTasks(state: OrchestratorState): OrchestratorStatus["activeTasks"] {
    return this.statusService.buildActiveTasks(state as unknown as StateForStatus);
  }

  private buildExecuteStatusPayload(
    projectId: string,
    state: OrchestratorState,
    overrides?: {
      queueDepth?: number;
      pendingFeedbackCategorizations?: PendingFeedbackCategorization[];
    }
  ): import("@opensprint/shared").ExecuteStatusEvent {
    return {
      type: "execute.status",
      activeTasks: this.buildActiveTasks(state),
      queueDepth: overrides?.queueDepth ?? state.status.queueDepth,
      baselineStatus: state.status.baselineStatus,
      baselineCheckedAt: state.status.baselineCheckedAt ?? null,
      baselineFailureSummary: state.status.baselineFailureSummary ?? null,
      mergeValidationStatus: state.status.mergeValidationStatus ?? "healthy",
      mergeValidationFailureSummary: state.status.mergeValidationFailureSummary ?? null,
      dispatchPausedReason: state.status.dispatchPausedReason ?? null,
      ...(overrides?.pendingFeedbackCategorizations && {
        pendingFeedbackCategorizations: overrides.pendingFeedbackCategorizations,
      }),
      selfImprovementRunInProgress: isSelfImprovementRunInProgress(projectId),
      gitMergeQueue: this.getGitMergeQueueSnapshot(projectId),
    };
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
        broadcastToProject(
          projectId,
          this.buildExecuteStatusPayload(projectId, state, { queueDepth: t.queueDepth })
        );
        break;
      }

      case "enter_review": {
        const slot = state.slots.get(t.taskId);
        if (slot) {
          slot.phase = "review";
          slot.assignee = t.assignee;
        }
        void broadcastAuthoritativeTaskUpdated(broadcastToProject, projectId, t.taskId);
        broadcastToProject(
          projectId,
          this.buildExecuteStatusPayload(projectId, state, { queueDepth: t.queueDepth })
        );
        break;
      }

      case "complete":
        state.status.totalDone += 1;
        this.removeSlot(state, t.taskId);
        broadcastToProject(projectId, this.buildExecuteStatusPayload(projectId, state));
        break;

      case "fail":
        state.status.totalFailed += 1;
        this.removeSlot(state, t.taskId);
        broadcastToProject(projectId, this.buildExecuteStatusPayload(projectId, state));
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

  private async persistCounters(projectId: string, repoPath: string): Promise<void> {
    const state = this.getState(projectId);
    await this.statusService.persistCounters(
      projectId,
      repoPath,
      state as unknown as StateForStatus
    );
  }

  private async loadCounters(repoPath: string): Promise<OrchestratorCounters | null> {
    return this.statusService.loadCounters(repoPath);
  }

  async setBaselineRuntimeState(
    projectId: string,
    repoPath: string,
    updates: {
      baselineStatus?: OrchestratorStatus["baselineStatus"];
      baselineCheckedAt?: string | null;
      baselineFailureSummary?: string | null;
      dispatchPausedReason?: string | null;
    }
  ): Promise<void> {
    const state = this.getState(projectId);
    let changed = false;

    if (
      updates.baselineStatus !== undefined &&
      state.status.baselineStatus !== updates.baselineStatus
    ) {
      state.status.baselineStatus = updates.baselineStatus;
      changed = true;
    }
    if (
      updates.baselineCheckedAt !== undefined &&
      state.status.baselineCheckedAt !== updates.baselineCheckedAt
    ) {
      state.status.baselineCheckedAt = updates.baselineCheckedAt;
      changed = true;
    }
    if (
      updates.baselineFailureSummary !== undefined &&
      state.status.baselineFailureSummary !== updates.baselineFailureSummary
    ) {
      state.status.baselineFailureSummary = updates.baselineFailureSummary;
      changed = true;
    }
    if (
      updates.dispatchPausedReason !== undefined &&
      state.status.dispatchPausedReason !== updates.dispatchPausedReason
    ) {
      state.status.dispatchPausedReason = updates.dispatchPausedReason;
      changed = true;
    }

    if (!changed) return;

    await this.persistCounters(projectId, repoPath);
    this.emitExecuteStatus(projectId);
  }

  async setMergeValidationRuntimeState(
    projectId: string,
    repoPath: string,
    updates: {
      mergeValidationStatus?: OrchestratorStatus["mergeValidationStatus"];
      mergeValidationFailureSummary?: string | null;
    }
  ): Promise<void> {
    const state = this.getState(projectId);
    let changed = false;

    if (
      updates.mergeValidationStatus !== undefined &&
      state.status.mergeValidationStatus !== updates.mergeValidationStatus
    ) {
      state.status.mergeValidationStatus = updates.mergeValidationStatus;
      changed = true;
    }
    if (
      updates.mergeValidationFailureSummary !== undefined &&
      state.status.mergeValidationFailureSummary !== updates.mergeValidationFailureSummary
    ) {
      state.status.mergeValidationFailureSummary = updates.mergeValidationFailureSummary;
      changed = true;
    }

    if (!changed) return;

    this.emitExecuteStatus(projectId);
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
          await this.branchManager.removeTaskWorktree(
            repoPath,
            slot.worktreeKey ?? taskId,
            slot.worktreePath
          );
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
          await this.branchManager.removeTaskWorktree(
            repoPath,
            slot.worktreeKey ?? taskId,
            slot.worktreePath
          );
        } catch {
          // Best effort; worktree may already be gone
        }
      }
      await this.deleteAssignmentAt(repoPath, taskId, slot.worktreePath ?? undefined);
      this.removeSlot(state, taskId);
      removed = true;
    }

    if (removed) {
      broadcastToProject(projectId, this.buildExecuteStatusPayload(projectId, state));
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
          await this.branchManager.removeTaskWorktree(
            repoPath,
            slot.worktreeKey ?? taskId,
            slot.worktreePath
          );
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

    broadcastToProject(projectId, this.buildExecuteStatusPayload(projectId, state));
    this.nudge(projectId);
  }

  // ─── Lifecycle ───

  stopProject(projectId: string): void {
    const state = this.state.get(projectId);
    if (!state) return;

    log.info(`Stopping orchestrator for project ${projectId}`);

    // Invalidate any in-flight loop so it cannot reschedule itself on stale timers.
    state.loopRunId = (state.loopRunId ?? 0) + 1;
    state.loopActive = false;
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
    broadcastToProject(projectId, this.buildExecuteStatusPayload(projectId, state));
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

  private getRecoveredWorktreeKey(assignment: GuppAssignment): string | undefined {
    return (
      assignment.worktreeKey ??
      (assignment.branchName.startsWith("opensprint/epic_")
        ? assignment.branchName.slice("opensprint/".length)
        : undefined)
    );
  }

  private getTerminalResultExitCode(result: { status?: string } | null | undefined): number | null {
    const status = typeof result?.status === "string" ? result.status.toLowerCase() : "";
    if (!["success", "failed", "approved", "rejected"].includes(status)) {
      return null;
    }
    return status === "success" || status === "approved" ? 0 : 1;
  }

  private getReviewAngleFromAssignment(assignment: GuppAssignment): ReviewAngle | undefined {
    const match = assignment.promptPath.match(
      /[\\/]+review-angles[\\/]+([^\\/]+)[\\/]+prompt\.md$/
    );
    if (!match) return undefined;
    const angle = match[1];
    return REVIEW_ANGLE_OPTIONS.some((option) => option.value === angle)
      ? (angle as ReviewAngle)
      : undefined;
  }

  private async hydrateRecoveredOutputLog(agent: AgentRunState, promptPath: string): Promise<void> {
    const outputLogPath = path.join(path.dirname(promptPath), OPENSPRINT_PATHS.agentOutputLog);
    try {
      const raw = await fs.readFile(outputLogPath, "utf-8");
      if (!raw) return;
      const output = filterAgentOutput(raw);
      agent.outputLog = [output];
      agent.outputLogBytes = Buffer.byteLength(output);
      const now = Date.now();
      agent.lastOutputTime = now;
      agent.lastOutputAtIso = new Date(now).toISOString();
    } catch {
      // Best-effort hydration for session archival.
    }
  }

  async handleCompletedRecoveredAssignment(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    assignment: GuppAssignment
  ): Promise<boolean> {
    return assignment.phase === "review"
      ? this.resumeRecoveredReviewFromTerminalResult(projectId, repoPath, task, assignment)
      : this.resumeRecoveredCodingFromTerminalResult(projectId, repoPath, task, assignment);
  }

  private async resumeRecoveredCodingFromTerminalResult(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    assignment: GuppAssignment
  ): Promise<boolean> {
    try {
      await fs.access(assignment.worktreePath);
    } catch {
      return false;
    }

    const { result } = await this.readCodingResultWithRaw(assignment.worktreePath, task.id);
    const exitCode = this.getTerminalResultExitCode(result);
    if (exitCode == null) return false;

    const state = this.getState(projectId);
    let slot = state.slots.get(task.id);
    if (!slot) {
      const assignee = task.assignee ?? getAgentName(0);
      slot = this.createSlot(
        task.id,
        task.title ?? null,
        assignment.branchName,
        assignment.attempt,
        assignee,
        this.getRecoveredWorktreeKey(assignment)
      );
      slot.worktreePath = assignment.worktreePath;
      slot.retryContext = assignment.retryContext;
      slot.agent.startedAt = assignment.createdAt;
      await this.hydrateRecoveredOutputLog(slot.agent, assignment.promptPath);
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
      if (coderIdx >= 0) {
        state.nextCoderIndex = Math.max(state.nextCoderIndex, coderIdx + 1);
      }
    }

    await this.handleCodingDone(projectId, repoPath, task, assignment.branchName, exitCode);
    return true;
  }

  private async resumeRecoveredReviewFromTerminalResult(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    assignment: GuppAssignment
  ): Promise<boolean> {
    const settings = await this.projectService.getSettings(projectId);
    const reviewMode = settings.reviewMode ?? DEFAULT_REVIEW_MODE;
    if (reviewMode === "never") return false;

    try {
      await fs.access(assignment.worktreePath);
    } catch {
      return false;
    }

    const angle = this.getReviewAngleFromAssignment(assignment);
    const result = await this.readReviewResult(assignment.worktreePath, task.id, angle);
    const exitCode = this.getTerminalResultExitCode(result);
    if (exitCode == null) return false;
    const persistedTestStatus = await this.readPersistedReviewTestStatus(
      task.id,
      repoPath,
      assignment.worktreePath
    );

    const state = this.getState(projectId);
    let slot = state.slots.get(task.id);
    if (!slot) {
      const baseBranch = await resolveBaseBranch(repoPath, settings.worktreeBaseBranch);
      let changedFiles: string[] = [];
      try {
        changedFiles = await this.branchManager.getChangedFiles(
          repoPath,
          assignment.branchName,
          baseBranch
        );
      } catch {
        // Fall back to configured/full suite.
      }

      const reviewerList = AGENT_NAMES_BY_ROLE.reviewer ?? [];
      const reviewerAssignee =
        typeof task.assignee === "string" && reviewerList.includes(task.assignee)
          ? task.assignee
          : getAgentNameForRole("reviewer", state.nextReviewerIndex);
      const reviewerIdx = reviewerList.indexOf(reviewerAssignee);
      if (reviewerIdx >= 0) {
        state.nextReviewerIndex = Math.max(state.nextReviewerIndex, reviewerIdx + 1);
      } else {
        state.nextReviewerIndex += 1;
      }

      slot = this.createSlot(
        task.id,
        task.title ?? null,
        assignment.branchName,
        assignment.attempt,
        reviewerAssignee,
        this.getRecoveredWorktreeKey(assignment)
      );
      slot.worktreePath = assignment.worktreePath;
      slot.retryContext = assignment.retryContext;
      slot.agent.startedAt = assignment.createdAt;
      await this.hydrateRecoveredOutputLog(slot.agent, assignment.promptPath);
      state.slots.set(task.id, slot);
      this.transition(projectId, {
        to: "enter_review",
        taskId: task.id,
        queueDepth: state.status.queueDepth,
        assignee: reviewerAssignee,
      });
      await this.persistCounters(projectId, repoPath);
      if (persistedTestStatus) {
        const coordinator = this.createReviewPhaseCoordinator(
          projectId,
          repoPath,
          task,
          assignment.branchName,
          settings
        );
        slot.phaseCoordinator = coordinator;
        const recoveredTestOutcome = this.toRecoveredTestOutcome(persistedTestStatus);
        if (recoveredTestOutcome) {
          this.applyRecoveredTestOutcome(
            slot.phaseResult,
            recoveredTestOutcome,
            persistedTestStatus
          );
          await coordinator.setTestOutcome(recoveredTestOutcome);
        }
      } else {
        await this.startReviewCoordinatorAndTests(
          projectId,
          repoPath,
          task,
          assignment.branchName,
          settings,
          changedFiles
        );
      }
      await this.clearRateLimitNotifications(projectId);
    } else if (persistedTestStatus && slot.phaseCoordinator) {
      const recoveredTestOutcome = this.toRecoveredTestOutcome(persistedTestStatus);
      if (recoveredTestOutcome) {
        this.applyRecoveredTestOutcome(slot.phaseResult, recoveredTestOutcome, persistedTestStatus);
        await slot.phaseCoordinator.setTestOutcome(recoveredTestOutcome);
      }
    }

    await this.handleReviewDone(projectId, repoPath, task, assignment.branchName, exitCode, angle);
    return true;
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
      assignee,
      this.getRecoveredWorktreeKey(assignment)
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
      reviewerAssignee,
      this.getRecoveredWorktreeKey(assignment)
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

  /** Remove a slot for recovery (stale task or cleanup). Used by RecoveryService. */
  async removeStaleSlot(projectId: string, taskId: string, repoPath: string): Promise<void> {
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
        await this.branchManager.removeTaskWorktree(
          repoPath,
          slot.worktreeKey ?? taskId,
          slot.worktreePath
        );
      } catch {
        // Best effort; worktree may already be gone
      }
    }
    await this.deleteAssignmentAt(repoPath, taskId, slot.worktreePath ?? undefined);
    this.removeSlot(state, taskId);
  }

  /** Handle recoverable heartbeat gap (reattach or resume with suspend reason). Used by RecoveryService. */
  async handleRecoverableHeartbeatGap(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    assignment: GuppAssignment
  ): Promise<boolean> {
    if (assignment.phase === "review") {
      return this.resumeRecoveredReviewPhase(projectId, repoPath, task, assignment, {
        pidAlive: true,
        suspendReason: "heartbeat_gap",
      });
    }
    return this.reattachRecoveredCodingTask(projectId, repoPath, task, assignment, {
      suspendReason: "heartbeat_gap",
    });
  }

  /** Build a RecoveryHost for the unified RecoveryService */
  private buildRecoveryHost(): RecoveryHost {
    return buildOrchestratorRecoveryHost(this as unknown as OrchestratorRecoveryHost);
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
      state.status.baselineStatus = counters.baselineStatus;
      state.status.baselineCheckedAt = counters.baselineCheckedAt;
      state.status.baselineFailureSummary = counters.baselineFailureSummary;
      state.status.dispatchPausedReason = counters.dispatchPausedReason;
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
            this.startRunLoop(projectId, "nudge-pending-feedback");
          }
        })
        .catch(() => {});
      return;
    }

    log.info("Nudge received, starting loop for project", { projectId });
    this.startRunLoop(projectId, "nudge");
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
      selfImprovementRunInProgress: isSelfImprovementRunInProgress(projectId),
      gitMergeQueue: this.getGitMergeQueueSnapshot(projectId),
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

  /** Active agent IDs (planning + execute) for recovery/orphan detection. */
  getActiveAgentIds(projectId: string): string[] {
    return activeAgentsService.list(projectId).map((a) => a.id);
  }

  /** Invalidate maxSlots cache for a project (e.g. after settings change). Next runLoop will refresh. */
  invalidateMaxSlotsCache(projectId: string): void {
    this.maxSlotsCache.delete(projectId);
  }

  /** Used by OrchestratorLoopService host interface. */
  getProjectService(): ProjectService {
    return this.projectService;
  }
  /** Used by OrchestratorLoopService host interface. */
  getTaskStore(): typeof taskStoreSingleton {
    return this.taskStore;
  }
  /** Used by OrchestratorLoopService host interface. */
  getTaskScheduler(): TaskScheduler {
    return this.taskScheduler;
  }
  /** Used by OrchestratorDispatchService host interface. */
  getBranchManager(): BranchManager {
    return this.branchManager;
  }
  /** Used by OrchestratorDispatchService host interface. */
  getFileScopeAnalyzer(): FileScopeAnalyzer {
    return this.fileScopeAnalyzer;
  }
  /** Used by OrchestratorLoopService host interface. */
  getFeedbackService(): FeedbackService {
    return this.feedbackService;
  }
  /** Used by OrchestratorLoopService host interface. */
  getMaxSlotsCache(): Map<string, number> {
    return this.maxSlotsCache;
  }
  /** Used by OrchestratorLoopService host interface. */
  setMaxSlotsCache(projectId: string, value: number): void {
    this.maxSlotsCache.set(projectId, value);
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
      const raw = await fs.readFile(outputLogPath, "utf-8");
      return filterAgentOutput(raw);
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
        if (slot.includeGeneralReview) {
          agents.push({
            id: buildReviewAgentId(slot.taskId, "general"),
            taskId: slot.taskId,
            phase: "review",
            role: "reviewer",
            label: slot.taskTitle ?? slot.taskId,
            startedAt: slot.agent.startedAt || new Date().toISOString(),
            branchName: slot.branchName,
            name: "General",
            state: slot.agent.lifecycleState,
            ...(slot.agent.lastOutputAtIso ? { lastOutputAt: slot.agent.lastOutputAtIso } : {}),
            ...(slot.agent.suspendedAtIso ? { suspendedAt: slot.agent.suspendedAtIso } : {}),
            ...(slot.agent.suspendReason ? { suspendReason: slot.agent.suspendReason } : {}),
          });
        }
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
        ...(slot.assignee != null && slot.assignee.trim() !== ""
          ? { name: slot.assignee.trim() }
          : slot.phase === "review"
            ? { name: "General" }
            : {}),
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
    await this.dispatchService.dispatchTask(projectId, repoPath, task, slotQueueDepth);
  }

  /**
   * Start the orchestrator loop without awaiting. Rejections are logged so they never become
   * unhandled (which can terminate the process under strict unhandled-rejection handling).
   */
  private startRunLoop(projectId: string, reason: string): void {
    void this.runLoop(projectId).catch((err) => {
      log.error("Orchestrator runLoop promise rejected", {
        projectId,
        reason,
        err: getErrorMessage(err),
      });
    });
  }

  private async runLoop(projectId: string): Promise<void> {
    await this.loopService.runLoop(projectId);
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

  private async performMergeRetry(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    slot: AgentSlot
  ): Promise<void> {
    await this.mergeCoordinator.performMergeAndDone(projectId, repoPath, task, slot.branchName);
  }

  /** Provider display name for API-blocked notifications */
  private static getProviderDisplayName(
    provider: import("@opensprint/shared").ApiKeyProvider
  ): string {
    switch (provider) {
      case "ANTHROPIC_API_KEY":
        return "Anthropic";
      case "CURSOR_API_KEY":
        return "Cursor";
      case "OPENAI_API_KEY":
        return "OpenAI";
      case "GOOGLE_API_KEY":
        return "Google";
      default:
        return provider;
    }
  }

  /**
   * When the orchestrator has no dispatchable tasks, ensure api_blocked notifications exist
   * for every exhausted provider so the UI shows the reason (e.g. user wasn't connected to
   * this project's WebSocket when exhaustion was first detected).
   */
  private async ensureApiBlockedNotificationsForExhaustedProviders(
    projectId: string
  ): Promise<void> {
    const providers: import("@opensprint/shared").ApiKeyProvider[] = [
      "ANTHROPIC_API_KEY",
      "CURSOR_API_KEY",
      "OPENAI_API_KEY",
      "GOOGLE_API_KEY",
    ];
    const existing = await notificationService.listByProject(projectId);
    for (const provider of providers) {
      if (!isExhausted(projectId, provider)) continue;
      const alreadyNotified = existing.some(
        (n) => n.kind === "api_blocked" && n.sourceId === `api-keys-${provider}`
      );
      if (alreadyNotified) continue;
      const providerDisplay = OrchestratorService.getProviderDisplayName(provider);
      const message = `Your API key(s) for ${providerDisplay} have hit their limit. Please increase your budget or add another key.`;
      const notification = await notificationService.createApiBlocked({
        projectId,
        source: "execute",
        sourceId: `api-keys-${provider}`,
        message,
        errorCode: "rate_limit",
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
          kind: "api_blocked",
          errorCode: notification.errorCode,
        },
      });
      log.info("Created API-blocked notification for exhausted provider (no dispatchable tasks)", {
        projectId,
        provider,
      });
    }
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

    const providerDisplay = OrchestratorService.getProviderDisplayName(provider);
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
        await this.branchManager.removeTaskWorktree(
          repoPath,
          slot.worktreeKey ?? task.id,
          slot.worktreePath
        );
      } catch {
        // Best effort
      }
    }
    await this.deleteAssignmentAt(repoPath, task.id, slot.worktreePath ?? undefined);
    this.removeSlot(state, task.id);
    broadcastToProject(projectId, this.buildExecuteStatusPayload(projectId, state));
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

    const readResultWithTimeout = async (): Promise<{
      raw: string | null;
      result: CodingAgentResult | null;
    }> => {
      const timeoutMs = 15_000;
      return (await Promise.race([
        this.readCodingResultWithRaw(wtPath, task.id),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("readResult timeout")), timeoutMs)
        ),
      ]).catch((err) => {
        log.warn("readResult failed or timed out", { taskId: task.id, err });
        return {
          raw: null,
          result: null,
        };
      })) as {
        raw: string | null;
        result: CodingAgentResult | null;
      };
    };

    const { raw: rawResult, result: parsedResult } = await readResultWithTimeout();
    let result = parsedResult;

    if (!result) {
      const retried = await this.retryCodingStructuredOutputRepair(
        projectId,
        repoPath,
        task,
        slot,
        rawResult
      );
      if (retried) {
        return;
      }

      const synthesizedResult = synthesizeCodingResultFromOutput(slot.agent.outputLog);
      if (synthesizedResult) {
        result = synthesizedResult;
        log.info("Synthesized coding result from structured terminal agent output", {
          taskId: task.id,
          status: result.status,
        });
      }
    }

    if (!result) {
      const failureType: FailureType = slot.agent.killedDueToTimeout
        ? "timeout"
        : exitCode === 143 || exitCode === 137
          ? "agent_crash"
          : "no_result";
      const noResultReason =
        failureType === "no_result"
          ? await extractNoResultReasonFromLogs(wtPath, task.id, slot.agent.outputLog)
          : undefined;
      slot.agent.killedDueToTimeout = false;
      const noResultMessage =
        "The coding agent stopped without reporting whether the task succeeded or failed." +
        (noResultReason ? ` Recent agent output: ${noResultReason}` : "");
      await this.failureHandler.handleTaskFailure(
        projectId,
        repoPath,
        task,
        branchName,
        noResultMessage,
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
        changedFiles = await this.branchManager.getChangedFiles(repoPath, branchName, baseBranch);
      } catch {
        // Fall back to full suite
      }

      const reviewMode = settings.reviewMode ?? DEFAULT_REVIEW_MODE;

      if (reviewMode === "never") {
        const scopedResult = await this.runAdaptiveValidation(
          projectId,
          wtPath,
          changedFiles,
          testCommand
        );
        slot.phaseResult.testOutput = scopedResult.rawOutput;
        slot.phaseResult.validationCommand = scopedResult.executedCommand ?? testCommand ?? null;
        this.clearQualityGateDetail(slot.phaseResult);
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
        const qualityGateFailure = await this.runMergeQualityGates({
          projectId,
          repoPath,
          worktreePath: wtPath,
          taskId: task.id,
          branchName,
          baseBranch,
          validationWorkspace: "task_worktree",
        });
        if (qualityGateFailure) {
          const detail = this.applyQualityGateFailure(slot.phaseResult, qualityGateFailure, wtPath);
          await this.failureHandler.handleTaskFailure(
            projectId,
            repoPath,
            task,
            branchName,
            this.formatQualityGateFailureReason(
              detail,
              qualityGateFailure.category === "environment_setup"
                ? "environment_setup"
                : "merge_quality_gate"
            ),
            null,
            qualityGateFailure.category === "environment_setup"
              ? "environment_setup"
              : "merge_quality_gate"
          );
          return;
        }
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
        void maybeAutoRespond(projectId, notification);
        const settings = await this.projectService.getSettings(projectId);
        const agentConfig = settings.simpleComplexityAgent;
        agentIdentityService
          .recordAttempt(repoPath, {
            taskId: task.id,
            agentId: `${agentConfig.type}-${agentConfig.model ?? "default"}`,
            role: "coder",
            model: agentConfig.model ?? "unknown",
            attempt: slot.attempt,
            startedAt: slot.agent.startedAt ?? new Date().toISOString(),
            completedAt: new Date().toISOString(),
            outcome: "coding_failure",
            durationMs: Math.max(
              0,
              Date.now() - new Date(slot.agent.startedAt ?? Date.now()).getTime()
            ),
          })
          .catch((err) =>
            log.warn("Failed to record coder run for Agent Log (open_questions)", { err })
          );
        await this.taskStore.update(projectId, task.id, {
          assignee: "",
          status: "blocked",
          block_reason: OPEN_QUESTION_BLOCK_REASON,
        });
        const wtPath = slot.worktreePath ?? repoPath;
        await heartbeatService.deleteHeartbeat(wtPath, task.id).catch(() => {});
        if (slot.worktreePath && slot.worktreePath !== repoPath) {
          try {
            await this.branchManager.removeTaskWorktree(
              repoPath,
              slot.worktreeKey ?? task.id,
              slot.worktreePath
            );
          } catch {
            // Best effort
          }
        }
        await this.deleteAssignment(repoPath, task.id);
        this.removeSlot(state, task.id);
        broadcastToProject(projectId, this.buildExecuteStatusPayload(projectId, state));
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

  private async runAdaptiveValidation(
    projectId: string,
    wtPath: string,
    changedFiles: string[],
    testCommand?: string
  ): Promise<ScopedTestResult> {
    const preferredScope: "scoped" | "full" = changedFiles.length > 0 ? "scoped" : "full";
    const timeoutMs = await this.projectService.getValidationTimeoutMs(projectId, preferredScope);
    const startedAt = Date.now();
    try {
      const scopedResult = await this.testRunner.runScopedTests(wtPath, changedFiles, testCommand, {
        timeoutMs,
      });
      const durationMs = Date.now() - startedAt;
      void this.projectService
        .recordValidationDuration(projectId, scopedResult.scope, durationMs)
        .catch((err) => {
          log.warn("Failed to persist validation timing sample", { projectId, durationMs, err });
        });
      return scopedResult;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      void this.projectService
        .recordValidationDuration(projectId, preferredScope, durationMs)
        .catch(() => {});
      throw err;
    }
  }

  private clearQualityGateDetail(phaseResult: PhaseResult): void {
    phaseResult.qualityGateDetail = null;
  }

  private toQualityGateDetail(
    failure: MergeQualityGateFailure,
    fallbackWorktreePath: string
  ): RetryQualityGateDetail {
    return {
      command: failure.command,
      reason: failure.reason?.trim().slice(0, 500) || "Unknown quality gate failure",
      outputSnippet:
        compactExecutionText((failure.outputSnippet ?? failure.output ?? "").trim(), 1800) || null,
      worktreePath: failure.worktreePath ?? fallbackWorktreePath,
      firstErrorLine:
        failure.firstErrorLine?.trim().slice(0, 300) ||
        compactExecutionText((failure.outputSnippet ?? failure.output ?? "").trim(), 300) ||
        null,
      category: failure.category ?? "quality_gate",
      validationWorkspace: failure.validationWorkspace ?? null,
      repairAttempted: failure.autoRepairAttempted ?? false,
      repairSucceeded: failure.autoRepairSucceeded ?? false,
      executable: failure.executable ?? null,
      cwd: failure.cwd ?? null,
      exitCode: failure.exitCode ?? null,
      signal: failure.signal ?? null,
    };
  }

  private applyQualityGateFailure(
    phaseResult: PhaseResult,
    failure: MergeQualityGateFailure,
    fallbackWorktreePath: string
  ): RetryQualityGateDetail {
    const detail = this.toQualityGateDetail(failure, fallbackWorktreePath);
    phaseResult.validationCommand = detail.command ?? null;
    phaseResult.testOutput = failure.outputSnippet ?? failure.output ?? "";
    phaseResult.qualityGateDetail = detail;
    return detail;
  }

  private formatQualityGateFailureReason(
    detail: RetryQualityGateDetail | null | undefined,
    failureType: FailureType
  ): string {
    const command = detail?.command?.trim();
    const reason =
      detail?.reason?.trim() || detail?.firstErrorLine?.trim() || "Pre-merge quality gates failed";
    const firstErrorLine = detail?.firstErrorLine?.trim();
    const prefix =
      failureType === "environment_setup"
        ? getFailureTypeTitle("environment_setup")
        : getFailureTypeTitle("quality_gate");
    const commandPart = command ? ` (${command})` : "";
    const detailPart =
      firstErrorLine && firstErrorLine !== reason
        ? `: ${reason} | ${firstErrorLine}`
        : `: ${reason}`;
    return compactExecutionText(`${prefix}${commandPart}${detailPart}`, 500);
  }

  private isPendingValidationFragment(text: string): boolean {
    const normalized = text.toLowerCase();
    const mentionsPending = normalized.includes("pending");
    const mentionsOrchestrator = normalized.includes("orchestrator");
    const mentionsValidation =
      normalized.includes("validation") ||
      normalized.includes("test status") ||
      normalized.includes("orchestrator-test-status");
    const mentionsStatusFile = normalized.includes("orchestrator-test-status.md");
    if (
      !(mentionsPending && ((mentionsOrchestrator && mentionsValidation) || mentionsStatusFile))
    ) {
      return false;
    }

    // Do not treat concrete code findings as pending-only.
    return !/\bpackages\/|\.tsx?\b|\.jsx?\b|line\s+\d+/i.test(text);
  }

  private isPendingValidationOnlyRejection(result: ReviewAgentResult): boolean {
    const summary = result.summary?.trim() ?? "";
    const notes = result.notes?.trim() ?? "";
    const issues = (result.issues ?? []).map((issue) => issue.trim()).filter(Boolean);
    const fragments = [summary, ...issues, notes].filter(Boolean);
    if (fragments.length === 0) return false;

    const hasPendingMention = fragments.some((fragment) =>
      this.isPendingValidationFragment(fragment)
    );
    if (!hasPendingMention) return false;

    if (summary && !this.isPendingValidationFragment(summary)) return false;
    if (issues.some((issue) => !this.isPendingValidationFragment(issue))) return false;

    return true;
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
    const baseBranch = await resolveBaseBranch(repoPath, settings.worktreeBaseBranch);
    const mergeQualityGates = getMergeQualityGateCommands();
    await this.writeReviewTestStatus(task.id, repoPath, wtPath, {
      status: "pending",
      testCommand,
      mergeQualityGates,
    });
    const coordinator = this.createReviewPhaseCoordinator(
      projectId,
      repoPath,
      task,
      branchName,
      settings
    );
    slot.phaseCoordinator = coordinator;

    this.runAdaptiveValidation(projectId, wtPath, changedFiles, testCommand)
      .then(async (scopedResult) => {
        const sl = this.getState(projectId).slots.get(task.id);
        if (!sl) {
          await this.writeReviewTestStatus(task.id, repoPath, wtPath, {
            status: "error",
            testCommand,
            mergeQualityGates,
            errorMessage: "Slot removed during tests",
          });
          void coordinator.setTestOutcome({
            status: "error",
            errorMessage: "Slot removed during tests",
          });
          return;
        }
        sl.phaseResult.testOutput = scopedResult.rawOutput;
        sl.phaseResult.validationCommand = scopedResult.executedCommand ?? testCommand ?? null;
        this.clearQualityGateDetail(sl.phaseResult);
        if (scopedResult.failed > 0) {
          const validationCommand = scopedResult.executedCommand ?? testCommand;
          await this.writeReviewTestStatus(task.id, repoPath, wtPath, {
            status: "failed",
            testCommand: validationCommand,
            mergeQualityGates,
            results: scopedResult,
            rawOutput: scopedResult.rawOutput,
          });
          void coordinator.setTestOutcome({
            status: "failed",
            results: scopedResult,
            rawOutput: scopedResult.rawOutput,
          });
        } else {
          sl.phaseResult.testResults = scopedResult;
          await this.branchManager.commitWip(wtPath, task.id);
          const qualityGateFailure = await this.runMergeQualityGates({
            projectId,
            repoPath,
            worktreePath: wtPath,
            taskId: task.id,
            branchName,
            baseBranch,
            validationWorkspace: "task_worktree",
          });
          if (qualityGateFailure) {
            const detail = this.applyQualityGateFailure(sl.phaseResult, qualityGateFailure, wtPath);
            await this.writeReviewTestStatus(task.id, repoPath, wtPath, {
              status: "failed",
              testCommand: qualityGateFailure.command,
              mergeQualityGates,
              rawOutput: qualityGateFailure.outputSnippet ?? qualityGateFailure.output,
              failureType:
                qualityGateFailure.category === "environment_setup"
                  ? "environment_setup"
                  : "merge_quality_gate",
              qualityGateDetail: detail,
            });
            void coordinator.setTestOutcome({
              status: "failed",
              failureType:
                qualityGateFailure.category === "environment_setup"
                  ? "environment_setup"
                  : "merge_quality_gate",
              rawOutput: qualityGateFailure.outputSnippet ?? qualityGateFailure.output,
              qualityGateDetail: detail,
            });
            return;
          }
          const validationCommand = scopedResult.executedCommand ?? testCommand;
          await this.writeReviewTestStatus(task.id, repoPath, wtPath, {
            status: "passed",
            testCommand: validationCommand,
            mergeQualityGates,
            results: scopedResult,
          });
          void coordinator.setTestOutcome({ status: "passed", results: scopedResult });
        }
      })
      .catch((err) => {
        log.error("Background tests failed for task", { taskId: task.id, err });
        void this.writeReviewTestStatus(task.id, repoPath, wtPath, {
          status: "error",
          testCommand,
          mergeQualityGates,
          errorMessage: String(err),
        });
        void coordinator.setTestOutcome({ status: "error", errorMessage: String(err) });
      });
  }

  private createReviewPhaseCoordinator(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    settings: import("@opensprint/shared").ProjectSettings
  ): TaskPhaseCoordinator {
    const angles = (settings.reviewAngles ?? []).filter(Boolean);
    return new TaskPhaseCoordinator(
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
        includeGeneralReview: settings.includeGeneralReview === true ? true : undefined,
        ...(angles.length > 1 &&
          !settings.includeGeneralReview && {
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
  }

  private async writeReviewTestStatus(
    taskId: string,
    repoPath: string,
    wtPath: string,
    status: PersistedOrchestratorTestStatus
  ): Promise<void> {
    const persistedStatus = {
      ...status,
      updatedAt: status.updatedAt ?? new Date().toISOString(),
    } satisfies PersistedOrchestratorTestStatus;
    const bases = new Set([repoPath, wtPath]);
    await Promise.all(
      [...bases].map(async (basePath) => {
        const statusPath = getOrchestratorTestStatusFsPath(basePath, taskId);
        const statePath = getOrchestratorTestStatusStateFsPath(basePath, taskId);
        await fs.mkdir(path.dirname(statusPath), { recursive: true });
        await Promise.all([
          fs.writeFile(statusPath, buildOrchestratorTestStatusContent(persistedStatus), "utf-8"),
          fs.writeFile(statePath, JSON.stringify(persistedStatus, null, 2), "utf-8"),
        ]);
      })
    );
  }

  private async readPersistedReviewTestStatus(
    taskId: string,
    repoPath: string,
    wtPath: string
  ): Promise<PersistedOrchestratorTestStatus | null> {
    const bases = [wtPath, repoPath];
    for (const basePath of bases) {
      try {
        const raw = await fs.readFile(
          getOrchestratorTestStatusStateFsPath(basePath, taskId),
          "utf-8"
        );
        const parsed = JSON.parse(raw) as PersistedOrchestratorTestStatus;
        if (parsed?.status && parsed.status !== "pending") {
          return parsed;
        }
      } catch {
        // Fall back to the legacy markdown-only status file.
      }

      try {
        const raw = await fs.readFile(getOrchestratorTestStatusFsPath(basePath, taskId), "utf-8");
        const parsed = parseOrchestratorTestStatusContent(raw);
        if (parsed?.status && parsed.status !== "pending") {
          return parsed;
        }
      } catch {
        // Ignore missing status files during recovery.
      }
    }
    return null;
  }

  private toRecoveredTestOutcome(status: PersistedOrchestratorTestStatus): TestOutcome | null {
    switch (status.status) {
      case "pending":
        return null;
      case "passed":
        return {
          status: "passed",
          ...(status.results ? { results: status.results } : {}),
        };
      case "failed":
        return {
          status: "failed",
          ...(status.results ? { results: status.results } : {}),
          ...(status.rawOutput ? { rawOutput: status.rawOutput } : {}),
          ...(status.failureType ? { failureType: status.failureType } : {}),
          ...(status.qualityGateDetail ? { qualityGateDetail: status.qualityGateDetail } : {}),
        };
      case "error":
        return {
          status: "error",
          ...(status.errorMessage ? { errorMessage: status.errorMessage } : {}),
          ...(status.rawOutput ? { rawOutput: status.rawOutput } : {}),
          ...(status.failureType ? { failureType: status.failureType } : {}),
          ...(status.qualityGateDetail ? { qualityGateDetail: status.qualityGateDetail } : {}),
        };
    }
  }

  private applyRecoveredTestOutcome(
    phaseResult: PhaseResult,
    outcome: TestOutcome,
    status: PersistedOrchestratorTestStatus
  ): void {
    phaseResult.validationCommand = status.testCommand ?? null;
    phaseResult.testResults = null;
    if (outcome.status === "passed") {
      phaseResult.testResults = outcome.results ?? null;
      phaseResult.testOutput = "";
      this.clearQualityGateDetail(phaseResult);
      return;
    }

    phaseResult.testOutput = outcome.rawOutput ?? outcome.errorMessage ?? "";
    if (outcome.status === "failed") {
      phaseResult.testResults = outcome.results ?? null;
    }
    phaseResult.qualityGateDetail = outcome.qualityGateDetail ?? null;
  }

  private async executeReviewPhase(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    retryContext?: RetryContext,
    reviewTarget?: ReviewRetryTarget
  ): Promise<void> {
    return this.phaseExecutor.executeReviewPhase(
      projectId,
      repoPath,
      task,
      branchName,
      retryContext,
      reviewTarget
    );
  }

  private getAssignmentPath(wtPath: string, taskId: string, angle?: ReviewAngle): string {
    return angle
      ? path.join(
          wtPath,
          OPENSPRINT_PATHS.active,
          taskId,
          "review-angles",
          angle,
          OPENSPRINT_PATHS.assignment
        )
      : path.join(wtPath, OPENSPRINT_PATHS.active, taskId, OPENSPRINT_PATHS.assignment);
  }

  private async readAssignmentForRun(
    wtPath: string,
    taskId: string,
    angle?: ReviewAngle
  ): Promise<TaskAssignmentLike | null> {
    try {
      const raw = await fs.readFile(this.getAssignmentPath(wtPath, taskId, angle), "utf-8");
      return JSON.parse(raw) as TaskAssignmentLike;
    } catch {
      return null;
    }
  }

  private async readCodingResultWithRaw(
    wtPath: string,
    taskId: string
  ): Promise<{ raw: string | null; result: CodingAgentResult | null }> {
    const raw = await this.sessionManager.readRawResult(wtPath, taskId);
    return {
      raw,
      result: parseCodingAgentResult(raw),
    };
  }

  private async readReviewResult(
    wtPath: string,
    taskId: string,
    angle?: ReviewAngle
  ): Promise<ReviewAgentResult | null> {
    const { result } = await this.readReviewResultWithRaw(wtPath, taskId, angle);
    return result;
  }

  private async readReviewResultWithRaw(
    wtPath: string,
    taskId: string,
    angle?: ReviewAngle
  ): Promise<{ raw: string | null; result: ReviewAgentResult | null }> {
    const raw = await this.sessionManager.readRawResult(wtPath, taskId, angle);
    return {
      raw,
      result: parseReviewAgentResult(raw),
    };
  }

  private async retryCodingStructuredOutputRepair(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    slot: AgentSlot,
    rawResult: string | null
  ): Promise<boolean> {
    const wtPath = slot.worktreePath ?? repoPath;
    const assignment = await this.readAssignmentForRun(wtPath, task.id);
    if (assignment?.retryContext?.structuredOutputRepairAttempted) {
      return false;
    }

    const retryContext: RetryContext = {
      ...(assignment?.retryContext ?? slot.retryContext ?? {}),
      previousFailure: describeStructuredOutputProblem({
        fileLabel: `.opensprint/active/${task.id}/result.json`,
        rawContent: rawResult,
        expectedShape: CODING_RESULT_EXPECTED_SHAPE,
      }),
      useExistingBranch: true,
      structuredOutputRepairAttempted: true,
    };

    log.warn("Retrying coder once to repair structured output", {
      projectId,
      taskId: task.id,
      branchName: slot.branchName,
    });

    await this.executeCodingPhase(projectId, repoPath, task, slot, retryContext);
    return true;
  }

  private async retryReviewStructuredOutputRepair(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    slot: AgentSlot,
    rawResult: string | null,
    angle?: ReviewAngle
  ): Promise<boolean> {
    const wtPath = slot.worktreePath ?? repoPath;
    const assignment = await this.readAssignmentForRun(wtPath, task.id, angle);
    if (assignment?.retryContext?.structuredOutputRepairAttempted) {
      return false;
    }

    const retryContext: RetryContext = {
      ...(assignment?.retryContext ?? {}),
      previousFailure: describeStructuredOutputProblem({
        fileLabel: angle
          ? `.opensprint/active/${task.id}/review-angles/${angle}/result.json`
          : `.opensprint/active/${task.id}/result.json`,
        rawContent: rawResult,
        expectedShape: REVIEW_RESULT_EXPECTED_SHAPE,
      }),
      useExistingBranch: true,
      structuredOutputRepairAttempted: true,
    };

    log.warn("Retrying reviewer once to repair structured output", {
      projectId,
      taskId: task.id,
      branchName: slot.branchName,
      angle: angle ?? "general",
    });

    await this.executeReviewPhase(
      projectId,
      repoPath,
      task,
      slot.branchName,
      retryContext,
      angle ?? "general"
    );
    return true;
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
    const { raw: rawResult, result } = await this.readReviewResultWithRaw(wtPath, task.id, angle);

    if (!result) {
      const retried = await this.retryReviewStructuredOutputRepair(
        projectId,
        repoPath,
        task,
        slot,
        rawResult,
        angle
      );
      if (retried) {
        return;
      }
    }

    const reviewAgentState = angle ? slot.reviewAgents?.get(angle) : undefined;
    const killedDueToTimeout =
      reviewAgentState?.agent.killedDueToTimeout ?? slot.agent.killedDueToTimeout;
    const status: ReviewOutcome["status"] =
      result?.status === "approved"
        ? "approved"
        : result?.status === "rejected"
          ? "rejected"
          : "no_result";
    const noResultReason =
      status === "no_result"
        ? await extractNoResultReasonFromLogs(
            wtPath,
            task.id,
            angle ? (reviewAgentState?.agent.outputLog ?? []) : slot.agent.outputLog,
            angle
          )
        : undefined;

    // If coordinated with tests, report outcome and let the coordinator decide
    if (slot.phaseCoordinator) {
      if (status === "approved") {
        const runAgent = reviewAgentState?.agent ?? slot.agent;
        const settings = await this.projectService.getSettings(projectId);
        const agentConfig = settings.simpleComplexityAgent;
        agentIdentityService
          .recordAttempt(repoPath, {
            taskId: task.id,
            agentId: `${agentConfig.type}-${agentConfig.model ?? "default"}`,
            role: "reviewer",
            model: agentConfig.model ?? "unknown",
            attempt: slot.attempt,
            startedAt: runAgent.startedAt ?? new Date().toISOString(),
            completedAt: new Date().toISOString(),
            outcome: "success",
            durationMs: Math.max(
              0,
              Date.now() - new Date(runAgent.startedAt ?? Date.now()).getTime()
            ),
          })
          .catch((err) =>
            log.warn("Failed to record reviewer run for Agent Log (coordinated approved)", { err })
          );
      }
      await slot.phaseCoordinator.setReviewOutcome(
        {
          status,
          result,
          exitCode,
          ...(status === "no_result" && {
            failureContext: [
              {
                ...(angle && { angle }),
                exitCode,
                ...(noResultReason && { reason: noResultReason }),
              },
            ],
          }),
        },
        angle
      );
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
      const settings = await this.projectService.getSettings(projectId);
      const agentConfig = settings.simpleComplexityAgent;
      agentIdentityService
        .recordAttempt(repoPath, {
          taskId: task.id,
          agentId: `${agentConfig.type}-${agentConfig.model ?? "default"}`,
          role: "reviewer",
          model: agentConfig.model ?? "unknown",
          attempt: slot.attempt,
          startedAt: slot.agent.startedAt ?? new Date().toISOString(),
          completedAt: new Date().toISOString(),
          outcome: "success",
          durationMs: Math.max(
            0,
            Date.now() - new Date(slot.agent.startedAt ?? Date.now()).getTime()
          ),
        })
        .catch((err) =>
          log.warn("Failed to record reviewer run for Agent Log (approved)", { err })
        );
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
          ? `Review agent (${angle}) exited with code ${exitCode} without producing a valid result${noResultReason ? ` (${noResultReason})` : ""}`
          : `Review agent exited with code ${exitCode} without producing a valid result${noResultReason ? ` (${noResultReason})` : ""}`,
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

    try {
      // Test failure takes priority over review outcome
      if (testOutcome.status === "failed") {
        if (
          testOutcome.failureType === "merge_quality_gate" ||
          testOutcome.failureType === "environment_setup"
        ) {
          if (testOutcome.qualityGateDetail) {
            slot.phaseResult.qualityGateDetail = testOutcome.qualityGateDetail;
          }
          await this.failureHandler.handleTaskFailure(
            projectId,
            repoPath,
            task,
            branchName,
            this.formatQualityGateFailureReason(
              slot.phaseResult.qualityGateDetail ?? testOutcome.qualityGateDetail,
              testOutcome.failureType
            ),
            null,
            testOutcome.failureType
          );
          return;
        }
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
        if (
          testOutcome.failureType === "merge_quality_gate" ||
          testOutcome.failureType === "environment_setup"
        ) {
          if (testOutcome.qualityGateDetail) {
            slot.phaseResult.qualityGateDetail = testOutcome.qualityGateDetail;
          }
          await this.failureHandler.handleTaskFailure(
            projectId,
            repoPath,
            task,
            branchName,
            this.formatQualityGateFailureReason(
              slot.phaseResult.qualityGateDetail ?? testOutcome.qualityGateDetail,
              testOutcome.failureType
            ),
            null,
            testOutcome.failureType
          );
          return;
        }
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
        if (this.isPendingValidationOnlyRejection(reviewOutcome.result!)) {
          log.warn("Ignoring review rejection caused only by pending validation status", {
            projectId,
            taskId: task.id,
          });
          await this.mergeCoordinator.performMergeAndDone(projectId, repoPath, task, branchName);
          return;
        }
        await this.handleReviewRejection(
          projectId,
          repoPath,
          task,
          branchName,
          reviewOutcome.result!
        );
      } else {
        const failureType: FailureType = "no_result";
        const noResultReason = buildReviewNoResultFailureReason(reviewOutcome);
        await this.failureHandler.handleTaskFailure(
          projectId,
          repoPath,
          task,
          branchName,
          noResultReason,
          null,
          failureType
        );
      }
    } catch (err) {
      const reason = `Failed to finalize review/test outcome: ${getErrorMessage(err)}`;
      log.error("resolveTestAndReview failed", {
        projectId,
        taskId: task.id,
        branchName,
        err: getErrorMessage(err),
      });
      await this.failureHandler.handleTaskFailure(
        projectId,
        repoPath,
        task,
        branchName,
        reason,
        null,
        "agent_crash"
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
    const baseSystemPrompt = `You are the Summarizer agent for Open Sprint (PRD §12.3.5). Condense context into a focused summary when it exceeds size thresholds. Produce JSON only. No markdown outside the summary field.`;
    const systemPrompt = `${baseSystemPrompt}\n\n${await getCombinedInstructions(repoPath, "summarizer")}`;
    const summarizerId = `summarizer-${projectId}-${taskId}-${Date.now()}`;

    try {
      const summarizerResponse = await invokeStructuredPlanningAgent({
        projectId,
        role: "summarizer",
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
        contract: {
          parse: (content) =>
            extractJsonFromAgentResponse<{ status: string; summary?: string }>(content, "status"),
          repairPrompt:
            'Return valid JSON only in this shape: {"status":"success","summary":"..."} or {"status":"failed"}',
        },
      });

      const parsed = summarizerResponse.parsed;
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
    reviewAngles?: ReviewAngle[],
    clearGeneralResult: boolean = true
  ): Promise<void> {
    if (wtPath !== repoPath) {
      assertSafeTaskWorktreePath(repoPath, taskId, wtPath);
    }
    await this.branchManager.waitForGitReady(wtPath);
    const repoState = await inspectGitRepoState(repoPath, baseBranch);
    await ensureGitIdentityConfigured(repoPath, { appError: false });
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

    await this.branchManager.checkDependencyIntegrity(repoPath, wtPath);

    if (clearGeneralResult) {
      await this.sessionManager.clearResult(wtPath, taskId);
    }
    if (reviewAngles && reviewAngles.length > 0) {
      for (const angle of reviewAngles) {
        await this.sessionManager.clearResult(wtPath, taskId, angle);
      }
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
    mergeQualityGates?: string[];
  }): Promise<boolean> {
    return agentService.runMergerAgentAndWait(options);
  }

  async runMergeQualityGates(
    options: MergeQualityGateRunOptions
  ): Promise<MergeQualityGateFailure | null> {
    return runMergeQualityGatesShared(options, {
      symlinkNodeModules: this.branchManager.symlinkNodeModules.bind(this.branchManager),
    });
  }
}

/** Shared orchestrator instance for build routes and task list (kanban phase override) */
export const orchestratorService = new OrchestratorService();
