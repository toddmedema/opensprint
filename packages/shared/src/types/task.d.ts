import type {
  QualityGateDiagnosticDetail,
  TaskLastExecutionSummary,
} from "./execute-diagnostics.js";
/** Task issue types */
export type TaskType = "bug" | "feature" | "task" | "epic" | "chore";
/** Task status values. Epics: blocked = plan not approved; open = approved; closed = complete. */
export type TaskStatus = "open" | "in_progress" | "closed" | "blocked";
/** Display status on the kanban board. List/detail kanbanColumn is server-computed for waiting_to_merge; mapStatusToKanban does not need to handle it. */
export type KanbanColumn =
  | "planning"
  | "backlog"
  | "ready"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked"
  | "waiting_to_merge";
export type MergeGateState =
  | "validating"
  | "blocked_on_baseline"
  | "candidate_fix_needed"
  | "environment_repair_needed"
  | "merging";
/** Task priority (0 = highest, 4 = lowest) */
export type TaskPriority = 0 | 1 | 2 | 3 | 4;
/** Task-level complexity (integer 1-10). 1=simplest, 10=most complex. Used for agent selection. */
export type TaskComplexity = number;
/** Valid range for task complexity */
export declare const TASK_COMPLEXITY_MIN = 1;
export declare const TASK_COMPLEXITY_MAX = 10;
/** Clamp and validate complexity to 1-10. Returns undefined if invalid. */
export declare function clampTaskComplexity(value: unknown): number | undefined;
/** Map integer complexity (1-10) to display label. 5 or less = Simple, 6+ = Complex. */
export declare function complexityToDisplay(
  complexity: number | undefined
): "Simple" | "Complex" | null;
/** Minimal task fields stored in the global task registry (cross-phase cache). */
export interface TaskSummary {
  title: string;
  kanbanColumn: KanbanColumn;
  priority: TaskPriority;
}
/** Map task status string to kanban column. Shared so execute and taskRegistry stay in sync. */
export declare function mapStatusToKanban(status: string): KanbanColumn;
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
  testResults?: {
    passed: number;
    failed: number;
    skipped: number;
    total: number;
  } | null;
  /** Feedback item ID when task originates from Evaluate feedback (discovered-from provenance) */
  /** @deprecated Use sourceFeedbackIds instead */
  sourceFeedbackId?: string;
  /** Feedback item IDs linked to this task (from discovered-from dependencies). Use this for multiple feedback. */
  sourceFeedbackIds?: string[];
  /** Task-level complexity (1-10). When absent, inferred from epic's plan. */
  complexity?: TaskComplexity;
  /** Reason task was blocked (e.g. Coding Failure, Merge Failure, Quality Gate Failure). */
  blockReason?: string | null;
  /** Lightweight execution summary for list/detail surfaces. Derived from tasks.extra.last_execution_summary. */
  lastExecutionSummary?: string | null;
  /** Failure type from the latest execution summary. */
  lastFailureType?: string | null;
  /** Timestamp of the latest execution summary. */
  lastExecutionAt?: string | null;
  /** Structured latest execution summary. */
  lastExecution?: TaskLastExecutionSummary | null;
  /** Task source (e.g. 'self-improvement' for tasks created by self-improvement runs). */
  source?: string;
  /** When merge is paused due to baseline quality gates on main (API only; ISO timestamp). Used for tooltip/secondary hint. */
  mergePausedUntil?: string | null;
  /** True when merge is waiting on main (API only). Used for tooltip/secondary hint. */
  mergeWaitingOnMain?: boolean;
  /** Server-derived merge gate state for waiting_to_merge tasks. */
  mergeGateState?: MergeGateState;
  /** Latest quality-gate failure detail from task extra (SPEC §API Contracts). Present when task failed/blocked with quality-gate diagnostics. */
  qualityGateDetail?: QualityGateDiagnosticDetail | null;
  /** Flat quality-gate fields from task extra (same values as qualityGateDetail when present). */
  failedGateCommand?: string | null;
  failedGateReason?: string | null;
  failedGateOutputSnippet?: string | null;
  worktreePath?: string | null;
}
/** Dependency relationship between tasks */
export interface TaskDependency {
  targetId: string;
  type: "blocks" | "related" | "parent-child" | "discovered-from";
}
//# sourceMappingURL=task.d.ts.map
