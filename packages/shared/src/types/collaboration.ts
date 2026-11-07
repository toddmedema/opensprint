/** Scoped collaboration credentials never authorize local settings, deployment or governance. */
export type CollaborationRole = "viewer" | "participant" | "controller";
export interface CollaborationPrincipal {
  actorId: string;
  displayName: string;
  role: CollaborationRole;
}
/** Discussion provenance identifies displayed content; paths never authorize filesystem reads. */
export interface CollaborationContext {
  kind: "file" | "diff" | "event";
  label: string;
  path?: string;
  line?: number;
  eventCursor?: number;
  attemptId?: string;
  attempt?: number;
  diffRevision?: string;
}
export interface CollaborationMessage {
  id: string;
  actorId: string;
  displayName: string;
  content: string;
  createdAt: string;
  cursor: number;
  taskId?: string;
  context?: CollaborationContext;
  mentionActorIds?: string[];
  decision?: boolean;
}
export interface CollaborationControlRequest {
  requestedBy: string;
  targetActorId: string;
  createdAt: string;
}
/** Versioned ownership for one execution attempt, separate from browser presence. */
export interface CollaborationRun {
  runId: string;
  controllerId: string | null;
  revision: number;
  request?: CollaborationControlRequest | null;
  taskId?: string;
}
export interface CollaborationEvent {
  projectId: string;
  cursor: number;
  type:
    | "message_appended"
    | "control_claimed"
    | "control_handed_off"
    | "control_requested"
    | "control_request_resolved";
  actorId: string;
  createdAt: string;
  payload: CollaborationMessage | CollaborationRun;
}
/**
 * Idempotent project mutations. HTTP control commands require taskId to validate the live
 * attempt; the optional field permits trusted internal callers to manage retained state.
 */
export type CollaborationCommand = { commandId: string } & (
  | {
      type: "append_message";
      content: string;
      taskId?: string;
      context?: CollaborationContext;
      mentionActorIds?: string[];
      decision?: boolean;
    }
  | { type: "claim_control"; runId: string; expectedRevision: number; taskId?: string }
  | { type: "reclaim_control"; runId: string; expectedRevision: number; taskId?: string }
  | {
      type: "handoff_control";
      runId: string;
      expectedRevision: number;
      targetActorId: string | null;
      taskId?: string;
    }
  | {
      type: "request_control";
      runId: string;
      expectedRevision: number;
      targetActorId: string;
      taskId?: string;
    }
  | {
      type: "respond_control";
      runId: string;
      expectedRevision: number;
      accept: boolean;
      taskId?: string;
    }
  | { type: "cancel_control_request"; runId: string; expectedRevision: number; taskId?: string }
);
export interface CollaborationCommandResult {
  event: CollaborationEvent;
  message?: CollaborationMessage;
  run?: CollaborationRun;
}
export interface CollaborationSnapshot {
  projectId: string;
  sessionId: "default";
  cursor: number;
  messages: CollaborationMessage[];
  messagesHasMore: boolean;
  runs: CollaborationRun[];
  runsHasMore: boolean;
  principal: CollaborationPrincipal;
}
export interface CollaborationReplay {
  events: CollaborationEvent[];
  nextCursor: number;
  hasMore: boolean;
}
export interface CollaborationInvite {
  id: string;
  actorId: string;
  displayName: string;
  role: CollaborationRole;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}
/** The raw bearer token is returned only at creation; persisted invitation metadata omits it. */
export interface CollaborationCreatedInvite {
  invite: CollaborationInvite;
  token: string;
}
export interface CollaborationPresence extends CollaborationPrincipal {
  clientId: string;
  taskId: string | null;
  lastSeenAt: string;
}
export interface CollaborationPreferences {
  seenCursor: number;
  subscribedTaskIds: string[];
  seenAt?: string | null;
}
export interface CollaborationNotification {
  id: string;
  cursor: number;
  taskId: string | null;
  actorId: string;
  createdAt: string;
  kind: "mention" | "control_request" | "task_discussion";
  content: string;
}
export interface CollaborationTask {
  id: string;
  title: string;
  status: string;
  updatedAt?: string;
  completedAt?: string | null;
  summary?: string | null;
  questions?: string[];
}
export interface CollaborationOverview {
  projectName: string;
  /** Configured guest-only origin; local installation credentials are never served there. */
  shareOrigin?: string;
  tasks: CollaborationTask[];
  observedAt?: string;
}
export interface CollaborationActiveRun {
  taskId: string;
  attemptId: string;
  attempt: number;
  supported: boolean;
  reason: string | null;
  control?: CollaborationRun;
}
/** Bounded, read-only task projection tied to a verified live attempt or its latest archive. */
export interface CollaborationTaskContext {
  task: CollaborationTask;
  activeRun: CollaborationActiveRun | null;
  output: string;
  diff: string;
  outputTruncated?: boolean;
  diffTruncated?: boolean;
  unavailableReason?: string;
  sourceAttemptId?: string;
  sourceAttempt?: number;
  source?: "active" | "archived" | "none";
  diffRevision?: string;
}
