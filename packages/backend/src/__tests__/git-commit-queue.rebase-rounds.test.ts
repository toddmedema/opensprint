import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSyncMainWithOrigin = vi.fn();
const mockEnsureOnMain = vi.fn();
const mockVerifyMerge = vi.fn();
const mockCheckout = vi.fn();
const mockRebaseOntoMain = vi.fn();
const mockRebaseContinue = vi.fn();
const mockRebaseAbort = vi.fn();
const mockMergeToMainNoCommit = vi.fn();
const mockIsMergeInProgress = vi.fn();
const mockMergeAbort = vi.fn();
const mockStripRuntimePathsFromMergeResult = vi.fn();
const mockSymlinkNodeModules = vi.fn();
const mockCreateTaskWorktree = vi.fn();
const mockRemoveTaskWorktree = vi.fn();
const mockGetConflictedFiles = vi.fn();

const mockTaskStoreInit = vi.fn();
const mockTaskStoreShow = vi.fn();

const mockGetProjectByRepoPath = vi.fn();
const mockGetSettings = vi.fn();

const mockRunMergerAgentAndWait = vi.fn();
const mockEventLogAppend = vi.fn();
const mockWaitForGitReady = vi.fn();
const mockShellExec = vi.fn();
const mockRunMergeQualityGates = vi.fn();

vi.mock("../services/branch-manager.js", () => {
  class RebaseConflictError extends Error {
    constructor(public readonly conflictedFiles: string[]) {
      super(`Rebase conflict in ${conflictedFiles.length} file(s): ${conflictedFiles.join(", ")}`);
      this.name = "RebaseConflictError";
    }
  }
  class MergeConflictError extends Error {
    constructor(public readonly conflictedFiles: string[]) {
      super(`Merge conflict in ${conflictedFiles.length} file(s): ${conflictedFiles.join(", ")}`);
      this.name = "MergeConflictError";
    }
  }
  return {
    BranchManager: vi.fn().mockImplementation(() => ({
      syncMainWithOrigin: (...args: unknown[]) => mockSyncMainWithOrigin(...args),
      ensureOnMain: (...args: unknown[]) => mockEnsureOnMain(...args),
      verifyMerge: (...args: unknown[]) => mockVerifyMerge(...args),
      checkout: (...args: unknown[]) => mockCheckout(...args),
      rebaseOntoMain: (...args: unknown[]) => mockRebaseOntoMain(...args),
      rebaseContinue: (...args: unknown[]) => mockRebaseContinue(...args),
      rebaseAbort: (...args: unknown[]) => mockRebaseAbort(...args),
      mergeToMainNoCommit: (...args: unknown[]) => mockMergeToMainNoCommit(...args),
      isMergeInProgress: (...args: unknown[]) => mockIsMergeInProgress(...args),
      mergeAbort: (...args: unknown[]) => mockMergeAbort(...args),
      stripRuntimePathsFromMergeResult: (...args: unknown[]) =>
        mockStripRuntimePathsFromMergeResult(...args),
      symlinkNodeModules: (...args: unknown[]) => mockSymlinkNodeModules(...args),
      createTaskWorktree: (...args: unknown[]) => mockCreateTaskWorktree(...args),
      removeTaskWorktree: (...args: unknown[]) => mockRemoveTaskWorktree(...args),
      getConflictedFiles: (...args: unknown[]) => mockGetConflictedFiles(...args),
    })),
    RebaseConflictError,
    MergeConflictError,
  };
});

vi.mock("../services/merge-quality-gate-runner.js", () => ({
  runMergeQualityGates: (...args: unknown[]) => mockRunMergeQualityGates(...args),
}));

vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    init: (...args: unknown[]) => mockTaskStoreInit(...args),
    show: (...args: unknown[]) => mockTaskStoreShow(...args),
  },
}));

vi.mock("../services/project.service.js", () => ({
  ProjectService: vi.fn().mockImplementation(() => ({
    getProjectByRepoPath: (...args: unknown[]) => mockGetProjectByRepoPath(...args),
    getSettings: (...args: unknown[]) => mockGetSettings(...args),
  })),
}));

vi.mock("../services/agent.service.js", () => ({
  agentService: {
    runMergerAgentAndWait: (...args: unknown[]) => mockRunMergerAgentAndWait(...args),
  },
}));

vi.mock("../services/event-log.service.js", () => ({
  eventLogService: {
    append: (...args: unknown[]) => mockEventLogAppend(...args),
  },
}));

vi.mock("../utils/git-lock.js", () => ({
  waitForGitReady: (...args: unknown[]) => mockWaitForGitReady(...args),
}));

vi.mock("../utils/shell-exec.js", () => ({
  shellExec: (...args: unknown[]) => mockShellExec(...args),
}));

