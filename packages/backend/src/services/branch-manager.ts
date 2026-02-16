import { exec } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

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
    await this.git(repoPath, 'checkout main');
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
    const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath });
    return stdout.trim();
  }

  /**
   * Revert all changes on a branch and return to main.
   */
  async revertAndReturnToMain(repoPath: string, branchName: string): Promise<void> {
    try {
      // Reset any uncommitted changes
      await this.git(repoPath, 'reset --hard HEAD');
      await this.git(repoPath, 'clean -fd');
      // Switch back to main
      await this.git(repoPath, 'checkout main');
      // Delete the task branch
      await this.git(repoPath, `branch -D ${branchName}`);
    } catch (error) {
      console.error(`Failed to revert branch ${branchName}:`, error);
      // Force checkout main even if something failed
      try {
        await this.git(repoPath, 'checkout -f main');
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
      const { stdout } = await execAsync(
        `git branch --merged main`,
        { cwd: repoPath },
      );
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
    const { stdout } = await execAsync(
      `git diff main...${branchName}`,
      { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
    );
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
   */
  async pushMain(repoPath: string): Promise<void> {
    try {
      await this.git(repoPath, "push origin main");
    } catch (error) {
      console.warn("[branch-manager] pushMain failed:", error);
      throw error;
    }
  }

  /**
   * Check for uncommitted changes and create a WIP commit if any exist.
   * Used when agent is terminated (SIGTERM, inactivity timeout) to preserve partial work.
   */
  async commitWip(repoPath: string, taskId: string): Promise<boolean> {
    try {
      const { stdout } = await execAsync('git status --porcelain', {
        cwd: repoPath,
        timeout: 5000,
      });
      if (!stdout.trim()) return false;

      await this.git(repoPath, 'add -A');
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
    const { stdout } = await execAsync(
      `git diff --name-only main...${branchName}`,
      { cwd: repoPath },
    );
    return stdout.trim().split('\n').filter(Boolean);
  }

  /**
   * Wait for .git/index.lock to be released, removing it if stale.
   * Prevents "Another git process seems to be running" errors when
   * the previous agent's git operations haven't fully completed.
   */
  async waitForGitReady(repoPath: string): Promise<void> {
    const lockPath = path.join(repoPath, '.git', 'index.lock');
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
            console.warn(`[branch-manager] Removing stale .git/index.lock (age: ${Math.round(lockAge / 1000)}s)`);
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
      console.warn('[branch-manager] Git lock wait timed out, force-removing .git/index.lock');
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
    if (currentBranch !== 'main') {
      console.warn(`[branch-manager] Expected main but on ${currentBranch}, switching to main`);
      try {
        await this.git(repoPath, 'reset --hard HEAD');
        await this.git(repoPath, 'checkout main');
      } catch {
        await this.git(repoPath, 'checkout -f main');
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
      const { stdout } = await execAsync(
        `git diff main...${branchName}`,
        { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
      );
      return stdout;
    } catch {
      return '';
    }
  }

  // ─── Git Worktree Operations ───

  private getWorktreeBasePath(): string {
    return path.join(os.tmpdir(), 'opensprint-worktrees');
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
    return wtPath;
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
        await this.git(repoPath, 'worktree prune');
      } catch {
        // Nothing to clean up
      }
    }
  }

  /**
   * Merge a branch into main from the main working tree.
   * The main working tree must be on main (which it always should be with worktrees).
   */
  async mergeToMain(repoPath: string, branchName: string): Promise<void> {
    await this.git(repoPath, `merge ${branchName}`);
  }

  private async git(repoPath: string, command: string): Promise<{ stdout: string; stderr: string }> {
    return execAsync(`git ${command}`, {
      cwd: repoPath,
      timeout: 30000,
    });
  }
}
