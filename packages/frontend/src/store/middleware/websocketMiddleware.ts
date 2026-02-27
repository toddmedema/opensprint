import type { Middleware, ThunkDispatch, UnknownAction } from "@reduxjs/toolkit";
import { createAction } from "@reduxjs/toolkit";
import type {
  ServerEvent,
  ClientEvent,
  AgentCompletedEvent,
  ExecuteStatusEvent,
  FeedbackMappedEvent,
  FeedbackUpdatedEvent,
  FeedbackResolvedEvent,
  TaskPriority,
} from "@opensprint/shared";
import {
  setConnected,
  setHilRequest,
  setHilNotification,
  setDeliverToast,
} from "../slices/websocketSlice";
import { setConnectionError } from "../slices/connectionSlice";
import { fetchPrd, fetchPrdHistory, fetchSketchChat } from "../slices/sketchSlice";
import { fetchPlanStatus, fetchPlanChat, fetchPlans, fetchSinglePlan } from "../slices/planSlice";
import {
  fetchTasks,
  fetchTasksByIds,
  appendAgentOutput,
  setAgentOutputBackfill,
  setOrchestratorRunning,
  setAwaitingApproval,
  setActiveTasks,
  setCompletionState,
  taskUpdated,
} from "../slices/executeSlice";
import { fetchFeedback, updateFeedbackItem, updateFeedbackItemResolved } from "../slices/evalSlice";
import {
  appendDeliverOutput,
  deliverStarted,
  deliverCompleted,
  fetchDeliverStatus,
  fetchDeliverHistory,
} from "../slices/deliverSlice";

type StoreDispatch = ThunkDispatch<unknown, unknown, UnknownAction>;

export const wsConnect = createAction<{ projectId: string }>("ws/connect");
export const wsConnectHome = createAction("ws/connectHome");
export const wsDisconnect = createAction("ws/disconnect");
export const wsSend = createAction<ClientEvent>("ws/send");

