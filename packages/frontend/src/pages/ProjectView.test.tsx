import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { Provider } from "react-redux";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configureStore } from "@reduxjs/toolkit";
import { ThemeProvider } from "../contexts/ThemeContext";
import { DisplayPreferencesProvider } from "../contexts/DisplayPreferencesContext";
import { ProjectView } from "./ProjectView";
import { api } from "../api/client";
import projectReducer from "../store/slices/projectSlice";
import websocketReducer, { setDeliverToast } from "../store/slices/websocketSlice";
import connectionReducer, { setConnectionError } from "../store/slices/connectionSlice";
import sketchReducer from "../store/slices/sketchSlice";
import planReducer, { fetchPlans } from "../store/slices/planSlice";
import executeReducer from "../store/slices/executeSlice";
import evalReducer from "../store/slices/evalSlice";
import deliverReducer from "../store/slices/deliverSlice";
import notificationReducer from "../store/slices/notificationSlice";

// Task included in list so fetchTasks.fulfilled does not clear selectedTaskId (URL deep link)
const mockTaskForDeepLink = {
  id: "opensprint.dev-xyz.1",
  title: "Build task",
  description: "",
  type: "task" as const,
  status: "open" as const,
  priority: 1,
  assignee: null,
  labels: [],
  dependencies: [],
  epicId: null,
  kanbanColumn: "backlog" as const,
  createdAt: "",
  updatedAt: "",
};

// Mock websocket middleware to prevent connection attempts
const mockWsConnect = vi.fn((payload: unknown) => ({ type: "ws/connect", payload }));
const mockWsDisconnect = vi.fn(() => ({ type: "ws/disconnect" }));
vi.mock("../store/middleware/websocketMiddleware", () => ({
  wsConnect: (payload: unknown) => mockWsConnect(payload),
  wsDisconnect: () => mockWsDisconnect(),
  wsSend: (payload: unknown) => ({ type: "ws/send", payload }),
  websocketMiddleware: () => (next: (a: unknown) => unknown) => (action: unknown) => next(action),
}));

// Mock API
vi.mock("../api/client", () => ({
  api: {
    projects: {
      get: vi.fn().mockResolvedValue({ id: "proj-1", name: "Test Project", currentPhase: "sketch" }),
      list: vi.fn().mockResolvedValue([]),
      getSettings: vi.fn().mockResolvedValue({ deployment: {} }),
      getSketchContext: vi.fn().mockResolvedValue({ hasExistingCode: false }),
    },
    prd: { get: vi.fn().mockResolvedValue({}), getHistory: vi.fn().mockResolvedValue([]) },
    plans: { list: vi.fn().mockResolvedValue({ plans: [], edges: [] }) },
    tasks: {
      list: vi.fn().mockResolvedValue([]),
    },
    execute: { status: vi.fn().mockResolvedValue({}) },
    feedback: {
      list: vi.fn().mockResolvedValue([]),
    },
    chat: { history: vi.fn().mockResolvedValue({ messages: [] }) },
    deliver: {
      status: vi.fn().mockResolvedValue({ activeDeployId: null, currentDeploy: null }),
      history: vi.fn().mockResolvedValue([]),
    },
    notifications: {
      listByProject: vi.fn().mockResolvedValue([]),
      listGlobal: vi.fn().mockResolvedValue([]),
    },
  },
}));

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  );
});

// Location capture for redirect assertion (pathname + search for deep link tests)
function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function createStore() {
  return configureStore({
    reducer: {
      project: projectReducer,
      websocket: websocketReducer,
      connection: connectionReducer,
      sketch: sketchReducer,
      plan: planReducer,
      execute: executeReducer,
      eval: evalReducer,
      deliver: deliverReducer,
      notification: notificationReducer,
    },
    preloadedState: {
      project: {
        data: {
          id: "proj-1",
          name: "Test Project",
          repoPath: "/tmp/test",
          currentPhase: "sketch",
          createdAt: "",
          updatedAt: "",
        },
        loading: false,
        error: null,
      },
    },
  });
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 60_000, retry: false },
    },
  });
}

function renderWithRouter(initialPath: string, store = createStore(), queryClient = createQueryClient()) {
  return render(
    <Provider store={store}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <DisplayPreferencesProvider>
            <MemoryRouter initialEntries={[initialPath]}>
              <LocationDisplay />
              <Routes>
                <Route path="/projects/:projectId/:phase?" element={<ProjectView />} />
              </Routes>
            </MemoryRouter>
          </DisplayPreferencesProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </Provider>
  );
}

