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

vi.mock("../../api/client", () => ({
  api: {
    tasks: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue({}),
      sessions: vi.fn().mockResolvedValue([]),
      markComplete: vi.fn().mockResolvedValue(undefined),
    },
    build: {
      nudge: (...args: unknown[]) => mockNudge(...args),
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

function createStore(tasks: { id: string; kanbanColumn: string; epicId: string; title: string; priority: number; assignee: string | null }[]) {
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
        awaitingApproval: false,
        selectedTaskId: null,
        taskDetail: null,
        taskDetailLoading: false,
        agentOutput: [],
        completionState: null,
        archivedSessions: [],
        archivedLoading: false,
        markCompleteLoading: false,
        loading: false,
        error: null,
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

  it("pause button is disabled", () => {
    const tasks = [
      { id: "epic-1.1", title: "Task A", epicId: "epic-1", kanbanColumn: "ready", priority: 0, assignee: null },
    ];
    const store = createStore(tasks);
    render(
      <Provider store={store}>
        <BuildPhase projectId="proj-1" />
      </Provider>,
    );

    const pauseButton = screen.getByRole("button", { name: /pause/i });
    expect(pauseButton).toBeDisabled();
  });
});
