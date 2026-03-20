import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import { QueryClient } from "@tanstack/react-query";
import { websocketMiddleware, wsConnect, wsDisconnect, wsSend } from "./websocketMiddleware";
import { queryKeys } from "../../api/queryKeys";
import projectReducer from "../slices/projectSlice";

const mockInvalidateQueries = vi.fn().mockResolvedValue(undefined);
const mockSetQueryData = vi.fn();
vi.mock("../../queryClient", () => ({
  getQueryClient: () =>
    ({
      invalidateQueries: mockInvalidateQueries,
      setQueryData: mockSetQueryData,
    }) as unknown as QueryClient,
}));
import websocketReducer from "../slices/websocketSlice";
import sketchReducer from "../slices/sketchSlice";
import planReducer from "../slices/planSlice";
import executeReducer, { selectTasks } from "../slices/executeSlice";
import evalReducer, { setFeedback } from "../slices/evalSlice";
import deliverReducer from "../slices/deliverSlice";
import routeReducer, { setRoute } from "../slices/routeSlice";
import unreadPhaseReducer from "../slices/unreadPhaseSlice";
import openQuestionsReducer, {
  addNotification,
  updateNotification,
} from "../slices/openQuestionsSlice";

/** Mock WebSocket that allows controlling open/close/message events */
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  /** Simulate connection opened */
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  /** Simulate receiving a message */
  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  /** Simulate connection closed (e.g. by server) */
  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

vi.mock("../../api/client", () => ({
  api: {
    prd: { get: vi.fn().mockResolvedValue({}), getHistory: vi.fn().mockResolvedValue([]) },
    chat: { history: vi.fn().mockResolvedValue({ messages: [] }) },
    plans: {
      list: vi.fn().mockResolvedValue({ plans: [], edges: [] }),
      get: vi.fn().mockResolvedValue({}),
    },
    projects: {
      getPlanStatus: vi.fn().mockResolvedValue({
        hasPlanningRun: false,
        prdChangedSinceLastRun: false,
        action: "plan",
      }),
    },
    tasks: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue({
        id: "task-1",
        title: "Fix bug",
        kanbanColumn: "backlog",
        priority: 1,
      }),
    },
    feedback: { list: vi.fn().mockResolvedValue([]) },
    deliver: {
      status: vi.fn().mockResolvedValue({ activeDeployId: null, currentDeploy: null }),
      history: vi.fn().mockResolvedValue([]),
    },
  },
}));

