/** Task issue types */
export type TaskType = "bug" | "feature" | "task" | "epic" | "chore";

/** Task status values */
export type TaskStatus = "open" | "in_progress" | "closed";

/** Display status on the kanban board */
export type KanbanColumn =
  | "planning"
  | "backlog"
  | "ready"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked";

/** Task priority (0 = highest, 4 = lowest) */
export type TaskPriority = 0 | 1 | 2 | 3 | 4;

/** Task-level complexity (simple|complex). Simpler than plan complexity; used for agent selection. */
export type TaskComplexity = "simple" | "complex";

/** Minimal task fields stored in the global task registry (cross-phase cache). */
export interface TaskSummary {
  title: string;
  kanbanColumn: KanbanColumn;
  priority: TaskPriority;
}

/** Map task status string to kanban column. Shared so execute and taskRegistry stay in sync. */
export function mapStatusToKanban(status: string): KanbanColumn {
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

/** Task entity */
export interface Task {
  id: string;
  title: string;
  description: string;
  type: TaskType;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: string | null;
  labels: string[];
  dependencies: TaskDependency[];
  epicId: string | null;
  /** Computed kanban column based on task state + orchestrator phase */
  kanbanColumn: KanbanColumn;
  createdAt: string;
  updatedAt: string;
  /** Set when first Coder agent picks up task (assignee set). Duration = completedAt - startedAt. */
  startedAt?: string | null;
  /** Set when task is closed. */
  completedAt?: string | null;
  /** Latest test results from agent sessions (PRD §8.3) */
  testResults?: { passed: number; failed: number; skipped: number; total: number } | null;
  /** Feedback item ID when task originates from Evaluate feedback (discovered-from provenance) */
  /** @deprecated Use sourceFeedbackIds instead */
  sourceFeedbackId?: string;
  /** Feedback item IDs linked to this task (from discovered-from dependencies). Use this for multiple feedback. */
  sourceFeedbackIds?: string[];
  /** Task-level complexity (simple|complex). When absent, inferred from epic's plan. */
  complexity?: TaskComplexity;
  /** Reason task was blocked (e.g. Coding Failure, Merge Failure). Set when status becomes blocked. */
  blockReason?: string | null;
}

/** Dependency relationship between tasks */
export interface TaskDependency {
  targetId: string;
  type: "blocks" | "related" | "parent-child" | "discovered-from";
}
