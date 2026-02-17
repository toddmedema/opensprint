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
import validateReducer from "../store/slices/validateSlice";

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
    build: { status: vi.fn().mockResolvedValue({}), nudge: vi.fn(), pause: vi.fn() },
    feedback: { list: vi.fn().mockResolvedValue([]) },
    chat: { history: vi.fn().mockResolvedValue({ messages: [] }) },
  },
}));

// Location capture for redirect assertion
function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function createStore() {
  return configureStore({
    reducer: {
      project: projectReducer,
      websocket: websocketReducer,
      design: designReducer,
      plan: planReducer,
      build: buildReducer,
      validate: validateReducer,
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

function renderWithRouter(initialPath: string) {
  const store = createStore();
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
