import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MergeCoordinatorService,
  type MergeCoordinatorHost,
  type MergeSlot,
} from "../services/merge-coordinator.service.js";
import type { StoredTask } from "../services/task-store.service.js";

vi.mock("../services/task-store.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/task-store.service.js")>();
  return {
    taskStore: {},
    resolveEpicId: actual.resolveEpicId,
  };
});

vi.mock("../services/branch-manager.js", () => {
  class RebaseConflictError extends Error {
    constructor(public readonly conflictedFiles: string[]) {
      super(`Rebase conflict in ${conflictedFiles.length} file(s)`);
      this.name = "RebaseConflictError";
    }
  }
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
      getDiff: vi.fn(),
    })),
  };
});

const mockRemoveTaskWorktree = vi.fn();
const mockDeleteBranch = vi.fn();
const mockGetSettings = vi.fn();
const mockGitQueueDrain = vi.fn();
const mockGitQueueEnqueueAndWait = vi.fn();
const mockNotificationCreate = vi.fn();
const mockResolveBaseBranch = vi.fn();
const mockInspectGitRepoState = vi.fn();

vi.mock("../services/git-commit-queue.service.js", () => ({
  MergeJobError: class MergeJobError extends Error {
    constructor(
      message: string,
      public readonly stage: "rebase_before_merge" | "merge_to_main",
      public readonly conflictedFiles: string[],
      public readonly resolvedBy: "requeued" | "blocked" = "requeued"
    ) {
      super(message);
      this.name = "MergeJobError";
    }
  },
  gitCommitQueue: {
    drain: () => mockGitQueueDrain(),
    enqueueAndWait: (opts: unknown) => mockGitQueueEnqueueAndWait(opts),
  },
}));

