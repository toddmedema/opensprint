import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { ExecutePhase } from "./ExecutePhase";
import {
  setSelectedTaskId,
  taskUpdated,
  initialExecuteState,
} from "../../store/slices/executeSlice";
import projectReducer from "../../store/slices/projectSlice";
import planReducer from "../../store/slices/planSlice";
import executeReducer from "../../store/slices/executeSlice";
import evalReducer from "../../store/slices/evalSlice";
import websocketReducer from "../../store/slices/websocketSlice";
const mockGet = vi.fn().mockResolvedValue({});
const mockMarkDone = vi.fn().mockResolvedValue(undefined);
const mockUnblock = vi.fn().mockResolvedValue({ taskUnblocked: true });
const mockFeedbackGet = vi.fn().mockResolvedValue(null);
const mockAgentsActive = vi.fn().mockResolvedValue([]);

vi.mock("../../api/client", () => ({
  api: {
    tasks: {
      list: vi.fn().mockResolvedValue([]),
      get: (...args: unknown[]) => mockGet(...args),
      sessions: vi.fn().mockResolvedValue([]),
      markDone: (...args: unknown[]) => mockMarkDone(...args),
      unblock: (...args: unknown[]) => mockUnblock(...args),
    },
    plans: {
      list: vi.fn().mockResolvedValue({ plans: [], edges: [] }),
    },
    execute: {
      status: vi.fn().mockResolvedValue({}),
      liveOutput: vi.fn().mockResolvedValue({ output: "" }),
    },
    agents: {
      active: (...args: unknown[]) => mockAgentsActive(...args),
    },
    feedback: {
      get: (...args: unknown[]) => mockFeedbackGet(...args),
    },
  },
}));

beforeEach(() => {
  localStorage.removeItem("opensprint.executeStatusFilter");
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

function createStore(
  tasks: {
    id: string;
    kanbanColumn: string;
    epicId: string;
    title: string;
    priority: number;
    assignee: string | null;
  }[],
  buildOverrides?: Partial<{
    orchestratorRunning: boolean;
    selectedTaskId: string | null;
    awaitingApproval: boolean;
    agentOutput: Record<string, string[]>;
    taskDetailError: string | null;
    activeTasks: { taskId: string; phase: string; startedAt: string }[];
    taskIdToStartedAt: Record<string, string>;
  }>,
  websocketOverrides?: Partial<{ connected: boolean }>
) {
  return configureStore({
    reducer: {
      project: projectReducer,
      plan: planReducer,
      execute: executeReducer,
      eval: evalReducer,
      websocket: websocketReducer,
    },
    preloadedState: {
      websocket: {
        connected: false,
        hilRequest: null,
        hilNotification: null,
        deliverToast: null,
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
          tasks,
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
    },
  });
}

describe("ExecutePhase epic card task order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentsActive.mockResolvedValue([]);
  });

  it("sorts epic card tasks by status: In Progress → In Review → Ready → Backlog → Done", () => {
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
    ];
    const store = createStore(tasks);
    const { container } = render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    const epicCard = container.querySelector('[data-testid="epic-card-epic-1"]');
    expect(epicCard).toBeInTheDocument();
    const listItems = epicCard!.querySelectorAll("ul li");
    expect(listItems).toHaveLength(3);
    expect(listItems[0].textContent).toContain("In progress task");
    expect(listItems[1].textContent).toContain("Ready task");
    expect(listItems[2].textContent).toContain("Done task");
  });

  it("renders task rows with status left and assignee right (no duplicate indicators)", () => {
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
        kanbanColumn: "ready",
        priority: 1,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    const { container } = render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    const epicCard = container.querySelector('[data-testid="epic-card-epic-1"]');
    expect(epicCard).toBeInTheDocument();

    // Assigned task: status left, assignee right
    const assignedRow = epicCard!.querySelector("li");
    expect(assignedRow).toBeTruthy();
    const assignedButton = assignedRow!.querySelector("button");
    const assignedChildren = Array.from(assignedButton!.children);
    const titleIdx = assignedChildren.findIndex((el) => el.textContent?.includes("Assigned task"));
    const statusIdx = assignedChildren.findIndex(
      (el) => el.getAttribute("title") === "In Progress"
    );
    const assigneeEl = assignedRow!.querySelector('[data-testid="task-row-right"]');
    expect(statusIdx).toBeGreaterThanOrEqual(0);
    expect(statusIdx).toBeLessThan(titleIdx);
    expect(assigneeEl).toHaveTextContent("Frodo");

    // Unassigned task: no assignee element on right (no empty dot or placeholder)
    const unassignedRow = epicCard!.querySelectorAll("li")[1];
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    // "All" filter hides fully-completed epics; switch to "Done" filter to see them
    fireEvent.click(screen.getByTestId("filter-chip-done"));

    const epicCard = screen.getByTestId("epic-card-epic-1");
    const checkmark = epicCard.querySelector('[data-testid="epic-completed-checkmark"]');
    expect(checkmark).toBeInTheDocument();
    expect(checkmark).toHaveClass("text-theme-success-muted");
  });

  it("does not show checkmark when any child task is not Done", () => {
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    const epicCard = screen.getByTestId("epic-card-epic-1");
    expect(
      epicCard.querySelector('[data-testid="epic-completed-checkmark"]')
    ).not.toBeInTheDocument();
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    const epicCard = () => screen.getByTestId("epic-card-epic-1");
    expect(
      epicCard().querySelector('[data-testid="epic-completed-checkmark"]')
    ).not.toBeInTheDocument();

    act(() => {
      store.dispatch(taskUpdated({ taskId: "epic-1.2", status: "closed" }));
    });

    // Switch to "done" filter so the epic stays visible (the "all" filter hides fully-completed epics)
    fireEvent.click(screen.getByTestId("filter-chip-done"));

    const checkmark = await screen.findByTestId("epic-completed-checkmark", { timeout: 3000 });
    expect(checkmark).toBeInTheDocument();
  });
});