/** Sentinel for "connected to /ws with no project" (so backend sees a client and does not open a duplicate tab on homepage) */
const HOME_SENTINEL = "__home__";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export const websocketMiddleware: Middleware = (storeApi) => {
  const dispatch = storeApi.dispatch as StoreDispatch;
  let ws: WebSocket | null = null;
  let currentProjectId: string | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let intentionalClose = false;

  /** Pending agent.subscribe messages to replay when connection opens (fixes stuck live output) */
  const pendingSubscribes: Array<{ type: "agent.subscribe"; taskId: string }> = [];

  function cleanup() {
    intentionalClose = true;
    pendingSubscribes.length = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.close();
      ws = null;
    }
    currentProjectId = null;
    reconnectAttempt = 0;
  }

  function connect(projectId: string) {
    // Skip if already connected to the same project
    if (currentProjectId === projectId && ws && ws.readyState === WebSocket.OPEN) {
      return;
    }

    cleanup();
    intentionalClose = false;
    currentProjectId = projectId;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws/projects/${projectId}`;

    const socket = new WebSocket(url);
    ws = socket;

    socket.onopen = () => {
      reconnectAttempt = 0;
      dispatch(setConnected(true));
      dispatch(setConnectionError(false));
      // Replay pending agent.subscribe so live output loads after reconnect
      for (const msg of pendingSubscribes) {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        }
      }
      pendingSubscribes.length = 0;
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as ServerEvent;
        handleServerEvent(dispatch, storeApi.getState, projectId, data);
      } catch {
        // ignore parse errors
      }
    };

    socket.onclose = () => {
      // Ignore if this is a stale socket (replaced by a newer connection)
      if (socket !== ws) return;
      dispatch(setConnected(false));
      if (!intentionalClose && currentProjectId) {
        scheduleReconnect(projectId);
      }
    };

    socket.onerror = () => {
      // onclose will fire after onerror
    };
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
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws`;
    const socket = new WebSocket(url);
    ws = socket;
    socket.onopen = () => {
      reconnectAttempt = 0;
      dispatch(setConnected(true));
      dispatch(setConnectionError(false));
    };
    socket.onmessage = () => {
      // No project scope — backend does not send project events to /ws-only clients
    };
    socket.onclose = () => {
      if (socket !== ws) return;
      dispatch(setConnected(false));
      if (!intentionalClose && currentProjectId === HOME_SENTINEL) {
        const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt), RECONNECT_MAX_MS);
        reconnectAttempt++;
        reconnectTimer = setTimeout(() => {
          if (currentProjectId === HOME_SENTINEL) connectHome();
        }, delay);
      }
    };
    socket.onerror = () => {};
  }

  // Reconnect immediately when tab becomes visible (helps after server restart; avoids throttled timers in background)
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible" || intentionalClose) return;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (currentProjectId === HOME_SENTINEL) connectHome();
        else if (currentProjectId) connect(currentProjectId);
      }
    });
  }

  function handleServerEvent(
    d: StoreDispatch,
    getState: () => unknown,
    projectId: string,
    event: ServerEvent
  ) {
    switch (event.type) {
      case "hil.request":
        if (event.blocking) {
          d(setHilRequest(event));
          d(setHilNotification(null));
          d(setAwaitingApproval(true));
        } else {
          d(setHilNotification(event));
          d(setHilRequest(null));
        }
        break;

      case "prd.updated":
        d(fetchPrd(projectId));
        d(fetchPrdHistory(projectId));
        d(fetchSketchChat(projectId));
        d(fetchPlanStatus(projectId));
        break;

      case "plan.generated":
        d(fetchPlans({ projectId, background: true }));
        d(fetchSinglePlan({ projectId, planId: event.planId }));
        break;

      case "plan.updated":
        d(fetchPlans({ projectId, background: true }));
        d(fetchSinglePlan({ projectId, planId: event.planId }));
        d(fetchPlanChat({ projectId, context: `plan:${event.planId}` }));
        d(fetchTasks(projectId));
        break;

      case "task.updated": {
        d(
          taskUpdated({
            taskId: event.taskId,
            status: event.status,
            assignee: event.assignee,
            priority: event.priority as TaskPriority | undefined,
            blockReason: event.blockReason,
          })
        );
        // For newly created tasks, taskUpdated is a no-op (task not in state). Fetch and merge so Plan page shows them in real time.
        const root = getState() as { execute?: { tasksById?: Record<string, unknown> } };
        const taskExists = root.execute?.tasksById != null && event.taskId in root.execute.tasksById;
        if (!taskExists) {
          d(fetchTasksByIds({ projectId, taskIds: [event.taskId] }));
        }
        break;
      }

      case "agent.started":
        d(fetchTasks(projectId));
        break;

      case "agent.completed": {
        const completed = event as AgentCompletedEvent;
        d(fetchTasks(projectId));
        d(
          setCompletionState({
            taskId: completed.taskId,
            status: completed.status,
            testResults: completed.testResults,
            reason: completed.reason,
          })
        );
        break;
      }

      case "agent.output":
        d(appendAgentOutput({ taskId: event.taskId, chunk: event.chunk }));
        break;

      case "agent.outputBackfill": {
        const backfill = event as { type: "agent.outputBackfill"; taskId: string; output: string };
        d(setAgentOutputBackfill({ taskId: backfill.taskId, output: backfill.output }));
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
        d(setActiveTasks(activeTasks));
        break;
      }

      case "feedback.mapped":
      case "feedback.updated": {
        const ev = event as FeedbackMappedEvent | FeedbackUpdatedEvent;
        if (ev.item) {
          d(updateFeedbackItem(ev.item));
          // Fetch only the new tasks so only the affected feedback card re-renders (not full page)
          if (ev.item.createdTaskIds?.length) {
            d(fetchTasksByIds({ projectId, taskIds: ev.item.createdTaskIds }));
          }
        } else {
          d(fetchFeedback(projectId));
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
        break;
      }

      case "deliver.started":
        d(deliverStarted({ deployId: event.deployId }));
        d(setDeliverToast({ message: "Delivery started", variant: "started" }));
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
          setDeliverToast({
            message: event.success ? "Delivery succeeded" : "Delivery failed",
            variant: event.success ? "succeeded" : "failed",
          })
        );
        d(fetchDeliverStatus(projectId));
        d(fetchDeliverHistory(projectId));
        break;
    }
  }

  return (next) => (action) => {
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
      }
    }

    return next(action);
  };
};
