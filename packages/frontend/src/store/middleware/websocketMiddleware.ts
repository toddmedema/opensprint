import type { Middleware, ThunkDispatch, UnknownAction } from "@reduxjs/toolkit";
import { createAction } from "@reduxjs/toolkit";
import type { ServerEvent, ClientEvent } from "@opensprint/shared";
import { setConnected, setHilRequest, setHilNotification } from "../slices/websocketSlice";
import { fetchPrd, fetchPrdHistory, fetchDreamChat } from "../slices/dreamSlice";
import { fetchPlans, fetchSinglePlan } from "../slices/planSlice";
import { fetchTasks, fetchBuildStatus, appendAgentOutput, setOrchestratorRunning, setAwaitingApproval, setCompletionState } from "../slices/buildSlice";
import { fetchFeedback } from "../slices/verifySlice";

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
    cleanup();
    intentionalClose = false;
    currentProjectId = projectId;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws/projects/${projectId}`;

    ws = new WebSocket(url);

    ws.onopen = () => {
      reconnectAttempt = 0;
      dispatch(setConnected(true));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as ServerEvent;
        handleServerEvent(dispatch, projectId, data);
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = () => {
      dispatch(setConnected(false));
      if (!intentionalClose && currentProjectId) {
        scheduleReconnect(projectId);
      }
    };

    ws.onerror = () => {
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

  function handleServerEvent(
    d: StoreDispatch,
    projectId: string,
    event: ServerEvent,
  ) {
    switch (event.type) {
      case "hil.request":
        if (event.blocking) {
          d(setHilRequest(event));
          d(setHilNotification(null));
        } else {
          d(setHilNotification(event));
          d(setHilRequest(null));
        }
        break;

      case "prd.updated":
        d(fetchPrd(projectId));
        d(fetchPrdHistory(projectId));
        d(fetchDreamChat(projectId));
        break;

      case "plan.updated":
        d(fetchPlans(projectId));
        d(fetchSinglePlan({ projectId, planId: event.planId }));
        break;

      case "task.updated":
        d(fetchTasks(projectId));
        break;

      case "agent.started":
        d(fetchTasks(projectId));
        d(fetchBuildStatus(projectId));
        break;

      case "agent.completed":
        d(fetchTasks(projectId));
        d(fetchBuildStatus(projectId));
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

      case "build.status":
        d(setOrchestratorRunning(event.running));
        if ("awaitingApproval" in event) {
          d(setAwaitingApproval(Boolean(event.awaitingApproval)));
        }
        break;

      case "build.awaiting_approval":
        d(setAwaitingApproval(event.awaiting));
        break;

      case "feedback.mapped":
        d(fetchFeedback(projectId));
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
