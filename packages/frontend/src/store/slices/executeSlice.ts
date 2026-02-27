import {
  createSlice,
  createAsyncThunk,
  createSelector,
  type PayloadAction,
} from "@reduxjs/toolkit";
import type {
  ActiveAgent,
  AgentSession,
  KanbanColumn,
  Task,
  TaskPriority,
  TaskSummary,
} from "@opensprint/shared";
import { mapStatusToKanban } from "@opensprint/shared";
import { api } from "../../api/client";
import { filterAgentOutput } from "../../utils/agentOutputFilter";
import { DEDUP_SKIP } from "../dedup";
import { createInitialAsyncStates, createAsyncHandlers, type AsyncStates } from "../asyncHelpers";
import { setPlansAndGraph } from "./planSlice";
import { isConnectionError } from "../../api/client";
import { setDeliverToast } from "./websocketSlice";

/** Task display shape for kanban (subset of Task) */
export type TaskCard = Pick<
  Task,
  "id" | "title" | "kanbanColumn" | "priority" | "assignee" | "epicId" | "testResults"
>;

/** Active task entry from orchestrator status (v2 multi-slot model) */
export interface ActiveTaskInfo {
  taskId: string;
  phase: string;
  startedAt: string;
}

const TASKS_IN_FLIGHT_KEY = "tasksInFlightCount" as const;

const EXECUTE_ASYNC_KEYS = [
  "tasks",
  "status",
  "taskDetail",
  "archived",
  "markDone",
  "unblock",
  "activeAgents",
] as const;
type ExecuteAsyncKey = (typeof EXECUTE_ASYNC_KEYS)[number];

export interface ExecuteState {
  /** Tasks keyed by ID — duplicates impossible. */
  tasksById: Record<string, Task>;
  /** Ordered task IDs for display. */
  taskIdsOrder: string[];
  [TASKS_IN_FLIGHT_KEY]: number;
  orchestratorRunning: boolean;
  awaitingApproval: boolean;
  /** Active tasks being worked on by orchestrator agents (v2 multi-slot) */
  activeTasks: ActiveTaskInfo[];
  /** Full active agents from fetchActiveAgents (for ActiveAgentsList, AgentDashboard) */
  activeAgents: ActiveAgent[];
  /** True after first fetchActiveAgents completes (fulfilled or rejected) — used to avoid showing "No agents running" during initial load */
  activeAgentsLoadedOnce: boolean;
  /** taskId -> startedAt for agents in coding/review (from fetchActiveAgents) */
  taskIdToStartedAt: Record<string, string>;
  /** Orchestrator stats (from fetchExecuteStatus) */
  totalDone: number;
  totalFailed: number;
  queueDepth: number;
  selectedTaskId: string | null;
  agentOutput: Record<string, string[]>;
  completionState: {
    status: string;
    testResults: { passed: number; failed: number; skipped: number; total: number } | null;
    reason?: string | null;
  } | null;
  archivedSessions: AgentSession[];
  async: AsyncStates<ExecuteAsyncKey>;
  /** Last error from any async operation (for backward compat / display) */
  error: string | null;
}

export const initialExecuteState: ExecuteState = {
  tasksById: {},
  taskIdsOrder: [],
  [TASKS_IN_FLIGHT_KEY]: 0,
  orchestratorRunning: false,
  awaitingApproval: false,
  activeTasks: [],
  activeAgents: [],
  activeAgentsLoadedOnce: false,
  taskIdToStartedAt: {},
  totalDone: 0,
  totalFailed: 0,
  queueDepth: 0,
  selectedTaskId: null,
  agentOutput: {},
  completionState: null,
  archivedSessions: [],
  async: createInitialAsyncStates(EXECUTE_ASYNC_KEYS),
  error: null,
};

export type FetchTasksArg = string;

export const fetchTasks = createAsyncThunk<Task[], FetchTasksArg>(
  "execute/fetchTasks",
  async (projectId, { getState, rejectWithValue }) => {
    const root = getState() as { execute: ExecuteState };
    const inFlight = root.execute[TASKS_IN_FLIGHT_KEY] ?? 0;
    if (inFlight > 1) {
      return rejectWithValue(DEDUP_SKIP);
    }
    return api.tasks.list(projectId);
  }
);

