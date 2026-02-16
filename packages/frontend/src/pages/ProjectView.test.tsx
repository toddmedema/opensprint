import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { ProjectView } from "./ProjectView";
import projectReducer from "../store/slices/projectSlice";
import websocketReducer from "../store/slices/websocketSlice";
import dreamReducer from "../store/slices/dreamSlice";
import planReducer from "../store/slices/planSlice";
import buildReducer from "../store/slices/buildSlice";
import verifyReducer from "../store/slices/verifySlice";

// Mock websocket middleware to prevent connection attempts
vi.mock("../store/middleware/websocketMiddleware", () => ({
  wsConnect: (payload: unknown) => ({ type: "ws/connect", payload }),
  wsDisconnect: () => ({ type: "ws/disconnect" }),
  wsSend: (payload: unknown) => ({ type: "ws/send", payload }),
  websocketMiddleware: () => (next: (a: unknown) => unknown) => (action: unknown) => next(action),
}));

// Mock API
vi.mock("../api/client", () => ({
  api: {
    projects: { get: vi.fn().mockResolvedValue({ id: "proj-1", name: "Test", currentPhase: "dream" }) },
    prd: { get: vi.fn().mockResolvedValue({}), getHistory: vi.fn().mockResolvedValue([]) },
    plans: { list: vi.fn().mockResolvedValue([]) },
    tasks: { list: vi.fn().mockResolvedValue([]) },
    build: { getPlans: vi.fn().mockResolvedValue([]), getStatus: vi.fn().mockResolvedValue({}) },
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
      dream: dreamReducer,
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
