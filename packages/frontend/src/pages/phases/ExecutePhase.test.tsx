import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { ExecutePhase } from "./ExecutePhase";
import projectReducer from "../../store/slices/projectSlice";
import planReducer from "../../store/slices/planSlice";
import executeReducer from "../../store/slices/executeSlice";
const mockGet = vi.fn().mockResolvedValue({});
const mockMarkDone = vi.fn().mockResolvedValue(undefined);
const mockUnblock = vi.fn().mockResolvedValue({ taskUnblocked: true });
const mockFeedbackGet = vi.fn().mockResolvedValue(null);

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
    },
    agents: {
      active: vi.fn().mockResolvedValue([]),
    },
    feedback: {
      get: (...args: unknown[]) => mockFeedbackGet(...args),
    },
  },
}));

const basePlan = {
  metadata: {
    planId: "build-test-feature",
    beadEpicId: "epic-1",
    gateTaskId: "epic-1.0",
    complexity: "medium" as const,
  },
  content: "# Build Test\n\nContent.",
  status: "building" as const,
  taskCount: 3,
  doneTaskCount: 0,
  dependencyCount: 0,
};

function createStore(
  tasks: { id: string; kanbanColumn: string; epicId: string; title: string; priority: number; assignee: string | null }[],
  buildOverrides?: Partial<{
    orchestratorRunning: boolean;
    selectedTaskId: string | null;
    awaitingApproval: boolean;
    agentOutput: string[];
  }>,
) {
  return configureStore({
    reducer: {
      project: projectReducer,
      plan: planReducer,
      execute: executeReducer,
    },
    preloadedState: {
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
        tasks,
        plans: [],
        awaitingApproval: false,
        orchestratorRunning: false,
        selectedTaskId: null,
        taskDetail: null,
        taskDetailLoading: false,
        agentOutput: [],
        completionState: null,
        archivedSessions: [],
        archivedLoading: false,
        markDoneLoading: false,
        unblockLoading: false,
        statusLoading: false,
        loading: false,
        error: null,
        ...buildOverrides,
      },
    },
  });
}

describe("ExecutePhase epic card task order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sorts epic card tasks by status: In Progress → In Review → Ready → Backlog → Done", () => {
    const tasks = [
      { id: "epic-1.1", title: "Done task", epicId: "epic-1", kanbanColumn: "done", priority: 0, assignee: null },
      { id: "epic-1.2", title: "Ready task", epicId: "epic-1", kanbanColumn: "ready", priority: 0, assignee: null },
      { id: "epic-1.3", title: "In progress task", epicId: "epic-1", kanbanColumn: "in_progress", priority: 0, assignee: null },
    ];
    const store = createStore(tasks);
    const { container } = render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
    );

    const epicCard = container.querySelector('[data-testid="epic-card-epic-1"]');
    expect(epicCard).toBeInTheDocument();
    const listItems = epicCard!.querySelectorAll("ul li");
    expect(listItems).toHaveLength(3);
    expect(listItems[0].textContent).toContain("In progress task");
    expect(listItems[1].textContent).toContain("Ready task");
    expect(listItems[2].textContent).toContain("Done task");
  });

  it("sorts by priority within same status, then by ID", () => {
    const tasks = [
      { id: "epic-1.3", title: "Low priority", epicId: "epic-1", kanbanColumn: "ready", priority: 2, assignee: null },
      { id: "epic-1.1", title: "High priority", epicId: "epic-1", kanbanColumn: "ready", priority: 0, assignee: null },
      { id: "epic-1.2", title: "Mid priority", epicId: "epic-1", kanbanColumn: "ready", priority: 1, assignee: null },
    ];
    const store = createStore(tasks);
    const { container } = render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
    );

    const epicCard = container.querySelector('[data-testid="epic-card-epic-1"]');
    const listItems = epicCard!.querySelectorAll("ul li");
    const titles = Array.from(listItems).map((li) => li.textContent?.trim().split(/\s+/).slice(0, 2).join(" ") ?? "");
    expect(titles[0]).toContain("High");
    expect(titles[1]).toContain("Mid");
    expect(titles[2]).toContain("Low");
  });
});

