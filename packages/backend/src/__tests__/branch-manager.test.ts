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
  });
});
