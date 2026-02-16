import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { OrphanRecoveryService } from '../services/orphan-recovery.service.js';

const execAsync = promisify(exec);

// Mock BeadsService
let mockListInProgress: { id: string; status: string; assignee: string }[] = [];
let mockUpdateCalls: Array<{ id: string; status: string; assignee: string }> = [];

vi.mock('../services/beads.service.js', () => {
  return {
    BeadsService: class MockBeadsService {
      listInProgressWithAgentAssignee = vi.fn().mockImplementation(() => Promise.resolve(mockListInProgress));
      update = vi.fn().mockImplementation(async (_repo: string, id: string, opts: { status?: string; assignee?: string }) => {
        mockUpdateCalls.push({ id, status: opts.status ?? '', assignee: opts.assignee ?? '' });
        return { id, status: opts.status ?? 'open', assignee: opts.assignee ?? '' };
      });
    },
  };
});

describe('OrphanRecoveryService', () => {
  let service: OrphanRecoveryService;
  let repoPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    service = new OrphanRecoveryService();
    repoPath = path.join(os.tmpdir(), `orphan-recovery-test-${Date.now()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await execAsync('git init', { cwd: repoPath });
    await execAsync('git branch -M main', { cwd: repoPath });
    await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
    await execAsync('git config user.name "Test"', { cwd: repoPath });
    await fs.mkdir(path.join(repoPath, '.beads'), { recursive: true });
    await fs.writeFile(path.join(repoPath, '.beads', 'issues.jsonl'), '[]');
    // Need an initial commit for worktree operations
    await fs.writeFile(path.join(repoPath, 'README.md'), 'test');
    await execAsync('git add -A && git commit -m "init"', { cwd: repoPath });
    mockListInProgress = [];
    mockUpdateCalls = [];
  });

  afterEach(async () => {
    try {
      // Clean up any worktrees
      await execAsync('git worktree prune', { cwd: repoPath }).catch(() => {});
      await fs.rm(repoPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('should recover orphaned tasks and reset to open without checkout', async () => {
    mockListInProgress = [
      { id: 'task-orphan-1', status: 'in_progress', assignee: 'agent-1' },
    ];

    const { recovered } = await service.recoverOrphanedTasks(repoPath);

    expect(recovered).toEqual(['task-orphan-1']);
    expect(mockUpdateCalls).toHaveLength(1);
    expect(mockUpdateCalls[0]).toMatchObject({
      id: 'task-orphan-1',
      status: 'open',
      assignee: '',
    });

    // Verify we're still on main (no checkout occurred)
    const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath });
    expect(stdout.trim()).toBe('main');
  });

  it('should exclude task when excludeTaskId is provided', async () => {
    mockListInProgress = [
      { id: 'task-a', status: 'in_progress', assignee: 'agent-1' },
      { id: 'task-b', status: 'in_progress', assignee: 'agent-1' },
    ];

    const { recovered } = await service.recoverOrphanedTasks(repoPath, 'task-a');

    expect(recovered).toEqual(['task-b']);
    expect(mockUpdateCalls).toHaveLength(1);
    expect(mockUpdateCalls[0].id).toBe('task-b');
  });

  it('should return empty when no orphaned tasks', async () => {
    mockListInProgress = [];

    const { recovered } = await service.recoverOrphanedTasks(repoPath);

    expect(recovered).toEqual([]);
    expect(mockUpdateCalls).toHaveLength(0);
  });

  it('should clean up stale worktrees during recovery', async () => {
    const taskId = 'task-wt';
    const wtPath = path.join(os.tmpdir(), 'opensprint-worktrees', taskId);

    // Create a branch and worktree to simulate an abandoned agent
    await execAsync(`git branch opensprint/${taskId} main`, { cwd: repoPath });
    await fs.mkdir(path.dirname(wtPath), { recursive: true });
    await execAsync(`git worktree add ${wtPath} opensprint/${taskId}`, { cwd: repoPath });

    mockListInProgress = [{ id: taskId, status: 'in_progress', assignee: 'agent-1' }];

    const { recovered } = await service.recoverOrphanedTasks(repoPath);

    expect(recovered).toContain(taskId);

    // Verify worktree was cleaned up
    try {
      await fs.access(wtPath);
      // If we get here, the directory still exists — fail
      expect.fail('Worktree directory should have been removed');
    } catch {
      // Expected: worktree directory removed
    }

    // Verify we're still on main
    const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath });
    expect(stdout.trim()).toBe('main');

    // Clean up
    await execAsync(`git branch -D opensprint/${taskId}`, { cwd: repoPath }).catch(() => {});
  });

  it('should log warning when recovering orphaned tasks', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockListInProgress = [{ id: 'task-1', status: 'in_progress', assignee: 'agent-1' }];

    await service.recoverOrphanedTasks(repoPath);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Recovered 1 orphaned task(s)'),
    );
    warnSpy.mockRestore();
  });
});
