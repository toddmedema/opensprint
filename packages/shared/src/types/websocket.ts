import type {
  AgentPhase,
  AgentRuntimeState,
  AgentSuspendReason,
  BaselineRuntimeStatus,
  GitMergeQueueSnapshot,
  MergeValidationRuntimeStatus,
  TestResults,
} from "./agent.js";
import type { FeedbackItem } from "./feedback.js";
import type {
  ScopeChangeMetadata,
  ScopeChangeProposedUpdate,
  SelfImprovementApprovalPayload,
} from "./notification.js";
import type { KanbanColumn, MergeGateState } from "./task.js";
import type { QualityGateDiagnosticDetail } from "./execute-diagnostics.js";

// ─── Server → Client Events ───

export interface TaskUpdatedEvent {
  type: "task.updated";
  taskId: string;
  /** Project scope; when omitted, client infers from channel. */
  projectId?: string;
  status: string;
  assignee: string | null;
  /** Optional; when present, syncs task priority into task registry and execute state */
  priority?: number;
  /** Reason task was blocked. Set when status is blocked; cleared when unblocked. */
  blockReason?: string | null;
  /** Optional; when present (e.g. plan-task-sync), syncs title into execute state */
  title?: string;
  /** Optional; when present (e.g. plan-task-sync), syncs description into execute state */
  description?: string;
  /** Optional; server-computed kanban column (e.g. waiting_to_merge). */
  kanbanColumn?: KanbanColumn;
  /**
   * Baseline merge pause (ISO string). `null` clears a prior pause on live clients.
   * Omitted for legacy/hand-built events that are not merge-authoritative.
   */
  mergePausedUntil?: string | null;
  /**
   * True while merge is waiting on main. `false` clears a prior wait.
   * Omitted for legacy/hand-built events that are not merge-authoritative.
   */
  mergeWaitingOnMain?: boolean;
  /**
   * Server-derived merge gate state. `null` clears a prior state (e.g. baseline unblocked).
   * Omitted for legacy/hand-built events that are not merge-authoritative.
   */
  mergeGateState?: MergeGateState | null;
}

/** Minimal task payload for create/close events (relevant task data) */
export interface TaskEventPayload {
  id: string;
  title: string;
  description?: string | null;
  issue_type: string;
  status: string;
  priority: number;
  assignee?: string | null;
  labels?: string[];
  created_at: string;
  updated_at: string;
  close_reason?: string | null;
  parentId?: string | null;
  /** Task source (e.g. 'self-improvement'). From tasks.extra.source. */
  source?: string;
  /** Optional; server-computed kanban column (e.g. waiting_to_merge). */
  kanbanColumn?: KanbanColumn;
  /** Baseline merge pause; `null` when not paused. */
  mergePausedUntil?: string | null;
  /** True while waiting on main; `false` when not. */
  mergeWaitingOnMain?: boolean;
  /** Derived merge gate state; `null` when none applies. */
  mergeGateState?: MergeGateState | null;
}

export interface TaskCreatedEvent {
  type: "task.created";
  taskId: string;
  task: TaskEventPayload;
}

export interface TaskClosedEvent {
  type: "task.closed";
  taskId: string;
  task: TaskEventPayload;
}

export interface AgentOutputEvent {
  type: "agent.output";
  taskId: string;
  chunk: string;
}

/** One-off backfill of existing live output when client subscribes (replace, do not append). */
export interface AgentOutputBackfillEvent {
  type: "agent.outputBackfill";
  taskId: string;
  output: string;
}

export interface AgentStartedEvent {
  type: "agent.started";
  taskId: string;
  phase: AgentPhase;
  branchName?: string;
  /** ISO timestamp when the agent started — for computing elapsed time without a separate fetch */
  startedAt?: string;
}

export interface AgentCompletedEvent {
  type: "agent.completed";
  taskId: string;
  status: string;
  testResults: TestResults | null;
  /** User-facing failure reason when status is "failed" */
  reason?: string;
}

export interface AgentActivityEvent {
  type: "agent.activity";
  taskId: string;
  phase: AgentPhase;
  activity: "waiting_on_tool" | "tool_completed" | "suspended" | "resumed";
  summary?: string;
}

export interface PrdUpdatedEvent {
  type: "prd.updated";
  section: string;
  version: number;
}

