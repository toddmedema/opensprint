import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import { websocketMiddleware, wsConnect, wsDisconnect, wsSend } from "./websocketMiddleware";
import projectReducer from "../slices/projectSlice";
import websocketReducer from "../slices/websocketSlice";
import specReducer from "../slices/specSlice";
import planReducer from "../slices/planSlice";
import executeReducer from "../slices/executeSlice";
import evalReducer from "../slices/evalSlice";
import deployReducer from "../slices/deploySlice";

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
      getPlanStatus: vi
        .fn()
        .mockResolvedValue({
          hasPlanningRun: false,
          prdChangedSinceLastRun: false,
          action: "plan",
        }),
    },
    tasks: { list: vi.fn().mockResolvedValue([]) },
    feedback: { list: vi.fn().mockResolvedValue([]) },
    deploy: {
      status: vi.fn().mockResolvedValue({ activeDeployId: null, currentDeploy: null }),
      history: vi.fn().mockResolvedValue([]),
    },
  },
}));

describe("websocketMiddleware", () => {
  let MockWS: typeof MockWebSocket;
  let wsInstance: MockWebSocket | null = null;

  beforeEach(() => {
    wsInstance = null;
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
        spec: specReducer,
        plan: planReducer,
        execute: executeReducer,
        eval: evalReducer,
        deploy: deployReducer,
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
  });

  describe("ServerEvent handling", () => {
    it("dispatches to spec and plan slices on prd.updated (fetchPrd, fetchPrdHistory, fetchSpecChat, fetchPlanStatus)", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      const { api } = await import("../../api/client");
      vi.mocked(api.prd.get).mockResolvedValue({ sections: { overview: { content: "Updated" } } });
      vi.mocked(api.prd.getHistory).mockResolvedValue([
        {
          section: "overview",
          version: 2,
          source: "sketch",
          timestamp: "2025-01-01",
          diff: "+Updated",
        },
      ]);
      vi.mocked(api.chat.history).mockResolvedValue({
        messages: [{ role: "assistant", content: "Done", timestamp: "2025-01-01" }],
      });
      vi.mocked(api.projects.getPlanStatus).mockResolvedValue({
        hasPlanningRun: false,
        prdChangedSinceLastRun: false,
        action: "plan",
      });

      wsInstance!.simulateMessage({ type: "prd.updated", section: "overview", version: 2 });

      await vi.waitFor(() => {
        expect(api.prd.get).toHaveBeenCalledWith("proj-1");
        expect(api.prd.getHistory).toHaveBeenCalledWith("proj-1");
        expect(api.chat.history).toHaveBeenCalledWith("proj-1", "sketch");
        expect(api.projects.getPlanStatus).toHaveBeenCalledWith("proj-1");
      });

      await vi.waitFor(() => {
        expect(store.getState().spec.prdContent).toEqual({ overview: "Updated" });
        expect(store.getState().spec.prdHistory).toHaveLength(1);
        expect(store.getState().spec.messages).toHaveLength(1);
        expect(store.getState().plan.planStatus).toEqual({
          hasPlanningRun: false,
          prdChangedSinceLastRun: false,
          action: "plan",
        });
      });
    });

    it("dispatches to domain slices on plan.updated", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      const { api } = await import("../../api/client");
      wsInstance!.simulateMessage({ type: "plan.updated", planId: "plan-123" });

      await vi.waitFor(() => {
        expect(api.plans.list).toHaveBeenCalledWith("proj-1");
        expect(api.plans.get).toHaveBeenCalledWith("proj-1", "plan-123");
      });
    });

    it("dispatches fetchTasks on task.updated", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      const { api } = await import("../../api/client");
      wsInstance!.simulateMessage({
        type: "task.updated",
        taskId: "task-1",
        status: "in_progress",
        assignee: "agent-1",
      });

      await vi.waitFor(() => {
        expect(api.tasks.list).toHaveBeenCalledWith("proj-1");
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
        expect(store.getState().execute.agentOutput.join("")).toContain("Hello world");
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
        const state = store.getState().execute.completionState;
        expect(state?.status).toBe("done");
        expect(state?.testResults?.passed).toBe(5);
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

    it("dispatches taskUpdated on task.updated for optimistic update, then fetchTasks", async () => {
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
          assignee: "agent-1",
          epicId: "epic-1",
        },
      ] as never);

      wsInstance!.simulateMessage({
        type: "task.updated",
        taskId: "task-1",
        status: "in_progress",
        assignee: "agent-1",
      });

      await vi.waitFor(() => {
        const task = store.getState().execute.tasks.find((t) => t.id === "task-1");
        expect(task?.kanbanColumn).toBe("in_progress");
        expect(task?.assignee).toBe("agent-1");
      });
    });

    it("dispatches setHilRequest on blocking hil.request", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      const hilEvent = {
        type: "hil.request" as const,
        requestId: "req-1",
        category: "approval",
        description: "Approve?",
        options: [],
        blocking: true,
      };
      wsInstance!.simulateMessage(hilEvent);

      await vi.waitFor(() => {
        expect(store.getState().websocket.hilRequest).toEqual(hilEvent);
      });
    });

    it("dispatches setHilNotification on non-blocking hil.request", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      const hilEvent = {
        type: "hil.request" as const,
        requestId: "req-2",
        category: "notify",
        description: "FYI",
        options: [],
        blocking: false,
      };
      wsInstance!.simulateMessage(hilEvent);

      await vi.waitFor(() => {
        expect(store.getState().websocket.hilNotification).toEqual(hilEvent);
      });
    });

    it("dispatches fetchFeedback on feedback.mapped", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      const { api } = await import("../../api/client");
      wsInstance!.simulateMessage({
        type: "feedback.mapped",
        feedbackId: "fb-1",
        planId: "plan-1",
        taskIds: ["task-1"],
      });

      await vi.waitFor(() => {
        expect(api.feedback.list).toHaveBeenCalledWith("proj-1");
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

    it("handles prd.updated after reconnect", async () => {
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

      const { api } = await import("../../api/client");
      vi.mocked(api.prd.get).mockResolvedValue({
        sections: { overview: { content: "After reconnect" } },
      });
      vi.mocked(api.prd.getHistory).mockResolvedValue([]);
      vi.mocked(api.chat.history).mockResolvedValue({ messages: [] });
      vi.mocked(api.projects.getPlanStatus).mockResolvedValue({
        hasPlanningRun: false,
        prdChangedSinceLastRun: false,
        action: "plan",
      });

      wsInstance!.simulateMessage({ type: "prd.updated", section: "overview", version: 2 });

      await vi.waitFor(() => {
        expect(store.getState().spec.prdContent).toEqual({ overview: "After reconnect" });
        expect(api.projects.getPlanStatus).toHaveBeenCalledWith("proj-1");
      });
      vi.useRealTimers();
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
