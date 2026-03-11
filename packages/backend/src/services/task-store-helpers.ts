import { clampTaskComplexity } from "@opensprint/shared";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { getErrorMessage } from "../utils/error-utils.js";
import type { StoredTask } from "./task-store.types.js";

// ──── Hydration ────

/**
 * Build a StoredTask from a DB row and optional dependency maps.
 * Used by the task store when hydrating single or batch task results.
 */
export function hydrateTask(
  row: Record<string, unknown>,
  depsByTaskId?: Map<string, Array<{ depends_on_id: string; type: string }>>,
  dependentCountByTaskId?: Map<string, number>
): StoredTask {
  const labels: string[] = JSON.parse((row.labels as string) || "[]");
  const extra: Record<string, unknown> = JSON.parse((row.extra as string) || "{}");

  let deps: Array<{ depends_on_id: string; type: string }>;
  let dependentCount: number;

  if (depsByTaskId != null && dependentCountByTaskId != null) {
    deps = depsByTaskId.get(row.id as string) ?? [];
    dependentCount = dependentCountByTaskId.get(row.id as string) ?? 0;
  } else {
    deps = [];
    dependentCount = 0;
  }

  const blockReason = (extra.block_reason as string) ?? null;
  const lastAutoRetryAt = (extra.last_auto_retry_at as string) ?? null;
  const complexity = clampTaskComplexity(row.complexity);
  return {
    ...extra,
    ...(complexity != null && { complexity }),
    block_reason: blockReason,
    last_auto_retry_at: lastAutoRetryAt,
    id: row.id as string,
    project_id: row.project_id as string | undefined,
    title: row.title as string,
    description: (row.description as string) ?? undefined,
    issue_type: row.issue_type as string,
    status: row.status as string,
    priority: row.priority as number,
    assignee: (row.assignee as string) ?? null,
    owner: (row.owner as string) ?? null,
    labels,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    created_by: (row.created_by as string) ?? undefined,
    close_reason: (row.close_reason as string) ?? undefined,
    started_at: (row.started_at as string) ?? null,
    completed_at: (row.completed_at as string) ?? null,
    dependencies: deps,
    dependency_count: deps.length,
    dependent_count: dependentCount,
  };
}

// ──── Validation & update building ────

/** Throws if assignee change is not allowed (task in progress and not reopening). */
export function validateAssigneeChange(
  currentStatus: string | undefined,
  options: { status?: string; assignee?: string; claim?: boolean },
  issueId: string
): void {
  const claimLikeTransition =
    options.status === "in_progress" && options.assignee !== undefined;
  if (options.claim || claimLikeTransition || options.assignee === undefined) return;
  const reopening = options.status === "open";
  const assigneeCleared = options.assignee == null || options.assignee.trim() === "";
  const transitioningOutOfInProgress =
    options.status !== undefined && options.status !== "in_progress";
  const releasingAssignment = transitioningOutOfInProgress && assigneeCleared;
  if (currentStatus === "in_progress" && !reopening && !releasingAssignment) {
    throw new AppError(
      400,
      ErrorCodes.ASSIGNEE_LOCKED,
      "Cannot change assignee while task is in progress",
      { issueId }
    );
  }
}

/** Merge options.extra, block_reason, last_auto_retry_at into existing extra JSON. */
export function mergeExtraForUpdate(
  existing: Record<string, unknown>,
  options: {
    extra?: Record<string, unknown>;
    block_reason?: string | null;
    last_auto_retry_at?: string | null;
  }
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing, ...options.extra };
  if (options.block_reason !== undefined) {
    if (options.block_reason == null || options.block_reason === "") {
      delete merged.block_reason;
    } else {
      merged.block_reason = options.block_reason;
    }
  }
  if (options.last_auto_retry_at !== undefined) {
    if (options.last_auto_retry_at == null || options.last_auto_retry_at === "") {
      delete merged.last_auto_retry_at;
    } else {
      merged.last_auto_retry_at = options.last_auto_retry_at;
    }
  }
  return merged;
}

/** Build SET clause and values for a single-task update. Returns nextIdx for WHERE id = $nextIdx AND project_id = $(nextIdx+1). */
export function buildTaskUpdateSets(
  options: {
    title?: string;
    status?: string;
    assignee?: string;
    description?: string;
    priority?: number;
    claim?: boolean;
    complexity?: number | null;
    extra?: Record<string, unknown>;
    block_reason?: string | null;
    last_auto_retry_at?: string | null;
  },
  now: string,
  row: { status?: string; started_at?: string | null; extra?: string } | null,
  mergedExtra: Record<string, unknown> | undefined
): { sets: string[]; vals: unknown[]; nextIdx: number } {
  const sets: string[] = ["updated_at = $1"];
  const vals: unknown[] = [now];
  let idx = 2;

  if (options.title != null) {
    sets.push(`title = $${idx++}`);
    vals.push(options.title);
  }
  if (options.claim) {
    sets.push(`status = $${idx++}`);
    vals.push("in_progress");
    if (options.assignee != null) {
      sets.push(`assignee = $${idx++}`);
      vals.push(options.assignee);
    }
  } else {
    if (options.status != null) {
      sets.push(`status = $${idx++}`);
      vals.push(options.status);
    }
    if (options.assignee !== undefined) {
      sets.push(`assignee = $${idx++}`);
      vals.push(options.assignee);
      const reopening = options.status === "open" && (options.assignee === "" || options.assignee == null);
      if (reopening) {
        sets.push(`started_at = $${idx++}`);
        vals.push(null);
      }
    }
  }

  const assigneeBeingSet = options.assignee != null && options.assignee.trim() !== "";
  if (assigneeBeingSet && row && (row.started_at == null || row.started_at === "")) {
    sets.push(`started_at = $${idx++}`);
    vals.push(now);
  }
  if (options.description != null) {
    sets.push(`description = $${idx++}`);
    vals.push(options.description);
  }
  if (options.priority != null) {
    sets.push(`priority = $${idx++}`);
    vals.push(options.priority);
  }
  if (options.complexity !== undefined) {
    const c = clampTaskComplexity(options.complexity);
    sets.push(`complexity = $${idx++}`);
    vals.push(c ?? null);
  }
  if (mergedExtra !== undefined) {
    sets.push(`extra = $${idx++}`);
    vals.push(JSON.stringify(mergedExtra));
  }
  return { sets, vals, nextIdx: idx };
}

