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
  TaskEventPayload,
  TaskPriority,
  Notification,
} from "@opensprint/shared";
import { setConnected, setDeliverToast } from "../slices/websocketSlice";
import { addNotification, removeNotification } from "../slices/openQuestionsSlice";
import { setConnectionError } from "../slices/connectionSlice";
import {
  appendAgentOutput,
  setAgentOutputBackfill,
  setOrchestratorRunning,
  setAwaitingApproval,
  setActiveTasks,
  setCompletionState,
  setSelectedTaskId,
  taskUpdated,
  taskCreated,
  taskClosed,
} from "../slices/executeSlice";
import { updateFeedbackItem, updateFeedbackItemResolved } from "../slices/evalSlice";
import { appendDeliverOutput, deliverStarted, deliverCompleted } from "../slices/deliverSlice";
import {
  appendAuditorOutput,
  setAuditorOutputBackfill,
} from "../slices/planSlice";
import { getQueryClient } from "../../queryClient";
import { queryKeys } from "../../api/queryKeys";

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
  /** True after first successful connect; used to invalidate queries on reconnect (graceful recovery) */
  let hadConnection = false;

  /** Pending agent.subscribe messages to replay when connection opens (fixes stuck live output) */
  const pendingSubscribes: Array<{ type: "agent.subscribe"; taskId: string }> = [];
  /** Pending plan.agent.subscribe messages to replay when connection opens */
  const pendingPlanSubscribes: Array<{ type: "plan.agent.subscribe"; planId: string }> = [];

  function cleanup() {
    intentionalClose = true;
    pendingSubscribes.length = 0;
    pendingPlanSubscribes.length = 0;
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
      // On reconnect: invalidate tasks and plans so Execute page gets fresh data
      if (hadConnection) {
        try {
          const qc = getQueryClient();
          void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
          void qc.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
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
    const qc = getQueryClient();
    switch (event.type) {
      case "prd.updated":
        void qc.invalidateQueries({ queryKey: queryKeys.prd.detail(projectId) });
        void qc.invalidateQueries({ queryKey: queryKeys.prd.history(projectId) });
        void qc.invalidateQueries({ queryKey: queryKeys.chat.history(projectId, "sketch") });
        void qc.invalidateQueries({ queryKey: queryKeys.plans.status(projectId) });
        break;

      case "plan.generated":
        void qc.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
        void qc.invalidateQueries({
          queryKey: queryKeys.plans.detail(projectId, event.planId),
        });
        break;

      case "plan.updated":
        void qc.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
        void qc.invalidateQueries({
          queryKey: queryKeys.plans.detail(projectId, event.planId),
        });
        void qc.invalidateQueries({
          queryKey: queryKeys.plans.chat(projectId, `plan:${event.planId}`),
        });
        void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
        break;

      case "task.created": {
        const created = event as { type: "task.created"; task: TaskEventPayload };
        if (created.task) {
          d(taskCreated(created.task));
        } else {
          void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
        }
        break;
      }
      case "task.closed": {
        const closed = event as { type: "task.closed"; task: TaskEventPayload };
        if (closed.task) {
          d(taskClosed(closed.task));
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
          })
        );
        const root = getState() as { execute?: { tasksById?: Record<string, unknown> } };
        const taskExists =
          root.execute?.tasksById != null && event.taskId in root.execute.tasksById;
        if (!taskExists) {
          void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
        }
        break;
      }

      case "agent.started":
        void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
        void qc.invalidateQueries({ queryKey: ["agents", "active", projectId] });
        break;

      case "agent.activity":
        void qc.invalidateQueries({
          queryKey: queryKeys.execute.diagnostics(projectId, event.taskId),
        });
        void qc.invalidateQueries({ queryKey: ["agents", "active", projectId] });
        break;

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
        d(setActiveTasks(activeTasks));
        break;
      }

      case "feedback.mapped":
      case "feedback.updated": {
        const ev = event as FeedbackMappedEvent | FeedbackUpdatedEvent;
        if (ev.item) {
          d(updateFeedbackItem(ev.item));
          if (ev.item.createdTaskIds?.length) {
            void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
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
        d(removeNotification({ projectId: ev.projectId, notificationId: ev.notificationId }));
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
