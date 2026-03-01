/**
 * RecoveryService — unified recovery across all mechanisms.
 *
 * Consolidates 5 overlapping recovery paths into a single service:
 *   1. GUPP crash recovery (assignment.json scan)
 *   2. Orphaned in_progress tasks
 *   3. Stale heartbeat detection
 *   4. Stale git lock removal
 *   5. Slot vs task store reconciliation
 *
 * Called once on startup by the orchestrator and periodically by the watchdog.
 */

import fs from "fs/promises";
import path from "path";
import { HEARTBEAT_STALE_MS } from "@opensprint/shared";
import type { StoredTask } from "./task-store.service.js";
import { taskStore as taskStoreSingleton } from "./task-store.service.js";
import { BranchManager } from "./branch-manager.js";
import { CrashRecoveryService } from "./crash-recovery.service.js";
import { ProjectService } from "./project.service.js";
import { heartbeatService } from "./heartbeat.service.js";
import { eventLogService } from "./event-log.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("recovery");

const GIT_LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes

export interface RecoveryResult {
  reattached: string[];
  requeued: string[];
  cleaned: string[];
}

export interface RecoveryHost {
  getSlottedTaskIds(projectId: string): string[];
  getActiveAgentIds(projectId: string): string[];
  /** Called to reattach a slot for a still-running agent (GUPP recovery) */
  reattachSlot?(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    assignment: GuppAssignment
  ): Promise<boolean>;
  /** Called to remove a slot whose task no longer exists in task store */
  removeStaleSlot?(projectId: string, taskId: string, repoPath: string): Promise<void>;
}

export interface GuppAssignment {
  taskId: string;
  projectId: string;
  phase: "coding" | "review";
  branchName: string;
  worktreePath: string;
  promptPath: string;
  agentConfig: unknown;
  attempt: number;
  createdAt: string;
}

/** Check whether a PID is still running */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const SIGTERM_WAIT_MS = 2000;

/** Terminate an agent process: SIGTERM first, then SIGKILL if it does not exit. */
async function terminateAgentProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process may already be gone
    return;
  }
  await new Promise((r) => setTimeout(r, SIGTERM_WAIT_MS));
  if (isPidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Best effort
    }
  }
}

export class RecoveryService {
  private taskStore = taskStoreSingleton;
  private branchManager = new BranchManager();
  private crashRecovery = new CrashRecoveryService();
  private projectService = new ProjectService();

  /**
   * Run full recovery pass. Safe to call multiple times (idempotent).
   * Startup mode includes GUPP (assignment reattachment); periodic mode skips it.
   */
  async runFullRecovery(
    projectId: string,
    repoPath: string,
    host: RecoveryHost,
    opts: { includeGupp?: boolean } = {}
  ): Promise<RecoveryResult> {
    const result: RecoveryResult = { reattached: [], requeued: [], cleaned: [] };

    // 1. GUPP crash recovery (startup only)
    if (opts.includeGupp && host.reattachSlot) {
      const guppResult = await this.recoverFromAssignments(projectId, repoPath, host);
      result.reattached.push(...guppResult.reattached);
      result.requeued.push(...guppResult.requeued);
    }

    // Build exclude set: active agents + slotted tasks + just-reattached
    const excludeIds = new Set([
      ...host.getSlottedTaskIds(projectId),
      ...host.getActiveAgentIds(projectId),
      ...result.reattached,
    ]);

    // 2. Stale heartbeat recovery
    const staleResult = await this.recoverFromStaleHeartbeats(projectId, repoPath, excludeIds);
    result.requeued.push(...staleResult);

    // 3. Orphaned in_progress tasks
    const orphanResult = await this.recoverOrphanedTasks(projectId, repoPath, excludeIds);
    result.requeued.push(...orphanResult);

    // 4. Stale git lock removal
    const lockCleaned = await this.cleanStaleGitLocks(projectId, repoPath);
    if (lockCleaned) result.cleaned.push(".git/index.lock");

    // 5. Reconcile slots vs task store
    if (host.removeStaleSlot) {
      const reconciled = await this.reconcileSlots(projectId, repoPath, host);
      result.cleaned.push(...reconciled);
    }

    // 6. Prune orphan worktrees (closed tasks, missing tasks) — prevents accumulation
    const pruned = await this.pruneOrphanWorktrees(projectId, repoPath, excludeIds);
    if (pruned.length > 0) {
      result.cleaned.push(...pruned.map((id) => `worktree:${id}`));
      log.info("Pruned orphan worktrees", { projectId, pruned });
    }

    return result;
  }

  // ─── GUPP: scan assignment.json files ───

