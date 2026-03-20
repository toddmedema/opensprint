import type { PayloadAction } from "@reduxjs/toolkit";
import type { ActionReducerMapBuilder } from "@reduxjs/toolkit";
import type { Task, TaskPriority, KanbanColumn, MergeGateState } from "@opensprint/shared";
import { mapStatusToKanban } from "@opensprint/shared";
import type { TaskEventPayload } from "@opensprint/shared";
import type { ExecuteState } from "./executeTypes";
import { TASKS_IN_FLIGHT_KEY } from "./executeTypes";
import {
  fetchTasks,
  fetchTasksByIds,
  fetchTaskDetail,
  markTaskDone,
  unblockTask,
  updateTaskPriority,
  updateTaskAssignee,
  addTaskDependency,
  removeTaskDependency,
  toTasksByIdAndOrder,
  taskEventPayloadToTask,
  ensureAsync,
  ensureTasksState,
} from "./executeThunks";
import { createAsyncHandlers } from "../asyncHelpers";
import { DEDUP_SKIP } from "../dedup";

export const taskListReducers = {
  taskUpdated(
    state: ExecuteState,
    action: PayloadAction<{
      taskId: string;
      status?: string;
      assignee?: string | null;
      priority?: TaskPriority;
      blockReason?: string | null;
      title?: string;
      description?: string;
      kanbanColumn?: KanbanColumn;
      mergePausedUntil?: string | null;
      mergeWaitingOnMain?: boolean;
      mergeGateState?: MergeGateState | null;
    }>
  ) {
    ensureTasksState(state);
    const {
      taskId,
      status,
      assignee,
      priority,
      blockReason,
      title,
      description,
      kanbanColumn,
      mergePausedUntil,
      mergeWaitingOnMain,
      mergeGateState,
    } = action.payload;
    const task = state.tasksById[taskId];
    if (task) {
      if (status !== undefined) {
        if (kanbanColumn !== undefined) {
          task.kanbanColumn = kanbanColumn;
        } else {
          task.kanbanColumn = mapStatusToKanban(status);
        }
        if (status === "open" || status === "in_progress" || status === "closed") {
          task.status = status;
        }
      } else if (kanbanColumn !== undefined) {
        task.kanbanColumn = kanbanColumn;
      }
      if (assignee !== undefined) task.assignee = assignee;
      if (priority !== undefined) task.priority = priority;
      if (blockReason !== undefined) task.blockReason = blockReason;
      if (title !== undefined) task.title = title;
      if (description !== undefined) task.description = description;
      if (mergePausedUntil !== undefined) task.mergePausedUntil = mergePausedUntil;
      if (mergeWaitingOnMain !== undefined) task.mergeWaitingOnMain = mergeWaitingOnMain;
      if (mergeGateState !== undefined) {
        if (mergeGateState === null) {
          delete task.mergeGateState;
        } else {
          task.mergeGateState = mergeGateState;
        }
      }
    }
  },
  /** Live-update: add task from WebSocket task.created event. */
  taskCreated(state: ExecuteState, action: PayloadAction<TaskEventPayload>) {
    ensureTasksState(state);
    const task = taskEventPayloadToTask(action.payload);
    if (task.id in state.tasksById) return;
    state.tasksById[task.id] = task;
    state.taskIdsOrder.push(task.id);
  },
  /** Live-update: merge task from WebSocket task.closed event. */
  taskClosed(state: ExecuteState, action: PayloadAction<TaskEventPayload>) {
    ensureTasksState(state);
    const task = taskEventPayloadToTask(action.payload);
    if (task.id in state.tasksById) {
      state.tasksById[task.id] = { ...state.tasksById[task.id], ...task };
    } else {
      state.tasksById[task.id] = task;
      state.taskIdsOrder.push(task.id);
    }
  },
  setTasks(state: ExecuteState, action: PayloadAction<Task[]>) {
    const { tasksById, taskIdsOrder } = toTasksByIdAndOrder(action.payload);
    state.tasksById = tasksById;
    state.taskIdsOrder = taskIdsOrder;
  },
};

export function addTaskListExtraReducers(builder: ActionReducerMapBuilder<ExecuteState>): void {
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
      const isForSelectedTask = requestedTaskId != null && state.selectedTaskId === requestedTaskId;
      if (isForSelectedTask) {
        const msg = action.error?.message ?? "";
        state.async.taskDetail.error = msg || "Failed to load task details";
        if (msg.includes("not found")) {
          state.selectedTaskId = null;
        }
      } else {
        state.async.taskDetail.error = null;
      }
    });

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
      state.error = action.error?.message ?? "Failed to retry";
    },
    defaultError: "Failed to retry",
  });

  builder
    .addCase(updateTaskPriority.pending, (state, action) => {
      ensureTasksState(state);
      const { taskId, priority } = action.meta.arg;
      const p = priority as TaskPriority;
      const task = state.tasksById[taskId];
      if (task) task.priority = p;
      state.priorityUpdatePendingTaskId = taskId;
    })
    .addCase(updateTaskPriority.fulfilled, (state, action) => {
      ensureTasksState(state);
      const { task } = action.payload;
      const t = state.tasksById[task.id];
      if (t) {
        t.priority = task.priority;
      }
      state.priorityUpdatePendingTaskId = null;
    })
    .addCase(updateTaskPriority.rejected, (state, action) => {
      ensureTasksState(state);
      const payload = action.payload as { previousPriority: TaskPriority } | undefined;
      if (!payload) return;
      const { taskId } = action.meta.arg;
      const task = state.tasksById[taskId];
      if (task) task.priority = payload.previousPriority;
      state.priorityUpdatePendingTaskId = null;
    });

  builder.addCase(updateTaskAssignee.fulfilled, (state, action) => {
    ensureTasksState(state);
    const { task } = action.payload;
    const t = state.tasksById[task.id];
    if (t) {
      t.assignee = task.assignee;
    }
    state.tasksById[task.id] = task;
    if (!state.taskIdsOrder.includes(task.id)) {
      state.taskIdsOrder.push(task.id);
    }
  });

  builder.addCase(addTaskDependency.fulfilled, (state, action) => {
    ensureTasksState(state);
    const { task } = action.payload;
    state.tasksById[task.id] = task;
  });

  builder.addCase(removeTaskDependency.fulfilled, (state, action) => {
    ensureTasksState(state);
    const { task } = action.payload;
    state.tasksById[task.id] = task;
  });
}
