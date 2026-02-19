import { exec } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";

const execAsync = promisify(exec);

/** Thrown when `pushMain` rebase encounters conflicts. Repo is left in rebase state. */
export class RebaseConflictError extends Error {
  constructor(public readonly conflictedFiles: string[]) {
    super(`Rebase conflict in ${conflictedFiles.length} file(s): ${conflictedFiles.join(", ")}`);
    this.name = "RebaseConflictError";
  }
}

/** Max time (ms) to wait for .git/index.lock to clear before removing it */
const GIT_LOCK_TIMEOUT_MS = 15_000;
/** Polling interval (ms) when waiting for git lock to clear */
const GIT_LOCK_POLL_MS = 500;

/**
 * Manages git branches for the task lifecycle:
 * - Create task branches
 * - Revert changes on failure (hard reset)
 * - Verify merges after review approval
 * - Delete branches after completion
 */
export class BranchManager {
  /**
   * Create a task branch from main.
   */
  async createBranch(repoPath: string, branchName: string): Promise<void> {
    await this.git(repoPath, "checkout main");
    await this.git(repoPath, `checkout -b ${branchName}`);
  }

  /**
   * Create branch if it does not exist, otherwise checkout existing branch.
   * Used when retrying after review rejection (branch already has coding agent's work).
   */
  async createOrCheckoutBranch(repoPath: string, branchName: string): Promise<void> {
    await this.waitForGitReady(repoPath);
    try {
      await execAsync(`git rev-parse --verify ${branchName}`, { cwd: repoPath });
      await this.checkout(repoPath, branchName);
    } catch {
      await this.createBranch(repoPath, branchName);
    }
  }

  /**
   * Switch to a branch.
   */
  async checkout(repoPath: string, branchName: string): Promise<void> {
    await this.git(repoPath, `checkout ${branchName}`);
  }

