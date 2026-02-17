import type { AgentPhase, OrchestratorStatus, TestResults } from './agent.js';
import type { FeedbackCategory } from './feedback.js';
import type { HilNotificationMode } from './settings.js';

// ─── Server → Client Events ───

export interface TaskUpdatedEvent {
  type: 'task.updated';
  taskId: string;
  status: string;
  assignee: string | null;
}

export interface AgentOutputEvent {
  type: 'agent.output';
  taskId: string;
  chunk: string;
}

export interface AgentStartedEvent {
  type: 'agent.started';
  taskId: string;
  phase: AgentPhase;
  branchName?: string;
}

export interface AgentCompletedEvent {
  type: 'agent.completed';
  taskId: string;
  status: string;
  testResults: TestResults | null;
}

export interface PrdUpdatedEvent {
  type: 'prd.updated';
  section: string;
  version: number;
}

export interface ExecuteStatusEvent {
  type: 'execute.status';
  currentTask: string | null;
  /** Coding vs review sub-phase for current task (PRD §7.3.2) */
  currentPhase?: AgentPhase | null;
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
  type: 'hil.request';
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
  type: 'feedback.mapped';
  feedbackId: string;
  planId: string;
  taskIds: string[];
}

export interface FeedbackResolvedEvent {
  type: 'feedback.resolved';
  feedbackId: string;
}

export interface PlanUpdatedEvent {
  type: 'plan.updated';
  planId: string;
}

/** Emitted when a task is blocked after progressive backoff exhaustion (PRDv2 §9.1) */
export interface TaskBlockedEvent {
  type: 'task.blocked';
  taskId: string;
  reason: string;
  cumulativeAttempts: number;
}

/** Deploy phase events (PRDv2 Deploy phase) */
export interface DeployStartedEvent {
  type: 'deploy.started';
  deployId: string;
}

export interface DeployCompletedEvent {
  type: 'deploy.completed';
  deployId: string;
  success: boolean;
  /** Beads epic ID for fix tasks when failed due to pre-deploy test failures (PRD §7.5.2) */
  fixEpicId?: string | null;
}

export interface DeployOutputEvent {
  type: 'deploy.output';
  deployId: string;
  chunk: string;
}

/** All server-to-client WebSocket event types */
export type ServerEvent =
  | TaskUpdatedEvent
  | AgentOutputEvent
  | AgentStartedEvent
  | AgentCompletedEvent
  | PrdUpdatedEvent
  | ExecuteStatusEvent
  | TaskBlockedEvent
  | DeployStartedEvent
  | DeployCompletedEvent
  | DeployOutputEvent
  | HilRequestEvent
  | FeedbackMappedEvent
  | FeedbackResolvedEvent
  | PlanUpdatedEvent;

// ─── Client → Server Events ───

export interface AgentSubscribeEvent {
  type: 'agent.subscribe';
  taskId: string;
}

export interface AgentUnsubscribeEvent {
  type: 'agent.unsubscribe';
  taskId: string;
}

export interface HilRespondEvent {
  type: 'hil.respond';
  requestId: string;
  approved: boolean;
  notes?: string;
}

/** All client-to-server WebSocket event types */
export type ClientEvent =
  | AgentSubscribeEvent
  | AgentUnsubscribeEvent
  | HilRespondEvent;
