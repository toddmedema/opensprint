/** Project collaboration is a scoped pilot; existing APIs retain local session auth. */
export type CollaborationRole = "viewer" | "participant" | "controller";

export interface CollaborationPrincipal {
  actorId: string;
  displayName: string;
  role: CollaborationRole;
}

export interface CollaborationMessage {
  id: string;
  actorId: string;
  displayName: string;
  content: string;
  createdAt: string;
  cursor: number;
}

export interface CollaborationRun {
  runId: string;
  controllerId: string | null;
  revision: number;
}

export interface CollaborationEvent {
  projectId: string;
  cursor: number;
  type: "message_appended" | "control_claimed" | "control_handed_off";
  actorId: string;
  createdAt: string;
  payload: CollaborationMessage | CollaborationRun;
}

export type CollaborationCommand = { commandId: string } & (
  | { type: "append_message"; content: string }
  | { type: "claim_control"; runId: string; expectedRevision: number }
  | {
      type: "handoff_control";
      runId: string;
      expectedRevision: number;
      targetActorId: string | null;
    }
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
  /** Older messages remain available through /events replay. */
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