/** Fetch only specific tasks and merge into state. Used when Analyst creates tickets so only the affected feedback card updates. */
export const fetchTasksByIds = createAsyncThunk<Task[], { projectId: string; taskIds: string[] }>(
  "execute/fetchTasksByIds",
  async ({ projectId, taskIds }) => {
    if (taskIds.length === 0) return [];
    const tasks = await Promise.all(taskIds.map((id) => api.tasks.get(projectId, id)));
    return tasks;
  }
);

export const fetchExecutePlans = createAsyncThunk(
  "execute/fetchExecutePlans",
  async (projectId: string, { dispatch }) => {
    const graph = await api.plans.list(projectId);
    dispatch(setPlansAndGraph({ plans: graph.plans, dependencyGraph: graph }));
    return graph.plans;
  }
);

export const fetchExecuteStatus = createAsyncThunk(
  "execute/fetchExecuteStatus",
  async (projectId: string) => {
    return api.execute.status(projectId);
  }
);

export const fetchActiveAgents = createAsyncThunk(
  "execute/fetchActiveAgents",
  async (projectId: string) => {
    const agents = await api.agents.active(projectId);
    const map: Record<string, string> = {};
    for (const a of agents) {
      if (a.phase === "coding" || a.phase === "review") {
        map[a.id] = a.startedAt;
      }
    }
    return { agents, taskIdToStartedAt: map };
  }
);

export const fetchTaskDetail = createAsyncThunk(
  "execute/fetchTaskDetail",
  async ({ projectId, taskId }: { projectId: string; taskId: string }) => {
    return api.tasks.get(projectId, taskId);
  }
);

export const fetchArchivedSessions = createAsyncThunk(
  "execute/fetchArchivedSessions",
  async ({ projectId, taskId }: { projectId: string; taskId: string }) => {
    return (await api.tasks.sessions(projectId, taskId)) ?? [];
  }
);

export const fetchLiveOutputBackfill = createAsyncThunk(
  "execute/fetchLiveOutputBackfill",
  async ({ projectId, taskId }: { projectId: string; taskId: string }) => {
    const output = (await api.execute.liveOutput(projectId, taskId)).output;
    return { taskId, output };
  }
);

export const markTaskDone = createAsyncThunk(
  "execute/markTaskDone",
  async ({ projectId, taskId }: { projectId: string; taskId: string }, { dispatch }) => {
    await api.tasks.markDone(projectId, taskId);
    const [tasksData, plansGraph] = await Promise.all([
      api.tasks.list(projectId),
      api.plans.list(projectId),
    ]);
    dispatch(setPlansAndGraph({ plans: plansGraph.plans, dependencyGraph: plansGraph }));
    const tasks = Array.isArray(tasksData)
      ? tasksData
      : (tasksData as { items: Task[] })?.items ?? [];
    return { tasks };
  }
);

export const updateTaskPriority = createAsyncThunk(
  "execute/updateTaskPriority",
  async (
    {
      projectId,
      taskId,
      priority,
      previousPriority,
    }: { projectId: string; taskId: string; priority: number; previousPriority: number },
    { dispatch, rejectWithValue }
  ) => {
    try {
      const task = await api.tasks.updatePriority(projectId, taskId, priority);
      return { task, taskId };
    } catch (err) {
      if (!isConnectionError(err)) {
        dispatch(setDeliverToast({ message: "Failed to update priority", variant: "failed" }));
      }
      return rejectWithValue({ previousPriority });
    }
  }
);

export const addTaskDependency = createAsyncThunk(
  "execute/addTaskDependency",
  async (
    {
      projectId,
      taskId,
      parentTaskId,
      type,
    }: {
      projectId: string;
      taskId: string;
      parentTaskId: string;
      type?: "blocks" | "parent-child" | "related";
    },
    { dispatch }
  ) => {
    await api.tasks.addDependency(projectId, taskId, parentTaskId, type);
    const task = await api.tasks.get(projectId, taskId);
    return { task, taskId };
  }
);

