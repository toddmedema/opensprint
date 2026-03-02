import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation, useNavigate, Navigate } from "react-router-dom";
import { Provider } from "react-redux";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configureStore } from "@reduxjs/toolkit";
import { ThemeProvider } from "../contexts/ThemeContext";
import { DisplayPreferencesProvider } from "../contexts/DisplayPreferencesContext";
import { ProjectView } from "./ProjectView";
import { ProjectShell } from "./ProjectShell";
import { api } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import projectReducer from "../store/slices/projectSlice";
import websocketReducer, { setDeliverToast } from "../store/slices/websocketSlice";
import connectionReducer, { setConnectionError } from "../store/slices/connectionSlice";
import sketchReducer from "../store/slices/sketchSlice";
import planReducer, { fetchPlans } from "../store/slices/planSlice";
import executeReducer from "../store/slices/executeSlice";
import evalReducer from "../store/slices/evalSlice";
import deliverReducer from "../store/slices/deliverSlice";
import notificationReducer from "../store/slices/notificationSlice";

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
      getPlanStatus: vi.fn().mockResolvedValue({ status: "idle" }),
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
                <Route path="/projects/:projectId" element={<ProjectShell />}>
                  <Route index element={<Navigate to="sketch" replace />} />
                  <Route path=":phase" element={<ProjectView />} />
                </Route>
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
    // Restore default API mocks (some tests override with mockImplementation)
    vi.mocked(api.projects.get).mockResolvedValue({
      id: "proj-1",
      name: "Test Project",
      currentPhase: "sketch",
    } as never);
    vi.mocked(api.tasks.list).mockResolvedValue([]);
    vi.mocked(api.plans.list).mockResolvedValue({ plans: [], edges: [] });
    vi.mocked(api.feedback.list).mockResolvedValue([]);
  });

  it("dispatches wsConnect and fetches tasks, plans, feedback on sketch (load on navigation)", async () => {
    renderWithRouter("/projects/proj-1/sketch");

    await waitFor(() => {
      expect(mockWsConnect).toHaveBeenCalledWith({ projectId: "proj-1" });
    });

    const { api: mockedApi } = await import("../api/client");
    // Tasks, plans, feedback always fetch when project loads (fixes navigation-from-homepage bug)
    await waitFor(() => {
      expect(mockedApi.projects.get).toHaveBeenCalledWith("proj-1");
      expect(mockedApi.prd.get).toHaveBeenCalledWith("proj-1");
      expect(mockedApi.prd.getHistory).toHaveBeenCalledWith("proj-1");
      expect(mockedApi.plans.list).toHaveBeenCalledWith("proj-1");
      expect(mockedApi.tasks.list).toHaveBeenCalledWith("proj-1");
      expect(mockedApi.feedback.list).toHaveBeenCalledWith("proj-1");
      expect(mockedApi.projects.getPlanStatus).toHaveBeenCalledWith("proj-1");
      expect(mockedApi.chat.history).toHaveBeenCalledWith("proj-1", "sketch");
    });
    // Phase-specific: execute status, deliver stay gated (not needed on sketch)
    expect(mockedApi.execute.status).not.toHaveBeenCalled();
    expect(mockedApi.deliver.status).not.toHaveBeenCalled();
    expect(mockedApi.deliver.history).not.toHaveBeenCalled();
  });

  it("fetches execute-phase data when on execute", async () => {
    renderWithRouter("/projects/proj-1/execute");

    await waitFor(() => {
      expect(mockWsConnect).toHaveBeenCalledWith({ projectId: "proj-1" });
    });

    const { api: mockedApi } = await import("../api/client");
    await waitFor(() => {
      expect(mockedApi.projects.get).toHaveBeenCalledWith("proj-1");
      expect(mockedApi.tasks.list).toHaveBeenCalledWith("proj-1");
      expect(mockedApi.execute.status).toHaveBeenCalledWith("proj-1");
      expect(mockedApi.plans.list).toHaveBeenCalledWith("proj-1");
    });
  });

  it("loads full project state when switching projects via dropdown (no refresh required)", async () => {
    const proj1Tasks = [
      {
        id: "t1",
        title: "Task 1",
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
      },
    ];
    const proj2Tasks = [
      {
        id: "t2",
        title: "Task 2",
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
      },
    ];
    vi.mocked(api.projects.get).mockImplementation((id: string) =>
      Promise.resolve(
        id === "proj-1"
          ? { id: "proj-1", name: "Project 1", currentPhase: "sketch" }
          : { id: "proj-2", name: "Project 2", currentPhase: "sketch" }
      ) as never
    );
    vi.mocked(api.tasks.list).mockImplementation((id: string) =>
      Promise.resolve(id === "proj-1" ? proj1Tasks : proj2Tasks) as never
    );
    vi.mocked(api.plans.list).mockImplementation((id: string) =>
      Promise.resolve({
        plans: id === "proj-1" ? [{ metadata: { planId: "p1", epicId: "e1", shippedAt: null, complexity: "low" as const }, content: "# P1", status: "planning" as const, taskCount: 1, doneTaskCount: 0, dependencyCount: 0 }] : [{ metadata: { planId: "p2", epicId: "e2", shippedAt: null, complexity: "low" as const }, content: "# P2", status: "planning" as const, taskCount: 1, doneTaskCount: 0, dependencyCount: 0 }],
        edges: [],
      }) as never
    );
    vi.mocked(api.feedback.list).mockImplementation((id: string) =>
      Promise.resolve(
        id === "proj-1"
          ? [{ id: "f1", text: "Feedback 1", category: "bug" as const, mappedPlanId: null, createdTaskIds: [], status: "pending" as const, createdAt: "2025-01-01" }]
          : [{ id: "f2", text: "Feedback 2", category: "feature" as const, mappedPlanId: null, createdTaskIds: [], status: "pending" as const, createdAt: "2025-01-01" }]
      ) as never
    );

    function NavToProj2() {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => navigate("/projects/proj-2/sketch")} data-testid="nav-to-proj2">
          Go to proj-2
        </button>
      );
    }

    const store = createStore();
    render(
      <Provider store={store}>
        <QueryClientProvider client={createQueryClient()}>
          <ThemeProvider>
            <DisplayPreferencesProvider>
              <MemoryRouter initialEntries={["/projects/proj-1/sketch"]}>
                <LocationDisplay />
                <NavToProj2 />
                <Routes>
                  <Route path="/projects/:projectId" element={<ProjectShell />}>
                    <Route index element={<Navigate to="sketch" replace />} />
                    <Route path=":phase" element={<ProjectView />} />
                  </Route>
                </Routes>
              </MemoryRouter>
            </DisplayPreferencesProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </Provider>
    );

    await waitFor(() => expect(screen.getByText("Project 1")).toBeInTheDocument());
    await waitFor(() => expect(store.getState().execute.tasksById["t1"]).toBeDefined());

    screen.getByTestId("nav-to-proj2").click();

    await waitFor(() => expect(screen.getByText("Project 2")).toBeInTheDocument());
    await waitFor(() => {
      const state = store.getState();
      expect(state.execute.tasksById["t2"]).toBeDefined();
      expect(state.plan.plans).toHaveLength(1);
      expect(state.plan.plans[0].metadata.planId).toBe("p2");
      expect(state.eval.feedback).toHaveLength(1);
      expect(state.eval.feedback[0].id).toBe("f2");
    });
  });

  it("keeps cached project data populated after switching projects", async () => {
    const proj1Tasks = [
      {
        id: "t1",
        title: "Task 1",
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
      },
    ];
    const proj2Tasks = [
      {
        id: "t2",
        title: "Task 2",
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
      },
    ];
    const proj1Plans = {
      plans: [
        {
          metadata: {
            planId: "p1",
            epicId: "e1",
            shippedAt: null,
            complexity: "low" as const,
          },
          content: "# P1",
          status: "planning" as const,
          taskCount: 1,
          doneTaskCount: 0,
          dependencyCount: 0,
        },
      ],
      edges: [],
    };
    const proj2Plans = {
      plans: [
        {
          metadata: {
            planId: "p2",
            epicId: "e2",
            shippedAt: null,
            complexity: "low" as const,
          },
          content: "# P2",
          status: "planning" as const,
          taskCount: 1,
          doneTaskCount: 0,
          dependencyCount: 0,
        },
      ],
      edges: [],
    };
    const proj1Feedback = [
      {
        id: "f1",
        text: "Feedback 1",
        category: "bug" as const,
        mappedPlanId: null,
        createdTaskIds: [],
        status: "pending" as const,
        createdAt: "2025-01-01",
      },
    ];
    const proj2Feedback = [
      {
        id: "f2",
        text: "Feedback 2",
        category: "feature" as const,
        mappedPlanId: null,
        createdTaskIds: [],
        status: "pending" as const,
        createdAt: "2025-01-01",
      },
    ];

    vi.mocked(api.projects.get).mockImplementation((id: string) =>
      Promise.resolve(
        id === "proj-1"
          ? { id: "proj-1", name: "Project 1", currentPhase: "sketch" }
          : { id: "proj-2", name: "Project 2", currentPhase: "sketch" }
      ) as never
    );
    vi.mocked(api.tasks.list).mockImplementation((id: string) =>
      Promise.resolve(id === "proj-1" ? proj1Tasks : proj2Tasks) as never
    );
    vi.mocked(api.plans.list).mockImplementation((id: string) =>
      Promise.resolve(id === "proj-1" ? proj1Plans : proj2Plans) as never
    );
    vi.mocked(api.feedback.list).mockImplementation((id: string) =>
      Promise.resolve(id === "proj-1" ? proj1Feedback : proj2Feedback) as never
    );

    function NavToProj2() {
      const navigate = useNavigate();
      return (
        <button
          type="button"
          onClick={() => navigate("/projects/proj-2/sketch")}
          data-testid="nav-to-proj2"
        >
          Go to proj-2
        </button>
      );
    }

    const store = createStore();
    const queryClient = createQueryClient();
    queryClient.setQueryData(queryKeys.tasks.list("proj-2"), proj2Tasks);
    queryClient.setQueryData(queryKeys.plans.list("proj-2"), proj2Plans);
    queryClient.setQueryData(queryKeys.feedback.list("proj-2"), proj2Feedback);

    render(
      <Provider store={store}>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <DisplayPreferencesProvider>
              <MemoryRouter initialEntries={["/projects/proj-1/sketch"]}>
                <LocationDisplay />
                <NavToProj2 />
                <Routes>
                  <Route path="/projects/:projectId" element={<ProjectShell />}>
                    <Route index element={<Navigate to="sketch" replace />} />
                    <Route path=":phase" element={<ProjectView />} />
                  </Route>
                </Routes>
              </MemoryRouter>
            </DisplayPreferencesProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </Provider>
    );

    await waitFor(() => expect(screen.getByText("Project 1")).toBeInTheDocument());
    await waitFor(() => expect(store.getState().execute.tasksById["t1"]).toBeDefined());

    screen.getByTestId("nav-to-proj2").click();

    await waitFor(() => expect(screen.getByText("Project 2")).toBeInTheDocument());
    await waitFor(() => {
      const state = store.getState();
      expect(state.execute.tasksById["t2"]).toBeDefined();
      expect(state.plan.plans[0]?.metadata.planId).toBe("p2");
      expect(state.eval.feedback[0]?.id).toBe("f2");
    });
  });

  it("syncs tasks, plans, feedback to Redux when navigating to project (no refresh required)", async () => {
    const mockTasks = [
      {
        id: "t1",
        title: "Task 1",
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
      },
    ];
    const mockPlan = {
      metadata: { planId: "p1", epicId: "e1", shippedAt: null, complexity: "low" as const },
      content: "# Plan 1",
      status: "planning" as const,
      taskCount: 1,
      doneTaskCount: 0,
      dependencyCount: 0,
    };
    const mockPlansData = { plans: [mockPlan], edges: [] };
    const mockFeedback = [
      {
        id: "f1",
        text: "Bug report",
        category: "bug" as const,
        mappedPlanId: null,
        createdTaskIds: [],
        status: "pending" as const,
        createdAt: "2025-01-01T00:00:00Z",
      },
    ];
    vi.mocked(api.tasks.list).mockResolvedValue(mockTasks as never);
    vi.mocked(api.plans.list).mockResolvedValue(mockPlansData as never);
    vi.mocked(api.feedback.list).mockResolvedValue(mockFeedback as never);

    const store = createStore();
    renderWithRouter("/projects/proj-1/sketch", store);

    await waitFor(() => {
      expect(screen.getByText("Test Project")).toBeInTheDocument();
    });

    await waitFor(() => {
      const state = store.getState();
      expect(state.execute.tasksById["t1"]).toBeDefined();
      expect(state.plan.plans).toHaveLength(1);
      expect(state.eval.feedback).toHaveLength(1);
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

  it("keeps phase data in store when switching phases; no refetch when returning", async () => {
    vi.mocked(api.tasks.list).mockResolvedValue([TASK_FOR_DEEP_LINK]);
    const store = createStore();
    renderWithRouter("/projects/proj-1/execute", store);

    await waitFor(() => {
      expect(screen.getByText("Test Project")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(store.getState().execute.tasksById["opensprint.dev-xyz.1"]).toBeDefined();
    });

    const { api: mockedApi } = await import("../api/client");
    const tasksCallCountBefore = mockedApi.tasks.list.mock.calls.length;
    expect(tasksCallCountBefore).toBeGreaterThanOrEqual(1);

    // Switch to sketch (execute unmounts, tasks query disabled)
    const sketchButton = screen.getByRole("button", { name: /^sketch$/i });
    sketchButton.click();
    await waitFor(() => {
      expect(screen.getByTestId("phase-sketch")).toBeInTheDocument();
    });

    // Data should still be in Redux (persisted from cache)
    expect(store.getState().execute.tasksById["opensprint.dev-xyz.1"]).toBeDefined();

    // Switch back to execute
    const executeButton = screen.getByRole("button", { name: /^execute$/i });
    executeButton.click();
    await waitFor(() => {
      expect(screen.getByTestId("phase-execute")).toBeInTheDocument();
    });

    // Tasks should still be in Redux; TanStack Query serves from cache, no extra fetch
    expect(store.getState().execute.tasksById["opensprint.dev-xyz.1"]).toBeDefined();
    const tasksCallCountAfter = mockedApi.tasks.list.mock.calls.length;
    // May refetch once when re-enabling (stale-while-revalidate); should not have doubled
    expect(tasksCallCountAfter).toBeLessThanOrEqual(tasksCallCountBefore + 1);
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

    // User clicks Plan in navbar — selection is preserved (phase tab)
    const planButton = within(screen.getByRole("navigation")).getByRole("button", {
      name: /^plan$/i,
    });
    planButton.click();

    await waitFor(() => {
      const loc = screen.getByTestId("location").textContent;
      expect(loc).toContain("/plan");
    });

    // selectedTaskId should still be in Redux (preserved)
    expect(store.getState().execute.selectedTaskId).toBe("opensprint.dev-xyz.1");

    // User clicks Build in navbar — should land with task param (phase tab, not plan Execute button)
    const executeButton = within(screen.getByRole("navigation")).getByRole("button", {
      name: /^execute$/i,
    });
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

    // User clicks Build in navbar — selection is preserved (phase tab, not plan Execute button)
    const executeButton = within(screen.getByRole("navigation")).getByRole("button", {
      name: /^execute$/i,
    });
    executeButton.click();

    await waitFor(() => {
      const loc = screen.getByTestId("location").textContent;
      expect(loc).toContain("/execute");
    });

    // selectedPlanId should still be in Redux (preserved)
    expect(store.getState().plan.selectedPlanId).toBe("opensprint.dev-abc");

    // User clicks Plan in navbar — should land with plan param (phase tab)
    const planButton = within(screen.getByRole("navigation")).getByRole("button", {
      name: /^plan$/i,
    });
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