describe("ProjectView URL behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects /projects/:id to /projects/:id/sketch", async () => {
    renderWithRouter("/projects/proj-1");

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/proj-1/sketch");
    });
  });

  it("redirects invalid phase slug to /projects/:id/sketch", async () => {
    renderWithRouter("/projects/proj-1/invalid-phase");

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/proj-1/sketch");
    });
  });

  it("does not redirect when phase slug is valid", async () => {
    renderWithRouter("/projects/proj-1/execute");

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/proj-1/execute");
    });
  });

  it("displays project when at valid phase URL", async () => {
    renderWithRouter("/projects/proj-1/sketch");

    await waitFor(() => {
      expect(screen.getByText("Test Project")).toBeInTheDocument();
    });
  });

  it("respects dark theme on sketch phase when user preference is dark", async () => {
    localStorage.setItem("opensprint.theme", "dark");
    document.documentElement.removeAttribute("data-theme");
    renderWithRouter("/projects/proj-1/sketch");

    await waitFor(() => {
      expect(screen.getByText("Test Project")).toBeInTheDocument();
    });

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("respects user theme preference on plan phase", async () => {
    localStorage.setItem("opensprint.theme", "dark");
    renderWithRouter("/projects/proj-1/plan");

    await waitFor(() => {
      expect(screen.getByText("Test Project")).toBeInTheDocument();
    });

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});

describe("ProjectView upfront loading and mount-all", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches wsConnect and all fetch thunks on mount", async () => {
    renderWithRouter("/projects/proj-1/sketch");

    await waitFor(() => {
      expect(mockWsConnect).toHaveBeenCalledWith({ projectId: "proj-1" });
    });

    const { api: mockedApi } = await import("../api/client");
    // Thunks are async; wait for their API calls to complete
    await waitFor(() => {
      expect(mockedApi.projects.get).toHaveBeenCalledWith("proj-1");
      expect(mockedApi.prd.get).toHaveBeenCalledWith("proj-1");
      expect(mockedApi.prd.getHistory).toHaveBeenCalledWith("proj-1");
      expect(mockedApi.plans.list).toHaveBeenCalledWith("proj-1");
      expect(mockedApi.tasks.list).toHaveBeenCalled();
      expect(mockedApi.tasks.list.mock.calls[0][0]).toBe("proj-1");
      expect(mockedApi.execute.status).toHaveBeenCalledWith("proj-1");
      expect(mockedApi.feedback.list).toHaveBeenCalled();
      expect(mockedApi.feedback.list.mock.calls[0][0]).toBe("proj-1");
      expect(mockedApi.chat.history).toHaveBeenCalledWith("proj-1", "sketch");
    });
  });

  it("displays persisted Sketch chat messages after page load (survives refresh)", async () => {
    const persistedMessages = [
      {
        role: "user" as const,
        content: "Hello, help me design",
        timestamp: "2025-01-01T00:00:00Z",
      },
      {
        role: "assistant" as const,
        content: "I'd be happy to help!",
        timestamp: "2025-01-01T00:00:01Z",
      },
    ];
    vi.mocked(api.prd.get).mockResolvedValue({
      sections: { executive_summary: { content: "Summary", version: 1 } },
    });
    vi.mocked(api.chat.history).mockResolvedValue({ messages: persistedMessages });

    renderWithRouter("/projects/proj-1/sketch");

    await waitFor(() => {
      expect(screen.getByText("Hello, help me design")).toBeInTheDocument();
    });
    expect(screen.getByText("I'd be happy to help!")).toBeInTheDocument();
  });

  it("dispatches wsDisconnect on unmount", async () => {
    const { unmount } = renderWithRouter("/projects/proj-1/sketch");
    await waitFor(() => expect(mockWsConnect).toHaveBeenCalled());

    unmount();

    expect(mockWsDisconnect).toHaveBeenCalled();
  });

  it("renders only active phase (mount-on-demand, lazy-loaded)", async () => {
    renderWithRouter("/projects/proj-1/execute");

    await waitFor(() => {
      expect(screen.getByText("Test Project")).toBeInTheDocument();
    });

    // Only the active phase wrapper is mounted; inactive phases are unmounted
    expect(screen.getByTestId("phase-execute")).toBeInTheDocument();
    expect(screen.queryByTestId("phase-sketch")).not.toBeInTheDocument();
    expect(screen.queryByTestId("phase-plan")).not.toBeInTheDocument();
    expect(screen.queryByTestId("phase-eval")).not.toBeInTheDocument();
    expect(screen.queryByTestId("phase-deliver")).not.toBeInTheDocument();
  });

  it("active phase wrapper has flex-1 min-h-0 for bounded height and independent page/sidebar scroll", async () => {
    renderWithRouter("/projects/proj-1/plan");

    await waitFor(() => {
      expect(screen.getByText("Test Project")).toBeInTheDocument();
    });

    const planPhaseWrapper = screen.getByTestId("phase-plan");
    expect(planPhaseWrapper).toHaveClass("flex-1");
    expect(planPhaseWrapper).toHaveClass("min-h-0");
    expect(planPhaseWrapper).toHaveClass("overflow-hidden");
  });
});