  private async recoverFromAssignments(
    projectId: string,
    repoPath: string,
    host: RecoveryHost
  ): Promise<{ reattached: string[]; requeued: string[] }> {
    const worktreeBase = this.branchManager.getWorktreeBasePath();
    const fromWorktrees =
      await this.crashRecovery.findOrphanedAssignmentsFromWorktrees(worktreeBase);
    const fromMainRepo = await this.crashRecovery.findOrphanedAssignments(repoPath);
    const byTaskId = new Map<string, { taskId: string; assignment: GuppAssignment }>();
    for (const o of fromMainRepo)
      byTaskId.set(o.taskId, o as { taskId: string; assignment: GuppAssignment });
    for (const o of fromWorktrees)
      byTaskId.set(o.taskId, o as { taskId: string; assignment: GuppAssignment });
    const orphaned = [...byTaskId.values()];

    if (orphaned.length === 0) return { reattached: [], requeued: [] };

    const allIssues = await this.taskStore.listAll(projectId);
    const idToIssue = new Map(allIssues.map((i) => [i.id, i]));
    const reattached: string[] = [];
    const requeued: string[] = [];

    for (const { taskId, assignment } of orphaned) {
      const task = idToIssue.get(taskId);
      if (!task) {
        log.warn("Recovery: task not found, cleaning up assignment", { taskId });
        await this.removeWorktreeIfNeeded(repoPath, taskId, assignment.worktreePath);
        await this.deleteAssignment(repoPath, taskId, assignment.worktreePath);
        continue;
      }

      if ((task.status as string) !== "in_progress") {
        log.info("Recovery: task no longer in_progress, removing stale assignment", {
          taskId,
          status: task.status,
        });
        await this.removeWorktreeIfNeeded(repoPath, taskId, assignment.worktreePath);
        await this.deleteAssignment(repoPath, taskId, assignment.worktreePath);
        continue;
      }

      const wtPath = assignment.worktreePath;
      const heartbeat = wtPath ? await heartbeatService.readHeartbeat(wtPath, taskId) : null;
      const pidAlive =
        heartbeat != null &&
        typeof heartbeat.pid === "number" &&
        heartbeat.pid > 0 &&
        isPidAlive(heartbeat.pid);

      if (pidAlive && assignment.phase === "coding" && host.reattachSlot) {
        const attached = await host.reattachSlot(projectId, repoPath, task, assignment);
        if (attached) {
          reattached.push(taskId);
          continue;
        }
      }

      log.info("Recovery: PID dead or missing, requeuing task", { taskId });
      try {
        await this.taskStore.update(projectId, taskId, { status: "open", assignee: "" });
        await this.taskStore.comment(
          projectId,
          taskId,
          "Agent crashed (backend restart). Task requeued for next attempt."
        );
      } catch (err) {
        log.warn("Recovery: failed to requeue task", { taskId, err });
      }
      await this.removeWorktreeIfNeeded(repoPath, taskId, assignment.worktreePath);
      await this.deleteAssignment(repoPath, taskId, assignment.worktreePath);
      requeued.push(taskId);
    }

    return { reattached, requeued };
  }

  // ─── Stale heartbeat recovery ───

  private async recoverFromStaleHeartbeats(
    projectId: string,
    repoPath: string,
    excludeIds: Set<string>
  ): Promise<string[]> {
    const worktreeBase = this.branchManager.getWorktreeBasePath();
    const stale = await heartbeatService.findStaleHeartbeats(worktreeBase);
    const recovered: string[] = [];

    for (const { taskId, heartbeat } of stale) {
      if (excludeIds.has(taskId)) continue;
      const staleSec = Math.round((Date.now() - heartbeat.lastOutputTimestamp) / 1000);
      log.warn("Stale heartbeat detected", {
        taskId,
        staleSec,
        threshold: HEARTBEAT_STALE_MS / 1000,
      });

      eventLogService
        .append(repoPath, {
          timestamp: new Date().toISOString(),
          projectId,
          taskId,
          event: "recovery.stale_heartbeat",
          data: { staleSec, threshold: HEARTBEAT_STALE_MS / 1000 },
        })
        .catch(() => {});

      try {
        const task = await this.taskStore.show(projectId, taskId);
        if (task.status === "in_progress") {
          if (
            typeof heartbeat.pid === "number" &&
            heartbeat.pid > 0 &&
            isPidAlive(heartbeat.pid)
          ) {
            log.info("Terminating orphaned agent process", { taskId, pid: heartbeat.pid });
            await terminateAgentProcess(heartbeat.pid);
          }
          await this.recoverTask(projectId, repoPath, task);
          recovered.push(taskId);
        }
      } catch {
        // Task may not exist — clean up worktree only in Worktree mode (Branches: no worktree)
        const settings = await this.projectService.getSettings(projectId);
        if (settings.gitWorkingMode !== "branches") {
          try {
            await this.branchManager.removeTaskWorktree(repoPath, taskId);
          } catch {
            // Ignore
          }
        }
      }
    }

    return recovered;
  }

  // ─── Orphaned in_progress tasks ───

  private async recoverOrphanedTasks(
    projectId: string,
    repoPath: string,
    excludeIds: Set<string>
  ): Promise<string[]> {
    const orphans = await this.taskStore.listInProgressWithAgentAssignee(projectId);
    const toRecover = orphans.filter((t) => !excludeIds.has(t.id));
    const recovered: string[] = [];

    for (const task of toRecover) {
      try {
        await this.recoverTask(projectId, repoPath, task);
        recovered.push(task.id);
      } catch (err) {
        log.warn("Failed to recover task", { taskId: task.id, err: (err as Error).message });
      }
    }

    if (recovered.length > 0) {
      log.warn("Recovered orphaned tasks", { count: recovered.length, recovered });
    }
    return recovered;
  }