export interface ExecuteStatusEvent {
  type: "execute.status";
  activeTasks: Array<{
    taskId: string;
    phase: AgentPhase;
    startedAt: string;
    state: AgentRuntimeState;
    lastOutputAt?: string;
    suspendedAt?: string;
    suspendReason?: AgentSuspendReason;
    /** Per-agent ID when multi-angle review (e.g. taskId--review--security). */
    id?: string;
    /** Display name when multi-angle review (e.g. "Reviewer (Security)"). */
    name?: string;
  }>;
  queueDepth: number;
  baselineStatus?: BaselineRuntimeStatus;
  baselineCheckedAt?: string | null;
  baselineFailureSummary?: string | null;
  mergeValidationStatus?: MergeValidationRuntimeStatus;
  mergeValidationFailureSummary?: string | null;
  dispatchPausedReason?: string | null;
  /** True when orchestrator is paused waiting for HIL approval (PRD §6.5) */
  awaitingApproval?: boolean;
  /** Path to active task's git worktree (PRDv2 §5.8) */
  worktreePath?: string | null;
  /** Feedback items awaiting categorization */
  pendingFeedbackCategorizations?: Array<{ feedbackId: string; category?: string }>;
  /** True when a self-improvement run is in progress for this project */
  selfImprovementRunInProgress?: boolean;
  /** Serialized git worktree_merge queue for this project's repo (FIFO). */
  gitMergeQueue?: GitMergeQueueSnapshot;
}

export interface HilRequestEvent {
  type: "hil.request";
  requestId: string;
  category: string;
  description: string;
  options: HilOption[];
  /** True = blocking modal (requires_approval); false = dismissible notification (notify_and_proceed) */
  blocking?: boolean;
  /** AI-generated summary of proposed PRD changes (scopeChanges category only) */
  scopeChangeSummary?: string;
  /** Proposed PRD section updates with change descriptions (scopeChanges category only) */
  scopeChangeProposedUpdates?: ScopeChangeProposedUpdate[];
}

export interface HilOption {
  id: string;
  label: string;
  description: string;
}

export interface FeedbackMappedEvent {
  type: "feedback.mapped";
  feedbackId: string;
  planId: string;
  taskIds: string[];
  /** Full updated item so the frontend can update in place without refetching the list */
  item: FeedbackItem;
}

/** Alias for feedback.mapped — emitted when categorization completes. Frontend patches only the matching card. */
export interface FeedbackUpdatedEvent {
  type: "feedback.updated";
  feedbackId: string;
  planId: string;
  taskIds: string[];
  /** Full updated item so the frontend can update in place without refetching the list */
  item: FeedbackItem;
}

export interface FeedbackResolvedEvent {
  type: "feedback.resolved";
  feedbackId: string;
  /** Full updated item so the frontend can update in place without refetching the list */
  item: FeedbackItem;
}

/** Emitted when an agent emits open questions or API-blocked notification */
export interface NotificationAddedEvent {
  type: "notification.added";
  notification: {
    id: string;
    projectId: string;
    source: "plan" | "prd" | "execute" | "eval" | "self-improvement";
    sourceId: string;
    questions: Array<{ id: string; text: string; createdAt?: string }>;
    status: "open" | "resolved";
    createdAt: string;
    resolvedAt: string | null;
    kind?:
      | "open_question"
      | "api_blocked"
      | "hil_approval"
      | "agent_failed"
      | "self_improvement_approval";
    errorCode?: "rate_limit" | "auth" | "out_of_credit" | "scope_compliance";
    scopeChangeMetadata?: ScopeChangeMetadata | SelfImprovementApprovalPayload;
  };
}

/** Emitted when a notification is resolved (user answered or dismissed) */
export interface NotificationResolvedEvent {
  type: "notification.resolved";
  notificationId: string;
  projectId: string;
  source: "plan" | "prd" | "execute" | "eval" | "self-improvement";
  sourceId: string;
}

export interface PlanUpdatedEvent {
  type: "plan.updated";
  planId: string;
}

export interface PlanGeneratedEvent {
  type: "plan.generated";
  planId: string;
}

/** Streaming output from plan-scoped agents (e.g. Auditor during Re-execute). */
export interface PlanAgentOutputEvent {
  type: "plan.agent.output";
  planId: string;
  chunk: string;
}

/** One-off backfill of existing Auditor output when client subscribes. */
export interface PlanAgentOutputBackfillEvent {
  type: "plan.agent.outputBackfill";
  planId: string;
  output: string;
}

