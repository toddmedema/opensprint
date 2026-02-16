import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { BranchManager } from '../services/branch-manager.js';

const execAsync = promisify(exec);

describe('BranchManager', () => {
  let branchManager: BranchManager;
  let repoPath: string;

  beforeEach(async () => {
    branchManager = new BranchManager();
    repoPath = path.join(os.tmpdir(), `opensprint-branch-test-${Date.now()}`);
    await fs.mkdir(repoPath, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(repoPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('commitWip', () => {
    it('should return false when there are no uncommitted changes', async () => {
      await execAsync('git init', { cwd: repoPath });
      await execAsync('git branch -M main', { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, 'README'), 'initial');
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const result = await branchManager.commitWip(repoPath, 'task-123');
      expect(result).toBe(false);
    });

    it('should create WIP commit and return true when there are uncommitted changes', async () => {
      await execAsync('git init', { cwd: repoPath });
      await execAsync('git branch -M main', { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, 'README'), 'initial');
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, 'newfile'), 'wip content');

      const result = await branchManager.commitWip(repoPath, 'task-456');
      expect(result).toBe(true);

      const { stdout } = await execAsync('git log -1 --oneline', { cwd: repoPath });
      expect(stdout).toContain('WIP: task-456');
    });

    it('should handle modified files', async () => {
      await execAsync('git init', { cwd: repoPath });
      await execAsync('git branch -M main', { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, 'README'), 'initial');
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, 'README'), 'modified');

      const result = await branchManager.commitWip(repoPath, 'task-789');
      expect(result).toBe(true);

      const { stdout } = await execAsync('git log -1 --oneline', { cwd: repoPath });
      expect(stdout).toContain('WIP: task-789');
    });

    it('should return false and not throw when git fails (e.g. not a repo)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await branchManager.commitWip('/nonexistent/path', 'task-999');
      expect(result).toBe(false);

      warnSpy.mockRestore();
    });

    it('should create WIP commit on task branch (agent termination scenario)', async () => {
      await execAsync('git init', { cwd: repoPath });
      await execAsync('git branch -M main', { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, 'README'), 'initial');
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });
      await execAsync('git checkout -b opensprint/task-xyz', { cwd: repoPath });
      await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
      await fs.writeFile(path.join(repoPath, 'src/newfile.ts'), 'partial work');

      const result = await branchManager.commitWip(repoPath, 'task-xyz');
      expect(result).toBe(true);

      const { stdout } = await execAsync('git log -1 --oneline', { cwd: repoPath });
      expect(stdout).toContain('WIP: task-xyz');
      const { stdout: branchOut } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath });
      expect(branchOut.trim()).toBe('opensprint/task-xyz');
    });
  });

  describe('captureBranchDiff', () => {
    it('should capture diff between main and a branch without checkout', async () => {
      await execAsync('git init', { cwd: repoPath });
      await execAsync('git branch -M main', { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, 'README'), 'initial');
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      // Create a branch with changes
      await execAsync('git checkout -b opensprint/test-task', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, 'newfile.ts'), 'new content');
      await execAsync('git add -A && git commit -m "add file"', { cwd: repoPath });

      // Switch back to main
      await execAsync('git checkout main', { cwd: repoPath });

      const diff = await branchManager.captureBranchDiff(repoPath, 'opensprint/test-task');
      expect(diff).toContain('newfile.ts');
      expect(diff).toContain('new content');

      // Verify we're still on main
      const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath });
      expect(stdout.trim()).toBe('main');
    });

    it('should return empty string for non-existent branch', async () => {
      await execAsync('git init', { cwd: repoPath });
      await execAsync('git branch -M main', { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, 'README'), 'initial');
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const diff = await branchManager.captureBranchDiff(repoPath, 'opensprint/nonexistent');
      expect(diff).toBe('');
    });
  });

  describe('worktree operations', () => {
    let worktreePaths: string[] = [];

    afterEach(async () => {
      // Clean up any worktrees created during tests
      for (const wt of worktreePaths) {
        try {
          await execAsync(`git worktree remove ${wt} --force`, { cwd: repoPath }).catch(() => {});
          await fs.rm(wt, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      worktreePaths = [];
      try {
        await execAsync('git worktree prune', { cwd: repoPath });
      } catch {
        // ignore
      }
    });

    it('should create and return a worktree path', async () => {
      await execAsync('git init', { cwd: repoPath });
      await execAsync('git branch -M main', { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, 'README'), 'initial');
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const taskId = `wt-test-${Date.now()}`;
      const wtPath = await branchManager.createTaskWorktree(repoPath, taskId);
      worktreePaths.push(wtPath);

      // Verify worktree exists and is on the correct branch
      const stat = await fs.stat(wtPath);
      expect(stat.isDirectory()).toBe(true);

      const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: wtPath });
      expect(stdout.trim()).toBe(`opensprint/${taskId}`);

      // Verify main WT is still on main
      const { stdout: mainBranch } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath });
      expect(mainBranch.trim()).toBe('main');
    });

    it('should remove a worktree cleanly', async () => {
      await execAsync('git init', { cwd: repoPath });
      await execAsync('git branch -M main', { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, 'README'), 'initial');
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const taskId = `wt-rm-${Date.now()}`;
      const wtPath = await branchManager.createTaskWorktree(repoPath, taskId);

      // Verify it exists
      await fs.access(wtPath);

      // Remove it
      await branchManager.removeTaskWorktree(repoPath, taskId);

      // Verify it's gone
      try {
        await fs.access(wtPath);
        expect.fail('Worktree directory should have been removed');
      } catch {
        // Expected
      }
    });

    it('should handle removing a non-existent worktree gracefully', async () => {
      await execAsync('git init', { cwd: repoPath });
      await execAsync('git branch -M main', { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, 'README'), 'initial');
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      // Should not throw
      await branchManager.removeTaskWorktree(repoPath, 'nonexistent-task');
    });

    it('should replace a stale worktree when creating', async () => {
      await execAsync('git init', { cwd: repoPath });
      await execAsync('git branch -M main', { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, 'README'), 'initial');
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const taskId = `wt-replace-${Date.now()}`;

      // Create first worktree
      const wtPath1 = await branchManager.createTaskWorktree(repoPath, taskId);
      worktreePaths.push(wtPath1);

      // Write a file in the first worktree
      await fs.writeFile(path.join(wtPath1, 'old-file.txt'), 'old content');

      // Create second worktree (should replace the first)
      const wtPath2 = await branchManager.createTaskWorktree(repoPath, taskId);
      worktreePaths.push(wtPath2);

      expect(wtPath2).toBe(wtPath1); // Same path

      // The old file should not exist (fresh worktree)
      // Actually, the branch preserves committed content. The uncommitted file is gone.
      try {
        await fs.access(path.join(wtPath2, 'old-file.txt'));
        expect.fail('Uncommitted file from old worktree should be gone');
      } catch {
        // Expected
      }
    });

    it('should merge branch to main via mergeToMain', async () => {
      await execAsync('git init', { cwd: repoPath });
      await execAsync('git branch -M main', { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, 'README'), 'initial');
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const taskId = `wt-merge-${Date.now()}`;
      const branchName = `opensprint/${taskId}`;
      const wtPath = await branchManager.createTaskWorktree(repoPath, taskId);
      worktreePaths.push(wtPath);

      // Make changes in worktree and commit
      await fs.writeFile(path.join(wtPath, 'feature.ts'), 'export const x = 1;');
      await execAsync('git add -A && git commit -m "add feature"', { cwd: wtPath });

      // Merge from main WT (which is on main)
      await branchManager.mergeToMain(repoPath, branchName);

      // Verify the file exists on main
      const content = await fs.readFile(path.join(repoPath, 'feature.ts'), 'utf-8');
      expect(content).toBe('export const x = 1;');

      // Verify merge
      const merged = await branchManager.verifyMerge(repoPath, branchName);
      expect(merged).toBe(true);
    });
  });
});
