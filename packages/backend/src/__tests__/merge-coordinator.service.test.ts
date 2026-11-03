import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MergeCoordinatorService,
  type MergeCoordinatorHost,
  type MergeSlot,
} from "../services/merge-coordinator.service.js";
import { computeMergeGateCommandsFingerprint } from "../services/merge-verification.service.js";
import type { StoredTask } from "../services/task-store.service.js";

vi.mock("../services/task-store.service.js", async () => {
  const actual = await vi.importActual<typeof import("../services/task-store.service.js")>(
    "../services/task-store.service.js"
  );
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
  class RebaseContinueBlockedError extends Error {
    constructor(
      message: string,
      public readonly diagnostics: {
        cause: "preflight_unmerged" | "preflight_staged_markers" | "continue_failed";
        rebaseMetadataPresent: string[];
        conflictedFiles: string[];
        gitStatusShort?: string;
        underlyingMessage?: string;
      },
      public readonly mergeFailureStage?: string
    ) {
      super(message);
      this.name = "RebaseContinueBlockedError";
    }
  }
  return {
    RebaseConflictError,
    RebaseContinueBlockedError,
    BranchManager: vi.fn().mockImplementation(() => ({
      waitForGitReady: vi.fn(),
      commitWip: vi.fn(),
      prepareWorktreeForRemoval: vi.fn(),
      removeTaskWorktree: vi.fn(),
      deleteBranch: vi.fn(),
      getChangedFiles: vi.fn(),
      prepareMainForPush: vi.fn(),
      pushMain: vi.fn(),
      pushMainToOrigin: vi.fn(),
      isMergeInProgress: vi.fn(),
      mergeAbort: vi.fn(),
      mergeContinue: vi.fn(),
      rebaseAbort: vi.fn(),
      rebaseContinue: vi.fn(),
      getDiff: vi.fn(),
      getGitRev: vi.fn(),
    })),
  };
});

const mockRemoveTaskWorktree = vi.fn();
const mockPrepareWorktreeForRemoval = vi.fn();
const mockDeleteBranch = vi.fn();
const mockGetSettings = vi.fn();
const mockGitQueueDrain = vi.fn();
const mockGitQueueEnqueueAndWait = vi.fn();
const mockNotificationCreate = vi.fn();
const mockNotificationCreateAgentFailed = vi.fn();
const mockNotificationListByProject = vi.fn();
const mockNotificationResolve = vi.fn();
const mockBroadcastToProject = vi.fn();
const mockResolveBaseBranch = vi.fn();
const mockInspectGitRepoState = vi.fn();
const mockCreateBaselineWorkspace = vi.fn();
const mockCleanupBaselineWorkspace = vi.fn();
const mockRegisterCleanupIntent = vi.fn();
const mockListCleanupIntents = vi.fn();
const mockRemoveCleanupIntent = vi.fn();

vi.mock("../services/git-commit-queue.service.js", async () => {
  const actual = await vi.importActual<typeof import("../services/git-commit-queue.service.js")>(
    "../services/git-commit-queue.service.js"
  );
  return {
    MergeJobError: actual.MergeJobError,
    gitCommitQueue: {
      drain: () => mockGitQueueDrain(),
      enqueueAndWait: (opts: unknown) => mockGitQueueEnqueueAndWait(opts),
      getMergeQueueSnapshotForRepo: vi.fn().mockReturnValue({
        activeTaskId: null,
        pendingTaskIds: [],
      }),
    },
  };
});

vi.mock("../utils/git-repo-state.js", () => ({
  resolveBaseBranch: (...args: unknown[]) => mockResolveBaseBranch(...args),
  inspectGitRepoState: (...args: unknown[]) => mockInspectGitRepoState(...args),
}));

vi.mock("../services/validation-workspace.service.js", () => ({
  validationWorkspaceService: {
    createBaselineWorkspace: (...args: unknown[]) => mockCreateBaselineWorkspace(...args),
  },
}));

vi.mock("../services/worktree-cleanup-intent.service.js", () => ({
  worktreeCleanupIntentService: {
    registerBestEffort: (...args: unknown[]) => mockRegisterCleanupIntent(...args),
    list: (...args: unknown[]) => mockListCleanupIntents(...args),
    removeBestEffort: (...args: unknown[]) => mockRemoveCleanupIntent(...args),
  },
}));

const mockWorktreeLeaseForceRelease = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/worktree-lease.service.js", () => ({
  worktreeLeaseService: {
    forceRelease: (...args: unknown[]) => mockWorktreeLeaseForceRelease(...args),
  },
}));

vi.mock("../services/agent-identity.service.js", () => ({
  buildAgentAttemptId: (
    agentConfig: { type: string; model?: string | null },
    role: "coder" | "reviewer",
    options?: { reviewScope?: string }
  ) => {
    const baseId = `${agentConfig.type}-${agentConfig.model ?? "default"}`;
    if (role !== "reviewer") return baseId;
    return `${baseId}-review-${options?.reviewScope ?? "general"}`;
  },
  agentIdentityService: {
    recordAttempt: vi.fn().mockResolvedValue(undefined),
    recordAttemptStarted: vi.fn().mockResolvedValue(undefined),
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
    createAgentFailed: (...args: unknown[]) => mockNotificationCreateAgentFailed(...args),
    listByProject: (...args: unknown[]) => mockNotificationListByProject(...args),
    resolve: (...args: unknown[]) => mockNotificationResolve(...args),
  },
}));

