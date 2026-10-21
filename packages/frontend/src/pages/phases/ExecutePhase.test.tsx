import { queryKeys } from "../../api/queryKeys";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configureStore } from "@reduxjs/toolkit";
import { ExecutePhase } from "./ExecutePhase";
import { api } from "../../api/client";
import {
  setSelectedTaskId,
  initialExecuteState,
  toTasksByIdAndOrder,
} from "../../store/slices/executeSlice";
import projectReducer from "../../store/slices/projectSlice";
import planReducer from "../../store/slices/planSlice";
import executeReducer from "../../store/slices/executeSlice";
import evalReducer from "../../store/slices/evalSlice";
import openQuestionsReducer, {
  addNotification as addOpenQuestionNotification,
} from "../../store/slices/openQuestionsSlice";
import websocketReducer, { setConnected } from "../../store/slices/websocketSlice";
import unreadPhaseReducer, { setPhaseUnread } from "../../store/slices/unreadPhaseSlice";
import { MOBILE_BREAKPOINT } from "../../lib/constants";
import { seedServerFixtureFromElement } from "../../test/seedServerFixtures";

function createExecutePhaseQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

let latestQueryClient: QueryClient;
function render(ui: ReactElement) {
  const queryClient = createExecutePhaseQueryClient();
  latestQueryClient = queryClient;
  seedServerFixtureFromElement(queryClient, ui);
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}
const mockGet = vi.fn().mockResolvedValue({});
const mockSessions = vi.fn().mockResolvedValue([]);
const mockMarkDone = vi.fn().mockResolvedValue(undefined);
const mockUnblock = vi.fn().mockResolvedValue({ taskUnblocked: true });
const mockDeleteTask = vi.fn().mockResolvedValue({ taskDeleted: true });
const mockFeedbackGet = vi.fn().mockResolvedValue(null);
const mockAgentsActive = vi.fn().mockResolvedValue([]);
const mockLiveOutput = vi.fn().mockResolvedValue({ output: "" });
const mockTaskDiagnostics = vi.fn().mockResolvedValue(null);
let currentTaskGetImpl = mockGet.getMockImplementation();

const mockGetSettings = vi.fn().mockResolvedValue({ teamMembers: [] });

vi.mock("../../api/client", () => ({
  api: {
    tasks: {
      list: vi.fn().mockResolvedValue([]),
      get: (...args: unknown[]) => mockGet(...args),
      sessions: (...args: unknown[]) => mockSessions(...args),
      markDone: (...args: unknown[]) => mockMarkDone(...args),
      unblock: (...args: unknown[]) => mockUnblock(...args),
      delete: (...args: unknown[]) => mockDeleteTask(...args),
      updateTask: vi
        .fn()
        .mockImplementation(
          async (_projectId: string, taskId: string, updates: { assignee?: string | null }) => {
            const task = (await mockGet("proj-1", taskId)) as {
              id: string;
              assignee: string | null;
            };
            return { ...task, assignee: updates.assignee ?? task.assignee };
          }
        ),
    },
    plans: {
      list: vi.fn().mockResolvedValue({ plans: [], edges: [] }),
    },
    projects: {
      getSettings: (...args: unknown[]) => mockGetSettings(...args),
    },
    execute: {
      status: vi.fn().mockResolvedValue({}),
      liveOutput: (...args: unknown[]) => mockLiveOutput(...args),
      taskDiagnostics: (...args: unknown[]) => mockTaskDiagnostics(...args),
    },
    agents: {
      active: (...args: unknown[]) => mockAgentsActive(...args),
    },
    feedback: {
      get: (...args: unknown[]) => mockFeedbackGet(...args),
    },
    notifications: {
      listByProject: vi.fn().mockResolvedValue([]),
    },
  },
}));

beforeEach(() => {
  localStorage.removeItem("opensprint.executeStatusFilter");
  localStorage.removeItem("opensprint.executeView");
});

const basePlan = {
  metadata: {
    planId: "build-test-feature",
    epicId: "epic-1",
    complexity: "medium" as const,
  },
  content: "# Build Test\n\nContent.",
  status: "building" as const,
  taskCount: 3,
  doneTaskCount: 0,
  dependencyCount: 0,
};

function syncTaskMocks(tasks: Parameters<typeof toTasksByIdAndOrder>[0]) {
  const tasksList = tasks.map((task) => ({
    description: "",
    type: "task" as const,
    status: task.kanbanColumn === "done" ? ("closed" as const) : ("open" as const),
    labels: [],
    dependencies: [],
    createdAt: "",
    updatedAt: "",
    ...task,
  }));
  const taskById = new Map(tasksList.map((task) => [task.id, task]));
  vi.mocked(api.tasks.list).mockResolvedValue(tasksList as never);
  const existingGetImpl = mockGet.getMockImplementation();
  const defaultGetImpl = async (_projectId: string, taskId: string) => {
    return (
      taskById.get(taskId) ?? {
        id: taskId,
        title: taskId,
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
        description: "",
        type: "task",
        status: "open",
        labels: [],
        dependencies: [],
        createdAt: "",
        updatedAt: "",
      }
    );
  };
  if (!existingGetImpl || existingGetImpl === currentTaskGetImpl) {
    mockGet.mockImplementation(defaultGetImpl);
    currentTaskGetImpl = defaultGetImpl;
  } else {
    currentTaskGetImpl = existingGetImpl;
  }
}