describe("GitCommitQueue rebase rounds", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockWaitForGitReady.mockResolvedValue(undefined);
    mockShellExec.mockResolvedValue({ stdout: "", stderr: "" });
    mockTaskStoreInit.mockResolvedValue(undefined);
    mockTaskStoreShow.mockResolvedValue({ title: "Task Title" });
    mockGetProjectByRepoPath.mockResolvedValue({ id: "proj-1" });
    mockGetSettings.mockResolvedValue({
      simpleComplexityAgent: { type: "cursor", model: null },
      complexComplexityAgent: { type: "cursor", model: null },
      deployment: {},
      testCommand: "npm test",
    });

    mockSyncMainWithOrigin.mockResolvedValue(undefined);
    mockEnsureOnMain.mockResolvedValue(undefined);
    mockVerifyMerge.mockResolvedValue(false);
    mockCheckout.mockResolvedValue(undefined);
    mockMergeToMainNoCommit.mockResolvedValue({ autoResolvedFiles: [] });
    mockIsMergeInProgress.mockResolvedValue(false);
    mockMergeAbort.mockResolvedValue(undefined);
    mockStripRuntimePathsFromMergeResult.mockResolvedValue(undefined);
    mockSymlinkNodeModules.mockResolvedValue(undefined);
    mockCreateTaskWorktree.mockResolvedValue("/tmp/worktree-created");
    mockRemoveTaskWorktree.mockResolvedValue(undefined);
    mockGetConflictedFiles.mockResolvedValue([]);
    mockRunMergeQualityGates.mockResolvedValue(null);
    mockRebaseAbort.mockResolvedValue(undefined);
    mockEventLogAppend.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const { gitCommitQueue } = await import("../services/git-commit-queue.service.js");
    await gitCommitQueue.drain();
  });

  it("handles sequential rebase conflicts by invoking merger repeatedly", async () => {
    const { gitCommitQueue } = await import("../services/git-commit-queue.service.js");
    const { RebaseConflictError } = await import("../services/branch-manager.js");

    mockRebaseOntoMain.mockRejectedValueOnce(new RebaseConflictError(["a.ts"]));
    mockRebaseContinue
      .mockRejectedValueOnce(new RebaseConflictError(["b.ts"]))
      .mockResolvedValueOnce(undefined);
    mockRunMergerAgentAndWait.mockResolvedValue(true);

    await expect(
      gitCommitQueue.enqueueAndWait({
        type: "worktree_merge",
        repoPath: "/tmp/repo",
        worktreePath: "/tmp/worktree",
        branchName: "opensprint/os-1234",
        taskId: "os-1234",
        taskTitle: "Task title",
      })
    ).resolves.toBeUndefined();

    expect(mockRunMergerAgentAndWait).toHaveBeenCalledTimes(2);
    expect(mockRebaseContinue).toHaveBeenCalledTimes(2);
    expect(mockRebaseAbort).not.toHaveBeenCalled();
  });

  it("uses a dedicated worktree when worktree_merge is pointed at repo root", async () => {
    const { gitCommitQueue } = await import("../services/git-commit-queue.service.js");

    mockRebaseOntoMain.mockResolvedValue(undefined);

    await expect(
      gitCommitQueue.enqueueAndWait({
        type: "worktree_merge",
        repoPath: "/tmp/repo",
        worktreePath: "/tmp/repo",
        branchName: "opensprint/os-1234",
        taskId: "os-1234",
        taskTitle: "Task title",
      })
    ).resolves.toBeUndefined();

    expect(mockCreateTaskWorktree).toHaveBeenCalledWith("/tmp/repo", "os-1234", "main", {
      branchName: "opensprint/os-1234",
    });
    expect(mockRebaseOntoMain).toHaveBeenCalledWith("/tmp/worktree-created", "main");
    expect(mockRemoveTaskWorktree).toHaveBeenCalledWith(
      "/tmp/repo",
      "os-1234",
      "/tmp/worktree-created"
    );
    expect(mockCheckout).not.toHaveBeenCalled();
  });

  it("aborts and fails after max rebase rounds", async () => {
    const { gitCommitQueue } = await import("../services/git-commit-queue.service.js");
    const { RebaseConflictError } = await import("../services/branch-manager.js");

    mockRebaseOntoMain.mockRejectedValueOnce(new RebaseConflictError(["a.ts"]));
    mockRebaseContinue.mockRejectedValue(new RebaseConflictError(["loop.ts"]));
    mockRunMergerAgentAndWait.mockResolvedValue(true);

    await expect(
      gitCommitQueue.enqueueAndWait({
        type: "worktree_merge",
        repoPath: "/tmp/repo",
        worktreePath: "/tmp/worktree",
        branchName: "opensprint/os-1234",
        taskId: "os-1234",
        taskTitle: "Task title",
      })
    ).rejects.toMatchObject({
      name: "MergeJobError",
      stage: "rebase_before_merge",
      conflictedFiles: expect.arrayContaining(["loop.ts"]),
    });

    expect(mockRunMergerAgentAndWait).toHaveBeenCalledTimes(12);
    expect(mockRebaseAbort).toHaveBeenCalledTimes(1);
  });

  it("aborts the merge candidate when merged-tree quality gates fail", async () => {
    const { gitCommitQueue } = await import("../services/git-commit-queue.service.js");

    mockIsMergeInProgress.mockResolvedValue(true);
    mockRunMergeQualityGates.mockResolvedValue({
      command: "npm run test",
      reason: "Command failed: npm run test",
      output: "stderr | merged candidate failure",
      outputSnippet: "stderr | merged candidate failure",
      firstErrorLine: "stderr | merged candidate failure",
      worktreePath: "/tmp/repo",
      category: "quality_gate",
    });

    await expect(
      gitCommitQueue.enqueueAndWait({
        type: "worktree_merge",
        repoPath: "/tmp/repo",
        worktreePath: "/tmp/worktree",
        branchName: "opensprint/os-1234",
        taskId: "os-1234",
        taskTitle: "Task title",
      })
    ).rejects.toMatchObject({
      name: "MergeJobError",
      stage: "quality_gate",
      qualityGateFailure: expect.objectContaining({
        command: "npm run test",
        worktreePath: "/tmp/repo",
      }),
    });

    expect(mockStripRuntimePathsFromMergeResult).toHaveBeenCalledWith("/tmp/repo");
    expect(mockMergeAbort).toHaveBeenCalledWith("/tmp/repo");
  });
});
