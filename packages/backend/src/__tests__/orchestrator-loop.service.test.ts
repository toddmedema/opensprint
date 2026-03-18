import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredTask } from "../services/task-store.service.js";
import { TimerRegistry } from "../services/timer-registry.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import {
  OrchestratorLoopService,
  type LoopState,
  type OrchestratorLoopHost,
} from "../services/orchestrator-loop.service.js";

const mockHasOpenPrdSpecHilApproval = vi.fn();
const mockBroadcastToProject = vi.fn();
const mockGetNextKey = vi.fn();
const mockIsExhausted = vi.fn();
const mockClearExhausted = vi.fn();
const mockGetProviderOutageBackoff = vi.fn();
const mockGetComplexityForAgent = vi.fn();

vi.mock("../services/notification.service.js", () => ({
  notificationService: {
    hasOpenPrdSpecHilApproval: (...args: unknown[]) => mockHasOpenPrdSpecHilApproval(...args),
  },
}));

vi.mock("../websocket/index.js", () => ({
  broadcastToProject: (...args: unknown[]) => mockBroadcastToProject(...args),
}));

vi.mock("../services/api-key-resolver.service.js", () => ({
  getNextKey: (...args: unknown[]) => mockGetNextKey(...args),
}));

vi.mock("../services/api-key-exhausted.service.js", () => ({
  isExhausted: (...args: unknown[]) => mockIsExhausted(...args),
  clearExhausted: (...args: unknown[]) => mockClearExhausted(...args),
}));

vi.mock("../services/provider-outage-backoff.service.js", () => ({
  getProviderOutageBackoff: (...args: unknown[]) => mockGetProviderOutageBackoff(...args),
}));

vi.mock("../services/plan-complexity.js", () => ({
  getComplexityForAgent: (...args: unknown[]) => mockGetComplexityForAgent(...args),
}));

vi.mock("../services/orchestrator.service.js", () => ({
  orchestratorService: {
    nudge: vi.fn(),
    getActiveAgents: vi.fn(),
    getRecoveryHost: vi.fn(),
    stopTaskAndFreeSlot: vi.fn(),
  },
}));

