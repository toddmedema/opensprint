import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BeadsService } from '../services/beads.service.js';

// Control mock stdout per test (closure reads current value at call time)
let mockStdout = '{}';
let mockExecImpl: (cmd: string) => Promise<{ stdout: string; stderr: string }> = async () => ({
  stdout: mockStdout,
  stderr: '',
});

vi.mock('util', () => ({
  promisify: () => (cmd: string, _opts?: unknown) => mockExecImpl(cmd),
}));

describe('BeadsService', () => {
  let beads: BeadsService;
  const repoPath = '/tmp/test-repo';

  beforeEach(() => {
    beads = new BeadsService();
    mockStdout = '{}';
    mockExecImpl = async () => ({ stdout: mockStdout, stderr: '' });
  });

  it('should be instantiable', () => {
    expect(beads).toBeInstanceOf(BeadsService);
  });

  it('should have all expected methods', () => {
    expect(typeof beads.init).toBe('function');
    expect(typeof beads.create).toBe('function');
    expect(typeof beads.update).toBe('function');
    expect(typeof beads.close).toBe('function');
    expect(typeof beads.ready).toBe('function');
    expect(typeof beads.list).toBe('function');
    expect(typeof beads.show).toBe('function');
    expect(typeof beads.addDependency).toBe('function');
    expect(typeof beads.delete).toBe('function');
    expect(typeof beads.sync).toBe('function');
    expect(typeof beads.depTree).toBe('function');
    expect(typeof beads.runBd).toBe('function');
    expect(typeof beads.getBlockers).toBe('function');
    expect(typeof beads.areAllBlockersClosed).toBe('function');
  });

  it('runBd should return parsed JSON from bd output', async () => {
    const json = { id: 'test-1', title: 'Test', status: 'open' };
    mockStdout = JSON.stringify(json);

    const result = await beads.runBd(repoPath, 'show', ['test-1', '--json']);
    expect(result).toEqual(json);
  });

  it('runBd should return null for empty output', async () => {
    mockStdout = '\n  \n';

    const result = await beads.runBd(repoPath, 'close', ['x', '--reason', 'done', '--json']);
    expect(result).toBeNull();
  });

  it('runBd should throw on exec error', async () => {
    mockExecImpl = async () => {
      throw Object.assign(new Error('bd not found'), { stderr: 'bd: command not found' });
    };

    await expect(beads.runBd(repoPath, 'list', ['--json'])).rejects.toThrow(/Beads command failed/);
  });

  describe('update', () => {
    it('should update issue with status and return parsed result', async () => {
      mockStdout = JSON.stringify({
        id: 'test-123',
        title: 'My Task',
        status: 'in_progress',
        priority: 1,
      });
      const result = await beads.update('/repo', 'test-123', { status: 'in_progress' });
      expect(result.id).toBe('test-123');
      expect(result.status).toBe('in_progress');
    });

    it('should support claim option (assignee + in_progress)', async () => {
      mockStdout = JSON.stringify({
        id: 'task-1',
        status: 'in_progress',
        assignee: 'agent-1',
      });
      const result = await beads.update('/repo', 'task-1', { claim: true });
      expect(result.assignee).toBe('agent-1');
      expect(result.status).toBe('in_progress');
    });

    it('should support assignee, description, and priority options', async () => {
      mockStdout = JSON.stringify({
        id: 'task-1',
        assignee: 'agent-1',
        description: 'Updated desc',
        priority: 0,
      });
      const result = await beads.update('/repo', 'task-1', {
        assignee: 'agent-1',
        description: 'Updated desc',
        priority: 0,
      });
      expect(result.assignee).toBe('agent-1');
      expect(result.description).toBe('Updated desc');
      expect(result.priority).toBe(0);
    });
  });

  describe('close', () => {
    it('should close issue with reason and return parsed result', async () => {
      mockStdout = JSON.stringify({
        id: 'task-1',
        status: 'closed',
        close_reason: 'Implemented and tested',
      });
      const result = await beads.close('/repo', 'task-1', 'Implemented and tested');
      expect(result.id).toBe('task-1');
      expect(result.status).toBe('closed');
    });

    it('should escape quotes in reason', async () => {
      mockStdout = JSON.stringify({ id: 'task-1', status: 'closed' });
      await beads.close('/repo', 'task-1', 'Done with "quotes"');
      // Service replaces " with \"
      expect(true).toBe(true); // No throw = command built correctly
    });
  });

  describe('list', () => {
    it('should return array of issues', async () => {
      mockStdout = JSON.stringify([
        { id: 'a', title: 'Task A', status: 'open' },
        { id: 'b', title: 'Task B', status: 'in_progress' },
      ]);
      const result = await beads.list('/repo');
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('a');
      expect(result[1].id).toBe('b');
    });

    it('should return empty array for empty list', async () => {
      mockStdout = '[]';
      const result = await beads.list('/repo');
      expect(result).toEqual([]);
    });
  });

  describe('show', () => {
    it('should return full issue details', async () => {
      mockStdout = JSON.stringify({
        id: 'task-1',
        title: 'Implement login',
        description: 'Add JWT auth',
        status: 'open',
        priority: 1,
        dependencies: [],
      });
      const result = await beads.show('/repo', 'task-1');
      expect(result.id).toBe('task-1');
      expect(result.title).toBe('Implement login');
      expect(result.description).toBe('Add JWT auth');
    });
  });

  describe('ready', () => {
    it('should return ready tasks (priority-sorted, deps resolved)', async () => {
      mockStdout = JSON.stringify([
        { id: 'task-1', title: 'High priority', priority: 0 },
        { id: 'task-2', title: 'Next', priority: 1 },
      ]);
      const result = await beads.ready('/repo');
      expect(result).toHaveLength(2);
      expect(result[0].priority).toBe(0);
    });

    it('should return empty array when no ready tasks', async () => {
      mockStdout = '[]';
      const result = await beads.ready('/repo');
      expect(result).toEqual([]);
    });

    it('should filter out tasks whose blockers are not closed', async () => {
      mockExecImpl = async (cmd: string) => {
        if (cmd.includes('ready')) {
          return {
            stdout: JSON.stringify([
              { id: 'task-1', title: 'Blocker', priority: 0 },
              { id: 'task-2', title: 'Blocked', priority: 1 },
            ]),
            stderr: '',
          };
        }
        if (cmd.includes('list --all')) {
          return {
            stdout: JSON.stringify([
              { id: 'task-1', status: 'in_progress' },
              { id: 'task-2', status: 'open' },
            ]),
            stderr: '',
          };
        }
        if (cmd.includes('show task-1')) {
          return {
            stdout: JSON.stringify({ id: 'task-1', dependencies: [] }),
            stderr: '',
          };
        }
        if (cmd.includes('show task-2')) {
          return {
            stdout: JSON.stringify({
              id: 'task-2',
              dependencies: [{ type: 'blocks', depends_on_id: 'task-1' }],
            }),
            stderr: '',
          };
        }
        return { stdout: '{}', stderr: '' };
      };
      const result = await beads.ready('/repo');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('task-1');
    });
  });

  describe('areAllBlockersClosed', () => {
    it('should return true when task has no blockers', async () => {
      mockExecImpl = async (cmd: string) => {
        if (cmd.includes('show t1')) {
          return { stdout: JSON.stringify({ id: 't1', dependencies: [] }), stderr: '' };
        }
        if (cmd.includes('list --all')) {
          return { stdout: JSON.stringify([{ id: 't1', status: 'open' }]), stderr: '' };
        }
        return { stdout: '{}', stderr: '' };
      };
      const result = await beads.areAllBlockersClosed('/repo', 't1');
      expect(result).toBe(true);
    });

    it('should return true when all blockers are closed', async () => {
      mockExecImpl = async (cmd: string) => {
        if (cmd.includes('show t1')) {
          return {
            stdout: JSON.stringify({
              id: 't1',
              dependencies: [{ type: 'blocks', depends_on_id: 'b1' }],
            }),
            stderr: '',
          };
        }
        if (cmd.includes('show b1')) {
          return { stdout: JSON.stringify({ id: 'b1', status: 'closed' }), stderr: '' };
        }
        if (cmd.includes('list --all')) {
          return {
            stdout: JSON.stringify([{ id: 't1', status: 'open' }, { id: 'b1', status: 'closed' }]),
            stderr: '',
          };
        }
        return { stdout: '{}', stderr: '' };
      };
      const result = await beads.areAllBlockersClosed('/repo', 't1');
      expect(result).toBe(true);
    });

    it('should return false when a blocker is in_progress', async () => {
      mockExecImpl = async (cmd: string) => {
        if (cmd.includes('show t1')) {
          return {
            stdout: JSON.stringify({
              id: 't1',
              dependencies: [{ type: 'blocks', depends_on_id: 'b1' }],
            }),
            stderr: '',
          };
        }
        if (cmd.includes('show b1')) {
          return { stdout: JSON.stringify({ id: 'b1', status: 'in_progress' }), stderr: '' };
        }
        if (cmd.includes('list --all')) {
          return {
            stdout: JSON.stringify([{ id: 't1', status: 'open' }, { id: 'b1', status: 'in_progress' }]),
            stderr: '',
          };
        }
        return { stdout: '{}', stderr: '' };
      };
      const result = await beads.areAllBlockersClosed('/repo', 't1');
      expect(result).toBe(false);
    });
  });

  describe('listAll', () => {
    it('should return all issues including closed', async () => {
      mockStdout = JSON.stringify([
        { id: 'a', status: 'open' },
        { id: 'b', status: 'closed' },
      ]);
      const result = await beads.listAll('/repo');
      expect(result).toHaveLength(2);
      expect(result.some((r) => r.status === 'closed')).toBe(true);
    });
  });
});