vi.mock("../utils/git-repo-state.js", () => ({
  resolveBaseBranch: (...args: unknown[]) => mockResolveBaseBranch(...args),
  inspectGitRepoState: (...args: unknown[]) => mockInspectGitRepoState(...args),
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

vi.mock("../services/notification.service.js", () => ({
  notificationService: {
    create: (...args: unknown[]) => mockNotificationCreate(...args),
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
  let hostState: ReturnType<MergeCoordinatorHost["getState"]>;
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
    mockNotificationCreate.mockResolvedValue(undefined);
    mockResolveBaseBranch.mockImplementation(
      async (_repoPath: string, preferredBaseBranch?: string | null) => preferredBaseBranch ?? "main"
    );
    mockInspectGitRepoState.mockResolvedValue({
      isGitRepo: true,
      hasHead: true,
      currentBranch: "main",
      baseBranch: "main",
      hasOrigin: false,
      originReachable: false,
      remoteMode: "local_only",
      originUrl: null,
      identity: { name: "Test", email: "test@test.com", valid: true },
    });
    mockGetSettings.mockResolvedValue({
      simpleComplexityAgent: { type: "cursor", model: null },
      complexComplexityAgent: { type: "cursor", model: null },
      deployment: { mode: "custom" },
      gitWorkingMode: "worktree",
    });

    hostState = {
      slots: new Map([[taskId, makeSlot()]]),
      status: { totalDone: 0, totalFailed: 0, queueDepth: 0 },
      globalTimers: {} as never,
    };

    mockHost = {
      getState: vi.fn().mockImplementation(() => hostState),
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
        setConflictFiles: vi.fn().mockResolvedValue(undefined),
        setMergeStage: vi.fn().mockResolvedValue(undefined),
        planGetByEpicId: vi.fn().mockResolvedValue(null),
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
      transition: vi.fn().mockImplementation((_projectId, transition) => {
        if (transition.to === "complete") {
          hostState.status.totalDone += 1;
        } else {
          hostState.status.totalFailed += 1;
        }
        hostState.slots.delete(transition.taskId);
      }),
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

    await vi.waitFor(() => {
      expect(mockRemoveTaskWorktree).toHaveBeenCalledWith(repoPath, taskId, "/tmp/worktree");
      expect(mockDeleteBranch).toHaveBeenCalledWith(repoPath, branchName);
    });
  });

  it("skips removeTaskWorktree when gitWorkingMode is branches", async () => {
    mockGetSettings.mockResolvedValue({
      simpleComplexityAgent: { type: "cursor", model: null },
      complexComplexityAgent: { type: "cursor", model: null },
      deployment: {},
      gitWorkingMode: "branches",
    });

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

    await vi.waitFor(() => {
      expect(mockRemoveTaskWorktree).not.toHaveBeenCalled();
      expect(mockDeleteBranch).toHaveBeenCalledWith(repoPath, branchName);
    });
  });

  it("skips removeTaskWorktree when gitWorkingMode is missing (defaults to worktree behavior)", async () => {
    mockGetSettings.mockResolvedValue({
      simpleComplexityAgent: { type: "cursor", model: null },
      complexComplexityAgent: { type: "cursor", model: null },
      deployment: {},
      // gitWorkingMode omitted
    });

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

    await vi.waitFor(() => {
      expect(mockRemoveTaskWorktree).toHaveBeenCalledWith(repoPath, taskId, "/tmp/worktree");
      expect(mockDeleteBranch).toHaveBeenCalledWith(repoPath, branchName);
    });
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

      // Reset slot so second iteration has a slot (transition removes it each run)
      hostState.slots = new Map([[taskId, makeSlot()]]);
      mockHost.getState = vi.fn().mockImplementation(() => hostState);

      await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

      await vi.waitFor(() => {
        expect(mockDeleteBranch).toHaveBeenCalledWith(repoPath, branchName);
      });
    }
  });

  it("enqueues merge job with worktreePath so rebase happens inside the serialized queue", async () => {
    const slot = makeSlot("/tmp/worktree");
    hostState = {
      slots: new Map([[taskId, slot]]),
      status: { totalDone: 0, totalFailed: 0, queueDepth: 0 },
      globalTimers: {} as never,
    };
    mockHost.getState = vi.fn().mockImplementation(() => hostState);

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

    expect(mockGitQueueEnqueueAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "worktree_merge",
        repoPath,
        worktreePath: "/tmp/worktree",
        branchName,
        taskId,
      })
    );
  });

  it("calls triggerDeployForEvent(projectId, 'each_task') when merge to main occurs (per_task mode)", async () => {
    mockGetSettings.mockResolvedValue({
      simpleComplexityAgent: { type: "cursor", model: null },
      complexComplexityAgent: { type: "cursor", model: null },
      deployment: {},
      gitWorkingMode: "worktree",
      mergeStrategy: "per_task",
    });
    hostState.slots = new Map([[taskId, makeSlot("/tmp/worktree")]]);
    mockHost.getState = vi.fn().mockImplementation(() => hostState);

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

    const { triggerDeployForEvent } = await import("../services/deploy-trigger.service.js");
    await vi.waitFor(() => {
      expect(triggerDeployForEvent).toHaveBeenCalledWith(projectId, "each_task");
    });
  });

  it("passes worktreeBaseBranch to enqueueAndWait when worktree mode", async () => {
    mockGetSettings.mockResolvedValue({
      simpleComplexityAgent: { type: "cursor", model: null },
      complexComplexityAgent: { type: "cursor", model: null },
      deployment: {},
      gitWorkingMode: "worktree",
      worktreeBaseBranch: "develop",
    });

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

    expect(mockGitQueueEnqueueAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "worktree_merge",
        baseBranch: "develop",
      })
    );
  });

  it("passes main as baseBranch when branches mode", async () => {
    mockGetSettings.mockResolvedValue({
      simpleComplexityAgent: { type: "cursor", model: null },
      complexComplexityAgent: { type: "cursor", model: null },
      deployment: {},
      gitWorkingMode: "branches",
    });

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

    expect(mockGitQueueEnqueueAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "worktree_merge",
        baseBranch: "main",
      })
    );
  });

  it("passes baseBranch to getChangedFiles after merge succeeds", async () => {
    mockGetSettings.mockResolvedValue({
      simpleComplexityAgent: { type: "cursor", model: null },
      complexComplexityAgent: { type: "cursor", model: null },
      deployment: {},
      gitWorkingMode: "worktree",
      worktreeBaseBranch: "develop",
    });
    const mockGetChangedFiles = vi.fn().mockResolvedValue(["src/foo.ts"]);
    mockHost.branchManager.getChangedFiles = mockGetChangedFiles;

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

    expect(mockGetChangedFiles).toHaveBeenCalledWith(repoPath, branchName, "develop");
  });

  it("archives session when merge fails so task detail sidebar can show output", async () => {
    const slotWithOutput = makeSlot();
    slotWithOutput.agent.outputLog = ["Agent output line 1\n", "Agent output line 2\n"];
    hostState = {
      slots: new Map([[taskId, slotWithOutput]]),
      status: { totalDone: 0, totalFailed: 0, queueDepth: 0 },
      globalTimers: {} as never,
    };
    mockHost.getState = vi.fn().mockImplementation(() => hostState);
    mockGitQueueEnqueueAndWait.mockRejectedValue(new Error("merge conflict"));

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

    expect(mockHost.sessionManager.createSession).toHaveBeenCalledWith(
      repoPath,
      expect.objectContaining({
        taskId,
        status: "failed",
        outputLog: "Agent output line 1\nAgent output line 2\n",
        failureReason: "merge conflict",
      })
    );
    expect(mockHost.sessionManager.archiveSession).toHaveBeenCalledWith(
      repoPath,
      taskId,
      1,
      expect.anything(),
      "/tmp/worktree"
    );
    expect(mockHost.transition).toHaveBeenCalledWith(projectId, {
      to: "fail",
      taskId,
    });
  });

  it("requeues task when merge job fails", async () => {
    mockGitQueueEnqueueAndWait.mockRejectedValue(new Error("merge conflict"));

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

    expect(mockHost.taskStore.update).toHaveBeenCalledWith(
      projectId,
      taskId,
      expect.objectContaining({ status: "open" })
    );
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
      expect(finalReviewService.runFinalReview).toHaveBeenCalledWith(projectId, "os-abc", repoPath);
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
      expect(finalReviewService.runFinalReview).toHaveBeenCalledWith(projectId, "os-abc", repoPath);
    });
    expect(finalReviewService.createTasksFromReview).toHaveBeenCalledWith(projectId, "os-abc", [
      { title: "Add error handling", description: "Handle edge cases", priority: 1 },
    ]);
    expect(mockHost.taskStore.close).not.toHaveBeenCalledWith(
      projectId,
      "os-abc",
      expect.any(String)
    );
    expect(nudge).toHaveBeenCalled();
  });

  it("does not trigger each_task when postCompletionAsync is called with mergedToMain: false", async () => {
    mockHost.taskStore.listAll.mockResolvedValue([
      { id: "os-xyz.1", title: "Task", status: "closed", issue_type: "task" } as never,
    ]);

    await coordinator.postCompletionAsync(projectId, repoPath, "os-xyz.1", {
      mergedToMain: false,
    });

    const { triggerDeployForEvent } = await import("../services/deploy-trigger.service.js");
    expect(triggerDeployForEvent).not.toHaveBeenCalledWith(projectId, "each_task");
  });

  describe("push rebase conflicts", () => {
    it("resolves sequential push rebase conflicts in one push cycle", async () => {
      const { RebaseConflictError } = await import("../services/branch-manager.js");
      const firstConflict = new RebaseConflictError(["settings-a.json"]);
      const secondConflict = new RebaseConflictError(["settings-b.json"]);
      mockInspectGitRepoState.mockResolvedValue({
        isGitRepo: true,
        hasHead: true,
        currentBranch: "main",
        baseBranch: "main",
        hasOrigin: true,
        originReachable: true,
        remoteMode: "publishable",
        originUrl: "git@example.com:test/repo.git",
        identity: { name: "Test", email: "test@test.com", valid: true },
      });

      mockHost.branchManager.pushMain = vi.fn().mockRejectedValueOnce(firstConflict);
      mockHost.branchManager.rebaseContinue = vi
        .fn()
        .mockRejectedValueOnce(secondConflict)
        .mockResolvedValueOnce(undefined);
      mockHost.branchManager.pushMainToOrigin = vi.fn().mockResolvedValue(undefined);
      mockHost.runMergerAgentAndWait = vi.fn().mockResolvedValue(true);

      await coordinator.postCompletionAsync(projectId, repoPath, taskId);

      expect(mockHost.branchManager.pushMain).toHaveBeenCalledTimes(1);
      expect(mockHost.runMergerAgentAndWait).toHaveBeenCalledTimes(2);
      expect(mockHost.branchManager.rebaseContinue).toHaveBeenCalledTimes(2);
      expect(mockHost.branchManager.pushMainToOrigin).toHaveBeenCalledTimes(1);
      expect(mockHost.branchManager.rebaseAbort).not.toHaveBeenCalled();
      expect(mockNotificationCreate).not.toHaveBeenCalled();
    });

    it("aborts and reports failure after bounded push rebase rounds", async () => {
      const { RebaseConflictError } = await import("../services/branch-manager.js");
      const initialConflict = new RebaseConflictError(["settings-initial.json"]);
      mockInspectGitRepoState.mockResolvedValue({
        isGitRepo: true,
        hasHead: true,
        currentBranch: "main",
        baseBranch: "main",
        hasOrigin: true,
        originReachable: true,
        remoteMode: "publishable",
        originUrl: "git@example.com:test/repo.git",
        identity: { name: "Test", email: "test@test.com", valid: true },
      });

      mockHost.branchManager.pushMain = vi.fn().mockRejectedValueOnce(initialConflict);
      mockHost.branchManager.rebaseContinue = vi
        .fn()
        .mockRejectedValue(new RebaseConflictError(["settings-loop.json"]));
      mockHost.runMergerAgentAndWait = vi.fn().mockResolvedValue(true);

      await coordinator.postCompletionAsync(projectId, repoPath, taskId);

      expect(mockHost.runMergerAgentAndWait).toHaveBeenCalledTimes(12);
      expect(mockHost.branchManager.rebaseAbort).toHaveBeenCalledTimes(1);
      expect(mockNotificationCreate).toHaveBeenCalledTimes(1);
      expect(mockNotificationCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId,
          source: "execute",
          sourceId: "remote-publish",
        })
      );
    });
  });

  describe("per_epic intermediate completion", () => {
    const epicTaskId = "os-abc.1";
    const epicBranchName = "opensprint/epic_os-abc";

    const makeEpicTask = (): StoredTask => ({
      id: epicTaskId,
      title: "Epic task 1",
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

    it("skips merge to main when mergeStrategy is per_epic and task has epic and not all impl tasks closed", async () => {
      mockGetSettings.mockResolvedValue({
        simpleComplexityAgent: { type: "cursor", model: null },
        complexComplexityAgent: { type: "cursor", model: null },
        deployment: {},
        gitWorkingMode: "worktree",
        mergeStrategy: "per_epic",
      });
      hostState.slots = new Map([
        [
          epicTaskId,
          {
            ...makeSlot("/tmp/epic-wt"),
            taskId: epicTaskId,
            branchName: epicBranchName,
          },
        ],
      ]);
      mockHost.getState = vi.fn().mockImplementation(() => hostState);

      const epicAndTasks = [
        { id: "os-abc", title: "Epic", status: "open", issue_type: "epic" } as StoredTask,
        { id: "os-abc.1", title: "Task 1", status: "open", issue_type: "task" } as StoredTask,
        { id: "os-abc.2", title: "Task 2", status: "open", issue_type: "task" } as StoredTask,
      ];
      mockHost.taskStore.listAll
        .mockResolvedValueOnce(epicAndTasks)
        .mockResolvedValueOnce([
          { ...epicAndTasks[0] },
          { ...epicAndTasks[1], status: "closed" },
          { ...epicAndTasks[2], status: "open" },
        ]);

      await coordinator.performMergeAndDone(
        projectId,
        repoPath,
        makeEpicTask(),
        epicBranchName
      );

      expect(mockGitQueueEnqueueAndWait).not.toHaveBeenCalled();
      expect(mockHost.taskStore.close).toHaveBeenCalledWith(
        projectId,
        epicTaskId,
        expect.any(String)
      );
      expect(mockHost.feedbackService.checkAutoResolveOnTaskDone).toHaveBeenCalledWith(
        projectId,
        epicTaskId
      );
      expect(mockRemoveTaskWorktree).not.toHaveBeenCalled();
      expect(mockDeleteBranch).not.toHaveBeenCalled();
      const { triggerDeployForEvent } = await import("../services/deploy-trigger.service.js");
      expect(triggerDeployForEvent).not.toHaveBeenCalled();
    });

    it("merges epic branch to main when mergeStrategy is per_epic and last task in epic completes", async () => {
      const { finalReviewService } = await import("../services/final-review.service.js");
      vi.mocked(finalReviewService.runFinalReview).mockResolvedValue(null);

      const lastTaskId = "os-abc.2";
      const epicWorktreeKey = "epic_os-abc";
      mockGetSettings.mockResolvedValue({
        simpleComplexityAgent: { type: "cursor", model: null },
        complexComplexityAgent: { type: "cursor", model: null },
        deployment: {},
        gitWorkingMode: "worktree",
        mergeStrategy: "per_epic",
      });
      hostState.slots = new Map([
        [
          lastTaskId,
          {
            ...makeSlot("/tmp/epic-wt"),
            taskId: lastTaskId,
            branchName: epicBranchName,
            worktreeKey: epicWorktreeKey,
          },
        ],
      ]);
      mockHost.getState = vi.fn().mockImplementation(() => hostState);

      const epicAndTasks = [
        { id: "os-abc", title: "Epic", status: "open", issue_type: "epic" } as StoredTask,
        { id: "os-abc.1", title: "Task 1", status: "closed", issue_type: "task" } as StoredTask,
        { id: "os-abc.2", title: "Task 2", status: "open", issue_type: "task" } as StoredTask,
      ];
      const allImplClosedList = [
        { ...epicAndTasks[0] },
        { ...epicAndTasks[1] },
        { ...epicAndTasks[2], status: "closed" },
      ];
      mockHost.taskStore.listAll
        .mockResolvedValueOnce(epicAndTasks)
        .mockResolvedValueOnce(allImplClosedList)
        .mockResolvedValue(allImplClosedList);

      const lastTask = (): StoredTask => ({
        ...makeEpicTask(),
        id: lastTaskId,
        title: "Epic task 2",
      });

      await coordinator.performMergeAndDone(
        projectId,
        repoPath,
        lastTask(),
        epicBranchName
      );

      expect(mockGitQueueEnqueueAndWait).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "worktree_merge",
          branchName: epicBranchName,
          taskId: lastTaskId,
        })
      );
      await vi.waitFor(() => {
        expect(mockRemoveTaskWorktree).toHaveBeenCalledWith(
          repoPath,
          epicWorktreeKey,
          "/tmp/epic-wt"
        );
        expect(mockDeleteBranch).toHaveBeenCalledWith(repoPath, epicBranchName);
      });

      const { triggerDeployForEvent } = await import("../services/deploy-trigger.service.js");
      await vi.waitFor(() => {
        expect(triggerDeployForEvent).toHaveBeenCalledWith(projectId, "each_task");
      });
      // Deliver gate: plan not complete (reviewedAt null) → do not trigger each_epic deploy
      expect(triggerDeployForEvent).not.toHaveBeenCalledWith(projectId, "each_epic");
    });

    it("calls triggerDeployForEvent(projectId, 'each_epic') when plan is complete (reviewedAt set)", async () => {
      const { finalReviewService } = await import("../services/final-review.service.js");
      vi.mocked(finalReviewService.runFinalReview).mockResolvedValue(null);

      const lastTaskId = "os-abc.2";
      const epicWorktreeKey = "epic_os-abc";
      const epicId = "os-abc";
      mockGetSettings.mockResolvedValue({
        simpleComplexityAgent: { type: "cursor", model: null },
        complexComplexityAgent: { type: "cursor", model: null },
        deployment: {},
        gitWorkingMode: "worktree",
        mergeStrategy: "per_epic",
      });
      hostState.slots = new Map([
        [
          lastTaskId,
          {
            ...makeSlot("/tmp/epic-wt"),
            taskId: lastTaskId,
            branchName: epicBranchName,
            worktreeKey: epicWorktreeKey,
          },
        ],
      ]);
      mockHost.getState = vi.fn().mockImplementation(() => hostState);

      const epicAndTasks = [
        { id: epicId, title: "Epic", status: "open", issue_type: "epic" } as StoredTask,
        { id: "os-abc.1", title: "Task 1", status: "closed", issue_type: "task" } as StoredTask,
        { id: "os-abc.2", title: "Task 2", status: "open", issue_type: "task" } as StoredTask,
      ];
      const allImplClosedList = [
        { ...epicAndTasks[0] },
        { ...epicAndTasks[1] },
        { ...epicAndTasks[2], status: "closed" },
      ];
      mockHost.taskStore.listAll
        .mockResolvedValueOnce(epicAndTasks)
        .mockResolvedValueOnce(allImplClosedList)
        .mockResolvedValue(allImplClosedList);
      vi.mocked(mockHost.taskStore.planGetByEpicId).mockResolvedValue({
        plan_id: "plan-1",
        content: "",
        metadata: { reviewedAt: new Date().toISOString(), epicId },
        shipped_content: null,
        updated_at: new Date().toISOString(),
      });

      const lastTask = (): StoredTask => ({
        ...makeEpicTask(),
        id: lastTaskId,
        title: "Epic task 2",
      });

      await coordinator.performMergeAndDone(
        projectId,
        repoPath,
        lastTask(),
        epicBranchName
      );

      const { triggerDeployForEvent } = await import("../services/deploy-trigger.service.js");
      await vi.waitFor(() => {
        expect(triggerDeployForEvent).toHaveBeenCalledWith(projectId, "each_task");
        expect(triggerDeployForEvent).toHaveBeenCalledWith(projectId, "each_epic");
      });
    });
  });
});
