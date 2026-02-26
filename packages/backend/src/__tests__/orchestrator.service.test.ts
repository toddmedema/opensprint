import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { OrchestratorService, formatReviewFeedback } from "../services/orchestrator.service.js";
import type { ReviewAgentResult } from "@opensprint/shared";

// ─── Mocks ───

const {
  mockBroadcastToProject,
  mockSendAgentOutputToProject,
  mockTaskStoreReady,
  mockTaskStoreShow,
  mockTaskStoreUpdate,
  mockTaskStoreClose,
  mockTaskStoreComment,
  mockTaskStoreHasLabel,
  mockTaskStoreAreAllBlockersClosed,
  mockTaskStoreGetCumulativeAttempts,
  mockTaskStoreSetCumulativeAttempts,
  mockTaskStoreAddLabel,
  mockTaskStoreRemoveLabel,
  mockTaskStoreExport,
  mockTaskStoreGetStatusMap,
  mockTaskStoreListAll,
  mockGetProject,
  mockGetRepoPath,
  mockGetProjectByRepoPath,
  mockGetSettings,
  mockCreateTaskWorktree,
  mockCreateOrCheckoutBranch,
  mockEnsureRepoNodeModules,
  mockRemoveTaskWorktree,
  mockDeleteBranch,
  mockGetCommitCountAhead,
  mockCaptureBranchDiff,
  mockEnsureOnMain,
  mockWaitForGitReady,
  mockSymlinkNodeModules,
  mockMergeToMain,
  mockVerifyMerge,
  mockPushMain,
  mockGetChangedFiles,
  mockCommitWip,
  mockBuildContext,
  mockAssembleTaskDirectory,
  mockGetActiveDir,
  mockReadResult,
  mockClearResult,
  mockCreateSession,
  mockArchiveSession,
  mockRunScopedTests,
  mockInvokeCodingAgent,
  mockInvokeReviewAgent,
  mockInvokeMergerAgent,
  mockRecoverOrphanedTasks,
  mockRecoverFromStaleHeartbeats,
  mockWriteJsonAtomic,
  mockGitQueueEnqueue,
  mockGitQueueEnqueueAndWait,
  mockGetComplexityForAgent,
  mockFindOrphanedAssignments,
  mockFindOrphanedAssignmentsFromWorktrees,
  mockDeleteAssignmentAt,
  mockListSessions,
  mockRunFullRecovery,
} = vi.hoisted(() => ({
  mockBroadcastToProject: vi.fn(),
  mockSendAgentOutputToProject: vi.fn(),
  mockTaskStoreReady: vi.fn(),
  mockTaskStoreShow: vi.fn(),
  mockTaskStoreUpdate: vi.fn(),
  mockTaskStoreClose: vi.fn(),
  mockTaskStoreComment: vi.fn(),
  mockTaskStoreHasLabel: vi.fn(),
  mockTaskStoreAreAllBlockersClosed: vi.fn(),
  mockTaskStoreGetCumulativeAttempts: vi.fn(),
  mockTaskStoreSetCumulativeAttempts: vi.fn(),
  mockTaskStoreAddLabel: vi.fn(),
  mockTaskStoreRemoveLabel: vi.fn(),
  mockTaskStoreExport: vi.fn().mockResolvedValue(undefined),
  mockTaskStoreGetStatusMap: vi.fn(),
  mockTaskStoreListAll: vi.fn(),
  mockGetProject: vi.fn(),
  mockGetRepoPath: vi.fn(),
  mockGetProjectByRepoPath: vi.fn().mockResolvedValue({ id: "proj-1", repoPath: "/tmp/repo" }),
  mockGetSettings: vi.fn(),
  mockCreateTaskWorktree: vi.fn(),
  mockCreateOrCheckoutBranch: vi.fn(),
  mockEnsureRepoNodeModules: vi.fn(),
  mockRemoveTaskWorktree: vi.fn(),
  mockDeleteBranch: vi.fn(),
  mockGetCommitCountAhead: vi.fn(),
  mockCaptureBranchDiff: vi.fn(),
  mockEnsureOnMain: vi.fn(),
  mockWaitForGitReady: vi.fn(),
  mockSymlinkNodeModules: vi.fn(),
  mockMergeToMain: vi.fn(),
  mockVerifyMerge: vi.fn(),
  mockPushMain: vi.fn(),
  mockGetChangedFiles: vi.fn(),
  mockCommitWip: vi.fn(),
  mockBuildContext: vi.fn(),
  mockAssembleTaskDirectory: vi.fn(),
  mockGetActiveDir: vi.fn(),
  mockReadResult: vi.fn(),
  mockClearResult: vi.fn(),
  mockCreateSession: vi.fn(),
  mockArchiveSession: vi.fn(),
  mockRunScopedTests: vi.fn(),
  mockInvokeCodingAgent: vi.fn(),
  mockInvokeReviewAgent: vi.fn(),
  mockInvokeMergerAgent: vi.fn(),
  mockRecoverOrphanedTasks: vi.fn(),
  mockRecoverFromStaleHeartbeats: vi.fn(),
  mockWriteJsonAtomic: vi.fn(),
  mockGitQueueEnqueue: vi.fn().mockResolvedValue(undefined),
  mockGitQueueEnqueueAndWait: vi.fn().mockResolvedValue(undefined),
  mockGetComplexityForAgent: vi.fn().mockResolvedValue(undefined),
  mockFindOrphanedAssignments: vi.fn(),
  mockFindOrphanedAssignmentsFromWorktrees: vi.fn().mockResolvedValue([]),
  mockDeleteAssignmentAt: vi.fn().mockResolvedValue(undefined),
  mockListSessions: vi.fn(),
  mockRunFullRecovery: vi.fn(),
}));

