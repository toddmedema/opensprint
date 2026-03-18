/** Valid range for task complexity */
export const TASK_COMPLEXITY_MIN = 1;
export const TASK_COMPLEXITY_MAX = 10;
/** Clamp and validate complexity to 1-10. Returns undefined if invalid. */
export function clampTaskComplexity(value) {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  if (value < TASK_COMPLEXITY_MIN || value > TASK_COMPLEXITY_MAX) return undefined;
  return value;
}
/** Map integer complexity (1-10) to display label. 5 or less = Simple, 6+ = Complex. */
export function complexityToDisplay(complexity) {
  if (complexity == null || typeof complexity !== "number") return null;
  if (complexity >= 1 && complexity <= 10) return complexity <= 5 ? "Simple" : "Complex";
  return null;
}
/** Map task status string to kanban column. Shared so execute and taskRegistry stay in sync. */
export function mapStatusToKanban(status) {
  switch (status) {
    case "open":
      return "backlog";
    case "in_progress":
      return "in_progress";
    case "closed":
      return "done";
    case "blocked":
      return "blocked";
    default:
      return "backlog";
  }
}
//# sourceMappingURL=task.js.map
