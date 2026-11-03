import fs from "fs/promises";
import path from "path";
import { OPENSPRINT_PATHS } from "@opensprint/shared";
import { createLogger } from "./logger.js";

const guardLog = createLogger("worktree-cleanup-guard");

export function getWorktreeCleanupAssignmentGuardMs(): number {
  const raw = process.env.OPENSPRINT_SLOT_RECOVERY_GRACE_MS;
  if (raw == null || raw.trim() === "") return 30_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30_000;
}

export interface WorktreeAssignmentSummary {
  taskId: string;
  createdAt: string;
  worktreePath?: string;
  worktreeKey?: string;
}

export async function listAssignmentSummariesInWorktree(
  worktreePath: string
): Promise<WorktreeAssignmentSummary[]> {
  const activeRoot = path.join(worktreePath, OPENSPRINT_PATHS.active);
  const out: WorktreeAssignmentSummary[] = [];
  try {
    const entries = await fs.readdir(activeRoot, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith("_")) continue;
      const assignmentFile = path.join(activeRoot, e.name, OPENSPRINT_PATHS.assignment);
      try {
        const raw = await fs.readFile(assignmentFile, "utf-8");
        const parsed = JSON.parse(raw) as {
          taskId?: string;
          createdAt?: string;
          worktreePath?: string;
          worktreeKey?: string;
        };
        const taskId = typeof parsed.taskId === "string" ? parsed.taskId : e.name;
        const createdAt =
          typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString();
        out.push({
          taskId,
          createdAt,
          worktreePath: typeof parsed.worktreePath === "string" ? parsed.worktreePath : undefined,
          worktreeKey: typeof parsed.worktreeKey === "string" ? parsed.worktreeKey : undefined,
        });
      } catch {
        // skip
      }
    }
  } catch {
    // no active
  }
  return out;
}

export type WorktreeCleanupTaskStoreShow = (
  projectId: string,
  taskId: string
) => Promise<{ status?: string } | null | undefined>;

export interface WorktreeCleanupProtectionResult {
  forbid: boolean;
  reason?: string;
  referencingTaskIds?: string[];
}

export async function evaluateWorktreeCleanupProtection(
  projectId: string,
  resolvedWorktreePath: string,
  taskStoreShow: WorktreeCleanupTaskStoreShow,
  guardMs: number,
  opts?: {
    ignoreLiveTaskStatusForTaskIds?: Set<string>;
    /**
     * Skip the "fresh assignment" grace check for these task IDs. Used when reclaiming a slot
     * directory for the same task: assignment.json is written *after* `createTaskWorktree`, so
     * any file on disk here is always from a prior attempt, not the current dispatch's agent.
     */
    ignoreFreshAssignmentForTaskIds?: Set<string>;
  }
): Promise<WorktreeCleanupProtectionResult> {
  const { governanceService } = await import("../services/governance.service.js");
  const held = (await governanceService.listCases(projectId)).filter(
    (c) =>
      [
        "awaiting_reconsideration",
        "awaiting_judge",
        "awaiting_human",
        "evidence_requested",
        "stale",
      ].includes(c.state) && path.resolve(c.worktreePath) === path.resolve(resolvedWorktreePath)
  );
  if (held.length)
    return {
      forbid: true,
      reason: "governance_hold",
      referencingTaskIds: [...new Set(held.map((c) => c.taskId))],
    };
  const summaries = await listAssignmentSummariesInWorktree(resolvedWorktreePath);
  if (summaries.length === 0) return { forbid: false };

  const now = Date.now();
  const referencing: string[] = [];

  for (const s of summaries) {
    if (opts?.ignoreFreshAssignmentForTaskIds?.has(s.taskId)) continue;
    const createdMs = Date.parse(s.createdAt);
    const age = Number.isFinite(createdMs) ? now - createdMs : Number.POSITIVE_INFINITY;
    if (age >= 0 && age < guardMs) {
      referencing.push(s.taskId);
      return {
        forbid: true,
        reason: "fresh_assignment_on_disk",
        referencingTaskIds: [...new Set(referencing)],
      };
    }
  }

  for (const s of summaries) {
    if (opts?.ignoreLiveTaskStatusForTaskIds?.has(s.taskId)) continue;
    try {
      const task = await taskStoreShow(projectId, s.taskId);
      const st = task && typeof task.status === "string" ? task.status : "";
      if (st === "in_progress" || st === "open" || st === "blocked") {
        referencing.push(s.taskId);
        return {
          forbid: true,
          reason: `active_task_${st}`,
          referencingTaskIds: [...new Set(referencing)],
        };
      }
    } catch {
      // continue
    }
  }

  return { forbid: false };
}

