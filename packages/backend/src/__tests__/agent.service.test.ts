import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentService } from '../services/agent.service.js';
import type { AgentConfig } from '@opensprint/shared';

const mockSpawnWithTaskFile = vi.fn();

vi.mock('../services/agent-client.js', () => ({
  AgentClient: vi.fn().mockImplementation(() => ({
    spawnWithTaskFile: mockSpawnWithTaskFile,
  })),
}));

describe('AgentService', () => {
  let service: AgentService;

  beforeEach(() => {
    service = new AgentService();
    vi.clearAllMocks();
  });

  describe('invokeReviewAgent', () => {
    it('should invoke review agent with code reviewer role per PRD §12.3', () => {
      const mockHandle = { kill: vi.fn(), pid: 12345 };
      mockSpawnWithTaskFile.mockReturnValue(mockHandle);

      const config: AgentConfig = { type: 'claude', model: 'claude-sonnet-4', cliCommand: null };
      const promptPath = '/proj/.opensprint/active/bd-a3f8.2/prompt.md';
      const onOutput = vi.fn();
      const onExit = vi.fn();

      const handle = service.invokeReviewAgent(promptPath, config, {
        cwd: '/proj',
        onOutput,
        onExit,
      });

      expect(mockSpawnWithTaskFile).toHaveBeenCalledWith(
        config,
        promptPath,
        '/proj',
        onOutput,
        onExit,
        'code reviewer'
      );
      expect(handle).toBe(mockHandle);
    });

    it('should allow override of agentRole when provided', () => {
      const mockHandle = { kill: vi.fn(), pid: 12345 };
      mockSpawnWithTaskFile.mockReturnValue(mockHandle);

      const config: AgentConfig = { type: 'cursor', model: null, cliCommand: null };
      const promptPath = '/proj/.opensprint/active/task-1/prompt.md';

      service.invokeReviewAgent(promptPath, config, {
        cwd: '/proj',
        onOutput: vi.fn(),
        onExit: vi.fn(),
        agentRole: 'senior reviewer',
      });

      expect(mockSpawnWithTaskFile).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        'senior reviewer'
      );
    });
  });
});
