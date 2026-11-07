import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CollaborationCommand, CollaborationSnapshot } from "@opensprint/shared";
import { applyCollaborationReplay, collaborationApi } from "../../api/collaboration";
import { ApiError } from "../../api/client";

/** Identify terminal membership failures so polling stops after expiration or revocation. */
export function isCollaborationAccessError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    ["COLLABORATION_UNAUTHENTICATED", "COLLABORATION_FORBIDDEN"].includes(error.code)
  );
}

/**
 * Own one connection's server queries, durable event replay, and browser presence.
 * Query identities exclude credentials, history pagination is independent of unread state,
 * and cleanup removes connection data without cancelling the agent attempt.
 */
export function useCollaborationSession(
  projectId: string,
  token: string | undefined,
  taskId: string | null,
  activityMode: "unread" | "history" = "unread",
  visible: { context?: boolean; history?: boolean } = {}
) {
  const client = useMemo(() => collaborationApi(projectId, token), [projectId, token]);
  const [connectionId] = useState(() => crypto.randomUUID());
  const queryKey = useMemo(
    () => ["collaboration", projectId, connectionId],
    [projectId, connectionId]
  );
  const qc = useQueryClient();
  const taskRef = useRef(taskId);
  taskRef.current = taskId;
  const heartbeatNow = useRef<(() => void) | null>(null);
  const [presenceError, setPresenceError] = useState<Error | null>(null);
  const snapshot = useQuery({
    queryKey: [...queryKey, "snapshot"],
    queryFn: async ({ signal }) => {
      const previous = qc.getQueryData<CollaborationSnapshot>([...queryKey, "snapshot"]);
      if (!previous) return client.snapshot(signal);
      try {
        return applyCollaborationReplay(previous, await client.replay(previous.cursor, signal));
      } catch (error) {
        if (signal.aborted || isCollaborationAccessError(error)) throw error;
        return client.snapshot(signal);
      }
    },
    refetchInterval: (query) => (isCollaborationAccessError(query.state.error) ? false : 2000),
    retry: false,
    gcTime: 0,
  });
  const enabled = snapshot.isSuccess && !snapshot.error;
  const principal = snapshot.data?.principal;
  const overview = useQuery({
    queryKey: [...queryKey, "overview"],
    queryFn: ({ signal }) => client.overview(signal),
    enabled,
    refetchInterval: 10000,
    retry: false,
    gcTime: 0,
  });
  const presence = useQuery({
    queryKey: [...queryKey, "presence"],
    queryFn: ({ signal }) => client.presence(signal),
    enabled,
    refetchInterval: 5000,
    retry: false,
    gcTime: 0,
  });
  const preferences = useQuery({
    queryKey: [...queryKey, "preferences"],
    queryFn: ({ signal }) => client.preferences(signal),
    enabled,
    retry: false,
    gcTime: 0,
  });
  const notifications = useQuery({
    queryKey: [...queryKey, "notifications"],
    queryFn: ({ signal }) => client.notifications(signal),
    enabled,
    refetchInterval: 5000,
    retry: false,
    gcTime: 0,
  });
  const context = useQuery({
    queryKey: [...queryKey, "context", taskId],
    queryFn: ({ signal }) => client.taskContext(taskId!, signal),
    enabled: enabled && Boolean(taskId) && visible.context !== false,
    refetchInterval: 3000,
    retry: false,
    gcTime: 0,
  });
  const active = useQuery({
    queryKey: [...queryKey, "active", taskId],
    queryFn: ({ signal }) => client.activeRun(taskId!, signal),
    enabled: enabled && Boolean(taskId),
    refetchInterval: 2000,
    retry: false,
    gcTime: 0,
  });
  const history = useQuery({
    queryKey: [...queryKey, "history", taskId],
    queryFn: ({ signal }) => client.guidanceHistory(taskId!, signal),
    enabled: enabled && Boolean(taskId) && visible.history !== false,
    refetchInterval: 2000,
    retry: false,
    gcTime: 0,
  });
  const activityStart = activityMode === "history" ? 0 : (preferences.data?.seenCursor ?? 0);
  const activity = useInfiniteQuery({
    queryKey: [...queryKey, "activity", activityMode, activityStart],
    initialPageParam: activityStart,
    queryFn: ({ pageParam, signal }) => client.replay(pageParam, signal),
    getNextPageParam: (page) => (page.hasMore ? page.nextCursor : undefined),
    enabled: enabled && Boolean(preferences.data) && visible.history !== false,
    refetchInterval: 5000,
    retry: false,
    gcTime: 0,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey });
  const command = useMutation({
    gcTime: 0,
    mutationFn: (input: CollaborationCommand) => client.command(input),
    onSuccess: invalidate,
    onError: () => {
      void invalidate();
    },
  });
  const savePreferences = useMutation({
    gcTime: 0,
    mutationFn: client.savePreferences,
    onSuccess: invalidate,
  });
  useEffect(() => {
    if (!enabled) return;
    // A reconnect uses a fresh presence identity so late cleanup cannot remove its replacement.
    const presenceId = crypto.randomUUID();
    let current = true;
    let inFlight: Promise<void> | null = null;
    let queued = false;
    let lastSentTask: string | null | undefined;
    /** Serialize heartbeats and queue task changes without reviving a connection after cleanup. */
    const beat = (force = true) => {
      if (!current) return;
      if (inFlight) {
        if (lastSentTask !== taskRef.current) queued = true;
        return;
      }
      if (!force && lastSentTask === taskRef.current) return;
      const sentTask = taskRef.current;
      lastSentTask = sentTask;
      inFlight = client
        .heartbeat(presenceId, sentTask)
        .then((data) => {
          if (current && sentTask === taskRef.current) {
            setPresenceError(null);
            qc.setQueryData([...queryKey, "presence"], data);
          }
        })
        .catch((error) => {
          if (current) setPresenceError(error);
        })
        .finally(() => {
          inFlight = null;
          if (current && queued) {
            queued = false;
            beat();
          }
        });
    };
    const onTaskChange = () => beat(false);
    heartbeatNow.current = onTaskChange;
    beat();
    const timer = window.setInterval(beat, 15000);
    const leave = () => {
      void client.leave(presenceId).catch(() => {});
    };
    window.addEventListener("pagehide", leave);
    return () => {
      current = false;
      if (heartbeatNow.current === onTaskChange) heartbeatNow.current = null;
      window.clearInterval(timer);
      window.removeEventListener("pagehide", leave);
      leave();
      // A request already accepted by the server may finish after the first DELETE.
      // Clear that presence again after its acknowledgment, without recreating query state.
      if (inFlight) void inFlight.then(leave);
    };
  }, [client, enabled, qc, queryKey]);
  useEffect(() => {
    heartbeatNow.current?.();
  }, [taskId]);
  useEffect(
    () => () => {
      void qc.cancelQueries({ queryKey });
      qc.removeQueries({ queryKey });
    },
    [qc, queryKey]
  );
  const activeRun = active.isSuccess ? active.data : (context.data?.activeRun ?? null);
  const snapshotControl = snapshot.data?.runs.find((run) => run.runId === activeRun?.attemptId);
  const run =
    snapshotControl && snapshotControl.revision >= (activeRun?.control?.revision ?? 0)
      ? snapshotControl
      : activeRun?.control;
  const connectionError =
    snapshot.error ??
    (visible.context !== false ? context.error : null) ??
    active.error ??
    (visible.history !== false ? history.error : null) ??
    overview.error ??
    presence.error ??
    notifications.error ??
    preferences.error ??
    (visible.history !== false ? activity.error : null) ??
    presenceError;
  const error = connectionError ?? command.error ?? savePreferences.error;
  return {
    client,
    queryKey,
    snapshot,
    principal,
    overview,
    presence,
    preferences,
    notifications,
    context,
    activeRun,
    run,
    history,
    activity,
    command,
    savePreferences,
    error,
    connectionError,
    invalidate,
  };
}
export type CollaborationSessionState = ReturnType<typeof useCollaborationSession>;
