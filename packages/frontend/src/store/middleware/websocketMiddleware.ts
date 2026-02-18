import type { Middleware, ThunkDispatch, UnknownAction } from "@reduxjs/toolkit";
import { createAction } from "@reduxjs/toolkit";
import type { ServerEvent, ClientEvent } from "@opensprint/shared";
import { setConnected, setHilRequest, setHilNotification, setDeployToast } from "../slices/websocketSlice";
import { fetchPrd, fetchPrdHistory, fetchSpecChat } from "../slices/specSlice";
import { fetchPlanStatus } from "../slices/planSlice";
import { fetchPlans, fetchSinglePlan } from "../slices/planSlice";
import {
  fetchTasks,
  appendAgentOutput,
  setOrchestratorRunning,
  setAwaitingApproval,
  setCurrentTaskAndPhase,
  setCompletionState,
  taskUpdated,
} from "../slices/executeSlice";
import { fetchFeedback } from "../slices/evalSlice";
import {
  appendDeployOutput,
  deployStarted,
  deployCompleted,
  fetchDeployStatus,
  fetchDeployHistory,
} from "../slices/deploySlice";

type StoreDispatch = ThunkDispatch<unknown, unknown, UnknownAction>;

export const wsConnect = createAction<{ projectId: string }>("ws/connect");
export const wsDisconnect = createAction("ws/disconnect");
export const wsSend = createAction<ClientEvent>("ws/send");

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export const websocketMiddleware: Middleware = (storeApi) => {
  const dispatch = storeApi.dispatch as StoreDispatch;
  let ws: WebSocket | null = null;
  let currentProjectId: string | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let intentionalClose = false;

  function cleanup() {
    intentionalClose = true;
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
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as ServerEvent;
        handleServerEvent(dispatch, projectId, data);
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

  function handleServerEvent(d: StoreDispatch, projectId: string, event: ServerEvent) {
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
        d(fetchSpecChat(projectId));
        d(fetchPlanStatus(projectId));
        break;

      case "plan.updated":
        d(fetchPlans(projectId));
        d(fetchSinglePlan({ projectId, planId: event.planId }));
        break;

      case "task.updated":
        d(taskUpdated({ taskId: event.taskId, status: event.status, assignee: event.assignee }));
        d(fetchTasks(projectId));
        break;

      case "agent.started":
        d(fetchTasks(projectId));
        break;

      case "agent.completed":
        d(fetchTasks(projectId));
        d(
          setCompletionState({
            taskId: event.taskId,
            status: event.status,
            testResults: event.testResults,
          }),
        );
        break;

      case "agent.output":
        d(appendAgentOutput({ taskId: event.taskId, chunk: event.chunk }));
        break;

      case "execute.status": {
        const running = event.currentTask !== null || event.queueDepth > 0;
        d(setOrchestratorRunning(running));
        if ("awaitingApproval" in event) {
          d(setAwaitingApproval(Boolean(event.awaitingApproval)));
        }
        d(
          setCurrentTaskAndPhase({
            currentTaskId: event.currentTask ?? null,
            currentPhase: event.currentPhase ?? null,
          }),
        );
        break;
      }

      case "feedback.mapped":
      case "feedback.resolved":
        d(fetchFeedback(projectId));
        break;

      case "deploy.started":
        d(deployStarted({ deployId: event.deployId }));
        d(setDeployToast({ message: "Deployment started", variant: "started" }));
        break;

      case "deploy.output":
        d(appendDeployOutput({ deployId: event.deployId, chunk: event.chunk }));
        break;

      case "deploy.completed":
        d(
          deployCompleted({
            deployId: event.deployId,
            success: event.success,
            fixEpicId: event.fixEpicId,
          }),
        );
        d(
          setDeployToast({
            message: event.success ? "Deployment succeeded" : "Deployment failed",
            variant: event.success ? "succeeded" : "failed",
          }),
        );
        d(fetchDeployStatus(projectId));
        d(fetchDeployHistory(projectId));
        break;
    }
  }

  return (next) => (action) => {
    if (wsConnect.match(action)) {
      connect(action.payload.projectId);
    } else if (wsDisconnect.match(action)) {
      cleanup();
    } else if (wsSend.match(action)) {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(action.payload));
      }
    }

    return next(action);
  };
};
