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

export interface BuildStatusEvent {
  type: 'build.status';
  running: boolean;
  currentTask: string | null;
  queueDepth: number;
}

export interface HilRequestEvent {
  type: 'hil.request';
  requestId: string;
  category: string;
  description: string;
  options: HilOption[];
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

/** All server-to-client WebSocket event types */
export type ServerEvent =
  | TaskUpdatedEvent
  | AgentOutputEvent
  | AgentCompletedEvent
  | PrdUpdatedEvent
  | BuildStatusEvent
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
