import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../websocket/index.js", () => ({
  broadcastToProject: vi.fn(),
}));

vi.mock("../services/task-store.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/task-store.service.js")>();
  const { createTestPostgresClient } = await import("./test-db-helper.js");
  const dbResult = await createTestPostgresClient();
  if (!dbResult) {
    return {
      ...actual,
      TaskStoreService: class {
        constructor() {
          throw new Error("Postgres required");
        }
      },
      taskStore: null,
      _postgresAvailable: false,
    };
  }
  const store = new actual.TaskStoreService(dbResult.client);
  await store.init();
  return {
    ...actual,
    TaskStoreService: class extends actual.TaskStoreService {
      constructor() {
        super(dbResult.client);
      }
    },
    taskStore: store,
    _postgresAvailable: true,
  };
});

const mockGetSettings = vi.fn();
const mockCreateHilApproval = vi.fn();

vi.mock("../services/project.service.js", () => {
  return {
    ProjectService: vi.fn().mockImplementation(() => ({
      getSettings: (...args: unknown[]) => mockGetSettings(...args),
    })),
  };
});

vi.mock("../services/notification.service.js", () => ({
  notificationService: {
    createHilApproval: (...args: unknown[]) => mockCreateHilApproval(...args),
  },
}));

// Import after mocks are set up
const { HilService } = await import("../services/hil-service.js");
const { broadcastToProject } = await import("../websocket/index.js");

const hilTaskStoreMod = await import("../services/task-store.service.js");
const hilPostgresOk =
  (hilTaskStoreMod as { _postgresAvailable?: boolean })._postgresAvailable ?? false;

describe.skipIf(!hilPostgresOk)("HilService", () => {
  let hilService: InstanceType<typeof HilService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockResolvedValue({
      hilConfig: {
        scopeChanges: "requires_approval",
        architectureDecisions: "requires_approval",
        dependencyModifications: "automated",
      },
    });
    // Restore after clearAllMocks (which clears mock implementations)
    mockCreateHilApproval.mockImplementation(
      async (input: {
        description?: string;
        projectId?: string;
        source?: string;
        sourceId?: string;
      }) => ({
        id: "hil-test-123",
        projectId: input?.projectId ?? "test-project",
        source: input?.source ?? "eval",
        sourceId: input?.sourceId ?? "scope",
        questions: [
          {
            id: "q-1",
            text: input?.description ?? "Placeholder",
            createdAt: new Date().toISOString(),
          },
        ],
        status: "open",
        createdAt: new Date().toISOString(),
        resolvedAt: null,
        kind: "hil_approval",
      })
    );
    hilService = new HilService();
  });

  it("should auto-approve automated decisions", async () => {
    const result = await hilService.evaluateDecision(
      "test-project",
      "dependencyModifications",
      "Reordering tasks"
    );
    expect(result.approved).toBe(true);
  });

  it("should auto-approve notify-and-proceed decisions", async () => {
    mockGetSettings.mockResolvedValue({
      hilConfig: {
        scopeChanges: "notify_and_proceed",
        architectureDecisions: "notify_and_proceed",
        dependencyModifications: "automated",
      },
    });

    const hil = new HilService();
    const result = await hil.evaluateDecision(
      "test-project",
      "scopeChanges",
      "Adding a new feature"
    );
    expect(result.approved).toBe(true);
  });

  it("should wait for approval on requires_approval decisions", async () => {
    const promise = hilService.evaluateDecision(
      "test-project",
      "scopeChanges",
      "Removing a feature"
    );

    await new Promise((r) => setTimeout(r, 10));

    expect(broadcastToProject).toHaveBeenCalledWith(
      "test-project",
      expect.objectContaining({
        type: "notification.added",
        notification: expect.objectContaining({
          kind: "hil_approval",
          source: "eval",
          sourceId: "scope",
        }),
      })
    );

    const broadcastCall = (broadcastToProject as ReturnType<typeof vi.fn>).mock.calls[0];
    const notificationId = broadcastCall[1].notification.id;

    hilService.notifyResolved(notificationId, true);

    const result = await promise;
    expect(result.approved).toBe(true);
  });

  it("should always treat testFailuresAndRetries as automated (PRD §6.5.1)", async () => {
    const result = await hilService.evaluateDecision(
      "test-project",
      "testFailuresAndRetries",
      "Task failed after retry limit",
      undefined,
      false
    );
    expect(result.approved).toBe(false);
  });

  it("should handle rejection", async () => {
    const promise = hilService.evaluateDecision("test-project", "scopeChanges", "Big scope change");

    await new Promise((r) => setTimeout(r, 10));

    const broadcastCall = (broadcastToProject as ReturnType<typeof vi.fn>).mock.calls[0];
    const notificationId = broadcastCall[1].notification.id;

    hilService.notifyResolved(notificationId, false);

    const result = await promise;
    expect(result.approved).toBe(false);
  });

  it("should broadcast notification.added for requires_approval", async () => {
    const promise = hilService.evaluateDecision(
      "test-project",
      "scopeChanges",
      "Add mobile support",
      undefined,
      true,
      {
        scopeChangeSummary:
          "• feature_list: Add mobile app\n• technical_architecture: Mobile stack",
        scopeChangeProposedUpdates: [
          { section: "feature_list", changeLogEntry: "Add mobile app" },
          { section: "technical_architecture", changeLogEntry: "Mobile stack" },
        ],
      }
    );

    await new Promise((r) => setTimeout(r, 10));

    expect(broadcastToProject).toHaveBeenCalledWith(
      "test-project",
      expect.objectContaining({
        type: "notification.added",
        notification: expect.objectContaining({
          kind: "hil_approval",
          source: "eval",
          sourceId: "scope",
          questions: expect.arrayContaining([
            expect.objectContaining({
              text: "Add mobile support",
            }),
          ]),
        }),
      })
    );

    const broadcastCall = (broadcastToProject as ReturnType<typeof vi.fn>).mock.calls[0];
    const notificationId = broadcastCall[1].notification.id;
    hilService.notifyResolved(notificationId, true);
    await promise;
  });
});