const TASK_FOR_DEEP_LINK = {
  id: "opensprint.dev-xyz.1",
  title: "Test Task",
  description: "",
  type: "task" as const,
  status: "open" as const,
  priority: 2,
  assignee: null,
  labels: [],
  dependencies: [],
  epicId: "opensprint.dev-xyz",
  kanbanColumn: "open" as const,
  createdAt: "",
  updatedAt: "",
};

describe("ProjectView URL deep linking for Plan and Build detail panes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.tasks.list).mockResolvedValue([TASK_FOR_DEEP_LINK]);
  });

  it("dispatches setSelectedPlanId when loading plan phase with plan param", async () => {
    const store = createStore();
    renderWithRouter("/projects/proj-1/plan?plan=opensprint.dev-abc", store);

    await waitFor(() => {
      expect(screen.getByText("Test Project")).toBeInTheDocument();
    });

    const state = store.getState();
    expect(state.plan.selectedPlanId).toBe("opensprint.dev-abc");
  });

  it("fetches plan chat history when loading plan phase with plan param (persistence across reloads)", async () => {
    const mockHistory = vi.mocked(api.chat.history);
    mockHistory.mockResolvedValue({
      id: "conv-1",
      context: "plan:opensprint.dev-abc",
      messages: [
        { role: "user", content: "Add more detail", timestamp: "2025-01-01" },
        { role: "assistant", content: "Sure, I can help.", timestamp: "2025-01-01" },
      ],
    });

    const store = createStore();
    renderWithRouter("/projects/proj-1/plan?plan=opensprint.dev-abc", store);

    // Wait for Plan phase to load (lazy) and fetch plan chat
    await waitFor(
      () => {
        expect(mockHistory).toHaveBeenCalledWith("proj-1", "plan:opensprint.dev-abc");
      },
      { timeout: 8000 }
    );

    await waitFor(
      () => {
        const msgs = store.getState().plan.chatMessages["plan:opensprint.dev-abc"];
        expect(msgs).toHaveLength(2);
        expect(msgs[0].content).toBe("Add more detail");
        expect(msgs[1].content).toBe("Sure, I can help.");
      },
      { timeout: 3000 }
    );
  });

  it("dispatches setSelectedTaskId when loading execute phase with task param", async () => {
    const store = createStore();
    renderWithRouter("/projects/proj-1/execute?task=opensprint.dev-xyz.1", store);

    await waitFor(() => {
      expect(screen.getByText("Test Project")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(store.getState().execute.selectedTaskId).toBe("opensprint.dev-xyz.1");
    });
  });

  it("preserves selected task when switching from execute to plan and back to execute", async () => {
    const store = createStore();
    renderWithRouter("/projects/proj-1/execute?task=opensprint.dev-xyz.1", store);

    await waitFor(() => {
      expect(screen.getByText("Test Project")).toBeInTheDocument();
    });

    // selectedTaskId set from URL (deep link)
    await waitFor(() => {
      expect(store.getState().execute.selectedTaskId).toBe("opensprint.dev-xyz.1");
    });

    // User clicks Plan in navbar — selection is preserved
    const planButton = screen.getByRole("button", { name: /^plan$/i });
    planButton.click();

    await waitFor(() => {
      const loc = screen.getByTestId("location").textContent;
      expect(loc).toContain("/plan");
    });

    // selectedTaskId should still be in Redux (preserved)
    expect(store.getState().execute.selectedTaskId).toBe("opensprint.dev-xyz.1");

    // User clicks Build in navbar — should land with task param
    const executeButton = screen.getByRole("button", { name: /^execute$/i });
    executeButton.click();

    await waitFor(() => {
      const loc = screen.getByTestId("location").textContent;
      expect(loc).toContain("task=opensprint.dev-xyz.1");
    });
  });

  it("preserves selected plan when switching from plan to execute and back to plan", async () => {
    const store = configureStore({
      reducer: {
        project: projectReducer,
        websocket: websocketReducer,
        connection: connectionReducer,
        sketch: sketchReducer,
        plan: planReducer,
        execute: executeReducer,
        eval: evalReducer,
        deliver: deliverReducer,
        notification: notificationReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            repoPath: "/tmp/test",
            currentPhase: "plan",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        plan: {
          selectedPlanId: "opensprint.dev-abc",
          plans: [],
          dependencyGraph: null,
          chatMessages: {},
          loading: false,
          decomposing: false,
          executingPlanId: null,
          reExecutingPlanId: null,
          archivingPlanId: null,
          error: null,
        },
      },
    });
    renderWithRouter("/projects/proj-1/plan?plan=opensprint.dev-abc", store);

    await waitFor(() => {
      expect(screen.getByText("Test Project")).toBeInTheDocument();
    });

    // User clicks Build in navbar — selection is preserved
    const executeButton = screen.getByRole("button", { name: /^execute$/i });
    executeButton.click();

    await waitFor(() => {
      const loc = screen.getByTestId("location").textContent;
      expect(loc).toContain("/execute");
    });

    // selectedPlanId should still be in Redux (preserved)
    expect(store.getState().plan.selectedPlanId).toBe("opensprint.dev-abc");

    // User clicks Plan in navbar — should land with plan param
    const planButton = screen.getByRole("button", { name: /^plan$/i });
    planButton.click();

    await waitFor(() => {
      const loc = screen.getByTestId("location").textContent;
      expect(loc).toContain("plan=opensprint.dev-abc");
    });
  });

  it("syncs selected plan to URL when on plan phase", async () => {
    const store = configureStore({
      reducer: {
        project: projectReducer,
        websocket: websocketReducer,
        connection: connectionReducer,
        sketch: sketchReducer,
        plan: planReducer,
        execute: executeReducer,
        eval: evalReducer,
        deliver: deliverReducer,
        notification: notificationReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            repoPath: "/tmp/test",
            currentPhase: "plan",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        plan: {
          selectedPlanId: "opensprint.dev-abc",
          plans: [],
          dependencyGraph: null,
          chatMessages: {},
          loading: false,
          decomposing: false,
          executingPlanId: null,
          reExecutingPlanId: null,
          archivingPlanId: null,
          error: null,
        },
      },
    });
    renderWithRouter("/projects/proj-1/plan", store);

    await waitFor(() => {
      const loc = screen.getByTestId("location").textContent;
      expect(loc).toContain("plan=opensprint.dev-abc");
    });
  });
});

