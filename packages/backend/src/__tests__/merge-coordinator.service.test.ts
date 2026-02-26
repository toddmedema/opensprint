import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MergeCoordinatorService,
  type MergeCoordinatorHost,
  type MergeSlot,
} from "../services/merge-coordinator.service.js";
import type { StoredTask } from "../services/task-store.service.js";

vi.mock("../services/task-store.service.js", () => ({
  taskStore: {},
}));

vi.mock("../services/branch-manager.js", () => ({
  RebaseConflictError: class RebaseConflictError extends Error {
    constructor(public readonly conflictedFiles: string[]) {
      super(`Rebase conflict`);
      this.name = "RebaseConflictError";
    }
  },
}));

const mockRemoveTaskWorktree = vi.fn();
const mockDeleteBranch = vi.fn();
const mockGetSettings = vi.fn();
const mockGitQueueDrain = vi.fn();
const mockGitQueueEnqueueAndWait = vi.fn();

vi.mock("../services/git-commit-queue.service.js", () => ({
  gitCommitQueue: {
    drain: () => mockGitQueueDrain(),
    enqueueAndWait: (opts: unknown) => mockGitQueueEnqueueAndWait(opts),
  },
}));

vi.mock("../services/agent-identity.service.js", () => ({
  agentIdentityService: {
    recordAttempt: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../services/event-log.service.js", () => ({
  eventLogService: {
    append: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../websocket/index.js", () => ({
  broadcastToProject: vi.fn(),
}));

describe("MergeCoordinatorService", () => {
  let coordinator: MergeCoordinatorService;
  let mockHost: MergeCoordinatorHost;
  const projectId = "proj-1";
  const repoPath = "/tmp/repo";
  const taskId = "os-abc1";
  const branchName = `opensprint/${taskId}`;

  const makeTask = (): StoredTask => ({
    id: taskId,
    title: "Test task",
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

  const makeSlot = (worktreePath: string | null = "/tmp/worktree"): MergeSlot => ({
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
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitQueueDrain.mockResolvedValue(undefined);
    mockGitQueueEnqueueAndWait.mockResolvedValue(undefined);
    mockGetSettings.mockResolvedValue({
      simpleComplexityAgent: { type: "cursor", model: null },
      complexComplexityAgent: { type: "cursor", model: null },
      deployment: { autoDeployOnEpicCompletion: false },
      gitWorkingMode: "worktree",
    });

    mockHost = {
      getState: vi.fn().mockReturnValue({
        slots: new Map([[taskId, makeSlot()]]),
        status: { totalDone: 0, queueDepth: 0 },
        globalTimers: {},
      }),
      taskStore: {
        close: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        comment: vi.fn().mockResolvedValue(undefined),
        sync: vi.fn().mockResolvedValue(undefined),
        syncForPush: vi.fn().mockResolvedValue(undefined),
        listAll: vi.fn().mockResolvedValue([]),
        show: vi.fn().mockResolvedValue(makeTask()),
        setCumulativeAttempts: vi.fn().mockResolvedValue(undefined),
        getCumulativeAttemptsFromIssue: vi.fn().mockReturnValue(0),
      },
      branchManager: {
        waitForGitReady: vi.fn().mockResolvedValue(undefined),
        commitWip: vi.fn().mockResolvedValue(undefined),
        removeTaskWorktree: mockRemoveTaskWorktree.mockResolvedValue(undefined),
        deleteBranch: mockDeleteBranch.mockResolvedValue(undefined),
        getChangedFiles: vi.fn().mockResolvedValue([]),
        pushMain: vi.fn().mockResolvedValue(undefined),
        pushMainToOrigin: vi.fn().mockResolvedValue(undefined),
        isMergeInProgress: vi.fn().mockResolvedValue(false),
        mergeAbort: vi.fn().mockResolvedValue(undefined),
        mergeContinue: vi.fn().mockResolvedValue(undefined),
        rebaseAbort: vi.fn().mockResolvedValue(undefined),
        rebaseContinue: vi.fn().mockResolvedValue(undefined),
        updateMainFromOrigin: vi.fn().mockResolvedValue(undefined),
        rebaseOntoMain: vi.fn().mockResolvedValue(undefined),
      },
      runMergerAgentAndWait: vi.fn().mockResolvedValue(false),
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
        getSettings: mockGetSettings,
      },
      transition: vi.fn(),
      persistCounters: vi.fn().mockResolvedValue(undefined),
      nudge: vi.fn(),
    };

    coordinator = new MergeCoordinatorService(mockHost);
  });

  it("calls removeTaskWorktree when gitWorkingMode is worktree", async () => {
    mockGetSettings.mockResolvedValue({
      simpleComplexityAgent: { type: "cursor", model: null },
      complexComplexityAgent: { type: "cursor", model: null },
      deployment: {},
      gitWorkingMode: "worktree",
    });

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

    expect(mockRemoveTaskWorktree).toHaveBeenCalledWith(repoPath, taskId);
    expect(mockDeleteBranch).toHaveBeenCalledWith(repoPath, branchName);
  });

  it("skips removeTaskWorktree when gitWorkingMode is branches", async () => {
    mockGetSettings.mockResolvedValue({
      simpleComplexityAgent: { type: "cursor", model: null },
      complexComplexityAgent: { type: "cursor", model: null },
      deployment: {},
      gitWorkingMode: "branches",
    });

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

    expect(mockRemoveTaskWorktree).not.toHaveBeenCalled();
    expect(mockDeleteBranch).toHaveBeenCalledWith(repoPath, branchName);
  });

  it("skips removeTaskWorktree when gitWorkingMode is missing (defaults to worktree behavior)", async () => {
    mockGetSettings.mockResolvedValue({
      simpleComplexityAgent: { type: "cursor", model: null },
      complexComplexityAgent: { type: "cursor", model: null },
      deployment: {},
      // gitWorkingMode omitted
    });

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

    // When undefined, !== "branches" so we call removeTaskWorktree (worktree behavior)
    expect(mockRemoveTaskWorktree).toHaveBeenCalledWith(repoPath, taskId);
    expect(mockDeleteBranch).toHaveBeenCalledWith(repoPath, branchName);
  });

  it("always calls deleteBranch regardless of gitWorkingMode", async () => {
    for (const mode of ["worktree", "branches"] as const) {
      vi.clearAllMocks();
      mockRemoveTaskWorktree.mockResolvedValue(undefined);
      mockDeleteBranch.mockResolvedValue(undefined);

      mockGetSettings.mockResolvedValue({
        simpleComplexityAgent: { type: "cursor", model: null },
        complexComplexityAgent: { type: "cursor", model: null },
        deployment: {},
        gitWorkingMode: mode,
      });

      await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

      expect(mockDeleteBranch).toHaveBeenCalledWith(repoPath, branchName);
    }
  });

  it("calls updateMainFromOrigin and rebaseOntoMain before merge to avoid overwriting recent work", async () => {
    const updateMainFromOrigin = vi.fn().mockResolvedValue(undefined);
    const rebaseOntoMain = vi.fn().mockResolvedValue(undefined);
    mockHost.branchManager.updateMainFromOrigin = updateMainFromOrigin;
    mockHost.branchManager.rebaseOntoMain = rebaseOntoMain;

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

    expect(updateMainFromOrigin).toHaveBeenCalledWith(repoPath);
    expect(rebaseOntoMain).toHaveBeenCalledWith("/tmp/worktree");
    expect(mockGitQueueEnqueueAndWait).toHaveBeenCalled();
    const callOrder = [
      updateMainFromOrigin.mock.invocationCallOrder[0],
      rebaseOntoMain.mock.invocationCallOrder[0],
      mockGitQueueEnqueueAndWait.mock.invocationCallOrder[0],
    ];
    expect(callOrder[0]).toBeLessThan(callOrder[1]);
    expect(callOrder[1]).toBeLessThan(callOrder[2]);
  });

  it("requeues task when rebaseOntoMain fails with non-conflict error", async () => {
    mockHost.branchManager.rebaseOntoMain = vi.fn().mockRejectedValue(new Error("rebase conflict"));
    const rebaseAbort = vi.fn().mockResolvedValue(undefined);
    mockHost.branchManager.rebaseAbort = rebaseAbort;

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

    expect(rebaseAbort).toHaveBeenCalledWith("/tmp/worktree");
    expect(mockHost.taskStore.update).toHaveBeenCalledWith(
      projectId,
      taskId,
      expect.objectContaining({ status: "open" })
    );
    expect(mockGitQueueEnqueueAndWait).not.toHaveBeenCalled();
    expect(mockHost.runMergerAgentAndWait).not.toHaveBeenCalled();
  });

  it("invokes merger agent when rebaseOntoMain fails with RebaseConflictError", async () => {
    const runMergerAgentAndWait = vi.fn().mockResolvedValue(false);
    mockHost.runMergerAgentAndWait = runMergerAgentAndWait;
    const { RebaseConflictError } = await import("../services/branch-manager.js");
    mockHost.branchManager.rebaseOntoMain = vi
      .fn()
      .mockRejectedValue(new RebaseConflictError(["src/foo.ts"]));
    const rebaseAbort = vi.fn().mockResolvedValue(undefined);
    mockHost.branchManager.rebaseAbort = rebaseAbort;

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

    expect(runMergerAgentAndWait).toHaveBeenCalledWith(projectId, "/tmp/worktree");
    expect(rebaseAbort).toHaveBeenCalledWith("/tmp/worktree");
    expect(mockHost.taskStore.update).toHaveBeenCalledWith(
      projectId,
      taskId,
      expect.objectContaining({ status: "open" })
    );
    expect(mockGitQueueEnqueueAndWait).not.toHaveBeenCalled();
  });

  it("continues to merge when merger resolves rebase conflicts", async () => {
    const runMergerAgentAndWait = vi.fn().mockResolvedValue(true);
    mockHost.runMergerAgentAndWait = runMergerAgentAndWait;
    const { RebaseConflictError } = await import("../services/branch-manager.js");
    mockHost.branchManager.rebaseOntoMain = vi
      .fn()
      .mockRejectedValue(new RebaseConflictError(["src/foo.ts"]));
    const rebaseContinue = vi.fn().mockResolvedValue(undefined);
    mockHost.branchManager.rebaseContinue = rebaseContinue;

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

    expect(runMergerAgentAndWait).toHaveBeenCalledWith(projectId, "/tmp/worktree");
    expect(rebaseContinue).toHaveBeenCalledWith("/tmp/worktree");
    expect(mockGitQueueEnqueueAndWait).toHaveBeenCalled();
    expect(mockHost.taskStore.close).toHaveBeenCalledWith(projectId, taskId, expect.any(String));
  });
});
