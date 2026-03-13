import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MergeCoordinatorHost, MergeSlot } from "../services/merge-coordinator.service.js";
import { MergeCoordinatorService } from "../services/merge-coordinator.service.js";
import { OrchestratorService } from "../services/orchestrator.service.js";
import { BranchManager } from "../services/branch-manager.js";
import { TaskExecutionDiagnosticsService } from "../services/task-execution-diagnostics.service.js";

const mockShellExec = vi.fn();
const mockGetMergeQualityGateCommands = vi.fn();
const mockEventAppend = vi.fn();
const mockEventReadForTask = vi.fn();

vi.mock("../services/task-store.service.js", () => ({
  taskStore: {},
  TaskStoreService: class {},
  resolveEpicId: () => null,
}));

vi.mock("../utils/shell-exec.js", () => ({
  shellExec: (...args: unknown[]) => mockShellExec(...args),
}));

vi.mock("../services/merge-quality-gates.js", () => ({
  getMergeQualityGateCommands: (...args: unknown[]) => mockGetMergeQualityGateCommands(...args),
}));

vi.mock("../services/event-log.service.js", () => ({
  eventLogService: {
    append: (...args: unknown[]) => mockEventAppend(...args),
    readForTask: (...args: unknown[]) => mockEventReadForTask(...args),
  },
}));

