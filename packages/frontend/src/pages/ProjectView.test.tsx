import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { ProjectView } from "./ProjectView";
import projectReducer from "../store/slices/projectSlice";
import websocketReducer, { setDeployToast } from "../store/slices/websocketSlice";
import specReducer from "../store/slices/specSlice";
import planReducer from "../store/slices/planSlice";
import executeReducer from "../store/slices/executeSlice";
import evalReducer from "../store/slices/evalSlice";
import deployReducer from "../store/slices/deploySlice";

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
    projects: { get: vi.fn().mockResolvedValue({ id: "proj-1", name: "Test", currentPhase: "spec" }) },
    prd: { get: vi.fn().mockResolvedValue({}), getHistory: vi.fn().mockResolvedValue([]) },
    plans: { list: vi.fn().mockResolvedValue({ plans: [], edges: [] }) },
    tasks: { list: vi.fn().mockResolvedValue([]) },
    execute: { status: vi.fn().mockResolvedValue({}) },
    feedback: { list: vi.fn().mockResolvedValue([]) },
    chat: { history: vi.fn().mockResolvedValue({ messages: [] }) },
    deploy: {
      status: vi.fn().mockResolvedValue({ activeDeployId: null, currentDeploy: null }),
      history: vi.fn().mockResolvedValue([]),
    },
  },
}));

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
      spec: specReducer,
      plan: planReducer,
      execute: executeReducer,
      eval: evalReducer,
      deploy: deployReducer,
    },
    preloadedState: {
      project: {
        data: {
          id: "proj-1",
          name: "Test Project",
          description: "",
          repoPath: "/tmp/test",
          currentPhase: "spec",
          createdAt: "",
          updatedAt: "",
        },
        loading: false,
        error: null,
      },
    },
  });
}

function renderWithRouter(initialPath: string, store = createStore()) {
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[initialPath]}>
        <LocationDisplay />
        <Routes>
          <Route path="/projects/:projectId/:phase?" element={<ProjectView />} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
}

describe("ProjectView URL behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects /projects/:id to /projects/:id/spec", async () => {
    renderWithRouter("/projects/proj-1");

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/proj-1/spec");
    });
  });

  it("redirects invalid phase slug to /projects/:id/spec", async () => {
    renderWithRouter("/projects/proj-1/invalid-phase");

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/proj-1/spec");
    });
  });

  it("does not redirect when phase slug is valid", async () => {
    renderWithRouter("/projects/proj-1/execute");

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/proj-1/execute");
    });
  });

  it("displays project when at valid phase URL", async () => {
    renderWithRouter("/projects/proj-1/spec");

    await waitFor(() => {
      expect(screen.getByText("Test Project")).toBeInTheDocument();
    });
  });

  it("adds spec-phase-light to document when on spec phase (dream page light mode)", async () => {
    document.documentElement.classList.remove("spec-phase-light");
    const { unmount } = renderWithRouter("/projects/proj-1/spec");

    await waitFor(() => {
      expect(screen.getByText("Test Project")).toBeInTheDocument();
    });

    expect(document.documentElement.classList.contains("spec-phase-light")).toBe(true);

    unmount();
    expect(document.documentElement.classList.contains("spec-phase-light")).toBe(false);
  });

  it("does not add spec-phase-light when on plan phase", async () => {
    document.documentElement.classList.remove("spec-phase-light");
    renderWithRouter("/projects/proj-1/plan");

    await waitFor(() => {
      expect(screen.getByText("Test Project")).toBeInTheDocument();
    });

    expect(document.documentElement.classList.contains("spec-phase-light")).toBe(false);
  });
});