  /**
   * Get the current branch name.
   */
  async getCurrentBranch(repoPath: string): Promise<string> {
    const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: repoPath });
    return stdout.trim();
  }

  /**
   * Revert all changes on a branch and return to main.
   */
  async revertAndReturnToMain(repoPath: string, branchName: string): Promise<void> {
    try {
      // Reset any uncommitted changes
      await this.git(repoPath, "reset --hard HEAD");
      await this.git(repoPath, "clean -fd");
      // Switch back to main
      await this.git(repoPath, "checkout main");
      // Delete the task branch
      await this.git(repoPath, `branch -D ${branchName}`);
    } catch (error) {
      console.error(`Failed to revert branch ${branchName}:`, error);
      // Force checkout main even if something failed
      try {
        await this.git(repoPath, "checkout -f main");
      } catch {
        // Last resort
      }
    }
  }

  /**
   * Verify that a branch has been merged to main.
   */
  async verifyMerge(repoPath: string, branchName: string): Promise<boolean> {
    try {
      const { stdout } = await execAsync(`git branch --merged main`, { cwd: repoPath });
      return stdout.includes(branchName);
    } catch {
      return false;
    }
  }

  /**
   * Delete a branch (after successful merge).
   */
  async deleteBranch(repoPath: string, branchName: string): Promise<void> {
    try {
      await this.git(repoPath, `branch -d ${branchName}`);
    } catch {
      // Branch might already be deleted
    }
  }

  /**
   * Get the diff between main and a task branch.
   */
  async getDiff(repoPath: string, branchName: string): Promise<string> {
    const { stdout } = await execAsync(`git diff main...${branchName}`, {
      cwd: repoPath,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  }

  /**
   * Push a branch to the remote. Used to preserve work before crash recovery revert.
   */
  async pushBranch(repoPath: string, branchName: string): Promise<void> {
    try {
      await this.git(repoPath, `push -u origin ${branchName}`);
    } catch (error) {
      console.warn(`[branch-manager] pushBranch ${branchName} failed:`, error);
      throw error;
    }
  }

  /**
   * Push main to the remote. Called after successful merge so completed work reaches origin.
   * Fetches and rebases first to handle concurrent pushes to origin/main.
   * If rebase hits conflicts, throws a RebaseConflictError (repo left in rebase state
   * so a merger agent can resolve). Caller is responsible for aborting if resolution fails.
   */
  async pushMain(repoPath: string): Promise<void> {
    try {
      await this.git(repoPath, "fetch origin main");
    } catch (error) {
      console.warn("[branch-manager] pushMain: fetch failed, pushing anyway:", error);
    }

    try {
      await this.git(repoPath, "rebase origin/main");
    } catch (rebaseErr) {
      const rebaseActive = await this.isRebaseInProgress(repoPath);
      if (!rebaseActive) {
        // Rebase failed for a non-conflict reason (or completed despite the error).
        // Re-throw the original error so the caller doesn't mistake this for a conflict.
        throw rebaseErr;
      }
      const conflictedFiles = await this.getConflictedFiles(repoPath);
      throw new RebaseConflictError(conflictedFiles);
    }

    await this.git(repoPath, "push origin main");
  }

  /**
   * Push main to origin (no fetch/rebase). Used after the merger agent has resolved conflicts.
   */
  async pushMainToOrigin(repoPath: string): Promise<void> {
    await this.git(repoPath, "push origin main");
  }

  /**
   * List files with merge/rebase conflicts (unmerged paths).
   */
  async getConflictedFiles(repoPath: string): Promise<string[]> {
    try {
      const { stdout } = await execAsync("git diff --name-only --diff-filter=U", {
        cwd: repoPath,
      });
      return stdout.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Get the full diff showing conflict markers for unresolved files.
   */
  async getConflictDiff(repoPath: string): Promise<string> {
    try {
      const { stdout } = await execAsync("git diff", {
        cwd: repoPath,
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout;
    } catch {
      return "";
    }
  }

  /**
   * Stage all resolved files and continue an in-progress rebase.
   */
  async rebaseContinue(repoPath: string): Promise<void> {
    await this.git(repoPath, "add -A");
    await execAsync("git -c core.editor=true rebase --continue", {
      cwd: repoPath,
      timeout: 30000,
    });
  }

  /**
   * Abort an in-progress rebase, restoring the repo to its pre-rebase state.
   */
  async rebaseAbort(repoPath: string): Promise<void> {
    await this.git(repoPath, "rebase --abort").catch(() => {});
  }

  /**
   * Check whether a rebase is currently in progress.
   */
  async isRebaseInProgress(repoPath: string): Promise<boolean> {
    const gitDir = path.join(repoPath, ".git");
    for (const dir of ["rebase-merge", "rebase-apply"]) {
      try {
        await fs.access(path.join(gitDir, dir));
        return true;
      } catch {
        // Not present
      }
    }
    return false;
  }

  /**
   * Check for uncommitted changes and create a WIP commit if any exist.
   * Used when agent is terminated (SIGTERM, inactivity timeout) to preserve partial work.
   */
  async commitWip(repoPath: string, taskId: string): Promise<boolean> {
    try {
      const { stdout } = await execAsync("git status --porcelain", {
        cwd: repoPath,
        timeout: 5000,
      });
      if (!stdout.trim()) return false;

      await this.git(repoPath, "add -A");
      await this.git(repoPath, `commit -m "WIP: ${taskId}"`);
      return true;
    } catch (error) {
      console.warn(`[branch-manager] commitWip failed for ${taskId}:`, error);
      return false;
    }
  }

  /**
   * Get a summary of files changed between main and a branch.
   */
  async getChangedFiles(repoPath: string, branchName: string): Promise<string[]> {
    const { stdout } = await execAsync(`git diff --name-only main...${branchName}`, {
      cwd: repoPath,
    });
    return stdout.trim().split("\n").filter(Boolean);
  }

  /**
   * Wait for .git/index.lock to be released, removing it if stale.
   * Prevents "Another git process seems to be running" errors when
   * the previous agent's git operations haven't fully completed.
   */
  async waitForGitReady(repoPath: string): Promise<void> {
    const lockPath = path.join(repoPath, ".git", "index.lock");
    const start = Date.now();

    while (Date.now() - start < GIT_LOCK_TIMEOUT_MS) {
      try {
        await fs.access(lockPath);
      } catch {
        return; // Lock file doesn't exist — git is ready
      }

      const elapsed = Date.now() - start;
      if (elapsed > GIT_LOCK_TIMEOUT_MS / 2) {
        // After half the timeout, check if the lock is stale (older than 30s)
        try {
          const stat = await fs.stat(lockPath);
          const lockAge = Date.now() - stat.mtimeMs;
          if (lockAge > 30_000) {
            console.warn(
              `[branch-manager] Removing stale .git/index.lock (age: ${Math.round(lockAge / 1000)}s)`
            );
            await fs.unlink(lockPath);
            return;
          }
        } catch {
          return; // Lock disappeared while checking
        }
      }

      await new Promise((resolve) => setTimeout(resolve, GIT_LOCK_POLL_MS));
    }

    // Timeout reached — force-remove the lock as last resort
    try {
      console.warn("[branch-manager] Git lock wait timed out, force-removing .git/index.lock");
      await fs.unlink(lockPath);
    } catch {
      // Lock may have been removed concurrently
    }
  }

  /**
   * Ensure the main working tree is on the main branch.
   * With worktrees, this should always be the case. Logs a warning if not
   * and corrects it, but does not perform destructive operations.
   */
  async ensureOnMain(repoPath: string): Promise<void> {
    await this.waitForGitReady(repoPath);

    const currentBranch = await this.getCurrentBranch(repoPath);
    if (currentBranch !== "main") {
      console.warn(`[branch-manager] Expected main but on ${currentBranch}, switching to main`);
      try {
        await this.git(repoPath, "reset --hard HEAD");
        await this.git(repoPath, "checkout main");
      } catch {
        await this.git(repoPath, "checkout -f main");
      }
    }
  }

  // ─── No-Checkout Diff Capture ───

  /**
   * Capture a branch's diff from main without checking it out.
   * Returns empty string if the branch doesn't exist or has no diff.
   */
  async captureBranchDiff(repoPath: string, branchName: string): Promise<string> {
    try {
      const { stdout } = await execAsync(`git diff main...${branchName}`, {
        cwd: repoPath,
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout;
    } catch {
      return "";
    }
  }

  /**
   * Capture uncommitted changes (working tree + staged + untracked) in the given path.
   * Use worktree path when agent runs in a worktree.
   * Returns empty string if no uncommitted changes or on error.
   * Temporarily stages all changes to include untracked files, then unstages.
   */
  async captureUncommittedDiff(gitPath: string): Promise<string> {
    try {
      await execAsync("git add -A", { cwd: gitPath });
      try {
        const { stdout } = await execAsync("git diff --cached HEAD", {
          cwd: gitPath,
          maxBuffer: 10 * 1024 * 1024,
        });
        return stdout;
      } finally {
        await execAsync("git reset HEAD", { cwd: gitPath }).catch(() => {});
      }
    } catch {
      return "";
    }
  }

  // ─── Git Worktree Operations ───

  /** Base directory for task worktrees (used by heartbeat stale detection) */
  getWorktreeBasePath(): string {
    return path.join(os.tmpdir(), "opensprint-worktrees");
  }

  /**
   * Get the filesystem path for a task's worktree.
   */
  getWorktreePath(taskId: string): string {
    return path.join(this.getWorktreeBasePath(), taskId);
  }

  /**
   * Create an isolated git worktree for a task.
   * Creates the branch from main if it doesn't exist, removes stale worktrees,
   * then creates a fresh worktree at /tmp/opensprint-worktrees/<taskId>.
   * After creation, symlinks node_modules from the main repo so dependencies
   * (vitest, etc.) are available for test execution.
   * Returns the worktree path.
   */
  async createTaskWorktree(repoPath: string, taskId: string): Promise<string> {
    const branchName = `opensprint/${taskId}`;
    const wtPath = this.getWorktreePath(taskId);

    // Create branch from main if it doesn't exist
    try {
      await execAsync(`git rev-parse --verify ${branchName}`, { cwd: repoPath });
    } catch {
      await this.git(repoPath, `branch ${branchName} main`);
    }

    // Remove stale worktree if exists
    await this.removeTaskWorktree(repoPath, taskId);

    // Create worktree
    await fs.mkdir(path.dirname(wtPath), { recursive: true });
    await this.git(repoPath, `worktree add ${wtPath} ${branchName}`);

    // Symlink node_modules from main repo so dependencies are available in the worktree.
    // Git worktrees only contain tracked files; node_modules is gitignored.
    await this.symlinkNodeModules(repoPath, wtPath);

    return wtPath;
  }

  /**
   * Symlink node_modules directories from the main repo into a worktree.
   * Handles both root node_modules and any per-package node_modules
   * (e.g. .vite caches in workspace packages).
   */
  async symlinkNodeModules(repoPath: string, wtPath: string): Promise<void> {
    // Safety: never symlink into the main repo itself
    const resolvedRepo = await fs.realpath(repoPath).catch(() => repoPath);
    const resolvedWt = await fs.realpath(wtPath).catch(() => wtPath);
    if (resolvedRepo === resolvedWt) {
      console.warn(
        "[branch-manager] symlinkNodeModules: wtPath equals repoPath, skipping to avoid circular symlinks"
      );
      return;
    }

    // Symlink root node_modules
    const srcRoot = path.join(repoPath, "node_modules");
    const destRoot = path.join(wtPath, "node_modules");
    try {
      await fs.access(srcRoot);
      await this.forceSymlink(srcRoot, destRoot);
    } catch (err) {
      console.warn("[branch-manager] Failed to symlink root node_modules:", err);
    }

    // Symlink per-package node_modules (for .vite caches etc.)
    try {
      const packagesDir = path.join(repoPath, "packages");
      const entries = await fs.readdir(packagesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const srcPkg = path.join(packagesDir, entry.name, "node_modules");
        const destPkg = path.join(wtPath, "packages", entry.name, "node_modules");
        try {
          await fs.access(srcPkg);
          await fs.mkdir(path.dirname(destPkg), { recursive: true });
          await this.forceSymlink(srcPkg, destPkg);
        } catch {
          // Package doesn't have node_modules — skip
        }
      }
    } catch {
      // No packages directory or other issue — non-critical
    }
  }

  /**
   * Create a symlink, removing any existing file/symlink at the destination first.
   */
  private async forceSymlink(target: string, linkPath: string): Promise<void> {
    // Safety: never create a symlink that points to itself
    const resolvedTarget = await fs.realpath(target).catch(() => path.resolve(target));
    const resolvedLink = path.resolve(linkPath);
    if (resolvedTarget === resolvedLink) {
      console.warn(
        `[branch-manager] forceSymlink: target === linkPath (${resolvedTarget}), skipping circular symlink`
      );
      return;
    }

    try {
      await fs.symlink(target, linkPath, "junction");
    } catch (err: unknown) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === "EEXIST") {
        // Don't delete a real directory that isn't a symlink
        const stat = await fs.lstat(linkPath);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          console.warn(
            `[branch-manager] forceSymlink: ${linkPath} is a real directory, refusing to replace`
          );
          return;
        }
        await fs.rm(linkPath, { recursive: true, force: true });
        await fs.symlink(target, linkPath, "junction");
      } else {
        throw err;
      }
    }
  }

  /**
   * Remove a task's worktree. Safe to call even if the worktree doesn't exist.
   */
  async removeTaskWorktree(repoPath: string, taskId: string): Promise<void> {
    const wtPath = this.getWorktreePath(taskId);
    try {
      await this.git(repoPath, `worktree remove ${wtPath} --force`);
    } catch {
      // Worktree may not exist — also try manual cleanup
      try {
        await fs.rm(wtPath, { recursive: true, force: true });
        await this.git(repoPath, "worktree prune");
      } catch {
        // Nothing to clean up
      }
    }
  }

  /**
   * Get the number of commits a branch is ahead of main.
   * Returns 0 if the branch doesn't exist or has no commits beyond main.
   */
  async getCommitCountAhead(repoPath: string, branchName: string): Promise<number> {
    try {
      const { stdout } = await execAsync(`git rev-list --count main..${branchName}`, {
        cwd: repoPath,
      });
      return parseInt(stdout.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Merge a branch into main from the main working tree.
   * The main working tree must be on main (which it always should be with worktrees).
   * @param message - Optional merge commit message (PRD §5.9: "merge: opensprint/<task-id> — <task title>")
   */
  async mergeToMain(repoPath: string, branchName: string, message?: string): Promise<void> {
    if (message) {
      const escaped = message.replace(/"/g, '\\"');
      await this.git(repoPath, `merge -m "${escaped}" ${branchName}`);
    } else {
      await this.git(repoPath, `merge ${branchName}`);
    }
  }

  private async git(
    repoPath: string,
    command: string
  ): Promise<{ stdout: string; stderr: string }> {
    return execAsync(`git ${command}`, {
      cwd: repoPath,
      timeout: 30000,
    });
  }
}
