import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { TaskLinkDisplay } from "./TaskLinkDisplay";
import executeReducer from "../store/slices/executeSlice";
import type { Task } from "@opensprint/shared";

const mockTasksGet = vi.fn();

vi.mock("../api/client", () => ({
  api: {
    tasks: {
      get: (...args: unknown[]) => mockTasksGet(...args),
    },
  },
}));

function toTasksByIdAndOrder(tasks: Task[]): { tasksById: Record<string, Task>; taskIdsOrder: string[] } {
  const tasksById: Record<string, Task> = {};
  const taskIdsOrder: string[] = [];
  const seen = new Set<string>();
  for (const t of tasks) {
    tasksById[t.id] = t;
    if (!seen.has(t.id)) {
      seen.add(t.id);
      taskIdsOrder.push(t.id);
    }
  }
  return { tasksById, taskIdsOrder };
}

const defaultExecuteState = {
  tasksById: {} as Record<string, Task>,
  taskIdsOrder: [] as string[],
  tasksInFlightCount: 0,
  orchestratorRunning: false,
  awaitingApproval: false,
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
};

function createStore(preloadedExecute?: { tasks: Task[] }) {
  return configureStore({
    reducer: { execute: executeReducer },
    preloadedState:
      preloadedExecute != null
        ? { execute: { ...defaultExecuteState, ...toTasksByIdAndOrder(preloadedExecute.tasks) } }
        : undefined,
  });
}

function renderWithStore(ui: React.ReactElement, options?: { execute?: { tasks: Task[] } }) {
  const store = createStore(options?.execute?.tasks ? { tasks: options.execute.tasks } : undefined);
  return {
    ...render(<Provider store={store}>{ui}</Provider>),
    store,
  };
}

describe("TaskLinkDisplay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders cached title when provided", () => {
    renderWithStore(
      <TaskLinkDisplay projectId="proj-1" taskId="task-1" cachedTitle="Cached task title" />
    );
    expect(screen.getByText("Cached task title")).toBeInTheDocument();
    expect(mockTasksGet).not.toHaveBeenCalled();
  });

  it("truncates cached title to 30 characters with ellipsis", () => {
    const longTitle = "This is a very long task title that exceeds thirty characters";
    renderWithStore(<TaskLinkDisplay projectId="proj-1" taskId="task-1" cachedTitle={longTitle} />);
    expect(screen.getByText("This is a very long task title…")).toBeInTheDocument();
  });

  it("does not call api.tasks.get when title is in execute.tasks", () => {
    renderWithStore(<TaskLinkDisplay projectId="proj-1" taskId="task-1" />, {
      execute: {
        tasks: [
          {
            id: "task-1",
            title: "From store",
            description: "",
            type: "task",
            status: "open",
            priority: 1,
            assignee: null,
            labels: [],
            dependencies: [],
            epicId: null,
            kanbanColumn: "backlog",
            createdAt: "",
            updatedAt: "",
          },
        ],
      },
    });
    expect(screen.getByText("From store")).toBeInTheDocument();
    expect(mockTasksGet).not.toHaveBeenCalled();
  });

  it("renders taskId when not in store and no cachedTitle (no fetch)", () => {
    renderWithStore(<TaskLinkDisplay projectId="proj-1" taskId="task-1" />);
    expect(screen.getByText("task-1")).toBeInTheDocument();
    expect(mockTasksGet).not.toHaveBeenCalled();
  });

  it("renders taskId for deleted/missing tasks without calling API", () => {
    renderWithStore(<TaskLinkDisplay projectId="proj-1" taskId="deleted-task" />);
    expect(screen.getByText("deleted-task")).toBeInTheDocument();
    expect(mockTasksGet).not.toHaveBeenCalled();
  });

  it("does not truncate title under 30 characters", () => {
    renderWithStore(
      <TaskLinkDisplay projectId="proj-1" taskId="task-1" cachedTitle="Short title" />
    );
    expect(screen.getByText("Short title")).toBeInTheDocument();
  });
});
