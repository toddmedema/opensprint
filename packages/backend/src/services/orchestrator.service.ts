import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import type {
  GitMergeQueueSnapshot,
  OrchestratorStatus,
  ActiveAgent,
  CodingAgentResult,
  ReviewAgentResult,
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
import { PrdService } from "./prd.service.js";
import { ChatService } from "./chat.service.js";
import { notificationService } from "./notification.service.js";
import { maybeAutoRespond } from "./open-question-autoresolve.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { broadcastAuthoritativeTaskUpdated } from "../task-store-events.js";
import { classifyAgentApiError, getErrorMessage } from "../utils/error-utils.js";
import { extractJsonFromAgentResponse } from "../utils/json-extract.js";
import { assertSafeTaskWorktreePath } from "../utils/path-safety.js";
import { TimerRegistry } from "./timer-registry.js";
import { AgentLifecycleManager, type AgentRunState } from "./agent-lifecycle.js";
import {
  executionOwnershipService,
  projectLeadershipService,
  withoutExecutionFence,
} from "./execution-ownership.service.js";
import { getDeploymentMode } from "./deployment-mode.js";
import { heartbeatService } from "./heartbeat.service.js";
import { FileScopeAnalyzer, type FileScope } from "./file-scope-analyzer.js";
import { TaskScheduler } from "./task-scheduler.js";
import { eventLogService } from "./event-log.service.js";
import { createLogger } from "../utils/logger.js";
import { fireAndForget } from "../utils/fire-and-forget.js";
import { filterAgentOutput } from "../utils/agent-output-filter.js";
import { PhaseExecutorService, type PhaseExecutorHost } from "./phase-executor.service.js";
import { agentIdentityService, buildAgentAttemptId } from "./agent-identity.service.js";
import { FailureHandlerService, type FailureHandlerHost } from "./failure-handler.service.js";
import {
  MergeCoordinatorService,
  type MergeCoordinatorHost,
  type MergeQualityGateFailure,
  type MergeQualityGateRunOptions,
} from "./merge-coordinator.service.js";
import { runMergeQualityGates as runMergeQualityGatesShared } from "./merge-quality-gate-runner.js";
import { runMergeQualityGatesWithArtifact } from "./merge-verification.service.js";
import {
  TaskPhaseCoordinator,
  type TestOutcome,
  type ReviewOutcome,
} from "./task-phase-coordinator.js";
import { validateTransition } from "./task-state-machine.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { AppError } from "../middleware/error-handler.js";
import { isExhausted } from "./api-key-exhausted.service.js";
import { invokeStructuredPlanningAgent } from "./structured-agent-output.service.js";
import {
  ensureGitIdentityConfigured,
  ensureBaseBranchExists,
  inspectGitRepoState,
  RepoPreflightError,
  resolveBaseBranch,
} from "../utils/git-repo-state.js";
import { type PersistedOrchestratorTestStatus } from "./orchestrator-test-status.js";
import {
  isSelfImprovementRunInProgress,
  getSelfImprovementRunMode,
} from "./self-improvement-runner.service.js";
import { gitCommitQueue } from "./git-commit-queue.service.js";
import {
  OrchestratorStatusService,
  buildReviewAgentId,
  REVIEW_ANGLE_ACTIVE_LABELS,
  type StateForStatus,
  type OrchestratorCounters,
} from "./orchestrator-status.service.js";
import { OrchestratorLoopService, type OrchestratorLoopHost } from "./orchestrator-loop.service.js";
import {
  buildOrchestratorRecoveryHost,
  type OrchestratorRecoveryHost,
} from "./orchestrator-recovery.service.js";
import {
  OrchestratorDispatchService,
  type OrchestratorDispatchHost,
} from "./orchestrator-dispatch.service.js";
import {
  OrchestratorReviewService,
  type OrchestratorReviewHost,
} from "./orchestrator-review.service.js";
import {
  extractNoResultReasonFromLogs,
  synthesizeCodingResultFromOutput,
  classifyNoResultReasonCode,
} from "./no-result-reason.service.js";
import {
  DEFAULT_WORKTREE_CHECKOUT_USABILITY_CACHE_TTL_MS,
  WorktreeCheckoutUsabilityCache,
  guppWorktreeUsabilityAttemptId,
  isWorktreeCheckoutUsable,
  preflightWorktreeForDiff,
} from "../utils/worktree-health.js";
import {
  describeStructuredOutputProblem,
  parseCodingAgentResult,
  parseReviewAgentResult,
} from "./agent-result-validation.js";
import {
  applyQualityGateFailureToPhaseResult,
  clearQualityGateDetailOnPhase,
  ensureTaskWorktreeRebasedForMergeGates,
  formatOrchestratorQualityGateFailureReason,
  runTaskWorktreeMergeGatesMaybeDeduped,
} from "./orchestrator-task-worktree-quality-gates.js";

const log = createLogger("orchestrator");

import type {
  FailureType,
  ReviewRetryTarget,
  RetryContext,
  RetryQualityGateDetail,
  TaskAssignmentLike,
} from "./orchestrator-phase-context.js";
import type { PhaseResult } from "./orchestrator-phase-context.js";

/** Loop kicker interval: 60s — restarts idle orchestrator loop (distinct from 5-min WatchdogService health patrol). */
const LOOP_KICKER_INTERVAL_MS = 60 * 1000;
const ORCHESTRATOR_LEASE_RENEW_MS = 15 * 1000;
const ORCHESTRATOR_LEASE_DISABLED =
  process.env.NODE_ENV === "test" ||
  (getDeploymentMode() === "trusted-local" &&
    process.env.OPENSPRINT_DISABLE_ORCHESTRATOR_LEASE === "1");
const CODING_RESULT_EXPECTED_SHAPE =
  'a JSON object like {"status":"success","summary":"..."} or {"status":"failed","summary":"...","open_questions":[{"id":"q1","text":"..."}]}';

/** Auto-block a task after this many consecutive "success" results with an empty diff. */
const MAX_CONSECUTIVE_EMPTY_DIFFS = 2;
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

export { formatReviewFeedback, type PhaseResult } from "./orchestrator-phase-context.js";

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
  /** Unique ID for this attempt, used for cross-event correlation in diagnostics. */
  attemptId: string;
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
  /** Agent config used for this active attempt; keeps start/end attempt stats aligned. */
  activeAgentConfig?: AgentConfig;
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
  private readonly worktreeCheckoutUsabilityCache = new WorktreeCheckoutUsabilityCache(
    DEFAULT_WORKTREE_CHECKOUT_USABILITY_CACHE_TTL_MS
  );
  /** @internal */ taskStore = taskStoreSingleton;
  private _projectService: ProjectService | null = null;
  /** @internal */ branchManager = new BranchManager();
  private _contextAssembler: ContextAssembler | null = null;
  private _sessionManager: SessionManager | null = null;
  /** @internal */ get sessionManager(): SessionManager {
    const sm = this._sessionManager;
    if (!sm) throw new Error("OrchestratorService: sessionManager not injected");
    return sm;
  }
  /** Injected by composition root so a single SessionManager is shared. */
  setSessionManager(sm: SessionManager): void {
    this._sessionManager = sm;
  }
  /** @internal */ testRunner = new TestRunner();
  private _feedbackService: FeedbackService | null = null;
  private _prdService: PrdService | null = null;
  private _chatService: ChatService | null = null;
  /** @internal */ lifecycleManager = new AgentLifecycleManager();
  /** @internal */ fileScopeAnalyzer = new FileScopeAnalyzer();
  private taskScheduler = new TaskScheduler(this.taskStore);
  /** Cached repoPath per project (avoids async lookup in synchronous transition()) */
  private repoPathCache = new Map<string, string>();
  /** Cached effective maxSlots per project (branches mode forces 1; avoids async lookup in nudge()) */
  private maxSlotsCache = new Map<string, number>();
  /** @internal */ failureHandler = new FailureHandlerService(this);
  /** @internal */ mergeCoordinator = new MergeCoordinatorService(this);
  private reviewService = new OrchestratorReviewService(this);
  private _statusService: OrchestratorStatusService | null = null;
  private get statusService(): OrchestratorStatusService {
    if (!this._statusService)
      this._statusService = new OrchestratorStatusService(this.taskStore, this.projectService);
    return this._statusService;
  }
  private loopService = new OrchestratorLoopService(this);
  private dispatchService = new OrchestratorDispatchService(this);
  private leaderByProject = new Map<string, boolean>();

  /** @internal */ get projectService(): ProjectService {
    if (!this._projectService) this._projectService = new ProjectService();
    return this._projectService;
  }
  /** @internal */ get contextAssembler(): ContextAssembler {
    if (!this._contextAssembler) this._contextAssembler = new ContextAssembler();
    return this._contextAssembler;
  }
  /** @internal */ get feedbackService(): FeedbackService {
    if (!this._feedbackService) this._feedbackService = new FeedbackService();
    return this._feedbackService;
  }
  private get prdService(): PrdService {
    if (!this._prdService) this._prdService = new PrdService();
    return this._prdService;
  }
  private get chatService(): ChatService {
    if (!this._chatService) this._chatService = new ChatService();
    return this._chatService;
  }

  /** @internal */ phaseExecutor = new PhaseExecutorService(this, {
    handleCodingDone: (a, b, c, d, e) => this.handleCodingDone(a, b, c, d, e),
    handleReviewDone: (a, b, c, d, e, f) => this.handleReviewDone(a, b, c, d, e, f),
    handleTaskFailure: (a, b, c, d, e, f, g, h) =>
      this.failureHandler.handleTaskFailure(a, b, c, d, e, f, g as FailureType | undefined, h),
    handleApiKeysExhausted: (a, b, c, d, provider) =>
      this.handleApiKeysExhausted(a, b, c, d, provider),
  });

  /** @internal */ getState(projectId: string): OrchestratorState {
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
      dispatchBlockers: null,
    };
  }

  private async tryAcquireOrRenewLease(projectId: string): Promise<boolean> {
    if (ORCHESTRATOR_LEASE_DISABLED) {
      this.leaderByProject.set(projectId, true);
      return true;
    }
    const acquired = await projectLeadershipService.acquireOrRenew(projectId);
    this.leaderByProject.set(projectId, acquired);
    if (!acquired) {
      const state = this.state.get(projectId);
      if (state) {
        state.loopRunId++;
        state.loopActive = false;
        state.status.dispatchPausedReason = "another_orchestrator_instance";
      }
    }
    return acquired;
  }

  /** Create a new AgentSlot for a task (optionally with assignee for recovery). */
  /** @internal */ createSlot(
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
        activeToolCallStartedAtMs: new Map<string, number>(),
        startedAt: new Date().toISOString(),
        firstOutputAtIso: undefined,
        exitHandled: false,
        killedDueToTimeout: false,
        lifecycleState: "running",
        suspendedAtIso: undefined,
        suspendReason: undefined,
        suspendDeadlineMs: undefined,
      },
      phase: "coding",
      attempt,
      attemptId: crypto.randomUUID(),
      phaseResult: {
        codingDiff: "",
        codingSummary: "",
        testResults: null,
        testOutput: "",
        validationCommand: null,
        qualityGateDetail: null,
        mergeGateArtifactTaskWorktree: null,
      },
      infraRetries: 0,
      timers: new TimerRegistry(),
      ...(assignee != null && { assignee }),
    };
  }

  /** Build activeTasks array from current slots for status/broadcast */
  /** @internal */ buildActiveTasks(state: OrchestratorState): OrchestratorStatus["activeTasks"] {
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
      baselineRemediationStatus: state.status.baselineRemediationStatus ?? null,
      mergeValidationStatus: state.status.mergeValidationStatus ?? "healthy",
      mergeValidationFailureSummary: state.status.mergeValidationFailureSummary ?? null,
      dispatchPausedReason: state.status.dispatchPausedReason ?? null,
      dispatchBlockers: state.status.dispatchBlockers ?? null,
      ...(overrides?.pendingFeedbackCategorizations && {
        pendingFeedbackCategorizations: overrides.pendingFeedbackCategorizations,
      }),
      selfImprovementRunInProgress: isSelfImprovementRunInProgress(projectId),
      selfImprovementRunMode: getSelfImprovementRunMode(projectId),
      gitMergeQueue: this.getGitMergeQueueSnapshot(projectId),
    };
  }

  /**
   * Centralized state transition with logging and broadcasting.
   * Validates the transition before mutating any state — invalid transitions
   * are logged and skipped to prevent counter/slot drift.
   */
  /** @internal */ transition(projectId: string, t: TransitionTarget): void {
    const state = this.getState(projectId);
    const existingSlot = state.slots.get(t.taskId);
    const currentPhase = existingSlot?.phase ?? "idle";
    if (!validateTransition(t.taskId, currentPhase, t.to)) {
      log.error("Blocked invalid state transition — no state mutation applied", {
        projectId,
        taskId: t.taskId,
        from: currentPhase,
        to: t.to,
      });
      return;
    }

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
    log.info("Task state transition", { projectId, taskId: t.taskId, to: t.to });

    const repoPath = this.repoPathCache.get(projectId);
    if (repoPath) {
      fireAndForget(
        eventLogService.append(repoPath, {
          timestamp: new Date().toISOString(),
          projectId,
          taskId: t.taskId,
          event: `transition.${t.to}`,
          data: { attempt: activeTask?.attempt },
        }),
        "orchestrator:task-stop-event-log"
      );
    }
  }

  private killProcessIfActive(agent: AgentRunState): void {
    if (
      agent.activeProcess?.ownership === "recovered_unverified" ||
      agent.runner?.observe().state === "uncertain"
    ) {
      agent.runner?.markUncertain();
      return;
    }
    agent.cancelled = true;
    if (agent.runner) {
      try {
        agent.runner.cancel();
      } catch {
        // The runner retains stop_requested until process exit is observed.
      }
      agent.activeProcess = null;
      return;
    }
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
  /** @internal */ removeSlot(state: OrchestratorState, taskId: string): void {
    const slot = state.slots.get(taskId);
    if (slot) {
      if (
        [
          slot.agent,
          ...(slot.reviewAgents
            ? [...slot.reviewAgents.values()].map((review) => review.agent)
            : []),
        ].some(
          (agent) =>
            agent.activeProcess?.ownership === "recovered_unverified" ||
            agent.runner?.observe().state === "uncertain"
        )
      )
        return;
      slot.timers.clearAll();
      this.killProcessIfActive(slot.agent);
      this.cleanupReviewAgents(slot);
      state.slots.delete(taskId);
      state.summarizerCache.delete(taskId);
    }
    state.status.activeTasks = this.buildActiveTasks(state);
  }

  /**
   * Unified slot finalization: heartbeat + worktree + assignment cleanup, then removeSlot.
   * All non-transition slot removal paths should go through this to keep cleanup consistent.
   */
  private async cleanupAndRemoveSlot(
    projectId: string,
    repoPath: string,
    state: OrchestratorState,
    taskId: string,
    reason: string,
    options?: { broadcast?: boolean }
  ): Promise<void> {
    const slot = state.slots.get(taskId);
    if (!slot) return;

    const agents = [
      slot.agent,
      ...(slot.reviewAgents ? [...slot.reviewAgents.values()].map((review) => review.agent) : []),
    ];
    if (
      agents.some(
        (agent) =>
          agent.activeProcess?.ownership === "recovered_unverified" ||
          agent.runner?.observe().state === "uncertain"
      )
    ) {
      for (const agent of agents)
        if (
          agent.activeProcess?.ownership === "recovered_unverified" ||
          agent.runner?.observe().state === "uncertain"
        )
          agent.runner?.markUncertain();
      log.warn("Unverified recovered execution retained; destructive cleanup rejected", {
        projectId,
        taskId,
        reason,
      });
      return;
    }

    log.info("Finalizing slot", { projectId, taskId, reason, phase: slot.phase });

    // Tear down agent processes before any destructive worktree ops so validators
    // and merge gates never race a half-removed checkout.
    for (const agent of agents) this.killProcessIfActive(agent);
    await Promise.all(agents.map((agent) => agent.runner?.waitForCompletion()));
    slot.timers.clearAll();
    this.cleanupReviewAgents(slot);

    const wtPath = slot.worktreePath ?? repoPath;
    await heartbeatService.deleteHeartbeat(wtPath, taskId).catch((err) => {
      log.warn("heartbeat delete failed", {
        taskId,
        wtPath,
        err: err instanceof Error ? err.message : String(err),
      });
    });

    // Drop assignment before worktree teardown so assignment-based cleanup guards (and recovery scans)
    // do not race with intentional slot finalization.
    await this.deleteAssignmentAt(repoPath, taskId, slot.worktreePath ?? undefined);

    if (slot.worktreePath && slot.worktreePath !== repoPath) {
      const worktreeKey = slot.worktreeKey ?? taskId;
      try {
        await this.branchManager.prepareWorktreeForRemoval(worktreeKey);
        await this.branchManager.removeTaskWorktree(repoPath, worktreeKey, slot.worktreePath);
      } catch {
        // Best effort; worktree may already be gone
      }
    }
    this.removeSlot(state, taskId);

    if (options?.broadcast !== false) {
      broadcastToProject(projectId, this.buildExecuteStatusPayload(projectId, state));
    }
  }

  /** Delete assignment.json for a task (from main repo or from given base path e.g. worktree) */
  /** @internal */ async deleteAssignment(
    repoPath: string,
    taskId: string,
    worktreePath?: string | null
  ): Promise<void> {
    await this.deleteAssignmentAt(repoPath, taskId, worktreePath ?? undefined);
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

  /** @internal */ async persistCounters(projectId: string, repoPath: string): Promise<void> {
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
      baselineRemediationStatus?: OrchestratorStatus["baselineRemediationStatus"];
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
    if (updates.baselineRemediationStatus !== undefined) {
      state.status.baselineRemediationStatus = updates.baselineRemediationStatus;
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
  /** @internal */ async cleanupSlotIfProjectGone(
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
      await this.cleanupAndRemoveSlot(projectId, repoPath, state, taskId, "project_deleted", {
        broadcast: false,
      });
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

    const allIssues = await this.taskStore.listAll(projectId);
    const validIds =
      validTaskIds ?? new Set(allIssues.map((i) => i.id).filter(Boolean) as string[]);
    const statusById = new Map(
      allIssues.map((i) => [i.id, (i.status as string | undefined) ?? "open"])
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
      if (validIds.has(taskId)) {
        const taskStatus = statusById.get(taskId);
        if (taskStatus != null && taskStatus !== "in_progress") {
          log.warn(
            "Task-agent status drift detected: slot active while task status is not in_progress",
            {
              projectId,
              taskId,
              taskStatus,
              slotPhase: slot.phase,
            }
          );
          try {
            await this.taskStore.update(projectId, taskId, {
              status: "in_progress",
              ...(typeof slot.assignee === "string" && slot.assignee.length > 0
                ? { assignee: slot.assignee }
                : {}),
            });
            statusById.set(taskId, "in_progress");
            log.info("Task-agent status drift repaired: task status reset to in_progress", {
              projectId,
              taskId,
              slotPhase: slot.phase,
              repairedAssignee:
                typeof slot.assignee === "string" && slot.assignee.length > 0
                  ? slot.assignee
                  : null,
            });
            void broadcastAuthoritativeTaskUpdated(broadcastToProject, projectId, taskId);
          } catch (err) {
            log.warn("Failed to repair task-agent status drift", {
              projectId,
              taskId,
              slotPhase: slot.phase,
              err,
            });
          }
        }
        continue;
      }
      log.warn("Removing stale slot: task no longer in task store", { projectId, taskId });
      await this.cleanupAndRemoveSlot(projectId, repoPath, state, taskId, "task_removed", {
        broadcast: false,
      });
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
      if (buildReviewAgentId(reviewSlot.taskId, "general") === agentId) {
        if (reviewSlot.agent.runner) reviewSlot.agent.runner.cancel(true);
        else this.killProcessIfActive(reviewSlot.agent);
        return true;
      }
      if (!reviewSlot.reviewAgents || reviewSlot.reviewAgents.size === 0) continue;
      for (const [angle, reviewAgent] of reviewSlot.reviewAgents.entries()) {
        if (buildReviewAgentId(reviewSlot.taskId, angle) !== agentId) continue;
        if (reviewAgent.agent.runner) reviewAgent.agent.runner.cancel(true);
        else this.killProcessIfActive(reviewAgent.agent);
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
    if (!slot) {
      const active = (await executionOwnershipService.observe(projectId)).filter(
        (attempt) => attempt.taskId === taskId && !["stopped", "completed"].includes(attempt.state)
      );
      if (!active.length) return;
      if (active.some((attempt) => attempt.state === "uncertain"))
        throw new AppError(
          409,
          "EXECUTION_STOP_UNCONFIRMED",
          "Execution ownership is uncertain; inspect it before changing the task."
        );
      for (const attempt of active)
        await executionOwnershipService.requestStop(projectId, attempt.attemptId);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const observed = await executionOwnershipService.observe(projectId);
        if (
          active.every((attempt) =>
            observed.some(
              (current) =>
                current.attemptId === attempt.attemptId &&
                current.generation === attempt.generation &&
                ["stopped", "completed"].includes(current.state)
            )
          )
        )
          return;
        if (observed.some((attempt) => attempt.taskId === taskId && attempt.state === "uncertain"))
          break;
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      throw new AppError(
        409,
        "EXECUTION_STOP_UNCONFIRMED",
        "Stop requested; waiting for the owning backend to observe completion."
      );
    }

    log.info("Stopping agent for user-marked-done task", { projectId, taskId });
    const repoPath = await this.projectService.getRepoPath(projectId);
    await this.cleanupAndRemoveSlot(projectId, repoPath, state, taskId, "user_stopped");
    if (state.slots.has(taskId))
      throw new AppError(
        409,
        "EXECUTION_STOP_UNCONFIRMED",
        "Execution ownership is uncertain; the assignment and workspace were retained."
      );
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
      else {
        slot.agent.cancelled = true;
        if (slot.agent.runner?.observe().state === "queued") slot.agent.runner.cancel();
        slot.agent.activeProcess = null;
      }
      if (slot.reviewAgents) {
        for (const reviewAgent of slot.reviewAgents.values()) {
          reviewAgent.timers.clearAll();
          if (!preserveAgents) this.killProcessIfActive(reviewAgent.agent);
          else {
            reviewAgent.agent.cancelled = true;
            if (reviewAgent.agent.runner?.observe().state === "queued")
              reviewAgent.agent.runner.cancel();
            reviewAgent.agent.activeProcess = null;
          }
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

  /** @internal */ onAgentStateChange(projectId: string): () => void {
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

  /** Coalesces repeated {@link isWorktreeCheckoutUsable} checks per assignment within a short TTL. */
  private isWorktreeCheckoutUsableCached(
    repoPath: string,
    worktreePath: string,
    taskId: string,
    attempt: number
  ): Promise<boolean> {
    const attemptId = guppWorktreeUsabilityAttemptId({ taskId, attempt });
    return this.worktreeCheckoutUsabilityCache.getOrEvaluate(
      repoPath,
      worktreePath,
      attemptId,
      () => isWorktreeCheckoutUsable(repoPath, worktreePath)
    );
  }

  private async resumeRecoveredCodingFromTerminalResult(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    assignment: GuppAssignment
  ): Promise<boolean> {
    if (
      assignment.worktreePath !== repoPath &&
      !(await this.isWorktreeCheckoutUsableCached(
        repoPath,
        assignment.worktreePath,
        task.id,
        assignment.attempt
      ))
    ) {
      log.warn(
        "Recovery: assignment worktree is missing checkout files; skipping terminal result",
        {
          taskId: task.id,
          branchName: assignment.branchName,
          worktreePath: assignment.worktreePath,
        }
      );
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
      slot.activeAgentConfig = assignment.agentConfig as AgentConfig;
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

    if (
      assignment.worktreePath !== repoPath &&
      !(await this.isWorktreeCheckoutUsableCached(
        repoPath,
        assignment.worktreePath,
        task.id,
        assignment.attempt
      ))
    ) {
      log.warn("Recovery: review assignment worktree is missing checkout files; skipping", {
        taskId: task.id,
        branchName: assignment.branchName,
        worktreePath: assignment.worktreePath,
      });
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
      slot.activeAgentConfig = assignment.agentConfig as AgentConfig;
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

  /** @internal */ async reattachRecoveredCodingTask(
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
    slot.activeAgentConfig = assignment.agentConfig as AgentConfig;
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

  /** @internal */ async resumeRecoveredReviewPhase(
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

    if (
      assignment.worktreePath !== repoPath &&
      !(await this.isWorktreeCheckoutUsableCached(
        repoPath,
        assignment.worktreePath,
        task.id,
        assignment.attempt
      ))
    ) {
      log.warn("Recovery: review worktree missing checkout files; cannot resume", {
        taskId: task.id,
        branchName: assignment.branchName,
        worktreePath: assignment.worktreePath,
      });
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
    slot.activeAgentConfig = assignment.agentConfig as AgentConfig;
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

    fireAndForget(
      eventLogService.append(repoPath, {
        timestamp: new Date().toISOString(),
        projectId,
        taskId: task.id,
        event: "recovery.review_resumed",
        data: {
          attempt: assignment.attempt,
          mode: handle ? "reattach" : "respawn",
          reviewAngles,
        },
      }),
      "orchestrator:post-merge-event-log"
    );

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
    await this.cleanupAndRemoveSlot(projectId, repoPath, state, taskId, "recovery_cleanup", {
      broadcast: false,
    });
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
    return buildOrchestratorRecoveryHost(this);
  }

  getRecoveryHost(): RecoveryHost {
    return this.buildRecoveryHost();
  }

  async ensureRunning(projectId: string): Promise<OrchestratorStatus> {
    await this.projectService.getProject(projectId);
    const state = this.getState(projectId);
    const repoPath = await this.projectService.getRepoPath(projectId);
    this.repoPathCache.set(projectId, repoPath);

    const ownsLease = await this.tryAcquireOrRenewLease(projectId);
    if (!ownsLease) {
      state.status.dispatchPausedReason = "another_orchestrator_instance";
      if (!state.globalTimers.has("leaseRetry")) {
        state.globalTimers.setInterval(
          "leaseRetry",
          () => {
            void this.tryAcquireOrRenewLease(projectId).then((acquired) => {
              if (!acquired) return;
              const currentState = this.getState(projectId);
              currentState.status.dispatchPausedReason = null;
              currentState.globalTimers.clear("leaseRetry");
              this.nudge(projectId);
            });
          },
          ORCHESTRATOR_LEASE_RENEW_MS
        );
      }
      return state.status;
    }
    state.status.dispatchPausedReason = null;
    state.globalTimers.clear("leaseRetry");
    if (!state.globalTimers.has("leaseRenew")) {
      state.globalTimers.setInterval(
        "leaseRenew",
        () => {
          fireAndForget(this.tryAcquireOrRenewLease(projectId), "orchestrator:lease-renew");
        },
        ORCHESTRATOR_LEASE_RENEW_MS
      );
    }

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
        log.warn("Recovered orphaned/stale task(s) on startup", {
          projectId,
          requeuedCount: recoveryResult.requeued.length,
          taskIds: recoveryResult.requeued,
        });
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
    if (!ORCHESTRATOR_LEASE_DISABLED && !this.leaderByProject.get(projectId)) {
      return;
    }
    const state = this.getState(projectId);

    const maxSlots = this.maxSlotsCache.get(projectId) ?? 1;
    const slotsFull = state.slots.size >= maxSlots;

    if (state.loopActive || state.globalTimers.has("loop")) {
      return;
    }

    if (slotsFull) {
      // Analyst doesn't use a slot; allow loop to run when there's pending feedback
      fireAndForget(
        this.feedbackService.getNextPendingFeedbackId(projectId).then((nextId) => {
          const s = this.getState(projectId);
          if (nextId && !s.loopActive && !s.globalTimers.has("loop")) {
            log.info("Nudge (pending feedback), starting loop for project", { projectId });
            this.startRunLoop(projectId, "nudge-pending-feedback");
          }
        }),
        "orchestrator:phase-transition-event-log"
      );
      return;
    }

    log.info("Nudge received, starting loop for project", { projectId });
    this.startRunLoop(projectId, "nudge");
  }

  async canRunRecoveryForProject(projectId: string): Promise<boolean> {
    if (ORCHESTRATOR_LEASE_DISABLED) return true;
    try {
      return await this.tryAcquireOrRenewLease(projectId);
    } catch (err) {
      log.warn("Failed to evaluate recovery lease ownership", { projectId, err });
      return false;
    }
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
      pendingFeedbackCategorizations,
      selfImprovementRunInProgress: isSelfImprovementRunInProgress(projectId),
      selfImprovementRunMode: getSelfImprovementRunMode(projectId),
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

  getSlottedWorktreeKeys(projectId: string): string[] {
    const state = this.state.get(projectId);
    if (!state) return [];
    const keys = new Set<string>();
    for (const [taskId, slot] of state.slots.entries()) {
      keys.add(slot.worktreeKey ?? taskId);
    }
    return [...keys];
  }

  getSlottedWorktreePaths(projectId: string): string[] {
    const state = this.state.get(projectId);
    if (!state) return [];
    const paths = new Set<string>();
    for (const slot of state.slots.values()) {
      if (slot.worktreePath) paths.add(slot.worktreePath);
    }
    return [...paths];
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

  /** @internal */ async dispatchTask(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    slotQueueDepth: number
  ): Promise<void> {
    if (!ORCHESTRATOR_LEASE_DISABLED) await projectLeadershipService.assertCurrent(projectId);
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

  /** @internal */ async runLoop(projectId: string): Promise<void> {
    return withoutExecutionFence(async () => {
      if (!ORCHESTRATOR_LEASE_DISABLED && !(await this.tryAcquireOrRenewLease(projectId))) return;
      await this.loopService.runLoop(projectId);
    });
  }

  /** @internal */ async executeCodingPhase(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    slot: AgentSlot,
    retryContext?: RetryContext
  ): Promise<void> {
    return this.phaseExecutor.executeCodingPhase(projectId, repoPath, task, slot, retryContext);
  }

  /** @internal */ async performMergeRetry(
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
  /** @internal */ async ensureApiBlockedNotificationsForExhaustedProviders(
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
    await this.cleanupAndRemoveSlot(projectId, repoPath, state, task.id, "api_exhausted");
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
      log.warn("handleCodingDone: no slot found for task", { projectId, taskId: task.id });
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

    const readResultWithRetries = async (): Promise<{
      raw: string | null;
      result: CodingAgentResult | null;
      readFailure: "timeout" | "error" | null;
    }> => {
      return this.readCodingResultWithRetries(wtPath, task.id);
    };

    const { raw: rawResult, result: parsedResult, readFailure } = await readResultWithRetries();
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
      const noResultReasonCode =
        failureType === "no_result"
          ? classifyNoResultReasonCode({
              rawResult,
              readFailure,
              agentOutputHint: noResultReason,
            })
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
        failureType,
        undefined,
        { noResultReasonCode, exitCode }
      );
      return;
    }

    if (result.status === "success") {
      const settings = await this.projectService.getSettings(projectId);
      const assignment = await this.readAssignmentForRun(wtPath, task.id);
      const agentConfig =
        (assignment?.agentConfig as AgentConfig | undefined) ??
        slot.activeAgentConfig ??
        settings.simpleComplexityAgent;
      slot.activeAgentConfig = agentConfig;
      const baseBranch = await resolveBaseBranch(repoPath, settings.worktreeBaseBranch);
      // Guard: verify the worktree still has a usable checkout before measuring diffs.
      // A missing/corrupt worktree would produce an empty diff and incorrectly trigger the
      // empty-diff circuit breaker. Classify this as workspace_invalid instead.
      const worktreePreflight = await preflightWorktreeForDiff(repoPath, wtPath);
      if (!worktreePreflight.usable) {
        log.warn("Worktree invalid at diff-capture time; failing as workspace_invalid", {
          taskId: task.id,
          worktreePath: wtPath,
          failureReason: worktreePreflight.failureReason,
          detail: worktreePreflight.detail,
        });
        fireAndForget(
          eventLogService.append(repoPath, {
            timestamp: new Date().toISOString(),
            projectId,
            taskId: task.id,
            event: "preflight_worktree_invalid",
            data: {
              projectId,
              attempt: slot.attempt,
              branchName,
              worktreePath: wtPath,
              failureReason: worktreePreflight.failureReason,
              detail: worktreePreflight.detail,
            },
          }),
          "orchestrator:coding-result-event-log"
        );
        await this.failureHandler.handleTaskFailure(
          projectId,
          repoPath,
          task,
          branchName,
          `Agent reported success but the task worktree is invalid (${worktreePreflight.failureReason}: ${worktreePreflight.detail}). ` +
            "The workspace was likely cleaned up or corrupted during the run. Blocking for investigation.",
          null,
          "workspace_invalid"
        );
        return;
      }

      // Commit any uncommitted work before measuring the branch diff. `captureBranchDiff` only
      // sees commits (base...branch); without this, success + uncommitted edits looks like an
      // empty diff and trips the consecutive-empty-diff circuit breaker incorrectly.
      await this.branchManager.commitWip(wtPath, task.id);
      slot.phaseResult.codingDiff = await this.branchManager.captureBranchDiff(
        repoPath,
        branchName,
        baseBranch
      );
      slot.phaseResult.codingSummary = result.summary ?? "";
      agentIdentityService
        .recordAttempt(repoPath, {
          taskId: task.id,
          agentId: buildAgentAttemptId(agentConfig, "coder"),
          role: "coder",
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
        .catch((err) => log.warn("Failed to record coder run for Agent Log (success)", { err }));

      const diffIsEmpty = !slot.phaseResult.codingDiff.trim();
      if (diffIsEmpty) {
        const prev = ((task as Record<string, unknown>).consecutiveEmptyDiffs as number) || 0;
        const consecutiveEmptyDiffs = prev + 1;
        if (consecutiveEmptyDiffs >= MAX_CONSECUTIVE_EMPTY_DIFFS) {
          log.warn("Empty-diff circuit breaker: blocking task after consecutive empty diffs", {
            taskId: task.id,
            consecutiveEmptyDiffs,
          });
          fireAndForget(
            eventLogService.append(repoPath, {
              timestamp: new Date().toISOString(),
              projectId,
              taskId: task.id,
              event: "circuit_breaker.empty_diff_blocked",
              data: {
                projectId,
                attempt: slot.attempt,
                branchName,
                consecutiveEmptyDiffs,
                threshold: MAX_CONSECUTIVE_EMPTY_DIFFS,
              },
            }),
            "orchestrator:review-result-event-log"
          );
          await this.failureHandler.handleTaskFailure(
            projectId,
            repoPath,
            task,
            branchName,
            `Agent reported success but produced no code changes on ${consecutiveEmptyDiffs} consecutive attempts. ` +
              "The task likely lacks sufficient context for the agent to act on. Blocking for investigation.",
            null,
            "coding_failure"
          );
          return;
        }
        await this.taskStore.update(projectId, task.id, {
          extra: { consecutiveEmptyDiffs },
        });
      } else {
        const prev = ((task as Record<string, unknown>).consecutiveEmptyDiffs as number) || 0;
        if (prev > 0) {
          await this.taskStore.update(projectId, task.id, {
            extra: { consecutiveEmptyDiffs: 0 },
          });
        }
      }

      const okRebase = await this.ensureTaskWorktreeRebasedForGates(
        projectId,
        repoPath,
        task,
        wtPath,
        baseBranch,
        branchName
      );
      if (!okRebase) return;

      if (settings.enforceMergeGatesOnCodingSuccess !== false) {
        await this.branchManager.commitWip(wtPath, task.id);
        const deletedOnDisk = await this.branchManager.listGitIndexFilesDeletedOnDisk(wtPath);
        if (deletedOnDisk.length > 0) {
          const maxShow = 40;
          const snippet = deletedOnDisk.slice(0, maxShow).join("\n");
          const more =
            deletedOnDisk.length > maxShow
              ? `\n... and ${deletedOnDisk.length - maxShow} more`
              : "";
          const preflightFailure: MergeQualityGateFailure = {
            command: "git_index_deleted_files_preflight",
            reason: `Working tree is missing ${deletedOnDisk.length} tracked file(s) that remain in the git index (restore files or stage deletions before merge gates).`,
            output: `${snippet}${more}`,
            worktreePath: wtPath,
            firstErrorLine: deletedOnDisk[0],
            validationWorkspace: "task_worktree",
            category: "quality_gate",
            classificationConfidence: "high",
            classificationReason: "tracked_files_deleted_on_disk_before_gates",
          };
          const detail = this.applyQualityGateFailure(slot.phaseResult, preflightFailure, wtPath);
          await this.failureHandler.handleTaskFailure(
            projectId,
            repoPath,
            task,
            branchName,
            this.formatQualityGateFailureReason(detail, "merge_quality_gate"),
            null,
            "merge_quality_gate"
          );
          return;
        }
        const { failure: earlyGateFailure, artifact: earlyArtifact } =
          await runMergeQualityGatesWithArtifact(
            (opts) => this.runMergeQualityGates(opts),
            this.branchManager,
            {
              projectId,
              repoPath,
              worktreePath: wtPath,
              taskId: task.id,
              branchName,
              baseBranch,
              validationWorkspace: "task_worktree",
              qualityGateProfile: "deterministic",
              toolchainProfile: settings.toolchainProfile,
            }
          );
        if (earlyGateFailure) {
          const detail = this.applyQualityGateFailure(slot.phaseResult, earlyGateFailure, wtPath);
          await this.failureHandler.handleTaskFailure(
            projectId,
            repoPath,
            task,
            branchName,
            this.formatQualityGateFailureReason(
              detail,
              earlyGateFailure.category === "environment_setup"
                ? "environment_setup"
                : "merge_quality_gate"
            ),
            null,
            earlyGateFailure.category === "environment_setup"
              ? "environment_setup"
              : "merge_quality_gate"
          );
          return;
        }
        if (earlyArtifact) {
          slot.phaseResult.mergeGateArtifactTaskWorktree = earlyArtifact;
        }
      }

      const testCommand = resolveTestCommand(settings) || undefined;
      let changedFiles: string[] = [];
      try {
        changedFiles = await this.branchManager.getChangedFiles(repoPath, branchName, baseBranch);
      } catch {
        // Fall back to full suite
      }

      const reviewMode = settings.reviewMode ?? DEFAULT_REVIEW_MODE;
      const skipReview =
        reviewMode === "never" || (reviewMode === "on-failure-only" && slot.attempt <= 1);

      if (skipReview) {
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
        await this.branchManager.commitWip(wtPath, task.id);
        const qualityGateFailure = await this.runTaskWorktreeMergeGatesMaybeDeduped(
          projectId,
          repoPath,
          task,
          branchName,
          wtPath,
          baseBranch,
          settings.toolchainProfile,
          slot
        );
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
        void maybeAutoRespond(projectId, notification, {
          projectService: this.projectService,
          prdService: this.prdService,
          chatService: this.chatService,
          feedbackService: this.feedbackService,
        });
        const assignment = await this.readAssignmentForRun(wtPath, task.id);
        const settings = await this.projectService.getSettings(projectId);
        const agentConfig =
          (assignment?.agentConfig as AgentConfig | undefined) ??
          slot.activeAgentConfig ??
          settings.simpleComplexityAgent;
        slot.activeAgentConfig = agentConfig;
        agentIdentityService
          .recordAttempt(repoPath, {
            taskId: task.id,
            agentId: buildAgentAttemptId(agentConfig, "coder"),
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
        await this.cleanupAndRemoveSlot(projectId, repoPath, state, task.id, "open_questions");
        await this.persistCounters(projectId, repoPath);
        return;
      }

      const reason = result.summary || `Agent exited with code ${exitCode}`;
      const apiFailureKind = classifyAgentApiError(new Error(reason));
      if (apiFailureKind) {
        await this.failureHandler.handleTaskFailure(
          projectId,
          repoPath,
          task,
          branchName,
          reason,
          null,
          "no_result",
          undefined,
          {
            noResultReasonCode: "agent_provider_usage_limit",
            agentDebugArtifact: result.debugArtifact,
            exitCode,
          }
        );
      } else {
        await this.failureHandler.handleTaskFailure(
          projectId,
          repoPath,
          task,
          branchName,
          reason,
          null,
          "coding_failure",
          undefined,
          { agentDebugArtifact: result.debugArtifact, exitCode }
        );
      }
    }
  }

  /** @internal */ async runAdaptiveValidation(
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
      fireAndForget(
        this.projectService.recordValidationDuration(projectId, preferredScope, durationMs),
        "orchestrator:record-validation-duration"
      );
      throw err;
    }
  }

  /** @internal */ clearQualityGateDetail(phaseResult: PhaseResult): void {
    clearQualityGateDetailOnPhase(phaseResult);
  }

  private async ensureTaskWorktreeRebasedForGates(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    wtPath: string,
    baseBranch: string,
    branchName: string
  ): Promise<boolean> {
    return ensureTaskWorktreeRebasedForMergeGates(
      {
        branchManager: this.branchManager,
        taskStore: this.taskStore,
        projectService: this.projectService,
        failureHandler: this.failureHandler,
        runMergerAgentAndWait: (opts) => this.runMergerAgentAndWait(opts),
      },
      { projectId, repoPath, task, wtPath, baseBranch, branchName }
    );
  }

  /** @internal */ async runTaskWorktreeMergeGatesMaybeDeduped(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    wtPath: string,
    baseBranch: string,
    toolchainProfile: import("@opensprint/shared").ToolchainProfile | undefined,
    slot: AgentSlot
  ): Promise<MergeQualityGateFailure | null> {
    return runTaskWorktreeMergeGatesMaybeDeduped(
      {
        runMergeQualityGates: (opts) => this.runMergeQualityGates(opts),
        branchManager: this.branchManager,
      },
      {
        projectId,
        repoPath,
        task,
        branchName,
        wtPath,
        baseBranch,
        toolchainProfile,
        slot,
      }
    );
  }

  /** @internal */ applyQualityGateFailure(
    phaseResult: PhaseResult,
    failure: MergeQualityGateFailure,
    fallbackWorktreePath: string
  ): RetryQualityGateDetail {
    return applyQualityGateFailureToPhaseResult(phaseResult, failure, fallbackWorktreePath);
  }

  /** @internal */ formatQualityGateFailureReason(
    detail: RetryQualityGateDetail | null | undefined,
    failureType: FailureType
  ): string {
    return formatOrchestratorQualityGateFailureReason(detail, failureType);
  }

  private async clearRateLimitNotifications(projectId: string): Promise<void> {
    return this.reviewService.clearRateLimitNotifications(projectId);
  }

  private async startReviewCoordinatorAndTests(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    settings: import("@opensprint/shared").ProjectSettings,
    changedFiles: string[]
  ): Promise<void> {
    return this.reviewService.startReviewCoordinatorAndTests(
      projectId,
      repoPath,
      task,
      branchName,
      settings,
      changedFiles
    );
  }

  private createReviewPhaseCoordinator(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    settings: import("@opensprint/shared").ProjectSettings
  ): TaskPhaseCoordinator {
    return this.reviewService.createReviewPhaseCoordinator(
      projectId,
      repoPath,
      task,
      branchName,
      settings
    );
  }

  private async writeReviewTestStatus(
    taskId: string,
    repoPath: string,
    wtPath: string,
    status: PersistedOrchestratorTestStatus
  ): Promise<void> {
    return this.reviewService.writeReviewTestStatus(taskId, repoPath, wtPath, status);
  }

  private async readPersistedReviewTestStatus(
    taskId: string,
    repoPath: string,
    wtPath: string
  ): Promise<PersistedOrchestratorTestStatus | null> {
    return this.reviewService.readPersistedReviewTestStatus(taskId, repoPath, wtPath);
  }

  private toRecoveredTestOutcome(status: PersistedOrchestratorTestStatus): TestOutcome | null {
    return this.reviewService.toRecoveredTestOutcome(status);
  }

  private applyRecoveredTestOutcome(
    phaseResult: PhaseResult,
    outcome: TestOutcome,
    status: PersistedOrchestratorTestStatus
  ): void {
    return this.reviewService.applyRecoveredTestOutcome(phaseResult, outcome, status);
  }

  private async executeReviewPhase(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    retryContext?: RetryContext,
    reviewTarget?: ReviewRetryTarget
  ): Promise<void> {
    return this.reviewService.executeReviewPhase(
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

  /** @internal */ async readAssignmentForRun(
    wtPath: string,
    taskId: string,
    angle?: ReviewAngle
  ): Promise<TaskAssignmentLike | null> {
    try {
      const filePath = this.getAssignmentPath(wtPath, taskId, angle);
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (
        typeof parsed.taskId !== "string" ||
        typeof parsed.worktreePath !== "string" ||
        typeof parsed.createdAt !== "string"
      ) {
        log.warn("Invalid assignment JSON: missing required string fields", { filePath });
        return null;
      }
      return parsed as unknown as TaskAssignmentLike;
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

  private async readCodingResultWithRetries(
    wtPath: string,
    taskId: string
  ): Promise<{
    raw: string | null;
    result: CodingAgentResult | null;
    readFailure: "timeout" | "error" | null;
  }> {
    const maxAttempts = 6;
    const perAttemptTimeoutMs = 8_000;
    let lastRaw: string | null = null;
    let stableMalformedReads = 0;
    let lastReadFailure: "timeout" | "error" | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let timeoutHandle: NodeJS.Timeout | null = null;
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error("readResult timeout")),
            perAttemptTimeoutMs
          );
        });
        const value = await Promise.race([
          this.readCodingResultWithRaw(wtPath, taskId),
          timeoutPromise,
        ]);
        if (value.result) {
          return { ...value, readFailure: null };
        }
        if (value.raw != null && value.raw === lastRaw) {
          stableMalformedReads += 1;
        } else {
          stableMalformedReads = value.raw != null ? 1 : 0;
          lastRaw = value.raw;
        }
        if (stableMalformedReads >= 2 && value.raw != null) {
          // Two identical malformed reads likely means write is complete but schema is invalid.
          return { raw: value.raw, result: null, readFailure: null };
        }
      } catch (err) {
        lastReadFailure =
          err instanceof Error && /timeout/i.test(err.message) ? "timeout" : "error";
        log.warn("readResult attempt failed", { taskId, attempt, err, wtPath });
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      }
    }
    return { raw: lastRaw, result: null, readFailure: lastReadFailure };
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
    return { raw, result: parseReviewAgentResult(raw) };
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
    return this.reviewService.retryReviewStructuredOutputRepair(
      projectId,
      repoPath,
      task,
      slot,
      rawResult,
      angle
    );
  }

  private async handleReviewDone(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    exitCode: number | null,
    angle?: ReviewAngle
  ): Promise<void> {
    return this.reviewService.handleReviewDone(
      projectId,
      repoPath,
      task,
      branchName,
      exitCode,
      angle
    );
  }

  private async resolveTestAndReview(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    testOutcome: TestOutcome,
    reviewOutcome: ReviewOutcome
  ): Promise<void> {
    return this.reviewService.resolveTestAndReview(
      projectId,
      repoPath,
      task,
      branchName,
      testOutcome,
      reviewOutcome
    );
  }

  private async handleReviewRejection(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    result: ReviewAgentResult
  ): Promise<void> {
    return this.reviewService.handleReviewRejection(projectId, repoPath, task, branchName, result);
  }

  /** @internal */ async buildReviewHistory(repoPath: string, taskId: string): Promise<string> {
    return this.reviewService.buildReviewHistory(repoPath, taskId);
  }

  // ─── Helpers ───

  getCachedSummarizerContext(projectId: string, taskId: string): TaskContext | undefined {
    return this.getState(projectId).summarizerCache.get(taskId);
  }

  setCachedSummarizerContext(projectId: string, taskId: string, context: TaskContext): void {
    this.getState(projectId).summarizerCache.set(taskId, context);
  }

  /** @internal */ async runSummarizer(
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

  /** @internal */ async preflightCheck(
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
      const gitPreflightCodes: readonly string[] = [
        ErrorCodes.GIT_BASE_BRANCH_INVALID,
        ErrorCodes.GIT_CHECKOUT_CONFLICT,
        ErrorCodes.GIT_REF_MISSING,
      ];
      const code =
        error instanceof AppError && gitPreflightCodes.includes(error.code)
          ? error.code
          : ErrorCodes.GIT_BASE_BRANCH_INVALID;
      throw new RepoPreflightError(error instanceof Error ? error.message : String(error), code);
    }

    if (wtPath === repoPath) {
      await this.branchManager.ensureRepoNodeModules(repoPath);
    } else {
      await this.branchManager.symlinkNodeModules(repoPath, wtPath);
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
    baseBranch?: string;
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

/**
 * Compile-time verification that OrchestratorService satisfies all host
 * interfaces it passes `this` into.  These type-level assertions catch
 * contract drift — adding / removing / renaming a host-expected method
 * will cause a build error here rather than a silent runtime failure.
 */
type _AssertFailureHandlerHost = OrchestratorService extends FailureHandlerHost
  ? true
  : { __err: "OrchestratorService does not satisfy FailureHandlerHost" };
type _AssertMergeCoordinatorHost = OrchestratorService extends MergeCoordinatorHost
  ? true
  : { __err: "OrchestratorService does not satisfy MergeCoordinatorHost" };
type _AssertReviewHost = OrchestratorService extends OrchestratorReviewHost
  ? true
  : { __err: "OrchestratorService does not satisfy OrchestratorReviewHost" };
type _AssertLoopHost = OrchestratorService extends OrchestratorLoopHost
  ? true
  : { __err: "OrchestratorService does not satisfy OrchestratorLoopHost" };
type _AssertDispatchHost = OrchestratorService extends OrchestratorDispatchHost
  ? true
  : { __err: "OrchestratorService does not satisfy OrchestratorDispatchHost" };
type _AssertPhaseHost = OrchestratorService extends PhaseExecutorHost
  ? true
  : { __err: "OrchestratorService does not satisfy PhaseExecutorHost" };
type _AssertRecoveryHost = OrchestratorService extends OrchestratorRecoveryHost
  ? true
  : { __err: "OrchestratorService does not satisfy OrchestratorRecoveryHost" };

/** Shared orchestrator instance for build routes and task list (kanban phase override) */
export const orchestratorService = new OrchestratorService();