describe("OrchestratorLoopService", () => {
  const projectId = "proj-1";
  const repoPath = "/tmp/repo";
  const customAgentConfig = { type: "custom" as const, model: null, cliCommand: "agent" };
  let state: LoopState;
  let host: OrchestratorLoopHost;
  let service: OrchestratorLoopService;
  let dispatchTask: ReturnType<typeof vi.fn>;
  let setMaxSlotsCache: ReturnType<typeof vi.fn>;

  const buildTask = (id: string): StoredTask =>
    ({
      id,
      title: `Task ${id}`,
      status: "open",
      priority: 1,
      issue_type: "task",
      assignee: null,
      labels: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      dependencies: [],
      dependent_count: 0,
    }) as StoredTask;

  beforeEach(() => {
    state = {
      slots: new Map(),
      loopRunId: 0,
      loopActive: false,
      globalTimers: new TimerRegistry(),
      status: { queueDepth: 0 },
    };

    dispatchTask = vi.fn().mockResolvedValue(undefined);
    setMaxSlotsCache = vi.fn();

    mockHasOpenPrdSpecHilApproval.mockResolvedValue(false);
    mockBroadcastToProject.mockReset();
    mockGetNextKey.mockResolvedValue(null);
    mockIsExhausted.mockReturnValue(false);
    mockClearExhausted.mockReset();
    mockGetProviderOutageBackoff.mockReturnValue(null);
    mockGetComplexityForAgent.mockResolvedValue("low");
    delete process.env.OPENSPRINT_MAX_NEW_TASKS_PER_LOOP;

    const readyTasks = [buildTask("os-1"), buildTask("os-2"), buildTask("os-3")];

    host = {
      getState: vi.fn().mockReturnValue(state),
      getStatus: vi.fn().mockResolvedValue({
        activeTasks: [],
        queueDepth: 0,
        totalDone: 0,
        totalFailed: 0,
      }),
      dispatchTask,
      removeSlot: vi.fn(),
      buildActiveTasks: vi.fn().mockReturnValue([]),
      persistCounters: vi.fn().mockResolvedValue(undefined),
      ensureApiBlockedNotificationsForExhaustedProviders: vi.fn().mockResolvedValue(undefined),
      nudge: vi.fn(),
      runLoop: vi.fn(),
      stopProject: vi.fn(),
      getProjectService: vi.fn().mockReturnValue({
        getRepoPath: vi.fn().mockResolvedValue(repoPath),
        getSettings: vi.fn().mockResolvedValue({
          gitWorkingMode: "worktree",
          maxConcurrentCoders: 3,
          unknownScopeStrategy: "conservative",
          simpleComplexityAgent: customAgentConfig,
          complexComplexityAgent: customAgentConfig,
        }),
      }),
      getTaskStore: vi.fn().mockReturnValue({
        readyWithStatusMap: vi.fn().mockResolvedValue({ tasks: readyTasks, allIssues: readyTasks }),
        update: vi.fn().mockResolvedValue(undefined),
      }),
      getTaskScheduler: vi.fn().mockReturnValue({
        selectTasks: vi.fn().mockResolvedValue(
          readyTasks.map((task) => ({
            task,
            fileScope: {
              taskId: task.id,
              files: new Set<string>(),
              directories: new Set<string>(),
            },
          }))
        ),
      }),
      getFeedbackService: vi.fn().mockReturnValue({
        claimNextPendingFeedbackId: vi.fn().mockResolvedValue(null),
        processFeedbackWithAnalyst: vi.fn().mockResolvedValue(undefined),
      }),
      getMaxSlotsCache: vi.fn().mockReturnValue(new Map<string, number>()),
      setMaxSlotsCache,
    };

    service = new OrchestratorLoopService(host);
  });

  afterEach(() => {
    state.globalTimers.clearAll();
    delete process.env.OPENSPRINT_MAX_NEW_TASKS_PER_LOOP;
  });

  it("fills all available coder slots in one loop pass by default", async () => {
    await service.runLoop(projectId);

    expect(setMaxSlotsCache).toHaveBeenCalledWith(projectId, 3);
    expect(dispatchTask).toHaveBeenCalledTimes(3);
    expect(dispatchTask).toHaveBeenNthCalledWith(
      1,
      projectId,
      repoPath,
      expect.objectContaining({ id: "os-1" }),
      2
    );
    expect(dispatchTask).toHaveBeenNthCalledWith(
      2,
      projectId,
      repoPath,
      expect.objectContaining({ id: "os-2" }),
      1
    );
    expect(dispatchTask).toHaveBeenNthCalledWith(
      3,
      projectId,
      repoPath,
      expect.objectContaining({ id: "os-3" }),
      0
    );
  });

  it("honors OPENSPRINT_MAX_NEW_TASKS_PER_LOOP when explicitly capped", async () => {
    process.env.OPENSPRINT_MAX_NEW_TASKS_PER_LOOP = "1";

    await service.runLoop(projectId);

    expect(dispatchTask).toHaveBeenCalledTimes(1);
    expect(dispatchTask).toHaveBeenCalledWith(
      projectId,
      repoPath,
      expect.objectContaining({ id: "os-1" }),
      2
    );
  });

  it("skips dispatch when the selected provider is under outage backoff", async () => {
    host.getProjectService = vi.fn().mockReturnValue({
      getRepoPath: vi.fn().mockResolvedValue(repoPath),
      getSettings: vi.fn().mockResolvedValue({
        gitWorkingMode: "worktree",
        maxConcurrentCoders: 3,
        unknownScopeStrategy: "conservative",
        simpleComplexityAgent: { type: "cursor", model: null },
        complexComplexityAgent: { type: "cursor", model: null },
      }),
    });
    mockGetProviderOutageBackoff.mockReturnValue({
      attempts: 2,
      until: "2026-03-15T12:15:00.000Z",
      reason: "Failed to reach the Cursor API",
    });

    await service.runLoop(projectId);

    expect(dispatchTask).not.toHaveBeenCalled();
    expect(host.ensureApiBlockedNotificationsForExhaustedProviders).not.toHaveBeenCalled();
  });

  it("stops the project without retrying when the project disappears mid-loop", async () => {
    host.getProjectService = vi.fn().mockReturnValue({
      getRepoPath: vi
        .fn()
        .mockRejectedValue(
          new AppError(404, ErrorCodes.PROJECT_NOT_FOUND, "Project not found", { projectId })
        ),
      getSettings: vi.fn(),
    });

    await service.runLoop(projectId);

    expect(host.stopProject).toHaveBeenCalledWith(projectId);
    expect(state.loopActive).toBe(false);
    expect(state.globalTimers.has("loop")).toBe(false);
  });

  it("treats ISSUE_NOT_FOUND as a benign task race without scheduling a retry", async () => {
    dispatchTask.mockRejectedValue(
      new AppError(404, ErrorCodes.ISSUE_NOT_FOUND, "Task not found", { issueId: "os-1" })
    );

    await service.runLoop(projectId);

    expect(host.stopProject).not.toHaveBeenCalled();
    expect(state.loopActive).toBe(false);
    expect(state.globalTimers.has("loop")).toBe(false);
  });
});
