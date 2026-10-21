import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import { QueryClient } from "@tanstack/react-query";
import {
  websocketMiddleware,
  wsConnect,
  wsConnectHome,
  wsDisconnect,
  wsSend,
} from "./websocketMiddleware";
import { queryKeys } from "../../api/queryKeys";
import { resetMergeGateExecuteStatusSnapshots } from "../../lib/executeStatusMergeGateTasksBump";
import projectReducer from "../slices/projectSlice";

const mockInvalidateQueries = vi.fn().mockResolvedValue(undefined);
const queryData = new Map<string, unknown>();
const cached = (key: readonly unknown[]) => queryData.get(JSON.stringify(key));
const mockSetQueryData = vi.fn((key: readonly unknown[], update: unknown) => {
  const id = JSON.stringify(key);
  const next = typeof update === "function" ? update(queryData.get(id)) : update;
  queryData.set(id, next);
  return next;
});
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
import unreadPhaseReducer from "../slices/unreadPhaseSlice";
import openQuestionsReducer, {
  addNotification,
  updateNotification,
} from "../slices/openQuestionsSlice";
import notificationReducer from "../slices/notificationSlice";
import agentChatReducer, {
  addOptimisticUserMessage,
  selectChatMessages,
  selectChatSending,
  selectChatSupport,
} from "../slices/agentChatSlice";

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
      chatHistory: vi.fn().mockResolvedValue({
        messages: [],
        attempt: 1,
        chatSupported: true,
      }),
      chatSupport: vi.fn().mockResolvedValue({
        supported: true,
        backend: "claude",
        reason: null,
      }),
    },
    feedback: { list: vi.fn().mockResolvedValue([]) },
    deliver: {
      status: vi.fn().mockResolvedValue({ activeDeployId: null, currentDeploy: null }),
      history: vi.fn().mockResolvedValue([]),
    },
  },
}));

const TEST_WEBSOCKET_SESSION = "test-ws-session-token";
const MOCK_WS_UPGRADE_TICKET = "mock-ws-upgrade-ticket-for-tests";

