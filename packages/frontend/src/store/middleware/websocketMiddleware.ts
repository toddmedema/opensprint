import type { Middleware, ThunkDispatch, UnknownAction } from "@reduxjs/toolkit";
import { createAction } from "@reduxjs/toolkit";
import type {
  ServerEvent,
  ClientEvent,
  AgentCompletedEvent,
  AgentChatReceivedEvent,
  AgentChatResponseEvent,
  AgentChatUnsupportedEvent,
  ExecuteStatusEvent,
  FeedbackMappedEvent,
  FeedbackUpdatedEvent,
  FeedbackResolvedEvent,
  IntegrationSyncCompletedEvent,
  IntegrationConnectionUpdatedEvent,
  Task,
  TaskEventPayload,
  TaskPriority,
  Notification,
} from "@opensprint/shared";
import { setConnected } from "../slices/websocketSlice";
import { addNotification as addToast } from "../slices/notificationSlice";
import {
  addNotification,
  removeNotification,
  selectProjectNotifications,
  type OpenQuestionsState,
} from "../slices/openQuestionsSlice";
import { setConnectionError } from "../slices/connectionSlice";
import {
  appendAgentOutput,
  setAgentOutputBackfill,
  setOrchestratorRunning,
  setAwaitingApproval,
  setExecuteStatusPayload,
  sweepExpiredBaselineMergePauseTick,
  setCompletionState,
  setSelectedTaskId,
  taskUpdated,
  taskCreated,
  taskClosed,
  fetchTasksByIds,
} from "../slices/executeSlice";
import { updateFeedbackItem, updateFeedbackItemResolved } from "../slices/evalSlice";
import { appendDeliverOutput, deliverStarted, deliverCompleted } from "../slices/deliverSlice";
import {
  appendAuditorOutput,
  setAuditorOutputBackfill,
  setDecomposeProgress,
} from "../slices/planSlice";
import { setPhaseUnread } from "../slices/unreadPhaseSlice";
import {
  chatMessageReceived,
  chatResponseReceived,
  chatUnsupported,
  chatConnectionLost,
  resetChatSending,
  fetchAgentChatHistory,
  type AgentChatState,
} from "../slices/agentChatSlice";
import type { QueryClient } from "@tanstack/react-query";
import { API_PREFIX } from "@opensprint/shared";
import { getQueryClient } from "../../queryClient";
import { queryKeys } from "../../api/queryKeys";
import { isViewingProjectPhase } from "../../lib/currentProjectRoute";
import {
  shouldBumpTasksListForMergeGateStatus,
  snapshotExecuteStatusMergeGateFields,
} from "../../lib/executeStatusMergeGateTasksBump";

type StoreDispatch = ThunkDispatch<unknown, unknown, UnknownAction>;

/** Merge fetched tasks into the tasks list cache and set each task's detail cache. Avoids duplicate refetches after feedback.updated. */
function syncTasksToQueryCache(qc: QueryClient, projectId: string, tasks: Task[]): void {
  if (tasks.length === 0) return;
  qc.setQueryData(queryKeys.tasks.list(projectId), (prev: unknown) => {
    const mergeIntoList = (current: Task[]): Task[] => {
      const byId = new Map(current.map((t) => [t.id, t]));
      for (const task of tasks) byId.set(task.id, task);
      return [...byId.values()];
    };
    if (Array.isArray(prev)) return mergeIntoList(prev as Task[]);
    if (prev && typeof prev === "object" && "items" in (prev as Record<string, unknown>)) {
      const paginatedPrev = prev as { items?: Task[]; total?: number };
      const mergedItems = mergeIntoList(
        Array.isArray(paginatedPrev.items) ? paginatedPrev.items : []
      );
      return {
        ...paginatedPrev,
        items: mergedItems,
        ...(typeof paginatedPrev.total === "number"
          ? { total: Math.max(paginatedPrev.total, mergedItems.length) }
          : {}),
      };
    }
    return mergeIntoList([]);
  });
  for (const task of tasks) {
    qc.setQueryData(queryKeys.tasks.detail(projectId, task.id), task);
  }
}

/**
 * Sync a single task from Redux execute state into React Query caches.
 * Returns true when task exists in state and cache sync was applied.
 */