/** Build SET clause and values for updateMany (status, assignee, description, priority, started_at). */
export function buildUpdateManySets(
  u: { status?: string; assignee?: string; description?: string; priority?: number },
  now: string,
  row: { started_at?: string | null } | null
): { sets: string[]; vals: unknown[]; nextIdx: number } {
  const sets: string[] = ["updated_at = $1"];
  const vals: unknown[] = [now];
  let idx = 2;
  if (u.status != null) {
    sets.push(`status = $${idx++}`);
    vals.push(u.status);
  }
  if (u.assignee !== undefined) {
    sets.push(`assignee = $${idx++}`);
    vals.push(u.assignee ?? null);
    const reopening = u.status === "open" && (u.assignee === "" || u.assignee == null);
    if (reopening) {
      sets.push(`started_at = $${idx++}`);
      vals.push(null);
    } else if (u.assignee != null && u.assignee.trim() !== "" && row && (row.started_at == null || row.started_at === "")) {
      sets.push(`started_at = $${idx++}`);
      vals.push(now);
    }
  }
  if (u.description != null) {
    sets.push(`description = $${idx++}`);
    vals.push(u.description);
  }
  if (u.priority != null) {
    sets.push(`priority = $${idx++}`);
    vals.push(u.priority);
  }
  return { sets, vals, nextIdx: idx };
}

export function isDuplicateKeyError(err: unknown): boolean {
  const msg = getErrorMessage(err);
  return /unique constraint|already exists|duplicate/i.test(msg);
}

// ──── Label / issue helpers ────

export function getCumulativeAttemptsFromIssue(issue: StoredTask): number {
  const labels = (issue.labels ?? []) as string[];
  let max = 0;
  for (const l of labels) {
    if (/^attempts:\d+$/.test(l)) {
      const n = parseInt(l.split(":")[1]!, 10);
      if (!Number.isNaN(n) && n > max) max = n;
    }
  }
  return max;
}

export function hasLabel(issue: StoredTask, label: string): boolean {
  return Array.isArray(issue.labels) && issue.labels.includes(label);
}

export function getFileScopeLabels(
  issue: StoredTask
): { modify?: string[]; create?: string[]; test?: string[] } | null {
  const labels = (issue.labels ?? []) as string[];
  const label = labels.find((l) => l.startsWith("files:"));
  if (!label) return null;
  try {
    return JSON.parse(label.slice("files:".length));
  } catch {
    return null;
  }
}

export function getConflictFilesFromIssue(issue: StoredTask): string[] {
  const labels = (issue.labels ?? []) as string[];
  const label = labels.find((l) => l.startsWith("conflict_files:"));
  if (!label) return [];
  try {
    const parsed = JSON.parse(label.slice("conflict_files:".length));
    return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === "string") : [];
  } catch {
    return [];
  }
}

export function getMergeStageFromIssue(issue: StoredTask): string | null {
  const labels = (issue.labels ?? []) as string[];
  const label = labels.find((l) => l.startsWith("merge_stage:"));
  return label ? label.slice("merge_stage:".length) : null;
}

// ──── Epic / blockers / parent ────

/**
 * Resolve the epic ID for a task by walking the parent chain until a task with issue_type/type === 'epic' is found.
 * Used when mergeStrategy === 'per_epic' for branch naming and defer-merge logic.
 * @param taskId - Task ID (e.g. os-a3f8.1 or os-a3f8.1.2)
 * @param idToIssue - Optional map or array of all tasks; required to determine which ancestor is the epic
 * @returns Epic ID (e.g. os-a3f8) or null if no epic in chain or idToIssue not provided
 */
export function resolveEpicId(
  taskId: string | undefined | null,
  idToIssue?: Map<string, StoredTask> | StoredTask[]
): string | null {
  if (taskId == null || typeof taskId !== "string") return null;
  const map =
    idToIssue instanceof Map
      ? idToIssue
      : Array.isArray(idToIssue)
        ? new Map(idToIssue.map((t) => [t.id, t]))
        : undefined;
  if (!map) return null;
  let current: string | null = taskId;
  while (current) {
    const lastDot = current.lastIndexOf(".");
    if (lastDot <= 0) return null;
    const parentId = current.slice(0, lastDot);
    const parent = map.get(parentId);
    if (parent && (parent.issue_type ?? (parent as { type?: string }).type) === "epic") {
      return parentId;
    }
    current = parentId;
  }
  return null;
}

/** Return blocker task IDs (depends_on_id for dependencies with type === 'blocks'). */
export function getBlockersFromIssue(issue: StoredTask): string[] {
  const deps = issue.dependencies ?? [];
  return deps
    .filter((d) => d.type === "blocks")
    .map((d) => d.depends_on_id)
    .filter((x): x is string => !!x);
}

/** Return parent task ID from a hierarchical task ID (e.g. os-a3f8.1.2 -> os-a3f8.1). */
export function getParentId(taskId: string): string | null {
  const lastDot = taskId.lastIndexOf(".");
  if (lastDot <= 0) return null;
  return taskId.slice(0, lastDot);
}