function createStore(
  tasks: Parameters<typeof toTasksByIdAndOrder>[0],
  buildOverrides?: Partial<{
    orchestratorRunning: boolean;
    selectedTaskId: string | null;
    awaitingApproval: boolean;
    selfImprovementRunInProgress: boolean;
    selfImprovementRunMode: "audit" | "experiments" | undefined;
    baselineStatus: "unknown" | "checking" | "healthy" | "failing";
    baselineFailureSummary: string | null;
    baselineRemediationStatus: {
      taskId: string;
      attempts: number;
      maxAttempts: number;
      status: string;
    } | null;
    dispatchPausedReason: string | null;
    agentOutput: Record<string, string[]>;
    taskDetailError: string | null;
    activeTasks: { taskId: string; phase: string; startedAt: string }[];
    taskIdToStartedAt: Record<string, string>;
  }>,
  websocketOverrides?: Partial<{ connected: boolean }>
) {
  syncTaskMocks(tasks);
  return configureStore({
    reducer: {
      project: projectReducer,
      plan: planReducer,
      execute: executeReducer,
      eval: evalReducer,
      openQuestions: openQuestionsReducer,
      websocket: websocketReducer,
      unreadPhase: unreadPhaseReducer,
    },
    preloadedState: {
      websocket: {
        connected: false,
        ...websocketOverrides,
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
      execute: (() => {
        const overrides = buildOverrides ?? {};
        const { taskDetailError, ...rest } = overrides;
        const execute: typeof initialExecuteState = {
          ...initialExecuteState,
          ...toTasksByIdAndOrder(tasks as Parameters<typeof toTasksByIdAndOrder>[0]),
          ...rest,
        };
        if (taskDetailError !== undefined) {
          execute.async = {
            ...execute.async,
            taskDetail: { ...execute.async.taskDetail, error: taskDetailError },
          };
        }
        return execute;
      })(),
      openQuestions: {
        byProject: {},
        global: [],
        async: {
          project: {},
          global: { loading: false },
        },
      },
    },
  });
}

describe("ExecutePhase epic card task order", () => {
  beforeEach(() => {
    localStorage.setItem("opensprint.executeView", "kanban");
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentsActive.mockResolvedValue([]);
  });

  it("clears execute phase unread when mounted with projectId", () => {
    const store = createStore([]);
    store.dispatch(setPhaseUnread({ projectId: "proj-1", phase: "execute" }));
    expect(store.getState().unreadPhase["proj-1"]?.execute).toBe(true);

    render(
      <Provider store={store}>
        <MemoryRouter>
          <ExecutePhase projectId="proj-1" />
        </MemoryRouter>
      </Provider>
    );

    expect(store.getState().unreadPhase["proj-1"]?.execute).toBeFalsy();
  });

  it("All filter shows Ready and Up Next swimlanes instead of active and completed tasks", () => {
    const tasks = [
      {
        id: "epic-1.1",
        title: "Done task",
        epicId: "epic-1",
        kanbanColumn: "done",
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-1.2",
        title: "Ready task",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-1.3",
        title: "In progress task",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-1.4",
        title: "Planning task",
        epicId: "epic-1",
        kanbanColumn: "planning",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    const { container } = render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    expect(screen.getByTestId("execute-section-ready")).toBeInTheDocument();
    expect(screen.getByTestId("execute-section-in_line")).toBeInTheDocument();
    expect(container).toHaveTextContent("Ready task");
    expect(container).toHaveTextContent("Planning task");
    expect(container).not.toHaveTextContent("In progress task");
    expect(container).not.toHaveTextContent("Done task");
  });

  it("All filter shows Failures section when blocked tasks exist", () => {
    const tasks = [
      {
        id: "epic-1.1",
        title: "Ready task",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-1.2",
        title: "Blocked task",
        epicId: "epic-1",
        kanbanColumn: "blocked",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    const { container } = render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    expect(screen.getByTestId("execute-section-ready")).toBeInTheDocument();
    expect(screen.getByTestId("execute-section-blocked")).toBeInTheDocument();
    expect(container).toHaveTextContent("Ready task");
    expect(container).toHaveTextContent("Blocked task");
  });

  it("renders task rows with status before title and assignee on the right", async () => {
    const user = userEvent.setup();
    const tasks = [
      {
        id: "epic-1.1",
        title: "Assigned task",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: "Frodo",
      },
      {
        id: "epic-1.2",
        title: "Unassigned task",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 1,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    const { container } = render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await user.click(screen.getByTestId("filter-chip-in_progress"));
    const epicCard = container.querySelector('[data-testid="epic-card-epic-1"]');
    expect(epicCard).toBeInTheDocument();

    const rows = epicCard!.querySelectorAll("ul li");
    expect(rows).toHaveLength(2);

    const assignedRow = rows[0];
    expect(assignedRow).toBeTruthy();
    const assignedButton = assignedRow!.querySelector("button");
    const statusEl = assignedButton!.querySelector('[title="In Progress"]');
    const titleEl = assignedButton!.querySelector('[title="Assigned task"]');
    const assigneeEl = assignedRow!.querySelector('[data-testid="task-row-right"]');
    expect(statusEl).toBeInTheDocument();
    expect(titleEl).toBeInTheDocument();
    expect(
      statusEl!.compareDocumentPosition(titleEl!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(assigneeEl).toHaveTextContent("Frodo");

    const unassignedRow = rows[1];
    expect(unassignedRow!.querySelector('[data-testid="task-row-right"]')).toBeNull();
  });

  it("sorts by priority within same status, then by ID", () => {
    const tasks = [
      {
        id: "epic-1.3",
        title: "Low priority",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 2,
        assignee: null,
      },
      {
        id: "epic-1.1",
        title: "High priority",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-1.2",
        title: "Mid priority",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 1,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    const { container } = render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    const epicCard = container.querySelector('[data-testid="epic-card-epic-1"]');
    const listItems = epicCard!.querySelectorAll("ul li");
    const titles = Array.from(listItems).map(
      (li) => li.textContent?.trim().split(/\s+/).slice(0, 2).join(" ") ?? ""
    );
    expect(titles[0]).toContain("High");
    expect(titles[1]).toContain("Mid");
    expect(titles[2]).toContain("Low");
  });
});

describe("ExecutePhase epic completed checkmark", () => {
  beforeEach(() => {
    localStorage.setItem("opensprint.executeView", "kanban");
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentsActive.mockResolvedValue([]);
  });

  it("shows green checkmark on epic card when all child tasks are Done", () => {
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "done",
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-1.2",
        title: "Task B",
        epicId: "epic-1",
        kanbanColumn: "done",
        priority: 1,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    // "All" filter hides fully-completed epics; switch to "Done" filter to see them
    fireEvent.click(screen.getByTestId("filter-chip-done"));

    const epicCard = screen.getByTestId("epic-card-epic-1");
    const checkmark = epicCard.querySelector('[data-testid="epic-completed-checkmark"]');
    expect(checkmark).toBeInTheDocument();
  });

  it("updates checkmark when task status changes via Redux (simulates WebSocket)", async () => {
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "done",
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-1.2",
        title: "Task B",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 1,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByTestId("filter-chip-in_progress"));
    const epicCard = () => screen.getByTestId("epic-card-epic-1");
    expect(
      epicCard().querySelector('[data-testid="epic-completed-checkmark"]')
    ).not.toBeInTheDocument();

    act(() => {
      latestQueryClient.setQueryData(
        queryKeys.tasks.list("proj-1"),
        (tasks: Array<{ id: string }> | undefined) =>
          (tasks ?? []).map((task) =>
            task.id === "epic-1.2" ? { ...task, status: "closed", kanbanColumn: "done" } : task
          )
      );
    });

    // Switch to "done" filter so the epic stays visible (the "all" filter hides fully-completed epics)
    fireEvent.click(screen.getByTestId("filter-chip-done"));

    const checkmark = await screen.findByTestId("epic-completed-checkmark", { timeout: 3000 });
    expect(checkmark).toBeInTheDocument();
  });
});

describe("ExecutePhase top bar", () => {
  beforeEach(() => {
    localStorage.setItem("opensprint.executeView", "kanban");
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows status filter chips with task counts (All, Ready, Done; Blocked only when count > 0; no Planning or Up Next chips)", () => {
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "done",
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-1.2",
        title: "Task B",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 1,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    expect(screen.getByTestId("filter-chip-all")).toHaveTextContent("All");
    expect(screen.getByTestId("filter-chip-all")).toHaveTextContent("2");
    expect(screen.queryByTestId("filter-chip-planning")).not.toBeInTheDocument();
    expect(screen.queryByTestId("filter-chip-in_line")).not.toBeInTheDocument();
    expect(screen.getByTestId("filter-chip-ready")).toHaveTextContent("Ready");
    expect(screen.getByTestId("filter-chip-ready")).toHaveTextContent("1");
    expect(screen.getByTestId("filter-chip-done")).toHaveTextContent("Done");
    expect(screen.getByTestId("filter-chip-done")).toHaveTextContent("1");
    expect(screen.queryByTestId("filter-chip-blocked")).not.toBeInTheDocument();
  });

  it("shows in-progress and in-review counts separately in chips", () => {
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "done",
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-1.2",
        title: "Task B",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 1,
        assignee: "Frodo",
      },
      {
        id: "epic-1.3",
        title: "Task C",
        epicId: "epic-1",
        kanbanColumn: "in_review",
        priority: 2,
        assignee: "Frodo",
      },
    ];
    const store = createStore(tasks);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    expect(screen.getByTestId("filter-chip-in_progress")).toHaveTextContent("2");
    expect(screen.queryByTestId("filter-chip-in_review")).not.toBeInTheDocument();
    expect(screen.getByTestId("filter-chip-done")).toHaveTextContent("1");
  });

  it("shows Blocked chip only when kanbanColumn blocked count > 0", () => {
    const tasks = [
      {
        id: "epic-1.1",
        title: "Blocked task",
        epicId: "epic-1",
        kanbanColumn: "blocked",
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-1.2",
        title: "Ready task",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 1,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    expect(screen.getByTestId("filter-chip-ready")).toHaveTextContent("1");
    expect(screen.getByTestId("filter-chip-blocked")).toHaveTextContent("Blocked");
    expect(screen.getByTestId("filter-chip-blocked")).toHaveTextContent("1");
  });

  it("shows Merge Queue chip when waiting_to_merge tasks exist, ordered In Progress → Blocked → Merge Queue → Ready", () => {
    const tasks = [
      {
        id: "epic-1.1",
        title: "Active task",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-1.2",
        title: "Blocked task",
        epicId: "epic-1",
        kanbanColumn: "blocked",
        priority: 1,
        assignee: null,
      },
      {
        id: "epic-1.3",
        title: "Merge task",
        epicId: "epic-1",
        kanbanColumn: "waiting_to_merge",
        priority: 2,
        assignee: null,
      },
      {
        id: "epic-1.4",
        title: "Ready task",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 3,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    const segmented = screen.getByTestId("execute-filter-segmented");
    const radios = segmented.querySelectorAll('[role="radio"]');
    const filtersInDomOrder = [...radios].map((el) => el.getAttribute("data-testid"));
    const inProgressIdx = filtersInDomOrder.indexOf("filter-chip-in_progress");
    const blockedIdx = filtersInDomOrder.indexOf("filter-chip-blocked");
    const waitingIdx = filtersInDomOrder.indexOf("filter-chip-waiting_to_merge");
    const readyIdx = filtersInDomOrder.indexOf("filter-chip-ready");
    expect(screen.getByTestId("filter-chip-waiting_to_merge")).toHaveTextContent("Merge Queue");
    expect(inProgressIdx).toBeLessThan(blockedIdx);
    expect(blockedIdx).toBeLessThan(waitingIdx);
    expect(waitingIdx).toBeLessThan(readyIdx);
  });

  it("preserves persisted Up Next (in_line) filter on load (no toolbar chip)", async () => {
    localStorage.setItem("opensprint.executeStatusFilter", "in_line");
    const tasks = [
      {
        id: "epic-1.1",
        title: "Backlog task",
        epicId: "epic-1",
        kanbanColumn: "backlog",
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-1.2",
        title: "Ready task",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 1,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    const { container } = render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(container).toHaveTextContent("Backlog task");
    });
    expect(container).not.toHaveTextContent("Ready task");
    expect(localStorage.getItem("opensprint.executeStatusFilter")).toBe("in_line");
    expect(screen.getByTestId("filter-chip-all")).toHaveAttribute("aria-checked", "false");
  });

  it("filters task list when chip is clicked", async () => {
    const user = userEvent.setup();
    const tasks = [
      {
        id: "epic-1.1",
        title: "Done task",
        epicId: "epic-1",
        kanbanColumn: "done",
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-1.2",
        title: "Ready task",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 1,
        assignee: null,
      },
      {
        id: "epic-1.3",
        title: "In progress task",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 2,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    const { container } = render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    expect(container).toHaveTextContent("Ready task");
    expect(container).not.toHaveTextContent("Done task");
    expect(container).not.toHaveTextContent("In progress task");

    await user.click(screen.getByTestId("filter-chip-done"));
    let epicCard = container.querySelector('[data-testid="epic-card-epic-1"]');
    const doneList = epicCard!.querySelectorAll("ul li");
    expect(doneList).toHaveLength(1);
    expect(doneList[0].textContent).toContain("Done task");

    await user.click(screen.getByTestId("filter-chip-ready"));
    epicCard = container.querySelector('[data-testid="epic-card-epic-1"]');
    expect(epicCard!.querySelectorAll("ul li")).toHaveLength(1);
    expect(epicCard!.textContent).toContain("Ready task");

    await user.click(screen.getByTestId("filter-chip-all"));
    expect(screen.getByTestId("filter-chip-all")).toHaveAttribute("aria-checked", "true");
    expect(container).toHaveTextContent("Ready task");
    expect(container).not.toHaveTextContent("Done task");
    expect(container).not.toHaveTextContent("In progress task");
  });

  it("re-clicking active chip (non-All) resets to All", async () => {
    const user = userEvent.setup();
    const tasks = [
      {
        id: "epic-1.1",
        title: "Done task",
        epicId: "epic-1",
        kanbanColumn: "done",
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-1.2",
        title: "Ready task",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 1,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    const { container } = render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await user.click(screen.getByTestId("filter-chip-done"));
    expect(container).toHaveTextContent("Done task");
    expect(container).not.toHaveTextContent("Ready task");

    await user.click(screen.getByTestId("filter-chip-done"));
    expect(screen.getByTestId("filter-chip-all")).toHaveAttribute("aria-checked", "true");
    expect(container).toHaveTextContent("Ready task");
    expect(container).not.toHaveTextContent("Done task");
  });

  it("defaults to All when persisted filter has no visible tasks (e.g. In Progress with 0 tasks)", async () => {
    localStorage.setItem("opensprint.executeStatusFilter", "in_progress");
    const tasks = [
      {
        id: "epic-1.1",
        title: "Ready task",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByTestId("filter-chip-all")).toHaveAttribute("aria-checked", "true");
    });
    expect(localStorage.getItem("opensprint.executeStatusFilter")).toBe("all");
  });

  it("keeps selected filter when it has visible tasks", () => {
    localStorage.setItem("opensprint.executeStatusFilter", "ready");
    const tasks = [
      {
        id: "epic-1.1",
        title: "Ready task",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    expect(screen.getByTestId("filter-chip-ready")).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem("opensprint.executeStatusFilter")).toBe("ready");
  });

  it("shows awaiting approval message when awaitingApproval is true", () => {
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks, { awaitingApproval: true });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    expect(screen.getByText("Awaiting approval")).toBeInTheDocument();
  });
});

describe("ExecutePhase epic merge mode indicator", () => {
  beforeEach(() => {
    localStorage.setItem("opensprint.executeView", "kanban");
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows epic merge mode indicator when project settings have mergeStrategy per_epic", async () => {
    mockGetSettings.mockResolvedValue({ teamMembers: [], mergeStrategy: "per_epic" });
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );
    const indicator = await screen.findByTestId("execute-epic-merge-indicator");
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveTextContent("Epic merge mode");
  });

  it("shows self-improvement indicator when selfImprovementRunInProgress is true", async () => {
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks, { selfImprovementRunInProgress: true });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("execute-filter-toolbar")).toBeInTheDocument();
    });
    expect(screen.getByTestId("execute-self-improvement-indicator")).toBeInTheDocument();
    expect(screen.getByText("Self-improvement review in progress")).toBeInTheDocument();
  });

  it("shows experiment indicator text when selfImprovementRunMode is experiments", async () => {
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks, {
      selfImprovementRunInProgress: true,
      selfImprovementRunMode: "experiments",
    });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("execute-self-improvement-indicator")).toBeInTheDocument();
    });
    expect(screen.getByText("Agent enhancement experiment in progress")).toBeInTheDocument();
  });
});

describe("ExecutePhase expandable search bar", () => {
  beforeEach(() => {
    localStorage.setItem("opensprint.executeView", "kanban");
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders search icon on the far right of the Execute toolbar", () => {
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    expect(screen.getByTestId("execute-search-expand")).toBeInTheDocument();
    expect(screen.getByTestId("execute-search-expand")).toHaveAttribute(
      "aria-label",
      "Expand search"
    );
    expect(screen.queryByTestId("execute-search-expanded")).not.toBeInTheDocument();
  });

  it("expands into text input when search icon is clicked", async () => {
    const user = userEvent.setup();
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await user.click(screen.getByTestId("execute-search-expand"));

    expect(screen.getByTestId("execute-search-expanded")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search tickets…")).toBeInTheDocument();
    expect(screen.getByTestId("execute-search-close")).toBeInTheDocument();
    expect(screen.queryByTestId("execute-search-expand")).not.toBeInTheDocument();
  });

  it("clicking X clears input, hides input, and reverts to icon state", async () => {
    const user = userEvent.setup();
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await user.click(screen.getByTestId("execute-search-expand"));
    const input = screen.getByPlaceholderText("Search tickets…");
    await user.type(input, "foo");

    expect(input).toHaveValue("foo");

    await user.click(screen.getByTestId("execute-search-close"));

    expect(screen.queryByTestId("execute-search-expanded")).not.toBeInTheDocument();
    expect(screen.getByTestId("execute-search-expand")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Search tickets…")).not.toBeInTheDocument();
  });

  it("pressing Escape closes and clears the search bar", async () => {
    const user = userEvent.setup();
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await user.click(screen.getByTestId("execute-search-expand"));
    const input = screen.getByPlaceholderText("Search tickets…");
    await user.type(input, "bar");

    await user.keyboard("{Escape}");

    expect(screen.queryByTestId("execute-search-expanded")).not.toBeInTheDocument();
    expect(screen.getByTestId("execute-search-expand")).toBeInTheDocument();
  });

  it("filters tasks by search query", async () => {
    const user = userEvent.setup();
    const tasks = [
      {
        id: "epic-1.1",
        title: "Add login form",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-1.2",
        title: "Add logout button",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 1,
        assignee: null,
      },
      {
        id: "epic-1.3",
        title: "Fix password reset",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 2,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    const { container } = render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await user.click(screen.getByTestId("execute-search-expand"));
    const input = screen.getByPlaceholderText("Search tickets…");
    fireEvent.change(input, { target: { value: "login" } });

    await waitFor(() => {
      const epicCard = container.querySelector('[data-testid="epic-card-epic-1"]');
      expect(epicCard!.querySelectorAll("ul li")).toHaveLength(1);
      expect(epicCard!.textContent).toContain("Add login form");
    });
  });

  it("works alongside status filter without layout conflicts", async () => {
    const user = userEvent.setup();
    const tasks = [
      {
        id: "epic-1.1",
        title: "Login task",
        epicId: "epic-1",
        kanbanColumn: "done",
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-1.2",
        title: "Logout task",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 1,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    const { container } = render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await user.click(screen.getByTestId("filter-chip-done"));
    expect(
      container.querySelector('[data-testid="epic-card-epic-1"]')!.querySelectorAll("ul li")
    ).toHaveLength(1);

    await user.click(screen.getByTestId("execute-search-expand"));
    const input = screen.getByPlaceholderText("Search tickets…");
    fireEvent.change(input, { target: { value: "Logout" } });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="epic-card-epic-1"]')).not.toBeInTheDocument();
    });

    fireEvent.change(input, { target: { value: "Login" } });

    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="epic-card-epic-1"]')!.querySelectorAll("ul li")
      ).toHaveLength(1);
      expect(container.querySelector('[data-testid="epic-card-epic-1"]')!.textContent).toContain(
        "Login task"
      );
    });
  });

  it("filters by description when title does not match", async () => {
    const tasks = [
      {
        id: "epic-1.1",
        title: "Implement auth",
        description: "Add OAuth2 login flow",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-1.2",
        title: "Add tests",
        description: "Unit tests for auth",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 1,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    const { container } = render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await userEvent.click(screen.getByTestId("execute-search-expand"));
    const input = screen.getByPlaceholderText("Search tickets…");
    fireEvent.change(input, { target: { value: "OAuth2" } });

    await waitFor(() => {
      const epicCard = container.querySelector('[data-testid="epic-card-epic-1"]');
      expect(epicCard!.querySelectorAll("ul li")).toHaveLength(1);
      expect(epicCard!.textContent).toContain("Implement auth");
    });
  });

  it("hides epic cards with zero matching tickets when search is active", async () => {
    const tasks = [
      {
        id: "epic-1.1",
        title: "Login task",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-2.1",
        title: "Unrelated task",
        epicId: "epic-2",
        kanbanColumn: "ready",
        priority: 0,
        assignee: null,
      },
    ];
    const plan2 = {
      ...basePlan,
      metadata: {
        ...basePlan.metadata,
        planId: "plan-2",
        epicId: "epic-2",
      },
      content: "# Other Epic",
    };
    const store = configureStore({
      reducer: {
        project: projectReducer,
        plan: planReducer,
        execute: executeReducer,
        unreadPhase: unreadPhaseReducer,
      },
      preloadedState: {
        plan: {
          plans: [basePlan, plan2],
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
          ...toTasksByIdAndOrder(tasks as Parameters<typeof toTasksByIdAndOrder>[0]),
          awaitingApproval: false,
          orchestratorRunning: false,
          activeTasks: [],
          selectedTaskId: null,
          taskDetailLoading: false,
          taskDetailError: null,
          agentOutput: {},
          completionState: null,
          archivedSessions: [],
          archivedLoading: false,
          markDoneLoading: false,
          unblockLoading: false,
          statusLoading: false,
          loading: false,
          error: null,
        },
      },
    });
    const { container } = render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    expect(container.querySelectorAll('[data-testid^="epic-card-"]')).toHaveLength(2);

    await userEvent.click(screen.getByTestId("execute-search-expand"));
    fireEvent.change(screen.getByPlaceholderText("Search tickets…"), {
      target: { value: "Login" },
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="epic-card-epic-1"]')).toBeInTheDocument();
      expect(container.querySelector('[data-testid="epic-card-epic-2"]')).not.toBeInTheDocument();
    });
  });

  it("clearing search via X restores full unfiltered view", async () => {
    const user = userEvent.setup();
    const tasks = [
      {
        id: "epic-1.1",
        title: "Add login",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-1.2",
        title: "Add logout",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 1,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    const { container } = render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await user.click(screen.getByTestId("execute-search-expand"));
    fireEvent.change(screen.getByPlaceholderText("Search tickets…"), {
      target: { value: "login" },
    });

    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="epic-card-epic-1"]')!.querySelectorAll("ul li")
      ).toHaveLength(1);
    });

    await user.click(screen.getByTestId("execute-search-close"));

    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="epic-card-epic-1"]')!.querySelectorAll("ul li")
      ).toHaveLength(2);
    });

    await user.click(screen.getByTestId("execute-search-expand"));
    const input = screen.getByPlaceholderText("Search tickets…");
    expect(input).toHaveValue("");
  });

  it("shows filtered indicator in epic card progress when search is active", async () => {
    const tasks = [
      {
        id: "epic-1.1",
        title: "Login task",
        epicId: "epic-1",
        kanbanColumn: "done",
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-1.2",
        title: "Logout task",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 1,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    const { container } = render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await userEvent.click(screen.getByTestId("execute-search-expand"));
    fireEvent.change(screen.getByPlaceholderText("Search tickets…"), {
      target: { value: "Logout" },
    });

    await waitFor(() => {
      const epicCard = container.querySelector('[data-testid="epic-card-epic-1"]');
      expect(epicCard).toBeInTheDocument();
      expect(epicCard!.textContent).toContain("filtered");
    });
  });
});

describe("ExecutePhase mobile layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem("opensprint.executeView", "kanban");
  });

  it("task detail sidebar renders inline (no overlay, no backdrop) on mobile viewport (< 768px)", async () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: MOBILE_BREAKPOINT - 1, writable: true });

    mockGet.mockResolvedValue({
      id: "epic-1.1",
      title: "Task A",
      epicId: "epic-1",
      kanbanColumn: "in_progress",
      description: "",
      type: "task",
      status: "open",
      labels: [],
      dependencies: [],
      createdAt: "",
      updatedAt: "",
      priority: 0,
      assignee: null,
    });
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    // Execute sidebar uses overlayOnMobile=false: always inline, no backdrop (same as Plan/Sketch)
    expect(
      screen.queryByRole("button", { name: "Close sidebar (backdrop)" })
    ).not.toBeInTheDocument();

    Object.defineProperty(window, "innerWidth", { value: originalInnerWidth, writable: true });
  });
});