describe("ExecutePhase top bar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not show Execute heading or progress bar in top bar", () => {
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
    const { container } = render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    expect(screen.queryByRole("heading", { name: "Execute" })).not.toBeInTheDocument();
    // Top bar (filter chips area) has no progress bar; epic cards have their own
    const topBar = container.querySelector(".px-6.py-4.border-b");
    expect(topBar?.querySelector('[role="progressbar"]')).not.toBeInTheDocument();
  });

  it("shows status filter chips with task counts (All, In Line, Ready, In Progress, In Review, Done; Blocked on Human only when count > 0)", () => {
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    expect(screen.getByTestId("filter-chip-all")).toHaveTextContent("All");
    expect(screen.getByTestId("filter-chip-all")).toHaveTextContent("2");
    expect(screen.getByTestId("filter-chip-in_line")).toHaveTextContent("In Line");
    expect(screen.getByTestId("filter-chip-in_line")).toHaveTextContent("0");
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    expect(screen.getByTestId("filter-chip-in_progress")).toHaveTextContent("1");
    expect(screen.getByTestId("filter-chip-in_review")).toHaveTextContent("1");
    expect(screen.getByTestId("filter-chip-done")).toHaveTextContent("1");
  });

  it("shows Blocked on Human chip only when kanbanColumn blocked count > 0", () => {
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    expect(screen.getByTestId("filter-chip-ready")).toHaveTextContent("1");
    expect(screen.getByTestId("filter-chip-blocked")).toHaveTextContent("⚠️ Blocked on Human");
    expect(screen.getByTestId("filter-chip-blocked")).toHaveTextContent("1");
  });

  it("counts only kanbanColumn blocked for Blocked on Human chip", () => {
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "planning",
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-1.2",
        title: "Task B",
        epicId: "epic-1",
        kanbanColumn: "backlog",
        priority: 1,
        assignee: null,
      },
      {
        id: "epic-1.3",
        title: "Task C",
        epicId: "epic-1",
        kanbanColumn: "blocked",
        priority: 2,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    expect(screen.getByTestId("filter-chip-blocked")).toHaveTextContent("⚠️ Blocked on Human");
    expect(screen.getByTestId("filter-chip-blocked")).toHaveTextContent("1");
  });

  it("filters to In Line tasks (backlog, blocked, planning) when In Line chip is clicked", async () => {
    const user = userEvent.setup();
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
        title: "Blocked task",
        epicId: "epic-1",
        kanbanColumn: "blocked",
        priority: 1,
        assignee: null,
      },
      {
        id: "epic-1.3",
        title: "Ready task",
        epicId: "epic-1",
        kanbanColumn: "ready",
        priority: 2,
        assignee: null,
      },
    ];
    const store = createStore(tasks);
    const { container } = render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    await user.click(screen.getByTestId("filter-chip-in_line"));
    const epicCard = container.querySelector('[data-testid="epic-card-epic-1"]');
    expect(epicCard).toBeInTheDocument();
    const listItems = epicCard!.querySelectorAll("ul li");
    expect(listItems).toHaveLength(2);
    expect(epicCard!.textContent).toContain("Backlog task");
    expect(epicCard!.textContent).toContain("Blocked task");
    expect(epicCard!.textContent).not.toContain("Ready task");
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    const epicCard = container.querySelector('[data-testid="epic-card-epic-1"]');
    expect(epicCard).toBeInTheDocument();
    expect(epicCard!.querySelectorAll("ul li")).toHaveLength(3);

    await user.click(screen.getByTestId("filter-chip-done"));
    const doneList = epicCard!.querySelectorAll("ul li");
    expect(doneList).toHaveLength(1);
    expect(doneList[0].textContent).toContain("Done task");

    await user.click(screen.getByTestId("filter-chip-ready"));
    expect(epicCard!.querySelectorAll("ul li")).toHaveLength(1);
    expect(epicCard!.textContent).toContain("Ready task");

    await user.click(screen.getByTestId("filter-chip-all"));
    expect(epicCard!.querySelectorAll("ul li")).toHaveLength(3);
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    await user.click(screen.getByTestId("filter-chip-done"));
    expect(
      container.querySelector('[data-testid="epic-card-epic-1"]')!.querySelectorAll("ul li")
    ).toHaveLength(1);

    await user.click(screen.getByTestId("filter-chip-done"));
    expect(
      container.querySelector('[data-testid="epic-card-epic-1"]')!.querySelectorAll("ul li")
    ).toHaveLength(2);
  });

  it("All chip is active by default", () => {
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    expect(screen.getByTestId("filter-chip-all")).toHaveAttribute("aria-pressed", "true");
  });

  it("does not render play or pause buttons in the header", () => {
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    expect(screen.queryByRole("button", { name: /pick up next task/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /pause/i })).not.toBeInTheDocument();
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    expect(screen.getByText("Awaiting approval…")).toBeInTheDocument();
  });

  it("does not show awaiting approval when awaitingApproval is false", () => {
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    expect(screen.queryByText("Awaiting approval…")).not.toBeInTheDocument();
  });
});

