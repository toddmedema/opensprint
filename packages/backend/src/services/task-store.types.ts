import type { TaskType, TaskPriority } from "@opensprint/shared";

export interface StoredTask {
  id: string;
  project_id?: string;
  title: string;
  description?: string;
  issue_type: string;
  status: string;
  priority: number;
  assignee?: string | null;
  owner?: string | null;
  labels?: string[];
  created_at: string;
  updated_at: string;
  created_by?: string;
  close_reason?: string;
  /** Set when first Coder agent picks up task (assignee set). */
  started_at?: string | null;
  /** Set when task is closed. */
  completed_at?: string | null;
  dependencies?: Array<{
    depends_on_id: string;
    type: string;
  }>;
  dependency_count?: number;
  dependent_count?: number;
  /** Reason task was blocked (e.g. Coding Failure, Merge Failure, Quality Gate Failure). Stored in extra when status is blocked. */
  block_reason?: string | null;
  /** ISO timestamp of last auto-retry (technical-error unblock). Stored in extra. */
  last_auto_retry_at?: string | null;
  [key: string]: unknown;
}

export interface CreateOpts {
  type?: TaskType | string;
  priority?: TaskPriority | number;
  description?: string;
  parentId?: string;
  /** Task-level complexity (1-10). Persisted in complexity column. */
  complexity?: number;
  /** Merge into extra JSON (e.g. sourceFeedbackIds) */
  extra?: Record<string, unknown>;
}

export interface CreateInput {
  title: string;
  type?: TaskType | string;
  priority?: TaskPriority | number;
  description?: string;
  parentId?: string;
  /** Task-level complexity (1-10). Persisted in complexity column. */
  complexity?: number;
  /** Merge into extra JSON (e.g. sourcePlanVersionNumber for plan-version-aware tasks). */
  extra?: Record<string, unknown>;
}

/** Callback invoked when a task is created, updated, or closed. Used to emit WebSocket events. */
export type TaskChangeCallback = (
  projectId: string,
  changeType: "create" | "update" | "close",
  task: StoredTask
) => void;
