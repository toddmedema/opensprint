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
      list: vi.fn().mockResolvedValue({ plans: [], dependencyGraph: null }),
    },
    execute: {
      status: vi.fn().mockResolvedValue({}),
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

describe("ExecutePhase top bar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows task count per stage (Ready, Blocked, In Progress, Done) and total in top bar", () => {
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

    expect(screen.getByText("Ready: 1 · Blocked: 0 · In Progress: 0 · Done: 1 · Total: 2")).toBeInTheDocument();
  });

  it("shows in-progress task count when tasks are in progress or in review", () => {
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

    expect(screen.getByText("Ready: 0 · Blocked: 0 · In Progress: 2 · Done: 1 · Total: 3")).toBeInTheDocument();
  });

  it("shows separate ready and blocked counts when tasks are in backlog or ready", () => {
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

    expect(screen.getByText("Ready: 1 · Blocked: 1 · In Progress: 0 · Done: 0 · Total: 2")).toBeInTheDocument();
  });

  it("counts planning, backlog, and blocked as Blocked", () => {
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

    expect(screen.getByText("Ready: 0 · Blocked: 3 · In Progress: 0 · Done: 0 · Total: 3")).toBeInTheDocument();
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
