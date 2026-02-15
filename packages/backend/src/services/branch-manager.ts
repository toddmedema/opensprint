import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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
   * Get a summary of files changed between main and a branch.
   */
  async getChangedFiles(repoPath: string, branchName: string): Promise<string[]> {
    const { stdout } = await execAsync(
      `git diff --name-only main...${branchName}`,
      { cwd: repoPath },
    );
    return stdout.trim().split('\n').filter(Boolean);
  }

  private async git(repoPath: string, command: string): Promise<{ stdout: string; stderr: string }> {
    return execAsync(`git ${command}`, {
      cwd: repoPath,
      timeout: 30000,
    });
  }
}