describe("ExecutePhase view toggle", () => {
  const STORAGE_KEY = "opensprint.executeView";

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem(STORAGE_KEY);
  });

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  it("default renders queue/list (Timeline) view", () => {
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    expect(screen.getByTestId("timeline-list")).toBeInTheDocument();
    expect(screen.queryByTestId("epic-card-epic-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("view-toggle-timeline")).toHaveAttribute("aria-checked", "true");
  });

  it("clicking Kanban toggle renders Kanban grid and hides TimelineList", async () => {
    const user = userEvent.setup();
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    expect(screen.getByTestId("timeline-list")).toBeInTheDocument();

    await user.click(screen.getByTestId("view-toggle-kanban"));

    expect(screen.getByTestId("epic-card-epic-1")).toBeInTheDocument();
    expect(screen.queryByTestId("timeline-list")).not.toBeInTheDocument();
    expect(screen.getByTestId("view-toggle-kanban")).toHaveAttribute("aria-checked", "true");
  });

  it("filter chips and search apply in Timeline mode", async () => {
    const user = userEvent.setup();
    const tasks = [
      {
        id: "epic-1.1",
        title: "Done task",
        epicId: "epic-1",
        kanbanColumn: "done",
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-1.2",
        title: "Ready task",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 1,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    expect(screen.getByTestId("timeline-list")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-row-epic-1.1")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-row-epic-1.2")).toBeInTheDocument();

    await user.click(screen.getByTestId("filter-chip-done"));
    expect(screen.getByTestId("timeline-row-epic-1.1")).toBeInTheDocument();
    expect(screen.queryByTestId("timeline-row-epic-1.2")).not.toBeInTheDocument();
  });

  it("Queue view with All filter shows Failures section when blocked tasks exist", async () => {
    const user = userEvent.setup();
    const tasks = [
      {
        id: "epic-1.1",
        title: "Blocked task",
        epicId: "epic-1",
        kanbanColumn: "blocked",
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-1.2",
        title: "Ready task",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 1,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await user.click(screen.getByTestId("filter-chip-all"));

    expect(screen.getByTestId("timeline-section-blocked")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Failures" })).toBeInTheDocument();
    expect(screen.getByText("Blocked task")).toBeInTheDocument();
    expect(screen.getByText("Ready task")).toBeInTheDocument();
    const blockedSection = screen.getByTestId("timeline-section-blocked");
    expect(blockedSection).toContainElement(screen.getByTestId("timeline-row-epic-1.1"));
    expect(screen.getByTestId("timeline-section-ready")).not.toContainElement(
      screen.getByTestId("timeline-row-epic-1.1")
    );
  });

  it("Failures filter shows only failed tickets in Timeline view", async () => {
    const user = userEvent.setup();
    const tasks = [
      {
        id: "epic-1.1",
        title: "Blocked task",
        epicId: "epic-1",
        kanbanColumn: "blocked",
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-1.2",
        title: "Ready task",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 1,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await user.click(screen.getByTestId("filter-chip-blocked"));

    expect(screen.getByTestId("filter-chip-blocked")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("timeline-section-blocked")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Failures" })).toBeInTheDocument();
    expect(screen.getByText("Blocked task")).toBeInTheDocument();
    expect(screen.queryByText("Ready task")).not.toBeInTheDocument();
  });

  it("sidebar opens from Timeline row click", async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue({ id: "epic-1.1", title: "Task A", kanbanColumn: "in_progress" });
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await user.click(screen.getByTestId("timeline-row-epic-1.1"));

    await waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });
    expect(screen.getByTestId("task-detail-title")).toHaveTextContent("Task A");
  });

  it("view preference restores from localStorage on mount", () => {
    localStorage.setItem(STORAGE_KEY, "timeline");
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    expect(screen.getByTestId("timeline-list")).toBeInTheDocument();
    expect(screen.queryByTestId("epic-card-epic-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("view-toggle-timeline")).toHaveAttribute("aria-checked", "true");
  });

  it("renders timeline rows on initial mount when timeline view is persisted and list exceeds virtualization threshold", () => {
    localStorage.setItem(STORAGE_KEY, "timeline");
    const tasks = Array.from({ length: 30 }, (_, index) => ({
      id: `epic-1.${index + 1}`,
      title: `Task ${index + 1}`,
      epicId: "epic-1",
      kanbanColumn: index % 2 === 0 ? ("in_progress" as const) : ("ready" as const),
      priority: index % 3,
      assignee: null,
    }));
    const store = createStore(tasks);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    expect(screen.getByTestId("timeline-list")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-row-epic-1.1")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "In Progress" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ready" })).toBeInTheDocument();
  });
});

describe("ExecutePhase Redux integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem("opensprint.executeView", "kanban");
  });

  it("renders OpenQuestionsBlock in task detail when coder has open questions", async () => {
    const taskNotification = {
      id: "oq-exec-1",
      projectId: "proj-1",
      source: "execute" as const,
      sourceId: "epic-1.1",
      questions: [
        { id: "q1", text: "Which database should I use?", createdAt: "2025-01-01T00:00:00Z" },
      ],
      status: "open" as const,
      createdAt: "2025-01-01T00:00:00Z",
      resolvedAt: null,
    };
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    store.dispatch(addOpenQuestionNotification(taskNotification));
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByTestId("open-questions-block")).toBeInTheDocument();
    });
    expect(screen.getByText("Which database should I use?")).toBeInTheDocument();
  });

  it("dispatches fetchTaskDetail when a task is selected", async () => {
    mockGet.mockResolvedValue({ id: "epic-1.1", title: "Task A", kanbanColumn: "in_progress" });
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: "agent",
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });
  });

  it("dispatches markTaskDone when Mark done is clicked from actions menu", async () => {
    const user = userEvent.setup();
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: "agent",
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    const menuTrigger = await screen.findByTestId("sidebar-actions-menu-trigger");
    await user.click(menuTrigger);
    const markDoneBtn = await screen.findByRole("menuitem", { name: /mark done/i });
    await user.click(markDoneBtn);

    await vi.waitFor(() => {
      expect(mockMarkDone).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });
  });

  it("shows Retry and Mark done in actions menu for blocked tasks and dispatches unblockTask when clicked", async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue({ id: "epic-1.1", title: "Blocked Task", kanbanColumn: "blocked" });
    const tasks = [
      {
        id: "epic-1.1",
        title: "Blocked Task",
        epicId: "epic-1",
        kanbanColumn: "blocked",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    const menuTrigger = await screen.findByTestId("sidebar-actions-menu-trigger");
    await user.click(menuTrigger);
    const unblockBtn = await screen.findByTestId("sidebar-retry-btn");
    expect(unblockBtn).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /mark done/i })).toBeInTheDocument();

    await user.click(unblockBtn);

    await vi.waitFor(() => {
      expect(mockUnblock).toHaveBeenCalledWith("proj-1", "epic-1.1", expect.anything());
    });
  });

  it("dispatches deleteTask when Delete is confirmed from actions menu", async () => {
    const user = userEvent.setup();
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: "agent",
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    const menuTrigger = await screen.findByTestId("sidebar-actions-menu-trigger");
    await user.click(menuTrigger);
    await user.click(screen.getByTestId("sidebar-delete-task-btn"));
    expect(screen.getByTestId("sidebar-delete-task-dialog")).toBeInTheDocument();
    await user.click(screen.getByTestId("sidebar-delete-task-confirm-btn"));

    await vi.waitFor(() => {
      expect(mockDeleteTask).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });
    await vi.waitFor(() => {
      expect(store.getState().execute.selectedTaskId).toBeNull();
    });
  });

  it("closes task detail panel when X close button is clicked", async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue({ id: "epic-1.1", title: "Task A", kanbanColumn: "in_progress" });
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    const closeBtn = screen.getByRole("button", { name: "Close task detail" });
    await user.click(closeBtn);

    expect(store.getState().execute.selectedTaskId).toBeNull();
  });

  it("calls onClose when X close button is clicked (sidebar opened via URL param)", async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue({ id: "epic-1.1", title: "Task A", kanbanColumn: "in_progress" });
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks, { selectedTaskId: null });
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" initialTaskIdFromUrl="epic-1.1" onClose={onClose} />
        </Provider>
      </MemoryRouter>
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    const closeBtn = screen.getByRole("button", { name: "Close task detail" });
    await user.click(closeBtn);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("main task list scroll container is scrollable when sidebar is open", async () => {
    mockGet.mockResolvedValue({ id: "epic-1.1", title: "Task A", kanbanColumn: "in_progress" });
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    const scrollContainer = screen.getByTestId("execute-main-scroll");
    expect(scrollContainer).toBeInTheDocument();

    // Simulate scrollable content: mock scrollHeight > clientHeight so scroll position can change
    Object.defineProperty(scrollContainer, "scrollHeight", { value: 800, configurable: true });
    Object.defineProperty(scrollContainer, "clientHeight", { value: 400, configurable: true });

    act(() => {
      scrollContainer.scrollTop = 100;
    });
    expect(scrollContainer.scrollTop).toBe(100);

    act(() => {
      scrollContainer.scrollTop = 200;
    });
    expect(scrollContainer.scrollTop).toBe(200);
  });

  it("renders a root container for page/sidebar layout", () => {
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    const { container } = render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );
    expect(container.firstElementChild).toBeInTheDocument();
  });

  it("renders resizable sidebar with resize handle when a task is selected", async () => {
    mockGet.mockResolvedValue({ id: "epic-1.1", title: "Task A", kanbanColumn: "in_progress" });
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    expect(screen.getByRole("slider", { name: "Resize task detail sidebar" })).toBeInTheDocument();
  });

  it("persists task detail sidebar width to localStorage when resized (matches Plan/Sketch)", async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    mockGet.mockResolvedValue({ id: "epic-1.1", title: "Task A", kanbanColumn: "in_progress" });
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    const handle = screen.getByRole("slider", { name: "Resize task detail sidebar" });
    handle.dispatchEvent(new MouseEvent("mousedown", { clientX: 100, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 80, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    expect(setItemSpy).toHaveBeenCalledWith("opensprint-sidebar-width-execute", expect.any(String));
    setItemSpy.mockRestore();
  });

  it("live agent output area is scrollable (overflow-y-auto) and auto-scrolls to latest content by default", async () => {
    mockGet.mockResolvedValue({ id: "epic-1.1", title: "Task A", kanbanColumn: "in_progress" });
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
    ];
    mockLiveOutput.mockResolvedValue({ output: "Line 1\nLine 2\nLine 3\n" });
    const store = createStore(
      tasks,
      {
        selectedTaskId: "epic-1.1",
        agentOutput: { "epic-1.1": ["Line 1\n", "Line 2\n", "Line 3\n"] },
      },
      { connected: true }
    );
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    const liveOutput = await vi.waitFor(() => {
      const el = screen.getByTestId("live-agent-output");
      expect(el).toHaveTextContent("Line 1");
      return el;
    });
    expect(liveOutput).toHaveTextContent("Line 2");
    expect(liveOutput).toHaveTextContent("Line 3");
  });

  it("shows connecting state and retry button when WebSocket is not connected", async () => {
    mockGet.mockResolvedValue({ id: "epic-1.1", title: "Task A", kanbanColumn: "in_progress" });
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await vi.waitFor(() => {
      expect(screen.getByTestId("live-output-connecting")).toBeInTheDocument();
      expect(screen.getByText("Connecting to live output…")).toBeInTheDocument();
      expect(screen.getByTestId("live-output-retry")).toBeInTheDocument();
    });
  });

  it("shows a baseline pause banner when baseline quality gates are failing", async () => {
    mockGet.mockResolvedValue({ id: "epic-1.1", title: "Task A", kanbanColumn: "in_progress" });
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(
      tasks,
      {
        selectedTaskId: "epic-1.1",
        baselineStatus: "failing",
        dispatchPausedReason:
          "Only the baseline-remediation task will be assigned until the baseline passes.",
        baselineFailureSummary: "npm run test: src/task-route.test.ts expected 200 to be 500",
      },
      { connected: true }
    );

    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await vi.waitFor(() => {
      expect(screen.getByTestId("execute-baseline-paused-banner")).toBeInTheDocument();
      expect(
        screen.getByText("Merge queue paused until baseline quality gates on main pass.")
      ).toBeInTheDocument();
      expect(
        screen.getByText("npm run test: src/task-route.test.ts expected 200 to be 500")
      ).toBeInTheDocument();
    });
  });

  it("shows repair progress in the baseline banner when remediation status is provided", async () => {
    mockGet.mockResolvedValue({ id: "epic-1.1", title: "Task A", kanbanColumn: "in_progress" });
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(
      tasks,
      {
        selectedTaskId: "epic-1.1",
        baselineStatus: "failing",
        baselineFailureSummary: "npm run test: something failed",
        baselineRemediationStatus: {
          taskId: "os-rem-1",
          attempts: 2,
          maxAttempts: 3,
          status: "open",
        },
      },
      { connected: true }
    );

    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await vi.waitFor(() => {
      expect(screen.getByTestId("execute-baseline-paused-banner")).toBeInTheDocument();
      expect(screen.getByTestId("execute-baseline-remediation-status")).toHaveTextContent(
        "Repair in progress (attempt 2 of 3)."
      );
    });
  });

  it("shows blocked repair status in the baseline banner", async () => {
    mockGet.mockResolvedValue({ id: "epic-1.1", title: "Task A", kanbanColumn: "in_progress" });
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(
      tasks,
      {
        selectedTaskId: "epic-1.1",
        baselineStatus: "failing",
        baselineFailureSummary: "npm run test: something failed",
        baselineRemediationStatus: {
          taskId: "os-rem-1",
          attempts: 3,
          maxAttempts: 3,
          status: "blocked",
        },
      },
      { connected: true }
    );

    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await vi.waitFor(() => {
      expect(screen.getByTestId("execute-baseline-paused-banner")).toBeInTheDocument();
      expect(screen.getByTestId("execute-baseline-remediation-status")).toHaveTextContent(
        "Repair blocked after 3 attempts."
      );
    });
  });

  it("does not loop archived-session refetches when the server returns an empty list", async () => {
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(mockSessions.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    expect(mockSessions.mock.calls.length).toBe(2);
  });

  it("backfills live output on mount and again after websocket reconnect", async () => {
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(
      tasks,
      { selectedTaskId: "epic-1.1", agentOutput: { "epic-1.1": ["Initial"] } },
      { connected: false }
    );
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(mockLiveOutput).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });
    const initialCalls = mockLiveOutput.mock.calls.length;

    await act(async () => {
      store.dispatch(setConnected(true));
    });

    await waitFor(
      () => {
        expect(mockLiveOutput.mock.calls.length).toBeGreaterThan(initialCalls);
      },
      { timeout: 15000 }
    );
    expect(mockLiveOutput.mock.calls.at(-1)).toEqual(["proj-1", "epic-1.1"]);
  }, 30000);

  it("task detail sidebar header shows only task title, not redundant Task label", async () => {
    mockGet.mockResolvedValue({
      id: "epic-1.1",
      title: "Implement feature X",
      kanbanColumn: "in_progress",
      description: "Short desc",
    });
    const tasks = [
      {
        id: "epic-1.1",
        title: "Implement feature X",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    const header = screen.getByTestId("task-detail-title");
    expect(header).toHaveTextContent("Implement feature X");
    expect(header).not.toHaveTextContent(/^Task$/);
    // No separate "Task" label in the detail section
    const taskLabels = screen.queryAllByText(/^Task$/);
    expect(taskLabels).toHaveLength(0);
  });

  it("task description renders fully and is scrollable when long", async () => {
    const longDescription = "Line 1\n".repeat(100) + "Final line";
    mockGet.mockResolvedValue({
      id: "epic-1.1",
      title: "Task A",
      kanbanColumn: "in_progress",
      description: longDescription,
      type: "task",
      status: "in_progress",
      labels: [],
      dependencies: [],
      priority: 0,
      assignee: null,
      epicId: "epic-1",
      createdAt: "",
      updatedAt: "",
    });
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    const descriptionContainer = await screen.findByTestId("task-description-markdown", {
      timeout: 5000,
    });
    expect(descriptionContainer).toHaveTextContent("Final line");
  });

  it("omits Description section when task has no description content", async () => {
    mockGet.mockResolvedValue({
      id: "epic-1.1",
      title: "Task A",
      kanbanColumn: "in_progress",
      description: "",
      type: "task",
      status: "in_progress",
      labels: [],
      dependencies: [],
      priority: 0,
      assignee: null,
      epicId: "epic-1",
      createdAt: "",
      updatedAt: "",
    });
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    expect(screen.queryByRole("button", { name: /description/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId("task-description-markdown")).not.toBeInTheDocument();
  });
});

describe("ExecutePhase task detail plan link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not show plan link when onNavigateToPlan is not provided", async () => {
    const taskDetail = {
      id: "epic-1.1",
      title: "Task A",
      epicId: "epic-1",
      kanbanColumn: "in_progress" as const,
      priority: 0,
      assignee: "agent",
      description: "",
      type: "task" as const,
      status: "in_progress" as const,
      labels: [],
      dependencies: [],
      createdAt: "",
      updatedAt: "",
    };
    mockGet.mockResolvedValue(taskDetail);
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: "agent",
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    expect(screen.queryByTestId("sidebar-view-plan-btn")).not.toBeInTheDocument();
  });

  it("does not show plan link when task has no epicId", async () => {
    const taskDetail = {
      id: "other-1",
      title: "Orphan Task",
      epicId: null,
      kanbanColumn: "ready" as const,
      priority: 0,
      assignee: null,
      description: "",
      type: "task" as const,
      status: "open" as const,
      labels: [],
      dependencies: [],
      createdAt: "",
      updatedAt: "",
    };
    mockGet.mockResolvedValue(taskDetail);
    const tasks = [
      {
        id: "other-1",
        title: "Orphan Task",
        epicId: null,
        kanbanColumn: "ready",
        priority: 0,
        assignee: null,
      },
    ];
    const onNavigateToPlan = vi.fn();
    const store = createStore(tasks, { selectedTaskId: "other-1" });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" onNavigateToPlan={onNavigateToPlan} />
        </Provider>
      </MemoryRouter>
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "other-1");
    });

    expect(screen.queryByTestId("sidebar-view-plan-btn")).not.toBeInTheDocument();
  });

  it("calls onNavigateToPlan with planId when plan link is clicked", async () => {
    const user = userEvent.setup();
    const taskDetail = {
      id: "epic-1.1",
      title: "Task A",
      epicId: "epic-1",
      kanbanColumn: "in_progress" as const,
      priority: 0,
      assignee: "agent",
      description: "",
      type: "task" as const,
      status: "in_progress" as const,
      labels: [],
      dependencies: [],
      createdAt: "",
      updatedAt: "",
    };
    mockGet.mockResolvedValue(taskDetail);
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: "agent",
      },
    ];
    const onNavigateToPlan = vi.fn();
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" onNavigateToPlan={onNavigateToPlan} />
        </Provider>
      </MemoryRouter>
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    const planLink = await screen.findByTestId("sidebar-view-plan-btn");
    await user.click(planLink);

    expect(onNavigateToPlan).toHaveBeenCalledWith("build-test-feature");
  });
});

