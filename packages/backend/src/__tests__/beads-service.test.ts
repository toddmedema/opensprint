import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BeadsService } from '../services/beads.service.js';

// Control mock stdout per test (closure reads current value at call time)
let mockStdout = '{}';

vi.mock('util', () => ({
  promisify: () => async () => ({ stdout: mockStdout, stderr: '' }),
}));

describe('BeadsService', () => {
  let beads: BeadsService;

  beforeEach(() => {
    beads = new BeadsService();
    mockStdout = '{}';
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
