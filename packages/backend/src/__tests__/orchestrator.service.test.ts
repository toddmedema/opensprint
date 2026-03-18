import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { OrchestratorService, formatReviewFeedback } from "../services/orchestrator.service.js";
import { sessionManager as mockSessionManager } from "../services/session-manager.js";
import {
  buildReviewNoResultFailureReason,
  extractNoResultReasonFromOutput,
} from "../services/no-result-reason.service.js";
import { heartbeatService } from "../services/heartbeat.service.js";
import { RepoPreflightError } from "../utils/git-repo-state.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import type { ReviewAgentResult } from "@opensprint/shared";
import { OPEN_QUESTION_BLOCK_REASON } from "@opensprint/shared";

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (a: unknown, b: unknown) => [a, b],
}));
vi.mock("../db/drizzle-schema-pg.js", () => ({ plansTable: {} }));

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
  mockTaskStoreGetBlockersFromIssue,
  mockGetProject,
  mockGetRepoPath,
  mockGetProjectByRepoPath,
  mockGetSettings,
  mockGetValidationTimeoutMs,
  mockRecordValidationDuration,
  mockCreateTaskWorktree,
  mockCreateOrCheckoutBranch,
  mockEnsureRepoNodeModules,
  mockCheckDependencyIntegrity,
  mockEnsureDependenciesHealthy,
  mockSyncMainWithOrigin,
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
  mockCreateProcessGroupHandle,
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
  mockInspectGitRepoState,
  mockEnsureBaseBranchExists,
  mockEnsureGitIdentityConfigured,
  mockResolveBaseBranch,
  mockShellExec,
  mockGetMergeQualityGateCommands,
  mockIsSelfImprovementRunInProgress,
  mockHasOpenPrdSpecHilApproval,
  mockNotificationCreate,
  mockMaybeAutoRespond,
  mockRecordAttempt,
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
  mockTaskStoreGetBlockersFromIssue: vi.fn().mockReturnValue([]),
  mockGetProject: vi.fn(),
  mockGetRepoPath: vi.fn(),
  mockGetProjectByRepoPath: vi.fn().mockResolvedValue({ id: "proj-1", repoPath: "/tmp/repo" }),
  mockGetSettings: vi.fn(),
  mockGetValidationTimeoutMs: vi.fn(),
  mockRecordValidationDuration: vi.fn().mockResolvedValue(undefined),
  mockCreateTaskWorktree: vi.fn(),
  mockCreateOrCheckoutBranch: vi.fn(),
  mockEnsureRepoNodeModules: vi.fn(),
  mockCheckDependencyIntegrity: vi.fn(),
  mockEnsureDependenciesHealthy: vi.fn(),
  mockSyncMainWithOrigin: vi.fn(),
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
  mockCreateProcessGroupHandle: vi.fn(),
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
  mockInspectGitRepoState: vi.fn(),
  mockEnsureBaseBranchExists: vi.fn(),
  mockEnsureGitIdentityConfigured: vi.fn(),
  mockResolveBaseBranch: vi.fn(),
  mockShellExec: vi.fn(),
  mockGetMergeQualityGateCommands: vi.fn(),
  mockIsSelfImprovementRunInProgress: vi.fn().mockReturnValue(false),
  mockHasOpenPrdSpecHilApproval: vi.fn().mockResolvedValue(false),
  mockNotificationCreate: vi.fn().mockResolvedValue({
    id: "oq-1",
    projectId: "",
    source: "execute",
    sourceId: "",
    questions: [],
    status: "open",
    createdAt: "",
    resolvedAt: null,
  }),
  mockMaybeAutoRespond: vi.fn().mockResolvedValue(undefined),
  mockRecordAttempt: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../websocket/index.js", () => ({
  broadcastToProject: (...args: unknown[]) => mockBroadcastToProject(...args),
  sendAgentOutputToProject: (...args: unknown[]) => mockSendAgentOutputToProject(...args),
}));

vi.mock("../services/task-store.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/task-store.service.js")>();
  const { createMockDbClient } = await import("./test-db-helper.js");
  const mockDb = createMockDbClient({
    queryOne: vi.fn().mockResolvedValue({ total_done: 0, total_failed: 0, queue_depth: 0 }),
  });
  const mockInstance = {
    ready: mockTaskStoreReady,
    readyWithStatusMap: vi.fn().mockImplementation(async () => {
      const tasks = await mockTaskStoreReady();
      return { tasks, statusMap: new Map(), allIssues: tasks };
    }),
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
    setConflictFiles: vi.fn().mockResolvedValue(undefined),
    setMergeStage: vi.fn().mockResolvedValue(undefined),
    export: mockTaskStoreExport,
    getStatusMap: mockTaskStoreGetStatusMap,
    listAll: mockTaskStoreListAll,
    getBlockersFromIssue: mockTaskStoreGetBlockersFromIssue,
    getParentId: vi.fn().mockImplementation((taskId: string) => {
      const lastDot = taskId.lastIndexOf(".");
      return lastDot > 0 ? taskId.slice(0, lastDot) : null;
    }),
    planGetByEpicId: vi.fn().mockResolvedValue(null),
  };
  return {
    TaskStoreService: vi.fn().mockImplementation(() => mockInstance),
    taskStore: mockInstance,
    resolveEpicId: actual.resolveEpicId,
  };
});