vi.mock("../websocket/index.js", () => ({
  broadcastToProject: (...args: unknown[]) => mockBroadcastToProject(...args),
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

vi.mock("../utils/worktree-health.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/worktree-health.js")>();
  return {
    ...actual,
    assertWorktreeIntegrity: vi
      .fn()
      .mockResolvedValue({ valid: true, phase: "merge", worktreePath: "", taskId: "" }),
    evaluateWorktreeCleanupProtection: vi.fn().mockResolvedValue({ forbid: false }),
    getWorktreeCleanupAssignmentGuardMs: vi.fn().mockReturnValue(30_000),
    logWorktreeCleanupBlocked: vi.fn(),
  };
});

vi.mock("../utils/failure-fingerprint.js", () => ({
  buildFailureFingerprint: vi.fn().mockReturnValue({
    hash: "mock-hash-0000",
    failureClass: "unknown",
    normalizedMessage: "",
    phase: "",
    branch: "",
    raw: "",
  }),
}));

vi.mock("../services/self-improvement.service.js", () => ({
  selfImprovementService: {
    runIfDue: vi.fn().mockResolvedValue(undefined),
    ensureBaselineQualityGateTask: vi.fn().mockResolvedValue({
      taskId: "os-baseline-fix",
      created: true,
      action: "created",
    }),
  },
}));

describe("MergeCoordinatorService", () => {
  let coordinator: MergeCoordinatorService;
  let mockHost: MergeCoordinatorHost;
  let hostState: ReturnType<MergeCoordinatorHost["getState"]>;
  /** Tracks fire-and-forget {@link MergeCoordinatorService.postCompletionAsync} from performMergeAndDone. */
  const postCompletionInflight: Promise<void>[] = [];
  const projectId = "proj-1";
  const repoPath = "/tmp/repo";
  const taskId = "os-abc1";
  const branchName = `opensprint/${taskId}`;

  const makeTask = (overrides: Partial<StoredTask> = {}): StoredTask => ({
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
    ...overrides,
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

  const isBaselineValidation = (options: {
    validationWorkspace?: string;
    taskId?: string;
  }): boolean => {
    return options.validationWorkspace === "baseline" || options.taskId === "baseline:main";
  };

  beforeEach(() => {
    vi.clearAllMocks();
    postCompletionInflight.length = 0;
    mockGitQueueDrain.mockResolvedValue(undefined);
    mockGitQueueEnqueueAndWait.mockResolvedValue(undefined);
    mockNotificationCreate.mockResolvedValue(undefined);
    mockNotificationCreateAgentFailed.mockResolvedValue({
      id: "af-1",
      projectId,
      source: "execute",
      sourceId: "merge-quality-gate-baseline:main",
      questions: [],
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      kind: "agent_failed",
    });
    mockNotificationListByProject.mockResolvedValue([]);
    mockNotificationResolve.mockResolvedValue({
      id: "af-1",
      projectId,
      source: "execute",
      sourceId: "merge-quality-gate-baseline:main",
      questions: [],
      status: "resolved",
      createdAt: new Date().toISOString(),
      resolvedAt: new Date().toISOString(),
      kind: "agent_failed",
    });
    mockBroadcastToProject.mockReset();
    mockResolveBaseBranch.mockImplementation(
      async (_repoPath: string, preferredBaseBranch?: string | null) =>
        preferredBaseBranch ?? "main"
    );
    mockRegisterCleanupIntent.mockResolvedValue(undefined);
    mockWorktreeLeaseForceRelease.mockResolvedValue(undefined);
    mockListCleanupIntents.mockResolvedValue([]);
    mockRemoveCleanupIntent.mockResolvedValue(undefined);
    mockCleanupBaselineWorkspace.mockResolvedValue(undefined);
    mockCreateBaselineWorkspace.mockResolvedValue({
      kind: "baseline",
      worktreePath: "/tmp/baseline-validation",
      branchName: null,
      cleanup: mockCleanupBaselineWorkspace,
    });
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
        getWorktreePath: vi
          .fn()
          .mockImplementation((key: string) => `/tmp/opensprint-worktrees/${key}`),
        waitForGitReady: vi.fn().mockResolvedValue(undefined),
        commitWip: vi.fn().mockResolvedValue(undefined),
        prepareWorktreeForRemoval: mockPrepareWorktreeForRemoval.mockResolvedValue(undefined),
        removeTaskWorktree: mockRemoveTaskWorktree.mockResolvedValue(true),
        deleteBranch: mockDeleteBranch.mockResolvedValue(undefined),
        getChangedFiles: vi.fn().mockResolvedValue([]),
        prepareMainForPush: vi.fn().mockResolvedValue(undefined),
        pushMain: vi.fn().mockResolvedValue(undefined),
        pushMainToOrigin: vi.fn().mockResolvedValue(undefined),
        isMergeInProgress: vi.fn().mockResolvedValue(false),
        mergeAbort: vi.fn().mockResolvedValue(undefined),
        mergeContinue: vi.fn().mockResolvedValue(undefined),
        rebaseAbort: vi.fn().mockResolvedValue(undefined),
        rebaseContinue: vi.fn().mockResolvedValue(undefined),
        reconcileDependenciesAfterMerge: vi.fn().mockResolvedValue(undefined),
        getGitRev: vi.fn().mockImplementation(async (_cwd: string, ref: string) => {
          if (ref === "HEAD") return "taskheadsha";
          if (ref === "origin/main" || ref === "main") return "mainheadsha";
          return "refsha";
        }),
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
      setBaselineRuntimeState: vi.fn().mockResolvedValue(undefined),
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
    const realPostCompletion =
      MergeCoordinatorService.prototype.postCompletionAsync.bind(coordinator);
    vi.spyOn(coordinator, "postCompletionAsync").mockImplementation((...args) => {
      const p = realPostCompletion(...args);
      postCompletionInflight.push(p);
      return p;
    });
  });

  afterEach(async () => {
    await Promise.allSettled(postCompletionInflight);
    postCompletionInflight.length = 0;
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
      expect(mockPrepareWorktreeForRemoval).toHaveBeenCalledWith(taskId);
      expect(mockRemoveTaskWorktree).toHaveBeenCalledWith(repoPath, taskId, "/tmp/worktree");
      expect(mockDeleteBranch).toHaveBeenCalledWith(repoPath, branchName);
      expect(mockRegisterCleanupIntent).toHaveBeenCalledWith(
        repoPath,
        projectId,
        expect.objectContaining({
          taskId,
          branchName,
          worktreePath: "/tmp/worktree",
          gitWorkingMode: "worktree",
        })
      );
      expect(mockWorktreeLeaseForceRelease).toHaveBeenCalledWith(taskId);
    });
  });

  it("skips task_worktree merge gates when stored artifact matches HEAD and base tip", async () => {
    mockHost.runMergeQualityGates = vi.fn().mockResolvedValue(null);
    const slot = makeSlot();
    slot.phaseResult.mergeGateArtifactTaskWorktree = {
      taskBranchHead: "taskheadsha",
      baseBranchTip: "mainheadsha",
      commandsFingerprint: computeMergeGateCommandsFingerprint(undefined, "deterministic"),
      qualityGateProfile: "deterministic",
      validationWorkspace: "task_worktree",
      passedAt: new Date().toISOString(),
    };
    hostState.slots.set(taskId, slot);

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

    const taskWorktreeGateCalls = mockHost.runMergeQualityGates!.mock.calls.filter(
      ([opts]) => opts.validationWorkspace === "task_worktree" && opts.taskId === taskId
    );
    expect(taskWorktreeGateCalls).toHaveLength(0);
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
      expect(mockWorktreeLeaseForceRelease).not.toHaveBeenCalled();
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
      expect(mockPrepareWorktreeForRemoval).toHaveBeenCalledWith(taskId);
      expect(mockRemoveTaskWorktree).toHaveBeenCalledWith(repoPath, taskId, "/tmp/worktree");
      expect(mockDeleteBranch).toHaveBeenCalledWith(repoPath, branchName);
    });
  });

  it("always calls deleteBranch regardless of gitWorkingMode", async () => {
    for (const mode of ["worktree", "branches"] as const) {
      vi.clearAllMocks();
      mockPrepareWorktreeForRemoval.mockResolvedValue(undefined);
      mockRemoveTaskWorktree.mockResolvedValue(true);
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

  it("replays persisted cleanup intents during post-completion push", async () => {
    mockListCleanupIntents.mockResolvedValue([
      {
        taskId: "os-replay",
        branchName: "opensprint/os-replay",
        worktreePath: "/tmp/replay-worktree",
        gitWorkingMode: "worktree",
        worktreeKey: "epic_42",
      },
    ]);

    await coordinator.postCompletionAsync(projectId, repoPath, "os-abc.1");

    expect(mockPrepareWorktreeForRemoval).toHaveBeenCalledWith("epic_42");
    expect(mockWorktreeLeaseForceRelease).toHaveBeenCalledWith("epic_42");
    expect(mockRemoveTaskWorktree).toHaveBeenCalledWith(
      repoPath,
      "epic_42",
      "/tmp/replay-worktree"
    );
    expect(mockDeleteBranch).toHaveBeenCalledWith(repoPath, "opensprint/os-replay");
    expect(mockRemoveCleanupIntent).toHaveBeenCalledWith(repoPath, projectId, "os-replay");
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

  it("suppresses duplicate in-flight merge flow for the same task attempt", async () => {
    let releaseGitReady: (() => void) | null = null;
    const gitReadyGate = new Promise<void>((resolve) => {
      releaseGitReady = resolve;
    });
    mockHost.branchManager.waitForGitReady = vi.fn().mockImplementation(() => gitReadyGate);

    const firstMerge = coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);
    await Promise.resolve();
    const duplicateMerge = coordinator.performMergeAndDone(
      projectId,
      repoPath,
      makeTask(),
      branchName
    );

    await duplicateMerge;
    expect(mockHost.branchManager.waitForGitReady).toHaveBeenCalledTimes(1);

    releaseGitReady?.();
    await firstMerge;
    expect(mockGitQueueEnqueueAndWait).toHaveBeenCalledTimes(1);
  });

  it("invalidates baseline cache and reconciles dependencies after successful merge", async () => {
    const mockReconcile = vi.fn().mockResolvedValue(undefined);
    mockHost.branchManager.reconcileDependenciesAfterMerge = mockReconcile;

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

    expect(mockReconcile).toHaveBeenCalledWith(repoPath);

    // Verify the baseline cache was invalidated by confirming a subsequent
    // baseline check does NOT short-circuit (it actually runs the check).
    // We do this by calling performMergeAndDone again — it should invoke
    // the baseline quality gate check (createBaselineWorkspace is the entry
    // point for a baseline check). Reset state for a second merge.
    mockGitQueueEnqueueAndWait.mockResolvedValue(undefined);
    hostState.slots = new Map([[taskId, makeSlot()]]);
    mockHost.getState = vi.fn().mockImplementation(() => hostState);

    // Enable quality gates so the baseline check runs
    const mergeCoordInternal = coordinator as unknown as {
      host: MergeCoordinatorHost & { runMergeQualityGates?: unknown };
    };
    mergeCoordInternal.host.runMergeQualityGates = vi.fn().mockResolvedValue(null);

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

    // Baseline workspace should have been created (meaning the cache didn't skip the check)
    expect(mockCreateBaselineWorkspace).toHaveBeenCalled();
  });

  it("does not block merge when dependency reconciliation fails", async () => {
    const mockReconcile = vi.fn().mockRejectedValue(new Error("npm ci failed"));
    mockHost.branchManager.reconcileDependenciesAfterMerge = mockReconcile;

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

    expect(mockReconcile).toHaveBeenCalledWith(repoPath);
    // Merge should still succeed — task should be closed (slot removed via transition)
    expect(mockHost.transition).toHaveBeenCalledWith(
      projectId,
      expect.objectContaining({ to: "complete", taskId })
    );
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
        failureReason:
          "The merge could not complete because your branch and main both changed the same files.",
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
      expect.objectContaining({
        status: "open",
        extra: expect.objectContaining({
          next_retry_context: expect.objectContaining({
            previousFailure: expect.stringContaining("merge failed"),
            failureType: "merge_conflict",
          }),
        }),
      })
    );
  });

  it("keeps requeueing merge conflicts in optimistic mode regardless of scope confidence", async () => {
    (
      mockHost.taskStore.getCumulativeAttemptsFromIssue as unknown as ReturnType<typeof vi.fn>
    ).mockReturnValue(10);
    mockGetSettings.mockResolvedValue({
      simpleComplexityAgent: { type: "cursor", model: null },
      complexComplexityAgent: { type: "cursor", model: null },
      deployment: { mode: "custom" },
      gitWorkingMode: "worktree",
      unknownScopeStrategy: "optimistic",
    });
    mockGitQueueEnqueueAndWait.mockRejectedValue(new Error("merge conflict"));

    await coordinator.performMergeAndDone(
      projectId,
      repoPath,
      makeTask({ labels: ["files:src/explicit.ts"] }),
      branchName
    );

    expect(mockHost.taskStore.update).toHaveBeenCalledWith(
      projectId,
      taskId,
      expect.objectContaining({
        status: "open",
        extra: expect.objectContaining({
          next_retry_context: expect.objectContaining({
            failureType: "merge_conflict",
          }),
        }),
      })
    );
    expect(mockHost.taskStore.update).not.toHaveBeenCalledWith(
      projectId,
      taskId,
      expect.objectContaining({
        status: "blocked",
      })
    );
  });

  it("requeues task when pre-merge quality gate fails", async () => {
    mockHost.runMergeQualityGates = vi.fn().mockImplementation(async (options) => {
      if (isBaselineValidation(options)) return null;
      return {
        command: "npm run lint",
        reason: "Command failed with exit code 1",
        output: "eslint found errors",
        outputSnippet: "eslint found errors",
        worktreePath: "/tmp/worktree",
      };
    });

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);
    const { eventLogService } = await import("../services/event-log.service.js");
    const appendMock = vi.mocked(eventLogService.append);

    expect(mockGitQueueEnqueueAndWait).not.toHaveBeenCalled();
    expect(mockHost.taskStore.setMergeStage).toHaveBeenCalledWith(
      projectId,
      taskId,
      "quality_gate"
    );
    expect(mockHost.taskStore.comment).toHaveBeenCalledWith(
      projectId,
      taskId,
      expect.stringContaining("Pre-merge quality gates failed")
    );
    expect(mockHost.taskStore.update).toHaveBeenCalledWith(
      projectId,
      taskId,
      expect.objectContaining({
        status: "open",
        extra: expect.objectContaining({
          failedGateCommand: "npm run lint",
          failedGateReason: "Command failed with exit code 1",
          failedGateOutputSnippet: "eslint found errors",
          worktreePath: "/tmp/worktree",
          qualityGateDetail: expect.objectContaining({
            command: "npm run lint",
            reason: "Command failed with exit code 1",
            outputSnippet: "eslint found errors",
            worktreePath: "/tmp/worktree",
            firstErrorLine: "eslint found errors",
          }),
          last_execution_summary: expect.objectContaining({
            summary: expect.stringContaining("cmd: npm run lint"),
          }),
          next_retry_context: expect.objectContaining({
            previousFailure: expect.stringContaining("quality gate failed"),
            failureType: "merge_quality_gate",
          }),
        }),
      })
    );
    expect(mockHost.taskStore.update).toHaveBeenCalledWith(
      projectId,
      taskId,
      expect.objectContaining({
        extra: expect.objectContaining({
          last_execution_summary: expect.objectContaining({
            summary: expect.stringContaining("error: eslint found errors"),
          }),
          next_retry_context: expect.objectContaining({
            previousFailure: expect.stringContaining("quality gate failed"),
            failureType: "merge_quality_gate",
          }),
        }),
      })
    );
    const qualityGateMergeFailedEvent = appendMock.mock.calls
      .map(([, event]) => event)
      .find((event) => event.event === "merge.failed");
    expect(qualityGateMergeFailedEvent).toBeDefined();
    expect(qualityGateMergeFailedEvent?.data).toEqual(
      expect.objectContaining({
        failedGateCommand: "npm run lint",
        failedGateReason: "Command failed with exit code 1",
        failedGateOutputSnippet: "eslint found errors",
        worktreePath: "/tmp/worktree",
        qualityGateDetail: expect.objectContaining({
          command: "npm run lint",
          reason: "Command failed with exit code 1",
          outputSnippet: "eslint found errors",
          worktreePath: "/tmp/worktree",
          firstErrorLine: "eslint found errors",
        }),
      })
    );
    const qualityGateRequeuedEvent = appendMock.mock.calls
      .map(([, event]) => event)
      .find((event) => event.event === "task.requeued");
    expect(qualityGateRequeuedEvent).toBeDefined();
    expect(qualityGateRequeuedEvent?.data).toEqual(
      expect.objectContaining({
        failedGateCommand: "npm run lint",
        failedGateReason: "Command failed with exit code 1",
        failedGateOutputSnippet: "eslint found errors",
        worktreePath: "/tmp/worktree",
      })
    );
  });

  it("propagates generic quality-gate failures to retry context when gate details are missing", async () => {
    mockHost.runMergeQualityGates = vi.fn().mockResolvedValue(null);
    const { MergeJobError } = await import("../services/git-commit-queue.service.js");
    mockGitQueueEnqueueAndWait.mockRejectedValue(
      new MergeJobError(
        "Quality gate failed before command execution: toolchain unavailable",
        "quality_gate",
        []
      )
    );

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

    expect(mockHost.taskStore.update).toHaveBeenCalledWith(
      projectId,
      taskId,
      expect.objectContaining({
        status: "open",
        extra: expect.objectContaining({
          failedGateReason: expect.stringContaining(
            "Quality gate failed before command execution: toolchain unavailable"
          ),
          qualityGateDetail: expect.objectContaining({
            reason: expect.stringContaining(
              "Quality gate failed before command execution: toolchain unavailable"
            ),
            firstErrorLine: expect.stringContaining(
              "Quality gate failed before command execution: toolchain unavailable"
            ),
            category: "quality_gate",
          }),
          next_retry_context: expect.objectContaining({
            previousFailure: expect.stringContaining(
              "Quality gate failed before command execution: toolchain unavailable"
            ),
            failureType: "merge_quality_gate",
          }),
        }),
      })
    );
  });

  it("persists retry context when quality-gate failures reach blocked threshold", async () => {
    (
      mockHost.taskStore.getCumulativeAttemptsFromIssue as unknown as ReturnType<typeof vi.fn>
    ).mockReturnValue(5);
    mockHost.runMergeQualityGates = vi.fn().mockImplementation(async (options) => {
      if (isBaselineValidation(options)) return null;
      return {
        command: "npm run lint",
        reason: "Command failed with exit code 1",
        output: "eslint found errors",
        outputSnippet: "eslint found errors",
        worktreePath: "/tmp/worktree",
      };
    });

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);
    const { eventLogService } = await import("../services/event-log.service.js");
    const appendMock = vi.mocked(eventLogService.append);

    expect(mockHost.taskStore.update).toHaveBeenCalledWith(
      projectId,
      taskId,
      expect.objectContaining({
        status: "blocked",
        block_reason: "Quality Gate Failure",
        extra: expect.objectContaining({
          failedGateCommand: "npm run lint",
          failedGateReason: "Command failed with exit code 1",
          failedGateOutputSnippet: "eslint found errors",
          worktreePath: "/tmp/worktree",
          qualityGateDetail: expect.objectContaining({
            command: "npm run lint",
            reason: "Command failed with exit code 1",
            outputSnippet: "eslint found errors",
            worktreePath: "/tmp/worktree",
            firstErrorLine: "eslint found errors",
          }),
          last_execution_summary: expect.objectContaining({
            summary: expect.stringContaining("cmd: npm run lint"),
          }),
          next_retry_context: expect.objectContaining({
            previousFailure: expect.stringContaining("quality gate failed"),
            failureType: "merge_quality_gate",
          }),
        }),
      })
    );
    expect(mockHost.taskStore.update).toHaveBeenCalledWith(
      projectId,
      taskId,
      expect.objectContaining({
        extra: expect.objectContaining({
          last_execution_summary: expect.objectContaining({
            summary: expect.stringContaining("error: eslint found errors"),
          }),
          next_retry_context: expect.objectContaining({
            previousFailure: expect.stringContaining("quality gate failed"),
            failureType: "merge_quality_gate",
          }),
        }),
      })
    );
    const blockedEvent = appendMock.mock.calls
      .map(([, event]) => event)
      .find((event) => event.event === "task.blocked");
    expect(blockedEvent).toBeDefined();
    expect(blockedEvent?.data).toEqual(
      expect.objectContaining({
        failedGateCommand: "npm run lint",
        failedGateReason: "Command failed with exit code 1",
        failedGateOutputSnippet: "eslint found errors",
        worktreePath: "/tmp/worktree",
      })
    );
  });

  it("creates a self-improvement task and pauses merging when baseline quality gates on main fail", async () => {
    const { selfImprovementService } = await import("../services/self-improvement.service.js");
    mockHost.runMergeQualityGates = vi.fn().mockImplementation(async (options) => {
      if (!isBaselineValidation(options)) return null;
      return {
        command: "npm run test",
        reason: "Command failed: npm run test",
        output: "stderr | baseline failure",
        firstErrorLine: "stderr | baseline failure",
        category: "quality_gate",
      };
    });

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

    expect(selfImprovementService.ensureBaselineQualityGateTask).toHaveBeenCalledWith(projectId, {
      baseBranch: "main",
      command: "npm run test",
      reason: "Command failed: npm run test",
      outputSnippet: "stderr | baseline failure",
      firstErrorLine: "stderr | baseline failure",
      worktreePath: null,
      validationWorkspace: "baseline",
    });
    expect(mockGitQueueEnqueueAndWait).not.toHaveBeenCalled();
    expect(mockHost.taskStore.setMergeStage).toHaveBeenCalledWith(
      projectId,
      taskId,
      "quality_gate"
    );
    expect(mockHost.taskStore.update).toHaveBeenCalledWith(
      projectId,
      taskId,
      expect.objectContaining({
        status: "open",
        assignee: "",
      })
    );
    expect(mockNotificationCreateAgentFailed).toHaveBeenCalledTimes(1);
    const { eventLogService } = await import("../services/event-log.service.js");
    const baselineCheckEvent = vi
      .mocked(eventLogService.append)
      .mock.calls.map(([, event]) => event)
      .find((event) => event.event === "baseline.check");
    expect(baselineCheckEvent?.data).toEqual(
      expect.objectContaining({
        source: "merge_precheck",
        outcome: "failing",
      })
    );

    hostState.slots.set(taskId, makeSlot());
    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);
    expect(selfImprovementService.ensureBaselineQualityGateTask).toHaveBeenCalledTimes(1);
    expect(mockNotificationCreateAgentFailed).toHaveBeenCalledTimes(1);
    expect(
      mockHost.runMergeQualityGates.mock.calls.filter(([options]) =>
        isBaselineValidation(options as { validationWorkspace?: string; taskId?: string })
      )
    ).toHaveLength(2);
  });

  it("suppresses duplicate baseline remediation task creation for repeated same fingerprint", async () => {
    const { selfImprovementService } = await import("../services/self-improvement.service.js");
    const nowSpy = vi.spyOn(Date, "now");
    let nowMs = 1_000_000;
    nowSpy.mockImplementation(() => nowMs);
    mockHost.runMergeQualityGates = vi.fn().mockImplementation(async (options) => {
      if (!isBaselineValidation(options)) return null;
      return {
        command: "npm run test",
        reason: "Command failed: npm run test",
        output: "stderr | baseline failure",
        firstErrorLine: "stderr | baseline failure",
        category: "quality_gate",
      };
    });
    try {
      await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);
      expect(selfImprovementService.ensureBaselineQualityGateTask).toHaveBeenCalledTimes(1);

      // Move beyond baseline success cache TTL, but stay within remediation suppression window.
      nowMs += 61_000;
      hostState.slots.set(taskId, makeSlot());
      await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);
      expect(selfImprovementService.ensureBaselineQualityGateTask).toHaveBeenCalledTimes(1);
      const pauseWindows = vi
        .mocked(mockHost.taskStore.update)
        .mock.calls.map(([, , fields]) => {
          const rec = fields as { extra?: { baselineQualityGatePauseMs?: unknown } };
          const value = rec.extra?.baselineQualityGatePauseMs;
          return typeof value === "number" ? value : null;
        })
        .filter((value): value is number => value != null);
      expect(pauseWindows).toEqual(expect.arrayContaining([5 * 60_000, 10 * 60_000]));

      const { eventLogService } = await import("../services/event-log.service.js");
      const remediationEvents = vi
        .mocked(eventLogService.append)
        .mock.calls.map(([, event]) => event)
        .filter((event) => event.event === "baseline.remediation_task");
      expect(remediationEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({ action: "created" }),
          }),
          expect.objectContaining({
            data: expect.objectContaining({ action: "suppressed_redundant" }),
          }),
        ])
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("lets the baseline remediation task bypass the baseline-on-main precheck while still merging through worktree gates", async () => {
    const { selfImprovementService } = await import("../services/self-improvement.service.js");
    mockHost.runMergeQualityGates = vi.fn().mockImplementation(async (options) => {
      if (isBaselineValidation(options)) {
        return {
          command: "npm run test",
          reason: "Command failed: npm run test",
          output: "stderr | baseline failure",
          firstErrorLine: "stderr | baseline failure",
          category: "quality_gate",
        };
      }
      return null;
    });

    await coordinator.performMergeAndDone(
      projectId,
      repoPath,
      makeTask({
        source: "self-improvement",
        selfImprovementKind: "baseline-quality-gate",
        baselineQualityGateSource: "merge-quality-gate-baseline",
        baselineBaseBranch: "main",
      }),
      branchName
    );

    expect(selfImprovementService.ensureBaselineQualityGateTask).not.toHaveBeenCalled();
    expect(mockNotificationCreateAgentFailed).not.toHaveBeenCalled();
    expect(mockGitQueueEnqueueAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "worktree_merge",
        repoPath,
        worktreePath: "/tmp/worktree",
        branchName,
        taskId,
      })
    );
    expect(
      mockHost.runMergeQualityGates.mock.calls.filter(([options]) =>
        isBaselineValidation(options as { validationWorkspace?: string; taskId?: string })
      )
    ).toHaveLength(0);
    expect(
      mockHost.runMergeQualityGates.mock.calls.filter(
        ([options]) =>
          !isBaselineValidation(options as { validationWorkspace?: string; taskId?: string })
      )
    ).toHaveLength(1);
  });

  it("does not resolve the baseline blocker notification while baseline is still failing", async () => {
    const { selfImprovementService } = await import("../services/self-improvement.service.js");
    mockHost.runMergeQualityGates = vi.fn().mockImplementation(async (options) => {
      if (!isBaselineValidation(options)) return null;
      return {
        command: "npm run test",
        reason: "Command failed: npm run test",
        output: "stderr | baseline failure",
        firstErrorLine: "stderr | baseline failure",
        category: "quality_gate",
      };
    });

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

    expect(selfImprovementService.ensureBaselineQualityGateTask).toHaveBeenCalledTimes(1);
    expect(mockNotificationCreateAgentFailed).toHaveBeenCalledTimes(1);
    expect(mockNotificationResolve).not.toHaveBeenCalled();
  });

  it("skips remediation task creation for low-confidence environment baseline failures", async () => {
    const { selfImprovementService } = await import("../services/self-improvement.service.js");
    mockHost.runMergeQualityGates = vi.fn().mockImplementation(async (options) => {
      if (!isBaselineValidation(options)) return null;
      return {
        command: "npm run build",
        reason: "Command failed with exit code 1",
        output: "Error: Cannot find module '@app/shared'",
        firstErrorLine: "Error: Cannot find module '@app/shared'",
        category: "environment_setup",
        classificationConfidence: "low",
        classificationReason: "matched ambiguous environment fingerprint",
      };
    });

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

    expect(selfImprovementService.ensureBaselineQualityGateTask).not.toHaveBeenCalled();
    expect(mockNotificationCreateAgentFailed).toHaveBeenCalledTimes(1);
  });

  it("resolves baseline blocker notification when baseline quality gates recover", async () => {
    let nowMs = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    try {
      mockHost.runMergeQualityGates = vi.fn().mockImplementation(async (options) => {
        if (!isBaselineValidation(options)) return null;
        return {
          command: "npm run test",
          reason: "Command failed: npm run test",
          output: "stderr | baseline failure",
          firstErrorLine: "stderr | baseline failure",
          category: "quality_gate",
        };
      });

      await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);
      expect(mockNotificationCreateAgentFailed).toHaveBeenCalledTimes(1);

      mockNotificationListByProject.mockResolvedValueOnce([
        {
          id: "af-baseline",
          projectId,
          source: "execute",
          sourceId: "merge-quality-gate-baseline:main",
          questions: [],
          status: "open",
          createdAt: new Date().toISOString(),
          resolvedAt: null,
          kind: "agent_failed",
        },
      ]);
      mockNotificationResolve.mockResolvedValueOnce({
        id: "af-baseline",
        projectId,
        source: "execute",
        sourceId: "merge-quality-gate-baseline:main",
        questions: [],
        status: "resolved",
        createdAt: new Date().toISOString(),
        resolvedAt: new Date().toISOString(),
        kind: "agent_failed",
      });

      // Baseline checks are cached for 60s; move beyond TTL so recovery is re-evaluated.
      nowMs += 61_000;
      hostState.slots.set(taskId, makeSlot());
      mockHost.runMergeQualityGates = vi.fn().mockResolvedValue(null);
      await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

      expect(mockNotificationResolve).not.toHaveBeenCalled();
      nowMs += 61_000;
      hostState.slots.set(taskId, makeSlot());
      await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

      expect(mockNotificationResolve).toHaveBeenCalledWith(projectId, "af-baseline");
      expect(mockBroadcastToProject).toHaveBeenCalledWith(
        projectId,
        expect.objectContaining({
          type: "notification.resolved",
          notificationId: "af-baseline",
          source: "execute",
          sourceId: "merge-quality-gate-baseline:main",
        })
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("closes the baseline remediation task when baseline quality gates recover", async () => {
    let nowMs = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    try {
      const remediationTask = makeTask({
        id: "os-rem-1",
        title: "Restore baseline quality gates on main",
        status: "open",
        source: "self-improvement",
        selfImprovementKind: "baseline-quality-gate",
        baselineQualityGateSource: "merge-quality-gate-baseline",
        baselineBaseBranch: "main",
      } as Partial<StoredTask>);

      mockHost.runMergeQualityGates = vi.fn().mockImplementation(async (options) => {
        if (!isBaselineValidation(options)) return null;
        return {
          command: "npm run test",
          reason: "Command failed: npm run test",
          output: "stderr | baseline failure",
          firstErrorLine: "stderr | baseline failure",
          category: "quality_gate",
        };
      });

      await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

      // Advance past cache TTL, set baseline to passing, add the remediation task to listAll
      nowMs += 61_000;
      hostState.slots.set(taskId, makeSlot());
      mockHost.runMergeQualityGates = vi.fn().mockResolvedValue(null);
      (mockHost.taskStore.listAll as ReturnType<typeof vi.fn>).mockResolvedValue([remediationTask]);

      await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);
      expect(mockHost.taskStore.close).not.toHaveBeenCalledWith(
        projectId,
        "os-rem-1",
        "Baseline restored"
      );
      nowMs += 61_000;
      hostState.slots.set(taskId, makeSlot());
      await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

      expect(mockHost.taskStore.close).toHaveBeenCalledWith(
        projectId,
        "os-rem-1",
        "Baseline restored"
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("requeues environment-setup quality-gate failures before the retry budget is exhausted", async () => {
    mockHost.runMergeQualityGates = vi.fn().mockImplementation(async (options) => {
      if (isBaselineValidation(options)) return null;
      return {
        command: "npm run build",
        reason: "Dependency setup check failed",
        output: "Cannot find module 'better-sqlite3'",
        firstErrorLine: "Cannot find module 'better-sqlite3'",
        category: "environment_setup",
        autoRepairAttempted: true,
        autoRepairSucceeded: false,
        autoRepairCommands: ["npm ci", "npm install"],
      };
    });

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

    expect(mockHost.taskStore.update).toHaveBeenCalledWith(
      projectId,
      taskId,
      expect.objectContaining({
        status: "open",
        assignee: "",
        extra: expect.objectContaining({
          next_retry_context: expect.objectContaining({
            failureType: "environment_setup",
          }),
          last_execution_summary: expect.objectContaining({
            summary: expect.stringContaining("category: environment_setup"),
          }),
        }),
      })
    );
    expect(mockHost.taskStore.comment).toHaveBeenCalledWith(
      projectId,
      taskId,
      expect.stringContaining("Task requeued")
    );
    expect(mockHost.taskStore.update).not.toHaveBeenCalledWith(
      projectId,
      taskId,
      expect.objectContaining({ status: "blocked" })
    );
  });

  it("stores remediation nextAction in blocked merge/task events after environment setup retries are exhausted", async () => {
    (
      mockHost.taskStore.getCumulativeAttemptsFromIssue as unknown as ReturnType<typeof vi.fn>
    ).mockReturnValue(2);
    mockHost.runMergeQualityGates = vi.fn().mockImplementation(async (options) => {
      if (isBaselineValidation(options)) return null;
      return {
        command: "npm run build",
        reason: "Dependency setup check failed",
        output: "Cannot find module 'better-sqlite3'",
        firstErrorLine: "Cannot find module 'better-sqlite3'",
        category: "environment_setup",
        autoRepairAttempted: true,
        autoRepairSucceeded: false,
        autoRepairCommands: ["npm ci", "npm install"],
      };
    });

    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);
    const { eventLogService } = await import("../services/event-log.service.js");
    const appendMock = vi.mocked(eventLogService.append);

    const blockedEvent = appendMock.mock.calls
      .map(([, event]) => event)
      .find((event) => event.event === "task.blocked");
    expect(blockedEvent).toBeDefined();
    expect(blockedEvent?.data).toEqual(
      expect.objectContaining({
        nextAction: expect.stringContaining(
          "refresh worktree dependency workspace if required by this project"
        ),
      })
    );
  });

  it("runs final review when last task of epic completes and closes epic on pass", async () => {
    const { finalReviewService } = await import("../services/final-review.service.js");
    const { selfImprovementService } = await import("../services/self-improvement.service.js");
    vi.mocked(finalReviewService.runFinalReview).mockResolvedValue({
      status: "pass",
      assessment: "Implementation meets plan scope.",
      proposedTasks: [],
    });
    mockHost.taskStore.listAll.mockResolvedValue([
      { id: "os-abc", title: "Epic", status: "open", issue_type: "epic" } as never,
      { id: "os-abc.1", title: "Task 1", status: "closed", issue_type: "task" } as never,
    ]);
    vi.mocked(mockHost.taskStore.planGetByEpicId).mockResolvedValue({
      plan_id: "plan-1",
      content: "",
      metadata: {},
      shipped_content: null,
      updated_at: new Date().toISOString(),
    });

    await coordinator.postCompletionAsync(projectId, repoPath, "os-abc.1");

    await vi.waitFor(() => {
      expect(finalReviewService.runFinalReview).toHaveBeenCalledWith(projectId, "os-abc", repoPath);
    });
    expect(mockHost.taskStore.close).toHaveBeenCalledWith(
      projectId,
      "os-abc",
      "All tasks done; final review passed"
    );
    await vi.waitFor(() => {
      expect(selfImprovementService.runIfDue).toHaveBeenCalledWith(projectId, {
        trigger: "after_each_plan",
        planId: "plan-1",
      });
    });
  });

  it("invokes runIfDue when epic already closed and plan exists (after_each_plan hook)", async () => {
    const { selfImprovementService } = await import("../services/self-improvement.service.js");
    mockHost.taskStore.listAll.mockResolvedValue([
      { id: "os-abc", title: "Epic", status: "closed", issue_type: "epic" } as never,
      { id: "os-abc.1", title: "Task 1", status: "closed", issue_type: "task" } as never,
    ]);
    vi.mocked(mockHost.taskStore.planGetByEpicId).mockResolvedValue({
      plan_id: "plan-2",
      content: "",
      metadata: {},
      shipped_content: null,
      updated_at: new Date().toISOString(),
    });

    await coordinator.postCompletionAsync(projectId, repoPath, "os-abc.1");

    await vi.waitFor(() => {
      expect(selfImprovementService.runIfDue).toHaveBeenCalledWith(projectId, {
        trigger: "after_each_plan",
        planId: "plan-2",
      });
    });
  });

  it("does not invoke runIfDue when epic closes but no plan (e.g. deploy-fix epic)", async () => {
    const { finalReviewService } = await import("../services/final-review.service.js");
    const { selfImprovementService } = await import("../services/self-improvement.service.js");
    vi.mocked(finalReviewService.runFinalReview).mockResolvedValue(null);
    mockHost.taskStore.listAll.mockResolvedValue([
      { id: "os-xyz", title: "Epic", status: "open", issue_type: "epic" } as never,
      { id: "os-xyz.1", title: "Task 1", status: "closed", issue_type: "task" } as never,
    ]);
    vi.mocked(mockHost.taskStore.planGetByEpicId).mockResolvedValue(null);

    await coordinator.postCompletionAsync(projectId, repoPath, "os-xyz.1");

    await vi.waitFor(() => {
      expect(mockHost.taskStore.close).toHaveBeenCalledWith(projectId, "os-xyz", "All tasks done");
    });
    expect(selfImprovementService.runIfDue).not.toHaveBeenCalled();
  });

  it("invokes runIfDue when final review returns null but plan exists (after_each_plan hook)", async () => {
    const { finalReviewService } = await import("../services/final-review.service.js");
    const { selfImprovementService } = await import("../services/self-improvement.service.js");
    vi.mocked(finalReviewService.runFinalReview).mockResolvedValue(null);
    mockHost.taskStore.listAll.mockResolvedValue([
      { id: "os-xyz", title: "Epic", status: "open", issue_type: "epic" } as never,
      { id: "os-xyz.1", title: "Task 1", status: "closed", issue_type: "task" } as never,
    ]);
    vi.mocked(mockHost.taskStore.planGetByEpicId).mockResolvedValue({
      plan_id: "plan-3",
      content: "",
      metadata: {},
      shipped_content: null,
      updated_at: new Date().toISOString(),
    });

    await coordinator.postCompletionAsync(projectId, repoPath, "os-xyz.1");

    await vi.waitFor(() => {
      expect(mockHost.taskStore.close).toHaveBeenCalledWith(projectId, "os-xyz", "All tasks done");
    });
    await vi.waitFor(() => {
      expect(selfImprovementService.runIfDue).toHaveBeenCalledWith(projectId, {
        trigger: "after_each_plan",
        planId: "plan-3",
      });
    });
  });

  it("does not invoke runIfDue when task has no epic (Execute click alone does not trigger)", async () => {
    const { selfImprovementService } = await import("../services/self-improvement.service.js");
    mockHost.taskStore.listAll.mockResolvedValue([
      {
        id: "os-standalone",
        title: "Top-level task",
        status: "closed",
        issue_type: "task",
      } as never,
    ]);

    await coordinator.postCompletionAsync(projectId, repoPath, "os-standalone");

    expect(selfImprovementService.runIfDue).not.toHaveBeenCalled();
  });

  it("does not invoke runIfDue when not all impl tasks closed (plan execution not complete)", async () => {
    const { selfImprovementService } = await import("../services/self-improvement.service.js");
    mockHost.taskStore.listAll.mockResolvedValue([
      { id: "os-abc", title: "Epic", status: "open", issue_type: "epic" } as never,
      { id: "os-abc.1", title: "Task 1", status: "closed", issue_type: "task" } as never,
      { id: "os-abc.2", title: "Task 2", status: "open", issue_type: "task" } as never,
    ]);

    await coordinator.postCompletionAsync(projectId, repoPath, "os-abc.1");

    expect(selfImprovementService.runIfDue).not.toHaveBeenCalled();
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

  it("resolves sequential push rebase conflicts in a single push cycle", async () => {
    const { RebaseConflictError } = await import("../services/branch-manager.js");
    const prepareMainForPush = mockHost.branchManager.prepareMainForPush as unknown as ReturnType<
      typeof vi.fn
    >;
    const rebaseContinue = mockHost.branchManager.rebaseContinue as unknown as ReturnType<
      typeof vi.fn
    >;
    const pushMainToOrigin = mockHost.branchManager.pushMainToOrigin as unknown as ReturnType<
      typeof vi.fn
    >;
    const rebaseAbort = mockHost.branchManager.rebaseAbort as unknown as ReturnType<typeof vi.fn>;
    mockInspectGitRepoState.mockResolvedValue({
      isGitRepo: true,
      hasHead: true,
      currentBranch: "main",
      baseBranch: "main",
      hasOrigin: true,
      originReachable: true,
      remoteMode: "remote",
      originUrl: "git@github.com:opensprint/opensprint.git",
      identity: { name: "Test", email: "test@test.com", valid: true },
    });

    mockHost.runMergeQualityGates = vi.fn().mockResolvedValue(null);
    prepareMainForPush.mockRejectedValueOnce(new RebaseConflictError(["first.ts"]));
    rebaseContinue
      .mockRejectedValueOnce(new RebaseConflictError(["second.ts"]))
      .mockResolvedValueOnce(undefined);
    pushMainToOrigin.mockResolvedValue(undefined);
    (mockHost.runMergerAgentAndWait as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    await coordinator.postCompletionAsync(projectId, repoPath, taskId);

    expect(mockHost.runMergerAgentAndWait).toHaveBeenCalledTimes(2);
    expect(mockHost.runMergerAgentAndWait).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        phase: "push_rebase",
        conflictedFiles: ["first.ts"],
      })
    );
    expect(mockHost.runMergerAgentAndWait).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        phase: "push_rebase",
        conflictedFiles: ["second.ts"],
      })
    );
    expect(mockHost.runMergeQualityGates).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        repoPath,
        taskId: "baseline:main",
        validationWorkspace: "baseline",
      })
    );
    expect(pushMainToOrigin).toHaveBeenCalledWith(repoPath, "main");
    expect(rebaseAbort).not.toHaveBeenCalled();
  });

  it("runs another merger round when rebaseContinue is blocked preflight (unmerged paths)", async () => {
    const { RebaseConflictError, RebaseContinueBlockedError } =
      await import("../services/branch-manager.js");
    const prepareMainForPush = mockHost.branchManager.prepareMainForPush as unknown as ReturnType<
      typeof vi.fn
    >;
    const rebaseContinue = mockHost.branchManager.rebaseContinue as unknown as ReturnType<
      typeof vi.fn
    >;
    const pushMainToOrigin = mockHost.branchManager.pushMainToOrigin as unknown as ReturnType<
      typeof vi.fn
    >;
    const rebaseAbort = mockHost.branchManager.rebaseAbort as unknown as ReturnType<typeof vi.fn>;
    mockInspectGitRepoState.mockResolvedValue({
      isGitRepo: true,
      hasHead: true,
      currentBranch: "main",
      baseBranch: "main",
      hasOrigin: true,
      originReachable: true,
      remoteMode: "remote",
      originUrl: "git@github.com:opensprint/opensprint.git",
      identity: { name: "Test", email: "test@test.com", valid: true },
    });

    mockHost.runMergeQualityGates = vi.fn().mockResolvedValue(null);
    prepareMainForPush.mockRejectedValueOnce(new RebaseConflictError(["still.ts"]));
    rebaseContinue
      .mockRejectedValueOnce(
        new RebaseContinueBlockedError(
          "Rebase continue blocked (preflight): unmerged paths remain: still.ts",
          {
            cause: "preflight_unmerged",
            rebaseMetadataPresent: ["rebase-merge"],
            conflictedFiles: ["still.ts"],
          },
          "push_rebase"
        )
      )
      .mockResolvedValueOnce(undefined);
    pushMainToOrigin.mockResolvedValue(undefined);
    (mockHost.runMergerAgentAndWait as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    await coordinator.postCompletionAsync(projectId, repoPath, taskId);

    expect(mockHost.runMergerAgentAndWait).toHaveBeenCalledTimes(2);
    expect(mockHost.runMergerAgentAndWait).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        phase: "push_rebase",
        conflictedFiles: ["still.ts"],
      })
    );
    expect(pushMainToOrigin).toHaveBeenCalledWith(repoPath, "main");
    expect(rebaseAbort).not.toHaveBeenCalled();
  });

  it("aborts and fails push when sequential push rebase conflicts exceed max rounds", async () => {
    const { RebaseConflictError } = await import("../services/branch-manager.js");
    const prepareMainForPush = mockHost.branchManager.prepareMainForPush as unknown as ReturnType<
      typeof vi.fn
    >;
    const rebaseContinue = mockHost.branchManager.rebaseContinue as unknown as ReturnType<
      typeof vi.fn
    >;
    const pushMainToOrigin = mockHost.branchManager.pushMainToOrigin as unknown as ReturnType<
      typeof vi.fn
    >;
    const rebaseAbort = mockHost.branchManager.rebaseAbort as unknown as ReturnType<typeof vi.fn>;
    const merger = mockHost.runMergerAgentAndWait as unknown as ReturnType<typeof vi.fn>;
    mockInspectGitRepoState.mockResolvedValue({
      isGitRepo: true,
      hasHead: true,
      currentBranch: "main",
      baseBranch: "main",
      hasOrigin: true,
      originReachable: true,
      remoteMode: "remote",
      originUrl: "git@github.com:opensprint/opensprint.git",
      identity: { name: "Test", email: "test@test.com", valid: true },
    });

    prepareMainForPush.mockRejectedValueOnce(new RebaseConflictError(["first.ts"]));
    rebaseContinue.mockRejectedValue(new RebaseConflictError(["next.ts"]));
    merger.mockResolvedValue(true);

    await coordinator.postCompletionAsync(projectId, repoPath, taskId);

    expect(merger).toHaveBeenCalledTimes(12);
    expect(rebaseAbort).toHaveBeenCalledTimes(1);
    expect(pushMainToOrigin).not.toHaveBeenCalled();
  });

  it("does not publish a rebased main candidate when its baseline quality gates fail", async () => {
    const { selfImprovementService } = await import("../services/self-improvement.service.js");
    const prepareMainForPush = mockHost.branchManager.prepareMainForPush as unknown as ReturnType<
      typeof vi.fn
    >;
    const pushMainToOrigin = mockHost.branchManager.pushMainToOrigin as unknown as ReturnType<
      typeof vi.fn
    >;

    mockInspectGitRepoState.mockResolvedValue({
      isGitRepo: true,
      hasHead: true,
      currentBranch: "main",
      baseBranch: "main",
      hasOrigin: true,
      originReachable: true,
      remoteMode: "remote",
      originUrl: "git@github.com:opensprint/opensprint.git",
      identity: { name: "Test", email: "test@test.com", valid: true },
    });
    prepareMainForPush.mockResolvedValue(undefined);
    mockHost.runMergeQualityGates = vi.fn().mockResolvedValue({
      command: "npm run test",
      reason: "Command failed: npm run test",
      output: "stderr | rebased main failure",
      firstErrorLine: "stderr | rebased main failure",
      category: "quality_gate",
      worktreePath: repoPath,
    });

    await coordinator.postCompletionAsync(projectId, repoPath, taskId);

    expect(mockHost.runMergeQualityGates).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        repoPath,
        taskId: "baseline:main",
        validationWorkspace: "baseline",
      })
    );
    expect(selfImprovementService.ensureBaselineQualityGateTask).toHaveBeenCalledWith(projectId, {
      baseBranch: "main",
      command: "npm run test",
      reason: "Command failed: npm run test",
      outputSnippet: "stderr | rebased main failure",
      firstErrorLine: "stderr | rebased main failure",
      worktreePath: null,
      validationWorkspace: "baseline",
    });
    const { eventLogService } = await import("../services/event-log.service.js");
    const baselineCheckEvent = vi
      .mocked(eventLogService.append)
      .mock.calls.map(([, event]) => event)
      .find((event) => event.event === "baseline.check");
    expect(baselineCheckEvent?.data).toEqual(
      expect.objectContaining({
        source: "push_precheck",
        outcome: "failing",
        validationWorkspace: "baseline",
      })
    );
    expect(pushMainToOrigin).not.toHaveBeenCalled();
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

      await coordinator.performMergeAndDone(projectId, repoPath, makeEpicTask(), epicBranchName);

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

      await coordinator.performMergeAndDone(projectId, repoPath, lastTask(), epicBranchName);

      expect(mockGitQueueEnqueueAndWait).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "worktree_merge",
          branchName: epicBranchName,
          taskId: lastTaskId,
        })
      );
      await vi.waitFor(() => {
        expect(mockPrepareWorktreeForRemoval).toHaveBeenCalledWith(epicWorktreeKey);
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

      await coordinator.performMergeAndDone(projectId, repoPath, lastTask(), epicBranchName);

      const { triggerDeployForEvent } = await import("../services/deploy-trigger.service.js");
      await vi.waitFor(() => {
        expect(triggerDeployForEvent).toHaveBeenCalledWith(projectId, "each_task");
        expect(triggerDeployForEvent).toHaveBeenCalledWith(projectId, "each_epic");
      });
    });
  });

  describe("governance opt-in", () => {
    const publishableRepo = {
      isGitRepo: true,
      hasHead: true,
      currentBranch: "main",
      baseBranch: "main",
      hasOrigin: true,
      originReachable: true,
      remoteMode: "remote",
      originUrl: "git@example.test:repo.git",
      identity: { name: "Test", email: "test@test.com", valid: true },
    };
    const leaseBusy = () =>
      Object.assign(new Error("Another publication owns the lease"), {
        code: "GOVERNANCE_PUBLICATION_LEASE_BUSY",
      });
    const governance = async () =>
      (await import("../services/governance.service.js")).governanceService;
    const spies: { mockRestore(): void }[] = [];
    const setActive = async () => {
      spies.push(vi.spyOn(await governance(), "isGovernanceInactive").mockResolvedValue(false));
    };
    const mockLock = async () => {
      const spy = vi.spyOn(await governance(), "withPublicationLock");
      spies.push(spy);
      return spy;
    };
    afterEach(() => {
      for (const spy of spies.splice(0)) spy.mockRestore();
    });

    it("deploys an inactive project fire-and-forget without any publication receipt", async () => {
      const { triggerDeployForEvent } = await import("../services/deploy-trigger.service.js");
      let finishDeploy!: () => void;
      vi.mocked(triggerDeployForEvent).mockReturnValueOnce(
        new Promise((resolve) => {
          finishDeploy = () => resolve([]);
        })
      );
      mockInspectGitRepoState.mockResolvedValue(publishableRepo);

      await coordinator.postCompletionAsync(projectId, repoPath, taskId);

      expect(triggerDeployForEvent).toHaveBeenCalledWith(projectId, "each_task");
      expect(deferredDeployState.jobs.size).toBe(0);
      expect(deferredDeployState.claim).not.toHaveBeenCalled();
      finishDeploy();
    });

    it("runs an active deploy after the push block and never reports its failure as a publish failure", async () => {
      await setActive();
      mockInspectGitRepoState.mockResolvedValue(publishableRepo);
      deferredDeployState.claim.mockRejectedValue(new Error("deploy claim failed"));

      await expect(
        coordinator.postCompletionAsync(projectId, repoPath, taskId)
      ).resolves.toBeUndefined();

      expect(deferredDeployState.published).toBe(true);
      expect(mockListCleanupIntents).toHaveBeenCalled();
      expect(mockNotificationCreate).not.toHaveBeenCalled();
    });

    it("does not wait for a long claimed deploy or keep the push marked in progress", async () => {
      await setActive();
      mockInspectGitRepoState.mockResolvedValue(publishableRepo);
      deferredDeployState.claim.mockResolvedValue([{ id: "job" }]);
      deferredDeployState.runClaimed.mockReturnValue(new Promise(() => {}));

      await coordinator.postCompletionAsync(projectId, repoPath, taskId);

      expect(deferredDeployState.runClaimed).toHaveBeenCalledOnce();
      await expect(
        (
          coordinator as unknown as { waitForPushComplete(id: string): Promise<void> }
        ).waitForPushComplete(projectId)
      ).resolves.toBeUndefined();
    });

    it("treats a busy publication lease as a retryable push, not a thrown completion", async () => {
      await setActive();
      mockInspectGitRepoState.mockResolvedValue(publishableRepo);
      (await mockLock()).mockRejectedValue(leaseBusy());

      await expect(
        coordinator.postCompletionAsync(projectId, repoPath, taskId)
      ).resolves.toBeUndefined();
    });

    it("keeps a successful push when releasing its lease fails afterwards", async () => {
      await setActive();
      mockInspectGitRepoState.mockResolvedValue(publishableRepo);
      (await mockLock()).mockImplementation(async (_id, fn) => {
        await fn(async () => {});
        throw new Error("lease cleanup lost the database");
      });

      await coordinator.postCompletionAsync(projectId, repoPath, taskId);

      expect(mockListCleanupIntents).toHaveBeenCalled();
    });

    it("spends no merge attempt when only the publication lease was busy", async () => {
      await setActive();
      mockGitQueueEnqueueAndWait.mockRejectedValueOnce(leaseBusy());

      await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

      expect(mockHost.taskStore.setCumulativeAttempts).not.toHaveBeenCalled();
      expect(mockHost.taskStore.update).toHaveBeenCalledWith(
        projectId,
        taskId,
        expect.objectContaining({ status: "open", assignee: "" })
      );
      expect(mockHost.taskStore.close).not.toHaveBeenCalled();
    });

    it("skips admission for an inactive project", async () => {
      const execution = await import("../services/governance-execution.service.js");

      await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

      expect(execution.governanceCodeSnapshot).not.toHaveBeenCalled();
      expect(execution.governanceBranchPathSnapshot).not.toHaveBeenCalled();
      expect(mockGitQueueEnqueueAndWait).toHaveBeenCalled();
    });

    it("uses the bounded merge-base path list for a pinless task on an active project", async () => {
      await setActive();
      const execution = await import("../services/governance-execution.service.js");

      await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

      expect(execution.governanceBranchPathSnapshot).toHaveBeenCalledWith(
        "/tmp/worktree",
        expect.any(String)
      );
      expect(execution.governanceCodeSnapshot).not.toHaveBeenCalled();
    });
  });
});