export function logWorktreeCleanupBlocked(
  context: string,
  meta: {
    projectId: string;
    worktreePath: string;
    reason: string;
    referencingTaskIds?: string[];
    cleanupTrigger?: string;
    intentTaskId?: string;
  }
): void {
  guardLog.warn("worktree.cleanup_forbidden_referenced", {
    context,
    forbiddenDeletesAvoided: 1,
    ...meta,
  });
}

/**
 * Structured log immediately before a destructive worktree delete (after protection checks).
 * Use for observability: correlates teardown attempts with on-disk assignment slots.
 */
export function logWorktreeDeletionImminent(
  context: string,
  meta: {
    projectId: string;
    worktreePath: string;
    worktreeKey: string;
    assignmentSlotCount: number;
    assignmentTaskIds?: string[];
    cleanupTrigger?: string;
  }
): void {
  guardLog.info("worktree.delete_imminent", {
    context,
    forbiddenDeletesAvoided: 0,
    ...meta,
  });
}

const EXCLUDED_ROOT_DIRS = new Set([
  ".git",
  ".opensprint",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "tmp",
]);

export type WorktreePhase = "dispatch" | "review" | "merge" | "retry";

export type WorktreePreflightFailureReason =
  | "directory_missing"
  | "git_entry_missing"
  | "package_json_missing"
  | "source_directories_missing";

export interface WorktreePreflightResult {
  usable: boolean;
  failureReason?: WorktreePreflightFailureReason;
  detail?: string;
}

export class IncompleteWorktreeError extends Error {
  constructor(
    public readonly worktreePath: string,
    public readonly detail: string
  ) {
    super(`Worktree checkout at ${worktreePath} is incomplete: ${detail}`);
    this.name = "IncompleteWorktreeError";
  }
}

/**
 * Validate a freshly created worktree has the minimum expected checkout files.
 * Throws IncompleteWorktreeError if the checkout is missing critical markers.
 *
 * Call this immediately after `git worktree add` and before any agent dispatch.
 */
export async function validateWorktreeCheckout(
  repoPath: string,
  worktreePath: string
): Promise<void> {
  try {
    await fs.access(worktreePath);
  } catch {
    throw new IncompleteWorktreeError(worktreePath, "directory does not exist");
  }

  try {
    await fs.access(path.join(worktreePath, ".git"));
  } catch {
    throw new IncompleteWorktreeError(worktreePath, ".git entry is missing");
  }

  const repoHasPackageJson = await fs
    .access(path.join(repoPath, "package.json"))
    .then(() => true)
    .catch(() => false);
  if (repoHasPackageJson) {
    try {
      await fs.access(path.join(worktreePath, "package.json"));
    } catch {
      throw new IncompleteWorktreeError(
        worktreePath,
        "package.json is present in the main repo but missing in the worktree"
      );
    }
  }

  const repoRootEntries = await fs.readdir(repoPath, { withFileTypes: true }).catch(() => null);
  if (!repoRootEntries) return;

  const repoCheckoutMarkers = repoRootEntries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !name.startsWith(".") && !EXCLUDED_ROOT_DIRS.has(name));

  if (repoCheckoutMarkers.length === 0) return;

  for (const marker of repoCheckoutMarkers) {
    try {
      await fs.access(path.join(worktreePath, marker));
      return; // at least one source directory present
    } catch {
      // keep probing
    }
  }

  throw new IncompleteWorktreeError(
    worktreePath,
    `none of the expected source directories are present (checked: ${repoCheckoutMarkers.join(", ")})`
  );
}

/**
 * Structured preflight check returning a typed result instead of throwing.
 * Use before diff capture or merge-gate runs to distinguish workspace failures
 * from agent-produced empty diffs.
 */
