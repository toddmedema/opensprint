import fs from "fs/promises";
import { taskStore as taskStoreSingleton, type StoredTask } from "./task-store.service.js";
import { BranchManager } from "./branch-manager.js";
import { heartbeatService } from "./heartbeat.service.js";
import { ProjectService } from "./project.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("orphan-recovery");

/** Normalize a single string, array, or nullish value into a Set for exclude checks. */
function toExcludeSet(ids?: string | string[] | null): Set<string> {
  if (!ids) return new Set();
  return new Set(Array.isArray(ids) ? ids : [ids]);
}

/**
 * Orphan recovery: detect and retry abandoned IN_PROGRESS tasks.
 * When an agent is killed, its task remains in_progress with no active process.
 * This service: (1) commits any uncommitted changes on the task branch as WIP,
 * (2) resets the task status to open so it re-enters the ready queue.
 *
 * IMPORTANT: This service never checks out branches. The task branch is preserved
 * on disk (and on the remote if it was pushed). When the task is retried, the
 * worktree-based agent flow will pick up the existing branch.
 */
export class OrphanRecoveryService {
  private taskStore = taskStoreSingleton;
  private branchManager = new BranchManager();
  private projectService = new ProjectService();

  /**
   * Recover tasks identified by stale heartbeat files (> 2 min old).
   * Complements recoverOrphanedTasks by finding orphaned worktrees via heartbeat age.
   *
   * @param repoPath - Path to the project repository
   * @param excludeTaskIds - Task ID(s) to exclude from recovery
   */
  async recoverFromStaleHeartbeats(
    repoPath: string,
    excludeTaskIds?: string | string[] | null
  ): Promise<{ recovered: string[] }> {
    const project = await this.projectService.getProjectByRepoPath(repoPath);
    if (!project) return { recovered: [] };
    const projectId = project.id;
    const excludeSet = toExcludeSet(excludeTaskIds);
    const worktreeBase = this.branchManager.getWorktreeBasePath();
    const stale = await heartbeatService.findStaleHeartbeats(worktreeBase);
    const recovered: string[] = [];

    for (const { taskId } of stale) {
      if (excludeSet.has(taskId)) continue;
      try {
        const task = await this.taskStore.show(projectId, taskId);
        if (task.status === "in_progress") {
          await this.recoverOne(projectId, repoPath, task);
          recovered.push(taskId);
        }
      } catch {
        // Task may not exist in task store — just clean up worktree (Branches mode: no worktree)
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

    return { recovered };
  }

  /**
   * Recover orphaned tasks: in_progress + agent assignee but no active process.
   * Resets each task to open without any git checkout operations.
   * The branch is preserved for the next agent attempt.
   *
   * @param repoPath - Path to the project repository
   * @param excludeTaskIds - Task ID(s) to exclude (e.g. currently active agent tasks)
   */
  async recoverOrphanedTasks(
    repoPath: string,
    excludeTaskIds?: string | string[] | null
  ): Promise<{ recovered: string[] }> {
    const project = await this.projectService.getProjectByRepoPath(repoPath);
    if (!project) return { recovered: [] };
    const projectId = project.id;
    const excludeSet = toExcludeSet(excludeTaskIds);
    const orphans = await this.taskStore.listInProgressWithAgentAssignee(projectId);
    const toRecover = orphans.filter((t) => !excludeSet.has(t.id));

    const recovered: string[] = [];

    for (const task of toRecover) {
      try {
        await this.recoverOne(projectId, repoPath, task);
        recovered.push(task.id);
      } catch (err) {
        log.warn("Failed to recover task", { taskId: task.id, err: (err as Error).message });
      }
    }

    if (recovered.length > 0) {
      log.warn("Recovered orphaned tasks", { count: recovered.length, recovered });
    }

    return { recovered };
  }

  private async recoverOne(projectId: string, repoPath: string, task: StoredTask): Promise<void> {
    const settings = await this.projectService.getSettings(projectId);
    const gitWorkingMode = settings.gitWorkingMode ?? "worktree";

    // In Branches mode, agent runs in repoPath; no worktree. In Worktree mode, use worktree path.
    const workPath =
      gitWorkingMode === "branches" ? repoPath : this.branchManager.getWorktreePath(task.id);
    try {
      await fs.access(workPath);
      await this.branchManager.commitWip(workPath, task.id);
    } catch {
      // Worktree/path may not exist — that's fine
    }

    // Clean up worktree only in Worktree mode (Branches mode: no worktree to remove)
    if (gitWorkingMode !== "branches") {
      try {
        const worktrees = await this.branchManager.listTaskWorktrees(repoPath);
        const found = worktrees.find((w) => w.taskId === task.id);
        await this.branchManager.removeTaskWorktree(repoPath, task.id, found?.worktreePath);
      } catch {
        // Worktree may not exist
      }
    }

    // Reset task status to open — no git checkout needed.
    // The branch is preserved for the next attempt.
    await this.taskStore.update(projectId, task.id, {
      status: "open",
      assignee: "",
    });
  }
}

export const orphanRecoveryService = new OrphanRecoveryService();