vi.mock("../websocket/index.js", () => ({
  broadcastToProject: (...args: unknown[]) => mockBroadcastToProject(...args),
  sendAgentOutputToProject: (...args: unknown[]) => mockSendAgentOutputToProject(...args),
}));

vi.mock("../services/task-store.service.js", () => {
  const mockDb = {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn(),
      step: vi.fn().mockReturnValue(true),
      getAsObject: vi.fn().mockReturnValue({ total_done: 0, total_failed: 0, queue_depth: 0 }),
      free: vi.fn(),
    }),
    run: vi.fn(),
  };
  const mockInstance = {
    ready: mockTaskStoreReady,
    readyWithStatusMap: vi
      .fn()
      .mockImplementation(async () => ({ tasks: await mockTaskStoreReady() })),
    syncForPush: vi.fn().mockResolvedValue(undefined),
    getDb: vi.fn().mockResolvedValue(mockDb),
    runWrite: vi.fn().mockImplementation(async (fn: (db: typeof mockDb) => void) => {
      await fn(mockDb);
    }),
    getCumulativeAttemptsFromIssue: vi.fn().mockImplementation((issue: { labels?: string[] }) => {
      const labels = (issue?.labels ?? []) as string[];
      const attemptsLabel = labels.find((l: string) => /^attempts:\d+$/.test(l));
      if (!attemptsLabel) return 0;
      const n = parseInt(attemptsLabel.split(":")[1]!, 10);
      return Number.isNaN(n) ? 0 : n;
    }),
    show: mockTaskStoreShow,
    update: mockTaskStoreUpdate,
    close: mockTaskStoreClose,
    comment: mockTaskStoreComment,
    hasLabel: mockTaskStoreHasLabel,
    areAllBlockersClosed: mockTaskStoreAreAllBlockersClosed,
    getCumulativeAttempts: mockTaskStoreGetCumulativeAttempts,
    setCumulativeAttempts: mockTaskStoreSetCumulativeAttempts,
    addLabel: mockTaskStoreAddLabel,
    removeLabel: mockTaskStoreRemoveLabel,
    export: mockTaskStoreExport,
    getStatusMap: mockTaskStoreGetStatusMap,
    listAll: mockTaskStoreListAll,
  };
  return {
    TaskStoreService: vi.fn().mockImplementation(() => mockInstance),
    taskStore: mockInstance,
  };
});

vi.mock("../services/project.service.js", () => ({
  ProjectService: vi.fn().mockImplementation(() => ({
    getProject: mockGetProject,
    getRepoPath: mockGetRepoPath,
    getProjectByRepoPath: mockGetProjectByRepoPath,
    getSettings: mockGetSettings,
  })),
}));

