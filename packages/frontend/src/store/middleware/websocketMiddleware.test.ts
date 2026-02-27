import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import { websocketMiddleware, wsConnect, wsDisconnect, wsSend } from "./websocketMiddleware";
import projectReducer from "../slices/projectSlice";
import websocketReducer from "../slices/websocketSlice";
import sketchReducer from "../slices/sketchSlice";
import planReducer from "../slices/planSlice";
import executeReducer, { selectTasks } from "../slices/executeSlice";
import evalReducer, { setFeedback } from "../slices/evalSlice";
import deliverReducer from "../slices/deliverSlice";

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
        sketch: sketchReducer,
        plan: planReducer,
        execute: executeReducer,
        eval: evalReducer,
        deliver: deliverReducer,
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
  });

  describe("ServerEvent handling", () => {
    it("dispatches to sketch and plan slices on prd.updated (fetchPrd, fetchPrdHistory, fetchSketchChat, fetchPlanStatus)", async () => {
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
        expect(store.getState().sketch.prdContent).toEqual({ overview: "Updated" });
        expect(store.getState().sketch.prdHistory).toHaveLength(1);
        expect(store.getState().sketch.messages).toHaveLength(1);
        expect(store.getState().plan.planStatus).toEqual({
          hasPlanningRun: false,
          prdChangedSinceLastRun: false,
          action: "plan",
        });
      });
    });

    it("dispatches fetchPlans and fetchSinglePlan on plan.generated (new plan live update)", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      const { api } = await import("../../api/client");
      vi.mocked(api.plans.list).mockClear();
      vi.mocked(api.plans.get).mockClear();

      wsInstance!.simulateMessage({ type: "plan.generated", planId: "plan-new-123" });

      await vi.waitFor(() => {
        expect(api.plans.list).toHaveBeenCalledWith("proj-1");
        expect(api.plans.get).toHaveBeenCalledWith("proj-1", "plan-new-123");
      });
    });

    it("dispatches to domain slices on plan.updated (background refresh, incl. fetchPlanChat, fetchTasks)", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      const { api } = await import("../../api/client");
      wsInstance!.simulateMessage({ type: "plan.updated", planId: "plan-123" });

      await vi.waitFor(() => {
        expect(api.plans.list).toHaveBeenCalledWith("proj-1");
        expect(api.plans.get).toHaveBeenCalledWith("proj-1", "plan-123");
        expect(api.chat.history).toHaveBeenCalledWith("proj-1", "plan:plan-123");
        expect(api.tasks.list).toHaveBeenCalledWith("proj-1");
      });
      expect(store.getState().plan.loading).toBe(false);
    });

    it("plan.updated after plan-tasks refreshes tasks so new tasks appear in UI", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      const { api } = await import("../../api/client");
      const newTasks = [
        {
          id: "epic-1.1",
          title: "Task A",
          description: "",
          type: "task" as const,
          status: "open" as const,
          priority: 1,
          assignee: null,
          labels: [],
          dependencies: [],
          epicId: "epic-1",
          kanbanColumn: "backlog" as const,
          createdAt: "",
          updatedAt: "",
        },
        {
          id: "epic-1.2",
          title: "Task B",
          description: "",
          type: "task" as const,
          status: "open" as const,
          priority: 1,
          assignee: null,
          labels: [],
          dependencies: [],
          epicId: "epic-1",
          kanbanColumn: "backlog" as const,
          createdAt: "",
          updatedAt: "",
        },
      ];
      vi.mocked(api.tasks.list).mockResolvedValue(newTasks as never);

      wsInstance!.simulateMessage({ type: "plan.updated", planId: "plan-123" });

      await vi.waitFor(() => {
        const tasks = selectTasks(store.getState());
        expect(tasks).toHaveLength(2);
        expect(tasks[0]?.title).toBe("Task A");
        expect(tasks[1]?.title).toBe("Task B");
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
    });

    it("fetches new task via fetchTasksByIds when task.updated for unknown task (Plan page live loading)", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      const { api } = await import("../../api/client");
      const newTask = {
        id: "epic-1.1",
        title: "Newly created task",
        description: "",
        type: "task" as const,
        status: "open" as const,
        priority: 1,
        assignee: null,
        labels: [],
        dependencies: [],
        epicId: "epic-1",
        kanbanColumn: "backlog" as const,
        createdAt: "",
        updatedAt: "",
      };
      vi.mocked(api.tasks.get).mockResolvedValue(newTask as never);

      wsInstance!.simulateMessage({
        type: "task.updated",
        taskId: "epic-1.1",
        status: "open",
        assignee: null,
      });

      await vi.waitFor(() => {
        expect(api.tasks.get).toHaveBeenCalledWith("proj-1", "epic-1.1");
      });
      await vi.waitFor(() => {
        const tasks = selectTasks(store.getState());
        expect(tasks).toHaveLength(1);
        expect(tasks[0]?.title).toBe("Newly created task");
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
        const state = store.getState().execute.completionState;
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

    it("dispatches fetchFeedback on feedback.mapped when event has no item (legacy fallback)", async () => {
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
      expect(api.tasks.list).not.toHaveBeenCalled();
      expect(api.tasks.get).toHaveBeenCalledWith("proj-1", "task-1");
      expect(api.tasks.get).toHaveBeenCalledWith("proj-1", "task-2");
      await vi.waitFor(() => {
        const tasks = selectTasks(store.getState());
        expect(tasks).toHaveLength(2);
        expect(tasks.map((t) => t.id)).toEqual(expect.arrayContaining(["task-1", "task-2"]));
      });
    });

    it("live-updates feedback card when task.updated received after feedback.updated (status change)", async () => {
      const store = createStore();
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
        kanbanColumn: "backlog",
        priority: 1,
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

      await vi.waitFor(() => {
        const tasks = selectTasks(store.getState());
        expect(tasks.some((t) => t.id === "task-auth")).toBe(true);
      });
      expect(selectTasks(store.getState()).find((t) => t.id === "task-auth")?.kanbanColumn).toBe(
        "backlog"
      );

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
        expect(store.getState().sketch.prdContent).toEqual({ overview: "After reconnect" });
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
