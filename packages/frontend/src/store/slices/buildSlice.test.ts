import { describe, it, expect, vi, beforeEach } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import buildReducer, {
  fetchTasks,
  fetchBuildPlans,
  fetchBuildStatus,
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
  setBuildError,
  resetBuild,
  type BuildState,
} from "./buildSlice";
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
    build: {
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

describe("buildSlice", () => {
  beforeEach(() => {
    vi.mocked(api.tasks.list).mockReset();
    vi.mocked(api.tasks.get).mockReset();
    vi.mocked(api.tasks.sessions).mockReset();
    vi.mocked(api.tasks.markDone).mockReset();
    vi.mocked(api.plans.list).mockReset();
    vi.mocked(api.build.status).mockReset();
  });

  function createStore() {
    return configureStore({
      reducer: { build: buildReducer, plan: planReducer },
    });
  }

  describe("initial state", () => {
    it("has correct initial state", () => {
      const store = createStore();
      const state = store.getState().build as BuildState;
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
      expect(store.getState().build.selectedTaskId).toBe("task-1");
      store.dispatch(appendAgentOutput({ taskId: "task-1", chunk: "output" }));
      store.dispatch(setCompletionState({ taskId: "task-1", status: "done", testResults: null }));
      store.dispatch(setSelectedTaskId(null));
      expect(store.getState().build.selectedTaskId).toBeNull();
      expect(store.getState().build.agentOutput).toEqual([]);
      expect(store.getState().build.completionState).toBeNull();
    });

    it("appendAgentOutput appends chunk for selected task only", () => {
      const store = createStore();
      store.dispatch(setSelectedTaskId("task-1"));
      store.dispatch(appendAgentOutput({ taskId: "task-1", chunk: "Hello " }));
      store.dispatch(appendAgentOutput({ taskId: "task-1", chunk: "world" }));
      expect(store.getState().build.agentOutput).toEqual(["Hello ", "world"]);
      store.dispatch(appendAgentOutput({ taskId: "task-2", chunk: "ignored" }));
      expect(store.getState().build.agentOutput).toEqual(["Hello ", "world"]);
    });

    it("setOrchestratorRunning sets orchestrator state", () => {
      const store = createStore();
      store.dispatch(setOrchestratorRunning(true));
      expect(store.getState().build.orchestratorRunning).toBe(true);
      store.dispatch(setOrchestratorRunning(false));
      expect(store.getState().build.orchestratorRunning).toBe(false);
    });

    it("setAwaitingApproval sets awaiting approval", () => {
      const store = createStore();
      store.dispatch(setAwaitingApproval(true));
      expect(store.getState().build.awaitingApproval).toBe(true);
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
      const state = store.getState().build;
      expect(state.completionState?.status).toBe("approved");
      expect(state.completionState?.testResults?.passed).toBe(5);
    });

    it("taskUpdated updates task in array", () => {
      const store = createStore();
      store.dispatch(setTasks([mockTask]));
      store.dispatch(taskUpdated({ taskId: "task-1", status: "in_progress", assignee: "agent-1" }));
      const task = store.getState().build.tasks[0];
      expect(task.kanbanColumn).toBe("in_progress");
      expect(task.assignee).toBe("agent-1");
    });

    it("setTasks replaces tasks", () => {
      const store = createStore();
      store.dispatch(setTasks([mockTask]));
      expect(store.getState().build.tasks).toHaveLength(1);
      store.dispatch(setTasks([]));
      expect(store.getState().build.tasks).toEqual([]);
    });

    it("setBuildError sets error", () => {
      const store = createStore();
      store.dispatch(setBuildError("Something went wrong"));
      expect(store.getState().build.error).toBe("Something went wrong");
    });

    it("resetBuild resets to initial state", () => {
      const store = createStore();
      store.dispatch(setTasks([mockTask]));
      store.dispatch(setSelectedTaskId("task-1"));
      store.dispatch(resetBuild());
      const state = store.getState().build as BuildState;
      expect(state.tasks).toEqual([]);
      expect(state.selectedTaskId).toBeNull();
    });
  });

  describe("fetchTasks thunk", () => {
    it("stores tasks on fulfilled", async () => {
      vi.mocked(api.tasks.list).mockResolvedValue([mockTask] as never);
      const store = createStore();
      await store.dispatch(fetchTasks("proj-1"));
      expect(store.getState().build.tasks).toEqual([mockTask]);
      expect(api.tasks.list).toHaveBeenCalledWith("proj-1");
    });

    it("sets error on rejected", async () => {
      vi.mocked(api.tasks.list).mockRejectedValue(new Error("Network error"));
      const store = createStore();
      await store.dispatch(fetchTasks("proj-1"));
      expect(store.getState().build.error).toBe("Network error");
    });
  });

  describe("fetchBuildPlans thunk", () => {
    it("stores plans and dispatches setPlansAndGraph on fulfilled", async () => {
      vi.mocked(api.plans.list).mockResolvedValue(mockGraph as never);
      const store = createStore();
      await store.dispatch(fetchBuildPlans("proj-1"));
      expect(store.getState().build.plans).toEqual([mockPlan]);
      expect(store.getState().plan.plans).toEqual([mockPlan]);
      expect(api.plans.list).toHaveBeenCalledWith("proj-1");
    });
  });

  describe("fetchBuildStatus thunk", () => {
    it("sets orchestratorRunning and awaitingApproval on fulfilled", async () => {
      vi.mocked(api.build.status).mockResolvedValue(mockOrchestratorStatus as never);
      const store = createStore();
      await store.dispatch(fetchBuildStatus("proj-1"));
      expect(store.getState().build.orchestratorRunning).toBe(true);
      expect(store.getState().build.awaitingApproval).toBe(false);
    });

    it("sets orchestratorRunning false when idle", async () => {
      vi.mocked(api.build.status).mockResolvedValue({
        currentTask: null,
        currentPhase: null,
        queueDepth: 0,
        totalDone: 0,
        totalFailed: 0,
      } as never);
      const store = createStore();
      await store.dispatch(fetchBuildStatus("proj-1"));
      expect(store.getState().build.orchestratorRunning).toBe(false);
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
      expect(store.getState().build.taskDetail).toEqual(fullTask);
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
      expect(store.getState().build.archivedSessions).toEqual(sessions);
    });
  });

  describe("markTaskDone thunk", () => {
    it("updates tasks and plan slice on fulfilled", async () => {
      vi.mocked(api.tasks.markDone).mockResolvedValue({ taskClosed: true } as never);
      vi.mocked(api.tasks.list).mockResolvedValue([{ ...mockTask, kanbanColumn: "done" }] as never);
      vi.mocked(api.plans.list).mockResolvedValue(mockGraph as never);
      const store = createStore();
      await store.dispatch(markTaskDone({ projectId: "proj-1", taskId: "task-1" }));
      expect(store.getState().build.tasks[0].kanbanColumn).toBe("done");
      expect(api.tasks.markDone).toHaveBeenCalledWith("proj-1", "task-1");
    });
  });
});
