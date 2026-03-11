/**
 * Integration tests: after-each-plan self-improvement trigger only on plan completion.
 *
 * Verifies:
 * (1) When selfImprovementFrequency is 'after_each_plan' and the user clicks Execute (plan
 *     execution starts), self-improvement is NOT triggered.
 * (2) When all tasks for the plan are closed and merged and the epic is closed, and change
 *     detection returns true, the self-improvement run is triggered and tasks are created
 *     with source 'self-improvement'.
 * (3) When change detection returns false after plan completion, Reviewer is not invoked
 *     and lastRunAt is not updated.
 *
 * Uses mocks for Reviewer (agent), git (change detection), and task/store where needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MergeCoordinatorService,
  type MergeCoordinatorHost,
} from "../services/merge-coordinator.service.js";
import type { StoredTask } from "../services/task-store.service.js";
import { selfImprovementService } from "../services/self-improvement.service.js";

function resolveEpicId(
  taskId: string | undefined | null,
  idToIssue?: Map<string, StoredTask> | StoredTask[]
): string | null {
  if (taskId == null || typeof taskId !== "string") return null;
  const map =
    idToIssue instanceof Map
      ? idToIssue
      : Array.isArray(idToIssue)
        ? new Map(idToIssue.map((t) => [t.id, t]))
        : undefined;
  if (!map) return null;
  let current: string | null = taskId;
  while (current) {
    const lastDot = current.lastIndexOf(".");
    if (lastDot <= 0) return null;
    const parentId = current.slice(0, lastDot);
    const parent = map.get(parentId);
    if (parent && (parent.issue_type ?? (parent as { type?: string }).type) === "epic") {
      return parentId;
    }
    current = parentId;
  }
  return null;
}

const mockTaskStoreCreate = vi.fn();
const mockHasCodeChangesSince = vi.fn();
const mockInvokePlanningAgent = vi.fn();
const mockUpdateSettingsInStore = vi.fn();
const mockGetSettingsFromStore = vi.fn();
const mockGetSettings = vi.fn();
const mockGetProject = vi.fn();

vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    create: (...args: unknown[]) => mockTaskStoreCreate(...args),
    listAll: vi.fn(),
    show: vi.fn(),
    update: vi.fn(),
    close: vi.fn(),
    comment: vi.fn(),
    sync: vi.fn(),
    syncForPush: vi.fn(),
    setCumulativeAttempts: vi.fn(),
    getCumulativeAttemptsFromIssue: vi.fn().mockReturnValue(0),
    setConflictFiles: vi.fn(),
    setMergeStage: vi.fn(),
    planGetByEpicId: vi.fn(),
  },
  resolveEpicId,
}));

vi.mock("../services/self-improvement-change-detection.js", () => ({
  hasCodeChangesSince: (...args: unknown[]) => mockHasCodeChangesSince(...args),
}));

vi.mock("../services/agent.service.js", () => ({
  agentService: {
    invokePlanningAgent: (...args: unknown[]) => mockInvokePlanningAgent(...args),
  },
}));

vi.mock("../services/project.service.js", () => ({
  ProjectService: vi.fn().mockImplementation(() => ({
    getSettings: (...args: unknown[]) => mockGetSettings(...args),
    getProject: (...args: unknown[]) => mockGetProject(...args),
  })),
}));

vi.mock("../services/plan.service.js", () => ({
  PlanService: vi.fn().mockImplementation(() => ({
    getCodebaseContext: vi.fn().mockResolvedValue({
      fileTree: "src/\n  index.ts\n",
      keyFilesContent: "// key files",
    }),
  })),
}));

vi.mock("../services/context-assembler.js", () => ({
  ContextAssembler: vi.fn().mockImplementation(() => ({
    extractPrdExcerpt: vi.fn().mockResolvedValue("# SPEC\n\nContent"),
  })),
}));

vi.mock("../services/settings-store.service.js", () => ({
  updateSettingsInStore: (...args: unknown[]) => mockUpdateSettingsInStore(...args),
  getSettingsFromStore: (...args: unknown[]) => mockGetSettingsFromStore(...args),
}));

vi.mock("../services/agent-instructions.service.js", () => ({
  getCombinedInstructions: vi.fn().mockResolvedValue(""),
}));

vi.mock("../utils/shell-exec.js", () => ({
  shellExec: vi.fn().mockResolvedValue({ stdout: "abc123sha\n", stderr: "" }),
}));

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
    })),
  };
});

vi.mock("../services/git-commit-queue.service.js", () => ({
  MergeJobError: class MergeJobError extends Error {
    constructor(
      message: string,
      public readonly stage: string,
      public readonly conflictedFiles: string[],
      public readonly resolvedBy: "requeued" | "blocked" = "requeued"
    ) {
      super(message);
      this.name = "MergeJobError";
    }
  },
  gitCommitQueue: {
    drain: vi.fn().mockResolvedValue(undefined),
    enqueueAndWait: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../utils/git-repo-state.js", () => ({
  resolveBaseBranch: vi.fn().mockResolvedValue("main"),
  inspectGitRepoState: vi.fn().mockResolvedValue({
    isGitRepo: true,
    hasHead: true,
    currentBranch: "main",
    baseBranch: "main",
    hasOrigin: false,
    originReachable: false,
    remoteMode: "local_only",
    originUrl: null,
    identity: { name: "Test", email: "test@test.com", valid: true },
  }),
}));

vi.mock("../services/agent-identity.service.js", () => ({
  agentIdentityService: { recordAttempt: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../services/event-log.service.js", () => ({
  eventLogService: { append: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../services/notification.service.js", () => ({
  notificationService: { create: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../websocket/index.js", () => ({ broadcastToProject: vi.fn() }));

vi.mock("../services/deploy-trigger.service.js", () => ({
  triggerDeployForEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/final-review.service.js", () => ({
  finalReviewService: {
    runFinalReview: vi.fn(),
    createTasksFromReview: vi.fn(),
  },
}));

describe("after-each-plan self-improvement integration", () => {
  const projectId = "proj-1";
  const repoPath = "/tmp/repo";

  let coordinator: MergeCoordinatorService;
  let mockHost: MergeCoordinatorHost;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskStoreCreate.mockResolvedValue({ id: "os-si-1", title: "Improvement task" });
    mockGetProject.mockResolvedValue({ id: projectId, repoPath });
    mockGetSettings.mockResolvedValue({
      simpleComplexityAgent: { type: "cursor", model: null },
      complexComplexityAgent: { type: "cursor", model: null },
      deployment: {},
      gitWorkingMode: "worktree",
      worktreeBaseBranch: "main",
      selfImprovementFrequency: "after_each_plan",
      selfImprovementLastRunAt: undefined,
      selfImprovementLastCommitSha: undefined,
    });
    mockGetSettingsFromStore.mockImplementation((_id: string, defaults: unknown) =>
      Promise.resolve(defaults)
    );

    mockHost = {
      getState: vi.fn().mockReturnValue({
        slots: new Map(),
        status: { totalDone: 0, totalFailed: 0, queueDepth: 0 },
        globalTimers: {} as never,
      }),
      taskStore: {
        close: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        comment: vi.fn().mockResolvedValue(undefined),
        sync: vi.fn().mockResolvedValue(undefined),
        syncForPush: vi.fn().mockResolvedValue(undefined),
        listAll: vi.fn().mockResolvedValue([]),
        show: vi.fn().mockResolvedValue({ id: "os-1", status: "closed" } as StoredTask),
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
      sessionManager: {
        createSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
        archiveSession: vi.fn().mockResolvedValue(undefined),
      },
      fileScopeAnalyzer: { recordActual: vi.fn().mockResolvedValue(undefined) },
      feedbackService: { checkAutoResolveOnTaskDone: vi.fn().mockResolvedValue(undefined) },
      projectService: { getSettings: mockGetSettings },
      transition: vi.fn(),
      persistCounters: vi.fn().mockResolvedValue(undefined),
      nudge: vi.fn(),
    };

    coordinator = new MergeCoordinatorService(mockHost);
  });

  it("does not trigger self-improvement when plan execution has just started (not all tasks closed)", async () => {
    const runIfDueSpy = vi.spyOn(selfImprovementService, "runIfDue");

    mockHost.taskStore.listAll.mockResolvedValue([
      { id: "os-abc", title: "Epic", status: "open", issue_type: "epic" } as StoredTask,
      { id: "os-abc.1", title: "Task 1", status: "closed", issue_type: "task" } as StoredTask,
      { id: "os-abc.2", title: "Task 2", status: "open", issue_type: "task" } as StoredTask,
    ]);
    mockHost.taskStore.planGetByEpicId.mockResolvedValue({
      plan_id: "plan-1",
      content: "",
      metadata: {},
      shipped_content: null,
      updated_at: new Date().toISOString(),
    });

    await coordinator.postCompletionAsync(projectId, repoPath, "os-abc.1");

    expect(runIfDueSpy).not.toHaveBeenCalled();
    runIfDueSpy.mockRestore();
  });

  it("triggers self-improvement and creates tasks with source self-improvement when plan is complete and change detection returns true", async () => {
    mockHasCodeChangesSince.mockResolvedValue(true);
    mockInvokePlanningAgent.mockResolvedValue({
      content: '[{"title":"Add tests","description":"Unit tests for X","priority":1,"complexity":3}]',
    });

    mockHost.taskStore.listAll.mockResolvedValue([
      { id: "os-abc", title: "Epic", status: "closed", issue_type: "epic" } as StoredTask,
      { id: "os-abc.1", title: "Task 1", status: "closed", issue_type: "task" } as StoredTask,
    ]);
    mockHost.taskStore.planGetByEpicId.mockResolvedValue({
      plan_id: "plan-1",
      content: "",
      metadata: {},
      shipped_content: null,
      updated_at: new Date().toISOString(),
    });

    await coordinator.postCompletionAsync(projectId, repoPath, "os-abc.1");

    await vi.waitFor(() => {
      expect(mockHasCodeChangesSince).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(mockInvokePlanningAgent).toHaveBeenCalled();
    });
    expect(mockTaskStoreCreate).toHaveBeenCalledWith(
      projectId,
      "Add tests",
      expect.objectContaining({
        description: "Unit tests for X",
        priority: 1,
        complexity: 3,
        extra: expect.objectContaining({
          source: "self-improvement",
          aiAssignedPriority: true,
          aiAssignedComplexity: true,
        }),
      })
    );
  });

  it("does not invoke Reviewer and does not update lastRunAt when change detection returns false after plan completion", async () => {
    mockHasCodeChangesSince.mockResolvedValue(false);

    mockHost.taskStore.listAll.mockResolvedValue([
      { id: "os-abc", title: "Epic", status: "closed", issue_type: "epic" } as StoredTask,
      { id: "os-abc.1", title: "Task 1", status: "closed", issue_type: "task" } as StoredTask,
    ]);
    mockHost.taskStore.planGetByEpicId.mockResolvedValue({
      plan_id: "plan-1",
      content: "",
      metadata: {},
      shipped_content: null,
      updated_at: new Date().toISOString(),
    });

    await coordinator.postCompletionAsync(projectId, repoPath, "os-abc.1");

    await vi.waitFor(() => {
      expect(mockHasCodeChangesSince).toHaveBeenCalled();
    });
    expect(mockInvokePlanningAgent).not.toHaveBeenCalled();
    expect(mockUpdateSettingsInStore).not.toHaveBeenCalled();
  });
});
