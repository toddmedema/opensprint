import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../websocket/index.js', () => ({
  broadcastToProject: vi.fn(),
}));

const mockGetSettings = vi.fn();

vi.mock('../services/project.service.js', () => {
  return {
    ProjectService: vi.fn().mockImplementation(() => ({
      getSettings: (...args: unknown[]) => mockGetSettings(...args),
    })),
  };
});

// Import after mocks are set up
const { HilService } = await import('../services/hil-service.js');
const { broadcastToProject } = await import('../websocket/index.js');

describe('HilService', () => {
  let hilService: InstanceType<typeof HilService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockResolvedValue({
      hilConfig: {
        scopeChanges: 'requires_approval',
        architectureDecisions: 'requires_approval',
        dependencyModifications: 'automated',
      },
    });
    hilService = new HilService();
  });

  it('should auto-approve automated decisions', async () => {
    const result = await hilService.evaluateDecision(
      'test-project',
      'dependencyModifications',
      'Reordering tasks',
    );
    expect(result.approved).toBe(true);
  });

  it('should auto-approve notify-and-proceed decisions', async () => {
    mockGetSettings.mockResolvedValue({
      hilConfig: {
        scopeChanges: 'notify_and_proceed',
        architectureDecisions: 'notify_and_proceed',
        dependencyModifications: 'automated',
      },
    });

    const hil = new HilService();
    const result = await hil.evaluateDecision(
      'test-project',
      'scopeChanges',
      'Adding a new feature',
    );
    expect(result.approved).toBe(true);
  });

  it('should wait for approval on requires_approval decisions', async () => {
    const promise = hilService.evaluateDecision(
      'test-project',
      'scopeChanges',
      'Removing a feature',
    );

    await new Promise((r) => setTimeout(r, 10));

    const pending = hilService.getPendingRequests('test-project');
    expect(pending).toHaveLength(1);

    hilService.respondToRequest(pending[0].id, true, 'Approved');

    const result = await promise;
    expect(result.approved).toBe(true);
    expect(result.notes).toBe('Approved');
  });

  it('should always treat testFailuresAndRetries as automated (PRD §6.5.1)', async () => {
    const result = await hilService.evaluateDecision(
      'test-project',
      'testFailuresAndRetries',
      'Task failed after retry limit',
      undefined,
      false,
    );
    expect(result.approved).toBe(false);
  });

  it('should handle rejection', async () => {
    const promise = hilService.evaluateDecision(
      'test-project',
      'scopeChanges',
      'Big scope change',
    );

    await new Promise((r) => setTimeout(r, 10));

    const pending = hilService.getPendingRequests('test-project');
    expect(pending).toHaveLength(1);
    hilService.respondToRequest(pending[0].id, false, 'Too risky');

    const result = await promise;
    expect(result.approved).toBe(false);
    expect(result.notes).toBe('Too risky');
  });

  it('should include scopeChangeMetadata in broadcast when provided', async () => {
    const promise = hilService.evaluateDecision(
      'test-project',
      'scopeChanges',
      'Add mobile support',
      undefined,
      true,
      {
        scopeChangeSummary: '• feature_list: Add mobile app\n• technical_architecture: Mobile stack',
        scopeChangeProposedUpdates: [
          { section: 'feature_list', changeLogEntry: 'Add mobile app' },
          { section: 'technical_architecture', changeLogEntry: 'Mobile stack' },
        ],
      },
    );

    await new Promise((r) => setTimeout(r, 10));

    expect(broadcastToProject).toHaveBeenCalledWith(
      'test-project',
      expect.objectContaining({
        type: 'hil.request',
        category: 'scopeChanges',
        scopeChangeSummary: '• feature_list: Add mobile app\n• technical_architecture: Mobile stack',
        scopeChangeProposedUpdates: [
          { section: 'feature_list', changeLogEntry: 'Add mobile app' },
          { section: 'technical_architecture', changeLogEntry: 'Mobile stack' },
        ],
      }),
    );

    const pending = hilService.getPendingRequests('test-project');
    hilService.respondToRequest(pending[0].id, true);
    await promise;
  });
});