describe("ProjectView global deliver toast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows DeliverToast when deliverToast is in state (global, regardless of active tab)", async () => {
    const store = createStore();
    store.dispatch(setDeliverToast({ message: "Delivery succeeded", variant: "succeeded" }));
    renderWithRouter("/projects/proj-1/sketch", store);

    await waitFor(() => {
      expect(screen.getByTestId("deliver-toast")).toBeInTheDocument();
      expect(screen.getByText("Delivery succeeded")).toBeInTheDocument();
    });
  });

  it("shows deliver toast on deliver phase as well (confirms global visibility)", async () => {
    const store = createStore();
    store.dispatch(setDeliverToast({ message: "Delivery failed", variant: "failed" }));
    renderWithRouter("/projects/proj-1/deliver", store);

    await waitFor(() => {
      expect(screen.getByTestId("deliver-toast")).toBeInTheDocument();
      expect(screen.getByText("Delivery failed")).toBeInTheDocument();
    });
  });
});

describe("ProjectView plan refresh toast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows PlanRefreshToast when background refresh fails (non-connection error)", async () => {
    const { api } = await import("../api/client");
    vi.mocked(api.plans.list).mockRejectedValue(new Error("Server error 500"));
    const store = createStore();
    await store.dispatch(fetchPlans({ projectId: "proj-1", background: true }));
    renderWithRouter("/projects/proj-1/sketch", store);

    await waitFor(() => {
      expect(screen.getByTestId("plan-refresh-toast")).toBeInTheDocument();
      expect(screen.getByText("Server error 500")).toBeInTheDocument();
    });
  });

  it("shows connection banner instead of PlanRefreshToast when connectionError is true", async () => {
    const store = createStore();
    store.dispatch(setConnectionError(true));
    vi.mocked(api.plans.list).mockRejectedValue(new Error("Failed to fetch"));
    await store.dispatch(fetchPlans({ projectId: "proj-1", background: true }));
    renderWithRouter("/projects/proj-1/sketch", store);

    await waitFor(() => {
      expect(screen.getByTestId("connection-error-banner")).toBeInTheDocument();
      expect(screen.getByText("Failed to connect to Open Sprint server - try restarting it")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("plan-refresh-toast")).not.toBeInTheDocument();
  });
});
