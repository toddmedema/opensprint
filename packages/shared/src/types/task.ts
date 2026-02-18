/** Beads issue types */
export type TaskType = "bug" | "feature" | "task" | "epic" | "chore";

/** Beads status values */
export type BeadsStatus = "open" | "in_progress" | "closed";

/** Display status on the kanban board */
export type KanbanColumn = "planning" | "backlog" | "ready" | "in_progress" | "in_review" | "done" | "blocked";

/** Beads priority (0 = highest, 4 = lowest) */
export type TaskPriority = 0 | 1 | 2 | 3 | 4;

/** Task entity — maps to a beads issue */
export interface Task {
  id: string;
  title: string;
  description: string;
  type: TaskType;
  status: BeadsStatus;
  priority: TaskPriority;
  assignee: string | null;
  labels: string[];
  dependencies: TaskDependency[];
  epicId: string | null;
  /** Computed kanban column based on beads state + orchestrator phase */
  kanbanColumn: KanbanColumn;
  createdAt: string;
  updatedAt: string;
  /** Latest test results from agent sessions (PRD §8.3) */
  testResults?: { passed: number; failed: number; skipped: number; total: number } | null;
  /** Feedback item ID when task originates from Eval feedback (discovered-from provenance) */
  sourceFeedbackId?: string;
}

/** Dependency relationship between tasks */
export interface TaskDependency {
  targetId: string;
  type: "blocks" | "related" | "parent-child" | "discovered-from";
}
