import { createSelector } from "@reduxjs/toolkit";
import type { Task, TaskSummary, KanbanColumn, TaskPriority } from "@opensprint/shared";
import type { ExecuteRootState } from "./executeTypes";

const EMPTY_AGENT_OUTPUT: string[] = [];
const EMPTY_FEEDBACK_TASK_SUMMARIES: Array<{
  id: string;
  kanbanColumn: Task["kanbanColumn"];
}> = [];

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

export const selectSelectedTaskOutput = createSelector(
  [
    (state: ExecuteRootState) => state.execute?.agentOutput ?? {},
    (_state: ExecuteRootState, taskId: string | null | undefined) => taskId ?? null,
  ],
  (agentOutput, taskId): string[] => {
    if (!taskId) return EMPTY_AGENT_OUTPUT;
    return agentOutput[taskId] ?? EMPTY_AGENT_OUTPUT;
  }
);

export const selectCompletionState = createSelector(
  [
    (state: ExecuteRootState) => state.execute?.completionStateByTaskId ?? {},
    (_state: ExecuteRootState, taskId: string | null | undefined) => taskId ?? null,
  ],
  (completionStateByTaskId, taskId) => {
    if (!taskId) return null;
    return completionStateByTaskId[taskId] ?? null;
  }
);

export const selectTaskSummariesForFeedback = createSelector([selectTasks], (tasks) => {
  if (tasks.length === 0) return EMPTY_FEEDBACK_TASK_SUMMARIES;
  return tasks.map((task) => ({ id: task.id, kanbanColumn: task.kanbanColumn }));
});

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
export const selectPriorityUpdatePendingTaskId = (s: ExecuteRootState) =>
  s.execute?.priorityUpdatePendingTaskId ?? null;