describe("ExecutePhase top bar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not show Execute heading or progress bar in top bar", () => {
    const tasks = [
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "ready", priority: 0, assignee: null },
    ];
    const store = createStore(tasks);
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.queryByRole("heading", { name: "Execute" })).not.toBeInTheDocument();
    expect(document.querySelector('[role="progressbar"]')).not.toBeInTheDocument();
  });

  it("shows status filter chips with task counts (All, Ready, In Progress, In Review, Done, Blocked)", () => {
    const tasks = [
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "done", priority: 0, assignee: null },
      { id: "epic-1.2", title: "Task B", epicId: "epic-1", kanbanColumn: "ready", priority: 1, assignee: null },
    ];
    const store = createStore(tasks);
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByTestId("filter-chip-all")).toHaveTextContent("All");
    expect(screen.getByTestId("filter-chip-all")).toHaveTextContent("2");
    expect(screen.getByTestId("filter-chip-ready")).toHaveTextContent("Ready");
    expect(screen.getByTestId("filter-chip-ready")).toHaveTextContent("1");
    expect(screen.getByTestId("filter-chip-done")).toHaveTextContent("Done");
    expect(screen.getByTestId("filter-chip-done")).toHaveTextContent("1");
  });

  it("shows in-progress and in-review counts separately in chips", () => {
    const tasks = [
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "done", priority: 0, assignee: null },
      { id: "epic-1.2", title: "Task B", epicId: "epic-1", kanbanColumn: "in_progress", priority: 1, assignee: "agent-1" },
      { id: "epic-1.3", title: "Task C", epicId: "epic-1", kanbanColumn: "in_review", priority: 2, assignee: "agent-1" },
    ];
    const store = createStore(tasks);
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByTestId("filter-chip-in_progress")).toHaveTextContent("1");
    expect(screen.getByTestId("filter-chip-in_review")).toHaveTextContent("1");
    expect(screen.getByTestId("filter-chip-done")).toHaveTextContent("1");
  });

  it("shows separate ready and blocked counts in chips", () => {
    const tasks = [
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "backlog", priority: 0, assignee: null },
      { id: "epic-1.2", title: "Task B", epicId: "epic-1", kanbanColumn: "ready", priority: 1, assignee: null },
    ];
    const store = createStore(tasks);
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByTestId("filter-chip-ready")).toHaveTextContent("1");
    expect(screen.getByTestId("filter-chip-blocked")).toHaveTextContent("1");
  });

  it("counts planning, backlog, and blocked as Blocked chip", () => {
    const tasks = [
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "planning", priority: 0, assignee: null },
      { id: "epic-1.2", title: "Task B", epicId: "epic-1", kanbanColumn: "backlog", priority: 1, assignee: null },
      { id: "epic-1.3", title: "Task C", epicId: "epic-1", kanbanColumn: "blocked", priority: 2, assignee: null },
    ];
    const store = createStore(tasks);
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByTestId("filter-chip-blocked")).toHaveTextContent("3");
  });

  it("filters task list when chip is clicked", async () => {
    const user = userEvent.setup();
    const tasks = [
      { id: "epic-1.1", title: "Done task", epicId: "epic-1", kanbanColumn: "done", priority: 0, assignee: null },
      { id: "epic-1.2", title: "Ready task", epicId: "epic-1", kanbanColumn: "ready", priority: 1, assignee: null },
      { id: "epic-1.3", title: "In progress task", epicId: "epic-1", kanbanColumn: "in_progress", priority: 2, assignee: null },
    ];
    const store = createStore(tasks);
    const { container } = render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
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
      { id: "epic-1.1", title: "Done task", epicId: "epic-1", kanbanColumn: "done", priority: 0, assignee: null },
      { id: "epic-1.2", title: "Ready task", epicId: "epic-1", kanbanColumn: "ready", priority: 1, assignee: null },
    ];
    const store = createStore(tasks);
    const { container } = render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
    );

    await user.click(screen.getByTestId("filter-chip-done"));
    expect(container.querySelector('[data-testid="epic-card-epic-1"]')!.querySelectorAll("ul li")).toHaveLength(1);

    await user.click(screen.getByTestId("filter-chip-done"));
    expect(container.querySelector('[data-testid="epic-card-epic-1"]')!.querySelectorAll("ul li")).toHaveLength(2);
  });

  it("All chip is active by default", () => {
    const tasks = [
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "ready", priority: 0, assignee: null },
    ];
    const store = createStore(tasks);
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByTestId("filter-chip-all")).toHaveAttribute("aria-pressed", "true");
  });

  it("does not render play or pause buttons in the header", () => {
    const tasks = [
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "ready", priority: 0, assignee: null },
    ];
    const store = createStore(tasks);
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.queryByRole("button", { name: /pick up next task/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /pause/i })).not.toBeInTheDocument();
  });

  it("shows awaiting approval message when awaitingApproval is true", () => {
    const tasks = [
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "in_progress", priority: 0, assignee: null },
    ];
    const store = createStore(tasks, { awaitingApproval: true });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByText("Awaiting approval…")).toBeInTheDocument();
  });

  it("does not show awaiting approval when awaitingApproval is false", () => {
    const tasks = [
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "ready", priority: 0, assignee: null },
    ];
    const store = createStore(tasks);
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.queryByText("Awaiting approval…")).not.toBeInTheDocument();
  });
});

