import type {
  CollaborationSnapshot,
  CollaborationReplay,
  CollaborationCommand,
  CollaborationCommandResult,
  CollaborationActiveRun,
  CollaborationCreatedInvite,
  CollaborationInvite,
  CollaborationNotification,
  CollaborationOverview,
  CollaborationPreferences,
  CollaborationPresence,
  CollaborationRole,
  CollaborationTaskContext,
} from "@opensprint/shared";
import { request } from "./client";

export type SharedActiveRun = CollaborationActiveRun;
export interface CollaborationGuidanceMessage {
  id: string;
  actorId?: string;
  content: string;
  status?: string;
  attempt: number;
  error?: string;
}

/**
 * Bind collaboration requests to one project and its in-memory invitation credential.
 * Omitting the credential uses the existing local session; it does not create guest authority.
 * Guest-listener documents use their own API while other frontends keep the configured API base.
 */
export function collaborationApi(projectId: string, token?: string) {
  const prefix = `/projects/${encodeURIComponent(projectId)}/collaboration`;
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const options = {
    headers,
    ...(typeof window !== "undefined" && window.__OPENSPRINT_COLLABORATION_GUEST__ === true
      ? { apiBaseUrl: "/api/v1" }
      : {}),
  };
  const read = <T>(path: string, signal?: AbortSignal) =>
    request<T>(`${prefix}${path}`, { ...options, signal });
  const write = <T>(path: string, body: unknown, method = "POST") =>
    request<T>(`${prefix}${path}`, { ...options, method, body: JSON.stringify(body) });
  return {
    snapshot: (signal?: AbortSignal) => read<CollaborationSnapshot>("/snapshot", signal),
    replay: (after: number, signal?: AbortSignal) =>
      read<CollaborationReplay>(`/events?after=${after}&limit=200`, signal),
    command: (command: CollaborationCommand) =>
      write<CollaborationCommandResult>("/commands", command),
    activeRun: (taskId: string, signal?: AbortSignal) =>
      read<CollaborationActiveRun | null>(`/runs/${encodeURIComponent(taskId)}`, signal),
    overview: (signal?: AbortSignal) => read<CollaborationOverview>("/overview", signal),
    taskContext: (taskId: string, signal?: AbortSignal) =>
      read<CollaborationTaskContext>(`/tasks/${encodeURIComponent(taskId)}/context`, signal),
    presence: (signal?: AbortSignal) => read<CollaborationPresence[]>("/presence", signal),
    heartbeat: (clientId: string, taskId: string | null) =>
      write<CollaborationPresence[]>("/presence", { clientId, taskId }),
    leave: (clientId: string) =>
      request<void>(`${prefix}/presence/${encodeURIComponent(clientId)}`, {
        ...options,
        method: "DELETE",
        keepalive: true,
      }),
    invites: (signal?: AbortSignal) => read<CollaborationInvite[]>("/invites", signal),
    createInvite: (input: {
      displayName: string;
      role: CollaborationRole;
      expiresInHours: number;
    }) => write<CollaborationCreatedInvite>("/invites", input),
    revokeInvite: (id: string) =>
      request<void>(`${prefix}/invites/${encodeURIComponent(id)}`, {
        ...options,
        method: "DELETE",
      }),
    preferences: (signal?: AbortSignal) => read<CollaborationPreferences>("/preferences", signal),
    savePreferences: (
      input: Pick<CollaborationPreferences, "seenCursor" | "subscribedTaskIds"> & {
        markSeen?: boolean;
        markSeenAt?: string;
      }
    ) => write<CollaborationPreferences>("/preferences", input, "PUT"),
    notifications: (signal?: AbortSignal) =>
      read<CollaborationNotification[]>("/notifications", signal),
    guidanceHistory: (taskId: string, signal?: AbortSignal) =>
      read<CollaborationGuidanceMessage[]>(`/guidance/${encodeURIComponent(taskId)}`, signal),
    guidance: (input: {
      taskId: string;
      attemptId: string;
      clientMessageId: string;
      content: string;
    }) => write<{ delivered: boolean; status?: string; error?: string }>("/guidance", input),
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
      if (!("content" in event.payload)) throw new Error("Invalid session message.");
      next.messages.push(event.payload);
      if (next.messages.length > 200) {
        next.messages.shift();
        next.messagesHasMore = true;
      }
    } else {
      if (!("runId" in event.payload)) throw new Error("Invalid session control event.");
      const updated = event.payload;
      next.runs = [...next.runs.filter((run) => run.runId !== updated.runId), updated];
    }
    next = { ...next, cursor: event.cursor };
  }
  if (replay.nextCursor !== next.cursor)
    throw new Error("Session cursor does not match committed events.");
  return next;
}