function syncTaskFromExecuteStateToQueryCache(
  qc: QueryClient,
  getState: () => unknown,
  projectId: string,
  taskId: string
): boolean {
  const root = getState() as {
    execute?: { tasksById?: Record<string, Task | undefined> };
  };
  const task = root.execute?.tasksById?.[taskId];
  if (!task) return false;
  syncTasksToQueryCache(qc, projectId, [task]);
  return true;
}

export const wsConnect = createAction<{ projectId: string }>("ws/connect");
export const wsConnectHome = createAction("ws/connectHome");
export const wsDisconnect = createAction("ws/disconnect");
export const wsSend = createAction<ClientEvent>("ws/send");

/** Sentinel for "connected to /ws with no project" (so backend sees a client and does not open a duplicate tab on homepage) */
const HOME_SENTINEL = "__home__";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

/** Max rate for agent.activity → React Query invalidations (diagnostics + active agents). Suspended/resumed flush immediately. */
const AGENT_ACTIVITY_QUERY_THROTTLE_MS = 1000;

/**
 * Single visibility/focus subscription for the whole app. Each `configureStore` must not add its own
 * listeners — tests create many stores sequentially, and duplicate handlers were firing `connect()` from
 * stale middleware and breaking MockWebSocket tests (wrong `ws` / timer interactions).
 */
let windowReturnOnVisible: (() => void) | null = null;
let windowReturnOnFocusDebounced: (() => void) | null = null;
let windowLifecycleHooksInstalled = false;

function installWindowLifecycleHooksOnce(): void {
  if (windowLifecycleHooksInstalled) return;
  windowLifecycleHooksInstalled = true;
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      windowReturnOnVisible?.();
    });
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("focus", () => {
      windowReturnOnFocusDebounced?.();
    });
  }
}

const API_V1_BASE = `${(import.meta.env.VITE_API_BASE as string | undefined) ?? ""}${API_PREFIX}`;

/**
 * Exchange Bearer session for a one-time WS upgrade ticket over HTTPS (avoids putting the session
 * in the WebSocket URL, which is often logged). Node `ws` clients can use the header instead.
 */
async function fetchWebSocketUpgradeTicket(): Promise<string | null> {
  const token = typeof window !== "undefined" ? window.__OPENSPRINT_LOCAL_SESSION__ : undefined;
  if (!token) return null;
  try {
    const res = await fetch(`${API_V1_BASE}/ws-upgrade-ticket`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: "{}",
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (
      body &&
      typeof body === "object" &&
      "data" in body &&
      body.data &&
      typeof body.data === "object" &&
      "ticket" in body.data &&
      typeof (body.data as { ticket?: unknown }).ticket === "string"
    ) {
      return (body.data as { ticket: string }).ticket;
    }
    return null;
  } catch {
    return null;
  }
}

function buildWebSocketUrl(pathFromHost: string, ticket: string | null): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = `${protocol}//${window.location.host}${pathFromHost}`;
  if (!ticket) return base;
  return `${base}?${new URLSearchParams({ ticket }).toString()}`;
}

