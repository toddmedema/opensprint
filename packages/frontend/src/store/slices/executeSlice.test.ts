import { describe, it, expect, vi, beforeEach } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import executeReducer, {
  fetchTasks,
  fetchExecutePlans,
  fetchExecuteStatus,
  fetchTaskDetail,
  fetchArchivedSessions,
  markTaskDone,
  setSelectedTaskId,
  appendAgentOutput,
  setOrchestratorRunning,
  setAwaitingApproval,
  setCompletionState,
  taskUpdated,
  setTasks,
  setExecuteError,
  resetExecute,
  type ExecuteState,
} from "./executeSlice";
import planReducer, { setPlansAndGraph } from "./planSlice";
import type { Plan, PlanDependencyGraph, AgentSession, Task } from "@opensprint/shared";

vi.mock("../../api/client", () => ({
  api: {
    tasks: {
      list: vi.fn(),
      get: vi.fn(),
      sessions: vi.fn(),
      markDone: vi.fn(),
    },
    plans: { list: vi.fn() },
    execute: {
      status: vi.fn(),
    },
  },
}));

import { api } from "../../api/client";

const mockTask: Task = {
  id: "task-1",
  title: "Task 1",
  description: "",
  type: "task",
  status: "open",
  priority: 1,
  assignee: null,
  labels: [],
  dependencies: [],
  epicId: "epic-1",
  kanbanColumn: "backlog",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const mockPlan: Plan = {
  metadata: {
    planId: "plan-1",
    beadEpicId: "epic-1",
    gateTaskId: "gate-1",
    shippedAt: null,
    complexity: "medium",
  },
  content: "# Plan 1",
  status: "planning",
  taskCount: 3,
  doneTaskCount: 0,
  dependencyCount: 0,
};

const mockGraph: PlanDependencyGraph = {
  plans: [mockPlan],
  edges: [],
};

const mockOrchestratorStatus = {
  currentTask: "task-1",
  currentPhase: "coding" as const,
  queueDepth: 2,
  totalDone: 5,
  totalFailed: 0,
  awaitingApproval: false,
};

describe("executeSlice", () => {
  beforeEach(() => {
    vi.mocked(api.tasks.list).mockReset();
    vi.mocked(api.tasks.get).mockReset();
    vi.mocked(api.tasks.sessions).mockReset();
    vi.mocked(api.tasks.markDone).mockReset();
    vi.mocked(api.plans.list).mockReset();
    vi.mocked(api.execute.status).mockReset();
  });

  function createStore() {
    return configureStore({
      reducer: { execute: executeReducer, plan: planReducer },
    });
  }

  describe("initial state", () => {
    it("has correct initial state", () => {
      const store = createStore();
      const state = store.getState().execute as ExecuteState;
      expect(state.tasks).toEqual([]);
      expect(state.plans).toEqual([]);
      expect(state.orchestratorRunning).toBe(false);
      expect(state.awaitingApproval).toBe(false);
      expect(state.selectedTaskId).toBeNull();
      expect(state.taskDetail).toBeNull();
      expect(state.agentOutput).toEqual([]);
      expect(state.completionState).toBeNull();
      expect(state.archivedSessions).toEqual([]);
      expect(state.loading).toBe(false);
      expect(state.error).toBeNull();
    });
  });

  describe("reducers", () => {
    it("setSelectedTaskId sets selected task and clears related state", () => {
      const store = createStore();
      store.dispatch(setTasks([mockTask]));
      store.dispatch(setSelectedTaskId("task-1"));
      expect(store.getState().execute.selectedTaskId).toBe("task-1");
      store.dispatch(appendAgentOutput({ taskId: "task-1", chunk: "output" }));
      store.dispatch(setCompletionState({ taskId: "task-1", status: "done", testResults: null }));
      store.dispatch(setSelectedTaskId(null));
      expect(store.getState().execute.selectedTaskId).toBeNull();
      expect(store.getState().execute.agentOutput).toEqual([]);
      expect(store.getState().execute.completionState).toBeNull();
    });

    it("appendAgentOutput appends filtered chunk for selected task only", () => {
      const store = createStore();
      store.dispatch(setSelectedTaskId("task-1"));
      // Plain text with newlines passes through; JSON metadata is filtered
      store.dispatch(appendAgentOutput({ taskId: "task-1", chunk: "Hello \n" }));
      store.dispatch(appendAgentOutput({ taskId: "task-1", chunk: "world\n" }));
      expect(store.getState().execute.agentOutput).toEqual(["Hello \n", "world\n"]);
      store.dispatch(appendAgentOutput({ taskId: "task-2", chunk: "ignored" }));
      expect(store.getState().execute.agentOutput).toEqual(["Hello \n", "world\n"]);
    });

    it("appendAgentOutput filters JSON metadata and shows only message content", () => {
      const store = createStore();
      store.dispatch(setSelectedTaskId("task-1"));
      // Cursor stream-json: metadata events are hidden, text events are shown
      store.dispatch(
        appendAgentOutput({
          taskId: "task-1",
          chunk: '{"type":"tool_use","name":"edit","input":{}}\n',
        }),
      );
      expect(store.getState().execute.agentOutput).toEqual([]);
      store.dispatch(
        appendAgentOutput({
          taskId: "task-1",
          chunk: '{"type":"text","text":"Creating file..."}\n',
        }),
      );
      expect(store.getState().execute.agentOutput).toEqual(["Creating file..."]);
    });

    it("setOrchestratorRunning sets orchestrator state", () => {
      const store = createStore();
      store.dispatch(setOrchestratorRunning(true));
      expect(store.getState().execute.orchestratorRunning).toBe(true);
      store.dispatch(setOrchestratorRunning(false));
      expect(store.getState().execute.orchestratorRunning).toBe(false);
    });

    it("setAwaitingApproval sets awaiting approval", () => {
      const store = createStore();
      store.dispatch(setAwaitingApproval(true));
      expect(store.getState().execute.awaitingApproval).toBe(true);
    });

    it("setCompletionState sets completion for selected task", () => {
      const store = createStore();
      store.dispatch(setSelectedTaskId("task-1"));
      store.dispatch(
        setCompletionState({
          taskId: "task-1",
          status: "approved",
          testResults: { passed: 5, failed: 0, skipped: 1, total: 6 },
        }),
      );
      const state = store.getState().execute;
      expect(state.completionState?.status).toBe("approved");
      expect(state.completionState?.testResults?.passed).toBe(5);
    });

    it("taskUpdated updates task in array", () => {
      const store = createStore();
      store.dispatch(setTasks([mockTask]));
      store.dispatch(taskUpdated({ taskId: "task-1", status: "in_progress", assignee: "agent-1" }));
      const task = store.getState().execute.tasks[0];
      expect(task.kanbanColumn).toBe("in_progress");
      expect(task.assignee).toBe("agent-1");
    });

    it("setTasks replaces tasks", () => {
      const store = createStore();
      store.dispatch(setTasks([mockTask]));
      expect(store.getState().execute.tasks).toHaveLength(1);
      store.dispatch(setTasks([]));
      expect(store.getState().execute.tasks).toEqual([]);
    });

    it("setExecuteError sets error", () => {
      const store = createStore();
      store.dispatch(setExecuteError("Something went wrong"));
      expect(store.getState().execute.error).toBe("Something went wrong");
    });

    it("resetExecute resets to initial state", () => {
      const store = createStore();
      store.dispatch(setTasks([mockTask]));
      store.dispatch(setSelectedTaskId("task-1"));
      store.dispatch(resetExecute());
      const state = store.getState().execute as ExecuteState;
      expect(state.tasks).toEqual([]);
      expect(state.selectedTaskId).toBeNull();
    });
  });

  describe("fetchTasks thunk", () => {
    it("stores tasks on fulfilled", async () => {
      vi.mocked(api.tasks.list).mockResolvedValue([mockTask] as never);
      const store = createStore();
      await store.dispatch(fetchTasks("proj-1"));
      expect(store.getState().execute.tasks).toEqual([mockTask]);
      expect(api.tasks.list).toHaveBeenCalledWith("proj-1");
    });

    it("sets error on rejected", async () => {
      vi.mocked(api.tasks.list).mockRejectedValue(new Error("Network error"));
      const store = createStore();
      await store.dispatch(fetchTasks("proj-1"));
      expect(store.getState().execute.error).toBe("Network error");
    });
  });

  describe("fetchExecutePlans thunk", () => {
    it("stores plans and dispatches setPlansAndGraph on fulfilled", async () => {
      vi.mocked(api.plans.list).mockResolvedValue(mockGraph as never);
      const store = createStore();
      await store.dispatch(fetchExecutePlans("proj-1"));
      expect(store.getState().execute.plans).toEqual([mockPlan]);
      expect(store.getState().plan.plans).toEqual([mockPlan]);
      expect(api.plans.list).toHaveBeenCalledWith("proj-1");
    });
  });

  describe("fetchExecuteStatus thunk", () => {
    it("sets orchestratorRunning and awaitingApproval on fulfilled", async () => {
      vi.mocked(api.execute.status).mockResolvedValue(mockOrchestratorStatus as never);
      const store = createStore();
      await store.dispatch(fetchExecuteStatus("proj-1"));
      expect(store.getState().execute.orchestratorRunning).toBe(true);
      expect(store.getState().execute.awaitingApproval).toBe(false);
    });

    it("sets orchestratorRunning false when idle", async () => {
      vi.mocked(api.execute.status).mockResolvedValue({
        currentTask: null,
        currentPhase: null,
        queueDepth: 0,
        totalDone: 0,
        totalFailed: 0,
      } as never);
      const store = createStore();
      await store.dispatch(fetchExecuteStatus("proj-1"));
      expect(store.getState().execute.orchestratorRunning).toBe(false);
    });
  });

  describe("fetchTaskDetail thunk", () => {
    it("stores task detail on fulfilled", async () => {
      const fullTask = {
        id: "task-1",
        title: "Task 1",
        description: "Desc",
        type: "task" as const,
        status: "open" as const,
        priority: 1 as const,
        assignee: null,
        labels: [],
        dependencies: [],
        epicId: "epic-1",
        kanbanColumn: "backlog" as const,
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
      };
      vi.mocked(api.tasks.get).mockResolvedValue(fullTask as never);
      const store = createStore();
      await store.dispatch(fetchTaskDetail({ projectId: "proj-1", taskId: "task-1" }));
      expect(store.getState().execute.taskDetail).toEqual(fullTask);
    });
  });

  describe("fetchArchivedSessions thunk", () => {
    it("stores archived sessions on fulfilled", async () => {
      const sessions: AgentSession[] = [
        {
          taskId: "task-1",
          attempt: 1,
          agentType: "claude",
          agentModel: "claude-3",
          startedAt: "2025-01-01",
          completedAt: "2025-01-01",
          status: "success",
          outputLog: "log",
          gitBranch: "main",
          gitDiff: null,
          testResults: null,
          failureReason: null,
        },
      ];
      vi.mocked(api.tasks.sessions).mockResolvedValue(sessions as never);
      const store = createStore();
      await store.dispatch(fetchArchivedSessions({ projectId: "proj-1", taskId: "task-1" }));
      expect(store.getState().execute.archivedSessions).toEqual(sessions);
    });
  });

  describe("markTaskDone thunk", () => {
    it("updates tasks and plan slice on fulfilled", async () => {
      vi.mocked(api.tasks.markDone).mockResolvedValue({ taskClosed: true } as never);
      vi.mocked(api.tasks.list).mockResolvedValue([{ ...mockTask, kanbanColumn: "done" }] as never);
      vi.mocked(api.plans.list).mockResolvedValue(mockGraph as never);
      const store = createStore();
      await store.dispatch(markTaskDone({ projectId: "proj-1", taskId: "task-1" }));
      expect(store.getState().execute.tasks[0].kanbanColumn).toBe("done");
      expect(api.tasks.markDone).toHaveBeenCalledWith("proj-1", "task-1");
    });
  });
});
