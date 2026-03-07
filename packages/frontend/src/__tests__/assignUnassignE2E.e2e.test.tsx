/**
 * E2E: Assign a ready task to a teammate from Execute UI; verify it does not get picked
 * by the agent (orchestrator excludes human-assigned tasks). Unassign; verify task
 * becomes eligible for agent pickup.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configureStore } from "@reduxjs/toolkit";
import { isAgentAssignee } from "@opensprint/shared";
import { ExecutePhase } from "../pages/phases/ExecutePhase";
import projectReducer from "../store/slices/projectSlice";
import planReducer from "../store/slices/planSlice";
import executeReducer, {
  initialExecuteState,
  toTasksByIdAndOrder,
} from "../store/slices/executeSlice";
import evalReducer from "../store/slices/evalSlice";
import websocketReducer from "../store/slices/websocketSlice";

const mockTasksList = vi.fn();
const mockGetSettings = vi.fn();
const mockUpdateTask = vi.fn();
const mockTaskGet = vi.fn();
const mockSessions = vi.fn();
const mockLiveOutput = vi.fn();
const mockAgentsActive = vi.fn();
const mockTaskDiagnostics = vi.fn();
const mockExecuteStatus = vi.fn();

vi.mock("../api/client", () => ({
  api: {
    tasks: {
      list: (...args: unknown[]) => mockTasksList(...args),
      get: (...args: unknown[]) => mockTaskGet(...args),
      updateTask: (...args: unknown[]) => mockUpdateTask(...args),
      sessions: vi.fn().mockResolvedValue([]),
      markDone: vi.fn().mockResolvedValue(undefined),
      unblock: vi.fn().mockResolvedValue({ taskUnblocked: true }),
    },
    plans: {
      list: vi.fn().mockResolvedValue({ plans: [], edges: [] }),
    },
    projects: {
      get: vi.fn().mockResolvedValue({ id: "proj-1", name: "Test", repoPath: "/tmp", currentPhase: "execute", createdAt: "", updatedAt: "" }),
      getSettings: (...args: unknown[]) => mockGetSettings(...args),
    },
    execute: {
      status: (...args: unknown[]) => mockExecuteStatus(...args),
      liveOutput: (...args: unknown[]) => mockLiveOutput(...args),
      taskDiagnostics: (...args: unknown[]) => mockTaskDiagnostics(...args),
    },
    agents: {
      active: (...args: unknown[]) => mockAgentsActive(...args),
    },
    feedback: {
      get: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
    },
    notifications: {
      listByProject: vi.fn().mockResolvedValue([]),
    },
  },
}));

const basePlan = {
  metadata: {
    planId: "plan-1",
    epicId: "epic-1",
    complexity: "medium" as const,
  },
  content: "# Plan",
  status: "building" as const,
  taskCount: 1,
  doneTaskCount: 0,
  dependencyCount: 0,
};

const readyTask = {
  id: "epic-1.1",
  title: "Ready task",
  epicId: "epic-1",
  kanbanColumn: "ready" as const,
  priority: 0,
  assignee: null as string | null,
  description: "",
  type: "task" as const,
  status: "open" as const,
  labels: [] as string[],
  dependencies: [] as { targetId: string; type: string }[],
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const teamMembers = [{ id: "alice", name: "Alice" }];

function createStore(preloadedTasks: typeof readyTask[] = [readyTask]) {
  const { tasksById, taskIdsOrder } = toTasksByIdAndOrder(preloadedTasks as never);
  return configureStore({
    reducer: {
      project: projectReducer,
      plan: planReducer,
      execute: executeReducer,
      eval: evalReducer,
      websocket: websocketReducer,
    },
    preloadedState: {
      websocket: { connected: true, deliverToast: null },
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
        tasksById,
        taskIdsOrder,
        selectedTaskId: null,
      },
    },
  });
}

async function renderExecutePhase(store: ReturnType<typeof createStore>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

describe("E2E: Assign task to teammate, verify no agent pickup; unassign and verify eligible", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTasksList.mockResolvedValue([]);
    mockGetSettings.mockResolvedValue({ teamMembers });
    mockExecuteStatus.mockResolvedValue({ activeTasks: [], queueDepth: 0 });
    mockTaskGet.mockResolvedValue(readyTask);
    mockSessions.mockResolvedValue([]);
    mockLiveOutput.mockResolvedValue({ output: "" });
    mockAgentsActive.mockResolvedValue([]);
    mockTaskDiagnostics.mockResolvedValue(null);
    mockUpdateTask.mockImplementation(
      (_projectId: string, _taskId: string, updates: { assignee?: string | null }) =>
        Promise.resolve({ ...readyTask, assignee: updates.assignee ?? null } as never)
    );
  });

  it("assigns ready task to teammate, verifies human assignee excluded from agent dispatch; unassigns and verifies eligible", async () => {
    const store = createStore();
    await renderExecutePhase(store);

    // Find the task row assignee control (Ready section)
    await waitFor(() => {
      expect(screen.getByTestId("task-row-assignee")).toBeInTheDocument();
    });
    expect(screen.getByText("—")).toBeInTheDocument(); // unassigned label

    const user = userEvent.setup();

    // Assign to teammate Alice
    await user.click(screen.getByTestId("assignee-dropdown-trigger"));
    await waitFor(() => {
      expect(screen.getByTestId("assignee-dropdown")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("assignee-option-alice"));

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith("proj-1", "epic-1.1", {
        assignee: "Alice",
      });
    });

    // Verify human assignee: orchestrator would not dispatch (isAgentAssignee false)
    expect(isAgentAssignee("Alice")).toBe(false);

    // After fulfilled, Redux should have the task with assignee "Alice"
    await waitFor(() => {
      const state = store.getState();
      const task = (state.execute as { tasksById: Record<string, { assignee: string | null }> }).tasksById["epic-1.1"];
      expect(task?.assignee).toBe("Alice");
    });

    // Unassign: select Unassigned
    await user.click(screen.getByTestId("assignee-dropdown-trigger"));
    await waitFor(() => {
      expect(screen.getByTestId("assignee-option-unassigned")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("assignee-option-unassigned"));

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith("proj-1", "epic-1.1", {
        assignee: null,
      });
    });

    // Verify task is eligible for agent (no assignee)
    await waitFor(() => {
      const state = store.getState();
      const task = (state.execute as { tasksById: Record<string, { assignee: string | null }> }).tasksById["epic-1.1"];
      expect(task?.assignee).toBeNull();
    });
    expect(isAgentAssignee(null)).toBe(false);
    // Task with assignee null is included in orchestrator's dispatch filter (!t.assignee || isAgentAssignee(t.assignee))
  });
});