vi.mock("../services/notification.service.js", () => ({
  notificationService: {
    createAgentFailed: vi.fn().mockResolvedValue({
      id: "af-1",
      projectId: "proj-1",
      source: "execute",
      sourceId: "merge-quality-gate-baseline:main",
      questions: [],
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      kind: "agent_failed",
    }),
    listByProject: vi.fn().mockResolvedValue([]),
    resolve: vi.fn().mockResolvedValue(undefined),
    createApiBlocked: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(undefined),
    resolveRateLimitNotifications: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../websocket/index.js", () => ({
  broadcastToProject: vi.fn(),
}));

vi.mock("../services/deploy-trigger.service.js", () => ({
  triggerDeployForEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/final-review.service.js", () => ({
  finalReviewService: {
    runFinalReview: vi.fn().mockResolvedValue(null),
    createTasksFromReview: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../services/self-improvement.service.js", () => ({
  selfImprovementService: {
    runIfDue: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("Cross-service quality-gate regression integration", () => {
  const projectId = "proj-1";
  const repoPath = "/tmp/repo-main";
  const worktreePath = "/tmp/repo-worktree";
  const taskId = "os-regression-1";
  const branchName = `opensprint/${taskId}`;
  const task = {
    id: taskId,
    title: "Regression integration task",
    status: "open",
    priority: 2,
    issue_type: "task",
    type: "task",
    labels: [],
    assignee: null,
    description: "",
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
  };

  let previousNodeEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    mockGetMergeQualityGateCommands.mockReturnValue(["npm run lint"]);
    mockEventAppend.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env.NODE_ENV = previousNodeEnv;
    vi.restoreAllMocks();
  });

  it("runs one repair cycle, blocks env-setup failures, and preserves structured diagnostics fields", async () => {
    const orchestrator = new OrchestratorService();
    const symlinkSpy = vi
      .spyOn(BranchManager.prototype, "symlinkNodeModules")
      .mockResolvedValue(undefined);

    let worktreeLintCalls = 0;
    mockShellExec.mockImplementation(
      async (command: string, options?: { cwd?: string }) => {
        if (command === "npm run lint" && options?.cwd === repoPath) {
          return { stdout: "baseline ok", stderr: "" };
        }
        if (command === "npm run lint" && options?.cwd === worktreePath) {
          worktreeLintCalls += 1;
          throw {
            message: "Command failed: npm run lint",
            stderr: "Cannot find module 'eslint'",
          };
        }
        if (command === "npm ci" && options?.cwd === repoPath) {
          return { stdout: "added 1 package", stderr: "" };
        }
        throw new Error(`Unexpected command: ${command} (${options?.cwd ?? "no-cwd"})`);
      }
    );

    const slot: MergeSlot = {
      taskId,
      attempt: 1,
      worktreePath,
      branchName,
      phaseResult: {
        codingDiff: "",
        codingSummary: "Done",
        testResults: null,
        testOutput: "",
      },
      agent: { outputLog: [], startedAt: new Date().toISOString() },
    };
    const state = {
      slots: new Map([[taskId, slot]]),
      status: { totalDone: 0, totalFailed: 0, queueDepth: 0 },
      globalTimers: {} as never,
    };
    const updates: Array<Record<string, unknown>> = [];
    const mockTaskStoreUpdate = vi
      .fn()
      .mockImplementation(async (_projectId: string, _id: string, fields: Record<string, unknown>) => {
        updates.push(fields);
      });

    const host: MergeCoordinatorHost = {
      getState: vi.fn().mockImplementation(() => state),
      taskStore: {
        close: vi.fn().mockResolvedValue(undefined),
        update: mockTaskStoreUpdate,
        comment: vi.fn().mockResolvedValue(undefined),
        sync: vi.fn().mockResolvedValue(undefined),
        syncForPush: vi.fn().mockResolvedValue(undefined),
        listAll: vi.fn().mockResolvedValue([]),
        show: vi.fn().mockResolvedValue(task),
        setCumulativeAttempts: vi.fn().mockResolvedValue(undefined),
        getCumulativeAttemptsFromIssue: vi.fn().mockReturnValue(0),
        setConflictFiles: vi.fn().mockResolvedValue(undefined),
        setMergeStage: vi.fn().mockResolvedValue(undefined),
        planGetByEpicId: vi.fn().mockResolvedValue(null),
      },
      branchManager: {
        waitForGitReady: vi.fn().mockResolvedValue(undefined),
        commitWip: vi.fn().mockResolvedValue(undefined),
        removeTaskWorktree: vi.fn().mockResolvedValue(undefined),
        deleteBranch: vi.fn().mockResolvedValue(undefined),
        getChangedFiles: vi.fn().mockResolvedValue([]),
        pushMain: vi.fn().mockResolvedValue(undefined),
        pushMainToOrigin: vi.fn().mockResolvedValue(undefined),
        isMergeInProgress: vi.fn().mockResolvedValue(false),
        mergeAbort: vi.fn().mockResolvedValue(undefined),
        mergeContinue: vi.fn().mockResolvedValue(undefined),
        rebaseAbort: vi.fn().mockResolvedValue(undefined),
        rebaseContinue: vi.fn().mockResolvedValue(undefined),
      },
      runMergerAgentAndWait: vi.fn().mockResolvedValue(false),
      runMergeQualityGates: (options) => orchestrator.runMergeQualityGates(options),
      sessionManager: {
        createSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
        archiveSession: vi.fn().mockResolvedValue(undefined),
      },
      fileScopeAnalyzer: {
        recordActual: vi.fn().mockResolvedValue(undefined),
      },
      feedbackService: {
        checkAutoResolveOnTaskDone: vi.fn().mockResolvedValue(undefined),
      },
      projectService: {
        getSettings: vi.fn().mockResolvedValue({
          simpleComplexityAgent: { type: "cursor", model: null },
          complexComplexityAgent: { type: "cursor", model: null },
          deployment: { mode: "custom" },
          gitWorkingMode: "worktree",
        }),
      },
      transition: vi.fn(),
      persistCounters: vi.fn().mockResolvedValue(undefined),
      nudge: vi.fn(),
    };

    const coordinator = new MergeCoordinatorService(host);
    await coordinator.performMergeAndDone(projectId, repoPath, task as never, branchName);

    expect(worktreeLintCalls).toBe(2);
    expect(
      mockShellExec.mock.calls.filter((call) => call[0] === "npm ci")
    ).toHaveLength(1);
    expect(symlinkSpy).toHaveBeenCalledTimes(1);
    expect(symlinkSpy).toHaveBeenCalledWith(repoPath, worktreePath);
    expect(mockTaskStoreUpdate).toHaveBeenCalledWith(
      projectId,
      taskId,
      expect.objectContaining({
        status: "blocked",
        extra: expect.objectContaining({
          failedGateCommand: "npm run lint",
          failedGateReason: "Command failed: npm run lint",
          failedGateOutputSnippet: "Cannot find module 'eslint'",
          worktreePath,
          qualityGateDetail: expect.objectContaining({
            command: "npm run lint",
            reason: "Command failed: npm run lint",
            outputSnippet: "Cannot find module 'eslint'",
            worktreePath,
            firstErrorLine: "Cannot find module 'eslint'",
          }),
        }),
      })
    );

    const loggedEvents = mockEventAppend.mock.calls.map(([, event]) => event);
    const mergeFailedEvent = loggedEvents.find((event) => event.event === "merge.failed");
    const taskBlockedEvent = loggedEvents.find((event) => event.event === "task.blocked");
    expect(mergeFailedEvent?.data).toEqual(
      expect.objectContaining({
        qualityGateCategory: "environment_setup",
        failedGateCommand: "npm run lint",
        qualityGateDetail: expect.objectContaining({
          command: "npm run lint",
          firstErrorLine: "Cannot find module 'eslint'",
        }),
      })
    );
    expect(taskBlockedEvent?.data).toEqual(
      expect.objectContaining({
        failedGateCommand: "npm run lint",
        nextAction: expect.stringContaining("re-link worktree node_modules"),
        qualityGateDetail: expect.objectContaining({
          command: "npm run lint",
          firstErrorLine: "Cannot find module 'eslint'",
        }),
      })
    );

    const blockedUpdate = updates.find((fields) => fields.status === "blocked");
    expect(blockedUpdate).toBeDefined();
    const blockedExtra = (blockedUpdate?.extra as Record<string, unknown>) ?? {};
    const diagnosticsTask = {
      ...task,
      status: "blocked",
      labels: ["attempts:1", "merge_stage:quality_gate"],
      block_reason: "Merge Failure",
      ...blockedExtra,
    };

    mockEventReadForTask.mockResolvedValue(
      loggedEvents.map((event) => ({
        ...event,
        taskId,
        projectId,
      }))
    );

    const diagnosticsService = new TaskExecutionDiagnosticsService(
      {
        getProject: vi.fn().mockResolvedValue({ id: projectId, repoPath }),
      } as never,
      {
        show: vi.fn().mockResolvedValue(diagnosticsTask),
        getCumulativeAttemptsFromIssue: vi.fn().mockReturnValue(1),
      } as never,
      {
        listSessions: vi.fn().mockResolvedValue([]),
      } as never
    );

    const diagnostics = await diagnosticsService.getDiagnostics(projectId, taskId);
    expect(diagnostics.latestSummary).toContain("npm run lint: Cannot find module 'eslint'");
    const mergeFailedTimelineEntry = diagnostics.timeline.find((item) =>
      item.summary.includes("repair:")
    );
    expect(mergeFailedTimelineEntry?.summary).toContain(
      "repair: npm ci -> symlinkNodeModules (succeeded)"
    );
    expect(mergeFailedTimelineEntry?.summary).toContain("category: environment_setup");
    expect(diagnostics.latestQualityGateDetail).toEqual({
      command: "npm run lint",
      reason: "Command failed: npm run lint",
      outputSnippet: "Cannot find module 'eslint'",
      worktreePath,
      firstErrorLine: "Cannot find module 'eslint'",
    });
  });

  it("requeues non-environment quality-gate failures without repair and persists structured details", async () => {
    const orchestrator = new OrchestratorService();
    const symlinkSpy = vi
      .spyOn(BranchManager.prototype, "symlinkNodeModules")
      .mockResolvedValue(undefined);

    let worktreeLintCalls = 0;
    mockShellExec.mockImplementation(
      async (command: string, options?: { cwd?: string }) => {
        if (command === "npm run lint" && options?.cwd === repoPath) {
          return { stdout: "baseline ok", stderr: "" };
        }
        if (command === "npm run lint" && options?.cwd === worktreePath) {
          worktreeLintCalls += 1;
          throw {
            message: "Command failed: npm run lint",
            stderr: "src/foo.ts: error TS2304: Cannot find name 'x'",
          };
        }
        throw new Error(`Unexpected command: ${command} (${options?.cwd ?? "no-cwd"})`);
      }
    );

    const slot: MergeSlot = {
      taskId,
      attempt: 1,
      worktreePath,
      branchName,
      phaseResult: {
        codingDiff: "",
        codingSummary: "Done",
        testResults: null,
        testOutput: "",
      },
      agent: { outputLog: [], startedAt: new Date().toISOString() },
    };
    const state = {
      slots: new Map([[taskId, slot]]),
      status: { totalDone: 0, totalFailed: 0, queueDepth: 0 },
      globalTimers: {} as never,
    };
    const updates: Array<Record<string, unknown>> = [];
    const mockTaskStoreUpdate = vi
      .fn()
      .mockImplementation(async (_projectId: string, _id: string, fields: Record<string, unknown>) => {
        updates.push(fields);
      });

    const host: MergeCoordinatorHost = {
      getState: vi.fn().mockImplementation(() => state),
      taskStore: {
        close: vi.fn().mockResolvedValue(undefined),
        update: mockTaskStoreUpdate,
        comment: vi.fn().mockResolvedValue(undefined),
        sync: vi.fn().mockResolvedValue(undefined),
        syncForPush: vi.fn().mockResolvedValue(undefined),
        listAll: vi.fn().mockResolvedValue([]),
        show: vi.fn().mockResolvedValue(task),
        setCumulativeAttempts: vi.fn().mockResolvedValue(undefined),
        getCumulativeAttemptsFromIssue: vi.fn().mockReturnValue(0),
        setConflictFiles: vi.fn().mockResolvedValue(undefined),
        setMergeStage: vi.fn().mockResolvedValue(undefined),
        planGetByEpicId: vi.fn().mockResolvedValue(null),
      },
      branchManager: {
        waitForGitReady: vi.fn().mockResolvedValue(undefined),
        commitWip: vi.fn().mockResolvedValue(undefined),
        removeTaskWorktree: vi.fn().mockResolvedValue(undefined),
        deleteBranch: vi.fn().mockResolvedValue(undefined),
        getChangedFiles: vi.fn().mockResolvedValue([]),
        pushMain: vi.fn().mockResolvedValue(undefined),
        pushMainToOrigin: vi.fn().mockResolvedValue(undefined),
        isMergeInProgress: vi.fn().mockResolvedValue(false),
        mergeAbort: vi.fn().mockResolvedValue(undefined),
        mergeContinue: vi.fn().mockResolvedValue(undefined),
        rebaseAbort: vi.fn().mockResolvedValue(undefined),
        rebaseContinue: vi.fn().mockResolvedValue(undefined),
      },
      runMergerAgentAndWait: vi.fn().mockResolvedValue(false),
      runMergeQualityGates: (options) => orchestrator.runMergeQualityGates(options),
      sessionManager: {
        createSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
        archiveSession: vi.fn().mockResolvedValue(undefined),
      },
      fileScopeAnalyzer: {
        recordActual: vi.fn().mockResolvedValue(undefined),
      },
      feedbackService: {
        checkAutoResolveOnTaskDone: vi.fn().mockResolvedValue(undefined),
      },
      projectService: {
        getSettings: vi.fn().mockResolvedValue({
          simpleComplexityAgent: { type: "cursor", model: null },
          complexComplexityAgent: { type: "cursor", model: null },
          deployment: { mode: "custom" },
          gitWorkingMode: "worktree",
        }),
      },
      transition: vi.fn(),
      persistCounters: vi.fn().mockResolvedValue(undefined),
      nudge: vi.fn(),
    };

    const coordinator = new MergeCoordinatorService(host);
    await coordinator.performMergeAndDone(projectId, repoPath, task as never, branchName);

    expect(worktreeLintCalls).toBe(1);
    expect(mockShellExec.mock.calls.filter((call) => call[0] === "npm ci")).toHaveLength(0);
    expect(symlinkSpy).not.toHaveBeenCalled();
    expect(mockTaskStoreUpdate).toHaveBeenCalledWith(
      projectId,
      taskId,
      expect.objectContaining({
        status: "open",
        extra: expect.objectContaining({
          failedGateCommand: "npm run lint",
          failedGateReason: "Command failed: npm run lint",
          failedGateOutputSnippet: "src/foo.ts: error TS2304: Cannot find name 'x'",
          worktreePath,
          qualityGateDetail: expect.objectContaining({
            command: "npm run lint",
            reason: "Command failed: npm run lint",
            outputSnippet: "src/foo.ts: error TS2304: Cannot find name 'x'",
            worktreePath,
            firstErrorLine: "src/foo.ts: error TS2304: Cannot find name 'x'",
          }),
        }),
      })
    );

    const loggedEvents = mockEventAppend.mock.calls.map(([, event]) => event);
    const mergeFailedEvent = loggedEvents.find((event) => event.event === "merge.failed");
    const taskRequeuedEvent = loggedEvents.find((event) => event.event === "task.requeued");
    expect(mergeFailedEvent?.data).toEqual(
      expect.objectContaining({
        qualityGateCategory: "quality_gate",
        failedGateCommand: "npm run lint",
        failedGateReason: "Command failed: npm run lint",
        failedGateOutputSnippet: "src/foo.ts: error TS2304: Cannot find name 'x'",
        worktreePath,
        qualityGateDetail: expect.objectContaining({
          command: "npm run lint",
          firstErrorLine: "src/foo.ts: error TS2304: Cannot find name 'x'",
        }),
      })
    );
    expect(taskRequeuedEvent?.data).toEqual(
      expect.objectContaining({
        failedGateCommand: "npm run lint",
        failedGateReason: "Command failed: npm run lint",
        failedGateOutputSnippet: "src/foo.ts: error TS2304: Cannot find name 'x'",
        worktreePath,
        qualityGateDetail: expect.objectContaining({
          command: "npm run lint",
          firstErrorLine: "src/foo.ts: error TS2304: Cannot find name 'x'",
        }),
      })
    );

    const requeuedUpdate = updates.find((fields) => fields.status === "open");
    expect(requeuedUpdate).toBeDefined();
    const requeuedExtra = (requeuedUpdate?.extra as Record<string, unknown>) ?? {};
    const diagnosticsTask = {
      ...task,
      status: "open",
      labels: ["attempts:1", "merge_stage:quality_gate"],
      ...requeuedExtra,
    };

    mockEventReadForTask.mockResolvedValue(
      loggedEvents.map((event) => ({
        ...event,
        taskId,
        projectId,
      }))
    );

    const diagnosticsService = new TaskExecutionDiagnosticsService(
      {
        getProject: vi.fn().mockResolvedValue({ id: projectId, repoPath }),
      } as never,
      {
        show: vi.fn().mockResolvedValue(diagnosticsTask),
        getCumulativeAttemptsFromIssue: vi.fn().mockReturnValue(1),
      } as never,
      {
        listSessions: vi.fn().mockResolvedValue([]),
      } as never
    );

    const diagnostics = await diagnosticsService.getDiagnostics(projectId, taskId);
    expect(diagnostics.latestSummary).toContain(
      "npm run lint: src/foo.ts: error TS2304: Cannot find name 'x'"
    );
    expect(diagnostics.latestSummary).not.toContain("repair:");
    expect(diagnostics.latestQualityGateDetail).toEqual({
      command: "npm run lint",
      reason: "Command failed: npm run lint",
      outputSnippet: "src/foo.ts: error TS2304: Cannot find name 'x'",
      worktreePath,
      firstErrorLine: "src/foo.ts: error TS2304: Cannot find name 'x'",
    });
  });
});
