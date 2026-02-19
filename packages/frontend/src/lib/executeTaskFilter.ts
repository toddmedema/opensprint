import type { Task } from "@opensprint/shared";

export type StatusFilter =
  | "all"
  | "ready"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked";

export function matchesStatusFilter(kanbanColumn: string, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "blocked") return ["planning", "backlog", "blocked"].includes(kanbanColumn);
  return kanbanColumn === filter;
}

/**
 * Returns true if the task matches the search query (case-insensitive).
 * Matches against both title and description.
 */
export function matchesSearchQuery(task: Pick<Task, "title" | "description">, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const title = (task.title ?? "").toLowerCase();
  const desc = (task.description ?? "").toLowerCase();
  return title.includes(q) || desc.includes(q);
}

/**
 * Filters tasks by status filter and search query (AND logic).
 * Both filters must match for a task to be included.
 */
export function filterTasksByStatusAndSearch(
  tasks: Task[],
  statusFilter: StatusFilter,
  searchQuery: string
): Task[] {
  const q = searchQuery.trim().toLowerCase();
  return tasks.filter((t) => {
    if (!matchesStatusFilter(t.kanbanColumn, statusFilter)) return false;
    if (!q) return true;
    return matchesSearchQuery(t, searchQuery);
  });
}