vi.mock("../services/branch-manager.js", () => {
  class _RebaseConflictError extends Error {
    conflictedFiles: string[];
    constructor(conflictedFiles: string[]) {
      super(`Rebase conflict in ${conflictedFiles.length} file(s)`);
      this.name = "RebaseConflictError";
      this.conflictedFiles = conflictedFiles;
    }
  }
  return {
    RebaseConflictError: _RebaseConflictError,
    BranchManager: vi.fn().mockImplementation(() => ({
      createTaskWorktree: mockCreateTaskWorktree,
      createOrCheckoutBranch: mockCreateOrCheckoutBranch,
      ensureRepoNodeModules: mockEnsureRepoNodeModules,
      removeTaskWorktree: mockRemoveTaskWorktree,
      deleteBranch: mockDeleteBranch,
      getCommitCountAhead: mockGetCommitCountAhead,
      captureBranchDiff: mockCaptureBranchDiff,
      captureUncommittedDiff: vi.fn().mockResolvedValue(""),
      ensureOnMain: mockEnsureOnMain,
      waitForGitReady: mockWaitForGitReady,
      symlinkNodeModules: mockSymlinkNodeModules,
      mergeToMain: mockMergeToMain,
      verifyMerge: mockVerifyMerge,
      pushMain: mockPushMain,
      pushMainToOrigin: vi.fn().mockResolvedValue(undefined),
      getChangedFiles: mockGetChangedFiles,
      getConflictedFiles: vi.fn().mockResolvedValue([]),
      getConflictDiff: vi.fn().mockResolvedValue(""),
      rebaseOntoMain: vi.fn().mockResolvedValue(undefined),
      rebaseContinue: vi.fn().mockResolvedValue(undefined),
      rebaseAbort: vi.fn().mockResolvedValue(undefined),
      isRebaseInProgress: vi.fn().mockResolvedValue(false),
      isMergeInProgress: vi.fn().mockResolvedValue(false),
      mergeContinue: vi.fn().mockResolvedValue(undefined),
      mergeAbort: vi.fn().mockResolvedValue(undefined),
      commitWip: mockCommitWip,
      getWorktreeBasePath: vi.fn().mockReturnValue(path.join(os.tmpdir(), "opensprint-worktrees")),
      getWorktreePath: vi
        .fn()
        .mockImplementation((taskId: string) =>
          path.join(os.tmpdir(), "opensprint-worktrees", taskId)
        ),
    })),
  };
});

vi.mock("../services/context-assembler.js", () => ({
  ContextAssembler: vi.fn().mockImplementation(() => ({
    buildContext: mockBuildContext,
    assembleTaskDirectory: mockAssembleTaskDirectory,
    generateMergeConflictPrompt: vi.fn().mockReturnValue("# Resolve Rebase Conflicts\n"),
  })),
}));

vi.mock("../services/session-manager.js", () => ({
  SessionManager: vi.fn().mockImplementation(() => ({
    getActiveDir: mockGetActiveDir,
    readResult: mockReadResult,
    clearResult: mockClearResult,
    createSession: mockCreateSession,
    archiveSession: mockArchiveSession,
    listSessions: mockListSessions,
  })),
}));

vi.mock("../services/test-runner.js", () => ({
  TestRunner: vi.fn().mockImplementation(() => ({
    runScopedTests: mockRunScopedTests,
  })),
}));

vi.mock("../services/agent.service.js", () => ({
  agentService: {
    invokeCodingAgent: mockInvokeCodingAgent,
    invokeReviewAgent: mockInvokeReviewAgent,
    invokeMergerAgent: mockInvokeMergerAgent,
  },
}));