describe("ExecutePhase epic card plan navigation", () => {
  beforeEach(() => {
    localStorage.setItem("opensprint.executeView", "kanban");
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clicking epic card title navigates to plan", async () => {
    const user = userEvent.setup();
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: "agent",
      },
    ];
    const onNavigateToPlan = vi.fn();
    const store = createStore(tasks);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" onNavigateToPlan={onNavigateToPlan} />
        </Provider>
      </MemoryRouter>
    );

    await user.click(screen.getByTestId("filter-chip-in_progress"));
    const epicTitleButton = await screen.findByRole("button", { name: "Build Test" });
    await user.click(epicTitleButton);

    expect(onNavigateToPlan).toHaveBeenCalledWith("build-test-feature");
  });

  it("epic card title is not clickable when onNavigateToPlan is not provided", async () => {
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: "agent",
      },
    ];
    const store = createStore(tasks);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByTestId("filter-chip-in_progress"));
    await screen.findByText("Build Test");
    expect(screen.queryByRole("button", { name: "Build Test" })).not.toBeInTheDocument();
  });
});

describe("ExecutePhase Source feedback section", () => {
  beforeEach(() => {
    localStorage.setItem("opensprint.executeView", "kanban");
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mockFeedbackGet.mockResolvedValue(null);
  });

  it("shows collapsible Source feedback section for feedback-originated tasks", async () => {
    const taskDetail = {
      id: "epic-1.1",
      title: "Implement feature from feedback",
      epicId: "epic-1",
      kanbanColumn: "in_progress" as const,
      priority: 0,
      assignee: "agent",
      description: "Implement the requested change",
      type: "task" as const,
      status: "in_progress" as const,
      labels: [],
      dependencies: [],
      createdAt: "",
      updatedAt: "",
      sourceFeedbackId: "fb-xyz123",
    };
    mockGet.mockResolvedValue(taskDetail);
    const tasks = [
      {
        id: "epic-1.1",
        title: "Implement feature",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: "agent",
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    expect(await screen.findByRole("button", { name: /source feedback/i })).toBeInTheDocument();
  });

  it("omits Source feedback section for tasks without sourceFeedbackId", async () => {
    const taskDetail = {
      id: "epic-1.1",
      title: "Regular task",
      epicId: "epic-1",
      kanbanColumn: "in_progress" as const,
      priority: 0,
      assignee: "agent",
      description: "Normal task description",
      type: "task" as const,
      status: "in_progress" as const,
      labels: [],
      dependencies: [],
      createdAt: "",
      updatedAt: "",
    };
    mockGet.mockResolvedValue(taskDetail);
    const tasks = [
      {
        id: "epic-1.1",
        title: "Regular task",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: "agent",
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    expect(screen.queryByRole("button", { name: /source feedback/i })).not.toBeInTheDocument();
  });

  it("does not show raw Feedback ID in description when task has sourceFeedbackId", async () => {
    const taskDetail = {
      id: "epic-1.1",
      title: "Feedback: Fix the bug",
      epicId: null,
      kanbanColumn: "ready" as const,
      priority: 4,
      assignee: null,
      description: "Feedback ID: fb-abc",
      type: "chore" as const,
      status: "open" as const,
      labels: [],
      dependencies: [],
      createdAt: "",
      updatedAt: "",
      sourceFeedbackId: "fb-abc",
    };
    mockGet.mockResolvedValue(taskDetail);
    const tasks = [
      {
        id: "epic-1.1",
        title: "Feedback: Fix the bug",
        epicId: null,
        kanbanColumn: "ready",
        priority: 4,
        assignee: null,
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    expect(screen.queryByText("Feedback ID: fb-abc")).not.toBeInTheDocument();
  });

  it("persists Source Feedback collapsed state when switching tasks and back", async () => {
    const taskWithFeedback = {
      id: "epic-1.1",
      title: "Task with feedback",
      epicId: "epic-1",
      kanbanColumn: "in_progress" as const,
      priority: 0,
      assignee: "agent",
      description: "Task details",
      type: "task" as const,
      status: "in_progress" as const,
      labels: [],
      dependencies: [],
      createdAt: "",
      updatedAt: "",
      sourceFeedbackId: "fb-xyz",
    };
    const taskWithoutFeedback = {
      id: "epic-1.2",
      title: "Task without feedback",
      epicId: "epic-1",
      kanbanColumn: "ready" as const,
      priority: 0,
      assignee: null,
      description: "Other task",
      type: "task" as const,
      status: "open" as const,
      labels: [],
      dependencies: [],
      createdAt: "",
      updatedAt: "",
    };
    mockGet.mockImplementation((_proj: string, taskId: string) => {
      if (taskId === "epic-1.1") return Promise.resolve(taskWithFeedback);
      if (taskId === "epic-1.2") return Promise.resolve(taskWithoutFeedback);
      return Promise.resolve({});
    });
    mockFeedbackGet.mockResolvedValue({
      id: "fb-xyz",
      text: "Please add dark mode",
      category: "feature",
      mappedPlanId: "build-test-feature",
      createdTaskIds: ["epic-1.1"],
      status: "pending",
      createdAt: "2026-02-17T10:00:00Z",
    });
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task with feedback",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: "agent",
      },
      {
        id: "epic-1.2",
        title: "Task without feedback",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await vi.waitFor(() => {
      expect(screen.getByTestId("source-feedback-card")).toBeInTheDocument();
    });

    const toggleBtn = screen.getByRole("button", { name: /source feedback/i });
    await userEvent.click(toggleBtn);
    expect(screen.queryByTestId("source-feedback-card")).not.toBeInTheDocument();

    store.dispatch(setSelectedTaskId("epic-1.2"));
    await vi.waitFor(() => {
      expect(screen.getByText("Task without feedback")).toBeInTheDocument();
    });

    store.dispatch(setSelectedTaskId("epic-1.1"));
    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    expect(screen.queryByTestId("source-feedback-card")).not.toBeInTheDocument();
  });

  it("shows Resolved chip in Source feedback section when feedback is resolved", async () => {
    const taskDetail = {
      id: "epic-1.1",
      title: "Implement feature",
      epicId: "epic-1",
      kanbanColumn: "in_progress" as const,
      priority: 0,
      assignee: "agent",
      description: "Task details",
      type: "task" as const,
      status: "in_progress" as const,
      labels: [],
      dependencies: [],
      createdAt: "",
      updatedAt: "",
      sourceFeedbackId: "fb-resolved",
    };
    mockGet.mockResolvedValue(taskDetail);
    mockFeedbackGet.mockResolvedValue({
      id: "fb-resolved",
      text: "Fixed login bug",
      category: "bug",
      mappedPlanId: "build-auth",
      createdTaskIds: ["epic-1.1"],
      status: "resolved",
      createdAt: "2026-02-17T10:00:00Z",
    });
    const tasks = [
      {
        id: "epic-1.1",
        title: "Implement feature",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: "agent",
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    await vi.waitFor(() => {
      expect(mockFeedbackGet).toHaveBeenCalledWith("proj-1", "fb-resolved");
    });

    expect(await screen.findByTestId("source-feedback-card")).toBeInTheDocument();
    expect(screen.getByText("Resolved")).toBeInTheDocument();
    expect(screen.getByText("Fixed login bug")).toBeInTheDocument();
    // Category chip (Bug) is not shown in Execute sidebar (reduced clutter)
    expect(screen.queryByText("Bug")).not.toBeInTheDocument();
  });
});

describe("ExecutePhase task detail cached state", () => {
  let pendingAbort: AbortController;

  function neverResolves() {
    pendingAbort = new AbortController();
    return new Promise((_resolve, reject) => {
      pendingAbort.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentsActive.mockResolvedValue([]);
  });

  afterEach(() => {
    pendingAbort?.abort();
  });

  it("task detail shows Waiting to Merge when list task has kanbanColumn waiting_to_merge", () => {
    mockGet.mockImplementation(() => neverResolves());
    const tasks = [
      {
        id: "epic-1.1",
        title: "Queued merge",
        epicId: "epic-1",
        kanbanColumn: "waiting_to_merge" as const,
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    const row = screen.getByTestId("task-detail-priority-state-row");
    expect(row).toHaveTextContent("Waiting to Merge");
    expect(row.querySelector('[title="Waiting to Merge"]')).toBeInTheDocument();
  });

  it("task detail shows Blocked on main hint when waiting_to_merge and mergeWaitingOnMain", () => {
    mockGet.mockImplementation(() => neverResolves());
    const tasks = [
      {
        id: "epic-1.1",
        title: "Paused merge",
        epicId: "epic-1",
        kanbanColumn: "waiting_to_merge" as const,
        priority: 0,
        assignee: null,
        mergeWaitingOnMain: true,
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    expect(screen.getByTestId("task-detail-merge-waiting-on-main-hint")).toHaveTextContent(
      "· Blocked on main"
    );
  });

  it("shows loading skeleton for detail-dependent fields while fetching", () => {
    mockGet.mockImplementation(() => neverResolves());
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    );

    expect(screen.getByTestId("task-detail-loading")).toBeInTheDocument();
    expect(screen.getByTestId("artifacts-loading")).toBeInTheDocument();
  });
});