vi.mock("../services/governance.service.js", async () => ({
  governanceService: (await import("./mocks/disabled-governance.js")).disabledGovernanceService,
}));

vi.mock("../services/governance-execution.service.js", () => ({
  governanceExecutionService: { assertScope: async () => {} },
  governanceCodeSnapshot: vi.fn(async () => ({
    headSha: "head",
    baseSha: "base",
    diff: "",
    diffHash: "hash",
    changedPaths: [],
  })),
  governanceBranchPathSnapshot: vi.fn(async () => ({
    headSha: "head",
    baseSha: "base",
    diffHash: "hash",
    changedPaths: [],
  })),
}));

const deferredDeployState = vi.hoisted(() => ({
  jobs: new Map<string, { projectId: string; event: "each_task" | "each_epic" }>(),
  published: false,
  claim: vi.fn(),
  runClaimed: vi.fn(),
}));
beforeEach(() => {
  deferredDeployState.jobs.clear();
  deferredDeployState.published = false;
  deferredDeployState.claim.mockReset().mockResolvedValue([]);
  deferredDeployState.runClaimed.mockReset().mockResolvedValue(undefined);
});
vi.mock("../services/deferred-auto-deploy.service.js", () => ({
  deferredAutoDeployService: {
    enqueue: async (
      projectId: string,
      event: "each_task" | "each_epic",
      sourceId: string,
      generation: string
    ) => {
      deferredDeployState.jobs.set(`${projectId}:${event}:${sourceId}:${generation}`, {
        projectId,
        event,
      });
    },
    hasPending: async () => deferredDeployState.jobs.size > 0,
    claim: (...args: unknown[]) => deferredDeployState.claim(...args),
    runClaimed: (...args: unknown[]) => deferredDeployState.runClaimed(...args),
  },
}));
vi.mock("../services/remote-publication-governance.service.js", () => ({
  remotePublicationGovernanceService: {
    beginPush: async () => ({ receiptIds: [], inputHeadSha: "head", baseBranch: "main" }),
    assertPreparedPush: async () => ({ headSha: "head", receiptIds: [] }),
    completePush: async () => {
      deferredDeployState.published = true;
    },
    getDeployableHead: async () => {
      const state = await mockInspectGitRepoState();
      return state.remoteMode === "local_only" || deferredDeployState.published ? "head" : null;
    },
  },
}));