describe("ExecutePhase Redux integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches fetchTaskDetail when a task is selected", async () => {
    mockGet.mockResolvedValue({ id: "epic-1.1", title: "Task A", kanbanColumn: "in_progress" });
    const tasks = [
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "in_progress", priority: 0, assignee: "agent" },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });
  });

  it("dispatches markTaskDone when Mark done button is clicked", async () => {
    const user = userEvent.setup();
    const tasks = [
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "in_progress", priority: 0, assignee: "agent" },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
    );

    const markDoneBtn = await screen.findByRole("button", { name: /mark done/i });
    await user.click(markDoneBtn);

    await vi.waitFor(() => {
      expect(mockMarkDone).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });
  });

  it("shows Unblock button for blocked tasks and dispatches unblockTask when clicked", async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue({ id: "epic-1.1", title: "Blocked Task", kanbanColumn: "blocked" });
    const tasks = [
      { id: "epic-1.1", title: "Blocked Task", epicId: "epic-1", kanbanColumn: "blocked", priority: 0, assignee: null },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
    );

    const unblockBtn = await screen.findByRole("button", { name: /unblock/i });
    expect(unblockBtn).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /mark done/i })).not.toBeInTheDocument();

    await user.click(unblockBtn);

    await vi.waitFor(() => {
      expect(mockUnblock).toHaveBeenCalledWith("proj-1", "epic-1.1", expect.anything());
    });
  });

  it("closes task detail panel when backdrop is clicked (narrow screens)", async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue({ id: "epic-1.1", title: "Task A", kanbanColumn: "in_progress" });
    const tasks = [
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "in_progress", priority: 0, assignee: null },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
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
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "in_progress", priority: 0, assignee: null },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    const closeBtn = screen.getByRole("button", { name: "Close task detail" });
    await user.click(closeBtn);

    expect(store.getState().execute.selectedTaskId).toBeNull();
  });

  it("has kanban scroll area with min-h-0 and overflow-auto for independent scroll", () => {
    const tasks = [
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "in_progress", priority: 0, assignee: null },
    ];
    const store = createStore(tasks);
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
    );
    const scrollArea = document.querySelector(".overflow-auto.min-h-0");
    expect(scrollArea).toBeInTheDocument();
    expect(scrollArea).toHaveClass("min-h-0");
  });

  it("has root with flex flex-1 min-h-0 min-w-0 for proper fill and independent page/sidebar scroll", () => {
    const tasks = [
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "in_progress", priority: 0, assignee: null },
    ];
    const store = createStore(tasks);
    const { container } = render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
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
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "in_progress", priority: 0, assignee: null },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    expect(screen.getByRole("separator", { name: "Resize sidebar", hidden: true })).toBeInTheDocument();
  });

  it("live agent output area is scrollable (overflow-y-auto) and does not auto-scroll when content grows", async () => {
    mockGet.mockResolvedValue({ id: "epic-1.1", title: "Task A", kanbanColumn: "in_progress" });
    const tasks = [
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "in_progress", priority: 0, assignee: null },
    ];
    const store = createStore(tasks, {
      selectedTaskId: "epic-1.1",
      agentOutput: ["Line 1\n", "Line 2\n", "Line 3\n"],
    });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    const liveOutput = screen.getByTestId("live-agent-output");
    expect(liveOutput).toBeInTheDocument();
    expect(liveOutput).toHaveClass("overflow-y-auto");
    expect(liveOutput).toHaveTextContent("Line 1");
    expect(liveOutput).toHaveTextContent("Line 2");
    expect(liveOutput).toHaveTextContent("Line 3");
  });

  it("task detail sidebar header shows only task title, not redundant Task label", async () => {
    mockGet.mockResolvedValue({
      id: "epic-1.1",
      title: "Implement feature X",
      kanbanColumn: "in_progress",
      description: "Short desc",
    });
    const tasks = [
      { id: "epic-1.1", title: "Implement feature X", epicId: "epic-1", kanbanColumn: "in_progress", priority: 0, assignee: null },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    const header = screen.getByRole("heading", { level: 3 });
    expect(header).toHaveTextContent("Implement feature X");
    expect(header).not.toHaveTextContent(/^Task$/);
    // No separate "Task" label in the detail section
    const taskLabels = screen.queryAllByText(/^Task$/);
    expect(taskLabels).toHaveLength(0);
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
      { id: "epic-1.1", title: "Fix login bug", epicId: "epic-1", kanbanColumn: "in_progress", priority: 0, assignee: null },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
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
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "in_progress", priority: 0, assignee: null },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    expect(screen.getByText("Final line")).toBeInTheDocument();
    const descriptionContainer = document.querySelector(".prose.overflow-y-auto");
    expect(descriptionContainer).toBeInTheDocument();
    expect(descriptionContainer).toHaveClass("overflow-y-auto");
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
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "in_progress", priority: 0, assignee: "agent" },
    ];
    const onNavigateToPlan = vi.fn();
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" onNavigateToPlan={onNavigateToPlan} />
      </Provider>,
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    const planLink = await screen.findByRole("button", { name: /view plan: build test/i });
    expect(planLink).toBeInTheDocument();
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
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "in_progress", priority: 0, assignee: "agent" },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    expect(screen.queryByRole("button", { name: /view plan:/i })).not.toBeInTheDocument();
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
      { id: "other-1", title: "Orphan Task", epicId: null, kanbanColumn: "ready", priority: 0, assignee: null },
    ];
    const onNavigateToPlan = vi.fn();
    const store = createStore(tasks, { selectedTaskId: "other-1" });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" onNavigateToPlan={onNavigateToPlan} />
      </Provider>,
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "other-1");
    });

    expect(screen.queryByRole("button", { name: /view plan:/i })).not.toBeInTheDocument();
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
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "in_progress", priority: 0, assignee: "agent" },
    ];
    const onNavigateToPlan = vi.fn();
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" onNavigateToPlan={onNavigateToPlan} />
      </Provider>,
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    const planLink = await screen.findByRole("button", { name: /view plan: build test/i });
    await user.click(planLink);

    expect(onNavigateToPlan).toHaveBeenCalledWith("build-test-feature");
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
      { id: "epic-1.1", title: "Implement feature", epicId: "epic-1", kanbanColumn: "in_progress", priority: 0, assignee: "agent" },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    expect(screen.getByRole("button", { name: /source feedback/i })).toBeInTheDocument();
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
      { id: "epic-1.1", title: "Regular task", epicId: "epic-1", kanbanColumn: "in_progress", priority: 0, assignee: "agent" },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
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
      { id: "epic-1.1", title: "Feedback: Fix the bug", epicId: null, kanbanColumn: "ready", priority: 4, assignee: null },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    expect(screen.queryByText("Feedback ID: fb-abc")).not.toBeInTheDocument();
  });

  it("displays full feedback card when Source feedback section is expanded", async () => {
    const user = userEvent.setup();
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
      status: "mapped",
      createdAt: "2026-02-17T10:00:00Z",
    });
    const tasks = [
      { id: "epic-1.1", title: "Implement feature", epicId: "epic-1", kanbanColumn: "in_progress", priority: 0, assignee: "agent" },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    const expandBtn = screen.getByRole("button", { name: /source feedback/i });
    await user.click(expandBtn);

    await vi.waitFor(() => {
      expect(mockFeedbackGet).toHaveBeenCalledWith("proj-1", "fb-xyz");
    });

    expect(screen.getByTestId("source-feedback-card")).toBeInTheDocument();
    expect(screen.getByText("Please add dark mode support")).toBeInTheDocument();
    expect(screen.getByText("Feature")).toBeInTheDocument();
    expect(screen.getByText(/mapped plan: build test/i)).toBeInTheDocument();
  });

  it("shows Resolved chip in Source feedback section when feedback is resolved", async () => {
    const user = userEvent.setup();
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
      { id: "epic-1.1", title: "Implement feature", epicId: "epic-1", kanbanColumn: "in_progress", priority: 0, assignee: "agent" },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <Provider store={store}>
        <ExecutePhase projectId="proj-1" />
      </Provider>,
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    const expandBtn = screen.getByRole("button", { name: /source feedback/i });
    await user.click(expandBtn);

    await vi.waitFor(() => {
      expect(mockFeedbackGet).toHaveBeenCalledWith("proj-1", "fb-resolved");
    });

    expect(screen.getByTestId("source-feedback-card")).toBeInTheDocument();
    const resolvedChip = screen.getByText("Resolved");
    expect(resolvedChip).toBeInTheDocument();
    expect(resolvedChip).toHaveClass("bg-theme-success-bg", "text-theme-success-text");
    expect(screen.getByText("Bug")).toBeInTheDocument();
  });
});
