import type { AgentPhase, TestResults } from "./agent.js";
import type { FeedbackItem } from "./feedback.js";

// ─── Server → Client Events ───

export interface TaskUpdatedEvent {
  type: "task.updated";
  taskId: string;
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

export interface PrdUpdatedEvent {
  type: "prd.updated";
  section: string;
  version: number;
}

export interface ExecuteStatusEvent {
  type: "execute.status";
  activeTasks: Array<{ taskId: string; phase: AgentPhase; startedAt: string }>;
  queueDepth: number;
  /** True when orchestrator is paused waiting for HIL approval (PRD §6.5) */
  awaitingApproval?: boolean;
  /** Path to active task's git worktree (PRDv2 §5.8) */
  worktreePath?: string | null;
  /** Feedback items awaiting categorization */
  pendingFeedbackCategorizations?: Array<{ feedbackId: string; category?: string }>;
}

/** Scope-change-specific metadata for HIL approval modal (AI-generated summary of proposed PRD updates) */
export interface ScopeChangeProposedUpdate {
  section: string;
  changeLogEntry?: string;
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
    source: "plan" | "prd" | "execute" | "eval";
    sourceId: string;
    questions: Array<{ id: string; text: string; createdAt?: string }>;
    status: "open" | "resolved";
    createdAt: string;
    resolvedAt: string | null;
    kind?: "open_question" | "api_blocked";
    errorCode?: "rate_limit" | "auth" | "out_of_credit";
  };
}

/** Emitted when a notification is resolved (user answered or dismissed) */
export interface NotificationResolvedEvent {
  type: "notification.resolved";
  notificationId: string;
  projectId: string;
  source: "plan" | "prd" | "execute" | "eval";
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

/** Emitted when a task is blocked after progressive backoff exhaustion (PRDv2 §9.1) */
export interface TaskBlockedEvent {
  type: "task.blocked";
  taskId: string;
  reason: string;
  cumulativeAttempts: number;
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
  | AgentOutputEvent
  | AgentOutputBackfillEvent
  | AgentStartedEvent
  | AgentCompletedEvent
  | PrdUpdatedEvent
  | ExecuteStatusEvent
  | TaskBlockedEvent
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
  | PlanGeneratedEvent;

// ─── Client → Server Events ───

export interface AgentSubscribeEvent {
  type: "agent.subscribe";
  taskId: string;
}

export interface AgentUnsubscribeEvent {
  type: "agent.unsubscribe";
  taskId: string;
}

export interface HilRespondEvent {
  type: "hil.respond";
  requestId: string;
  approved: boolean;
  notes?: string;
}

/** All client-to-server WebSocket event types */
export type ClientEvent = AgentSubscribeEvent | AgentUnsubscribeEvent | HilRespondEvent;
