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
  tasks: Task[];
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
  tasks: [],
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

export const fetchTasks = createAsyncThunk<Task[], string>(
  "execute/fetchTasks",
  async (projectId: string, { getState, rejectWithValue }) => {
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
    return { tasks: tasksData ?? [] };
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
    return { tasks: tasksData ?? [], taskId };
  }
);

const MAX_AGENT_OUTPUT = 5000;

/** Ensures state.async exists when tests use partial preloadedState */
function ensureAsync(state: ExecuteState): void {
  if (!state.async) {
    (state as ExecuteState).async = createInitialAsyncStates(EXECUTE_ASYNC_KEYS);
  }
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
      }>
    ) {
      const { taskId, status, assignee, priority, blockReason } = action.payload;
      const task = state.tasks.find((t) => t.id === taskId);
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
      }
    },
    setTasks(state, action: PayloadAction<Task[]>) {
      state.tasks = action.payload;
    },
    setExecuteError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setActiveTasks(state, action: PayloadAction<ActiveTaskInfo[]>) {
      state.activeTasks = action.payload;
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
        const incoming = (action.payload ?? []) as Task[];
        const doneIds = new Set(
          state.tasks.filter((t) => t.kanbanColumn === "done").map((t) => t.id)
        );
        state.tasks = incoming.map((t) => {
          if (doneIds.has(t.id) && t.kanbanColumn !== "done") {
            return { ...t, kanbanColumn: "done" as const, status: "closed" as const };
          }
          return t;
        });
        state.async.tasks.loading = false;
        state[TASKS_IN_FLIGHT_KEY] = Math.max(0, (state[TASKS_IN_FLIGHT_KEY] ?? 1) - 1);
        const taskIds = new Set((action.payload ?? []).map((t: Task) => t.id));
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
      const incoming = (action.payload ?? []) as Task[];
      if (incoming.length === 0) return;
      const byId = new Map(state.tasks.map((t) => [t.id, t]));
      for (const t of incoming) {
        byId.set(t.id, t);
      }
      state.tasks = Array.from(byId.values());
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
        const task = action.payload as Task;
        const idx = state.tasks.findIndex((t) => t.id === task.id);
        if (idx >= 0) {
          state.tasks[idx] = task;
        } else {
          state.tasks.push(task);
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
        state.tasks = (action.payload as { tasks: Task[] }).tasks;
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
        state.tasks = (action.payload as { tasks: Task[] }).tasks;
      },
      onRejected: (state, action) => {
        state.error = action.error?.message ?? "Failed to unblock";
      },
      defaultError: "Failed to unblock",
    });

    // updateTaskPriority — optimistic update, revert on error
    builder
      .addCase(updateTaskPriority.pending, (state, action) => {
        const { taskId, priority } = action.meta.arg;
        const p = priority as TaskPriority;
        const task = state.tasks.find((t) => t.id === taskId);
        if (task) task.priority = p;
      })
      .addCase(updateTaskPriority.fulfilled, (state, action) => {
        const { task } = action.payload;
        const t = state.tasks.find((x) => x.id === task.id);
        if (t) {
          t.priority = task.priority;
        }
      })
      .addCase(updateTaskPriority.rejected, (state, action) => {
        const payload = action.payload as { previousPriority: TaskPriority } | undefined;
        if (!payload) return;
        const { taskId } = action.meta.arg;
        const task = state.tasks.find((t) => t.id === taskId);
        if (task) task.priority = payload.previousPriority;
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
  resetExecute,
} = executeSlice.actions;

/** State shape for selectors (execute may be missing in tests). */
export type ExecuteRootState = { execute?: ExecuteState };

const selectTasks = (state: ExecuteRootState): Task[] => state.execute?.tasks ?? [];

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

/** Task title by id from execute.tasks. */
export function selectTaskTitle(state: ExecuteRootState, taskId: string): string | undefined {
  return state.execute?.tasks?.find((t) => t.id === taskId)?.title;
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
