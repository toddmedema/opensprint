/**
 * Viewport E2E tests: critical flows at 375×667 (mobile) and 768×1024 (tablet).
 * Verifies open project, navigate phases, open/close task detail work at key breakpoints.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, Navigate } from "react-router-dom";
import { Provider } from "react-redux";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configureStore } from "@reduxjs/toolkit";
import { ThemeProvider } from "../contexts/ThemeContext";
import { DisplayPreferencesProvider } from "../contexts/DisplayPreferencesContext";
import { mockViewport, VIEWPORT_MOBILE, VIEWPORT_TABLET } from "./test-utils";
import { ProjectShell } from "../pages/ProjectShell";
import { ProjectView } from "../pages/ProjectView";
import projectReducer from "../store/slices/projectSlice";
import planReducer from "../store/slices/planSlice";
import executeReducer, {
  initialExecuteState,
  toTasksByIdAndOrder,
  setSelectedTaskId,
} from "../store/slices/executeSlice";
import websocketReducer from "../store/slices/websocketSlice";
import sketchReducer from "../store/slices/sketchSlice";
import evalReducer from "../store/slices/evalSlice";
import deliverReducer from "../store/slices/deliverSlice";
import notificationReducer from "../store/slices/notificationSlice";
import openQuestionsReducer from "../store/slices/openQuestionsSlice";
import connectionReducer from "../store/slices/connectionSlice";

const mockProjectsGet = vi.fn();
const mockTasksList = vi.fn();
const mockPlansList = vi.fn();
const mockExecuteStatus = vi.fn();
const mockTaskGet = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: {
    projects: {
      get: (...args: unknown[]) => mockProjectsGet(...args),
      list: vi.fn().mockResolvedValue([]),
      getSettings: vi.fn().mockResolvedValue({}),
      getSketchContext: vi.fn().mockResolvedValue({ hasExistingCode: false }),
      getPlanStatus: vi.fn().mockResolvedValue({ status: "idle" }),
    },
    prd: { get: vi.fn().mockResolvedValue({}), getHistory: vi.fn().mockResolvedValue([]) },
    plans: { list: (...args: unknown[]) => mockPlansList(...args) },
    tasks: {
      list: (...args: unknown[]) => mockTasksList(...args),
      get: (...args: unknown[]) => mockTaskGet(...args),
    },
    execute: { status: (...args: unknown[]) => mockExecuteStatus(...args) },
    feedback: { list: vi.fn().mockResolvedValue([]) },
    deliver: {
      status: vi.fn().mockResolvedValue({ activeDeployId: null, currentDeploy: null }),
      history: vi.fn().mockResolvedValue([]),
    },
    chat: { history: vi.fn().mockResolvedValue({ messages: [] }) },
    agents: { active: vi.fn().mockResolvedValue([]) },
    notifications: {
      listByProject: vi.fn().mockResolvedValue([]),
      listGlobal: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock("../api/collaboration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/collaboration")>()),
  collaborationApi: (projectId: string) => ({
    snapshot: async () => ({
      projectId,
      sessionId: "default",
      cursor: 0,
      messages: [],
      messagesHasMore: false,
      runs: [],
      runsHasMore: false,
      principal: { actorId: "local-user", displayName: "Local user", role: "controller" },
    }),
    replay: async (after: number) => ({ events: [], nextCursor: after, hasMore: false }),
    overview: async () => ({ projectName: "Test Project", tasks: [] }),
    presence: async () => [],
    preferences: async () => ({ seenCursor: 0, subscribedTaskIds: [] }),
    notifications: async () => [],
    activeRun: async () => null,
    guidanceHistory: async () => [],
    heartbeat: async () => [],
    leave: async () => undefined,
  }),
}));

vi.mock("../store/middleware/websocketMiddleware", () => ({
  wsConnect: (payload: unknown) => ({ type: "ws/connect", payload }),
  wsDisconnect: () => ({ type: "ws/disconnect" }),
  wsSend: () => ({ type: "ws/send" }),
  websocketMiddleware: () => (next: (a: unknown) => unknown) => (action: unknown) => next(action),
}));

const basePlan = {
  metadata: {
    planId: "plan-1",
    epicId: "epic-1",
    complexity: "medium" as const,
  },
  content: "# Plan",
  status: "building" as const,
  taskCount: 2,
  doneTaskCount: 0,
  dependencyCount: 0,
};

const tasks = [
  {
    id: "epic-1.1",
    title: "Task A",
    epicId: "epic-1",
    kanbanColumn: "in_progress" as const,
    priority: 0,
    assignee: null,
    type: "task" as const,
    status: "in_progress" as const,
    labels: [],
    dependencies: [],
    description: "",
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "epic-1.2",
    title: "Task B",
    epicId: "epic-1",
    kanbanColumn: "ready" as const,
    priority: 1,
    assignee: null,
    type: "task" as const,
    status: "open" as const,
    labels: [],
    dependencies: [],
    description: "",
    createdAt: "",
    updatedAt: "",
  },
];

function createStore() {
  return configureStore({
    reducer: {
      project: projectReducer,
      plan: planReducer,
      execute: executeReducer,
      websocket: websocketReducer,
      sketch: sketchReducer,
      eval: evalReducer,
      deliver: deliverReducer,
      notification: notificationReducer,
      openQuestions: openQuestionsReducer,
      connection: connectionReducer,
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
      plan: {
        plans: [basePlan],
        dependencyGraph: null,
        selectedPlanId: null,
        chatMessages: {},
        loading: false,
        decomposing: false,
        executingPlanId: null,
        reExecutingPlanId: null,
        archivingPlanId: null,
        error: null,
      },
      execute: {
        ...initialExecuteState,
        ...toTasksByIdAndOrder(tasks),
        awaitingApproval: false,
        orchestratorRunning: false,
        activeTasks: [],
        activeAgents: [],
        activeAgentsLoadedOnce: false,
        selectedTaskId: null,
      },
      websocket: { connected: false },
    },
  });
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function renderApp(initialPath: string, store = createStore()) {
  return render(
    <ThemeProvider>
      <DisplayPreferencesProvider>
        <Provider store={store}>
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[initialPath]}>
              <Routes>
                <Route path="/projects/:projectId" element={<ProjectShell />}>
                  <Route index element={<Navigate to="sketch" replace />} />
                  <Route path=":phase" element={<ProjectView />} />
                </Route>
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>
        </Provider>
      </DisplayPreferencesProvider>
    </ThemeProvider>
  );
}

describe("viewport E2E: critical flows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectsGet.mockResolvedValue({
      id: "proj-1",
      name: "Test Project",
      repoPath: "/tmp/test",
      currentPhase: "sketch",
      createdAt: "",
      updatedAt: "",
    });
    mockTasksList.mockResolvedValue(tasks);
    mockPlansList.mockResolvedValue({ plans: [basePlan], edges: [] });
    mockExecuteStatus.mockResolvedValue({});
    mockTaskGet.mockImplementation((_projectId: string, taskId: string) => {
      const t = tasks.find((x) => x.id === taskId);
      return Promise.resolve(t ?? { id: taskId, title: taskId, kanbanColumn: "in_progress" });
    });
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  });

  describe("375×667 (mobile)", () => {
    it("open project and navigate phases", async () => {
      const restore = mockViewport(VIEWPORT_MOBILE.width, VIEWPORT_MOBILE.height);
      try {
        const user = userEvent.setup();
        renderApp("/projects/proj-1/sketch");

        await waitFor(() => {
          expect(screen.getByText("Test Project")).toBeInTheDocument();
        });

        expect(screen.getByRole("tab", { name: /Sketch/ })).toBeInTheDocument();
        await user.click(screen.getByRole("tab", { name: /Plan/ }));
        await waitFor(() => {
          expect(screen.getByText("Test Project")).toBeInTheDocument();
        });

        await user.click(screen.getByRole("tab", { name: /Execute/ }));
        await waitFor(() => {
          expect(screen.getByText("Test Project")).toBeInTheDocument();
        });
      } finally {
        restore();
      }
    });

    it("open and close task detail on Execute phase", async () => {
      const restore = mockViewport(VIEWPORT_MOBILE.width, VIEWPORT_MOBILE.height);
      try {
        const user = userEvent.setup();
        const store = createStore();
        store.dispatch(setSelectedTaskId("epic-1.1"));
        renderApp("/projects/proj-1/execute", store);

        await waitFor(() => {
          expect(screen.getByText("Test Project")).toBeInTheDocument();
        });

        await waitFor(
          () => {
            expect(screen.getByTestId("task-detail-title")).toHaveTextContent("Task A");
          },
          { timeout: 15000 }
        );

        expect(screen.getAllByTestId("task-detail-title")).toHaveLength(1);
        expect(screen.getByRole("tab", { name: "Work" })).toHaveAttribute("aria-selected", "true");
        const closeBtn = screen.getByRole("button", { name: "Close task workspace" });
        await user.click(closeBtn);

        await waitFor(
          () => {
            expect(screen.queryByTestId("task-detail-title")).not.toBeInTheDocument();
          },
          { timeout: 15000 }
        );
      } finally {
        restore();
      }
    });
  });

  describe("768×1024 (tablet)", () => {
    it("open project and navigate phases", async () => {
      const restore = mockViewport(VIEWPORT_TABLET.width, VIEWPORT_TABLET.height);
      try {
        const user = userEvent.setup();
        renderApp("/projects/proj-1/sketch");

        await waitFor(() => {
          expect(screen.getByText("Test Project")).toBeInTheDocument();
        });

        await user.click(screen.getByRole("tab", { name: /Plan/ }));
        await user.click(screen.getByRole("tab", { name: /Execute/ }));
        await waitFor(() => {
          expect(screen.getByText("Test Project")).toBeInTheDocument();
        });
      } finally {
        restore();
      }
    });

    it("open and close task detail on Execute phase", async () => {
      const restore = mockViewport(VIEWPORT_TABLET.width, VIEWPORT_TABLET.height);
      try {
        const user = userEvent.setup();
        const store = createStore();
        store.dispatch(setSelectedTaskId("epic-1.1"));
        renderApp("/projects/proj-1/execute", store);

        await waitFor(() => {
          expect(screen.getByTestId("task-detail-title")).toHaveTextContent("Task A");
        });

        expect(screen.getAllByTestId("task-detail-title")).toHaveLength(1);
        expect(screen.getByRole("tab", { name: "Work" })).toHaveAttribute("aria-selected", "true");
        await user.click(screen.getByRole("button", { name: "Close task workspace" }));

        await waitFor(() => {
          expect(screen.queryByTestId("task-detail-title")).not.toBeInTheDocument();
        });
      } finally {
        restore();
      }
    });
  });
});
