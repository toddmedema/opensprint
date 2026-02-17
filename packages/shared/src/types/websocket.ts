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

export interface AgentDoneEvent {
  type: 'agent.done';
  taskId: string;
  status: string;
  testResults: TestResults | null;
}

export interface PrdUpdatedEvent {
  type: 'prd.updated';
  section: string;
  version: number;
}

export interface BuildStatusEvent {
  type: 'build.status';
  currentTask: string | null;
  /** Coding vs review sub-phase for current task (PRD §7.3.2) */
  currentPhase?: AgentPhase | null;
  queueDepth: number;
  /** True when orchestrator is paused waiting for HIL approval (PRD §6.5) */
  awaitingApproval?: boolean;
}

export interface HilRequestEvent {
  type: 'hil.request';
  requestId: string;
  category: string;
  description: string;
  options: HilOption[];
  /** True = blocking modal (requires_approval); false = dismissible notification (notify_and_proceed) */
  blocking?: boolean;
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

/** Emitted when orchestrator pauses for HIL approval or resumes after response (PRD §6.5) */
export interface BuildAwaitingApprovalEvent {
  type: 'build.awaiting_approval';
  awaiting: boolean;
  category?: string;
  description?: string;
}

/** All server-to-client WebSocket event types */
export type ServerEvent =
  | TaskUpdatedEvent
  | AgentOutputEvent
  | AgentStartedEvent
  | AgentDoneEvent
  | PrdUpdatedEvent
  | BuildStatusEvent
  | TaskBlockedEvent
  | BuildAwaitingApprovalEvent
  | HilRequestEvent
  | FeedbackMappedEvent
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
