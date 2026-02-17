import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { BuildPhase } from "./BuildPhase";
import projectReducer from "../../store/slices/projectSlice";
import planReducer from "../../store/slices/planSlice";
import buildReducer from "../../store/slices/buildSlice";
const mockGet = vi.fn().mockResolvedValue({});
const mockMarkComplete = vi.fn().mockResolvedValue(undefined);

vi.mock("../../api/client", () => ({
  api: {
    tasks: {
      list: vi.fn().mockResolvedValue([]),
      get: (...args: unknown[]) => mockGet(...args),
      sessions: vi.fn().mockResolvedValue([]),
      markComplete: (...args: unknown[]) => mockMarkComplete(...args),
    },
    build: {
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
  completedTaskCount: 0,
  dependencyCount: 0,
};

function createStore(
  tasks: { id: string; kanbanColumn: string; epicId: string; title: string; priority: number; assignee: string | null }[],
  buildOverrides?: Partial<{ orchestratorRunning: boolean; selectedTaskId: string | null }>,
) {
  return configureStore({
    reducer: {
      project: projectReducer,
      plan: planReducer,
      build: buildReducer,
    },
    preloadedState: {
      plan: {
        plans: [basePlan],
        dependencyGraph: null,
        selectedPlanId: null,
        chatMessages: {},
        loading: false,
        decomposing: false,
        shippingPlanId: null,
        reshippingPlanId: null,
        archivingPlanId: null,
        error: null,
      },
      build: {
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
        markCompleteLoading: false,
        statusLoading: false,
        loading: false,
        error: null,
        ...buildOverrides,
      },
    },
  });
}

describe("BuildPhase top bar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows task count per stage (Ready, In Progress, Done) and total in top bar", () => {
    const tasks = [
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "done", priority: 0, assignee: null },
      { id: "epic-1.2", title: "Task B", epicId: "epic-1", kanbanColumn: "ready", priority: 1, assignee: null },
    ];
    const store = createStore(tasks);
    render(
      <Provider store={store}>
        <BuildPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByText("Ready: 1 · In Progress: 0 · Done: 1 · Total: 2")).toBeInTheDocument();
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
        <BuildPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByText("Ready: 0 · In Progress: 2 · Done: 1 · Total: 3")).toBeInTheDocument();
  });

  it("shows ready count when tasks are in backlog or ready", () => {
    const tasks = [
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "backlog", priority: 0, assignee: null },
      { id: "epic-1.2", title: "Task B", epicId: "epic-1", kanbanColumn: "ready", priority: 1, assignee: null },
    ];
    const store = createStore(tasks);
    render(
      <Provider store={store}>
        <BuildPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByText("Ready: 2 · In Progress: 0 · Done: 0 · Total: 2")).toBeInTheDocument();
  });

  it("counts planning and backlog as Ready", () => {
    const tasks = [
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "planning", priority: 0, assignee: null },
      { id: "epic-1.2", title: "Task B", epicId: "epic-1", kanbanColumn: "backlog", priority: 1, assignee: null },
    ];
    const store = createStore(tasks);
    render(
      <Provider store={store}>
        <BuildPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByText("Ready: 2 · In Progress: 0 · Done: 0 · Total: 2")).toBeInTheDocument();
  });

  it("does not render play or pause buttons in the header", () => {
    const tasks = [
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "ready", priority: 0, assignee: null },
    ];
    const store = createStore(tasks);
    render(
      <Provider store={store}>
        <BuildPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.queryByRole("button", { name: /pick up next task/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /pause/i })).not.toBeInTheDocument();
  });
});

describe("BuildPhase Redux integration", () => {
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
        <BuildPhase projectId="proj-1" />
      </Provider>,
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });
  });

  it("dispatches markTaskComplete when Mark complete button is clicked", async () => {
    const user = userEvent.setup();
    const tasks = [
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "in_progress", priority: 0, assignee: "agent" },
    ];
    const store = createStore(tasks, { selectedTaskId: "epic-1.1" });
    render(
      <Provider store={store}>
        <BuildPhase projectId="proj-1" />
      </Provider>,
    );

    const markCompleteBtn = await screen.findByRole("button", { name: /mark complete/i });
    await user.click(markCompleteBtn);

    await vi.waitFor(() => {
      expect(mockMarkComplete).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });
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
        <BuildPhase projectId="proj-1" />
      </Provider>,
    );

    await vi.waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    const closeBtn = screen.getByRole("button", { name: "Close" });
    await user.click(closeBtn);

    expect(store.getState().build.selectedTaskId).toBeNull();
  });
});

describe("BuildPhase task detail plan link", () => {
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
        <BuildPhase projectId="proj-1" onNavigateToPlan={onNavigateToPlan} />
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
        <BuildPhase projectId="proj-1" />
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
        <BuildPhase projectId="proj-1" onNavigateToPlan={onNavigateToPlan} />
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
        <BuildPhase projectId="proj-1" onNavigateToPlan={onNavigateToPlan} />
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