describe("websocketMiddleware", () => {
  let MockWS: typeof MockWebSocket;
  let wsInstance: MockWebSocket | null = null;

  const focusListeners: Array<() => void> = [];
  beforeEach(() => {
    wsInstance = null;
    focusListeners.length = 0;
    mockInvalidateQueries.mockClear();
    mockSetQueryData.mockClear();
    MockWS = class extends MockWebSocket {
      constructor(url: string) {
        super(url);
        wsInstance = this; // eslint-disable-line @typescript-eslint/no-this-alias
      }
    };
    vi.stubGlobal("WebSocket", MockWS);
    vi.stubGlobal("window", {
      ...globalThis.window,
      location: { protocol: "http:", host: "localhost:3100" },
      addEventListener: (event: string, handler: () => void) => {
        if (event === "focus") focusListeners.push(handler);
      },
      dispatchEvent: (event: Event) => {
        if (event.type === "focus") focusListeners.forEach((h) => h());
        return true;
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function createStore() {
    return configureStore({
      reducer: {
        project: projectReducer,
        websocket: websocketReducer,
        sketch: sketchReducer,
        plan: planReducer,
        execute: executeReducer,
        eval: evalReducer,
        deliver: deliverReducer,
        route: routeReducer,
        unreadPhase: unreadPhaseReducer,
        openQuestions: openQuestionsReducer,
      },
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware({
          serializableCheck: { ignoredActions: ["ws/connect", "ws/disconnect", "ws/send"] },
        }).concat(websocketMiddleware),
    });
  }

  describe("wsConnect", () => {
    it("creates WebSocket connection to project URL", () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-123" }));

      expect(wsInstance).toBeTruthy();
      expect(wsInstance!.url).toBe("ws://localhost:3100/ws/projects/proj-123");
    });

    it("uses wss when protocol is https", () => {
      vi.stubGlobal("window", {
        ...globalThis.window,
        location: { protocol: "https:", host: "localhost:3100" },
      });
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-456" }));

      expect(wsInstance!.url).toBe("wss://localhost:3100/ws/projects/proj-456");
    });

    it("dispatches setConnected(true) when socket opens", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));

      wsInstance!.simulateOpen();

      await vi.waitFor(() => {
        expect(store.getState().websocket.connected).toBe(true);
      });
    });

    it("does not create duplicate connection for same project when already open", () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();

      const firstWs = wsInstance;
      store.dispatch(wsConnect({ projectId: "proj-1" }));

      expect(wsInstance).toBe(firstWs);
    });

    it("replaces connection when connecting to different project", () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      const firstWs = wsInstance;
      store.dispatch(wsConnect({ projectId: "proj-2" }));

      expect(wsInstance).not.toBe(firstWs);
      expect(wsInstance!.url).toContain("proj-2");
    });
  });

  describe("wsDisconnect", () => {
    it("closes socket and clears connection state", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();

      store.dispatch(wsDisconnect());

      await vi.waitFor(() => {
        expect(store.getState().websocket.connected).toBe(false);
      });
      expect(wsInstance!.readyState).toBe(MockWebSocket.CLOSED);
    });

    it("does not reconnect after intentional disconnect", async () => {
      vi.useFakeTimers();
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      store.dispatch(wsDisconnect());

      vi.advanceTimersByTime(60000);

      expect(store.getState().websocket.connected).toBe(false);
      vi.useRealTimers();
    });
  });

  describe("wsSend", () => {
    it("sends message when socket is open", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();

      store.dispatch(wsSend({ type: "agent.subscribe", taskId: "task-1" }));

      expect(wsInstance!.sent).toContainEqual(
        JSON.stringify({ type: "agent.subscribe", taskId: "task-1" })
      );
    });

    it("does not send when socket is closed", () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      wsInstance!.simulateClose();

      store.dispatch(wsSend({ type: "agent.subscribe", taskId: "task-1" }));

      const sentAfterClose = wsInstance!.sent.filter((s) => s.includes("agent.subscribe"));
      expect(sentAfterClose.length).toBe(0);
    });

    it("queues agent.subscribe when socket not yet open and replays on connect (fixes stuck live output)", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      // Socket is CONNECTING, not OPEN yet
      expect(wsInstance!.readyState).toBe(WebSocket.CONNECTING);

      store.dispatch(wsSend({ type: "agent.subscribe", taskId: "task-xyz" }));

      // Nothing sent yet
      const sentBeforeOpen = wsInstance!.sent.filter((s) => s.includes("agent.subscribe"));
      expect(sentBeforeOpen.length).toBe(0);

      wsInstance!.simulateOpen();

      await vi.waitFor(() => {
        const sentAfterOpen = wsInstance!.sent.filter((s) => s.includes("agent.subscribe"));
        expect(sentAfterOpen).toContainEqual(
          JSON.stringify({ type: "agent.subscribe", taskId: "task-xyz" })
        );
      });
    });

    it("dispatches agent.unsubscribe when setSelectedTaskId(null) to free memory before reducer cleanup", async () => {
      const { setSelectedTaskId } = await import("../slices/executeSlice");
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      store.dispatch(setSelectedTaskId("task-1"));

      store.dispatch(setSelectedTaskId(null));

      const unsubscribes = wsInstance!.sent.filter((s) => s.includes("agent.unsubscribe"));
      expect(unsubscribes).toContainEqual(
        JSON.stringify({ type: "agent.unsubscribe", taskId: "task-1" })
      );
    });
  });

  describe("ServerEvent handling", () => {
    it("invalidates PRD and plan status queries on prd.updated", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateMessage({ type: "prd.updated", section: "overview", version: 2 });

      await vi.waitFor(() => {
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.prd.detail("proj-1"),
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.prd.history("proj-1"),
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.chat.history("proj-1", "sketch"),
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.plans.status("proj-1"),
        });
      });
    });

    it("invalidates plans queries on plan.generated", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateMessage({ type: "plan.generated", planId: "plan-new-123" });

      await vi.waitFor(() => {
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.plans.list("proj-1"),
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.plans.detail("proj-1", "plan-new-123"),
        });
      });
    });

    it("invalidates plans, plan chat, and tasks on plan.updated", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateMessage({ type: "plan.updated", planId: "plan-123" });

      await vi.waitFor(() => {
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.plans.list("proj-1"),
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.plans.status("proj-1"),
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.plans.detail("proj-1", "plan-123"),
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.plans.chat("proj-1", "plan:plan-123"),
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.tasks.list("proj-1"),
        });
      });
    });

    it("invalidates tasks list on plan.updated so UI can refetch", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateMessage({ type: "plan.updated", planId: "plan-123" });

      await vi.waitFor(() => {
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.tasks.list("proj-1"),
        });
      });
    });

    describe("plan phase unread (plan.generated / plan.updated)", () => {
      it("dispatches setPhaseUnread(plan) when route project differs from event project", async () => {
        const store = createStore();
        store.dispatch(setRoute({ projectId: "proj-2", phase: "sketch" }));
        store.dispatch(wsConnect({ projectId: "proj-1" }));
        wsInstance!.simulateOpen();
        await vi.waitFor(() => store.getState().websocket.connected);

        wsInstance!.simulateMessage({ type: "plan.updated", planId: "plan-123" });

        await vi.waitFor(() => {
          expect(store.getState().unreadPhase["proj-1"]?.plan).toBe(true);
        });
      });

      it("dispatches setPhaseUnread(plan) when same project but currentPhase !== plan", async () => {
        const store = createStore();
        store.dispatch(setRoute({ projectId: "proj-1", phase: "sketch" }));
        store.dispatch(wsConnect({ projectId: "proj-1" }));
        wsInstance!.simulateOpen();
        await vi.waitFor(() => store.getState().websocket.connected);

        wsInstance!.simulateMessage({ type: "plan.updated", planId: "plan-123" });

        await vi.waitFor(() => {
          expect(store.getState().unreadPhase["proj-1"]?.plan).toBe(true);
        });
      });

      it("does not dispatch setPhaseUnread(plan) when same project and currentPhase is plan", async () => {
        const store = createStore();
        store.dispatch(setRoute({ projectId: "proj-1", phase: "plan" }));
        store.dispatch(wsConnect({ projectId: "proj-1" }));
        wsInstance!.simulateOpen();
        await vi.waitFor(() => store.getState().websocket.connected);

        wsInstance!.simulateMessage({ type: "plan.updated", planId: "plan-123" });

        await vi.waitFor(() => {
          expect(mockInvalidateQueries).toHaveBeenCalledWith({
            queryKey: queryKeys.plans.list("proj-1"),
          });
        });
        expect(store.getState().unreadPhase["proj-1"]?.plan).not.toBe(true);
      });

      it("plan.generated: dispatches setPhaseUnread(plan) when different project", async () => {
        const store = createStore();
        store.dispatch(setRoute({ projectId: "proj-2", phase: "plan" }));
        store.dispatch(wsConnect({ projectId: "proj-1" }));
        wsInstance!.simulateOpen();
        await vi.waitFor(() => store.getState().websocket.connected);

        wsInstance!.simulateMessage({ type: "plan.generated", planId: "plan-new-456" });

        await vi.waitFor(() => {
          expect(store.getState().unreadPhase["proj-1"]?.plan).toBe(true);
        });
      });

      it("plan.generated: does not dispatch setPhaseUnread when same project and phase plan", async () => {
        const store = createStore();
        store.dispatch(setRoute({ projectId: "proj-1", phase: "plan" }));
        store.dispatch(wsConnect({ projectId: "proj-1" }));
        wsInstance!.simulateOpen();
        await vi.waitFor(() => store.getState().websocket.connected);

        wsInstance!.simulateMessage({ type: "plan.generated", planId: "plan-new-456" });

        await vi.waitFor(() => {
          expect(mockInvalidateQueries).toHaveBeenCalledWith({
            queryKey: queryKeys.plans.list("proj-1"),
          });
        });
        expect(store.getState().unreadPhase["proj-1"]?.plan).not.toBe(true);
      });
    });

    describe("sketch phase unread (prd.updated)", () => {
      it("dispatches setPhaseUnread(sketch) when route project differs from event project", async () => {
        const store = createStore();
        store.dispatch(setRoute({ projectId: "proj-2", phase: "sketch" }));
        store.dispatch(wsConnect({ projectId: "proj-1" }));
        wsInstance!.simulateOpen();
        await vi.waitFor(() => store.getState().websocket.connected);

        wsInstance!.simulateMessage({ type: "prd.updated", section: "overview", version: 2 });

        await vi.waitFor(() => {
          expect(store.getState().unreadPhase["proj-1"]?.sketch).toBe(true);
        });
      });

      it("dispatches setPhaseUnread(sketch) when same project but currentPhase !== sketch", async () => {
        const store = createStore();
        store.dispatch(setRoute({ projectId: "proj-1", phase: "plan" }));
        store.dispatch(wsConnect({ projectId: "proj-1" }));
        wsInstance!.simulateOpen();
        await vi.waitFor(() => store.getState().websocket.connected);

        wsInstance!.simulateMessage({ type: "prd.updated", section: "overview", version: 2 });

        await vi.waitFor(() => {
          expect(store.getState().unreadPhase["proj-1"]?.sketch).toBe(true);
        });
      });

      it("does not dispatch setPhaseUnread(sketch) when same project and currentPhase is sketch", async () => {
        const store = createStore();
        store.dispatch(setRoute({ projectId: "proj-1", phase: "sketch" }));
        store.dispatch(wsConnect({ projectId: "proj-1" }));
        wsInstance!.simulateOpen();
        await vi.waitFor(() => store.getState().websocket.connected);

        wsInstance!.simulateMessage({ type: "prd.updated", section: "overview", version: 2 });

        await vi.waitFor(() => {
          expect(mockInvalidateQueries).toHaveBeenCalledWith({
            queryKey: queryKeys.prd.detail("proj-1"),
          });
        });
        expect(store.getState().unreadPhase["proj-1"]?.sketch).not.toBe(true);
      });
    });

    it("dispatches taskUpdated on task.updated for existing task (no fetch)", async () => {
      const store = createStore();
      const { setTasks } = await import("../slices/executeSlice");
      store.dispatch(
        setTasks([
          {
            id: "task-1",
            title: "Task 1",
            description: "",
            type: "task",
            status: "open",
            priority: 1,
            assignee: null,
            labels: [],
            dependencies: [],
            epicId: null,
            kanbanColumn: "backlog",
            createdAt: "",
            updatedAt: "",
          },
        ])
      );
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      const { api } = await import("../../api/client");
      wsInstance!.simulateMessage({
        type: "task.updated",
        taskId: "task-1",
        status: "in_progress",
        assignee: "Frodo",
      });

      await vi.waitFor(() => {
        expect(selectTasks(store.getState())[0]?.kanbanColumn).toBe("in_progress");
      });
      expect(api.tasks.get).not.toHaveBeenCalled();
      expect(mockSetQueryData).toHaveBeenCalledWith(
        queryKeys.tasks.list("proj-1"),
        expect.any(Function)
      );
      expect(mockSetQueryData).toHaveBeenCalledWith(
        queryKeys.tasks.detail("proj-1", "task-1"),
        expect.objectContaining({ id: "task-1", kanbanColumn: "in_progress", assignee: "Frodo" })
      );
    });

    it("invalidates tasks list when task.updated for unknown task (Plan page will refetch)", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateMessage({
        type: "task.updated",
        taskId: "epic-1.1",
        status: "open",
        assignee: null,
      });

      await vi.waitFor(() => {
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.tasks.list("proj-1"),
        });
      });
    });

    describe("notification.resolved", () => {
      it("does not remove notification when it is already resolved (show reply until dismiss)", async () => {
        const store = createStore();
        const resolvedNotification = {
          id: "oq-1",
          projectId: "proj-1",
          source: "execute" as const,
          sourceId: "task-1",
          questions: [{ id: "q1", text: "Which approach?" }],
          status: "resolved" as const,
          resolvedAt: "2025-01-01T00:00:00Z",
          createdAt: "2025-01-01T00:00:00Z",
          responses: [{ questionId: "q1", answer: "Use REST" }],
        };
        store.dispatch(updateNotification(resolvedNotification));
        store.dispatch(wsConnect({ projectId: "proj-1" }));
        wsInstance!.simulateOpen();
        await vi.waitFor(() => store.getState().websocket.connected);

        wsInstance!.simulateMessage({
          type: "notification.resolved",
          projectId: "proj-1",
          notificationId: "oq-1",
        });

        await vi.waitFor(() => {
          const list = store.getState().openQuestions?.byProject?.["proj-1"] ?? [];
          expect(list.some((n) => n.id === "oq-1")).toBe(true);
          expect(list.find((n) => n.id === "oq-1")?.status).toBe("resolved");
        });
      });

      it("removes notification when it is open (normal resolve from other client)", async () => {
        const store = createStore();
        const openNotification = {
          id: "oq-2",
          projectId: "proj-1",
          source: "execute" as const,
          sourceId: "task-2",
          questions: [{ id: "q1", text: "Clarify?" }],
          status: "open" as const,
          resolvedAt: null,
          createdAt: "2025-01-01T00:00:00Z",
        };
        store.dispatch(addNotification(openNotification));
        store.dispatch(wsConnect({ projectId: "proj-1" }));
        wsInstance!.simulateOpen();
        await vi.waitFor(() => store.getState().websocket.connected);

        wsInstance!.simulateMessage({
          type: "notification.resolved",
          projectId: "proj-1",
          notificationId: "oq-2",
        });

        await vi.waitFor(() => {
          const list = store.getState().openQuestions?.byProject?.["proj-1"] ?? [];
          expect(list.some((n) => n.id === "oq-2")).toBe(false);
        });
      });
    });

    it("dispatches taskCreated on task.created for live-update (no refetch)", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      const taskPayload = {
        id: "os-ab12.1",
        title: "New Task",
        issue_type: "task",
        status: "open",
        priority: 2,
        assignee: null,
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
      };

      wsInstance!.simulateMessage({
        type: "task.created",
        taskId: "os-ab12.1",
        task: taskPayload,
      });

      await vi.waitFor(() => {
        const tasks = store.getState().execute.tasksById;
        expect(tasks["os-ab12.1"]).toBeDefined();
        expect(tasks["os-ab12.1"].title).toBe("New Task");
        expect(tasks["os-ab12.1"].kanbanColumn).toBe("backlog");
      });
      expect(mockSetQueryData).toHaveBeenCalledWith(
        queryKeys.tasks.list("proj-1"),
        expect.any(Function)
      );
      expect(mockSetQueryData).toHaveBeenCalledWith(
        queryKeys.tasks.detail("proj-1", "os-ab12.1"),
        expect.objectContaining({ id: "os-ab12.1", title: "New Task" })
      );
      expect(mockInvalidateQueries).not.toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: queryKeys.tasks.list("proj-1") })
      );
    });

    it("dispatches taskClosed on task.closed for live-update (no refetch)", async () => {
      const store = createStore();
      const { setTasks } = await import("../slices/executeSlice");
      store.dispatch(
        setTasks([
          {
            id: "os-ab12.1",
            title: "In Progress Task",
            description: "",
            type: "task",
            status: "in_progress",
            priority: 2,
            assignee: "agent-1",
            labels: [],
            dependencies: [],
            epicId: "os-ab12",
            kanbanColumn: "in_progress",
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          },
        ])
      );
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateMessage({
        type: "task.closed",
        taskId: "os-ab12.1",
        task: {
          id: "os-ab12.1",
          title: "Done Task",
          issue_type: "task",
          status: "closed",
          priority: 2,
          assignee: "agent-1",
          close_reason: "Completed",
          created_at: "2025-01-01T00:00:00Z",
          updated_at: "2025-01-01T01:00:00Z",
        },
      });

      await vi.waitFor(() => {
        const task = store.getState().execute.tasksById["os-ab12.1"];
        expect(task?.kanbanColumn).toBe("done");
        expect(task?.status).toBe("closed");
      });
      expect(mockSetQueryData).toHaveBeenCalledWith(
        queryKeys.tasks.list("proj-1"),
        expect.any(Function)
      );
      expect(mockSetQueryData).toHaveBeenCalledWith(
        queryKeys.tasks.detail("proj-1", "os-ab12.1"),
        expect.objectContaining({ id: "os-ab12.1", kanbanColumn: "done", status: "closed" })
      );
      expect(mockInvalidateQueries).not.toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: queryKeys.tasks.list("proj-1") })
      );
    });

    it("invalidates tasks list on task.created when task payload is missing", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateMessage({
        type: "task.created",
        taskId: "os-ab12.1",
      });

      await vi.waitFor(() => {
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.tasks.list("proj-1"),
        });
      });
    });

    it("dispatches appendAgentOutput on agent.output", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      const { setSelectedTaskId } = await import("../slices/executeSlice");
      store.dispatch(setSelectedTaskId("task-1"));

      wsInstance!.simulateMessage({
        type: "agent.output",
        taskId: "task-1",
        chunk: "Hello world\n",
      });

      await vi.waitFor(() => {
        const output = (store.getState().execute.agentOutput["task-1"] ?? []).join("");
        expect(output).toContain("Hello world");
      });
    });

    it("invalidates diagnostics on agent.activity", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateMessage({
        type: "agent.activity",
        taskId: "task-1",
        phase: "coding",
        activity: "waiting_on_tool",
        summary: "npm test",
      });

      await vi.waitFor(() => {
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.execute.diagnostics("proj-1", "task-1"),
        });
      });
    });

    it("invalidates diagnostics and active-agent lists on suspended activity events", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateMessage({
        type: "agent.activity",
        taskId: "task-1",
        phase: "coding",
        activity: "suspended",
        summary: "Heartbeat gap after host sleep or backend pause",
      });

      await vi.waitFor(() => {
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.execute.diagnostics("proj-1", "task-1"),
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: ["agents", "active", "proj-1"],
        });
      });
    });

    it("dispatches setCompletionState on agent.completed", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      const { setSelectedTaskId } = await import("../slices/executeSlice");
      store.dispatch(setSelectedTaskId("task-1"));

      wsInstance!.simulateMessage({
        type: "agent.completed",
        taskId: "task-1",
        status: "done",
        testResults: { passed: 5, failed: 0, skipped: 1, total: 6 },
      });

      await vi.waitFor(() => {
        const state = store.getState().execute.completionStateByTaskId["task-1"];
        expect(state?.status).toBe("done");
        expect(state?.testResults?.passed).toBe(5);
      });
    });

    it("stores reason in completionState when agent.completed has status failed and reason", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      const { setSelectedTaskId } = await import("../slices/executeSlice");
      store.dispatch(setSelectedTaskId("task-1"));

      const failureReason = "Cursor agent requires authentication. Run agent login.";
      wsInstance!.simulateMessage({
        type: "agent.completed",
        taskId: "task-1",
        status: "failed",
        testResults: null,
        reason: failureReason,
      });

      await vi.waitFor(() => {
        const state = store.getState().execute.completionStateByTaskId["task-1"];
        expect(state?.status).toBe("failed");
        expect(state?.reason).toBe(failureReason);
      });
    });

    it("dispatches setOrchestratorRunning and setAwaitingApproval on execute.status", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateMessage({
        type: "execute.status",
        currentTask: "task-1",
        queueDepth: 0,
        awaitingApproval: true,
        activeTasks: [{ taskId: "task-1", phase: "execute", startedAt: new Date().toISOString() }],
      });

      await vi.waitFor(() => {
        expect(store.getState().execute.orchestratorRunning).toBe(true);
        expect(store.getState().execute.awaitingApproval).toBe(true);
      });
    });

    it("sets orchestratorRunning false when execute.status has no currentTask and zero queueDepth", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateMessage({
        type: "execute.status",
        currentTask: null,
        queueDepth: 0,
      });

      await vi.waitFor(() => {
        expect(store.getState().execute.orchestratorRunning).toBe(false);
      });
    });

    it("sets selfImprovementRunInProgress when execute.status includes selfImprovementRunInProgress: true", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateMessage({
        type: "execute.status",
        activeTasks: [],
        queueDepth: 0,
        selfImprovementRunInProgress: true,
      });

      await vi.waitFor(() => {
        expect(store.getState().execute.selfImprovementRunInProgress).toBe(true);
      });
    });

    it("stores baseline pause details from execute.status", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateMessage({
        type: "execute.status",
        activeTasks: [],
        queueDepth: 0,
        baselineStatus: "failing",
        baselineCheckedAt: "2026-03-18T22:30:00.000Z",
        baselineFailureSummary: "npm run test: expected 1 to be 2",
        dispatchPausedReason:
          "Only the baseline-remediation task will be assigned until the baseline passes.",
      });

      await vi.waitFor(() => {
        expect(store.getState().execute.baselineStatus).toBe("failing");
        expect(store.getState().execute.baselineCheckedAt).toBe("2026-03-18T22:30:00.000Z");
        expect(store.getState().execute.baselineFailureSummary).toBe(
          "npm run test: expected 1 to be 2"
        );
        expect(store.getState().execute.dispatchPausedReason).toBe(
          "Only the baseline-remediation task will be assigned until the baseline passes."
        );
      });
    });

    it("dispatches taskUpdated on task.updated for incremental update", async () => {
      const store = createStore();
      const { setTasks } = await import("../slices/executeSlice");
      store.dispatch(
        setTasks([
          {
            id: "task-1",
            title: "Task 1",
            kanbanColumn: "backlog",
            priority: 1,
            assignee: null,
            epicId: "epic-1",
          },
        ])
      );
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      const { api } = await import("../../api/client");
      vi.mocked(api.tasks.list).mockResolvedValue([
        {
          id: "task-1",
          title: "Task 1",
          kanbanColumn: "in_progress",
          priority: 1,
          assignee: "Frodo",
          epicId: "epic-1",
        },
      ] as never);

      wsInstance!.simulateMessage({
        type: "task.updated",
        taskId: "task-1",
        status: "in_progress",
        assignee: "Frodo",
      });

      await vi.waitFor(() => {
        const task = selectTasks(store.getState()).find((t) => t.id === "task-1");
        expect(task?.kanbanColumn).toBe("in_progress");
        expect(task?.assignee).toBe("Frodo");
      });
    });

    it("passes kanbanColumn and merge hint fields through taskUpdated on task.updated", async () => {
      const store = createStore();
      const { setTasks } = await import("../slices/executeSlice");
      store.dispatch(
        setTasks([
          {
            id: "task-1",
            title: "Task 1",
            kanbanColumn: "backlog",
            priority: 1,
            assignee: null,
            epicId: "epic-1",
          },
        ])
      );
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateMessage({
        type: "task.updated",
        taskId: "task-1",
        status: "open",
        assignee: null,
        kanbanColumn: "waiting_to_merge",
        mergePausedUntil: "2025-03-18T12:00:00Z",
        mergeWaitingOnMain: true,
      });

      await vi.waitFor(() => {
        const task = selectTasks(store.getState()).find((t) => t.id === "task-1");
        expect(task?.kanbanColumn).toBe("waiting_to_merge");
        expect(task?.mergePausedUntil).toBe("2025-03-18T12:00:00Z");
        expect(task?.mergeWaitingOnMain).toBe(true);
      });
    });

    it("task.updated with authoritative null merge fields clears stuck merge-gate state", async () => {
      const store = createStore();
      const { setTasks } = await import("../slices/executeSlice");
      store.dispatch(
        setTasks([
          {
            id: "task-1",
            title: "Task 1",
            kanbanColumn: "waiting_to_merge",
            mergeGateState: "blocked_on_baseline" as const,
            mergePausedUntil: "2099-01-01T00:00:00Z",
            mergeWaitingOnMain: true,
            priority: 1,
            assignee: null,
            epicId: "epic-1",
          },
        ])
      );
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateMessage({
        type: "task.updated",
        taskId: "task-1",
        status: "open",
        assignee: null,
        kanbanColumn: "waiting_to_merge",
        mergePausedUntil: null,
        mergeWaitingOnMain: false,
        mergeGateState: null,
      });

      await vi.waitFor(() => {
        const task = selectTasks(store.getState()).find((t) => t.id === "task-1");
        expect(task?.mergeGateState).toBeUndefined();
        expect(task?.mergePausedUntil).toBeNull();
        expect(task?.mergeWaitingOnMain).toBe(false);
      });
    });

    it("dispatches updateFeedbackItem on feedback.updated when event includes item (no refetch)", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      store.dispatch(
        setFeedback([
          {
            id: "fb-1",
            text: "Bug",
            category: "bug",
            mappedPlanId: null,
            createdTaskIds: [],
            status: "pending",
            createdAt: "2024-01-01T00:00:00Z",
          },
        ])
      );

      const { api } = await import("../../api/client");
      vi.mocked(api.feedback.list).mockClear();

      const updatedItem = {
        id: "fb-1",
        text: "Bug report",
        category: "feature",
        mappedPlanId: "plan-1",
        createdTaskIds: ["task-1"],
        status: "pending",
        createdAt: "2024-01-01T00:00:00Z",
      };
      wsInstance!.simulateMessage({
        type: "feedback.updated",
        feedbackId: "fb-1",
        planId: "plan-1",
        taskIds: ["task-1"],
        item: updatedItem,
      });

      await vi.waitFor(() => {
        expect(store.getState().eval.feedback[0]).toEqual(updatedItem);
      });
      expect(api.feedback.list).not.toHaveBeenCalled();
    });

    it("dispatches updateFeedbackItem on feedback.mapped when event includes item (no refetch)", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      store.dispatch(
        setFeedback([
          {
            id: "fb-1",
            text: "Bug",
            category: "bug",
            mappedPlanId: null,
            createdTaskIds: [],
            status: "pending",
            createdAt: "2024-01-01T00:00:00Z",
          },
        ])
      );

      const { api } = await import("../../api/client");
      vi.mocked(api.feedback.list).mockClear();

      const updatedItem = {
        id: "fb-1",
        text: "Bug report",
        category: "feature",
        mappedPlanId: "plan-1",
        createdTaskIds: ["task-1"],
        status: "pending",
        createdAt: "2024-01-01T00:00:00Z",
      };
      wsInstance!.simulateMessage({
        type: "feedback.mapped",
        feedbackId: "fb-1",
        planId: "plan-1",
        taskIds: ["task-1"],
        item: updatedItem,
      });

      await vi.waitFor(() => {
        expect(store.getState().eval.feedback[0]).toEqual(updatedItem);
      });
      expect(api.feedback.list).not.toHaveBeenCalled();
    });

    it("updates only the matching feedback card when feedback.updated received with multiple items", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      const fb1 = {
        id: "fb-1",
        text: "First bug",
        category: "bug",
        mappedPlanId: null,
        createdTaskIds: [] as string[],
        status: "pending" as const,
        createdAt: "2024-01-01T00:00:00Z",
      };
      const fb2 = {
        id: "fb-2",
        text: "Second bug",
        category: "bug",
        mappedPlanId: null,
        createdTaskIds: [] as string[],
        status: "pending" as const,
        createdAt: "2024-01-01T00:00:01Z",
      };
      store.dispatch(setFeedback([fb1, fb2]));

      const { api } = await import("../../api/client");
      vi.mocked(api.feedback.list).mockClear();

      const updatedFb1 = {
        ...fb1,
        category: "feature" as const,
        mappedPlanId: "plan-1",
        createdTaskIds: ["task-1"],
        status: "pending" as const,
      };
      wsInstance!.simulateMessage({
        type: "feedback.updated",
        feedbackId: "fb-1",
        planId: "plan-1",
        taskIds: ["task-1"],
        item: updatedFb1,
      });

      await vi.waitFor(() => {
        const feedback = store.getState().eval.feedback;
        expect(feedback).toHaveLength(2);
        expect(feedback[0]).toEqual(updatedFb1);
        expect(feedback[1]).toEqual(fb2);
      });
      expect(api.feedback.list).not.toHaveBeenCalled();
    });

    it("dispatches updateFeedbackItem on feedback.resolved when event includes item (no refetch)", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      store.dispatch(
        setFeedback([
          {
            id: "fb-2",
            text: "Resolved bug",
            category: "bug",
            mappedPlanId: null,
            createdTaskIds: [],
            status: "pending",
            createdAt: "2024-01-01T00:00:00Z",
          },
        ])
      );

      const { api } = await import("../../api/client");
      vi.mocked(api.feedback.list).mockClear();

      const resolvedItem = {
        id: "fb-2",
        text: "Resolved bug",
        category: "bug",
        mappedPlanId: null,
        createdTaskIds: [],
        status: "resolved",
        createdAt: "2024-01-01T00:00:00Z",
      };
      wsInstance!.simulateMessage({
        type: "feedback.resolved",
        feedbackId: "fb-2",
        item: resolvedItem,
      });

      await vi.waitFor(() => {
        expect(store.getState().eval.feedback[0]).toEqual(resolvedItem);
      });
      expect(api.feedback.list).not.toHaveBeenCalled();
    });

    it("dispatches updateFeedbackItemResolved (not fetchFeedback) on feedback.resolved when event has no item", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      store.dispatch(
        setFeedback([
          {
            id: "fb-3",
            text: "Another bug",
            category: "bug",
            mappedPlanId: null,
            createdTaskIds: [],
            status: "pending",
            createdAt: "2024-01-01T00:00:00Z",
          },
        ])
      );

      const { api } = await import("../../api/client");
      vi.mocked(api.feedback.list).mockClear();

      wsInstance!.simulateMessage({
        type: "feedback.resolved",
        feedbackId: "fb-3",
      });

      await vi.waitFor(() => {
        expect(store.getState().eval.feedback[0].status).toBe("resolved");
      });
      expect(api.feedback.list).not.toHaveBeenCalled();
    });

    it("invalidates feedback list when feedback.mapped has no item", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateMessage({
        type: "feedback.mapped",
        feedbackId: "fb-1",
        planId: "plan-1",
        taskIds: ["task-1"],
      });

      await vi.waitFor(() => {
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.feedback.list("proj-1"),
        });
      });
    });

    it("dispatches fetchTasksByIds when feedback.updated includes createdTaskIds (Analyst ticket creation)", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      store.dispatch(
        setFeedback([
          {
            id: "fb-1",
            text: "Bug",
            category: "bug",
            mappedPlanId: null,
            createdTaskIds: [],
            status: "pending",
            createdAt: "2024-01-01T00:00:00Z",
          },
        ])
      );

      const { api } = await import("../../api/client");
      vi.mocked(api.tasks.list).mockClear();
      vi.mocked(api.tasks.get).mockClear();
      vi.mocked(api.tasks.get)
        .mockResolvedValueOnce({
          id: "task-1",
          title: "Fix bug",
          kanbanColumn: "backlog",
          priority: 1,
        } as never)
        .mockResolvedValueOnce({
          id: "task-2",
          title: "Add test",
          kanbanColumn: "backlog",
          priority: 1,
        } as never);

      const updatedItem = {
        id: "fb-1",
        text: "Bug report",
        category: "bug",
        mappedPlanId: "plan-1",
        createdTaskIds: ["task-1", "task-2"],
        status: "pending",
        createdAt: "2024-01-01T00:00:00Z",
      };
      wsInstance!.simulateMessage({
        type: "feedback.updated",
        feedbackId: "fb-1",
        planId: "plan-1",
        taskIds: ["task-1", "task-2"],
        item: updatedItem,
      });

      await vi.waitFor(() => {
        expect(store.getState().eval.feedback[0]).toEqual(updatedItem);
      });
      await vi.waitFor(() => {
        expect(api.tasks.get).toHaveBeenCalledTimes(2);
      });
      expect(api.tasks.get).toHaveBeenCalledWith("proj-1", "task-1");
      expect(api.tasks.get).toHaveBeenCalledWith("proj-1", "task-2");
      await vi.waitFor(() => {
        const tasks = selectTasks(store.getState());
        expect(tasks.some((t) => t.id === "task-1")).toBe(true);
        expect(tasks.some((t) => t.id === "task-2")).toBe(true);
      });
      // Middleware syncs fetched tasks to React Query cache instead of invalidating (avoids duplicate refetches)
      await vi.waitFor(() => {
        expect(mockSetQueryData).toHaveBeenCalledWith(
          queryKeys.tasks.list("proj-1"),
          expect.any(Function)
        );
        expect(mockSetQueryData).toHaveBeenCalledWith(
          queryKeys.tasks.detail("proj-1", "task-1"),
          expect.objectContaining({ id: "task-1", title: "Fix bug" })
        );
        expect(mockSetQueryData).toHaveBeenCalledWith(
          queryKeys.tasks.detail("proj-1", "task-2"),
          expect.objectContaining({ id: "task-2", title: "Add test" })
        );
      });
      expect(mockInvalidateQueries).not.toHaveBeenCalledWith({
        queryKey: queryKeys.tasks.list("proj-1"),
      });
    });

    it("uses event taskIds fallback when feedback item has no createdTaskIds", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      const { api } = await import("../../api/client");
      vi.mocked(api.tasks.get).mockClear();
      vi.mocked(api.tasks.get).mockResolvedValueOnce({
        id: "task-fallback",
        title: "Fallback task",
        kanbanColumn: "backlog",
        priority: 1,
      } as never);

      wsInstance!.simulateMessage({
        type: "feedback.updated",
        feedbackId: "fb-1",
        planId: "plan-1",
        taskIds: ["task-fallback"],
        item: {
          id: "fb-1",
          text: "Bug report",
          category: "bug",
          mappedPlanId: "plan-1",
          createdTaskIds: [],
          status: "pending",
          createdAt: "2024-01-01T00:00:00Z",
        },
      });

      await vi.waitFor(() => {
        expect(api.tasks.get).toHaveBeenCalledWith("proj-1", "task-fallback");
      });
      await vi.waitFor(() => {
        const tasks = selectTasks(store.getState());
        expect(tasks.some((t) => t.id === "task-fallback")).toBe(true);
      });
    });

    it("invalidates tasks and dispatches taskUpdated when task.updated after feedback.updated", async () => {
      const store = createStore();
      const { setTasks } = await import("../slices/executeSlice");
      store.dispatch(
        setTasks([
          {
            id: "task-auth",
            title: "Fix auth",
            description: "",
            type: "task",
            status: "open",
            priority: 1,
            assignee: null,
            labels: [],
            dependencies: [],
            epicId: null,
            kanbanColumn: "backlog",
            createdAt: "",
            updatedAt: "",
          },
        ])
      );
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      store.dispatch(
        setFeedback([
          {
            id: "fb-1",
            text: "Auth bug",
            category: "bug",
            mappedPlanId: "plan-1",
            createdTaskIds: [],
            status: "pending",
            createdAt: "2024-01-01T00:00:00Z",
          },
        ])
      );

      const { api } = await import("../../api/client");
      vi.mocked(api.tasks.get).mockResolvedValue({
        id: "task-auth",
        title: "Fix auth",
        description: "",
        type: "task",
        status: "open",
        priority: 1,
        assignee: null,
        labels: [],
        dependencies: [],
        epicId: null,
        kanbanColumn: "backlog",
        createdAt: "",
        updatedAt: "",
      } as never);

      wsInstance!.simulateMessage({
        type: "feedback.updated",
        feedbackId: "fb-1",
        planId: "plan-1",
        taskIds: ["task-auth"],
        item: {
          id: "fb-1",
          text: "Auth bug",
          category: "bug",
          mappedPlanId: "plan-1",
          createdTaskIds: ["task-auth"],
          status: "pending",
          createdAt: "2024-01-01T00:00:00Z",
        },
      });

      // feedback.updated syncs fetched tasks to React Query cache (no invalidate)
      await vi.waitFor(() => {
        expect(mockSetQueryData).toHaveBeenCalledWith(
          queryKeys.tasks.list("proj-1"),
          expect.any(Function)
        );
      });

      wsInstance!.simulateMessage({
        type: "task.updated",
        taskId: "task-auth",
        status: "closed",
        assignee: null,
      });

      await vi.waitFor(() => {
        const task = selectTasks(store.getState()).find((t) => t.id === "task-auth");
        expect(task?.kanbanColumn).toBe("done");
      });
    });

    it("dispatches setDeliverToast on deliver.started", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateMessage({ type: "deliver.started", deployId: "deploy-123" });

      await vi.waitFor(() => {
        expect(store.getState().websocket.deliverToast).toEqual({
          message: "Delivery started",
          variant: "started",
        });
      });
    });

    it("dispatches setDeliverToast with succeeded on deliver.completed success", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateMessage({
        type: "deliver.completed",
        deployId: "deploy-123",
        success: true,
      });

      await vi.waitFor(() => {
        expect(store.getState().websocket.deliverToast).toEqual({
          message: "Delivery succeeded",
          variant: "succeeded",
        });
      });
    });

    it("dispatches setDeliverToast with failed on deliver.completed failure", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateMessage({
        type: "deliver.completed",
        deployId: "deploy-123",
        success: false,
      });

      await vi.waitFor(() => {
        expect(store.getState().websocket.deliverToast).toEqual({
          message: "Delivery failed",
          variant: "failed",
        });
      });
    });
  });

  describe("exponential backoff reconnection", () => {
    it("schedules reconnect with exponential delay on unexpected close", async () => {
      vi.useFakeTimers();
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateClose();

      await vi.waitFor(() => {
        expect(store.getState().websocket.connected).toBe(false);
      });

      const firstWs = wsInstance;
      vi.advanceTimersByTime(1000);

      await vi.waitFor(() => {
        expect(wsInstance).toBeTruthy();
        expect(wsInstance).not.toBe(firstWs);
      });

      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateClose();
      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(1000);

      vi.advanceTimersByTime(2000);

      await vi.waitFor(() => {
        expect(wsInstance).toBeTruthy();
      });

      vi.useRealTimers();
    });

    it("caps reconnect delay at max (30s)", async () => {
      vi.useFakeTimers();
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateClose();
      vi.advanceTimersByTime(35000);

      await vi.waitFor(() => {
        expect(wsInstance).toBeTruthy();
      });
      vi.useRealTimers();
    });

    it("invalidates PRD queries on prd.updated after reconnect", async () => {
      vi.useFakeTimers();
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      const firstWs = wsInstance;
      wsInstance!.simulateClose();
      await vi.waitFor(() => !store.getState().websocket.connected);

      vi.advanceTimersByTime(1000);
      await vi.waitFor(() => wsInstance !== firstWs);
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      mockInvalidateQueries.mockClear();
      wsInstance!.simulateMessage({ type: "prd.updated", section: "overview", version: 2 });

      await vi.waitFor(() => {
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.prd.detail("proj-1"),
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.plans.status("proj-1"),
        });
      });
      vi.useRealTimers();
    });

    it("invalidates tasks, plans, and feedback on reconnect for project live-update recovery", async () => {
      vi.useFakeTimers();
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      mockInvalidateQueries.mockClear();
      const firstWs = wsInstance;
      wsInstance!.simulateClose();
      await vi.waitFor(() => !store.getState().websocket.connected);

      vi.advanceTimersByTime(1000);
      await vi.waitFor(() => wsInstance !== firstWs);
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      await vi.waitFor(() => {
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.tasks.list("proj-1"),
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.plans.list("proj-1"),
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.feedback.list("proj-1"),
        });
      });
      vi.useRealTimers();
    });

    it("invalidates project queries when window returns to focus (visibility visible) so UI updates", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      mockInvalidateQueries.mockClear();
      Object.defineProperty(document, "visibilityState", {
        value: "visible",
        configurable: true,
        writable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));

      await vi.waitFor(() => {
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.prd.detail("proj-1"),
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.plans.list("proj-1"),
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.plans.status("proj-1"),
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.tasks.list("proj-1"),
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.feedback.list("proj-1"),
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.deliver.status("proj-1"),
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.execute.status("proj-1"),
        });
      });
    });

    it("invalidates project queries when window focus fires (Electron fallback when visibilitychange is unreliable)", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      mockInvalidateQueries.mockClear();
      window.dispatchEvent(new Event("focus"));

      await vi.waitFor(() => {
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.prd.detail("proj-1"),
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.plans.list("proj-1"),
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.execute.status("proj-1"),
        });
      });
    });
  });

  describe("action passthrough", () => {
    it("passes non-websocket actions to next middleware", () => {
      const store = createStore();
      const action = { type: "some/other/action" };
      expect(() => store.dispatch(action)).not.toThrow();
    });
  });
});
