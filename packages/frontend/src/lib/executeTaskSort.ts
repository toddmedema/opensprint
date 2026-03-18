import type { Task } from "@opensprint/shared";
import type { KanbanColumn } from "@opensprint/shared";

/** Timeline list section labels for grouping rows */
export const TIMELINE_SECTION = {
  active: "active",
  queue: "queue",
  completed: "completed",
} as const;

export type TimelineSection = (typeof TIMELINE_SECTION)[keyof typeof TIMELINE_SECTION];

/** Map kanban column to timeline section for grouping. */
export function getTimelineSection(column: KanbanColumn): TimelineSection {
  if (column === "in_progress" || column === "in_review") return TIMELINE_SECTION.active;
  if (column === "done") return TIMELINE_SECTION.completed;
  return TIMELINE_SECTION.queue; // ready, backlog, planning, blocked
}

/** Tier order for timeline sort: active (0) → queue (1) → completed (2) */
const TIMELINE_TIER: Record<KanbanColumn, number> = {
  in_progress: 0,
  in_review: 0,
  ready: 1,
  backlog: 1,
  planning: 1,
  blocked: 1,
  waiting_to_merge: 1,
  done: 2,
};

function getSortTimestamp(task: Task): string {
  return task.updatedAt || task.createdAt || "";
}

/**
 * Sort tasks for Timeline view: active → queue → completed.
 * Within each tier: updatedAt descending, fallback to createdAt descending, then id as tiebreaker.
 *
 * @param tasks - Tasks to sort (not mutated)
 * @returns New array sorted for timeline display
 */
export function sortTasksForTimeline(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const tierA = TIMELINE_TIER[a.kanbanColumn] ?? 999;
    const tierB = TIMELINE_TIER[b.kanbanColumn] ?? 999;
    if (tierA !== tierB) return tierA - tierB;

    const tsA = getSortTimestamp(a);
    const tsB = getSortTimestamp(b);
    const cmp = tsB.localeCompare(tsA); // descending: newer first
    if (cmp !== 0) return cmp;

    return a.id.localeCompare(b.id);
  });
}

/**
 * Display order for epic card task list in Execute tab.
 * In Progress → In Review → Ready → Backlog → Done.
 * Planning and blocked are grouped after backlog, before done.
 */
const STATUS_ORDER: Record<KanbanColumn, number> = {
  in_progress: 0,
  in_review: 1,
  ready: 2,
  backlog: 3,
  planning: 4,
  blocked: 5,
  waiting_to_merge: 6,
  done: 7,
};

/**
 * Sort epic subtasks by status priority for Execute tab display.
 * Groups: In Progress → In Review → Ready → Backlog → Done.
 * Within each status group: priority (0 highest) then ID as tiebreaker.
 *
 * @param tasks - Tasks to sort (not mutated)
 * @returns New array sorted by status order, then priority, then id
 */
export function sortEpicTasksByStatus(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const orderA = STATUS_ORDER[a.kanbanColumn] ?? 999;
    const orderB = STATUS_ORDER[b.kanbanColumn] ?? 999;
    if (orderA !== orderB) return orderA - orderB;

    // Same status: priority (0 = highest)
    const priA = a.priority ?? 999;
    const priB = b.priority ?? 999;
    if (priA !== priB) return priA - priB;

    // Tiebreaker: ID
    return a.id.localeCompare(b.id);
  });
}