export async function preflightWorktreeForDiff(
  repoPath: string,
  worktreePath: string
): Promise<WorktreePreflightResult> {
  try {
    await fs.access(worktreePath);
  } catch {
    return {
      usable: false,
      failureReason: "directory_missing",
      detail: "worktree directory does not exist",
    };
  }

  try {
    await fs.access(path.join(worktreePath, ".git"));
  } catch {
    return {
      usable: false,
      failureReason: "git_entry_missing",
      detail: ".git entry is missing from worktree",
    };
  }

  const repoHasPackageJson = await fs
    .access(path.join(repoPath, "package.json"))
    .then(() => true)
    .catch(() => false);
  if (repoHasPackageJson) {
    try {
      await fs.access(path.join(worktreePath, "package.json"));
    } catch {
      return {
        usable: false,
        failureReason: "package_json_missing",
        detail: "package.json is present in the main repo but missing in the worktree",
      };
    }
  }

  const repoRootEntries = await fs.readdir(repoPath, { withFileTypes: true }).catch(() => null);
  if (!repoRootEntries) return { usable: true };

  const repoCheckoutMarkers = repoRootEntries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !name.startsWith(".") && !EXCLUDED_ROOT_DIRS.has(name));

  if (repoCheckoutMarkers.length === 0) return { usable: true };

  for (const marker of repoCheckoutMarkers) {
    try {
      await fs.access(path.join(worktreePath, marker));
      return { usable: true };
    } catch {
      // keep probing
    }
  }

  return {
    usable: false,
    failureReason: "source_directories_missing",
    detail: `none of the expected source directories are present (checked: ${repoCheckoutMarkers.join(", ")})`,
  };
}

/**
 * True when both paths resolve to the same directory (realpath with path.resolve fallback).
 * Used before destructive worktree cleanup to avoid removing the wrong directory if a lease
 * row still points at a superseded path (TOCTOU vs. re-dispatch).
 */
export async function worktreePathsResolveEqually(a: string, b: string): Promise<boolean> {
  const ar = await fs.realpath(a).catch(() => path.resolve(a));
  const br = await fs.realpath(b).catch(() => path.resolve(b));
  return ar === br;
}

export interface WorktreeIntegrityResult {
  valid: boolean;
  phase: WorktreePhase;
  failureReason?: WorktreePreflightFailureReason;
  failureClass?: "environment_validation_failed";
  detail?: string;
  worktreePath: string;
  taskId: string;
}

/**
 * Phase-bound worktree integrity preflight.
 *
 * Validates that a worktree is structurally sound before a phase boundary.
 * Called by dispatch, review, merge-gate, and retry flows to fail fast
 * rather than discovering an invalid worktree deep in execution.
 */
export async function assertWorktreeIntegrity(
  repoPath: string,
  worktreePath: string,
  taskId: string,
  phase: WorktreePhase
): Promise<WorktreeIntegrityResult> {
  const ok: WorktreeIntegrityResult = { valid: true, phase, worktreePath, taskId };
  if (worktreePath === repoPath) return ok;

  const preflight = await preflightWorktreeForDiff(repoPath, worktreePath);
  if (preflight.usable) return ok;

  return {
    valid: false,
    phase,
    failureReason: preflight.failureReason,
    failureClass: "environment_validation_failed",
    detail: preflight.detail,
    worktreePath,
    taskId,
  };
}

/** Default TTL for {@link WorktreeCheckoutUsabilityCache} in orchestrator recovery paths. */
export const DEFAULT_WORKTREE_CHECKOUT_USABILITY_CACHE_TTL_MS = 2_500;

/** Correlates a GUPP assignment attempt with cached usability checks (task id + ordinal attempt). */
export function guppWorktreeUsabilityAttemptId(parts: { taskId: string; attempt: number }): string {
  return `${parts.taskId}:${parts.attempt}`;
}

interface WorktreeCheckoutUsabilityCacheEntry {
  expiresAt: number;
  value: Promise<boolean>;
}

/**
 * Short-lived memo for {@link isWorktreeCheckoutUsable} keyed by repo path, worktree path, and attempt id.
 * Coalesces duplicate checks in a single orchestrator tick without hiding long-lived filesystem changes.
 */
export class WorktreeCheckoutUsabilityCache {
  private readonly entries = new Map<string, WorktreeCheckoutUsabilityCacheEntry>();

  constructor(private readonly ttlMs: number) {}

  async getOrEvaluate(
    repoPath: string,
    worktreePath: string,
    attemptId: string,
    evaluate: () => Promise<boolean>
  ): Promise<boolean> {
    const key = `${path.resolve(repoPath)}\0${path.resolve(worktreePath)}\0${attemptId}`;
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) {
      return hit.value;
    }
    const value = evaluate().catch((err: unknown) => {
      this.entries.delete(key);
      throw err;
    });
    this.entries.set(key, { expiresAt: now + this.ttlMs, value });
    return value;
  }
}

