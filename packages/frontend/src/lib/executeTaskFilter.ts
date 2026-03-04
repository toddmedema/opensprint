import type { Task } from "@opensprint/shared";
import type { Plan } from "@opensprint/shared";

export type StatusFilter =
  | "all"
  | "planning"
  | "in_line"
  | "ready"
  | "in_progress"
  | "done"
  | "blocked";

/** Blocked-on-human = task status blocked (kanbanColumn "blocked"); excludes planning/backlog. */
export function matchesStatusFilter(kanbanColumn: string, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "planning") return false; // planning filter uses parent plan status, not kanbanColumn
  if (filter === "blocked") return kanbanColumn === "blocked";
  if (filter === "in_line") return kanbanColumn === "backlog" || kanbanColumn === "planning";
  if (filter === "in_progress") return kanbanColumn === "in_progress" || kanbanColumn === "in_review";
  return kanbanColumn === filter;
}

/** Returns true if the task's parent plan has status "planning" (not yet executed). */
export function isTaskInPlanningPlan(task: Task, plans: Plan[]): boolean {
  if (!task.epicId) return false;
  const plan = plans.find((p) => p.metadata.epicId === task.epicId);
  return plan?.status === "planning";
}

/**
 * Returns true if the task matches the search query (case-insensitive).
 * Matches against both title and description.
 */
export function matchesSearchQuery(
  task: Pick<Task, "title" | "description">,
  query: string
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const title = (task.title ?? "").toLowerCase();
  const desc = (task.description ?? "").toLowerCase();
  return title.includes(q) || desc.includes(q);
}

/**
 * Filters tasks by status filter and search query (AND logic).
 * Both filters must match for a task to be included.
 * For "planning" filter, plans must be provided to determine parent plan status.
 */
export function filterTasksByStatusAndSearch(
  tasks: Task[],
  statusFilter: StatusFilter,
  searchQuery: string,
  plans?: Plan[]
): Task[] {
  const q = searchQuery.trim().toLowerCase();
  return tasks.filter((t) => {
    if (statusFilter === "planning") {
      if (!plans || !isTaskInPlanningPlan(t, plans)) return false;
    } else if (statusFilter === "in_line") {
      if (!matchesStatusFilter(t.kanbanColumn, statusFilter)) return false;
      if (plans && isTaskInPlanningPlan(t, plans)) return false;
    } else if (!matchesStatusFilter(t.kanbanColumn, statusFilter)) {
      return false;
    }
    if (!q) return true;
    return matchesSearchQuery(t, searchQuery);
  });
}
