import type { Task } from "@opensprint/shared";
import type { KanbanColumn } from "@opensprint/shared";

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
  done: 6,
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