vi.mock("../services/project.service.js", () => ({
  ProjectService: vi.fn().mockImplementation(() => ({
    getProject: mockGetProject,
    getRepoPath: mockGetRepoPath,
    getProjectByRepoPath: mockGetProjectByRepoPath,
    getSettings: mockGetSettings,
    getValidationTimeoutMs: mockGetValidationTimeoutMs,
    recordValidationDuration: mockRecordValidationDuration,
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
      checkDependencyIntegrity: mockCheckDependencyIntegrity,
      ensureDependenciesHealthy: mockEnsureDependenciesHealthy,
      syncMainWithOrigin: mockSyncMainWithOrigin,
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

vi.mock("../services/session-manager.js", () => {
  const mockInstance = {
    getActiveDir: mockGetActiveDir,
    readResult: mockReadResult,
    clearResult: mockClearResult,
    createSession: mockCreateSession,
    archiveSession: mockArchiveSession,
    listSessions: mockListSessions,
  };
  return {
    SessionManager: vi.fn().mockImplementation(() => mockInstance),
    sessionManager: mockInstance,
  };
});

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
  createProcessGroupHandle: mockCreateProcessGroupHandle,
}));

vi.mock("../services/agent-identity.service.js", () => ({
  agentIdentityService: {
    recordAttempt: (...args: unknown[]) => mockRecordAttempt(...args),
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

const mockGetNextKey = vi.fn().mockResolvedValue({ key: "test-key", keyId: "k1", source: "env" });
vi.mock("../services/api-key-resolver.service.js", () => ({
  getNextKey: (...args: unknown[]) => mockGetNextKey(...args),
}));

vi.mock("../services/api-key-exhausted.service.js", () => ({
  isExhausted: vi.fn().mockReturnValue(false),
  clearExhausted: vi.fn(),
  markExhausted: vi.fn(),
}));

vi.mock("../utils/git-repo-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/git-repo-state.js")>();
  return {
    ...actual,
    inspectGitRepoState: (...args: unknown[]) => mockInspectGitRepoState(...args),
    ensureBaseBranchExists: (...args: unknown[]) => mockEnsureBaseBranchExists(...args),
    ensureGitIdentityConfigured: (...args: unknown[]) => mockEnsureGitIdentityConfigured(...args),
    resolveBaseBranch: (...args: unknown[]) => mockResolveBaseBranch(...args),
  };
});

vi.mock("../utils/shell-exec.js", () => ({
  shellExec: (...args: unknown[]) => mockShellExec(...args),
}));

vi.mock("../services/merge-quality-gates.js", () => ({
  getMergeQualityGateCommands: (...args: unknown[]) => mockGetMergeQualityGateCommands(...args),
}));

vi.mock("../services/crash-recovery.service.js", () => ({
  CrashRecoveryService: vi.fn().mockImplementation(() => ({
    findOrphanedAssignments: mockFindOrphanedAssignments,
    findOrphanedAssignmentsFromWorktrees: mockFindOrphanedAssignmentsFromWorktrees,
    deleteAssignmentAt: mockDeleteAssignmentAt,
  })),
}));

vi.mock("../services/notification.service.js", () => ({
  notificationService: {
    hasOpenPrdSpecHilApproval: (...args: unknown[]) => mockHasOpenPrdSpecHilApproval(...args),
    listByProject: vi.fn().mockResolvedValue([]),
    createApiBlocked: vi.fn().mockResolvedValue({
      id: "ab-1",
      projectId: "",
      source: "execute",
      sourceId: "",
      questions: [],
      status: "open",
      createdAt: "",
      resolvedAt: null,
      kind: "api_blocked",
    }),
    create: (...args: unknown[]) => mockNotificationCreate(...args),
    resolveRateLimitNotifications: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../services/open-question-autoresolve.service.js", () => ({
  maybeAutoRespond: (...args: unknown[]) => mockMaybeAutoRespond(...args),
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

vi.mock("../services/self-improvement-runner.service.js", () => ({
  isSelfImprovementRunInProgress: (...args: unknown[]) =>
    mockIsSelfImprovementRunInProgress(...args),
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
    deployment: { mode: "custom", autoResolveFeedbackOnTaskCompletion: false },
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
    orchestrator.setSessionManager(mockSessionManager);

    repoPath = path.join(os.tmpdir(), `orchestrator-test-${Date.now()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await fs.mkdir(path.join(repoPath, ".opensprint"), { recursive: true });

    mockGetProject.mockResolvedValue({ id: projectId });
    mockGetRepoPath.mockResolvedValue(repoPath);
    mockGetSettings.mockResolvedValue(defaultSettings);
    mockGetValidationTimeoutMs.mockResolvedValue(300_000);
    mockRecordValidationDuration.mockResolvedValue(undefined);
    mockRecoverOrphanedTasks.mockResolvedValue({ recovered: [] });
    mockRecoverFromStaleHeartbeats.mockResolvedValue({ recovered: [] });
    mockFindOrphanedAssignments.mockResolvedValue([]);
    mockRunFullRecovery.mockResolvedValue({ reattached: [], requeued: [], cleaned: [] });
    mockInspectGitRepoState.mockResolvedValue({
      baseBranch: "main",
      currentBranch: "main",
      hasHead: true,
      hasCommits: true,
      branches: ["main"],
      identity: { name: "Test User", email: "test@example.com" },
    });
    mockEnsureBaseBranchExists.mockResolvedValue(undefined);
    mockEnsureGitIdentityConfigured.mockResolvedValue({
      name: "Test",
      email: "test@test.com",
      valid: true,
    });
    mockShellExec.mockResolvedValue({ stdout: "", stderr: "" });
    mockGetMergeQualityGateCommands.mockReturnValue(["npm run lint", "npm run test"]);
    mockResolveBaseBranch.mockResolvedValue("main");
    mockCheckDependencyIntegrity.mockResolvedValue(undefined);
    mockEnsureDependenciesHealthy.mockResolvedValue({
      healthy: true,
      checkOutput: "",
      repairAttempted: false,
      repairSucceeded: false,
      repairCommands: [],
      repairOutput: "",
    });
    mockTaskStoreGetStatusMap.mockResolvedValue(new Map());
    mockTaskStoreListAll.mockResolvedValue([]);
    mockTaskStoreGetBlockersFromIssue.mockReturnValue([]);
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
    mockRunScopedTests.mockResolvedValue({
      passed: 0,
      failed: 0,
      rawOutput: "",
      executedCommand: "npm test",
      scope: "full",
    });
    mockListSessions.mockResolvedValue([]);
    mockBuildContext.mockResolvedValue({
      prdExcerpt: "",
      planContent: "",
      dependencyOutputs: [],
      taskDescription: "",
    });
    mockCreateProcessGroupHandle.mockReturnValue({ kill: vi.fn(), pid: 12345 });
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

  describe("pending validation review rejection handling", () => {
    it("detects pending-only orchestrator status rejection", () => {
      const isPendingOnly = (
        orchestrator as unknown as {
          isPendingValidationOnlyRejection: (result: ReviewAgentResult) => boolean;
        }
      ).isPendingValidationOnlyRejection.bind(orchestrator);

      expect(
        isPendingOnly({
          status: "rejected",
          summary:
            "Review rejected: Orchestrator test status in .opensprint/active/os-1234/context/orchestrator-test-status.md is PENDING.",
          notes: "",
        })
      ).toBe(true);

      expect(
        isPendingOnly({
          status: "rejected",
          summary:
            "Review rejected: Orchestrator test status in .opensprint/active/os-1234/context/orchestrator-test-status.md is PENDING.",
          issues: ["packages/backend/src/x.ts:12 regression in parsing"],
          notes: "",
        })
      ).toBe(false);
    });
  });

  describe("review no_result diagnostics", () => {
    it("formats angle-aware no_result reasons for multi-angle failures", () => {
      const reason = buildReviewNoResultFailureReason({
        status: "no_result",
        result: null,
        exitCode: 1,
        failureContext: [
          { angle: "security", exitCode: 1, reason: "missing result.json" },
          { angle: "performance", exitCode: 0 },
        ],
      });

      expect(reason).toContain("security");
      expect(reason).toContain("performance");
      expect(reason).toContain("missing result.json");
    });

    it("extracts structured error from JSON output and ignores init frames", () => {
      const reason = extractNoResultReasonFromOutput([
        '{"type":"system","subtype":"init","apiKeySource":"env"}\n',
        '{"type":"error","message":"Security command failed: Security process exited with code: 45"}\n',
      ]);

      expect(reason).toContain("Security command failed");
    });

    it("ignores punctuation-only fragments in no_result output parsing", () => {
      const reason = extractNoResultReasonFromOutput(["}\n", " \n"]);

      expect(reason).toBeUndefined();
    });
  });

  describe("coding no_result recovery", () => {
    it("turns structured terminal clarification output into blocked open questions", async () => {
      const { task } = setupSingleTaskFlow("task-open-question");
      mockReadResult.mockResolvedValue(null);
      mockNotificationCreate.mockImplementation(
        async (input: {
          projectId: string;
          source: string;
          sourceId: string;
          questions: Array<{ id: string; text: string }>;
        }) => ({
          id: "oq-1",
          projectId: input.projectId,
          source: input.source,
          sourceId: input.sourceId,
          questions: input.questions,
          status: "open",
          createdAt: "2026-03-13T23:12:13.000Z",
          resolvedAt: null,
        })
      );

      await orchestrator.ensureRunning(projectId);
      await vi.waitFor(() => {
        expect(mockWriteJsonAtomic).toHaveBeenCalled();
      });

      const state = (
        orchestrator as unknown as { getState: (id: string) => { slots: Map<string, unknown> } }
      ).getState(projectId);
      const slot = state.slots.get(task.id) as {
        branchName?: string;
        agent: { outputLog: string[]; killedDueToTimeout: boolean };
      };
      expect(slot).toBeTruthy();
      slot.agent.killedDueToTimeout = false;
      slot.agent.outputLog = [
        '{"type":"result","subtype":"success","result":"Unexpected workspace change detected while running the baseline gates: `packages/frontend/vite.config.js` was reformatted (indentation-only diff) by tooling.\\n\\nHow do you want me to proceed?\\n- keep this formatting change and include it in commits\\n- leave it out and continue with only the baseline-gate fixes."}\n',
      ];

      const invokeHandleCodingDone = orchestrator as unknown as {
        handleCodingDone(
          projectId: string,
          repoPath: string,
          task: typeof task,
          branchName: string,
          exitCode: number | null
        ): Promise<void>;
      };

      await invokeHandleCodingDone.handleCodingDone(
        projectId,
        repoPath,
        task,
        slot.branchName ?? `opensprint/${task.id}`,
        0
      );

      expect(mockNotificationCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId,
          source: "execute",
          sourceId: task.id,
          questions: [
            expect.objectContaining({
              text: expect.stringContaining("How do you want me to proceed?"),
            }),
          ],
        })
      );
      expect(mockTaskStoreUpdate).toHaveBeenCalledWith(
        projectId,
        task.id,
        expect.objectContaining({
          assignee: "",
          status: "blocked",
          block_reason: OPEN_QUESTION_BLOCK_REASON,
        })
      );
      expect(mockTaskStoreComment).not.toHaveBeenCalled();
      expect(mockMaybeAutoRespond).toHaveBeenCalled();
      expect(mockRecordAttempt).toHaveBeenCalledWith(
        repoPath,
        expect.objectContaining({
          taskId: task.id,
          role: "coder",
          outcome: "coding_failure",
        })
      );
    });

    it("turns assistant chat clarification output into blocked open questions", async () => {
      const { task } = setupSingleTaskFlow("task-open-question-chat");
      mockReadResult.mockResolvedValue(null);
      mockNotificationCreate.mockImplementation(
        async (input: {
          projectId: string;
          source: string;
          sourceId: string;
          questions: Array<{ id: string; text: string }>;
        }) => ({
          id: "oq-2",
          projectId: input.projectId,
          source: input.source,
          sourceId: input.sourceId,
          questions: input.questions,
          status: "open",
          createdAt: "2026-03-13T23:22:13.000Z",
          resolvedAt: null,
        })
      );

      await orchestrator.ensureRunning(projectId);
      await vi.waitFor(() => {
        expect(mockWriteJsonAtomic).toHaveBeenCalled();
      });

      const state = (
        orchestrator as unknown as { getState: (id: string) => { slots: Map<string, unknown> } }
      ).getState(projectId);
      const slot = state.slots.get(task.id) as {
        branchName?: string;
        agent: { outputLog: string[]; killedDueToTimeout: boolean };
      };
      expect(slot).toBeTruthy();
      slot.agent.killedDueToTimeout = false;
      slot.agent.outputLog = [
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Unexpected workspace change detected while running the baseline gates.\\n\\nHow do you want me to proceed?\\n- keep this formatting change and include it in commits\\n- leave it out and continue with only the baseline-gate fixes."}]}}\n',
      ];

      const invokeHandleCodingDone = orchestrator as unknown as {
        handleCodingDone(
          projectId: string,
          repoPath: string,
          task: typeof task,
          branchName: string,
          exitCode: number | null
        ): Promise<void>;
      };

      await invokeHandleCodingDone.handleCodingDone(
        projectId,
        repoPath,
        task,
        slot.branchName ?? `opensprint/${task.id}`,
        0
      );

      expect(mockNotificationCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId,
          source: "execute",
          sourceId: task.id,
          questions: [
            expect.objectContaining({
              text: expect.stringContaining("How do you want me to proceed?"),
            }),
          ],
        })
      );
      expect(mockTaskStoreUpdate).toHaveBeenCalledWith(
        projectId,
        task.id,
        expect.objectContaining({
          assignee: "",
          status: "blocked",
          block_reason: OPEN_QUESTION_BLOCK_REASON,
        })
      );
    });
  });

  describe("preflightCheck", () => {
    it("runs dependency integrity check after restoring missing node_modules in branches mode", async () => {
      const invokePreflight = orchestrator as unknown as {
        preflightCheck(
          repoPath: string,
          wtPath: string,
          taskId: string,
          baseBranch?: string,
          reviewAngles?: Array<"security" | "performance">
        ): Promise<void>;
      };

      await invokePreflight.preflightCheck(repoPath, repoPath, "task-preflight", "main");

      expect(mockEnsureRepoNodeModules).toHaveBeenCalledWith(repoPath);
      expect(mockCheckDependencyIntegrity).toHaveBeenCalledWith(repoPath, repoPath);
    });

    it("clears top-level and per-angle result files for review attempts", async () => {
      await fs.mkdir(path.join(repoPath, "node_modules"), { recursive: true });
      const invokePreflight = orchestrator as unknown as {
        preflightCheck(
          repoPath: string,
          wtPath: string,
          taskId: string,
          baseBranch?: string,
          reviewAngles?: Array<"security" | "performance">
        ): Promise<void>;
      };

      await invokePreflight.preflightCheck(repoPath, repoPath, "task-preflight", "main", [
        "security",
        "performance",
      ]);

      expect(mockClearResult).toHaveBeenNthCalledWith(1, repoPath, "task-preflight");
      expect(mockClearResult).toHaveBeenNthCalledWith(2, repoPath, "task-preflight", "security");
      expect(mockClearResult).toHaveBeenNthCalledWith(3, repoPath, "task-preflight", "performance");
    });

    it("propagates git identity preflight errors unchanged", async () => {
      await fs.mkdir(path.join(repoPath, "node_modules"), { recursive: true });
      const expected = new RepoPreflightError(
        "Git identity missing",
        ErrorCodes.GIT_IDENTITY_REQUIRED
      );
      mockEnsureGitIdentityConfigured.mockRejectedValueOnce(expected);
      const invokePreflight = orchestrator as unknown as {
        preflightCheck(
          repoPath: string,
          wtPath: string,
          taskId: string,
          baseBranch?: string,
          reviewAngles?: Array<"security" | "performance">
        ): Promise<void>;
      };

      await expect(
        invokePreflight.preflightCheck(repoPath, repoPath, "task-preflight", "main")
      ).rejects.toBe(expected);
    });

    it("does not remap unexpected identity check errors to repo preflight", async () => {
      await fs.mkdir(path.join(repoPath, "node_modules"), { recursive: true });
      const expected = new ReferenceError("assertGitIdentityConfigured is not defined");
      mockEnsureGitIdentityConfigured.mockRejectedValueOnce(expected);
      const invokePreflight = orchestrator as unknown as {
        preflightCheck(
          repoPath: string,
          wtPath: string,
          taskId: string,
          baseBranch?: string,
          reviewAngles?: Array<"security" | "performance">
        ): Promise<void>;
      };

      await expect(
        invokePreflight.preflightCheck(repoPath, repoPath, "task-preflight", "main")
      ).rejects.toBe(expected);
    });

    it("throws dependency integrity preflight error when deps remain unhealthy", async () => {
      await fs.mkdir(path.join(repoPath, "node_modules"), { recursive: true });
      mockCheckDependencyIntegrity.mockRejectedValueOnce(
        new RepoPreflightError(
          "Dependency integrity check failed after one automatic repair attempt.",
          ErrorCodes.REPO_DEPENDENCIES_INVALID,
          ["npm ci", "npm ls --depth=0 --workspaces"]
        )
      );
      const invokePreflight = orchestrator as unknown as {
        preflightCheck(
          repoPath: string,
          wtPath: string,
          taskId: string,
          baseBranch?: string,
          reviewAngles?: Array<"security" | "performance">
        ): Promise<void>;
      };

      await expect(
        invokePreflight.preflightCheck(repoPath, repoPath, "task-preflight", "main")
      ).rejects.toMatchObject({
        name: "RepoPreflightError",
        code: ErrorCodes.REPO_DEPENDENCIES_INVALID,
      });
    });
  });

  describe("runMergeQualityGates", () => {
    const taskId = "task-quality-gate";
    const branchName = "opensprint/task-quality-gate";
    const baseBranch = "main";
    const worktreePath = path.join(os.tmpdir(), "opensprint-quality-gate-worktree");

    const runMergeQualityGates = () =>
      orchestrator.runMergeQualityGates({
        projectId,
        repoPath,
        worktreePath,
        taskId,
        branchName,
        baseBranch,
      });

    it("does not auto-repair when failure has no env fingerprint", async () => {
      const previousNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      try {
        mockShellExec.mockRejectedValueOnce({
          message: "Command failed: npm run lint",
          stderr: "src/foo.ts: error TS2304: Cannot find name 'x'",
        });

        const failure = await runMergeQualityGates();

        expect(failure).toMatchObject({
          command: "npm run lint",
          category: "quality_gate",
          autoRepairAttempted: false,
          autoRepairSucceeded: false,
        });
        expect(mockShellExec).toHaveBeenCalledTimes(1);
        expect(mockShellExec).toHaveBeenCalledWith(
          "npm run lint",
          expect.objectContaining({ cwd: worktreePath })
        );
        expect(mockSymlinkNodeModules).not.toHaveBeenCalled();
      } finally {
        process.env.NODE_ENV = previousNodeEnv;
      }
    });

    it("surfaces the first meaningful compiler/test error line on gate failure", async () => {
      const previousNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      try {
        mockShellExec.mockRejectedValueOnce({
          message: "Command failed: npm run lint",
          stderr: [
            "> eslint .",
            "npm ERR! code 1",
            "npm ERR! path /tmp/repo",
            "src/foo.ts: error TS2304: Cannot find name 'x'",
          ].join("\n"),
        });

        const failure = await runMergeQualityGates();

        expect(failure).toMatchObject({
          command: "npm run lint",
          category: "quality_gate",
          firstErrorLine: "src/foo.ts: error TS2304: Cannot find name 'x'",
        });
      } finally {
        process.env.NODE_ENV = previousNodeEnv;
      }
    });

    it("finds the first meaningful error line even when it appears after long passing output", async () => {
      const previousNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      try {
        const longPassingOutput = `${"✓ passing test\n".repeat(400)}AssertionError: expected 401 to be 403`;
        mockShellExec.mockRejectedValueOnce({
          message: "Command failed: npm run test",
          stdout: longPassingOutput,
          stderr: "",
        });

        const failure = await runMergeQualityGates();

        expect(failure).toMatchObject({
          command: "npm run lint",
          category: "quality_gate",
          firstErrorLine: "AssertionError: expected 401 to be 403",
        });
      } finally {
        process.env.NODE_ENV = previousNodeEnv;
      }
    });

    it("runs one env auto-repair and continues gates when retry succeeds", async () => {
      const previousNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      try {
        mockShellExec
          .mockRejectedValueOnce({
            message: "Command failed: npm run lint",
            stderr: "Error: MODULE_NOT_FOUND: Cannot find module 'typescript'",
          })
          .mockResolvedValueOnce({ stdout: "added 1 package", stderr: "" })
          .mockResolvedValueOnce({ stdout: "", stderr: "" })
          .mockResolvedValueOnce({ stdout: "", stderr: "" });

        const failure = await runMergeQualityGates();

        expect(failure).toBeNull();
        expect(mockShellExec.mock.calls.map((call) => call[0])).toEqual([
          "npm run lint",
          "npm ci",
          "npm run lint",
          "npm run test",
        ]);
        expect(mockSymlinkNodeModules).toHaveBeenCalledTimes(1);
        expect(mockSymlinkNodeModules).toHaveBeenCalledWith(repoPath, worktreePath);
      } finally {
        process.env.NODE_ENV = previousNodeEnv;
      }
    });

    it("classifies as environment_setup when retry still matches env fingerprint", async () => {
      const previousNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      try {
        mockShellExec
          .mockRejectedValueOnce({
            message: "Command failed: npm run lint",
            stderr: "Cannot find module 'eslint'",
          })
          .mockResolvedValueOnce({ stdout: "", stderr: "" })
          .mockRejectedValueOnce({
            message: "Command failed: npm run lint",
            stderr: "MODULE_NOT_FOUND: Cannot find module 'eslint'",
          });

        const failure = await runMergeQualityGates();

        expect(failure).toMatchObject({
          command: "npm run lint",
          category: "environment_setup",
          autoRepairAttempted: true,
          autoRepairSucceeded: true,
        });
        expect(mockShellExec).toHaveBeenCalledTimes(3);
        expect(mockShellExec.mock.calls.map((call) => call[0])).toEqual([
          "npm run lint",
          "npm ci",
          "npm run lint",
        ]);
      } finally {
        process.env.NODE_ENV = previousNodeEnv;
      }
    });

    it("downgrades to quality_gate when retry fails without env fingerprint", async () => {
      const previousNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      try {
        mockShellExec
          .mockRejectedValueOnce({
            message: "Command failed: npm run lint",
            stderr: "Cannot find module 'eslint'",
          })
          .mockResolvedValueOnce({ stdout: "", stderr: "" })
          .mockRejectedValueOnce({
            message: "Command failed: npm run lint",
            stderr: "src/foo.ts: error TS2304: Cannot find name 'x'",
          });

        const failure = await runMergeQualityGates();

        expect(failure).toMatchObject({
          command: "npm run lint",
          category: "quality_gate",
          autoRepairAttempted: true,
          autoRepairSucceeded: true,
        });
        expect(mockShellExec).toHaveBeenCalledTimes(3);
      } finally {
        process.env.NODE_ENV = previousNodeEnv;
      }
    });

    it("retries the gate once even when npm ci repair fails", async () => {
      const previousNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      try {
        mockShellExec
          .mockRejectedValueOnce({
            message: "Command failed: npm run lint",
            stderr: "Cannot find module 'eslint'",
          })
          .mockRejectedValueOnce({
            message: "Command failed: npm ci",
            stderr: "npm ERR! network timeout",
          })
          .mockRejectedValueOnce({
            message: "Command failed: npm run lint",
            stderr: "src/foo.ts: error TS2304: Cannot find name 'x'",
          });

        const failure = await runMergeQualityGates();

        expect(failure).toMatchObject({
          command: "npm run lint",
          category: "quality_gate",
          autoRepairAttempted: true,
          autoRepairSucceeded: false,
        });
        expect(mockShellExec.mock.calls.map((call) => call[0])).toEqual([
          "npm run lint",
          "npm ci",
          "npm run lint",
        ]);
        expect(mockSymlinkNodeModules).toHaveBeenCalledTimes(1);
      } finally {
        process.env.NODE_ENV = previousNodeEnv;
      }
    });

    it("persists repair metadata and performs only one retry when symlink repair step fails", async () => {
      const previousNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      try {
        mockShellExec
          .mockRejectedValueOnce({
            message: "Command failed: npm run lint",
            stderr: "Cannot find module 'eslint'",
          })
          .mockResolvedValueOnce({
            stdout: "added 1 package",
            stderr: "",
          })
          .mockRejectedValueOnce({
            message: "Command failed: npm run lint",
            stderr: "MODULE_NOT_FOUND: Cannot find module 'eslint'",
          });
        mockSymlinkNodeModules.mockRejectedValueOnce(new Error("EPERM: symlink failed"));

        const failure = await runMergeQualityGates();

        expect(failure).toMatchObject({
          command: "npm run lint",
          category: "environment_setup",
          autoRepairAttempted: true,
          autoRepairSucceeded: false,
          autoRepairCommands: ["npm ci", "symlinkNodeModules"],
        });
        expect(failure?.autoRepairOutput).toContain("[npm ci] added 1 package");
        expect(failure?.autoRepairOutput).toContain("[symlinkNodeModules] EPERM: symlink failed");
        expect(mockShellExec.mock.calls.map((call) => call[0])).toEqual([
          "npm run lint",
          "npm ci",
          "npm run lint",
        ]);
        expect(mockSymlinkNodeModules).toHaveBeenCalledTimes(1);
      } finally {
        process.env.NODE_ENV = previousNodeEnv;
      }
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
          handleCompletedAssignment: expect.any(Function),
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

    it("rebuilds review coordination when recovering a review-phase task", async () => {
      const task = { ...makeTask("task-review"), status: "in_progress" };
      const host = orchestrator.getRecoveryHost();

      mockGetSettings.mockResolvedValue({
        ...defaultSettings,
        reviewMode: "always",
        simpleComplexityAgent: { type: "cursor", model: "gpt-5", cliCommand: null },
        complexComplexityAgent: { type: "cursor", model: "gpt-5", cliCommand: null },
      });
      mockGetChangedFiles.mockResolvedValue(["src/foo.ts"]);
      mockRunScopedTests.mockResolvedValue({
        passed: 3,
        failed: 0,
        rawOutput: "ok",
        executedCommand:
          "node ./node_modules/vitest/vitest.mjs related --run --testTimeout=30000 src/foo.ts",
        scope: "scoped",
      });
      mockGetActiveDir.mockImplementation((base: string, tid: string) =>
        path.join(base, ".opensprint", "active", tid)
      );
      mockWriteJsonAtomic.mockResolvedValue(undefined);
      mockInvokeReviewAgent.mockImplementation(() => ({ kill: vi.fn(), pid: 4321 }));

      const resumed = await host.resumeReviewPhase?.(
        projectId,
        repoPath,
        task as never,
        {
          taskId: task.id,
          projectId,
          phase: "review",
          branchName: `opensprint/${task.id}`,
          worktreePath: repoPath,
          promptPath: path.join(repoPath, ".opensprint", "active", task.id, "prompt.md"),
          agentConfig: { type: "cursor", model: "gpt-5", cliCommand: null },
          attempt: 2,
          createdAt: "2026-03-02T10:00:00.000Z",
        },
        { pidAlive: false }
      );

      expect(resumed).toBe(true);
      await vi.waitFor(() => {
        expect(mockRunScopedTests).toHaveBeenCalledWith(
          repoPath,
          ["src/foo.ts"],
          expect.any(String),
          expect.objectContaining({ timeoutMs: expect.any(Number) })
        );
      });
      await vi.waitFor(() => {
        expect(mockInvokeReviewAgent).toHaveBeenCalled();
      });
      await vi.waitFor(() => {
        expect(mockCommitWip).toHaveBeenCalledWith(repoPath, task.id);
      });
      const statusPath = path.join(
        repoPath,
        ".opensprint",
        "active",
        task.id,
        "context",
        "orchestrator-test-status.md"
      );
      await vi.waitFor(async () => {
        await expect(fs.readFile(statusPath, "utf-8")).resolves.toContain(
          "Validation command: `node ./node_modules/vitest/vitest.mjs related --run --testTimeout=30000 src/foo.ts`"
        );
      });
    });

    it("reattaches recovered coding agents with a process-group handle", async () => {
      const task = {
        ...makeTask("task-coding-recover"),
        status: "in_progress",
        assignee: "Frodo",
      };
      const host = orchestrator.getRecoveryHost();

      vi.mocked(heartbeatService.readHeartbeat).mockResolvedValue({
        processGroupLeaderPid: 4242,
        lastOutputTimestamp: Date.now(),
        heartbeatTimestamp: Date.now(),
      });

      const resumed = await host.reattachSlot?.(projectId, repoPath, task as never, {
        taskId: task.id,
        projectId,
        phase: "coding",
        branchName: `opensprint/${task.id}`,
        worktreePath: repoPath,
        promptPath: path.join(repoPath, ".opensprint", "active", task.id, "prompt.md"),
        agentConfig: { type: "cursor", model: "gpt-5", cliCommand: null },
        attempt: 2,
        createdAt: "2026-03-02T10:00:00.000Z",
      });

      expect(resumed).toBe(true);
      expect(mockCreateProcessGroupHandle).toHaveBeenCalledWith(4242);
    });

    it("reattaches recovered review agents with a process-group handle", async () => {
      const task = {
        ...makeTask("task-review-live"),
        status: "in_progress",
        assignee: "Boromir",
      };
      const host = orchestrator.getRecoveryHost();

      mockGetSettings.mockResolvedValue({
        ...defaultSettings,
        reviewMode: "always",
        simpleComplexityAgent: { type: "cursor", model: "gpt-5", cliCommand: null },
        complexComplexityAgent: { type: "cursor", model: "gpt-5", cliCommand: null },
      });
      mockGetChangedFiles.mockResolvedValue(["src/foo.ts"]);
      mockRunScopedTests.mockResolvedValue({
        passed: 3,
        failed: 0,
        rawOutput: "ok",
        executedCommand:
          "node ./node_modules/vitest/vitest.mjs related --run --testTimeout=30000 src/foo.ts",
        scope: "scoped",
      });
      vi.mocked(heartbeatService.readHeartbeat).mockResolvedValue({
        processGroupLeaderPid: 4343,
        lastOutputTimestamp: Date.now(),
        heartbeatTimestamp: Date.now(),
      });

      const resumed = await host.resumeReviewPhase?.(
        projectId,
        repoPath,
        task as never,
        {
          taskId: task.id,
          projectId,
          phase: "review",
          branchName: `opensprint/${task.id}`,
          worktreePath: repoPath,
          promptPath: path.join(repoPath, ".opensprint", "active", task.id, "prompt.md"),
          agentConfig: { type: "cursor", model: "gpt-5", cliCommand: null },
          attempt: 2,
          createdAt: "2026-03-02T10:00:00.000Z",
        },
        { pidAlive: true }
      );

      expect(resumed).toBe(true);
      expect(mockCreateProcessGroupHandle).toHaveBeenCalledWith(4343);
      expect(mockInvokeReviewAgent).not.toHaveBeenCalled();
    });

    it("completes recovered coding assignments from terminal result.json without respawning the coder", async () => {
      const task = {
        ...makeTask("task-coding-complete"),
        status: "in_progress",
        assignee: "Frodo",
      };
      const host = orchestrator.getRecoveryHost();
      const activeDir = path.join(repoPath, ".opensprint", "active", task.id);

      await fs.mkdir(activeDir, { recursive: true });
      await fs.writeFile(path.join(activeDir, "agent-output.log"), "Recovered coding output\n");
      mockReadResult.mockResolvedValue({
        status: "success",
        summary: "Recovered cleanly",
        filesChanged: [],
        testsWritten: 0,
        testsPassed: 0,
        notes: "",
      });

      const completed = await host.handleCompletedAssignment?.(projectId, repoPath, task as never, {
        taskId: task.id,
        projectId,
        phase: "coding",
        branchName: `opensprint/${task.id}`,
        worktreePath: repoPath,
        promptPath: path.join(activeDir, "prompt.md"),
        agentConfig: { type: "cursor", model: "gpt-5", cliCommand: null },
        attempt: 2,
        createdAt: "2026-03-02T10:00:00.000Z",
      });

      expect(completed).toBe(true);
      expect(mockInvokeCodingAgent).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(mockGitQueueEnqueueAndWait).toHaveBeenCalledWith(
          expect.objectContaining({
            taskId: task.id,
            branchName: `opensprint/${task.id}`,
          })
        );
      });
      expect(mockTaskStoreClose).toHaveBeenCalledWith(projectId, task.id, expect.any(String));
    });

    it("completes recovered angle-specific review assignments from terminal result.json without respawning the reviewer", async () => {
      const task = {
        ...makeTask("task-review-complete"),
        status: "in_progress",
        assignee: "Boromir",
      };
      const host = orchestrator.getRecoveryHost();
      const angleDir = path.join(
        repoPath,
        ".opensprint",
        "active",
        task.id,
        "review-angles",
        "security"
      );

      mockGetSettings.mockResolvedValue({
        ...defaultSettings,
        reviewMode: "always",
        reviewAngles: ["security"],
        includeGeneralReview: false,
        simpleComplexityAgent: { type: "cursor", model: "gpt-5", cliCommand: null },
        complexComplexityAgent: { type: "cursor", model: "gpt-5", cliCommand: null },
      });
      mockGetChangedFiles.mockResolvedValue(["src/foo.ts"]);
      await fs.mkdir(angleDir, { recursive: true });
      await fs.writeFile(
        path.join(angleDir, "result.json"),
        JSON.stringify({ status: "approved", summary: "Looks good", notes: "" }),
        "utf-8"
      );
      await fs.writeFile(path.join(angleDir, "agent-output.log"), "Recovered review output\n");

      const completed = await host.handleCompletedAssignment?.(projectId, repoPath, task as never, {
        taskId: task.id,
        projectId,
        phase: "review",
        branchName: `opensprint/${task.id}`,
        worktreePath: repoPath,
        promptPath: path.join(angleDir, "prompt.md"),
        agentConfig: { type: "cursor", model: "gpt-5", cliCommand: null },
        attempt: 2,
        createdAt: "2026-03-02T10:00:00.000Z",
      });

      expect(completed).toBe(true);
      expect(mockInvokeReviewAgent).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(mockGitQueueEnqueueAndWait).toHaveBeenCalledWith(
          expect.objectContaining({
            taskId: task.id,
            branchName: `opensprint/${task.id}`,
          })
        );
      });
      expect(mockTaskStoreClose).toHaveBeenCalledWith(projectId, task.id, expect.any(String));
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

      // Should write assignment.json with branchName and worktreeKey (per_task => worktreeKey = task.id)
      expect(mockWriteJsonAtomic).toHaveBeenCalledWith(
        expect.stringContaining("assignment.json"),
        expect.objectContaining({
          taskId: "task-1",
          phase: "coding",
          branchName: "opensprint/task-1",
          worktreeKey: "task-1",
        })
      );
    });

    it("blocks task assignment when open PRD/SPEC HIL approval exists", async () => {
      mockHasOpenPrdSpecHilApproval.mockResolvedValueOnce(true);
      const { task } = setupSingleTaskFlow();
      mockTaskStoreReady.mockResolvedValueOnce([task]);

      await orchestrator.ensureRunning(projectId);

      await vi.waitFor(() => {
        expect(mockBroadcastToProject).toHaveBeenCalledWith(
          projectId,
          expect.objectContaining({ type: "execute.status" })
        );
      });

      expect(mockHasOpenPrdSpecHilApproval).toHaveBeenCalledWith(projectId);
      expect(mockInvokeCodingAgent).not.toHaveBeenCalled();
      expect(mockWriteJsonAtomic).not.toHaveBeenCalledWith(
        expect.stringContaining("assignment.json"),
        expect.anything()
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

      expect(mockCreateOrCheckoutBranch).toHaveBeenCalledWith(
        repoPath,
        "opensprint/task-branches",
        "main"
      );
      expect(mockCreateTaskWorktree).not.toHaveBeenCalled();
      expect(mockSymlinkNodeModules).not.toHaveBeenCalled();
      expect(mockEnsureRepoNodeModules).toHaveBeenCalledWith(repoPath);
    });

    it("fails before merge when branch quality gates fail in reviewMode=never", async () => {
      const { task, wtPath } = setupSingleTaskFlow("task-quality-gate");
      mockTaskStoreReady.mockResolvedValueOnce([task]);
      mockReadResult.mockResolvedValue({
        status: "success",
        summary: "Implemented feature",
        filesChanged: [],
        testsWritten: 0,
        testsPassed: 0,
        notes: "",
      });
      mockGetChangedFiles.mockResolvedValue(["src/foo.ts"]);
      mockRunScopedTests.mockResolvedValue({
        passed: 3,
        failed: 0,
        skipped: 0,
        total: 3,
        details: [],
        rawOutput: "ok",
        executedCommand:
          "node ./node_modules/vitest/vitest.mjs related --run --testTimeout=30000 src/foo.ts",
        scope: "scoped",
      });
      const runMergeQualityGatesSpy = vi
        .spyOn(orchestrator, "runMergeQualityGates")
        .mockResolvedValue({
          command: "npm run lint",
          reason: "Command failed: npm run lint",
          output: "src/foo.ts: error TS2304: Cannot find name 'x'",
          outputSnippet: "src/foo.ts: error TS2304: Cannot find name 'x'",
          worktreePath: wtPath,
          firstErrorLine: "src/foo.ts: error TS2304: Cannot find name 'x'",
          category: "quality_gate",
        });

      await orchestrator.ensureRunning(projectId);
      await vi.waitFor(() => {
        expect(mockWriteJsonAtomic).toHaveBeenCalled();
      });

      const mergeSpy = vi
        .spyOn(
          (
            orchestrator as unknown as {
              mergeCoordinator: { performMergeAndDone: (...args: unknown[]) => Promise<void> };
            }
          ).mergeCoordinator,
          "performMergeAndDone"
        )
        .mockResolvedValue(undefined);
      const failureSpy = vi
        .spyOn(
          (
            orchestrator as unknown as {
              failureHandler: {
                handleTaskFailure: (...args: unknown[]) => Promise<void>;
              };
            }
          ).failureHandler,
          "handleTaskFailure"
        )
        .mockResolvedValue(undefined);

      const invokeHandleCodingDone = orchestrator as unknown as {
        handleCodingDone(
          projectId: string,
          repoPath: string,
          task: typeof task,
          branchName: string,
          exitCode: number | null
        ): Promise<void>;
        getState(id: string): { slots: Map<string, unknown> };
      };

      await invokeHandleCodingDone.handleCodingDone(
        projectId,
        repoPath,
        task,
        `opensprint/${task.id}`,
        0
      );

      expect(mergeSpy).not.toHaveBeenCalled();
      expect(failureSpy).toHaveBeenCalledWith(
        projectId,
        repoPath,
        task,
        `opensprint/${task.id}`,
        expect.stringContaining("Quality gate failed (npm run lint)"),
        null,
        "merge_quality_gate"
      );

      const slot = invokeHandleCodingDone.getState(projectId).slots.get(task.id) as {
        phaseResult: {
          qualityGateDetail?: {
            command?: string | null;
            firstErrorLine?: string | null;
          } | null;
        };
      };
      expect(slot.phaseResult.qualityGateDetail).toEqual(
        expect.objectContaining({
          command: "npm run lint",
          firstErrorLine: "src/foo.ts: error TS2304: Cannot find name 'x'",
        })
      );
      expect(runMergeQualityGatesSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: task.id,
          worktreePath: wtPath,
          branchName: `opensprint/${task.id}`,
        })
      );
    });

    it("caps dispatch to one new coder per loop even when multiple slots are available", async () => {
      const task1 = makeTask("task-1");
      const task2 = makeTask("task-2");

      mockGetSettings.mockResolvedValue({
        ...defaultSettings,
        gitWorkingMode: "worktree",
        maxConcurrentCoders: 3,
      });
      mockTaskStoreReady.mockResolvedValue([task1, task2]);
      mockCreateTaskWorktree.mockImplementation(async (_repo: string, taskId: string) => {
        return `/tmp/opensprint-worktrees/${taskId}`;
      });
      mockGetActiveDir.mockImplementation((base: string, tid: string) =>
        path.join(base, ".opensprint", "active", tid)
      );
      mockWriteJsonAtomic.mockResolvedValue(undefined);
      mockInvokeCodingAgent.mockImplementation(
        (_prompt: string, _config: unknown, _opts: { onExit: (code: number | null) => void }) => {
          return { kill: vi.fn(), pid: 12345 };
        }
      );

      await orchestrator.ensureRunning(projectId);

      await vi.waitFor(() => {
        expect(mockCreateTaskWorktree).toHaveBeenCalledTimes(1);
      });

      expect(mockCreateTaskWorktree).toHaveBeenCalledTimes(1);
      expect(mockCreateTaskWorktree).toHaveBeenCalledWith(repoPath, "task-1", "main", {
        worktreeKey: "task-1",
        branchName: "opensprint/task-1",
      });
    });

    it("uses epic branch and worktreeKey when mergeStrategy is per_epic and task has epic parent", async () => {
      const epicId = "os-abc";
      const childTaskId = "os-abc.1";
      const epic = {
        ...makeTask(epicId),
        id: epicId,
        title: "Epic",
        issue_type: "epic",
        type: "epic",
      };
      const childTask = makeTask(childTaskId);
      (childTask as { issue_type: string }).issue_type = "task";

      mockGetSettings.mockResolvedValue({
        ...defaultSettings,
        mergeStrategy: "per_epic",
      });
      mockTaskStoreReady.mockResolvedValueOnce([childTask]);
      // listAll is called inside pickTask for resolveEpicId; must include epic so branch is epic_os-abc
      mockTaskStoreListAll.mockResolvedValueOnce([epic, childTask]);
      mockCreateTaskWorktree.mockResolvedValue(`/tmp/opensprint-worktrees/epic_${epicId}`);
      mockGetActiveDir.mockImplementation((base: string, tid: string) =>
        path.join(base, ".opensprint", "active", tid)
      );
      mockWriteJsonAtomic.mockResolvedValue(undefined);
      mockInvokeCodingAgent.mockImplementation(
        (_prompt: string, _config: unknown, _opts: { onExit: (code: number | null) => void }) => ({
          kill: vi.fn(),
          pid: 12345,
        })
      );

      await orchestrator.ensureRunning(projectId);

      // Slot contains opensprint/epic_<epicId>: phase executor calls createTaskWorktree with worktreeKey and branchName
      await vi.waitFor(
        () => {
          expect(mockCreateTaskWorktree).toHaveBeenCalledWith(repoPath, childTaskId, "main", {
            worktreeKey: "epic_os-abc",
            branchName: "opensprint/epic_os-abc",
          });
        },
        { timeout: 8000 }
      );

      // assignment.json written by phase executor contains epic branch and worktreeKey
      const assignmentCall = vi
        .mocked(mockWriteJsonAtomic)
        .mock.calls.find((c) => String(c[0]).endsWith("assignment.json"));
      expect(assignmentCall).toBeDefined();
      expect(assignmentCall![1]).toMatchObject({
        taskId: childTaskId,
        phase: "coding",
        branchName: "opensprint/epic_os-abc",
        worktreeKey: "epic_os-abc",
      });
    });

    it("uses per-task branch when mergeStrategy is per_epic but task has no epic parent (top-level)", async () => {
      const topLevelTask = makeTask("os-standalone");
      mockGetSettings.mockResolvedValue({
        ...defaultSettings,
        mergeStrategy: "per_epic",
      });
      mockTaskStoreReady.mockResolvedValueOnce([topLevelTask]);
      // listAll: only this task (no parent epic), so resolveEpicId returns null
      mockTaskStoreListAll.mockResolvedValueOnce([topLevelTask]);
      mockCreateTaskWorktree.mockResolvedValue(`/tmp/opensprint-worktrees/${topLevelTask.id}`);
      mockGetActiveDir.mockImplementation((base: string, tid: string) =>
        path.join(base, ".opensprint", "active", tid)
      );
      mockWriteJsonAtomic.mockResolvedValue(undefined);
      mockInvokeCodingAgent.mockImplementation(
        (_prompt: string, _config: unknown, _opts: { onExit: (code: number | null) => void }) => ({
          kill: vi.fn(),
          pid: 12345,
        })
      );

      await orchestrator.ensureRunning(projectId);

      await vi.waitFor(() => {
        expect(mockCreateTaskWorktree).toHaveBeenCalled();
      });
      expect(mockCreateTaskWorktree).toHaveBeenCalledWith(repoPath, "os-standalone", "main", {
        worktreeKey: "os-standalone",
        branchName: "opensprint/os-standalone",
      });
      const assignmentCall = vi
        .mocked(mockWriteJsonAtomic)
        .mock.calls.find((c) => String(c[0]).endsWith("assignment.json"));
      expect(assignmentCall![1]).toMatchObject({
        taskId: "os-standalone",
        branchName: "opensprint/os-standalone",
        worktreeKey: "os-standalone",
      });
    });
  });

  describe("human-assigned filter", () => {
    it("excludes ready tasks with human assignee from agent dispatch", async () => {
      const task = makeTask("task-1");
      (task as { assignee: string | null }).assignee = "alice";
      mockTaskStoreReady.mockResolvedValue([task]);
      mockCreateTaskWorktree.mockResolvedValue(`/tmp/opensprint-worktrees/task-1`);
      mockGetActiveDir.mockReturnValue(`${repoPath}/.opensprint/active/task-1`);
      mockWriteJsonAtomic.mockResolvedValue(undefined);
      mockInvokeCodingAgent.mockImplementation(
        (_prompt: string, _config: unknown, _opts: { onExit: (code: number | null) => void }) => ({
          kill: vi.fn(),
          pid: 12345,
        })
      );

      await orchestrator.ensureRunning(projectId);

      await vi.waitFor(() => {
        expect(mockBroadcastToProject).toHaveBeenCalled();
      });

      // Human-assigned task must not be dispatched: no worktree created, no active task
      expect(mockCreateTaskWorktree).not.toHaveBeenCalled();
      expect(mockBroadcastToProject).toHaveBeenCalledWith(
        projectId,
        expect.objectContaining({
          type: "execute.status",
          activeTasks: [],
        })
      );
    });

    it("includes ready tasks with agent assignee or unassigned in agent dispatch", async () => {
      const taskWithAgent = makeTask("task-agent");
      (taskWithAgent as { assignee: string | null }).assignee = "Frodo";
      const taskUnassigned = makeTask("task-unassigned");
      mockTaskStoreReady.mockResolvedValue([taskWithAgent, taskUnassigned]);
      mockCreateTaskWorktree.mockImplementation(
        async (_repo: string, taskId: string) => `/tmp/opensprint-worktrees/${taskId}`
      );
      mockGetActiveDir.mockImplementation((base: string, tid: string) =>
        path.join(base, ".opensprint", "active", tid)
      );
      mockWriteJsonAtomic.mockResolvedValue(undefined);
      mockInvokeCodingAgent.mockImplementation(
        (_prompt: string, _config: unknown, _opts: { onExit: (code: number | null) => void }) => ({
          kill: vi.fn(),
          pid: 12345,
        })
      );

      await orchestrator.ensureRunning(projectId);

      await vi.waitFor(() => {
        expect(mockCreateTaskWorktree).toHaveBeenCalled();
      });

      // Agent-assigned or unassigned tasks are dispatched
      expect(mockCreateTaskWorktree).toHaveBeenCalled();
      expect(mockBroadcastToProject).toHaveBeenCalledWith(
        projectId,
        expect.objectContaining({
          type: "execute.status",
          activeTasks: expect.arrayContaining([
            expect.objectContaining({ taskId: expect.any(String), phase: "coding" }),
          ]),
        })
      );
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

    it("includes selfImprovementRunInProgress from self-improvement runner", async () => {
      mockTaskStoreReady.mockResolvedValue([]);
      await orchestrator.ensureRunning(projectId);
      mockIsSelfImprovementRunInProgress.mockReturnValue(false);
      const statusInactive = await orchestrator.getStatus(projectId);
      expect(statusInactive.selfImprovementRunInProgress).toBe(false);

      mockIsSelfImprovementRunInProgress.mockReturnValue(true);
      const statusActive = await orchestrator.getStatus(projectId);
      expect(statusActive.selfImprovementRunInProgress).toBe(true);
    });
  });

  describe("resolveTestAndReview", () => {
    it("prefers quality-gate failure over approved review outcome", async () => {
      const { task } = setupSingleTaskFlow("task-review-quality-gate");
      mockTaskStoreReady.mockResolvedValueOnce([task]);

      await orchestrator.ensureRunning(projectId);
      await vi.waitFor(() => {
        expect(mockWriteJsonAtomic).toHaveBeenCalled();
      });

      const mergeSpy = vi
        .spyOn(
          (
            orchestrator as unknown as {
              mergeCoordinator: { performMergeAndDone: (...args: unknown[]) => Promise<void> };
            }
          ).mergeCoordinator,
          "performMergeAndDone"
        )
        .mockResolvedValue(undefined);
      const failureSpy = vi
        .spyOn(
          (
            orchestrator as unknown as {
              failureHandler: {
                handleTaskFailure: (...args: unknown[]) => Promise<void>;
              };
            }
          ).failureHandler,
          "handleTaskFailure"
        )
        .mockResolvedValue(undefined);

      const invokeResolve = orchestrator as unknown as {
        getState(id: string): { slots: Map<string, unknown> };
        resolveTestAndReview(
          projectId: string,
          repoPath: string,
          task: typeof task,
          branchName: string,
          testOutcome: {
            status: "failed";
            failureType: "merge_quality_gate";
            qualityGateDetail: {
              command: string;
              reason: string;
              outputSnippet: string;
              worktreePath: string;
              firstErrorLine: string;
            };
          },
          reviewOutcome: {
            status: "approved";
            result: { status: "approved"; summary: string; notes: string };
            exitCode: number;
          }
        ): Promise<void>;
      };

      await invokeResolve.resolveTestAndReview(
        projectId,
        repoPath,
        task,
        `opensprint/${task.id}`,
        {
          status: "failed",
          failureType: "merge_quality_gate",
          qualityGateDetail: {
            command: "npm run lint",
            reason: "Command failed: npm run lint",
            outputSnippet: "src/foo.ts: error TS2304: Cannot find name 'x'",
            worktreePath: `/tmp/opensprint-worktrees/${task.id}`,
            firstErrorLine: "src/foo.ts: error TS2304: Cannot find name 'x'",
          },
        },
        {
          status: "approved",
          result: { status: "approved", summary: "Looks good", notes: "" },
          exitCode: 0,
        }
      );

      expect(mergeSpy).not.toHaveBeenCalled();
      expect(failureSpy).toHaveBeenCalledWith(
        projectId,
        repoPath,
        task,
        `opensprint/${task.id}`,
        expect.stringContaining("Quality gate failed (npm run lint)"),
        null,
        "merge_quality_gate"
      );

      const slot = invokeResolve.getState(projectId).slots.get(task.id) as {
        phaseResult: {
          qualityGateDetail?: {
            command?: string | null;
            firstErrorLine?: string | null;
          } | null;
        };
      };
      expect(slot.phaseResult.qualityGateDetail).toEqual(
        expect.objectContaining({
          command: "npm run lint",
          firstErrorLine: "src/foo.ts: error TS2304: Cannot find name 'x'",
        })
      );
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

    it("invalidates any in-flight loop before removing project state", () => {
      const state = (
        orchestrator as unknown as {
          getState: (id: string) => { loopRunId: number };
        }
      ).getState(projectId);
      state.loopRunId = 7;

      orchestrator.stopProject(projectId);

      expect(state.loopRunId).toBe(8);
      expect(
        (orchestrator as unknown as { state: Map<string, unknown> }).state.has(projectId)
      ).toBe(false);
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
      // So far listAll returns [] (beforeEach). First getStatus would skip reconciliation when list is empty.
      // Override so listAll includes the task until we simulate archiving.
      mockTaskStoreListAll.mockResolvedValue([task]);

      await orchestrator.ensureRunning(projectId);
      await vi.waitFor(() => {
        expect(mockWriteJsonAtomic).toHaveBeenCalled();
      });

      const statusBefore = await orchestrator.getStatus(projectId);
      expect(statusBefore.activeTasks).toHaveLength(1);
      expect(statusBefore.activeTasks[0].taskId).toBe("task-stale");

      // Simulate task archived: listAll returns other tasks but not this one (non-empty list)
      mockTaskStoreListAll.mockResolvedValue([{ ...task, id: "other-task" }]);

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

    it("reconciles stale slots: does not remove slots when listAll returns empty (avoids killing agents on empty list)", async () => {
      const { task } = setupSingleTaskFlow("task-no-empty-wipe");
      mockTaskStoreReady.mockResolvedValueOnce([task]);
      mockTaskStoreListAll.mockResolvedValue([task]);

      await orchestrator.ensureRunning(projectId);
      await vi.waitFor(() => {
        expect(mockWriteJsonAtomic).toHaveBeenCalled();
      });

      const statusBefore = await orchestrator.getStatus(projectId);
      expect(statusBefore.activeTasks).toHaveLength(1);

      // listAll returns [] (e.g. wrong DB or transient). We must not treat all slots as stale.
      mockTaskStoreListAll.mockResolvedValue([]);

      const agents = await orchestrator.getActiveAgents(projectId);
      expect(agents).toHaveLength(1);
      expect(agents[0].id).toBe("task-no-empty-wipe");
    });

    it("returns one reviewer entry per active review angle", async () => {
      const { task } = setupSingleTaskFlow("task-review-angles");
      mockTaskStoreReady.mockResolvedValueOnce([task]);
      mockTaskStoreListAll.mockResolvedValue([task]);

      await orchestrator.ensureRunning(projectId);
      await vi.waitFor(() => {
        expect(mockWriteJsonAtomic).toHaveBeenCalled();
      });

      const state = (
        orchestrator as unknown as { getState: (id: string) => { slots: Map<string, unknown> } }
      ).getState(projectId);
      const slot = state.slots.get(task.id) as {
        phase: "coding" | "review";
        reviewAgents?: Map<
          string,
          {
            angle: string;
            agent: { startedAt: string; activeProcess: null };
            timers: { clearAll: () => void };
          }
        >;
      };
      expect(slot).toBeTruthy();
      slot.phase = "review";
      slot.reviewAgents = new Map([
        [
          "security",
          {
            angle: "security",
            agent: { startedAt: "2026-02-20T10:00:00.000Z", activeProcess: null },
            timers: { clearAll: vi.fn() },
          },
        ],
        [
          "performance",
          {
            angle: "performance",
            agent: { startedAt: "2026-02-20T10:00:05.000Z", activeProcess: null },
            timers: { clearAll: vi.fn() },
          },
        ],
      ]);

      const agents = await orchestrator.getActiveAgents(projectId);
      const reviewerAgents = agents.filter((a) => a.role === "reviewer");
      expect(reviewerAgents).toHaveLength(2);
      expect(reviewerAgents.map((a) => a.id)).toEqual(
        expect.arrayContaining([`${task.id}--review--security`, `${task.id}--review--performance`])
      );
      // name is instance suffix; getRoleDisplayLabel produces "Reviewer (Security)" from name "Security"
      expect(reviewerAgents.map((a) => a.name)).toEqual(
        expect.arrayContaining(["Security", "Performance"])
      );
      expect(reviewerAgents.every((a) => a.taskId === task.id)).toBe(true);
    });

    it("general reviewer has name General so UI shows Reviewer (General) without duplication", async () => {
      const { task } = setupSingleTaskFlow("task-general-review");
      mockTaskStoreReady.mockResolvedValueOnce([task]);
      mockTaskStoreListAll.mockResolvedValue([task]);

      await orchestrator.ensureRunning(projectId);
      await vi.waitFor(() => {
        expect(mockWriteJsonAtomic).toHaveBeenCalled();
      });

      const state = (
        orchestrator as unknown as { getState: (id: string) => { slots: Map<string, unknown> } }
      ).getState(projectId);
      const slot = state.slots.get(task.id) as {
        phase: "coding" | "review";
        includeGeneralReview?: boolean;
        agent: { startedAt: string; lifecycleState: string; activeProcess: null };
        reviewAgents?: Map<
          string,
          {
            angle: string;
            agent: { startedAt: string; activeProcess: null };
            timers: { clearAll: () => void };
          }
        >;
      };
      expect(slot).toBeTruthy();
      slot.phase = "review";
      slot.includeGeneralReview = true;
      slot.reviewAgents = new Map([
        [
          "security",
          {
            angle: "security",
            agent: { startedAt: "2026-02-20T10:00:00.000Z", activeProcess: null },
            timers: { clearAll: vi.fn() },
          },
        ],
      ]);

      const agents = await orchestrator.getActiveAgents(projectId);
      const generalEntry = agents.find((a) => a.id === `${task.id}--review--general`);
      expect(generalEntry).toBeTruthy();
      expect(generalEntry!.name).toBe("General");
    });

    it("single general reviewer (no angles) has name General so UI shows Reviewer (General) without duplication", async () => {
      const { task } = setupSingleTaskFlow("task-single-general");
      mockTaskStoreReady.mockResolvedValueOnce([task]);
      mockTaskStoreListAll.mockResolvedValue([task]);

      await orchestrator.ensureRunning(projectId);
      await vi.waitFor(() => {
        expect(mockWriteJsonAtomic).toHaveBeenCalled();
      });

      const state = (
        orchestrator as unknown as { getState: (id: string) => { slots: Map<string, unknown> } }
      ).getState(projectId);
      const slot = state.slots.get(task.id) as {
        phase: "coding" | "review";
        assignee?: string;
        agent: { startedAt: string; lifecycleState: string; activeProcess: null };
        reviewAgents?: Map<string, unknown>;
      };
      expect(slot).toBeTruthy();
      slot.phase = "review";
      slot.assignee = "";
      slot.reviewAgents = undefined;

      const agents = await orchestrator.getActiveAgents(projectId);
      const reviewerAgents = agents.filter((a) => a.role === "reviewer");
      expect(reviewerAgents).toHaveLength(1);
      expect(reviewerAgents[0].id).toBe(task.id);
      expect(reviewerAgents[0].name).toBe("General");
    });

    it("getStatus.activeTasks emits one entry per active review agent when multi-angle", async () => {
      const { task } = setupSingleTaskFlow("task-build-active");
      mockTaskStoreReady.mockResolvedValueOnce([task]);
      mockTaskStoreListAll.mockResolvedValue([task]);

      await orchestrator.ensureRunning(projectId);
      await vi.waitFor(() => {
        expect(mockWriteJsonAtomic).toHaveBeenCalled();
      });

      const state = (
        orchestrator as unknown as { getState: (id: string) => { slots: Map<string, unknown> } }
      ).getState(projectId);
      const slot = state.slots.get(task.id) as {
        phase: "coding" | "review";
        reviewAgents?: Map<
          string,
          {
            angle: string;
            agent: { startedAt: string; lifecycleState: string; activeProcess: null };
            timers: { clearAll: () => void };
          }
        >;
      };
      expect(slot).toBeTruthy();
      slot.phase = "review";
      slot.reviewAgents = new Map([
        [
          "security",
          {
            angle: "security",
            agent: {
              startedAt: "2026-02-20T10:00:00.000Z",
              lifecycleState: "running",
              activeProcess: null,
            },
            timers: { clearAll: vi.fn() },
          },
        ],
        [
          "performance",
          {
            angle: "performance",
            agent: {
              startedAt: "2026-02-20T10:00:05.000Z",
              lifecycleState: "running",
              activeProcess: null,
            },
            timers: { clearAll: vi.fn() },
          },
        ],
      ]);

      const status = await orchestrator.getStatus(projectId);
      const reviewTasks = status.activeTasks.filter((t) => t.phase === "review");
      expect(reviewTasks).toHaveLength(2);
      expect(reviewTasks.map((t) => t.id)).toEqual(
        expect.arrayContaining([`${task.id}--review--security`, `${task.id}--review--performance`])
      );
      expect(reviewTasks.map((t) => t.name)).toEqual(
        expect.arrayContaining(["Reviewer (Security)", "Reviewer (Performance)"])
      );
    });
  });

  describe("refreshMaxSlotsAndNudge", () => {
    it("refreshes maxSlots from settings and calls nudge so new agents spawn when maxConcurrentCoders increases", async () => {
      mockGetSettings.mockResolvedValue({
        ...defaultSettings,
        maxConcurrentCoders: 4,
        gitWorkingMode: "worktree",
      });
      mockTaskStoreReady.mockResolvedValue([]);
      const nudgeSpy = vi.spyOn(orchestrator, "nudge").mockImplementation(() => {});

      await orchestrator.refreshMaxSlotsAndNudge(projectId);

      expect(mockGetSettings).toHaveBeenCalledWith(projectId);
      expect(nudgeSpy).toHaveBeenCalledWith(projectId);
      nudgeSpy.mockRestore();
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