describe("ExecutePhase expandable search bar", () => {
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    await user.click(screen.getByTestId("execute-search-expand"));

    expect(screen.getByTestId("execute-search-expanded")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search tickets…")).toBeInTheDocument();
    expect(screen.getByTestId("execute-search-close")).toBeInTheDocument();
    expect(screen.queryByTestId("execute-search-expand")).not.toBeInTheDocument();
  });

  it("shows X close button when input is visible", async () => {
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    await user.click(screen.getByTestId("execute-search-expand"));

    const closeBtn = screen.getByTestId("execute-search-close");
    expect(closeBtn).toBeInTheDocument();
    expect(closeBtn).toHaveAttribute("aria-label", "Close search");
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
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

  it("input receives focus automatically on expand", async () => {
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    await user.click(screen.getByTestId("execute-search-expand"));

    const input = screen.getByPlaceholderText("Search tickets…");
    expect(document.activeElement).toBe(input);
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
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
      reducer: { project: projectReducer, plan: planReducer, execute: executeReducer },
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
          tasks,
          plans: [],
          awaitingApproval: false,
          orchestratorRunning: false,
          activeTasks: [],
          selectedTaskId: null,
          taskDetail: null,
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
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

describe("ExecutePhase view toggle", () => {
  const STORAGE_KEY = "opensprint.executeView";

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem(STORAGE_KEY);
  });

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  it("default renders Kanban grid", () => {
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    expect(screen.getByTestId("epic-card-epic-1")).toBeInTheDocument();
    expect(screen.queryByTestId("timeline-list")).not.toBeInTheDocument();
    expect(screen.getByTestId("view-toggle-kanban")).toHaveAttribute("aria-checked", "true");
  });

  it("clicking Timeline toggle renders TimelineList and hides Kanban grid", async () => {
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    expect(screen.getByTestId("epic-card-epic-1")).toBeInTheDocument();

    await user.click(screen.getByTestId("view-toggle-timeline"));

    expect(screen.queryByTestId("epic-card-epic-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("timeline-list")).toBeInTheDocument();
    expect(screen.getByTestId("view-toggle-timeline")).toHaveAttribute("aria-checked", "true");
  });

  it("toggling back to Kanban re-renders Kanban grid", async () => {
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    await user.click(screen.getByTestId("view-toggle-timeline"));
    expect(screen.getByTestId("timeline-list")).toBeInTheDocument();

    await user.click(screen.getByTestId("view-toggle-kanban"));
    expect(screen.getByTestId("epic-card-epic-1")).toBeInTheDocument();
    expect(screen.queryByTestId("timeline-list")).not.toBeInTheDocument();
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    await user.click(screen.getByTestId("view-toggle-timeline"));
    expect(screen.getByTestId("timeline-list")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-row-epic-1.1")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-row-epic-1.2")).toBeInTheDocument();

    await user.click(screen.getByTestId("filter-chip-done"));
    expect(screen.getByTestId("timeline-row-epic-1.1")).toBeInTheDocument();
    expect(screen.queryByTestId("timeline-row-epic-1.2")).not.toBeInTheDocument();
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    await user.click(screen.getByTestId("view-toggle-timeline"));
    await user.click(screen.getByTestId("timeline-row-epic-1.1").querySelector("button")!);

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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    expect(screen.getByTestId("timeline-list")).toBeInTheDocument();
    expect(screen.queryByTestId("epic-card-epic-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("view-toggle-timeline")).toHaveAttribute("aria-checked", "true");
  });

  it("invalid localStorage value defaults to kanban", () => {
    localStorage.setItem(STORAGE_KEY, "invalid");
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    expect(screen.getByTestId("epic-card-epic-1")).toBeInTheDocument();
    expect(screen.queryByTestId("timeline-list")).not.toBeInTheDocument();
    expect(screen.getByTestId("view-toggle-kanban")).toHaveAttribute("aria-checked", "true");
  });
});

describe("ExecutePhase Redux integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    await user.click(await screen.findByTestId("sidebar-actions-menu-btn"));
    const markDoneBtn = await screen.findByTestId("sidebar-mark-done-btn");
    await user.click(markDoneBtn);

    await vi.waitFor(() => {
      expect(mockMarkDone).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });
  });

  it("shows Unblock in actions menu for blocked tasks and dispatches unblockTask when clicked", async () => {
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    await user.click(await screen.findByTestId("sidebar-actions-menu-btn"));
    const unblockBtn = await screen.findByTestId("sidebar-unblock-btn");
    expect(unblockBtn).toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-mark-done-btn")).not.toBeInTheDocument();

    await user.click(unblockBtn);

    await vi.waitFor(() => {
      expect(mockUnblock).toHaveBeenCalledWith("proj-1", "epic-1.1", expect.anything());
    });
  });

  it("closes task detail panel when backdrop is clicked (narrow screens)", async () => {
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    // Backdrop is md:hidden (hidden at 768px+); use hidden: true for default viewport
    const backdrop = screen.getByRole("button", { name: "Dismiss task detail", hidden: true });
    await user.click(backdrop);

    expect(store.getState().execute.selectedTaskId).toBeNull();
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" initialTaskIdFromUrl="epic-1.1" onClose={onClose} />
      </Provider>
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    const closeBtn = screen.getByRole("button", { name: "Close task detail" });
    await user.click(closeBtn);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("has kanban scroll area with min-h-0 and overflow-auto for independent scroll", () => {
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );
    const scrollArea = document.querySelector(".overflow-auto.min-h-0");
    expect(scrollArea).toBeInTheDocument();
    expect(scrollArea).toHaveClass("min-h-0");
  });

  it("has root with flex flex-1 min-h-0 min-w-0 for proper fill and independent page/sidebar scroll", () => {
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );
    const root = container.firstElementChild;
    expect(root).toHaveClass("flex");
    expect(root).toHaveClass("flex-1");
    expect(root).toHaveClass("min-h-0");
    expect(root).toHaveClass("min-w-0");
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    expect(
      screen.getByRole("separator", { name: "Resize sidebar", hidden: true })
    ).toBeInTheDocument();
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    const handle = screen.getByRole("separator", { name: "Resize sidebar", hidden: true });
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
    const store = createStore(
      tasks,
      {
        selectedTaskId: "epic-1.1",
        agentOutput: { "epic-1.1": ["Line 1\n", "Line 2\n", "Line 3\n"] },
      },
      { connected: true }
    );
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    const liveOutput = await vi.waitFor(() => {
      const el = screen.getByTestId("live-agent-output");
      expect(el).toHaveTextContent("Line 1");
      return el;
    });
    expect(liveOutput).toHaveClass("overflow-y-auto");
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    await vi.waitFor(() => {
      expect(screen.getByTestId("live-output-connecting")).toBeInTheDocument();
      expect(screen.getByText("Connecting to live output…")).toBeInTheDocument();
      expect(screen.getByTestId("live-output-retry")).toBeInTheDocument();
    });
  });

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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
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

  it("task title renders exactly once in detail sidebar, status badge visible without redundant title", async () => {
    const uniqueTitle = "Single Display Task Title";
    mockGet.mockResolvedValue({
      id: "epic-1.1",
      title: uniqueTitle,
      kanbanColumn: "in_progress",
      description: "Desc",
      priority: 0,
      assignee: null,
      epicId: "epic-1",
    });
    const tasks = [
      {
        id: "epic-1.1",
        title: uniqueTitle,
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    // Title appears immediately from cached list data
    const header = screen.getByTestId("task-detail-title");
    expect(header).toHaveTextContent(uniqueTitle);

    // Status (In Progress) remains visible in metadata row (may also appear in filter chips)
    expect(screen.getAllByText("In Progress").length).toBeGreaterThanOrEqual(1);
  });

  it("task detail sidebar does not display task type (Task text removed per feedback)", async () => {
    mockGet.mockResolvedValue({
      id: "epic-1.1",
      title: "Fix login bug",
      kanbanColumn: "in_progress",
      description: "Bug description",
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
        title: "Fix login bug",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    // Task type should not be displayed in the details sidebar (feedback: remove Task text)
    // The metadata row used to show "title · task · priority"; we no longer show the type
    const metadataSection = document.body.textContent ?? "";
    expect(metadataSection).not.toMatch(/\s·\s*task\s*·/);
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    const descriptionContainer = await screen.findByTestId("task-description-markdown", {
      timeout: 5000,
    });
    expect(descriptionContainer).toHaveTextContent("Final line");
    // .prose-task-description (index.css) includes overflow-y-auto via @apply
    expect(descriptionContainer).toHaveClass("prose-task-description");
  });

  it("task description markdown has theme-aware prose styles for WCAG AA contrast", async () => {
    mockGet.mockResolvedValue({
      id: "epic-1.1",
      title: "Task A",
      kanbanColumn: "in_progress",
      description: "## Heading\n\nParagraph with **bold** and `inline code`.\n\n- List item",
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    const markdownContainer = await screen.findByTestId("task-description-markdown");
    expect(markdownContainer).toBeInTheDocument();
    // Styles are in .prose-task-description (index.css @apply) and .prose-execute-task; element uses those classes
    const cn = markdownContainer.className;
    expect(cn).toMatch(/prose-task-description/);
    expect(cn).toMatch(/prose-execute-task/);
  });

  it("shows collapsible Description header between Source Feedback and description markdown when task has description", async () => {
    mockGet.mockResolvedValue({
      id: "epic-1.1",
      title: "Task with description",
      kanbanColumn: "in_progress",
      description: "Implement the feature",
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
        title: "Task with description",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    const descHeader = await screen.findByRole("button", { name: /description/i });
    expect(descHeader).toBeInTheDocument();
    expect(screen.getByTestId("task-description-markdown")).toBeInTheDocument();
    expect(screen.getByTestId("task-description-markdown")).toHaveTextContent(
      "Implement the feature"
    );
  });

  it("collapses and expands Description section when header is clicked", async () => {
    mockGet.mockResolvedValue({
      id: "epic-1.1",
      title: "Task A",
      kanbanColumn: "in_progress",
      description: "Task details",
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    const toggleBtn = await screen.findByRole("button", { name: /description/i });
    expect(screen.getByTestId("task-description-markdown")).toBeInTheDocument();

    await userEvent.click(toggleBtn);
    expect(screen.queryByTestId("task-description-markdown")).not.toBeInTheDocument();

    await userEvent.click(toggleBtn);
    expect(screen.getByTestId("task-description-markdown")).toBeInTheDocument();
  });

  it("Description section defaults to expanded", async () => {
    mockGet.mockResolvedValue({
      id: "epic-1.1",
      title: "Task A",
      kanbanColumn: "in_progress",
      description: "Visible by default",
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    const markdown = await screen.findByTestId("task-description-markdown");
    expect(markdown).toBeInTheDocument();
    expect(markdown).toHaveTextContent("Visible by default");
  });

  it("shows Description header between Source Feedback and description when task has both", async () => {
    mockGet.mockResolvedValue({
      id: "epic-1.1",
      title: "Feedback task",
      kanbanColumn: "in_progress",
      description: "Implement from feedback",
      type: "task",
      status: "in_progress",
      labels: [],
      dependencies: [],
      priority: 0,
      assignee: null,
      epicId: "epic-1",
      createdAt: "",
      updatedAt: "",
      sourceFeedbackId: "fb-xyz",
    });
    mockFeedbackGet.mockResolvedValue({
      id: "fb-xyz",
      text: "Add dark mode",
      category: "feature",
      mappedPlanId: "plan-1",
      createdTaskIds: ["epic-1.1"],
      status: "pending",
      createdAt: "2026-02-17T10:00:00Z",
    });
    const tasks = [
      {
        id: "epic-1.1",
        title: "Feedback task",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    await vi.waitFor(() => {
      expect(mockFeedbackGet).toHaveBeenCalledWith("proj-1", "fb-xyz");
    });

    const sourceFeedbackBtn = screen.getByRole("button", { name: /source feedback/i });
    const descriptionBtn = screen.getByRole("button", { name: /description/i });
    const sourceFeedbackIdx = Array.from(document.body.querySelectorAll("button")).indexOf(
      sourceFeedbackBtn
    );
    const descriptionIdx = Array.from(document.body.querySelectorAll("button")).indexOf(
      descriptionBtn
    );
    expect(sourceFeedbackIdx).toBeLessThan(descriptionIdx);
    expect(screen.getByTestId("task-description-markdown")).toHaveTextContent(
      "Implement from feedback"
    );
  });

  it("Description, Source Feedback, and Live Output headers use identical structure when all three visible", async () => {
    mockGet.mockResolvedValue({
      id: "epic-1.1",
      title: "Task with both",
      kanbanColumn: "in_progress",
      description: "Implement from feedback",
      type: "task",
      status: "in_progress",
      labels: [],
      dependencies: [],
      priority: 0,
      assignee: null,
      epicId: "epic-1",
      createdAt: "",
      updatedAt: "",
      sourceFeedbackId: "fb-xyz",
    });
    mockFeedbackGet.mockResolvedValue({
      id: "fb-xyz",
      text: "Add dark mode",
      category: "feature",
      mappedPlanId: "plan-1",
      createdTaskIds: ["epic-1.1"],
      status: "pending",
      createdAt: "2026-02-17T10:00:00Z",
    });
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task with both",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    const { container } = render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    await vi.waitFor(() => {
      expect(mockFeedbackGet).toHaveBeenCalledWith("proj-1", "fb-xyz");
    });

    const sourceFeedbackHeader = container.querySelector("#source-feedback-header-fb-xyz");
    const descriptionHeader = container.querySelector("#description-header");
    const artifactsHeader = container.querySelector("#artifacts-header");

    expect(sourceFeedbackHeader).toBeInTheDocument();
    expect(descriptionHeader).toBeInTheDocument();
    expect(artifactsHeader).toBeInTheDocument();

    const sharedHeaderClasses = [
      "w-full",
      "flex",
      "items-center",
      "justify-between",
      "p-4",
      "text-left",
      "hover:bg-theme-border-subtle/50",
      "transition-colors",
    ];
    for (const header of [sourceFeedbackHeader, descriptionHeader, artifactsHeader]) {
      for (const cls of sharedHeaderClasses) {
        expect(header).toHaveClass(cls);
      }
    }

    const sharedH4Classes = [
      "text-xs",
      "font-medium",
      "text-theme-muted",
      "uppercase",
      "tracking-wide",
    ];
    for (const header of [sourceFeedbackHeader, descriptionHeader, artifactsHeader]) {
      const h4 = header?.querySelector("h4");
      expect(h4).toBeInTheDocument();
      for (const cls of sharedH4Classes) {
        expect(h4).toHaveClass(cls);
      }
    }
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
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

  it("shows plan link when task has epicId and matching plan exists", async () => {
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" onNavigateToPlan={onNavigateToPlan} />
      </Provider>
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    const user = userEvent.setup();
    await user.click(await screen.findByTestId("sidebar-actions-menu-btn"));
    const planLink = await screen.findByTestId("sidebar-view-plan-btn");
    expect(planLink).toBeInTheDocument();
    expect(planLink).toHaveTextContent(/view plan: build test/i);
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    const user = userEvent.setup();
    await user.click(await screen.findByTestId("sidebar-actions-menu-btn"));
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" onNavigateToPlan={onNavigateToPlan} />
      </Provider>
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "other-1");
    });

    const user = userEvent.setup();
    await user.click(await screen.findByTestId("sidebar-actions-menu-btn"));
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" onNavigateToPlan={onNavigateToPlan} />
      </Provider>
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    await user.click(await screen.findByTestId("sidebar-actions-menu-btn"));
    const planLink = await screen.findByTestId("sidebar-view-plan-btn");
    await user.click(planLink);

    expect(onNavigateToPlan).toHaveBeenCalledWith("build-test-feature");
  });
});

describe("ExecutePhase epic card plan navigation", () => {
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" onNavigateToPlan={onNavigateToPlan} />
      </Provider>
    );

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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    await screen.findByText("Build Test");
    expect(screen.queryByRole("button", { name: "Build Test" })).not.toBeInTheDocument();
  });
});

describe("ExecutePhase Source feedback section", () => {
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    expect(screen.queryByText("Feedback ID: fb-abc")).not.toBeInTheDocument();
  });

  it("displays full feedback card when Source feedback section is expanded", async () => {
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
      sourceFeedbackId: "fb-xyz",
    };
    mockGet.mockResolvedValue(taskDetail);
    mockFeedbackGet.mockResolvedValue({
      id: "fb-xyz",
      text: "Please add dark mode support",
      category: "feature",
      mappedPlanId: "build-test-feature",
      createdTaskIds: ["epic-1.1"],
      status: "pending",
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    await vi.waitFor(() => {
      expect(mockFeedbackGet).toHaveBeenCalledWith("proj-1", "fb-xyz");
    });

    expect(screen.getByTestId("source-feedback-card")).toBeInTheDocument();
    expect(screen.getByText("Please add dark mode support")).toBeInTheDocument();
    // Category chip and Mapped plan are not shown in Execute sidebar (reduced clutter)
    expect(screen.queryByText("Feature")).not.toBeInTheDocument();
    expect(screen.queryByText(/mapped plan:/i)).not.toBeInTheDocument();
  });

  it("collapses and expands Source feedback section when icon button is clicked", async () => {
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
      sourceFeedbackId: "fb-xyz",
    };
    mockGet.mockResolvedValue(taskDetail);
    mockFeedbackGet.mockResolvedValue({
      id: "fb-xyz",
      text: "Please add dark mode support",
      category: "feature",
      mappedPlanId: "build-test-feature",
      createdTaskIds: ["epic-1.1"],
      status: "pending",
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    const toggleBtn = await screen.findByRole("button", { name: /source feedback/i });
    expect(screen.getByTestId("source-feedback-card")).toBeInTheDocument();

    await userEvent.click(toggleBtn);
    expect(screen.queryByTestId("source-feedback-card")).not.toBeInTheDocument();

    await userEvent.click(toggleBtn);
    expect(screen.getByTestId("source-feedback-card")).toBeInTheDocument();
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    await vi.waitFor(() => {
      expect(mockFeedbackGet).toHaveBeenCalledWith("proj-1", "fb-resolved");
    });

    expect(screen.getByTestId("source-feedback-card")).toBeInTheDocument();
    const resolvedChip = screen.getByText("Resolved");
    expect(resolvedChip).toBeInTheDocument();
    expect(resolvedChip).toHaveClass("bg-theme-success-bg", "text-theme-success-text");
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

  it("shows task title immediately in sidebar header from cached list data (no wait for detail API)", () => {
    mockGet.mockImplementation(() => neverResolves());
    const tasks = [
      {
        id: "epic-1.1",
        title: "Cached Task Title",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: "Frodo",
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    const title = screen.getByTestId("task-detail-title");
    expect(title).toHaveTextContent("Cached Task Title");
    expect(screen.getByTestId("task-detail-loading")).toBeInTheDocument();
  });

  it("shows status and assignee in detail section (status in row 1, assignee in active-agent section)", async () => {
    mockGet.mockImplementation(() => neverResolves());
    const startedAt = new Date(Date.now() - 60000).toISOString();
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_review",
        priority: 0,
        assignee: "Frodo",
      },
    ];
    const store = createStore(tasks, {
      selectedTaskId: "epic-1.1",
      activeTasks: [{ taskId: "epic-1.1", phase: "review", startedAt }],
    });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    // Header shows only title
    const header = screen.getByTestId("task-detail-title");
    expect(header).toHaveTextContent("Task A");
    expect(screen.queryByTestId("task-detail-metadata")).not.toBeInTheDocument();

    // Row 1: Status and priority share first row
    const row = screen.getByTestId("task-detail-priority-state-row");
    expect(row).toHaveTextContent("In Review");

    // Row 2: Active agent section shows assignee when agent is active
    const callout = screen.getByTestId("task-detail-active-callout");
    expect(callout).toHaveTextContent("Frodo");
  });

  it("shows status with color indicator and icon in row 1", () => {
    mockGet.mockImplementation(() => new Promise(() => {}));
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "done",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    const row = screen.getByTestId("task-detail-priority-state-row");
    expect(row).toHaveTextContent("Done");
    // TaskStatusBadge renders with title attribute for accessibility
    const badge = row.querySelector('[title="Done"]');
    expect(badge).toBeInTheDocument();
  });

  it("shows running time in active-agent section when task has active agent", async () => {
    mockGet.mockImplementation(() => new Promise(() => {}));
    const startedAt = new Date(Date.now() - 125000).toISOString(); // 2m 5s ago
    mockAgentsActive.mockResolvedValue([
      { id: "epic-1.1", phase: "coding", role: "coder", label: "Task A", startedAt },
    ]);
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: "Frodo",
      },
    ];
    const store = createStore(tasks, {
      selectedTaskId: "epic-1.1",
      activeTasks: [{ taskId: "epic-1.1", phase: "coding", startedAt }],
    });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    const callout = screen.getByTestId("task-detail-active-callout");
    expect(callout).toHaveTextContent("Frodo");
    // Wait for async agents fetch to populate running time in active-agent section (formatUptime produces "2m 5s" or similar)
    await vi.waitFor(() => {
      expect(callout.textContent).toMatch(/\d+m\s+\d+s/);
    });
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
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    expect(screen.getByTestId("task-detail-loading")).toBeInTheDocument();
    expect(screen.getByTestId("artifacts-loading")).toBeInTheDocument();
  });

  it("shows error state below header without clearing task name when detail fetch fails", async () => {
    mockGet.mockRejectedValue(new Error("Network error"));
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task With Error",
        epicId: "epic-1",
        kanbanColumn: "in_progress",
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>
    );

    expect(screen.getByTestId("task-detail-title")).toHaveTextContent("Task With Error");
    const errorEl = await vi.waitFor(() => screen.getByTestId("task-detail-error"));
    expect(errorEl).toHaveTextContent("Network error");
  });
});