export const websocketMiddleware: Middleware = (storeApi) => {
  const dispatch = storeApi.dispatch as StoreDispatch;
  let ws: WebSocket | null = null;
  let connectionGeneration = 0;
  let currentProjectId: string | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let intentionalClose = false;
  /** True after first successful connect; used to invalidate queries on reconnect (graceful recovery) */
  let hadConnection = false;

  /** Coalesce agent.activity invalidations to avoid refetch storms during long agent runs */
  let lastAgentActivityQueryFlushAt = -AGENT_ACTIVITY_QUERY_THROTTLE_MS;
  let agentActivityQueryFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingAgentActivityDiagnosticsTaskIds = new Set<string>();
  let pendingAgentActivityInvalidateActiveAgents = false;

  function clearAgentActivityQueryFlushTimer() {
    if (agentActivityQueryFlushTimer) {
      clearTimeout(agentActivityQueryFlushTimer);
      agentActivityQueryFlushTimer = null;
    }
  }

  function resetAgentActivityQueryCoalescing() {
    clearAgentActivityQueryFlushTimer();
    pendingAgentActivityDiagnosticsTaskIds.clear();
    pendingAgentActivityInvalidateActiveAgents = false;
    lastAgentActivityQueryFlushAt = -AGENT_ACTIVITY_QUERY_THROTTLE_MS;
  }

  function flushAgentActivityQueryInvalidations(projectId: string) {
    const taskIds = [...pendingAgentActivityDiagnosticsTaskIds];
    const invalidateActive = pendingAgentActivityInvalidateActiveAgents;
    pendingAgentActivityDiagnosticsTaskIds.clear();
    pendingAgentActivityInvalidateActiveAgents = false;
    agentActivityQueryFlushTimer = null;
    lastAgentActivityQueryFlushAt = Date.now();
    try {
      const client = getQueryClient();
      for (const taskId of taskIds) {
        void client.invalidateQueries({
          queryKey: queryKeys.execute.diagnostics(projectId, taskId),
        });
      }
      if (invalidateActive) {
        void client.invalidateQueries({ queryKey: ["agents", "active", projectId] });
      }
    } catch {
      // QueryClient may not be set in tests
    }
  }

  /** Pending agent.subscribe messages to replay when connection opens (fixes stuck live output) */
  const pendingSubscribes: Array<{ type: "agent.subscribe"; taskId: string }> = [];
  /** Pending plan.agent.subscribe messages to replay when connection opens */
  const pendingPlanSubscribes: Array<{ type: "plan.agent.subscribe"; planId: string }> = [];

  function cleanup() {
    dispatch(chatConnectionLost());
    connectionGeneration++;
    intentionalClose = true;
    dispatch(setConnected(false));
    resetAgentActivityQueryCoalescing();
    pendingSubscribes.length = 0;
    pendingPlanSubscribes.length = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      const previous = ws;
      ws = null;
      previous.close();
    }
    currentProjectId = null;
    reconnectAttempt = 0;
  }

  function attachProjectSocketHandlers(socket: WebSocket, projectId: string, generation: number) {
    socket.onopen = () => {
      if (socket !== ws || generation !== connectionGeneration) return;
      reconnectAttempt = 0;
      dispatch(setConnected(true));
      dispatch(setConnectionError(false));
      dispatch(sweepExpiredBaselineMergePauseTick());
      // On reconnect: invalidate tasks and plans so Execute page gets fresh data
      if (hadConnection) {
        try {
          const qc = getQueryClient();
          void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
          void qc.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
          void qc.invalidateQueries({ queryKey: queryKeys.feedback.list(projectId) });
          const selectedTaskId = (
            storeApi.getState() as { execute?: { selectedTaskId?: string | null } }
          ).execute?.selectedTaskId;
          if (selectedTaskId)
            void dispatch(fetchAgentChatHistory({ projectId, taskId: selectedTaskId }));
        } catch {
          // QueryClient may not be set in tests
        }
      }
      hadConnection = true;
      // Replay pending agent.subscribe so live output loads after reconnect
      for (const msg of pendingSubscribes) {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        }
      }
      pendingSubscribes.length = 0;
      // Replay pending plan.agent.subscribe for Auditor output
      for (const msg of pendingPlanSubscribes) {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        }
      }
      pendingPlanSubscribes.length = 0;
    };

    socket.onmessage = (event) => {
      if (socket !== ws || generation !== connectionGeneration) return;
      try {
        const data = JSON.parse(event.data) as ServerEvent;
        handleServerEvent(dispatch, storeApi.getState, projectId, data);
      } catch {
        // ignore parse errors
      }
    };

    socket.onclose = () => {
      // Ignore if this is a stale socket (replaced by a newer connection)
      if (socket !== ws || generation !== connectionGeneration) return;
      dispatch(setConnected(false));
      dispatch(chatConnectionLost());
      if (!intentionalClose && currentProjectId) {
        scheduleReconnect(projectId);
      }
    };

    socket.onerror = () => {
      // onclose will fire after onerror
    };
  }

  function connect(projectId: string) {
    // Skip if already connected to the same project
    if (currentProjectId === projectId && ws && ws.readyState === WebSocket.OPEN) {
      return;
    }

    cleanup();
    intentionalClose = false;
    currentProjectId = projectId;
    const generation = connectionGeneration;

    void (async () => {
      const ticket = await fetchWebSocketUpgradeTicket();
      if (generation !== connectionGeneration || intentionalClose || currentProjectId !== projectId)
        return;

      const url = buildWebSocketUrl(`/ws/projects/${projectId}`, ticket);
      const socket = new WebSocket(url);
      ws = socket;
      attachProjectSocketHandlers(socket, projectId, generation);
    })();
  }

  function scheduleReconnect(projectId: string) {
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt), RECONNECT_MAX_MS);
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
      if (currentProjectId === projectId) {
        connect(projectId);
      }
    }, delay);
  }

  function connectHome() {
    if (currentProjectId === HOME_SENTINEL && ws?.readyState === WebSocket.OPEN) return;
    cleanup();
    intentionalClose = false;
    currentProjectId = HOME_SENTINEL;
    const generation = connectionGeneration;

    void (async () => {
      const ticket = await fetchWebSocketUpgradeTicket();
      if (
        generation !== connectionGeneration ||
        intentionalClose ||
        currentProjectId !== HOME_SENTINEL
      )
        return;

      const url = buildWebSocketUrl("/ws", ticket);
      const socket = new WebSocket(url);
      ws = socket;
      socket.onopen = () => {
        if (socket !== ws || generation !== connectionGeneration) return;
        reconnectAttempt = 0;
        dispatch(setConnected(true));
        dispatch(setConnectionError(false));
      };
      socket.onmessage = () => {
        // No project scope — backend does not send project events to /ws-only clients
      };
      socket.onclose = () => {
        if (socket !== ws || generation !== connectionGeneration) return;
        dispatch(setConnected(false));
        if (!intentionalClose && currentProjectId === HOME_SENTINEL) {
          const delay = Math.min(
            RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt),
            RECONNECT_MAX_MS
          );
          reconnectAttempt++;
          reconnectTimer = setTimeout(() => {
            if (currentProjectId === HOME_SENTINEL) connectHome();
          }, delay);
        }
      };
      socket.onerror = () => {};
    })();
  }

  /** Invalidate project queries so UI refetches when window returns to focus (Electron or browser tab). */
  function invalidateProjectQueriesOnFocus(projectId: string) {
    try {
      const qc = getQueryClient();
      void qc.invalidateQueries({ queryKey: queryKeys.prd.detail(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.prd.history(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.plans.status(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.feedback.list(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.deliver.status(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.execute.status(projectId) });
    } catch {
      // QueryClient may not be set in tests
    }
  }

  /** Run when window/tab becomes visible or window gains focus (Electron often does not fire visibilitychange on focus). */
  function onWindowReturn() {
    if (intentionalClose) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (currentProjectId === HOME_SENTINEL) connectHome();
      else if (currentProjectId) connect(currentProjectId);
    } else if (currentProjectId && currentProjectId !== HOME_SENTINEL) {
      invalidateProjectQueriesOnFocus(currentProjectId);
    }
  }

  // Debounce focus only (per store instance) — visibility should reconnect/invalidate immediately.
  const FOCUS_DEBOUNCE_MS = 2000;
  let lastFocusRefreshAt = 0;
  function onWindowReturnFromFocus() {
    if (intentionalClose) return;
    const now = Date.now();
    if (now - lastFocusRefreshAt < FOCUS_DEBOUNCE_MS) return;
    lastFocusRefreshAt = now;
    onWindowReturn();
  }

  installWindowLifecycleHooksOnce();
  windowReturnOnVisible = onWindowReturn;
  windowReturnOnFocusDebounced = onWindowReturnFromFocus;

  function handleServerEvent(
    d: StoreDispatch,
    getState: () => unknown,
    projectId: string,
    event: ServerEvent
  ) {
    const qc = getQueryClient();
    switch (event.type) {
      case "prd.updated": {
        if (!isViewingProjectPhase(projectId, "sketch")) {
          d(setPhaseUnread({ projectId, phase: "sketch" }));
        }
        void qc.invalidateQueries({ queryKey: queryKeys.prd.detail(projectId) });
        void qc.invalidateQueries({ queryKey: queryKeys.prd.history(projectId) });
        void qc.invalidateQueries({ queryKey: queryKeys.chat.history(projectId, "sketch") });
        void qc.invalidateQueries({ queryKey: queryKeys.plans.status(projectId) });
        break;
      }

      case "plan.generated": {
        if (!isViewingProjectPhase(projectId, "plan")) {
          d(setPhaseUnread({ projectId, phase: "plan" }));
        }
        void qc.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
        void qc.invalidateQueries({
          queryKey: queryKeys.plans.detail(projectId, event.planId),
        });
        break;
      }

      case "plan.decompose.progress": {
        d(
          setDecomposeProgress({
            createdCount: event.createdCount,
            totalCount: event.totalCount,
          })
        );
        break;
      }

      case "plan.updated": {
        if (!isViewingProjectPhase(projectId, "plan")) {
          d(setPhaseUnread({ projectId, phase: "plan" }));
        }
        void qc.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
        void qc.invalidateQueries({ queryKey: queryKeys.plans.status(projectId) });
        void qc.invalidateQueries({
          queryKey: queryKeys.plans.detail(projectId, event.planId),
        });
        void qc.invalidateQueries({
          queryKey: queryKeys.plans.chat(projectId, `plan:${event.planId}`),
        });
        void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
        break;
      }

      case "task.created": {
        const created = event as { type: "task.created"; task: TaskEventPayload };
        if (created.task) {
          d(taskCreated(created.task));
          const synced = syncTaskFromExecuteStateToQueryCache(
            qc,
            getState,
            projectId,
            created.task.id
          );
          if (!synced) {
            void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
          }
        } else {
          void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
        }
        break;
      }
      case "task.closed": {
        const closed = event as { type: "task.closed"; task: TaskEventPayload };
        if (closed.task) {
          d(taskClosed(closed.task));
          const synced = syncTaskFromExecuteStateToQueryCache(
            qc,
            getState,
            projectId,
            closed.task.id
          );
          if (!synced) {
            void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
          }
        } else {
          void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
        }
        break;
      }

      case "task.updated": {
        void qc.invalidateQueries({
          queryKey: queryKeys.execute.diagnostics(projectId, event.taskId),
        });
        d(
          taskUpdated({
            taskId: event.taskId,
            status: event.status,
            assignee: event.assignee,
            priority: event.priority as TaskPriority | undefined,
            blockReason: event.blockReason,
            title: event.title,
            description: event.description,
            kanbanColumn: event.kanbanColumn,
            mergePausedUntil: event.mergePausedUntil,
            mergeWaitingOnMain: event.mergeWaitingOnMain,
            mergeGateState: event.mergeGateState,
            lastExecutionSummary: event.lastExecutionSummary,
          })
        );
        const synced = syncTaskFromExecuteStateToQueryCache(qc, getState, projectId, event.taskId);
        if (!synced) {
          void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
          void qc.invalidateQueries({
            queryKey: queryKeys.tasks.detail(projectId, event.taskId),
          });
        }
        break;
      }

      case "agent.started":
        void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
        void qc.invalidateQueries({ queryKey: ["agents", "active", projectId] });
        break;

      case "agent.activity": {
        pendingAgentActivityDiagnosticsTaskIds.add(event.taskId);
        pendingAgentActivityInvalidateActiveAgents = true;
        const forceImmediate = event.activity === "suspended" || event.activity === "resumed";
        if (forceImmediate) {
          clearAgentActivityQueryFlushTimer();
          flushAgentActivityQueryInvalidations(projectId);
        } else {
          const now = Date.now();
          if (now - lastAgentActivityQueryFlushAt >= AGENT_ACTIVITY_QUERY_THROTTLE_MS) {
            clearAgentActivityQueryFlushTimer();
            flushAgentActivityQueryInvalidations(projectId);
          } else if (!agentActivityQueryFlushTimer) {
            const delay = Math.max(
              0,
              AGENT_ACTIVITY_QUERY_THROTTLE_MS - (now - lastAgentActivityQueryFlushAt)
            );
            agentActivityQueryFlushTimer = setTimeout(() => {
              flushAgentActivityQueryInvalidations(projectId);
            }, delay);
          }
        }
        break;
      }

      case "agent.completed": {
        const completed = event as AgentCompletedEvent;
        void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
        void qc.invalidateQueries({
          queryKey: queryKeys.execute.diagnostics(projectId, completed.taskId),
        });
        void qc.invalidateQueries({ queryKey: ["agents", "active", projectId] });
        d(
          setCompletionState({
            taskId: completed.taskId,
            status: completed.status,
            testResults: completed.testResults,
            reason: completed.reason,
          })
        );
        d(resetChatSending({ taskId: completed.taskId }));
        break;
      }

      case "task.blocked":
        void qc.invalidateQueries({
          queryKey: queryKeys.tasks.detail(projectId, event.taskId),
        });
        void qc.invalidateQueries({
          queryKey: queryKeys.tasks.sessions(projectId, event.taskId),
        });
        void qc.invalidateQueries({
          queryKey: queryKeys.execute.diagnostics(projectId, event.taskId),
        });
        void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
        break;

      case "merge.failed":
      case "task.requeued":
      case "task.dispatch_deferred":
        void qc.invalidateQueries({
          queryKey: queryKeys.tasks.detail(projectId, event.taskId),
        });
        void qc.invalidateQueries({
          queryKey: queryKeys.execute.diagnostics(projectId, event.taskId),
        });
        void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
        break;

      case "agent.output":
        d(appendAgentOutput({ taskId: event.taskId, chunk: event.chunk }));
        break;

      case "agent.outputBackfill": {
        const backfill = event as { type: "agent.outputBackfill"; taskId: string; output: string };
        d(setAgentOutputBackfill({ taskId: backfill.taskId, output: backfill.output }));
        break;
      }

      case "plan.agent.output": {
        const ev = event as { type: "plan.agent.output"; planId: string; chunk: string };
        d(appendAuditorOutput({ planId: ev.planId, chunk: ev.chunk }));
        break;
      }

      case "plan.agent.outputBackfill": {
        const ev = event as {
          type: "plan.agent.outputBackfill";
          planId: string;
          output: string;
        };
        d(setAuditorOutputBackfill({ planId: ev.planId, output: ev.output }));
        break;
      }

      case "execute.status": {
        const statusEv = event as ExecuteStatusEvent;
        const activeTasks = statusEv.activeTasks ?? [];
        const running = activeTasks.length > 0 || statusEv.queueDepth > 0;
        d(setOrchestratorRunning(running));
        if (statusEv.awaitingApproval !== undefined) {
          d(setAwaitingApproval(Boolean(statusEv.awaitingApproval)));
        }
        d(
          setExecuteStatusPayload({
            activeTasks,
            queueDepth: statusEv.queueDepth,
            awaitingApproval: statusEv.awaitingApproval,
            baselineStatus: statusEv.baselineStatus,
            baselineCheckedAt: statusEv.baselineCheckedAt,
            baselineFailureSummary: statusEv.baselineFailureSummary,
            baselineRemediationStatus: statusEv.baselineRemediationStatus,
            mergeValidationStatus: statusEv.mergeValidationStatus,
            mergeValidationFailureSummary: statusEv.mergeValidationFailureSummary,
            dispatchPausedReason: statusEv.dispatchPausedReason,
            selfImprovementRunInProgress: statusEv.selfImprovementRunInProgress,
            selfImprovementRunMode: statusEv.selfImprovementRunMode,
            gitMergeQueue: statusEv.gitMergeQueue ?? null,
          })
        );
        {
          const snap = snapshotExecuteStatusMergeGateFields(statusEv);
          if (shouldBumpTasksListForMergeGateStatus(projectId, snap)) {
            void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
          }
        }
        break;
      }

      case "feedback.mapped":
      case "feedback.updated": {
        const ev = event as FeedbackMappedEvent | FeedbackUpdatedEvent;
        if (ev.item) {
          d(updateFeedbackItem(ev.item));
          const taskIds = [
            ...new Set([...(ev.item.createdTaskIds ?? []), ...(ev.taskIds ?? [])]),
          ].filter((id): id is string => typeof id === "string" && id.length > 0);
          if (taskIds.length > 0) {
            d(fetchTasksByIds({ projectId, taskIds })).then((result) => {
              if (fetchTasksByIds.fulfilled.match(result) && result.payload.length > 0) {
                try {
                  syncTasksToQueryCache(qc, projectId, result.payload);
                } catch {
                  // QueryClient may not be set in tests
                }
              }
            });
            // Do not invalidate tasks list — we sync fetched tasks to the cache above to avoid duplicate refetches
          }
        } else {
          void qc.invalidateQueries({ queryKey: queryKeys.feedback.list(projectId) });
        }
        break;
      }
      case "feedback.resolved": {
        const ev = event as FeedbackResolvedEvent;
        if (ev.item) {
          d(updateFeedbackItem(ev.item));
        } else {
          d(updateFeedbackItemResolved(ev.feedbackId));
        }
        void qc.invalidateQueries({ queryKey: queryKeys.feedback.list(projectId) });
        break;
      }

      case "deliver.started":
        d(deliverStarted({ deployId: event.deployId }));
        d(addToast({ message: "Delivery started", severity: "info" }));
        break;

      case "deliver.output":
        d(appendDeliverOutput({ deployId: event.deployId, chunk: event.chunk }));
        break;

      case "deliver.completed":
        d(
          deliverCompleted({
            deployId: event.deployId,
            success: event.success,
            fixEpicId: event.fixEpicId,
          })
        );
        d(
          addToast({
            message: event.success ? "Delivery succeeded" : "Delivery failed",
            severity: event.success ? "success" : "error",
          })
        );
        void qc.invalidateQueries({ queryKey: queryKeys.deliver.status(projectId) });
        void qc.invalidateQueries({ queryKey: queryKeys.deliver.history(projectId) });
        break;

      case "notification.added": {
        const ev = event as { type: "notification.added"; notification: Notification };
        if (ev.notification) {
          d(addNotification(ev.notification));
        }
        break;
      }

      case "notification.resolved": {
        const ev = event as {
          type: "notification.resolved";
          notificationId: string;
          projectId: string;
        };
        // Keep resolved notification in state when already updated (e.g. after user submitted answer)
        // so the UI can show "Answered" and the reply until the user dismisses.
        const state = storeApi.getState() as { openQuestions?: OpenQuestionsState };
        const projectNotifications = selectProjectNotifications(state, ev.projectId);
        const existing = projectNotifications.find((n) => n.id === ev.notificationId);
        if (existing?.status === "resolved") {
          // Already updated optimistically; leave in state so reply is visible
          break;
        }
        d(removeNotification({ projectId: ev.projectId, notificationId: ev.notificationId }));
        break;
      }

      case "agent.chat.received": {
        const chatRecv = event as AgentChatReceivedEvent;
        const chatState = (getState() as { agentChat?: AgentChatState }).agentChat;
        const msgs = chatState?.messagesByTaskId?.[chatRecv.taskId] ?? [];
        const hasUndelivered = msgs.some(
          (m) =>
            m.id === chatRecv.messageId ||
            (chatRecv.clientMessageId !== undefined &&
              m.clientMessageId === chatRecv.clientMessageId)
        );
        d(
          chatMessageReceived({
            taskId: chatRecv.taskId,
            messageId: chatRecv.messageId,
            timestamp: chatRecv.timestamp,
            clientMessageId: chatRecv.clientMessageId,
            attemptId: chatRecv.attemptId,
            status: chatRecv.status,
            error: chatRecv.error,
          })
        );
        if (!hasUndelivered) {
          void d(fetchAgentChatHistory({ projectId, taskId: chatRecv.taskId }));
        }
        void qc.invalidateQueries({
          queryKey: queryKeys.tasks.chatHistory(projectId, chatRecv.taskId),
        });
        break;
      }

      case "agent.chat.response": {
        const chatResp = event as AgentChatResponseEvent;
        d(
          chatResponseReceived({
            taskId: chatResp.taskId,
            messageId: chatResp.messageId,
            content: chatResp.content,
          })
        );
        void qc.invalidateQueries({
          queryKey: queryKeys.tasks.chatHistory(projectId, chatResp.taskId),
        });
        break;
      }

      case "agent.chat.unsupported": {
        const chatUnsup = event as AgentChatUnsupportedEvent;
        d(
          chatUnsupported({
            taskId: chatUnsup.taskId,
            reason: chatUnsup.reason,
            clientMessageId: chatUnsup.clientMessageId,
          })
        );
        break;
      }

      case "integration.sync.started":
        break;

      case "integration.sync.completed": {
        const syncEv = event as IntegrationSyncCompletedEvent;
        void qc.invalidateQueries({
          queryKey: queryKeys.integrations.status(projectId, syncEv.provider),
        });
        if (syncEv.provider === "todoist") {
          void qc.invalidateQueries({
            queryKey: queryKeys.integrations.todoistStatus(projectId),
          });
        }
        void qc.invalidateQueries({
          queryKey: queryKeys.integrations.all(projectId),
        });
        if (syncEv.imported > 0) {
          void qc.invalidateQueries({ queryKey: queryKeys.feedback.list(projectId) });
          if (syncEv.provider === "todoist") {
            const label =
              syncEv.imported === 1
                ? "1 item imported from Todoist"
                : `${syncEv.imported} items imported from Todoist`;
            d(
              addToast({
                message: label,
                severity: "success",
                timeout: 6000,
              })
            );
          }
        }
        break;
      }

      case "integration.sync.error":
        void qc.invalidateQueries({
          queryKey: queryKeys.integrations.all(projectId),
        });
        break;

      case "integration.connection.updated": {
        const connEv = event as IntegrationConnectionUpdatedEvent;
        void qc.invalidateQueries({
          queryKey: queryKeys.integrations.status(projectId, connEv.provider),
        });
        void qc.invalidateQueries({
          queryKey: queryKeys.integrations.all(projectId),
        });
        break;
      }
    }
  }

  return (next) => (action) => {
    // Unsubscribe from agent output before reducer clears agentOutput (memory cleanup)
    if (setSelectedTaskId.match(action) && action.payload === null) {
      const root = storeApi.getState() as {
        execute?: { selectedTaskId?: string | null };
      };
      const prev = root.execute?.selectedTaskId;
      if (
        prev &&
        ws?.readyState === WebSocket.OPEN &&
        currentProjectId &&
        currentProjectId !== HOME_SENTINEL
      ) {
        dispatch(wsSend({ type: "agent.unsubscribe", taskId: prev }));
      }
      const idx = pendingSubscribes.findIndex((p) => p.taskId === prev);
      if (idx >= 0) pendingSubscribes.splice(idx, 1);
    }
    if (wsConnect.match(action)) {
      connect(action.payload.projectId);
    } else if (wsConnectHome.match(action)) {
      connectHome();
    } else if (wsDisconnect.match(action)) {
      cleanup();
    } else if (wsSend.match(action)) {
      const event = action.payload as ClientEvent;
      if (
        ws?.readyState === WebSocket.OPEN &&
        currentProjectId &&
        currentProjectId !== HOME_SENTINEL
      ) {
        ws.send(JSON.stringify(event));
      } else if (event.type === "agent.chat.send") {
        storeApi.dispatch(
          chatUnsupported({
            taskId: event.taskId,
            clientMessageId: event.clientMessageId,
            reason: "No connection. Guidance was not sent; reconnect and try again.",
          })
        );
      } else if (
        event.type === "agent.subscribe" &&
        "taskId" in event &&
        event.taskId &&
        currentProjectId &&
        currentProjectId !== HOME_SENTINEL
      ) {
        // Queue subscribe so it replays when connection opens (fixes stuck live output)
        const idx = pendingSubscribes.findIndex((p) => p.taskId === event.taskId);
        if (idx >= 0) pendingSubscribes.splice(idx, 1);
        pendingSubscribes.push({ type: "agent.subscribe", taskId: event.taskId });
      } else if (
        event.type === "plan.agent.subscribe" &&
        "planId" in event &&
        event.planId &&
        currentProjectId &&
        currentProjectId !== HOME_SENTINEL
      ) {
        const idx = pendingPlanSubscribes.findIndex((p) => p.planId === event.planId);
        if (idx >= 0) pendingPlanSubscribes.splice(idx, 1);
        pendingPlanSubscribes.push({ type: "plan.agent.subscribe", planId: event.planId });
      }
    }

    return next(action);
  };
};
