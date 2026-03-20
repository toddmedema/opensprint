import { createAsyncThunk } from "@reduxjs/toolkit";
import type {
  Task,
  TaskPriority,
  TaskType,
  KanbanColumn,
  MergeGateState,
} from "@opensprint/shared";
import { mapStatusToKanban } from "@opensprint/shared";

const VALID_KANBAN_COLUMNS: readonly KanbanColumn[] = [
  "planning",
  "backlog",
  "ready",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "waiting_to_merge",
];

function isValidKanbanColumn(v: unknown): v is KanbanColumn {
  return typeof v === "string" && (VALID_KANBAN_COLUMNS as readonly string[]).includes(v);
}
import type { TaskEventPayload } from "@opensprint/shared";
import { api } from "../../api/client";
import { normalizeTaskListResponse } from "../../api/taskList";
import { DEDUP_SKIP } from "../dedup";
import { setPlansAndGraph } from "./planSlice";
import { isApiError, isConnectionError } from "../../api/client";
import { setDeliverToast } from "./websocketSlice";
import { type ExecuteState, TASKS_IN_FLIGHT_KEY, EXECUTE_ASYNC_KEYS } from "./executeTypes";
import { createInitialAsyncStates } from "../asyncHelpers";

export type FetchTasksArg = string;

export const fetchTasks = createAsyncThunk<Task[], FetchTasksArg>(
  "execute/fetchTasks",
  async (projectId, { getState, rejectWithValue }) => {
    const root = getState() as { execute: ExecuteState };
    const inFlight = root.execute[TASKS_IN_FLIGHT_KEY] ?? 0;
    if (inFlight > 1) {
      return rejectWithValue(DEDUP_SKIP);
    }
    return normalizeTaskListResponse(await api.tasks.list(projectId));
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
        const key = a.taskId ?? a.id;
        const existing = map[key];
        if (!existing || a.startedAt < existing) {
          map[key] = a.startedAt;
        }
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
    const tasks = normalizeTaskListResponse(tasksData);
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

export const updateTaskAssignee = createAsyncThunk(
  "execute/updateTaskAssignee",
  async (
    { projectId, taskId, assignee }: { projectId: string; taskId: string; assignee: string | null },
    { dispatch, rejectWithValue }
  ) => {
    try {
      const task = await api.tasks.updateTask(projectId, taskId, { assignee });
      return { task, taskId };
    } catch (err) {
      if (isApiError(err) && err.code === "ASSIGNEE_LOCKED") {
        return rejectWithValue({ message: err.message, code: err.code });
      }
      if (!isConnectionError(err)) {
        dispatch(setDeliverToast({ message: "Failed to update assignee", variant: "failed" }));
      }
      return rejectWithValue(err instanceof Error ? err.message : "Failed to update assignee");
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
    { dispatch: _dispatch }
  ) => {
    await api.tasks.addDependency(projectId, taskId, parentTaskId, type);
    const task = await api.tasks.get(projectId, taskId);
    return { task, taskId };
  }
);

export const removeTaskDependency = createAsyncThunk(
  "execute/removeTaskDependency",
  async (
    {
      projectId,
      taskId,
      parentTaskId,
    }: { projectId: string; taskId: string; parentTaskId: string },
    { dispatch: _dispatch }
  ) => {
    await api.tasks.removeDependency(projectId, taskId, parentTaskId);
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
    const tasks = normalizeTaskListResponse(tasksData);
    return { tasks, taskId };
  }
);

/** Convert TaskEventPayload (WebSocket) to Task shape for Redux. */
export function taskEventPayloadToTask(p: TaskEventPayload): Task {
  const issueType = (p.issue_type ?? "task") as TaskType;
  const isEpic = issueType === "epic";
  const kanbanColumn = isValidKanbanColumn(p.kanbanColumn)
    ? p.kanbanColumn
    : mapStatusToKanban(p.status);
  const task: Task = {
    id: p.id,
    title: p.title,
    description: p.description ?? "",
    type: issueType,
    status: p.status as Task["status"],
    priority: (p.priority ?? 2) as TaskPriority,
    assignee: p.assignee ?? null,
    labels: p.labels ?? [],
    dependencies: [],
    epicId: isEpic ? null : (p.parentId ?? null),
    kanbanColumn,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    startedAt: null,
    completedAt: p.status === "closed" ? p.updated_at : null,
    ...("source" in p && p.source ? { source: p.source } : {}),
  };
  if ("mergePausedUntil" in p) task.mergePausedUntil = p.mergePausedUntil ?? null;
  if ("mergeWaitingOnMain" in p) task.mergeWaitingOnMain = p.mergeWaitingOnMain;
  if ("mergeGateState" in p) {
    if (p.mergeGateState == null) {
      delete task.mergeGateState;
    } else {
      task.mergeGateState = p.mergeGateState as MergeGateState;
    }
  }
  return task;
}

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
export function ensureAsync(state: ExecuteState): void {
  if (!state.async) {
    (state as ExecuteState).async = createInitialAsyncStates(EXECUTE_ASYNC_KEYS);
  }
}

/** Ensures tasksById and taskIdsOrder exist (handles preloadedState with old tasks array shape). */
export function ensureTasksState(state: ExecuteState): void {
  if (!state.tasksById) (state as ExecuteState).tasksById = {};
  if (!state.taskIdsOrder) (state as ExecuteState).taskIdsOrder = [];
}