describe("ProjectView upfront loading and mount-all", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches wsConnect and all fetch thunks on mount", async () => {
    renderWithRouter("/projects/proj-1/spec");

    await waitFor(() => {
      expect(mockWsConnect).toHaveBeenCalledWith({ projectId: "proj-1" });
    });

    const { api: mockedApi } = await import("../api/client");
    expect(mockedApi.projects.get).toHaveBeenCalledWith("proj-1");
    expect(mockedApi.prd.get).toHaveBeenCalledWith("proj-1");
    expect(mockedApi.prd.getHistory).toHaveBeenCalledWith("proj-1");
    expect(mockedApi.plans.list).toHaveBeenCalledWith("proj-1");
    expect(mockedApi.tasks.list).toHaveBeenCalledWith("proj-1");
    expect(mockedApi.execute.status).toHaveBeenCalledWith("proj-1");
    expect(mockedApi.feedback.list).toHaveBeenCalledWith("proj-1");
    expect(mockedApi.chat.history).toHaveBeenCalledWith("proj-1", "spec");
  });

  it("dispatches wsDisconnect on unmount", async () => {
    const { unmount } = renderWithRouter("/projects/proj-1/spec");
    await waitFor(() => expect(mockWsConnect).toHaveBeenCalled());

    unmount();

    expect(mockWsDisconnect).toHaveBeenCalled();
  });

  it("renders all 5 phase components with CSS display toggle", async () => {
    renderWithRouter("/projects/proj-1/execute");

    await waitFor(() => {
      expect(screen.getByText("Test Project")).toBeInTheDocument();
    });

    // All 4 phase wrappers should be mounted; execute is visible (flex), others hidden (none)
    expect(screen.getByTestId("phase-spec")).toBeInTheDocument();
    expect(screen.getByTestId("phase-plan")).toBeInTheDocument();
    expect(screen.getByTestId("phase-execute")).toBeInTheDocument();
    expect(screen.getByTestId("phase-eval")).toBeInTheDocument();
    expect(screen.getByTestId("phase-deploy")).toBeInTheDocument();
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

describe("ProjectView URL deep linking for Plan and Build detail panes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("dispatches setSelectedTaskId when loading execute phase with task param", async () => {
    const store = createStore();
    renderWithRouter("/projects/proj-1/execute?task=opensprint.dev-xyz.1", store);

    await waitFor(() => {
      expect(screen.getByText("Test Project")).toBeInTheDocument();
    });

    const state = store.getState();
    expect(state.execute.selectedTaskId).toBe("opensprint.dev-xyz.1");
  });

  it("preserves selected task when switching from execute to plan and back to execute", async () => {
    const store = configureStore({
      reducer: {
        project: projectReducer,
        websocket: websocketReducer,
        spec: specReducer,
        plan: planReducer,
        execute: executeReducer,
        eval: evalReducer,
        deploy: deployReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "execute",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        execute: {
          tasks: [],
          plans: [],
          orchestratorRunning: false,
          awaitingApproval: false,
          selectedTaskId: "opensprint.dev-xyz.1",
          taskDetail: null,
          taskDetailLoading: false,
          agentOutput: [],
          completionState: null,
          archivedSessions: [],
          archivedLoading: false,
          markDoneLoading: false,
          statusLoading: false,
          loading: false,
          error: null,
        },
      },
    });
    renderWithRouter("/projects/proj-1/execute?task=opensprint.dev-xyz.1", store);

    await waitFor(() => {
      expect(screen.getByText("Test Project")).toBeInTheDocument();
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
        spec: specReducer,
        plan: planReducer,
        execute: executeReducer,
        eval: evalReducer,
        deploy: deployReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
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
        spec: specReducer,
        plan: planReducer,
        execute: executeReducer,
        eval: evalReducer,
        deploy: deployReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
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

describe("ProjectView global deploy toast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows DeployToast when deployToast is in state (global, regardless of active tab)", async () => {
    const store = createStore();
    store.dispatch(setDeployToast({ message: "Deployment succeeded", variant: "succeeded" }));
    renderWithRouter("/projects/proj-1/spec", store);

    await waitFor(() => {
      expect(screen.getByTestId("deploy-toast")).toBeInTheDocument();
      expect(screen.getByText("Deployment succeeded")).toBeInTheDocument();
    });
  });

  it("shows deploy toast on deploy phase as well (confirms global visibility)", async () => {
    const store = createStore();
    store.dispatch(setDeployToast({ message: "Deployment failed", variant: "failed" }));
    renderWithRouter("/projects/proj-1/deploy", store);

    await waitFor(() => {
      expect(screen.getByTestId("deploy-toast")).toBeInTheDocument();
      expect(screen.getByText("Deployment failed")).toBeInTheDocument();
    });
  });
});
