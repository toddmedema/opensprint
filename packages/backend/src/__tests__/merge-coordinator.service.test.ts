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

vi.mock("../services/branch-manager.js", () => {
  const RebaseConflictError = class RebaseConflictError extends Error {
    constructor(public readonly conflictedFiles: string[]) {
      super(`Rebase conflict`);
      this.name = "RebaseConflictError";
    }
  };
  return {
    RebaseConflictError,
    BranchManager: vi.fn().mockImplementation(() => ({
      waitForGitReady: vi.fn(),
      commitWip: vi.fn(),
      removeTaskWorktree: vi.fn(),
      deleteBranch: vi.fn(),
      getChangedFiles: vi.fn(),
      pushMain: vi.fn(),
      pushMainToOrigin: vi.fn(),
      isMergeInProgress: vi.fn(),
      mergeAbort: vi.fn(),
      mergeContinue: vi.fn(),
      rebaseAbort: vi.fn(),
      rebaseContinue: vi.fn(),
      updateMainFromOrigin: vi.fn(),
      rebaseOntoMain: vi.fn(),
      getDiff: vi.fn(),
    })),
  };
});

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

vi.mock("../services/deploy-trigger.service.js", () => ({
  triggerDeployForEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/final-review.service.js", () => ({
  finalReviewService: {
    runFinalReview: vi.fn(),
    createTasksFromReview: vi.fn(),
  },
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
      deployment: { mode: "custom" },
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

  it("runs final review when last task of epic completes and closes epic on pass", async () => {
    const { finalReviewService } = await import("../services/final-review.service.js");
    vi.mocked(finalReviewService.runFinalReview).mockResolvedValue({
      status: "pass",
      assessment: "Implementation meets plan scope.",
      proposedTasks: [],
    });
    mockHost.taskStore.listAll.mockResolvedValue([
      { id: "os-abc", title: "Epic", status: "open", issue_type: "epic" } as never,
      { id: "os-abc.1", title: "Task 1", status: "closed", issue_type: "task" } as never,
    ]);

    await coordinator.postCompletionAsync(projectId, repoPath, "os-abc.1");

    await vi.waitFor(() => {
      expect(finalReviewService.runFinalReview).toHaveBeenCalledWith(
        projectId,
        "os-abc",
        repoPath
      );
    });
    expect(mockHost.taskStore.close).toHaveBeenCalledWith(
      projectId,
      "os-abc",
      "All tasks done; final review passed"
    );
  });

  it("creates tasks and nudges when final review finds issues", async () => {
    const { finalReviewService } = await import("../services/final-review.service.js");
    vi.mocked(finalReviewService.runFinalReview).mockResolvedValue({
      status: "issues",
      assessment: "Missing error handling.",
      proposedTasks: [
        { title: "Add error handling", description: "Handle edge cases", priority: 1 },
      ],
    });
    vi.mocked(finalReviewService.createTasksFromReview).mockResolvedValue(["os-abc.2"]);
    mockHost.taskStore.listAll.mockResolvedValue([
      { id: "os-abc", title: "Epic", status: "open", issue_type: "epic" } as never,
      { id: "os-abc.1", title: "Task 1", status: "closed", issue_type: "task" } as never,
    ]);
    const nudge = vi.fn();
    mockHost.nudge = nudge;

    await coordinator.postCompletionAsync(projectId, repoPath, "os-abc.1");

    await vi.waitFor(() => {
      expect(finalReviewService.runFinalReview).toHaveBeenCalledWith(
        projectId,
        "os-abc",
        repoPath
      );
    });
    expect(finalReviewService.createTasksFromReview).toHaveBeenCalledWith(
      projectId,
      "os-abc",
      [{ title: "Add error handling", description: "Handle edge cases", priority: 1 }]
    );
    expect(mockHost.taskStore.close).not.toHaveBeenCalledWith(
      projectId,
      "os-abc",
      expect.any(String)
    );
    expect(nudge).toHaveBeenCalled();
  });
});