  // ─── Stale git lock removal ───

  private async cleanStaleGitLocks(projectId: string, repoPath: string): Promise<boolean> {
    const lockPath = path.join(repoPath, ".git", "index.lock");
    try {
      const stat = await fs.stat(lockPath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > GIT_LOCK_STALE_MS) {
        log.warn("Removing stale .git/index.lock", { ageSec: Math.round(ageMs / 1000) });
        await fs.unlink(lockPath);
        eventLogService
          .append(repoPath, {
            timestamp: new Date().toISOString(),
            projectId,
            taskId: "",
            event: "recovery.stale_lock_removed",
            data: { ageMs },
          })
          .catch(() => {});
        return true;
      }
    } catch {
      // No lock file — healthy
    }
    return false;
  }

  // ─── Slot reconciliation ───

  private async reconcileSlots(
    projectId: string,
    repoPath: string,
    host: RecoveryHost
  ): Promise<string[]> {
    const slottedIds = host.getSlottedTaskIds(projectId);
    if (slottedIds.length === 0) return [];

    const allIssues = await this.taskStore.listAll(projectId);
    const validIds = new Set(allIssues.map((i) => i.id).filter(Boolean) as string[]);

    // Do not remove slots when listAll returned no tasks; avoid killing agents on empty list.
    if (validIds.size === 0) {
      log.warn("Skipping slot reconciliation: listAll returned 0 tasks but we have slots", {
        projectId,
        slottedCount: slottedIds.length,
        slottedTaskIds: slottedIds,
      });
      return [];
    }

    const stale: string[] = [];

    for (const taskId of slottedIds) {
      if (!validIds.has(taskId)) {
        log.warn("Removing stale slot: task no longer in task store", { projectId, taskId });
        await host.removeStaleSlot!(projectId, taskId, repoPath);
        stale.push(taskId);
      }
    }

    return stale;
  }

  // ─── Orphan worktree pruning ───

  private async pruneOrphanWorktrees(
    projectId: string,
    repoPath: string,
    excludeIds: Set<string>
  ): Promise<string[]> {
    const settings = await this.projectService.getSettings(projectId);
    if (settings.gitWorkingMode === "branches") return [];
    return this.branchManager.pruneOrphanWorktrees(
      repoPath,
      projectId,
      excludeIds,
      this.taskStore
    );
  }

  // ─── Shared helpers ───

  private async recoverTask(projectId: string, repoPath: string, task: StoredTask): Promise<void> {
    const settings = await this.projectService.getSettings(projectId);
    const gitWorkingMode = settings.gitWorkingMode ?? "worktree";

    // In Branches mode, agent runs in repoPath; no worktree. In Worktree mode, use worktree path.
    const workPath =
      gitWorkingMode === "branches" ? repoPath : this.branchManager.getWorktreePath(task.id);
    try {
      await fs.access(workPath);
      await this.branchManager.commitWip(workPath, task.id);
    } catch {
      // Worktree/path may not exist
    }

    // Clean up worktree only in Worktree mode (Branches mode: no worktree to remove)
    if (gitWorkingMode !== "branches") {
      try {
        const worktrees = await this.branchManager.listTaskWorktrees(repoPath);
        const found = worktrees.find((w) => w.taskId === task.id);
        await this.branchManager.removeTaskWorktree(
          repoPath,
          task.id,
          found?.worktreePath
        );
      } catch {
        // Worktree may not exist
      }
    }

    await this.taskStore.update(projectId, task.id, {
      status: "open",
      assignee: "",
    });
  }

  /**
   * Remove worktree when the path is a task worktree (not main repo).
   * In Branches mode assignment.worktreePath === repoPath; in Worktree mode it's a temp path.
   * Uses actual path so we clean up correctly when os.tmpdir() changed since creation.
   */
  private async removeWorktreeIfNeeded(
    repoPath: string,
    taskId: string,
    worktreePath?: string
  ): Promise<void> {
    if (!worktreePath) return;
    const repoResolved = path.resolve(repoPath);
    const wtResolved = path.resolve(worktreePath);
    if (repoResolved === wtResolved) return; // Branches mode: no worktree
    try {
      await this.branchManager.removeTaskWorktree(repoPath, taskId, worktreePath);
    } catch {
      // Best effort; worktree may already be gone
    }
  }

  private async deleteAssignment(
    repoPath: string,
    taskId: string,
    worktreePath?: string
  ): Promise<void> {
    if (worktreePath) {
      await this.crashRecovery.deleteAssignmentAt(worktreePath, taskId);
    }
    const { OPENSPRINT_PATHS } = await import("@opensprint/shared");
    const assignmentPath = path.join(
      repoPath,
      OPENSPRINT_PATHS.active,
      taskId,
      OPENSPRINT_PATHS.assignment
    );
    try {
      await fs.unlink(assignmentPath);
    } catch {
      // File may not exist
    }
  }
}

export const recoveryService = new RecoveryService();