export const unblockTask = createAsyncThunk(
  "execute/unblockTask",
  async (
    {
      projectId,
      taskId,
      resetAttempts,
    }: { projectId: string; taskId: string; resetAttempts?: boolean },
    { dispatch }
  ) => {
    await api.tasks.unblock(projectId, taskId, { resetAttempts });
    const [tasksData, plansGraph] = await Promise.all([
      api.tasks.list(projectId),
      api.plans.list(projectId),
    ]);
    dispatch(setPlansAndGraph({ plans: plansGraph.plans, dependencyGraph: plansGraph }));
    const tasks = Array.isArray(tasksData)
      ? tasksData
      : (tasksData as { items: Task[] })?.items ?? [];
    return { tasks, taskId };
  }
);

const MAX_AGENT_OUTPUT = 5000;

/** Converts task array to tasksById + taskIdsOrder (deduped by id). Exported for tests. */
export function toTasksByIdAndOrder(tasks: Task[]): {
  tasksById: Record<string, Task>;
  taskIdsOrder: string[];
} {
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

/** Ensures state.async exists when tests use partial preloadedState */
function ensureAsync(state: ExecuteState): void {
  if (!state.async) {
    (state as ExecuteState).async = createInitialAsyncStates(EXECUTE_ASYNC_KEYS);
  }
}

/** Ensures tasksById and taskIdsOrder exist (handles preloadedState with old tasks array shape). */
function ensureTasksState(state: ExecuteState): void {
  if (!state.tasksById) (state as ExecuteState).tasksById = {};
  if (!state.taskIdsOrder) (state as ExecuteState).taskIdsOrder = [];
}

const executeSlice = createSlice({
  name: "execute",
  initialState: initialExecuteState,
  reducers: {
    setSelectedTaskId(state, action: PayloadAction<string | null>) {
      const next = action.payload;
      const changed = state.selectedTaskId !== next;
      state.selectedTaskId = next;
      state.completionState = null;
      state.archivedSessions = [];
      if (changed) state.async.taskDetail.error = null;
    },
    appendAgentOutput(state, action: PayloadAction<{ taskId: string; chunk: string }>) {
      const { taskId, chunk } = action.payload;
      if (chunk) {
        if (!state.agentOutput[taskId]) {
          state.agentOutput[taskId] = [];
        }
        state.agentOutput[taskId].push(chunk);
        if (state.agentOutput[taskId].length > MAX_AGENT_OUTPUT) {
          state.agentOutput[taskId] = state.agentOutput[taskId].slice(-MAX_AGENT_OUTPUT);
        }
      }
      if (taskId === state.selectedTaskId) {
        state.completionState = null;
      }
    },
    /** Replace agent output for a task (e.g. backfill on subscribe). */
    setAgentOutputBackfill(state, action: PayloadAction<{ taskId: string; output: string }>) {
      const { taskId, output } = action.payload;
      if (output.length > 0) {
        state.agentOutput[taskId] = [output];
      }
    },
    setOrchestratorRunning(state, action: PayloadAction<boolean>) {
      state.orchestratorRunning = action.payload;
    },
    setAwaitingApproval(state, action: PayloadAction<boolean>) {
      state.awaitingApproval = action.payload;
    },
    setCompletionState(
      state,
      action: PayloadAction<{
        taskId: string;
        status: string;
        testResults: { passed: number; failed: number; skipped: number; total: number } | null;
        reason?: string | null;
      }>
    ) {
      if (action.payload.taskId === state.selectedTaskId) {
        state.completionState = {
          status: action.payload.status,
          testResults: action.payload.testResults,
          reason: action.payload.reason ?? null,
        };
      }
    },
    taskUpdated(
      state,
      action: PayloadAction<{
        taskId: string;
        status?: string;
        assignee?: string | null;
        priority?: TaskPriority;
        blockReason?: string | null;
        title?: string;
        description?: string;
      }>
    ) {
      ensureTasksState(state);
      const { taskId, status, assignee, priority, blockReason, title, description } =
        action.payload;
      const task = state.tasksById[taskId];
      if (task) {
        if (status !== undefined) {
          task.kanbanColumn = mapStatusToKanban(status);
          if (status === "open" || status === "in_progress" || status === "closed") {
            task.status = status;
          }
        }
        if (assignee !== undefined) task.assignee = assignee;
        if (priority !== undefined) task.priority = priority;
        if (blockReason !== undefined) task.blockReason = blockReason;
        if (title !== undefined) task.title = title;
        if (description !== undefined) task.description = description;
      }
    },
    setTasks(state, action: PayloadAction<Task[]>) {
      const { tasksById, taskIdsOrder } = toTasksByIdAndOrder(action.payload);
      state.tasksById = tasksById;
      state.taskIdsOrder = taskIdsOrder;
    },
    setExecuteError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setActiveTasks(state, action: PayloadAction<ActiveTaskInfo[]>) {
      state.activeTasks = action.payload;
    },
    /** Sync from TanStack Query useExecuteStatus (replaces fetchExecuteStatus.fulfilled). */
    setExecuteStatusPayload(
      state,
      action: PayloadAction<{
        activeTasks?: ActiveTaskInfo[];
        queueDepth?: number;
        awaitingApproval?: boolean;
        totalDone?: number;
        totalFailed?: number;
      }>
    ) {
      const p = action.payload;
      const activeTasks = p.activeTasks ?? [];
      state.activeTasks = activeTasks;
      state.orchestratorRunning = activeTasks.length > 0 || (p.queueDepth ?? 0) > 0;
      state.awaitingApproval = p.awaitingApproval ?? false;
      state.totalDone = p.totalDone ?? 0;
      state.totalFailed = p.totalFailed ?? 0;
      state.queueDepth = p.queueDepth ?? 0;
    },
    /** Sync from TanStack Query useArchivedSessions. */
    setArchivedSessions(state, action: PayloadAction<AgentSession[]>) {
      state.archivedSessions = action.payload;
    },
    /** Sync from TanStack Query useActiveAgents (agents + taskIdToStartedAt). */
    setActiveAgentsPayload(
      state,
      action: PayloadAction<{
        agents: ActiveAgent[];
        taskIdToStartedAt: Record<string, string>;
      }>
    ) {
      state.activeAgents = action.payload.agents;
      state.activeAgentsLoadedOnce = true;
      state.taskIdToStartedAt = action.payload.taskIdToStartedAt ?? {};
    },
    resetExecute() {
      return initialExecuteState;
    },
  },
  extraReducers: (builder) => {
    // fetchTasks — custom in-flight + tasks merge logic
    builder
      .addCase(fetchTasks.pending, (state) => {
        ensureAsync(state);
        state[TASKS_IN_FLIGHT_KEY] = (state[TASKS_IN_FLIGHT_KEY] ?? 0) + 1;
        state.async.tasks.loading = true;
        state.async.tasks.error = null;
        state.error = null;
      })
      .addCase(fetchTasks.fulfilled, (state, action) => {
        ensureAsync(state);
        ensureTasksState(state);
        const incoming: Task[] = (action.payload ?? []) as Task[];

        const existingById = state.tasksById;
        const doneIds = new Set(
          Object.values(existingById)
            .filter((t) => t.kanbanColumn === "done")
            .map((t) => t.id)
        );
        const merged = incoming.map((t) => {
          if (doneIds.has(t.id) && t.kanbanColumn !== "done") {
            return { ...t, kanbanColumn: "done" as const, status: "closed" as const };
          }
          return t;
        });

        const { tasksById, taskIdsOrder } = toTasksByIdAndOrder(merged);
        state.tasksById = tasksById;
        state.taskIdsOrder = taskIdsOrder;
        state.async.tasks.loading = false;
        state[TASKS_IN_FLIGHT_KEY] = Math.max(0, (state[TASKS_IN_FLIGHT_KEY] ?? 1) - 1);
        const taskIds = new Set(taskIdsOrder);
        if (state.selectedTaskId && !taskIds.has(state.selectedTaskId)) {
          state.selectedTaskId = null;
          state.async.taskDetail.error = null;
        }
      })
      .addCase(fetchTasks.rejected, (state, action) => {
        ensureAsync(state);
        state[TASKS_IN_FLIGHT_KEY] = Math.max(0, (state[TASKS_IN_FLIGHT_KEY] ?? 1) - 1);
        if (action.payload === DEDUP_SKIP) return;
        state.async.tasks.loading = false;
        state.async.tasks.error = action.error.message ?? "Failed to load tasks";
        state.error = action.error.message ?? "Failed to load tasks";
      });

    // fetchTasksByIds — merge only fetched tasks (no loading state, minimal re-renders)
    builder.addCase(fetchTasksByIds.fulfilled, (state, action) => {
      ensureTasksState(state);
      const incoming = (action.payload ?? []) as Task[];
      if (incoming.length === 0) return;
      for (const t of incoming) {
        state.tasksById[t.id] = t;
        if (!state.taskIdsOrder.includes(t.id)) {
          state.taskIdsOrder.push(t.id);
        }
      }
    });

    createAsyncHandlers("status", fetchExecuteStatus, builder, {
      ensureState: ensureAsync,
      onPending: (state) => {
        state.error = null;
      },
      onFulfilled: (state, action) => {
        const payload = action.payload as {
          activeTasks?: ActiveTaskInfo[];
          queueDepth?: number;
          awaitingApproval?: boolean;
          totalDone?: number;
          totalFailed?: number;
        };
        const activeTasks = payload.activeTasks ?? [];
        state.activeTasks = activeTasks;
        state.orchestratorRunning = activeTasks.length > 0 || (payload.queueDepth ?? 0) > 0;
        state.awaitingApproval = payload.awaitingApproval ?? false;
        state.totalDone = payload.totalDone ?? 0;
        state.totalFailed = payload.totalFailed ?? 0;
        state.queueDepth = payload.queueDepth ?? 0;
      },
      onRejected: (state, action) => {
        state.error = action.error?.message ?? "Failed to load execute status";
      },
      defaultError: "Failed to load execute status",
    });

    // fetchTaskDetail — merge into state.tasks; only apply error when rejection was for the selected task (avoids stale "Issue X not found" from a previous request)
    builder
      .addCase(fetchTaskDetail.pending, (state) => {
        ensureAsync(state);
        state.async.taskDetail.loading = true;
        state.async.taskDetail.error = null;
      })
      .addCase(fetchTaskDetail.fulfilled, (state, action) => {
        ensureAsync(state);
        ensureTasksState(state);
        const task = action.payload as Task;
        const existed = task.id in state.tasksById;
        state.tasksById[task.id] = task;
        if (!existed && !state.taskIdsOrder.includes(task.id)) {
          state.taskIdsOrder.push(task.id);
        }
        state.async.taskDetail.loading = false;
        state.async.taskDetail.error = null;
      })
      .addCase(fetchTaskDetail.rejected, (state, action) => {
        ensureAsync(state);
        state.async.taskDetail.loading = false;
        const requestedTaskId = (action.meta?.arg as { taskId?: string } | undefined)?.taskId;
        const isForSelectedTask =
          requestedTaskId != null && state.selectedTaskId === requestedTaskId;
        if (isForSelectedTask) {
          const msg = action.error?.message ?? "";
          state.async.taskDetail.error = msg || "Failed to load task details";
          if (msg.includes("not found")) {
            state.selectedTaskId = null;
          }
        } else {
          // Stale rejection for a different task — don't show it
          state.async.taskDetail.error = null;
        }
      });

    // fetchArchivedSessions
    createAsyncHandlers("archived", fetchArchivedSessions, builder, {
      ensureState: ensureAsync,
      onFulfilled: (state, action) => {
        state.archivedSessions = action.payload as AgentSession[];
      },
      onRejected: (state) => {
        state.archivedSessions = [];
      },
    });

    // fetchLiveOutputBackfill — filter NDJSON/plain text for consistency with live/archived.
    // Always apply poll result so UI refreshes every ~1s during active agent sessions.
    builder.addCase(fetchLiveOutputBackfill.fulfilled, (state, action) => {
      const filtered = filterAgentOutput(action.payload.output ?? "");
      state.agentOutput[action.payload.taskId] = [filtered];
    });

    // fetchActiveAgents
    createAsyncHandlers("activeAgents", fetchActiveAgents, builder, {
      ensureState: ensureAsync,
      onFulfilled: (state, action) => {
        const { agents, taskIdToStartedAt } = action.payload as {
          agents: ActiveAgent[];
          taskIdToStartedAt: Record<string, string>;
        };
        state.activeAgents = agents ?? [];
        state.activeAgentsLoadedOnce = true;
        state.taskIdToStartedAt = taskIdToStartedAt ?? {};
      },
      onRejected: (state) => {
        state.activeAgents = [];
        state.activeAgentsLoadedOnce = true;
        state.taskIdToStartedAt = {};
      },
    });

    // markTaskDone
    createAsyncHandlers("markDone", markTaskDone, builder, {
      ensureState: ensureAsync,
      onPending: (state) => {
        state.error = null;
      },
      onFulfilled: (state, action) => {
        const { tasksById, taskIdsOrder } = toTasksByIdAndOrder(
          (action.payload as { tasks: Task[] }).tasks
        );
        state.tasksById = tasksById;
        state.taskIdsOrder = taskIdsOrder;
      },
      onRejected: (state, action) => {
        state.error = action.error?.message ?? "Failed to mark done";
      },
      defaultError: "Failed to mark done",
    });

    // unblockTask
    createAsyncHandlers("unblock", unblockTask, builder, {
      ensureState: ensureAsync,
      onPending: (state) => {
        state.error = null;
      },
      onFulfilled: (state, action) => {
        const { tasksById, taskIdsOrder } = toTasksByIdAndOrder(
          (action.payload as { tasks: Task[] }).tasks
        );
        state.tasksById = tasksById;
        state.taskIdsOrder = taskIdsOrder;
      },
      onRejected: (state, action) => {
        state.error = action.error?.message ?? "Failed to unblock";
      },
      defaultError: "Failed to unblock",
    });

    // updateTaskPriority — optimistic update, revert on error
    builder
      .addCase(updateTaskPriority.pending, (state, action) => {
        ensureTasksState(state);
        const { taskId, priority } = action.meta.arg;
        const p = priority as TaskPriority;
        const task = state.tasksById[taskId];
        if (task) task.priority = p;
      })
      .addCase(updateTaskPriority.fulfilled, (state, action) => {
        ensureTasksState(state);
        const { task } = action.payload;
        const t = state.tasksById[task.id];
        if (t) {
          t.priority = task.priority;
        }
      })
      .addCase(updateTaskPriority.rejected, (state, action) => {
        ensureTasksState(state);
        const payload = action.payload as { previousPriority: TaskPriority } | undefined;
        if (!payload) return;
        const { taskId } = action.meta.arg;
        const task = state.tasksById[taskId];
        if (task) task.priority = payload.previousPriority;
      });

    // addTaskDependency — refresh task in state after adding dependency
    builder.addCase(addTaskDependency.fulfilled, (state, action) => {
      ensureTasksState(state);
      const { task } = action.payload;
      state.tasksById[task.id] = task;
    });
  },
});

export const {
  setSelectedTaskId,
  appendAgentOutput,
  setAgentOutputBackfill,
  setOrchestratorRunning,
  setAwaitingApproval,
  setActiveTasks,
  setCompletionState,
  taskUpdated,
  setTasks,
  setExecuteError,
  setExecuteStatusPayload,
  setArchivedSessions,
  setActiveAgentsPayload,
  resetExecute,
} = executeSlice.actions;

/** State shape for selectors (execute may be missing in tests). */
export type ExecuteRootState = { execute?: ExecuteState };

/** Ordered tasks derived from tasksById + taskIdsOrder (no duplicates). Applies in_review from activeTasks so list API can skip getStatus. */
export const selectTasks = createSelector(
  [
    (state: ExecuteRootState) => state.execute?.tasksById ?? {},
    (state: ExecuteRootState) => state.execute?.taskIdsOrder ?? [],
    (state: ExecuteRootState) => state.execute?.activeTasks ?? [],
  ],
  (tasksById, taskIdsOrder, activeTasks): Task[] => {
    const reviewTaskIds = new Set(
      activeTasks.filter((a) => a.phase === "review").map((a) => a.taskId)
    );
    return taskIdsOrder
      .map((id) => tasksById[id])
      .filter((t): t is Task => t != null)
      .map((t) =>
        t.kanbanColumn === "in_progress" && reviewTaskIds.has(t.id)
          ? { ...t, kanbanColumn: "in_review" as const }
          : t
      );
  }
);

/** Task summaries derived from execute.tasks (single source of truth for current project). Memoized to avoid unnecessary rerenders. */
export const selectTaskSummaries = createSelector(
  [selectTasks],
  (tasks): Record<string, TaskSummary> =>
    Object.fromEntries(
      tasks.map((t) => [
        t.id,
        { title: t.title, kanbanColumn: t.kanbanColumn, priority: t.priority },
      ])
    )
);

/** Task by id. Use for granular subscription so only components using this task re-render on update. Applies in_review from activeTasks. */
export function selectTaskById(state: ExecuteRootState, taskId: string): Task | undefined {
  const task = state.execute?.tasksById?.[taskId];
  if (!task) return undefined;
  const activeTasks = state.execute?.activeTasks ?? [];
  const inReview = activeTasks.some((a) => a.taskId === taskId && a.phase === "review");
  if (task.kanbanColumn === "in_progress" && inReview) {
    return { ...task, kanbanColumn: "in_review" };
  }
  return task;
}

/** Task title by id from execute.tasks. */
export function selectTaskTitle(state: ExecuteRootState, taskId: string): string | undefined {
  return state.execute?.tasksById?.[taskId]?.title;
}

/** Task summary (title, kanbanColumn, priority) for a single task. Used by FeedbackTaskChip for isolated re-renders. */
export const selectTaskSummary = createSelector(
  [selectTasks, (_state: ExecuteRootState, taskId: string) => taskId],
  (
    tasks,
    taskId
  ): { title: string; kanbanColumn: KanbanColumn; priority: TaskPriority } | undefined => {
    const t = tasks.find((x) => x.id === taskId);
    return t ? { title: t.title, kanbanColumn: t.kanbanColumn, priority: t.priority } : undefined;
  }
);

/** Tasks for a given epic (filter by epicId only; no gate to exclude in epic-blocked model). Memoized so Plan page only re-renders when tasks for that epic change. */
export const selectTasksForEpic = createSelector(
  [selectTasks, (_state: ExecuteRootState, epicId: string | undefined) => epicId ?? ""],
  (tasks, epicId): Task[] => {
    if (!epicId) return [];
    return tasks.filter((t) => t.epicId === epicId);
  }
);

/** Selectors for async state (backward compat / convenience) */
export const selectTasksLoading = (s: ExecuteRootState) =>
  s.execute?.async?.tasks?.loading ?? false;
export const selectTaskDetailLoading = (s: ExecuteRootState) =>
  s.execute?.async?.taskDetail?.loading ?? false;
export const selectTaskDetailError = (s: ExecuteRootState) =>
  s.execute?.async?.taskDetail?.error ?? null;
export const selectArchivedLoading = (s: ExecuteRootState) =>
  s.execute?.async?.archived?.loading ?? false;
export const selectMarkDoneLoading = (s: ExecuteRootState) =>
  s.execute?.async?.markDone?.loading ?? false;
export const selectUnblockLoading = (s: ExecuteRootState) =>
  s.execute?.async?.unblock?.loading ?? false;

export default executeSlice.reducer;