vi.mock("../services/deployment-service.js", () => ({
  deploymentService: { deploy: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../services/orphan-recovery.service.js", () => ({
  orphanRecoveryService: {
    recoverOrphanedTasks: mockRecoverOrphanedTasks,
    recoverFromStaleHeartbeats: mockRecoverFromStaleHeartbeats,
  },
}));

vi.mock("../services/recovery.service.js", () => ({
  recoveryService: {
    runFullRecovery: mockRunFullRecovery,
  },
}));

vi.mock("../services/heartbeat.service.js", () => ({
  heartbeatService: {
    writeHeartbeat: vi.fn().mockResolvedValue(undefined),
    deleteHeartbeat: vi.fn().mockResolvedValue(undefined),
    readHeartbeat: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("../services/git-commit-queue.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/git-commit-queue.service.js")>();
  return {
    ...actual,
    gitCommitQueue: {
      enqueue: mockGitQueueEnqueue,
      enqueueAndWait: mockGitQueueEnqueueAndWait,
      drain: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock("../utils/file-utils.js", () => ({
  writeJsonAtomic: (...args: unknown[]) => mockWriteJsonAtomic(...args),
}));

vi.mock("../services/plan-complexity.js", () => ({
  getComplexityForAgent: (...args: unknown[]) => mockGetComplexityForAgent(...args),
}));

vi.mock("../services/crash-recovery.service.js", () => ({
  CrashRecoveryService: vi.fn().mockImplementation(() => ({
    findOrphanedAssignments: mockFindOrphanedAssignments,
    findOrphanedAssignmentsFromWorktrees: mockFindOrphanedAssignmentsFromWorktrees,
    deleteAssignmentAt: mockDeleteAssignmentAt,
  })),
}));

const mockListPendingFeedbackIds = vi.fn().mockResolvedValue([]);
const mockGetNextPendingFeedbackId = vi.fn().mockResolvedValue(null);
const mockClaimNextPendingFeedbackId = vi.fn().mockResolvedValue(null);
vi.mock("../services/feedback.service.js", () => ({
  FeedbackService: vi.fn().mockImplementation(() => ({
    listPendingFeedbackIds: (...args: unknown[]) => mockListPendingFeedbackIds(...args),
    getNextPendingFeedbackId: (...args: unknown[]) => mockGetNextPendingFeedbackId(...args),
    claimNextPendingFeedbackId: (...args: unknown[]) => mockClaimNextPendingFeedbackId(...args),
    processFeedbackWithAnalyst: vi.fn().mockResolvedValue(undefined),
    removeFromInbox: vi.fn().mockResolvedValue(undefined),
    checkAutoResolveOnTaskDone: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ─── Tests ───

describe("OrchestratorService (slot-based model)", () => {
  let orchestrator: OrchestratorService;
  let repoPath: string;
  const projectId = "test-project-1";

  const defaultSettings = {
    testFramework: "vitest",
    simpleComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
    complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
    reviewMode: "never",
    deployment: { autoDeployOnEpicCompletion: false, autoResolveFeedbackOnTaskCompletion: false },
    maxConcurrentCoders: 1,
    gitWorkingMode: "worktree" as const,
  };

  const makeTask = (id: string, title = `Task ${id}`) => ({
    id,
    title,
    status: "open",
    priority: 2,
    issue_type: "task",
    type: "task",
    labels: [],
    assignee: null,
    description: "",
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
  });

  /**
   * Helper to simulate a full single-task dispatch:
   * taskStore.ready returns one task, agent lifecycle fires onDone callback with
   * a successful coding result.
   */
  function setupSingleTaskFlow(taskId = "task-1") {
    const task = makeTask(taskId);
    const wtPath = `/tmp/opensprint-worktrees/${taskId}`;

    mockTaskStoreReady.mockResolvedValue([task]);
    mockTaskStoreAreAllBlockersClosed.mockResolvedValue(true);
    mockTaskStoreGetCumulativeAttempts.mockResolvedValue(0);
    mockCreateTaskWorktree.mockResolvedValue(wtPath);
    mockGetActiveDir.mockReturnValue(`${wtPath}/.opensprint/active/${taskId}`);
    mockWriteJsonAtomic.mockResolvedValue(undefined);

    let capturedOnDone: ((code: number | null) => Promise<void>) | undefined;
    mockInvokeCodingAgent.mockImplementation(
      (_prompt: string, _config: unknown, opts: { onExit: (code: number | null) => void }) => {
        capturedOnDone = opts.onExit as (code: number | null) => Promise<void>;
        return { kill: vi.fn(), pid: 12345 };
      }
    );

    return { task, wtPath, getOnDone: () => capturedOnDone! };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    orchestrator = new OrchestratorService();

    repoPath = path.join(os.tmpdir(), `orchestrator-test-${Date.now()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await fs.mkdir(path.join(repoPath, ".opensprint"), { recursive: true });

    mockGetProject.mockResolvedValue({ id: projectId });
    mockGetRepoPath.mockResolvedValue(repoPath);
    mockGetSettings.mockResolvedValue(defaultSettings);
    mockRecoverOrphanedTasks.mockResolvedValue({ recovered: [] });
    mockRecoverFromStaleHeartbeats.mockResolvedValue({ recovered: [] });
    mockFindOrphanedAssignments.mockResolvedValue([]);
    mockRunFullRecovery.mockResolvedValue({ reattached: [], requeued: [], cleaned: [] });
    mockTaskStoreGetStatusMap.mockResolvedValue(new Map());
    mockTaskStoreListAll.mockResolvedValue([]);
    mockCaptureBranchDiff.mockResolvedValue("");
    mockCommitWip.mockResolvedValue(undefined);
    mockRemoveTaskWorktree.mockResolvedValue(undefined);
    mockDeleteBranch.mockResolvedValue(undefined);
    mockTaskStoreComment.mockResolvedValue(undefined);
    mockTaskStoreUpdate.mockResolvedValue(undefined);
    mockTaskStoreClose.mockResolvedValue(undefined);
    mockTaskStoreSetCumulativeAttempts.mockResolvedValue(undefined);
    mockCreateSession.mockResolvedValue({ id: "sess-default" });
    mockArchiveSession.mockResolvedValue(undefined);
    mockGetChangedFiles.mockResolvedValue([]);
    mockEnsureOnMain.mockResolvedValue(undefined);
    mockWaitForGitReady.mockResolvedValue(undefined);
    mockPushMain.mockResolvedValue(undefined);
    mockMergeToMain.mockResolvedValue(undefined);
    mockRunScopedTests.mockResolvedValue({ passed: 0, failed: 0, rawOutput: "" });
    mockListSessions.mockResolvedValue([]);
    mockBuildContext.mockResolvedValue({
      prdExcerpt: "",
      planContent: "",
      dependencyOutputs: [],
      taskDescription: "",
    });
  });

  afterEach(async () => {
    orchestrator.stopProject(projectId);
    try {
      await fs.rm(repoPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("formatReviewFeedback (exported helper)", () => {
    it("formats result with summary only", () => {
      const result: ReviewAgentResult = {
        status: "rejected",
        summary: "Tests do not adequately cover the ticket scope.",
        notes: "",
      };
      expect(formatReviewFeedback(result)).toBe("Tests do not adequately cover the ticket scope.");
    });

    it("formats result with summary and issues", () => {
      const result: ReviewAgentResult = {
        status: "rejected",
        summary: "Implementation has quality issues.",
        issues: ["Missing error handling", "Tests do not cover edge cases"],
        notes: "",
      };
      const formatted = formatReviewFeedback(result);
      expect(formatted).toContain("Implementation has quality issues.");
      expect(formatted).toContain("Issues to address:");
    });

    it("handles missing summary gracefully", () => {
      const result = { status: "rejected" } as unknown as ReviewAgentResult;
      expect(formatReviewFeedback(result)).toBe(
        "Review rejected (no details provided by review agent)."
      );
    });
  });

  describe("ensureRunning", () => {
    it("returns status with empty activeTasks when idle", async () => {
      mockTaskStoreReady.mockResolvedValue([]);
      const status = await orchestrator.ensureRunning(projectId);
      expect(status.activeTasks).toEqual([]);
      expect(status.queueDepth).toBe(0);
    });

    it("runs unified recovery on startup", async () => {
      mockTaskStoreReady.mockResolvedValue([]);
      await orchestrator.ensureRunning(projectId);
      expect(mockRunFullRecovery).toHaveBeenCalledWith(
        projectId,
        repoPath,
        expect.objectContaining({
          getSlottedTaskIds: expect.any(Function),
          getActiveAgentIds: expect.any(Function),
          reattachSlot: expect.any(Function),
          removeStaleSlot: expect.any(Function),
        }),
        { includeGupp: true }
      );
    });

    it("reports requeued tasks from recovery in totalFailed", async () => {
      mockTaskStoreReady.mockResolvedValue([]);
      mockRunFullRecovery.mockResolvedValueOnce({
        reattached: [],
        requeued: ["task-orphan"],
        cleaned: [],
      });

      const status = await orchestrator.ensureRunning(projectId);
      expect(status.totalFailed).toBeGreaterThanOrEqual(1);
    });
  });

  describe("single task dispatch (maxConcurrentCoders=1)", () => {
    it("creates a slot, spawns agent, writes assignment.json", async () => {
      const { task } = setupSingleTaskFlow();
      mockTaskStoreReady.mockResolvedValueOnce([task]);

      await orchestrator.ensureRunning(projectId);

      // nudge() fires runLoop() without awaiting — flush microtask queue
      await vi.waitFor(() => {
        expect(mockWriteJsonAtomic).toHaveBeenCalled();
      });

      // Should broadcast execute.status with activeTasks
      expect(mockBroadcastToProject).toHaveBeenCalledWith(
        projectId,
        expect.objectContaining({
          type: "execute.status",
          activeTasks: expect.arrayContaining([
            expect.objectContaining({ taskId: "task-1", phase: "coding" }),
          ]),
        })
      );

      // Should write assignment.json
      expect(mockWriteJsonAtomic).toHaveBeenCalledWith(
        expect.stringContaining("assignment.json"),
        expect.objectContaining({
          taskId: "task-1",
          phase: "coding",
          branchName: "opensprint/task-1",
        })
      );
    });

    it("branches mode: uses createOrCheckoutBranch, skips symlinkNodeModules when wtPath=repoPath", async () => {
      mockGetSettings.mockImplementation(async () => ({
        ...defaultSettings,
        gitWorkingMode: "branches",
      }));
      const { task } = setupSingleTaskFlow("task-branches");
      mockGetActiveDir.mockImplementation((base: string, tid: string) =>
        path.join(base, ".opensprint", "active", tid)
      );
      mockTaskStoreReady.mockResolvedValueOnce([task]);

      await orchestrator.ensureRunning(projectId);

      await vi.waitFor(() => {
        expect(mockWriteJsonAtomic).toHaveBeenCalled();
      });

      expect(mockCreateOrCheckoutBranch).toHaveBeenCalledWith(repoPath, "opensprint/task-branches");
      expect(mockCreateTaskWorktree).not.toHaveBeenCalled();
      expect(mockSymlinkNodeModules).not.toHaveBeenCalled();
      expect(mockEnsureRepoNodeModules).toHaveBeenCalledWith(repoPath);
    });
  });

  describe("branches mode maxSlots=1", () => {
    it("enforces maxSlots=1 regardless of maxConcurrentCoders when gitWorkingMode is branches", async () => {
      const task1 = makeTask("task-1");
      const task2 = makeTask("task-2");

      mockGetSettings.mockResolvedValue({
        ...defaultSettings,
        gitWorkingMode: "branches",
        maxConcurrentCoders: 3,
      });
      mockTaskStoreReady.mockResolvedValue([task1, task2]);
      mockCreateOrCheckoutBranch.mockResolvedValue(undefined);
      mockGetActiveDir.mockReturnValue(`${repoPath}/.opensprint/active/task-1`);
      mockWriteJsonAtomic.mockResolvedValue(undefined);

      let _capturedOnDone: ((code: number | null) => Promise<void>) | undefined;
      mockInvokeCodingAgent.mockImplementation(
        (_prompt: string, _config: unknown, opts: { onExit: (code: number | null) => void }) => {
          _capturedOnDone = opts.onExit as (code: number | null) => Promise<void>;
          return { kill: vi.fn(), pid: 12345 };
        }
      );

      await orchestrator.ensureRunning(projectId);

      await vi.waitFor(() => {
        expect(mockWriteJsonAtomic).toHaveBeenCalled();
      });

      // With branches mode, maxSlots=1; only one task dispatched via createOrCheckoutBranch (no worktree)
      expect(mockCreateOrCheckoutBranch).toHaveBeenCalledTimes(1);
      expect(mockBroadcastToProject).toHaveBeenCalledWith(
        projectId,
        expect.objectContaining({
          type: "execute.status",
          activeTasks: expect.arrayContaining([
            expect.objectContaining({ taskId: "task-1", phase: "coding" }),
          ]),
        })
      );
    });
  });

  describe("getStatus", () => {
    it("returns activeTasks array from current slots", async () => {
      mockTaskStoreReady.mockResolvedValue([]);
      await orchestrator.ensureRunning(projectId);
      const status = await orchestrator.getStatus(projectId);
      expect(status).toHaveProperty("activeTasks");
      expect(Array.isArray(status.activeTasks)).toBe(true);
    });
  });

  describe("getLiveOutput", () => {
    it("returns empty for unknown task", async () => {
      mockTaskStoreReady.mockResolvedValue([]);
      await orchestrator.ensureRunning(projectId);
      const output = await orchestrator.getLiveOutput(projectId, "nonexistent");
      expect(output).toBe("");
    });
  });

  describe("stopProject", () => {
    it("clears all slots and timers", async () => {
      mockTaskStoreReady.mockResolvedValue([]);
      await orchestrator.ensureRunning(projectId);
      orchestrator.stopProject(projectId);
      const status = await orchestrator.getStatus(projectId);
      expect(status.activeTasks).toEqual([]);
    });
  });

  describe("getActiveAgents", () => {
    it("returns empty array when no agents are running", async () => {
      mockTaskStoreReady.mockResolvedValue([]);
      await orchestrator.ensureRunning(projectId);
      const agents = await orchestrator.getActiveAgents(projectId);
      expect(agents).toEqual([]);
    });

    it("reconciles stale slots: removes slot when task no longer in task store", async () => {
      const { task } = setupSingleTaskFlow("task-stale");
      mockTaskStoreReady.mockResolvedValueOnce([task]);
      // So far listAll returns [] (beforeEach). First getStatus runs reconcileStaleSlots which would remove the slot.
      // Override so listAll includes the task until we simulate archiving.
      mockTaskStoreListAll.mockResolvedValue([task]);

      await orchestrator.ensureRunning(projectId);
      await vi.waitFor(() => {
        expect(mockWriteJsonAtomic).toHaveBeenCalled();
      });

      const statusBefore = await orchestrator.getStatus(projectId);
      expect(statusBefore.activeTasks).toHaveLength(1);
      expect(statusBefore.activeTasks[0].taskId).toBe("task-stale");

      // Simulate task archived: listAll no longer returns it
      mockTaskStoreListAll.mockResolvedValue([]);

      const agents = await orchestrator.getActiveAgents(projectId);
      expect(agents).toEqual([]);

      const statusAfter = await orchestrator.getStatus(projectId);
      expect(statusAfter.activeTasks).toEqual([]);

      expect(mockBroadcastToProject).toHaveBeenCalledWith(
        projectId,
        expect.objectContaining({
          type: "execute.status",
          activeTasks: [],
        })
      );
    });
  });

  describe("stuck-loop guard", () => {
    const LOOP_STUCK_GUARD_MS = 5 * 60 * 1000;

    it("forces recovery when runLoop is blocked in an await so nudge can start a fresh loop", async () => {
      vi.useFakeTimers();
      mockTaskStoreReady.mockResolvedValue([]);
      // Block runLoop in the first await (claimNextPendingFeedbackId) so it never completes
      mockClaimNextPendingFeedbackId.mockImplementation(() => new Promise(() => {}));

      const nudgeSpy = vi.spyOn(orchestrator, "nudge");

      await orchestrator.ensureRunning(projectId);
      // ensureRunning calls nudge once at the end; runLoop started and is stuck awaiting claimNextPendingFeedbackId
      expect(nudgeSpy).toHaveBeenCalledWith(projectId);

      nudgeSpy.mockClear();
      vi.advanceTimersByTime(LOOP_STUCK_GUARD_MS + 100);
      // Guard should have fired: clear loopActive and call nudge so a fresh runLoop can start
      expect(nudgeSpy).toHaveBeenCalledWith(projectId);

      vi.useRealTimers();
    });
  });
});
