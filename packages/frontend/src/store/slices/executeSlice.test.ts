import { describe, it, expect, vi, beforeEach } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import { agentOutputFilterMiddleware } from "../middleware/agentOutputFilterMiddleware";
import executeReducer, {
  fetchTasks,
  fetchMoreTasks,
  fetchTasksByIds,
  fetchExecutePlans,
  fetchExecuteStatus,
  fetchActiveAgents,
  fetchTaskDetail,
  fetchArchivedSessions,
  fetchLiveOutputBackfill,
  markTaskDone,
  unblockTask,
  updateTaskPriority,
  setSelectedTaskId,
  appendAgentOutput,
  setOrchestratorRunning,
  setAwaitingApproval,
  setCompletionState,
  taskUpdated,
  setTasks,
  setExecuteError,
  resetExecute,
  setAgentOutputBackfill,
  selectTasks,
  selectTasksForEpic,
  type ExecuteState,
} from "./executeSlice";
import planReducer from "./planSlice";
import websocketReducer from "./websocketSlice";
import type { Plan, PlanDependencyGraph, AgentSession, Task } from "@opensprint/shared";

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    api: {
      tasks: {
        list: vi.fn(),
        get: vi.fn(),
        sessions: vi.fn(),
        markDone: vi.fn(),
        unblock: vi.fn(),
        updatePriority: vi.fn(),
      },
      plans: { list: vi.fn() },
      execute: {
        status: vi.fn(),
        liveOutput: vi.fn(),
      },
      agents: { active: vi.fn() },
    },
  };
});

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
    epicId: "epic-1",
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
  activeTasks: [{ taskId: "task-1", phase: "coding", startedAt: "2025-01-01T00:00:00Z" }],
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
    vi.mocked(api.tasks.unblock).mockReset();
    vi.mocked(api.tasks.updatePriority).mockReset();
    vi.mocked(api.plans.list).mockReset();
    vi.mocked(api.execute.status).mockReset();
    vi.mocked(api.execute.liveOutput).mockReset();
    vi.mocked(api.agents.active).mockReset();
  });

  function createStore() {
    return configureStore({
      reducer: { execute: executeReducer, plan: planReducer, websocket: websocketReducer },
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(agentOutputFilterMiddleware),
    });
  }

  describe("initial state", () => {
    it("has correct initial state", () => {
      const store = createStore();
      const state = store.getState().execute as ExecuteState;
      expect(state.tasksById).toEqual({});
      expect(state.taskIdsOrder).toEqual([]);
      expect(state.orchestratorRunning).toBe(false);
      expect(state.awaitingApproval).toBe(false);
      expect(state.selectedTaskId).toBeNull();
      expect(state.agentOutput).toEqual({});
      expect(state.completionState).toBeNull();
      expect(state.archivedSessions).toEqual([]);
      expect(state.async.tasks.loading).toBe(false);
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
      expect(store.getState().execute.completionState).toBeNull();
    });

    it("setSelectedTaskId clears taskDetailError when switching tasks", async () => {
      vi.mocked(api.tasks.get).mockRejectedValue(new Error("Fetch failed"));
      const store = createStore();
      store.dispatch(setTasks([mockTask]));
      store.dispatch(setSelectedTaskId("task-1"));
      await store.dispatch(fetchTaskDetail({ projectId: "proj-1", taskId: "task-1" }));
      expect(store.getState().execute.async.taskDetail.error).toBe("Fetch failed");
      store.dispatch(setSelectedTaskId(null));
      expect(store.getState().execute.async.taskDetail.error).toBeNull();
    });

    it("appendAgentOutput appends filtered chunk keyed by taskId", () => {
      const store = createStore();
      store.dispatch(setSelectedTaskId("task-1"));
      store.dispatch(appendAgentOutput({ taskId: "task-1", chunk: "Hello \n" }));
      store.dispatch(appendAgentOutput({ taskId: "task-1", chunk: "world\n" }));
      expect(store.getState().execute.agentOutput["task-1"]).toEqual(["Hello \n", "world\n"]);
      store.dispatch(appendAgentOutput({ taskId: "task-2", chunk: "other\n" }));
      expect(store.getState().execute.agentOutput["task-2"]).toEqual(["other\n"]);
    });

    it("appendAgentOutput filters JSON metadata and shows only message content", () => {
      const store = createStore();
      store.dispatch(setSelectedTaskId("task-1"));
      store.dispatch(
        appendAgentOutput({
          taskId: "task-1",
          chunk: '{"type":"tool_use","name":"edit","input":{}}\n',
        })
      );
      expect(store.getState().execute.agentOutput["task-1"]).toBeUndefined();
      store.dispatch(
        appendAgentOutput({
          taskId: "task-1",
          chunk: '{"type":"text","text":"Creating file..."}\n',
        })
      );
      expect(store.getState().execute.agentOutput["task-1"]).toEqual(["Creating file..."]);
    });

    it("appendAgentOutput extracts actual thinking text from type:thinking JSON", () => {
      const store = createStore();
      store.dispatch(setSelectedTaskId("task-1"));
      store.dispatch(
        appendAgentOutput({
          taskId: "task-1",
          chunk: '{"type":"thinking","content":"internal reasoning..."}\n',
        })
      );
      expect(store.getState().execute.agentOutput["task-1"]).toEqual(["internal reasoning...\n"]);
    });

    it("setAgentOutputBackfill filters NDJSON backfill output before storing", () => {
      const store = createStore();
      const raw =
        '{"type":"text","text":"Hello"}\n{"type":"tool_use","name":"edit"}\n{"type":"text","text":" world"}\n';
      store.dispatch(setAgentOutputBackfill({ taskId: "task-1", output: raw }));
      expect(store.getState().execute.agentOutput["task-1"]).toEqual(["Hello world"]);
    });

    it("fetchLiveOutputBackfill.fulfilled sets agentOutput keyed by taskId", async () => {
      vi.mocked(api.execute.liveOutput).mockResolvedValue({
        output: "Existing output from server\n",
      });
      const store = createStore();
      store.dispatch(setSelectedTaskId("task-1"));
      await store.dispatch(fetchLiveOutputBackfill({ projectId: "proj-1", taskId: "task-1" }));
      expect(store.getState().execute.agentOutput["task-1"]).toEqual([
        "Existing output from server\n",
      ]);
    });

    it("fetchLiveOutputBackfill.fulfilled stores output for non-selected task too", async () => {
      vi.mocked(api.execute.liveOutput).mockResolvedValue({
        output: "Output for task-2\n",
      });
      const store = createStore();
      store.dispatch(setSelectedTaskId("task-1"));
      await store.dispatch(fetchLiveOutputBackfill({ projectId: "proj-1", taskId: "task-2" }));
      expect(store.getState().execute.agentOutput["task-2"]).toEqual(["Output for task-2\n"]);
      expect(store.getState().execute.agentOutput["task-1"]).toBeUndefined();
    });

    it("fetchLiveOutputBackfill.fulfilled filters NDJSON backfill output before storing", async () => {
      const raw =
        '{"type":"text","text":"Hello"}\n{"type":"tool_use","name":"edit"}\n{"type":"text","text":" world"}\n';
      vi.mocked(api.execute.liveOutput).mockResolvedValue({ output: raw });
      const store = createStore();
      await store.dispatch(fetchLiveOutputBackfill({ projectId: "proj-1", taskId: "task-1" }));
      expect(store.getState().execute.agentOutput["task-1"]).toEqual(["Hello world"]);
    });

    it("fetchLiveOutputBackfill.fulfilled always applies result (including empty) so UI refreshes during polling", async () => {
      vi.mocked(api.execute.liveOutput).mockResolvedValue({ output: "" });
      const store = createStore();
      await store.dispatch(fetchLiveOutputBackfill({ projectId: "proj-1", taskId: "task-1" }));
      expect(store.getState().execute.agentOutput["task-1"]).toEqual([""]);
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
        })
      );
      const state = store.getState().execute;
      expect(state.completionState?.status).toBe("approved");
      expect(state.completionState?.testResults?.passed).toBe(5);
    });

    it("taskUpdated updates task in array", () => {
      const store = createStore();
      store.dispatch(setTasks([mockTask]));
      store.dispatch(taskUpdated({ taskId: "task-1", status: "in_progress", assignee: "Frodo" }));
      const task = selectTasks(store.getState())[0];
      expect(task.kanbanColumn).toBe("in_progress");
      expect(task.assignee).toBe("Frodo");
    });

    it("taskUpdated maps blocked status to kanbanColumn blocked", () => {
      const store = createStore();
      store.dispatch(setTasks([mockTask]));
      store.dispatch(taskUpdated({ taskId: "task-1", status: "blocked" }));
      const task = selectTasks(store.getState())[0];
      expect(task.kanbanColumn).toBe("blocked");
    });

    it("taskUpdated updates blockReason when provided", () => {
      const store = createStore();
      store.dispatch(setTasks([mockTask]));
      store.dispatch(
        taskUpdated({ taskId: "task-1", status: "blocked", blockReason: "Merge Failure" })
      );
      const task = selectTasks(store.getState())[0];
      expect(task.kanbanColumn).toBe("blocked");
      expect(task.blockReason).toBe("Merge Failure");
    });

    it("taskUpdated updates priority in tasks", () => {
      const store = createStore();
      const taskWithDetail = { ...mockTask, id: "task-1" };
      store.dispatch(setTasks([taskWithDetail]));
      store.dispatch(setSelectedTaskId("task-1"));
      store.dispatch(
        fetchTaskDetail.fulfilled(taskWithDetail, "", { projectId: "p1", taskId: "task-1" })
      );
      store.dispatch(taskUpdated({ taskId: "task-1", priority: 0 }));
      const task = selectTasks(store.getState())[0];
      expect(task.priority).toBe(0);
    });

    it("setTasks replaces tasks", () => {
      const store = createStore();
      store.dispatch(setTasks([mockTask]));
      expect(selectTasks(store.getState())).toHaveLength(1);
      store.dispatch(setTasks([]));
      expect(selectTasks(store.getState())).toEqual([]);
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
      expect(state.tasksById).toEqual({});
      expect(state.taskIdsOrder).toEqual([]);
      expect(state.selectedTaskId).toBeNull();
    });
  });

  describe("fetchTasks thunk", () => {
    it("stores tasks on fulfilled", async () => {
      vi.mocked(api.tasks.list).mockResolvedValue([mockTask] as never);
      const store = createStore();
      await store.dispatch(fetchTasks("proj-1"));
      expect(selectTasks(store.getState())).toEqual([mockTask]);
      expect(api.tasks.list).toHaveBeenCalledWith("proj-1");
    });

    it("stores paginated tasks and sets hasMoreTasks when limit/offset provided", async () => {
      vi.mocked(api.tasks.list).mockResolvedValue({
        items: [mockTask],
        total: 150,
      } as never);
      const store = createStore();
      await store.dispatch(fetchTasks({ projectId: "proj-1", limit: 100, offset: 0 }));
      const state = store.getState().execute;
      expect(selectTasks(store.getState())).toEqual([mockTask]);
      expect(state.tasksTotalCount).toBe(150);
      expect(state.hasMoreTasks).toBe(true);
      expect(api.tasks.list).toHaveBeenCalledWith("proj-1", { limit: 100, offset: 0 });
    });

    it("sets error on rejected", async () => {
      vi.mocked(api.tasks.list).mockRejectedValue(new Error("Network error"));
      const store = createStore();
      await store.dispatch(fetchTasks("proj-1"));
      expect(store.getState().execute.error).toBe("Network error");
    });
  });

  describe("fetchMoreTasks thunk", () => {
    it("deduplicates when paginated pages overlap (same task ID in multiple pages)", async () => {
      const task2 = { ...mockTask, id: "task-2", title: "Task 2" };
      const task3 = { ...mockTask, id: "task-3", title: "Task 3" };
      vi.mocked(api.tasks.list)
        .mockResolvedValueOnce({ items: [mockTask, task2], total: 4 } as never)
        .mockResolvedValueOnce({ items: [task2, task3], total: 4 } as never);
      const store = createStore();
      await store.dispatch(fetchTasks({ projectId: "proj-1", limit: 100, offset: 0 }));
      expect(selectTasks(store.getState())).toHaveLength(2);
      await store.dispatch(fetchMoreTasks("proj-1"));
      const tasks = selectTasks(store.getState());
      expect(tasks).toHaveLength(3);
      const ids = tasks.map((t) => t.id);
      expect(ids).toEqual(["task-1", "task-2", "task-3"]);
      expect(new Set(ids).size).toBe(3);
    });

    it("appends next page and updates hasMoreTasks", async () => {
      const task2 = { ...mockTask, id: "task-2", title: "Task 2" };
      vi.mocked(api.tasks.list)
        .mockResolvedValueOnce({ items: [mockTask], total: 150 } as never)
        .mockResolvedValueOnce({ items: [task2], total: 150 } as never);
      const store = createStore();
      await store.dispatch(fetchTasks({ projectId: "proj-1", limit: 100, offset: 0 }));
      expect(selectTasks(store.getState())).toHaveLength(1);
      await store.dispatch(fetchMoreTasks("proj-1"));
      const tasks = selectTasks(store.getState());
      const state = store.getState().execute;
      expect(tasks).toHaveLength(2);
      expect(tasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "task-1" }),
          expect.objectContaining({ id: "task-2" }),
        ])
      );
      expect(state.hasMoreTasks).toBe(true);
      expect(api.tasks.list).toHaveBeenLastCalledWith("proj-1", { limit: 100, offset: 1 });
    });
  });

  describe("fetchTasksByIds thunk", () => {
    it("merges fetched tasks into state without replacing existing tasks", async () => {
      const task2 = { ...mockTask, id: "task-2", title: "Task 2" };
      vi.mocked(api.tasks.get)
        .mockResolvedValueOnce(mockTask as never)
        .mockResolvedValueOnce(task2 as never);
      const store = createStore();
      store.dispatch(setTasks([{ ...mockTask, id: "existing", title: "Existing" }]));
      await store.dispatch(fetchTasksByIds({ projectId: "proj-1", taskIds: ["task-1", "task-2"] }));
      const tasks = selectTasks(store.getState());
      expect(tasks).toHaveLength(3);
      expect(tasks.map((t) => t.id)).toEqual(
        expect.arrayContaining(["existing", "task-1", "task-2"])
      );
      expect(api.tasks.get).toHaveBeenCalledWith("proj-1", "task-1");
      expect(api.tasks.get).toHaveBeenCalledWith("proj-1", "task-2");
    });

    it("returns empty array when taskIds is empty", async () => {
      const store = createStore();
      store.dispatch(setTasks([mockTask]));
      await store.dispatch(fetchTasksByIds({ projectId: "proj-1", taskIds: [] }));
      expect(selectTasks(store.getState())).toEqual([mockTask]);
      expect(api.tasks.get).not.toHaveBeenCalled();
    });
  });

  describe("selectTasksForEpic", () => {
    it("returns all tasks for epic (filter by epicId only, no gate exclusion)", () => {
      const tasks = [
        { ...mockTask, id: "epic-1.1", epicId: "epic-1", title: "Task 1" },
        { ...mockTask, id: "epic-1.2", epicId: "epic-1", title: "Task 2" },
        { ...mockTask, id: "epic-2.1", epicId: "epic-2", title: "Other epic" },
      ];
      const store = createStore();
      store.dispatch(setTasks(tasks as Task[]));
      const state = store.getState();
      const result = selectTasksForEpic(state, "epic-1");
      expect(result).toHaveLength(2);
      expect(result.map((t) => t.id)).toEqual(["epic-1.1", "epic-1.2"]);
    });

    it("returns empty array when epicId is undefined", () => {
      const store = createStore();
      store.dispatch(setTasks([mockTask]));
      const state = store.getState();
      expect(selectTasksForEpic(state, undefined)).toEqual([]);
    });

    it("returns all tasks for epic by epicId only (no id-pattern exclusion)", () => {
      const tasks = [
        { ...mockTask, id: "epic-1.1", epicId: "epic-1", title: "Task 1" },
        { ...mockTask, id: "epic-1.2", epicId: "epic-1", title: "Task 2" },
        { ...mockTask, id: "epic-1.10", epicId: "epic-1", title: "Task 10" },
      ];
      const store = createStore();
      store.dispatch(setTasks(tasks as Task[]));
      const state = store.getState();
      const result = selectTasksForEpic(state, "epic-1");
      expect(result).toHaveLength(3);
      expect(result.map((t) => t.id)).toEqual(["epic-1.1", "epic-1.2", "epic-1.10"]);
    });

    it("returns tasks in planning column (blocked epic) — no gate exclusion", () => {
      const tasks = [
        {
          ...mockTask,
          id: "epic-1.1",
          epicId: "epic-1",
          title: "Task in blocked epic",
          kanbanColumn: "planning",
        },
      ];
      const store = createStore();
      store.dispatch(setTasks(tasks as Task[]));
      const state = store.getState();
      const result = selectTasksForEpic(state, "epic-1");
      expect(result).toHaveLength(1);
      expect(result[0].kanbanColumn).toBe("planning");
    });
  });

  describe("fetchExecutePlans thunk", () => {
    it("dispatches setPlansAndGraph so plan slice has plans on fulfilled", async () => {
      vi.mocked(api.plans.list).mockResolvedValue(mockGraph as never);
      const store = createStore();
      await store.dispatch(fetchExecutePlans("proj-1"));
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
        activeTasks: [],
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
    it("merges task detail into state.tasks on fulfilled", async () => {
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
      store.dispatch(setTasks([{ ...mockTask, id: "task-1" }]));
      await store.dispatch(fetchTaskDetail({ projectId: "proj-1", taskId: "task-1" }));
      expect(selectTasks(store.getState())[0]).toEqual(fullTask);
      expect(store.getState().execute.async.taskDetail.error).toBeNull();
    });

    it("sets taskDetailError on rejected", async () => {
      vi.mocked(api.tasks.get).mockRejectedValue(new Error("Network error"));
      const store = createStore();
      store.dispatch(setSelectedTaskId("task-1"));
      await store.dispatch(fetchTaskDetail({ projectId: "proj-1", taskId: "task-1" }));
      expect(store.getState().execute.async.taskDetail.loading).toBe(false);
      expect(store.getState().execute.async.taskDetail.error).toBe("Network error");
    });
  });

  describe("fetchActiveAgents thunk", () => {
    it("stores activeAgents and taskIdToStartedAt on fulfilled", async () => {
      const agents = [
        { id: "task-1", phase: "coding", role: "coder", label: "Coder", startedAt: "2025-01-01" },
        {
          id: "task-2",
          phase: "review",
          role: "reviewer",
          label: "Reviewer",
          startedAt: "2025-01-02",
        },
      ];
      vi.mocked(api.agents.active).mockResolvedValue(agents as never);
      const store = createStore();
      await store.dispatch(fetchActiveAgents("proj-1"));
      const state = store.getState().execute;
      expect(state.activeAgents).toEqual(agents);
      expect(state.taskIdToStartedAt).toEqual({ "task-1": "2025-01-01", "task-2": "2025-01-02" });
      expect(state.activeAgentsLoadedOnce).toBe(true);
    });

    it("sets activeAgentsLoadedOnce true on rejected", async () => {
      vi.mocked(api.agents.active).mockRejectedValue(new Error("Network error"));
      const store = createStore();
      await store.dispatch(fetchActiveAgents("proj-1"));
      expect(store.getState().execute.activeAgentsLoadedOnce).toBe(true);
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
      expect(selectTasks(store.getState())[0].kanbanColumn).toBe("done");
      expect(api.tasks.markDone).toHaveBeenCalledWith("proj-1", "task-1");
    });
  });

  describe("unblockTask thunk", () => {
    it("updates tasks and plan slice on fulfilled", async () => {
      vi.mocked(api.tasks.unblock).mockResolvedValue({ taskUnblocked: true } as never);
      vi.mocked(api.tasks.list).mockResolvedValue([
        { ...mockTask, id: "task-1", kanbanColumn: "backlog" },
      ] as never);
      vi.mocked(api.plans.list).mockResolvedValue(mockGraph as never);
      const store = createStore();
      store.dispatch(setTasks([{ ...mockTask, kanbanColumn: "blocked" }]));
      store.dispatch(setSelectedTaskId("task-1"));
      await store.dispatch(unblockTask({ projectId: "proj-1", taskId: "task-1" }));
      expect(selectTasks(store.getState())[0].kanbanColumn).toBe("backlog");
      expect(api.tasks.unblock).toHaveBeenCalledWith("proj-1", "task-1", {});
    });

    it("passes resetAttempts when provided", async () => {
      vi.mocked(api.tasks.unblock).mockResolvedValue({ taskUnblocked: true } as never);
      vi.mocked(api.tasks.list).mockResolvedValue([
        { ...mockTask, kanbanColumn: "backlog" },
      ] as never);
      vi.mocked(api.plans.list).mockResolvedValue(mockGraph as never);
      const store = createStore();
      await store.dispatch(
        unblockTask({ projectId: "proj-1", taskId: "task-1", resetAttempts: true })
      );
      expect(api.tasks.unblock).toHaveBeenCalledWith("proj-1", "task-1", { resetAttempts: true });
    });
  });

  describe("updateTaskPriority thunk", () => {
    it("optimistically updates priority, then confirms on fulfilled", async () => {
      const updatedTask = { ...mockTask, id: "task-1", priority: 0 };
      vi.mocked(api.tasks.updatePriority).mockResolvedValue(updatedTask as never);
      const store = createStore();
      store.dispatch(setTasks([{ ...mockTask, priority: 1 }]));
      store.dispatch(setSelectedTaskId("task-1"));
      store.dispatch(
        fetchTaskDetail.fulfilled({ ...mockTask, priority: 1 }, "", {
          projectId: "proj-1",
          taskId: "task-1",
        })
      );
      const promise = store.dispatch(
        updateTaskPriority({
          projectId: "proj-1",
          taskId: "task-1",
          priority: 0,
          previousPriority: 1,
        })
      );
      // Optimistic update applied immediately to tasks
      expect(selectTasks(store.getState())[0].priority).toBe(0);
      await promise;
      expect(api.tasks.updatePriority).toHaveBeenCalledWith("proj-1", "task-1", 0);
      expect(selectTasks(store.getState())[0].priority).toBe(0);
    });

    it("reverts priority and shows toast on rejected", async () => {
      vi.mocked(api.tasks.updatePriority).mockRejectedValue(new Error("Validation failed"));
      const store = createStore();
      store.dispatch(setTasks([{ ...mockTask, id: "task-1", priority: 1 }]));
      store.dispatch(setSelectedTaskId("task-1"));
      store.dispatch(
        fetchTaskDetail.fulfilled({ ...mockTask, id: "task-1", priority: 1 }, "", {
          projectId: "proj-1",
          taskId: "task-1",
        })
      );
      await store.dispatch(
        updateTaskPriority({
          projectId: "proj-1",
          taskId: "task-1",
          priority: 0,
          previousPriority: 1,
        })
      );
      expect(selectTasks(store.getState())[0].priority).toBe(1);
      expect(store.getState().websocket.deliverToast).toEqual({
        message: "Failed to update priority",
        variant: "failed",
      });
    });
  });
});
