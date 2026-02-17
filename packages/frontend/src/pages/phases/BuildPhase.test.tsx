import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { BuildPhase } from "./BuildPhase";
import projectReducer from "../../store/slices/projectSlice";
import planReducer from "../../store/slices/planSlice";
import buildReducer from "../../store/slices/buildSlice";
const mockNudge = vi.fn().mockResolvedValue(undefined);
const mockPause = vi.fn().mockResolvedValue(undefined);
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
      nudge: (...args: unknown[]) => mockNudge(...args),
      pause: (...args: unknown[]) => mockPause(...args),
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
        startBuildLoading: false,
        pauseBuildLoading: false,
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

  it("shows total task count and done count in top bar", () => {
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

    expect(screen.getByText("1/2 tasks completed · 0 in progress")).toBeInTheDocument();
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

    expect(screen.getByText("1/3 tasks completed · 2 in progress")).toBeInTheDocument();
  });

  it("shows 0 in progress when no tasks are in progress or in review", () => {
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

    expect(screen.getByText("0/2 tasks completed · 0 in progress")).toBeInTheDocument();
  });
});

describe("BuildPhase build controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders play and pause icon buttons in the header", () => {
    const tasks = [
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "ready", priority: 0, assignee: null },
    ];
    const store = createStore(tasks);
    render(
      <Provider store={store}>
        <BuildPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByRole("button", { name: /pick up next task/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();
  });

  it("calls build nudge API when play button is clicked", async () => {
    const user = userEvent.setup();
    const tasks = [
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "ready", priority: 0, assignee: null },
    ];
    const store = createStore(tasks);
    render(
      <Provider store={store}>
        <BuildPhase projectId="proj-1" />
      </Provider>,
    );

    const playButton = screen.getByRole("button", { name: /pick up next task/i });
    await user.click(playButton);

    expect(mockNudge).toHaveBeenCalledWith("proj-1");
  });

  it("pause button is disabled when orchestrator is not running", () => {
    const tasks = [
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "ready", priority: 0, assignee: null },
    ];
    const store = createStore(tasks);
    render(
      <Provider store={store}>
        <BuildPhase projectId="proj-1" />
      </Provider>,
    );

    const pauseButton = screen.getByRole("button", { name: /pause \(orchestrator runs continuously\)/i });
    expect(pauseButton).toBeDisabled();
  });

  it("dispatches pauseBuild when pause button is clicked and orchestrator is running", async () => {
    const user = userEvent.setup();
    const tasks = [
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "ready", priority: 0, assignee: null },
    ];
    const store = createStore(tasks, { orchestratorRunning: true });
    render(
      <Provider store={store}>
        <BuildPhase projectId="proj-1" />
      </Provider>,
    );

    const pauseButton = screen.getByRole("button", { name: /pause build/i });
    expect(pauseButton).not.toBeDisabled();
    await user.click(pauseButton);

    expect(mockPause).toHaveBeenCalledWith("proj-1");
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
});
