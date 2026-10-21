import type {
  CollaborationSnapshot,
  CollaborationReplay,
  CollaborationCommand,
  CollaborationCommandResult,
  CollaborationMessage,
  CollaborationRun,
} from "@opensprint/shared";
import { request } from "./client";

export interface SharedActiveRun {
  taskId: string;
  attemptId: string;
  attempt: number;
  supported: boolean;
  reason: string | null;
  control?: { runId: string; controllerId: string | null; revision: number };
}
export function collaborationApi(projectId: string, token?: string) {
  const prefix = `/projects/${encodeURIComponent(projectId)}/collaboration`;
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  return {
    snapshot: () => request<CollaborationSnapshot>(`${prefix}/snapshot`, { headers }),
    replay: (after: number) =>
      request<CollaborationReplay>(`${prefix}/events?after=${after}&limit=200`, { headers }),
    command: (command: CollaborationCommand) =>
      request<CollaborationCommandResult>(`${prefix}/commands`, {
        headers,
        method: "POST",
        body: JSON.stringify(command),
      }),
    activeRun: (taskId: string) =>
      request<SharedActiveRun | null>(`${prefix}/runs/${encodeURIComponent(taskId)}`, { headers }),
    guidanceHistory: (taskId: string) =>
      request<
        Array<{
          id: string;
          actorId?: string;
          content: string;
          status?: string;
          attempt: number;
          error?: string;
        }>
      >(`${prefix}/guidance/${encodeURIComponent(taskId)}`, { headers }),
    guidance: (input: {
      taskId: string;
      attemptId: string;
      clientMessageId: string;
      content: string;
    }) =>
      request<{ delivered: boolean; status?: string; error?: string }>(`${prefix}/guidance`, {
        headers,
        method: "POST",
        body: JSON.stringify(input),
      }),
  };
}

/** Replayed semantic events are a view of Query-owned server state, never another Redux copy. */
export function applyCollaborationReplay(
  snapshot: CollaborationSnapshot,
  replay: CollaborationReplay
): CollaborationSnapshot {
  let next = { ...snapshot, messages: [...snapshot.messages], runs: [...snapshot.runs] };
  for (const event of replay.events) {
    if (event.cursor <= next.cursor) continue;
    if (event.projectId !== snapshot.projectId || event.cursor !== next.cursor + 1)
      throw new Error("Session history needs a fresh snapshot.");
    if (event.type === "message_appended") {
      if (!event.payload || typeof event.payload !== "object" || !("content" in event.payload))
        throw new Error("Invalid session message.");
      next.messages.push(event.payload as CollaborationMessage);
      if (next.messages.length > 200) {
        next.messages.shift();
        next.messagesHasMore = true;
      }
    } else if (event.type === "control_claimed" || event.type === "control_handed_off") {
      if (!event.payload || typeof event.payload !== "object" || !("runId" in event.payload))
        throw new Error("Invalid session control event.");
      const updated = event.payload as CollaborationRun;
      next.runs = [...next.runs.filter((run) => run.runId !== updated.runId), updated];
    }
    next = { ...next, cursor: event.cursor };
  }
  if (replay.nextCursor !== next.cursor)
    throw new Error("Session cursor does not match committed events.");
  return next;
}
