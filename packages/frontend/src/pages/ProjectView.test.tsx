import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { ProjectView } from "./ProjectView";
import projectReducer from "../store/slices/projectSlice";
import websocketReducer from "../store/slices/websocketSlice";
import designReducer from "../store/slices/designSlice";
import planReducer from "../store/slices/planSlice";
import buildReducer from "../store/slices/buildSlice";
import verifyReducer from "../store/slices/verifySlice";

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
    projects: { get: vi.fn().mockResolvedValue({ id: "proj-1", name: "Test", currentPhase: "dream" }) },
    prd: { get: vi.fn().mockResolvedValue({}), getHistory: vi.fn().mockResolvedValue([]) },
    plans: { list: vi.fn().mockResolvedValue({ plans: [], edges: [] }) },
    tasks: { list: vi.fn().mockResolvedValue([]) },
    build: { status: vi.fn().mockResolvedValue({}) },
    feedback: { list: vi.fn().mockResolvedValue([]) },
    chat: { history: vi.fn().mockResolvedValue({ messages: [] }) },
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
      design: designReducer,
      plan: planReducer,
      build: buildReducer,
      verify: verifyReducer,
    },
    preloadedState: {
      project: {
        data: {
          id: "proj-1",
          name: "Test Project",
          description: "",
          repoPath: "/tmp/test",
          currentPhase: "dream",
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

  it("redirects /projects/:id to /projects/:id/dream", async () => {
    renderWithRouter("/projects/proj-1");

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/proj-1/dream");
    });
  });

  it("redirects invalid phase slug to /projects/:id/dream", async () => {
    renderWithRouter("/projects/proj-1/invalid-phase");

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/proj-1/dream");
    });
  });

  it("does not redirect when phase slug is valid", async () => {
    renderWithRouter("/projects/proj-1/build");

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/proj-1/build");
    });
  });

  it("displays project when at valid phase URL", async () => {
    renderWithRouter("/projects/proj-1/dream");

    await waitFor(() => {
      expect(screen.getByText("Test Project")).toBeInTheDocument();
    });
  });
});

describe("ProjectView upfront loading and mount-all", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches wsConnect and all fetch thunks on mount", async () => {
    renderWithRouter("/projects/proj-1/dream");

    await waitFor(() => {
      expect(mockWsConnect).toHaveBeenCalledWith({ projectId: "proj-1" });
    });

    const { api: mockedApi } = await import("../api/client");
    expect(mockedApi.projects.get).toHaveBeenCalledWith("proj-1");
    expect(mockedApi.prd.get).toHaveBeenCalledWith("proj-1");
    expect(mockedApi.prd.getHistory).toHaveBeenCalledWith("proj-1");
    expect(mockedApi.plans.list).toHaveBeenCalledWith("proj-1");
    expect(mockedApi.tasks.list).toHaveBeenCalledWith("proj-1");
    expect(mockedApi.build.status).toHaveBeenCalledWith("proj-1");
    expect(mockedApi.feedback.list).toHaveBeenCalledWith("proj-1");
    expect(mockedApi.chat.history).toHaveBeenCalledWith("proj-1", "dream");
  });

  it("dispatches wsDisconnect on unmount", async () => {
    const { unmount } = renderWithRouter("/projects/proj-1/dream");
    await waitFor(() => expect(mockWsConnect).toHaveBeenCalled());

    unmount();

    expect(mockWsDisconnect).toHaveBeenCalled();
  });

  it("renders all 4 phase components with CSS display toggle", async () => {
    renderWithRouter("/projects/proj-1/build");

    await waitFor(() => {
      expect(screen.getByText("Test Project")).toBeInTheDocument();
    });

    // All 4 phase wrappers should be mounted; build is visible (contents), others hidden (none)
    expect(screen.getByTestId("phase-dream")).toBeInTheDocument();
    expect(screen.getByTestId("phase-plan")).toBeInTheDocument();
    expect(screen.getByTestId("phase-build")).toBeInTheDocument();
    expect(screen.getByTestId("phase-verify")).toBeInTheDocument();
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

  it("dispatches setSelectedTaskId when loading build phase with task param", async () => {
    const store = createStore();
    renderWithRouter("/projects/proj-1/build?task=opensprint.dev-xyz.1", store);

    await waitFor(() => {
      expect(screen.getByText("Test Project")).toBeInTheDocument();
    });

    const state = store.getState();
    expect(state.build.selectedTaskId).toBe("opensprint.dev-xyz.1");
  });

  it("preserves selected task when switching from build to plan and back to build", async () => {
    const store = configureStore({
      reducer: {
        project: projectReducer,
        websocket: websocketReducer,
        design: designReducer,
        plan: planReducer,
        build: buildReducer,
        verify: verifyReducer,
      },
      preloadedState: {
        project: {
          data: {
            id: "proj-1",
            name: "Test Project",
            description: "",
            repoPath: "/tmp/test",
            currentPhase: "build",
            createdAt: "",
            updatedAt: "",
          },
          loading: false,
          error: null,
        },
        build: {
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
    renderWithRouter("/projects/proj-1/build?task=opensprint.dev-xyz.1", store);

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
    expect(store.getState().build.selectedTaskId).toBe("opensprint.dev-xyz.1");

    // User clicks Build in navbar — should land with task param
    const buildButton = screen.getByRole("button", { name: /^build$/i });
    buildButton.click();

    await waitFor(() => {
      const loc = screen.getByTestId("location").textContent;
      expect(loc).toContain("task=opensprint.dev-xyz.1");
    });
  });

  it("preserves selected plan when switching from plan to build and back to plan", async () => {
    const store = configureStore({
      reducer: {
        project: projectReducer,
        websocket: websocketReducer,
        design: designReducer,
        plan: planReducer,
        build: buildReducer,
        verify: verifyReducer,
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
          shippingPlanId: null,
          reshippingPlanId: null,
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
    const buildButton = screen.getByRole("button", { name: /^build$/i });
    buildButton.click();

    await waitFor(() => {
      const loc = screen.getByTestId("location").textContent;
      expect(loc).toContain("/build");
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
        design: designReducer,
        plan: planReducer,
        build: buildReducer,
        verify: verifyReducer,
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
          shippingPlanId: null,
          reshippingPlanId: null,
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