/**
 * Best-effort check that a worktree contains a real source checkout, not just runtime metadata.
 *
 * This intentionally avoids shelling out to git so it is safe in startup/recovery paths.
 */
export async function isWorktreeCheckoutUsable(
  repoPath: string,
  worktreePath: string
): Promise<boolean> {
  try {
    await fs.access(worktreePath);
    await fs.access(path.join(worktreePath, ".git"));
  } catch {
    return false;
  }

  const repoHasPackageJson = await fs
    .access(path.join(repoPath, "package.json"))
    .then(() => true)
    .catch(() => false);
  if (repoHasPackageJson) {
    try {
      await fs.access(path.join(worktreePath, "package.json"));
    } catch {
      return false;
    }
  }

  const repoRootEntries = await fs.readdir(repoPath, { withFileTypes: true }).catch(() => null);
  if (!repoRootEntries) {
    // If we cannot inspect the repo root, keep the check conservative and avoid false negatives.
    return true;
  }

  const repoCheckoutMarkers = repoRootEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith(".") && !EXCLUDED_ROOT_DIRS.has(name));

  if (repoCheckoutMarkers.length === 0) {
    const worktreeEntries = await fs
      .readdir(worktreePath, { withFileTypes: true })
      .catch(() => null);
    if (!worktreeEntries) return true;
    return worktreeEntries.some(
      (entry) =>
        !entry.name.startsWith(".") &&
        !EXCLUDED_ROOT_DIRS.has(entry.name) &&
        (entry.isDirectory() || entry.isFile())
    );
  }

  for (const marker of repoCheckoutMarkers) {
    try {
      await fs.access(path.join(worktreePath, marker));
      return true;
    } catch {
      // Keep probing markers.
    }
  }

  return false;
}

const rebuildLog = createLogger("worktree-rebuild");

export interface WorktreeRebuildResult {
  rebuilt: boolean;
  previousPath: string;
  newPath: string;
  error?: string;
}

export interface WorktreeRebuildDeps {
  removeWorktree(repoPath: string, worktreeKey: string, actualPath?: string): Promise<boolean>;
  createWorktree(
    repoPath: string,
    taskId: string,
    baseBranch: string,
    options?: { worktreeKey?: string; branchName?: string }
  ): Promise<string>;
}

/**
 * Rebuild a worktree that has failed integrity validation.
 *
 * Flow: retire bad worktree -> remove -> recreate from branch -> verify.
 * Returns the new worktree path on success.
 */
export async function rebuildWorktreeIfInvalid(
  repoPath: string,
  worktreePath: string,
  taskId: string,
  branchName: string,
  baseBranch: string,
  deps: WorktreeRebuildDeps
): Promise<WorktreeRebuildResult> {
  const integrity = await assertWorktreeIntegrity(repoPath, worktreePath, taskId, "retry");
  if (integrity.valid) {
    return { rebuilt: false, previousPath: worktreePath, newPath: worktreePath };
  }

  rebuildLog.warn("Rebuilding invalid worktree", {
    taskId,
    worktreePath,
    failureReason: integrity.failureReason,
    detail: integrity.detail,
  });

  try {
    await deps.removeWorktree(repoPath, taskId, worktreePath);
  } catch (err) {
    rebuildLog.warn("Failed to remove invalid worktree during rebuild", {
      taskId,
      worktreePath,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const newPath = await deps.createWorktree(repoPath, taskId, baseBranch, {
      branchName,
    });

    const verification = await assertWorktreeIntegrity(repoPath, newPath, taskId, "retry");
    if (!verification.valid) {
      return {
        rebuilt: false,
        previousPath: worktreePath,
        newPath: newPath,
        error: `Rebuilt worktree still invalid: ${verification.detail}`,
      };
    }

    rebuildLog.info("Worktree rebuilt successfully", {
      taskId,
      previousPath: worktreePath,
      newPath,
    });

    return { rebuilt: true, previousPath: worktreePath, newPath };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    rebuildLog.error("Failed to rebuild worktree", {
      taskId,
      worktreePath,
      err: errorMsg,
    });
    return {
      rebuilt: false,
      previousPath: worktreePath,
      newPath: worktreePath,
      error: errorMsg,
    };
  }
}