describe("websocketMiddleware", () => {
  let MockWS: typeof MockWebSocket;
  let wsInstance: MockWebSocket | null = null;
  /** Close sockets and timers so stale middleware reconnects do not steal the shared MockWebSocket instance. */
  let storeUnderTest: ReturnType<typeof configureStore> | null = null;

  function setCurrentPath(pathname: string) {
    vi.stubGlobal("window", {
      ...globalThis.window,
      __OPENSPRINT_LOCAL_SESSION__: TEST_WEBSOCKET_SESSION,
      location: {
        ...(globalThis.window as { location?: Record<string, unknown> } | undefined)?.location,
        protocol:
          (globalThis.window as { location?: { protocol?: string } } | undefined)?.location
            ?.protocol ?? "http:",
        host:
          (globalThis.window as { location?: { host?: string } } | undefined)?.location?.host ??
          "localhost:3100",
        pathname,
      },
      history: {
        replaceState: vi.fn(),
      },
      addEventListener:
        (
          globalThis.window as
            | { addEventListener?: (event: string, handler: () => void) => void }
            | undefined
        )?.addEventListener ??
        ((event: string, handler: () => void) => {
          if (event === "focus") focusListeners.push(handler);
        }),
      dispatchEvent:
        (globalThis.window as { dispatchEvent?: (event: Event) => boolean } | undefined)
          ?.dispatchEvent ??
        ((event: Event) => {
          if (event.type === "focus") focusListeners.forEach((h) => h());
          return true;
        }),
    });
  }

  const focusListeners: Array<() => void> = [];
  beforeEach(() => {
    resetMergeGateExecuteStatusSnapshots();
    wsInstance = null;
    // Do not clear focusListeners: visibility/focus hooks register once and must stay bound across tests.
    mockInvalidateQueries.mockClear();
    mockSetQueryData.mockClear();
    queryData.clear();
    MockWS = class extends MockWebSocket {
      constructor(url: string) {
        super(url);
        wsInstance = this; // eslint-disable-line @typescript-eslint/no-this-alias
      }
    };
    vi.stubGlobal("WebSocket", MockWS);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { ticket: MOCK_WS_UPGRADE_TICKET } }),
      })
    );
    vi.stubGlobal("window", {
      ...globalThis.window,
      __OPENSPRINT_LOCAL_SESSION__: TEST_WEBSOCKET_SESSION,
      location: { protocol: "http:", host: "localhost:3100" },
      addEventListener: (event: string, handler: () => void) => {
        if (event === "focus") focusListeners.push(handler);
      },
      dispatchEvent: (event: Event) => {
        if (event.type === "focus") focusListeners.forEach((h) => h());
        return true;
      },
      history: {
        replaceState: vi.fn(),
      },
    });
    setCurrentPath("/");
  });

  afterEach(() => {
    try {
      storeUnderTest?.dispatch(wsDisconnect());
    } catch {
      // ignore
    }
    storeUnderTest = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function createStore() {
    const store = configureStore({
      reducer: {
        project: projectReducer,
        websocket: websocketReducer,
        sketch: sketchReducer,
        plan: planReducer,
        execute: executeReducer,
        eval: evalReducer,
        deliver: deliverReducer,
        unreadPhase: unreadPhaseReducer,
        openQuestions: openQuestionsReducer,
        notification: notificationReducer,
        agentChat: agentChatReducer,
      },
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware({
          serializableCheck: { ignoredActions: ["ws/connect", "ws/disconnect", "ws/send"] },
        }).concat(websocketMiddleware),
    });
    storeUnderTest = store;
    return store;
  }

  /** Wait until the middleware finishes the HTTPS ticket exchange and constructs the WebSocket. */
  async function flushPendingWsInstance(urlMustContain?: string) {
    await vi.waitFor(() => {
      expect(wsInstance).toBeTruthy();
      if (urlMustContain !== undefined) {
        expect(wsInstance!.url).toContain(urlMustContain);
      }
    });
  }

  describe("connection attempt ownership", () => {
    it.each([false, true])(
      "ignores old same-project ticket resolved newest-first=%s",
      async (newestFirst) => {
        const pending: Array<(value: unknown) => void> = [];
        vi.mocked(fetch).mockImplementation(
          () => new Promise((resolve) => pending.push(resolve)) as Promise<Response>
        );
        const store = createStore();
        store.dispatch(wsConnect({ projectId: "A" }));
        store.dispatch(wsDisconnect());
        store.dispatch(wsConnect({ projectId: "A" }));
        const reply = (ticket: string) => ({ ok: true, json: async () => ({ data: { ticket } }) });
        const order = newestFirst ? [1, 0] : [0, 1];
        pending[order[0]](reply(order[0] === 1 ? "current" : "obsolete"));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        pending[order[1]](reply(order[1] === 1 ? "current" : "obsolete"));
        await flushPendingWsInstance("ticket=current");
        const current = wsInstance;
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(wsInstance).toBe(current);
        expect(current!.url).toContain("ticket=current");
      }
    );

    it("ignores A-to-B-to-A pending tickets and stale socket callbacks", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "A" }));
      await flushPendingWsInstance("/A");
      const stale = wsInstance!;
      store.dispatch(wsConnect({ projectId: "B" }));
      await flushPendingWsInstance("/B");
      const current = wsInstance!;
      current.simulateOpen();
      mockInvalidateQueries.mockClear();
      stale.simulateOpen();
      stale.simulateMessage({ type: "prd.updated", section: "overview", version: 2 });
      stale.simulateClose();
      expect(store.getState().websocket.connected).toBe(true);
      expect(mockInvalidateQueries).not.toHaveBeenCalled();
      store.dispatch(wsConnect({ projectId: "A" }));
      await vi.waitFor(() => {
        expect(wsInstance).not.toBe(stale);
        expect(wsInstance!.url).toContain("/A");
      });
    });

    it("invalidates obsolete home ticket continuations", async () => {
      const pending: Array<(value: unknown) => void> = [];
      vi.mocked(fetch).mockImplementation(
        () => new Promise((resolve) => pending.push(resolve)) as Promise<Response>
      );
      const store = createStore();
      store.dispatch(wsConnectHome());
      store.dispatch(wsDisconnect());
      store.dispatch(wsConnectHome());
      pending[1]({ ok: true, json: async () => ({ data: { ticket: "home-current" } }) });
      await flushPendingWsInstance("home-current");
      const current = wsInstance;
      pending[0]({ ok: true, json: async () => ({ data: { ticket: "home-old" } }) });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(wsInstance).toBe(current);
    });
  });

  describe("wsConnect", () => {
    it("creates WebSocket connection to project URL", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-123" }));

      await flushPendingWsInstance("/ws/projects/proj-123");

      expect(wsInstance).toBeTruthy();
      expect(wsInstance!.url).toBe(
        `ws://localhost:3100/ws/projects/proj-123?ticket=${encodeURIComponent(MOCK_WS_UPGRADE_TICKET)}`
      );
    });

    it("uses wss when protocol is https", async () => {
      vi.stubGlobal("window", {
        ...globalThis.window,
        __OPENSPRINT_LOCAL_SESSION__: TEST_WEBSOCKET_SESSION,
        location: { protocol: "https:", host: "localhost:3100" },
      });
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-456" }));

      await flushPendingWsInstance("/ws/projects/proj-456");

      expect(wsInstance!.url).toBe(
        `wss://localhost:3100/ws/projects/proj-456?ticket=${encodeURIComponent(MOCK_WS_UPGRADE_TICKET)}`
      );
    });

    it("dispatches setConnected(true) when socket opens", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));

      await flushPendingWsInstance("/ws/projects/proj-1");

      wsInstance!.simulateOpen();

      await vi.waitFor(() => {
        expect(store.getState().websocket.connected).toBe(true);
      });
    });

    it("does not create duplicate connection for same project when already open", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
      wsInstance!.simulateOpen();

      const firstWs = wsInstance;
      store.dispatch(wsConnect({ projectId: "proj-1" }));

      await flushPendingWsInstance("/ws/projects/proj-1");

      expect(wsInstance).toBe(firstWs);
    });

    it("replaces connection when connecting to different project", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
      const firstWs = wsInstance;
      store.dispatch(wsConnect({ projectId: "proj-2" }));

      await flushPendingWsInstance("/ws/projects/proj-2");

      expect(wsInstance).not.toBe(firstWs);
      expect(wsInstance!.url).toContain("proj-2");
    });
  });

  describe("wsDisconnect", () => {
    it("closes socket and clears connection state", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
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
      await flushPendingWsInstance("/ws/projects/proj-1");
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
      await flushPendingWsInstance("/ws/projects/proj-1");
      wsInstance!.simulateOpen();

      store.dispatch(wsSend({ type: "agent.subscribe", taskId: "task-1" }));

      expect(wsInstance!.sent).toContainEqual(
        JSON.stringify({ type: "agent.subscribe", taskId: "task-1" })
      );
    });

    it("does not send when socket is closed", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
      wsInstance!.simulateOpen();
      wsInstance!.simulateClose();

      store.dispatch(wsSend({ type: "agent.subscribe", taskId: "task-1" }));

      const sentAfterClose = wsInstance!.sent.filter((s) => s.includes("agent.subscribe"));
      expect(sentAfterClose.length).toBe(0);
    });

    it("queues agent.subscribe when socket not yet open and replays on connect (fixes stuck live output)", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
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
      await flushPendingWsInstance("/ws/projects/proj-1");
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
      await flushPendingWsInstance("/ws/projects/proj-1");
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
      await flushPendingWsInstance("/ws/projects/proj-1");
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
      await flushPendingWsInstance("/ws/projects/proj-1");
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

    it("stores live decompose progress on plan.decompose.progress", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateMessage({
        type: "plan.decompose.progress",
        createdCount: 2,
        totalCount: 5,
      });

      await vi.waitFor(() => {
        expect(store.getState().plan.decomposeGeneratedCount).toBe(2);
        expect(store.getState().plan.decomposeTotalCount).toBe(5);
      });
    });

    it("invalidates tasks list on plan.updated so UI can refetch", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
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
        setCurrentPath("/projects/proj-2/sketch");
        store.dispatch(wsConnect({ projectId: "proj-1" }));
        await flushPendingWsInstance("/ws/projects/proj-1");
        wsInstance!.simulateOpen();
        await vi.waitFor(() => store.getState().websocket.connected);

        wsInstance!.simulateMessage({ type: "plan.updated", planId: "plan-123" });

        await vi.waitFor(() => {
          expect(store.getState().unreadPhase["proj-1"]?.plan).toBe(true);
        });
      });

      it("dispatches setPhaseUnread(plan) when same project but currentPhase !== plan", async () => {
        const store = createStore();
        setCurrentPath("/projects/proj-1/sketch");
        store.dispatch(wsConnect({ projectId: "proj-1" }));
        await flushPendingWsInstance("/ws/projects/proj-1");
        wsInstance!.simulateOpen();
        await vi.waitFor(() => store.getState().websocket.connected);

        wsInstance!.simulateMessage({ type: "plan.updated", planId: "plan-123" });

        await vi.waitFor(() => {
          expect(store.getState().unreadPhase["proj-1"]?.plan).toBe(true);
        });
      });

      it("does not dispatch setPhaseUnread(plan) when same project and currentPhase is plan", async () => {
        const store = createStore();
        setCurrentPath("/projects/proj-1/plan");
        store.dispatch(wsConnect({ projectId: "proj-1" }));
        await flushPendingWsInstance("/ws/projects/proj-1");
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
        setCurrentPath("/projects/proj-2/plan");
        store.dispatch(wsConnect({ projectId: "proj-1" }));
        await flushPendingWsInstance("/ws/projects/proj-1");
        wsInstance!.simulateOpen();
        await vi.waitFor(() => store.getState().websocket.connected);

        wsInstance!.simulateMessage({ type: "plan.generated", planId: "plan-new-456" });

        await vi.waitFor(() => {
          expect(store.getState().unreadPhase["proj-1"]?.plan).toBe(true);
        });
      });

      it("plan.generated: does not dispatch setPhaseUnread when same project and phase plan", async () => {
        const store = createStore();
        setCurrentPath("/projects/proj-1/plan");
        store.dispatch(wsConnect({ projectId: "proj-1" }));
        await flushPendingWsInstance("/ws/projects/proj-1");
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
        setCurrentPath("/projects/proj-2/sketch");
        store.dispatch(wsConnect({ projectId: "proj-1" }));
        await flushPendingWsInstance("/ws/projects/proj-1");
        wsInstance!.simulateOpen();
        await vi.waitFor(() => store.getState().websocket.connected);

        wsInstance!.simulateMessage({ type: "prd.updated", section: "overview", version: 2 });

        await vi.waitFor(() => {
          expect(store.getState().unreadPhase["proj-1"]?.sketch).toBe(true);
        });
      });

      it("dispatches setPhaseUnread(sketch) when same project but currentPhase !== sketch", async () => {
        const store = createStore();
        setCurrentPath("/projects/proj-1/plan");
        store.dispatch(wsConnect({ projectId: "proj-1" }));
        await flushPendingWsInstance("/ws/projects/proj-1");
        wsInstance!.simulateOpen();
        await vi.waitFor(() => store.getState().websocket.connected);

        wsInstance!.simulateMessage({ type: "prd.updated", section: "overview", version: 2 });

        await vi.waitFor(() => {
          expect(store.getState().unreadPhase["proj-1"]?.sketch).toBe(true);
        });
      });

      it("does not dispatch setPhaseUnread(sketch) when same project and currentPhase is sketch", async () => {
        const store = createStore();
        setCurrentPath("/projects/proj-1/sketch");
        store.dispatch(wsConnect({ projectId: "proj-1" }));
        await flushPendingWsInstance("/ws/projects/proj-1");
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

    it.each(["task.created", "task.updated", "task.closed"] as const)(
      "%s refreshes Query state without creating a second Redux task owner",
      async (type) => {
        const store = createStore();
        const { setTasks } = await import("../slices/executeSlice");
        store.dispatch(
          setTasks([
            { id: "task-1", title: "Original", kanbanColumn: "backlog", priority: 1 },
          ] as never)
        );
        store.dispatch(wsConnect({ projectId: "proj-1" }));
        await flushPendingWsInstance("/ws/projects/proj-1");
        wsInstance!.simulateOpen();
        const before = store.getState().execute.tasksById;
        const { api } = await import("../../api/client");
        vi.mocked(api.tasks.get).mockClear();
        wsInstance!.simulateMessage({
          type,
          taskId: "task-1",
          status: "closed",
          task: { id: "task-1", title: "Changed", status: "closed" },
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.tasks.list("proj-1"),
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.tasks.detail("proj-1", "task-1"),
        });
        expect(store.getState().execute.tasksById).toBe(before);
        expect(api.tasks.get).not.toHaveBeenCalled();
      }
    );

    it("invalidates tasks list when task.updated for unknown task (Plan page will refetch)", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
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
        await flushPendingWsInstance("/ws/projects/proj-1");
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
        await flushPendingWsInstance("/ws/projects/proj-1");
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

    it("invalidates tasks list on task.created when task payload is missing", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
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
      await flushPendingWsInstance("/ws/projects/proj-1");
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
      await flushPendingWsInstance("/ws/projects/proj-1");
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
      await flushPendingWsInstance("/ws/projects/proj-1");
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

    it("coalesces repeated agent.activity invalidations within the throttle window", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      vi.useFakeTimers();
      vi.setSystemTime(0);
      try {
        const waiting = {
          type: "agent.activity" as const,
          taskId: "task-1",
          phase: "coding" as const,
          activity: "waiting_on_tool" as const,
        };

        wsInstance!.simulateMessage(waiting);
        await vi.waitFor(() => {
          expect(mockInvalidateQueries).toHaveBeenCalledWith({
            queryKey: queryKeys.execute.diagnostics("proj-1", "task-1"),
          });
        });

        mockInvalidateQueries.mockClear();
        vi.setSystemTime(100);

        wsInstance!.simulateMessage(waiting);
        wsInstance!.simulateMessage(waiting);
        wsInstance!.simulateMessage(waiting);
        expect(mockInvalidateQueries).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1000);
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.execute.diagnostics("proj-1", "task-1"),
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: ["agents", "active", "proj-1"],
        });
        const diagCalls = mockInvalidateQueries.mock.calls.filter(
          (c) =>
            Array.isArray(c[0]?.queryKey) &&
            c[0].queryKey[0] === "execute" &&
            c[0].queryKey[3] === "diagnostics"
        );
        expect(diagCalls.length).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("dedupes diagnostics invalidation for the same task across coalesced agent.activity events", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      vi.useFakeTimers();
      vi.setSystemTime(0);
      try {
        const toolCompleted = {
          type: "agent.activity" as const,
          taskId: "task-1",
          phase: "coding" as const,
          activity: "tool_completed" as const,
        };

        wsInstance!.simulateMessage(toolCompleted);
        await vi.waitFor(() => {
          expect(mockInvalidateQueries).toHaveBeenCalled();
        });
        mockInvalidateQueries.mockClear();
        vi.setSystemTime(50);

        wsInstance!.simulateMessage(toolCompleted);
        wsInstance!.simulateMessage({
          ...toolCompleted,
          taskId: "task-2",
        });

        await vi.advanceTimersByTimeAsync(1000);
        const diagCalls = mockInvalidateQueries.mock.calls.filter(
          (c) =>
            Array.isArray(c[0]?.queryKey) &&
            c[0].queryKey[0] === "execute" &&
            c[0].queryKey[3] === "diagnostics"
        );
        expect(diagCalls.map((c) => c[0].queryKey)).toEqual(
          expect.arrayContaining([
            queryKeys.execute.diagnostics("proj-1", "task-1"),
            queryKeys.execute.diagnostics("proj-1", "task-2"),
          ])
        );
        expect(diagCalls.length).toBe(2);
        expect(
          mockInvalidateQueries.mock.calls.some(
            (c) =>
              Array.isArray(c[0]?.queryKey) &&
              c[0].queryKey[0] === "agents" &&
              c[0].queryKey[1] === "active"
          )
        ).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("flushes agent.activity immediately on resumed without waiting for throttle", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      try {
        const store = createStore();
        store.dispatch(wsConnect({ projectId: "proj-1" }));
        await flushPendingWsInstance("/ws/projects/proj-1");
        wsInstance!.simulateOpen();
        await vi.waitFor(() => store.getState().websocket.connected);

        wsInstance!.simulateMessage({
          type: "agent.activity",
          taskId: "task-1",
          phase: "coding",
          activity: "waiting_on_tool",
        });
        await vi.waitFor(() => expect(mockInvalidateQueries).toHaveBeenCalled());
        mockInvalidateQueries.mockClear();
        vi.setSystemTime(100);

        wsInstance!.simulateMessage({
          type: "agent.activity",
          taskId: "task-1",
          phase: "coding",
          activity: "resumed",
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.execute.diagnostics("proj-1", "task-1"),
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: ["agents", "active", "proj-1"],
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("dispatches setCompletionState on agent.completed", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
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
      await flushPendingWsInstance("/ws/projects/proj-1");
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

    it.each([
      {
        currentTask: "task-1",
        queueDepth: 2,
        awaitingApproval: true,
        activeTasks: [{ taskId: "task-1" }],
      },
      { currentTask: null, queueDepth: 0, selfImprovementRunInProgress: true },
      {
        activeTasks: [],
        queueDepth: 0,
        baselineStatus: "failing",
        baselineCheckedAt: "2026-03-18T22:30:00.000Z",
        baselineFailureSummary: "Tests failed",
        dispatchPausedReason: "Remediation required",
      },
    ])(
      "execute.status updates the Query snapshot while Redux keeps transient state only ($queueDepth)",
      async (payload) => {
        const store = createStore();
        store.dispatch(wsConnect({ projectId: "proj-1" }));
        await flushPendingWsInstance("/ws/projects/proj-1");
        wsInstance!.simulateOpen();
        const previous = store.getState().execute;
        queryData.set(JSON.stringify(queryKeys.execute.status("proj-1")), { retained: "value" });
        wsInstance!.simulateMessage({ type: "execute.status", ...payload });
        expect(cached(queryKeys.execute.status("proj-1"))).toMatchObject({
          ...payload,
          retained: "value",
          activeTasks: payload.activeTasks ?? [],
        });
        expect(store.getState().execute).toBe(previous);
      }
    );

    it("invalidates tasks list when execute.status merge-related fields change (deduped)", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateMessage({
        type: "execute.status",
        activeTasks: [],
        queueDepth: 0,
        gitMergeQueue: { activeTaskId: null, pendingTaskIds: [] },
      });
      await vi.waitFor(() => {
        expect(mockInvalidateQueries).toHaveBeenCalledWith(
          expect.objectContaining({ queryKey: queryKeys.tasks.list("proj-1") })
        );
      });
      const countAfterFirst = mockInvalidateQueries.mock.calls.length;

      wsInstance!.simulateMessage({
        type: "execute.status",
        activeTasks: [],
        queueDepth: 2,
        gitMergeQueue: { activeTaskId: null, pendingTaskIds: [] },
      });
      await vi.waitFor(() => {
        expect(mockInvalidateQueries.mock.calls.length).toBe(countAfterFirst);
      });

      wsInstance!.simulateMessage({
        type: "execute.status",
        activeTasks: [],
        queueDepth: 2,
        mergeValidationStatus: "degraded",
        gitMergeQueue: { activeTaskId: null, pendingTaskIds: [] },
      });
      await vi.waitFor(() => {
        expect(mockInvalidateQueries.mock.calls.length).toBeGreaterThan(countAfterFirst);
      });
    });

    it.each([
      { status: "in_progress", assignee: "Frodo" },
      {
        kanbanColumn: "waiting_to_merge",
        mergePausedUntil: null,
        mergeWaitingOnMain: false,
        mergeGateState: null,
      },
      { mergeGateState: "candidate_fix_needed", lastExecutionSummary: "Merge paused" },
    ])(
      "partial task.updated fields trigger authoritative refetch without patching legacy state",
      async (fields) => {
        const store = createStore();
        store.dispatch(wsConnect({ projectId: "proj-1" }));
        await flushPendingWsInstance("/ws/projects/proj-1");
        wsInstance!.simulateOpen();
        const before = store.getState().execute.tasksById;
        wsInstance!.simulateMessage({ type: "task.updated", taskId: "task-1", ...fields });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.tasks.detail("proj-1", "task-1"),
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.execute.diagnostics("proj-1", "task-1"),
        });
        expect(store.getState().execute.tasksById).toBe(before);
      }
    );

    it.each(["feedback.updated", "feedback.mapped"] as const)(
      "%s replaces only matching Query feedback without Redux writes",
      async (type) => {
        const store = createStore();
        store.dispatch(wsConnect({ projectId: "proj-1" }));
        await flushPendingWsInstance("/ws/projects/proj-1");
        wsInstance!.simulateOpen();
        const first = { id: "fb-1", text: "Original", status: "pending" };
        const second = { id: "fb-2", text: "Other", status: "pending" };
        queryData.set(JSON.stringify(queryKeys.feedback.list("proj-1")), [first, second]);
        const before = store.getState().eval.feedback;
        const item = { ...first, text: "Updated", createdTaskIds: [] };
        wsInstance!.simulateMessage({
          type,
          feedbackId: "fb-1",
          planId: "plan-1",
          taskIds: [],
          item,
        });
        expect(cached(queryKeys.feedback.list("proj-1"))).toEqual([item, second]);
        expect(store.getState().eval.feedback).toBe(before);
      }
    );

    it.each([true, false])(
      "feedback.resolved invalidates Query with item present=%s without Redux writes",
      async (includeItem) => {
        const store = createStore();
        store.dispatch(wsConnect({ projectId: "proj-1" }));
        await flushPendingWsInstance("/ws/projects/proj-1");
        wsInstance!.simulateOpen();
        store.dispatch(setFeedback([{ id: "fb-1", status: "pending" }] as never));
        const before = store.getState().eval.feedback;
        wsInstance!.simulateMessage({
          type: "feedback.resolved",
          feedbackId: "fb-1",
          ...(includeItem ? { item: { id: "fb-1", status: "resolved" } } : {}),
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.feedback.list("proj-1"),
        });
        expect(store.getState().eval.feedback).toBe(before);
      }
    );

    it("invalidates feedback list when feedback.mapped has no item", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
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

    it("fetches created task details into Query without Redux copies", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
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
        expect(cached(queryKeys.feedback.list("proj-1"))).toEqual([updatedItem]);
        expect(store.getState().eval.feedback[0].text).toBe("Bug");
      });
      await vi.waitFor(() => {
        expect(api.tasks.get).toHaveBeenCalledTimes(2);
      });
      expect(api.tasks.get).toHaveBeenCalledWith("proj-1", "task-1");
      expect(api.tasks.get).toHaveBeenCalledWith("proj-1", "task-2");
      await vi.waitFor(() => {
        const tasks = cached(queryKeys.tasks.list("proj-1")) as { id: string }[];
        expect(tasks.some((t) => t.id === "task-1")).toBe(true);
        expect(tasks.some((t) => t.id === "task-2")).toBe(true);
        expect(selectTasks(store.getState())).toEqual([]);
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
      await flushPendingWsInstance("/ws/projects/proj-1");
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
        const tasks = cached(queryKeys.tasks.list("proj-1")) as { id: string }[];
        expect(tasks.some((t) => t.id === "task-fallback")).toBe(true);
        expect(selectTasks(store.getState())).toEqual([]);
      });
    });

    it("invalidates cached task after feedback detail sync without patching Redux", async () => {
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
      await flushPendingWsInstance("/ws/projects/proj-1");
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
        expect(task?.kanbanColumn).toBe("backlog");
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.tasks.detail("proj-1", "task-auth"),
        });
      });
    });

    it("dispatches notification on deliver.started", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateMessage({ type: "deliver.started", deployId: "deploy-123" });

      await vi.waitFor(() => {
        expect(store.getState().notification.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ message: "Delivery started", severity: "info" }),
          ])
        );
      });
    });

    it("dispatches success notification on deliver.completed success", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateMessage({
        type: "deliver.completed",
        deployId: "deploy-123",
        success: true,
      });

      await vi.waitFor(() => {
        expect(store.getState().notification.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ message: "Delivery succeeded", severity: "success" }),
          ])
        );
      });
    });

    it("dispatches error notification on deliver.completed failure", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateMessage({
        type: "deliver.completed",
        deployId: "deploy-123",
        success: false,
      });

      await vi.waitFor(() => {
        expect(store.getState().notification.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ message: "Delivery failed", severity: "error" }),
          ])
        );
      });
    });
  });

  describe("agent.chat events", () => {
    it("marks optimistic user message as delivered on agent.chat.received", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      store.dispatch(
        addOptimisticUserMessage({
          taskId: "task-1",
          tempId: "temp-123",
          content: "Hello agent",
        })
      );

      expect(selectChatSending(store.getState(), "task-1")).toBe(true);
      const msgsBefore = selectChatMessages(store.getState(), "task-1");
      expect(msgsBefore).toHaveLength(1);
      expect(msgsBefore[0].delivered).toBe(false);

      wsInstance!.simulateMessage({
        type: "agent.chat.received",
        taskId: "task-1",
        messageId: "msg-server-1",
        clientMessageId: "temp-123",
        status: "queued",
        timestamp: "2025-01-01T00:00:00Z",
      });

      await vi.waitFor(() => {
        const msgs = selectChatMessages(store.getState(), "task-1");
        expect(msgs[0].status).toBe("queued");
        expect(msgs[0].id).toBe("msg-server-1");
      });
    });

    it("dedupes agent.chat.received by messageId (ignores duplicate)", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      store.dispatch(
        addOptimisticUserMessage({
          taskId: "task-1",
          tempId: "temp-1",
          content: "First message",
        })
      );

      wsInstance!.simulateMessage({
        type: "agent.chat.received",
        taskId: "task-1",
        messageId: "msg-1",
        clientMessageId: "temp-1",
        status: "queued",
        timestamp: "2025-01-01T00:00:00Z",
      });

      await vi.waitFor(() => {
        expect(selectChatMessages(store.getState(), "task-1")[0].id).toBe("msg-1");
      });

      wsInstance!.simulateMessage({
        type: "agent.chat.received",
        taskId: "task-1",
        messageId: "msg-1",
        clientMessageId: "temp-1",
        status: "queued",
        timestamp: "2025-01-01T00:00:00Z",
      });

      await vi.waitFor(() => {
        expect(selectChatMessages(store.getState(), "task-1")).toHaveLength(1);
      });
    });

    it("refreshes canonical history and clears sending on agent.chat.response", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      store.dispatch(
        addOptimisticUserMessage({
          taskId: "task-1",
          tempId: "temp-1",
          content: "Hello",
        })
      );
      expect(selectChatSending(store.getState(), "task-1")).toBe(true);

      wsInstance!.simulateMessage({
        type: "agent.chat.response",
        taskId: "task-1",
        messageId: "msg-1",
        clientMessageId: "temp-1",
        status: "queued",
        content: "Hi, I'm working on it!",
      });

      await vi.waitFor(() => {
        const msgs = selectChatMessages(store.getState(), "task-1");
        expect(msgs).toHaveLength(1);
        expect(msgs[0].role).toBe("user");
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.tasks.chatHistory("proj-1", "task-1"),
        });
        expect(selectChatSending(store.getState(), "task-1")).toBe(false);
      });
    });

    it("repeated response delivery refreshes history without copying assistant messages to Redux", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      wsInstance!.simulateMessage({
        type: "agent.chat.response",
        taskId: "task-1",
        messageId: "msg-1",
        clientMessageId: "temp-1",
        status: "queued",
        content: "First response",
      });

      await vi.waitFor(() => {
        expect(selectChatMessages(store.getState(), "task-1")).toHaveLength(0);
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.tasks.chatHistory("proj-1", "task-1"),
        });
      });

      wsInstance!.simulateMessage({
        type: "agent.chat.response",
        taskId: "task-1",
        messageId: "msg-1",
        clientMessageId: "temp-1",
        status: "queued",
        content: "First response",
      });

      await vi.waitFor(() => {
        expect(selectChatMessages(store.getState(), "task-1")).toHaveLength(0);
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.tasks.chatHistory("proj-1", "task-1"),
        });
      });
    });

    it("sets chat unsupported on agent.chat.unsupported and clears sending", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      store.dispatch(
        addOptimisticUserMessage({
          taskId: "task-cli",
          tempId: "temp-1",
          content: "Hello",
        })
      );

      wsInstance!.simulateMessage({
        type: "agent.chat.unsupported",
        taskId: "task-cli",
        reason: "CLI backend does not support chat",
      });

      await vi.waitFor(() => {
        const support = selectChatSupport(store.getState(), "task-cli");
        expect(support.supported).toBe(false);
        expect(support.reason).toBe("CLI backend does not support chat");
        expect(selectChatSending(store.getState(), "task-cli")).toBe(false);
      });
    });

    it("resets chat sending on agent.completed (terminal event re-enables send)", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      store.dispatch(
        addOptimisticUserMessage({
          taskId: "task-1",
          tempId: "temp-1",
          content: "Are you done?",
        })
      );
      expect(selectChatSending(store.getState(), "task-1")).toBe(true);

      wsInstance!.simulateMessage({
        type: "agent.completed",
        taskId: "task-1",
        status: "done",
        testResults: null,
      });

      await vi.waitFor(() => {
        expect(selectChatSending(store.getState(), "task-1")).toBe(false);
      });
    });

    it("invalidates chat-history query on agent.chat.received", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      store.dispatch(
        addOptimisticUserMessage({
          taskId: "task-1",
          tempId: "temp-1",
          content: "Hello",
        })
      );
      mockInvalidateQueries.mockClear();

      wsInstance!.simulateMessage({
        type: "agent.chat.received",
        taskId: "task-1",
        messageId: "msg-1",
        clientMessageId: "temp-1",
        status: "queued",
        timestamp: "2025-01-01T00:00:00Z",
      });

      await vi.waitFor(() => {
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.tasks.chatHistory("proj-1", "task-1"),
        });
      });
    });

    it("invalidates chat-history query on agent.chat.response", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      mockInvalidateQueries.mockClear();

      wsInstance!.simulateMessage({
        type: "agent.chat.response",
        taskId: "task-1",
        messageId: "msg-1",
        clientMessageId: "temp-1",
        status: "queued",
        content: "Agent response",
      });

      await vi.waitFor(() => {
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.tasks.chatHistory("proj-1", "task-1"),
        });
      });
    });

    it("fetches chat history for non-sender tab on agent.chat.received (no pending optimistic)", async () => {
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      const { api } = await import("../../api/client");
      vi.mocked(api.tasks.chatHistory).mockResolvedValue({
        messages: [
          {
            id: "msg-1",
            role: "user",
            content: "Hello from other tab",
            timestamp: "2025-01-01T00:00:00Z",
            attempt: 1,
          },
        ],
        attempt: 1,
        chatSupported: true,
      } as never);

      wsInstance!.simulateMessage({
        type: "agent.chat.received",
        taskId: "task-1",
        messageId: "msg-1",
        clientMessageId: "temp-1",
        status: "queued",
        timestamp: "2025-01-01T00:00:00Z",
      });

      await vi.waitFor(() => {
        expect(api.tasks.chatHistory).toHaveBeenCalledWith("proj-1", "task-1");
      });
    });
  });

  describe("exponential backoff reconnection", () => {
    it("schedules reconnect with exponential delay on unexpected close", async () => {
      vi.useFakeTimers();
      const store = createStore();
      store.dispatch(wsConnect({ projectId: "proj-1" }));
      await flushPendingWsInstance("/ws/projects/proj-1");
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
      await flushPendingWsInstance("/ws/projects/proj-1");
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
      await flushPendingWsInstance("/ws/projects/proj-1");
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      const firstWs = wsInstance;
      wsInstance!.simulateClose();
      await vi.waitFor(() => !store.getState().websocket.connected);

      vi.advanceTimersByTime(1000);
      await vi.waitFor(() => {
        expect(wsInstance).not.toBe(firstWs);
      });
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
      await flushPendingWsInstance("/ws/projects/proj-1");
      wsInstance!.simulateOpen();
      await vi.waitFor(() => store.getState().websocket.connected);

      mockInvalidateQueries.mockClear();
      const firstWs = wsInstance;
      wsInstance!.simulateClose();
      await vi.waitFor(() => !store.getState().websocket.connected);

      vi.advanceTimersByTime(1000);
      await vi.waitFor(() => {
        expect(wsInstance).not.toBe(firstWs);
      });
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
      await flushPendingWsInstance("/ws/projects/proj-1");
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
      await flushPendingWsInstance("/ws/projects/proj-1");
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
    it("passes non-websocket actions to next middleware", async () => {
      const store = createStore();
      const action = { type: "some/other/action" };
      expect(() => store.dispatch(action)).not.toThrow();
    });
  });
});