/** Emitted when a task is blocked after progressive backoff exhaustion (PRDv2 §9.1) */
export interface TaskBlockedEvent {
  type: "task.blocked";
  taskId: string;
  reason: string;
  cumulativeAttempts: number;
  /** Quality-gate diagnostics when block was due to quality-gate/merge failure (SPEC §API Contracts) */
  qualityGateDetail?: QualityGateDiagnosticDetail | null;
  /** Flat fields for UI/notifications (SPEC §API Contracts); same as qualityGateDetail when present */
  failedGateCommand?: string | null;
  failedGateReason?: string | null;
  failedGateOutputSnippet?: string | null;
  worktreePath?: string | null;
}

/** Emitted when merge or quality-gate step fails (event log parity for live clients). */
export interface MergeFailedEvent {
  type: "merge.failed";
  taskId: string;
  cumulativeAttempts: number;
  resolvedBy: "requeued" | "blocked";
  reason?: string | null;
  mergeStage?: string | null;
  qualityGateDetail?: QualityGateDiagnosticDetail | null;
  failedGateCommand?: string | null;
  failedGateReason?: string | null;
  failedGateOutputSnippet?: string | null;
  worktreePath?: string | null;
}

/** Emitted when the orchestrator requeues a task after failure (coding, merge, infra retry). */
export interface TaskRequeuedEvent {
  type: "task.requeued";
  taskId: string;
  cumulativeAttempts: number;
  phase?: string | null;
  mergeStage?: string | null;
  summary?: string | null;
  nextAction?: string | null;
  qualityGateDetail?: QualityGateDiagnosticDetail | null;
  failedGateCommand?: string | null;
  failedGateReason?: string | null;
  failedGateOutputSnippet?: string | null;
  worktreePath?: string | null;
}

/**
 * Scheduling deferral: branch/worktree is held by another active agent.
 * Task stays open/unassigned; not a coding or merge failure.
 */
export interface TaskDispatchDeferredEvent {
  type: "task.dispatch_deferred";
  taskId: string;
  reason: string;
  otherTaskId?: string | null;
  otherWorktreePath?: string | null;
}

/** Deliver phase events (PRDv2 Deliver phase) */
export interface DeliverStartedEvent {
  type: "deliver.started";
  deployId: string;
}

export interface DeliverCompletedEvent {
  type: "deliver.completed";
  deployId: string;
  success: boolean;
  /** Epic (task) ID for fix tasks when failed due to pre-deploy test failures (PRD §7.5.2) */
  fixEpicId?: string | null;
}

export interface DeliverOutputEvent {
  type: "deliver.output";
  deployId: string;
  chunk: string;
}

/** All server-to-client WebSocket event types */
export type ServerEvent =
  | TaskUpdatedEvent
  | TaskCreatedEvent
  | TaskClosedEvent
  | AgentOutputEvent
  | AgentOutputBackfillEvent
  | AgentStartedEvent
  | AgentCompletedEvent
  | AgentActivityEvent
  | PrdUpdatedEvent
  | ExecuteStatusEvent
  | TaskBlockedEvent
  | MergeFailedEvent
  | TaskRequeuedEvent
  | TaskDispatchDeferredEvent
  | DeliverStartedEvent
  | DeliverCompletedEvent
  | DeliverOutputEvent
  | HilRequestEvent
  | FeedbackMappedEvent
  | FeedbackUpdatedEvent
  | FeedbackResolvedEvent
  | NotificationAddedEvent
  | NotificationResolvedEvent
  | PlanUpdatedEvent
  | PlanGeneratedEvent
  | PlanAgentOutputEvent
  | PlanAgentOutputBackfillEvent;

// ─── Client → Server Events ───

export interface AgentSubscribeEvent {
  type: "agent.subscribe";
  taskId: string;
}

export interface AgentUnsubscribeEvent {
  type: "agent.unsubscribe";
  taskId: string;
}

export interface PlanAgentSubscribeEvent {
  type: "plan.agent.subscribe";
  planId: string;
}

export interface PlanAgentUnsubscribeEvent {
  type: "plan.agent.unsubscribe";
  planId: string;
}

export interface HilRespondEvent {
  type: "hil.respond";
  requestId: string;
  approved: boolean;
  notes?: string;
}

/** All client-to-server WebSocket event types */
export type ClientEvent =
  | AgentSubscribeEvent
  | AgentUnsubscribeEvent
  | PlanAgentSubscribeEvent
  | PlanAgentUnsubscribeEvent
  | HilRespondEvent;
