import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { OrchestratorService, formatReviewFeedback } from "../services/orchestrator.service.js";
import type { ReviewAgentResult } from "@opensprint/shared";
import { OPENSPRINT_PATHS } from "@opensprint/shared";

// ─── Mocks ───
// All mock fns must be created via vi.hoisted() so they're available inside vi.mock() factories.

const {
  mockBroadcastToProject,
  mockSendAgentOutputToProject,
  mockBeadsReady,
  mockBeadsShow,
  mockBeadsUpdate,
  mockBeadsClose,
  mockBeadsComment,
  mockBeadsHasLabel,
  mockBeadsAreAllBlockersClosed,
  mockBeadsGetCumulativeAttempts,
  mockBeadsSetCumulativeAttempts,
  mockBeadsAddLabel,
  mockBeadsRemoveLabel,
  mockBeadsExport,
  mockGetProject,
  mockGetRepoPath,
  mockGetSettings,
  mockCreateTaskWorktree,
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
} = vi.hoisted(() => ({
  mockBroadcastToProject: vi.fn(),
  mockSendAgentOutputToProject: vi.fn(),
  mockBeadsReady: vi.fn(),
  mockBeadsShow: vi.fn(),
  mockBeadsUpdate: vi.fn(),
  mockBeadsClose: vi.fn(),
  mockBeadsComment: vi.fn(),
  mockBeadsHasLabel: vi.fn(),
  mockBeadsAreAllBlockersClosed: vi.fn(),
  mockBeadsGetCumulativeAttempts: vi.fn(),
  mockBeadsSetCumulativeAttempts: vi.fn(),
  mockBeadsAddLabel: vi.fn(),
  mockBeadsRemoveLabel: vi.fn(),
  mockBeadsExport: vi.fn().mockResolvedValue(undefined),
  mockGetProject: vi.fn(),
  mockGetRepoPath: vi.fn(),
  mockGetSettings: vi.fn(),
  mockCreateTaskWorktree: vi.fn(),
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
}));

vi.mock("../websocket/index.js", () => ({
  broadcastToProject: (...args: unknown[]) => mockBroadcastToProject(...args),
  sendAgentOutputToProject: (...args: unknown[]) => mockSendAgentOutputToProject(...args),
}));

vi.mock("../services/beads.service.js", () => ({
  BeadsService: vi.fn().mockImplementation(() => ({
    ready: mockBeadsReady,
    show: mockBeadsShow,
    update: mockBeadsUpdate,
    close: mockBeadsClose,
    comment: mockBeadsComment,
    hasLabel: mockBeadsHasLabel,
    areAllBlockersClosed: mockBeadsAreAllBlockersClosed,
    getCumulativeAttempts: mockBeadsGetCumulativeAttempts,
    setCumulativeAttempts: mockBeadsSetCumulativeAttempts,
    addLabel: mockBeadsAddLabel,
    removeLabel: mockBeadsRemoveLabel,
    export: mockBeadsExport,
  })),
}));

vi.mock("../services/project.service.js", () => ({
  ProjectService: vi.fn().mockImplementation(() => ({
    getProject: mockGetProject,
    getRepoPath: mockGetRepoPath,
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
      rebaseContinue: vi.fn().mockResolvedValue(undefined),
      rebaseAbort: vi.fn().mockResolvedValue(undefined),
      isRebaseInProgress: vi.fn().mockResolvedValue(false),
      commitWip: mockCommitWip,
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

vi.mock("../services/heartbeat.service.js", () => ({
  heartbeatService: {
    writeHeartbeat: vi.fn().mockResolvedValue(undefined),
    deleteHeartbeat: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../utils/file-utils.js", () => ({
  writeJsonAtomic: (...args: unknown[]) => mockWriteJsonAtomic(...args),
}));

// ─── Tests ───

describe("OrchestratorService", () => {
  let orchestrator: OrchestratorService;
  let repoPath: string;
  const projectId = "test-project-1";

  beforeEach(async () => {
    vi.clearAllMocks();
    orchestrator = new OrchestratorService();

    repoPath = path.join(os.tmpdir(), `orchestrator-test-${Date.now()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await fs.mkdir(path.join(repoPath, ".opensprint"), { recursive: true });

    mockGetProject.mockResolvedValue({ id: projectId });
    mockGetRepoPath.mockResolvedValue(repoPath);
    mockGetSettings.mockResolvedValue({
      testFramework: "vitest",
      codingAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      reviewMode: "never",
    });
    mockRecoverOrphanedTasks.mockResolvedValue({ recovered: [] });
    mockRecoverFromStaleHeartbeats.mockResolvedValue({ recovered: [] });
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
      expect(formatted).toContain("- Missing error handling");
      expect(formatted).toContain("- Tests do not cover edge cases");
    });

    it("handles missing summary gracefully", () => {
      const result = {
        status: "rejected",
      } as unknown as ReviewAgentResult;
      expect(formatReviewFeedback(result)).toBe(
        "Review rejected (no details provided by review agent)."
      );
    });
  });

  describe("getStatus", () => {
    it("returns default status when project exists", async () => {
      const status = await orchestrator.getStatus(projectId);
      expect(status).toEqual({
        currentTask: null,
        currentPhase: null,
        queueDepth: 0,
        totalDone: 0,
        totalFailed: 0,
      });
      expect(mockGetProject).toHaveBeenCalledWith(projectId);
    });
  });

  describe("getActiveAgents", () => {
    it("returns empty array when idle", async () => {
      const agents = await orchestrator.getActiveAgents(projectId);
      expect(agents).toEqual([]);
      expect(mockGetProject).toHaveBeenCalledWith(projectId);
    });
  });

  describe("stopProject", () => {
    it("does nothing when project has no state", () => {
      expect(() => orchestrator.stopProject(projectId)).not.toThrow();
    });

    it("cleans up state when project has state", async () => {
      // Get state by calling getStatus first
      await orchestrator.getStatus(projectId);
      orchestrator.stopProject(projectId);
      // After stop, getStatus would create fresh state
      const status = await orchestrator.getStatus(projectId);
      expect(status.currentTask).toBeNull();
    });
  });

  describe("nudge", () => {
    it("does not start loop when no ready tasks", async () => {
      mockBeadsReady.mockResolvedValue([]);

      await orchestrator.ensureRunning(projectId);
      orchestrator.nudge(projectId);

      // Give loop time to run
      await new Promise((r) => setTimeout(r, 100));

      // Should have broadcast execute.status with null task
      expect(mockBroadcastToProject).toHaveBeenCalledWith(
        projectId,
        expect.objectContaining({
          type: "execute.status",
          currentTask: null,
          queueDepth: 0,
        })
      );
    });

    it("does not start second loop when one is already active", async () => {
      mockBeadsReady.mockResolvedValue([
        {
          id: "task-1",
          title: "Test task",
          issue_type: "task",
          priority: 2,
          status: "open",
        },
      ]);
      mockBeadsAreAllBlockersClosed.mockResolvedValue(true);
      mockBeadsGetCumulativeAttempts.mockResolvedValue(0);
      mockCreateTaskWorktree.mockResolvedValue(path.join(repoPath, "wt-1"));
      mockGetActiveDir.mockReturnValue(
        path.join(repoPath, "wt-1", ".opensprint", "active", "task-1")
      );
      mockBuildContext.mockResolvedValue({});
      mockAssembleTaskDirectory.mockResolvedValue(undefined);

      // Never actually spawn agent - make createTaskWorktree throw after first call to simulate
      // loop being "active" during the coding phase setup. Actually, the loop will call
      // executeCodingPhase which will call createTaskWorktree. If we make the agent spawn
      // return a handle that never exits, the loop stays "active".
      const mockKill = vi.fn();
      mockInvokeCodingAgent.mockReturnValue({
        kill: mockKill,
        pid: 12345,
      });

      await orchestrator.ensureRunning(projectId);

      // First nudge starts the loop. Second nudge while loop is active should return early.
      orchestrator.nudge(projectId);
      orchestrator.nudge(projectId);
      await new Promise((r) => setTimeout(r, 200));
      // Should not have started a second runLoop - we'd see duplicate agent.started if so
      const agentStartedCalls = mockBroadcastToProject.mock.calls.filter(
        (c: [string, { type?: string }]) => c[1]?.type === "agent.started"
      );
      expect(agentStartedCalls.length).toBeLessThanOrEqual(1);
      // agent.started includes startedAt so frontend can compute elapsed time without separate fetch
      if (agentStartedCalls.length > 0) {
        const payload = agentStartedCalls[0][1] as { type: string; taskId: string; startedAt?: string };
        expect(payload.startedAt).toBeDefined();
        expect(typeof payload.startedAt).toBe("string");
      }
    });
  });

  describe("ensureRunning - crash recovery", () => {
    it("performs crash recovery when persisted state has dead PID and no commits", async () => {
      const persistedState = {
        projectId,
        currentTaskId: "task-crashed",
        currentTaskTitle: "Crashed task",
        currentPhase: "coding" as const,
        branchName: "opensprint/task-crashed",
        worktreePath: null,
        agentPid: 999999999, // Non-existent PID (dead)
        attempt: 1,
        startedAt: new Date().toISOString(),
        lastTransition: new Date().toISOString(),
        queueDepth: 0,
        totalDone: 0,
        totalFailed: 0,
      };

      const statePath = path.join(repoPath, OPENSPRINT_PATHS.orchestratorState);
      await fs.writeFile(statePath, JSON.stringify(persistedState), "utf-8");

      mockGetCommitCountAhead.mockResolvedValue(0);
      mockCaptureBranchDiff.mockResolvedValue("");

      await orchestrator.ensureRunning(projectId);

      // Wait for async recovery
      await new Promise((r) => setTimeout(r, 150));

      // Should have cleared persisted state (unlink)
      const statePathAfter = path.join(repoPath, OPENSPRINT_PATHS.orchestratorState);
      await expect(fs.access(statePathAfter)).rejects.toThrow();

      // Should have removed worktree
      expect(mockRemoveTaskWorktree).toHaveBeenCalledWith(repoPath, "task-crashed");

      // Should have deleted branch (no commits to preserve)
      expect(mockDeleteBranch).toHaveBeenCalledWith(repoPath, "opensprint/task-crashed");

      // Should have commented on task
      expect(mockBeadsComment).toHaveBeenCalledWith(
        repoPath,
        "task-crashed",
        "Agent crashed (backend restart). No committed work found, task requeued."
      );

      // Should have requeued task
      expect(mockBeadsUpdate).toHaveBeenCalledWith(repoPath, "task-crashed", {
        status: "open",
        assignee: "",
      });

      // Should have broadcast task.updated
      expect(mockBroadcastToProject).toHaveBeenCalledWith(
        projectId,
        expect.objectContaining({
          type: "task.updated",
          taskId: "task-crashed",
          status: "open",
          assignee: null,
        })
      );
    });

    it("preserves branch when crash recovery finds committed work", async () => {
      const persistedState = {
        projectId,
        currentTaskId: "task-crashed-2",
        currentTaskTitle: "Task with work",
        currentPhase: "coding" as const,
        branchName: "opensprint/task-crashed-2",
        worktreePath: null,
        agentPid: 999999999,
        attempt: 1,
        startedAt: new Date().toISOString(),
        lastTransition: new Date().toISOString(),
        queueDepth: 0,
        totalDone: 0,
        totalFailed: 0,
      };

      const statePath = path.join(repoPath, OPENSPRINT_PATHS.orchestratorState);
      await fs.writeFile(statePath, JSON.stringify(persistedState), "utf-8");

      mockGetCommitCountAhead.mockResolvedValue(2);
      mockCaptureBranchDiff.mockResolvedValue("diff content");

      await orchestrator.ensureRunning(projectId);

      await new Promise((r) => setTimeout(r, 150));

      // Should NOT have deleted branch (has commits)
      expect(mockDeleteBranch).not.toHaveBeenCalled();

      // Should have commented about preserving branch
      expect(mockBeadsComment).toHaveBeenCalledWith(
        repoPath,
        "task-crashed-2",
        "Agent crashed (backend restart). Branch preserved with 2 commits for next attempt."
      );

      // Should still requeue
      expect(mockBeadsUpdate).toHaveBeenCalledWith(repoPath, "task-crashed-2", {
        status: "open",
        assignee: "",
      });
    });

    it("advances to review when crash recovery finds result.json success and branch has commits", async () => {
      const wtPath = path.join(repoPath, "wt-result-success");
      await fs.mkdir(path.join(wtPath, "node_modules"), { recursive: true });
      await fs.mkdir(path.join(wtPath, ".opensprint", "active", "task-result-success"), {
        recursive: true,
      });
      mockGetActiveDir.mockImplementation((base: string, tid: string) =>
        path.join(base, ".opensprint", "active", tid)
      );

      const persistedState = {
        projectId,
        currentTaskId: "task-result-success",
        currentTaskTitle: "Task with successful result",
        currentPhase: "coding" as const,
        branchName: "opensprint/task-result-success",
        worktreePath: wtPath,
        agentPid: 999999999, // Dead PID
        attempt: 1,
        startedAt: new Date().toISOString(),
        lastTransition: new Date().toISOString(),
        lastOutputTimestamp: null,
        queueDepth: 0,
        totalDone: 0,
        totalFailed: 0,
      };

      const statePath = path.join(repoPath, OPENSPRINT_PATHS.orchestratorState);
      await fs.writeFile(statePath, JSON.stringify(persistedState), "utf-8");

      mockReadResult.mockResolvedValue({ status: "success", summary: "Implemented feature" });
      mockGetCommitCountAhead.mockResolvedValue(2);
      mockCaptureBranchDiff.mockResolvedValue("diff content");
      mockGetChangedFiles.mockResolvedValue([]);
      mockRunScopedTests.mockResolvedValue({
        passed: 3,
        failed: 0,
        rawOutput: "tests passed",
      });
      mockBeadsShow.mockResolvedValue({
        id: "task-result-success",
        title: "Task with successful result",
        issue_type: "task",
        priority: 2,
        status: "in_progress",
      });
      mockGetSettings.mockResolvedValue({
        testFramework: "vitest",
        codingAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
        reviewMode: "always",
      });
      mockCommitWip.mockResolvedValue(undefined);
      mockMergeToMain.mockResolvedValue(undefined);
      mockCreateSession.mockResolvedValue({ id: "sess-1" });
      mockArchiveSession.mockResolvedValue(undefined);

      let reviewOnExit: (code: number | null) => Promise<void> = async () => {};
      mockInvokeReviewAgent.mockImplementation(
        (_p: string, _c: unknown, opts: { onExit?: (code: number | null) => Promise<void> }) => {
          reviewOnExit = opts.onExit ?? (async () => {});
          return { kill: vi.fn(), pid: 12346 };
        }
      );

      await orchestrator.ensureRunning(projectId);

      await new Promise((r) => setTimeout(r, 150));

      // Should NOT requeue — should have advanced to review
      expect(mockBeadsUpdate).not.toHaveBeenCalledWith(
        repoPath,
        "task-result-success",
        expect.objectContaining({ status: "open" })
      );

      // Should NOT have removed worktree (we need it for review)
      expect(mockRemoveTaskWorktree).not.toHaveBeenCalledWith(repoPath, "task-result-success");

      // Should have invoked review agent
      expect(mockInvokeReviewAgent).toHaveBeenCalled();

      // Should have read result.json from worktree
      expect(mockReadResult).toHaveBeenCalledWith(wtPath, "task-result-success");

      // Clean up: simulate review agent exit so we don't leave timers running
      await reviewOnExit(0);
      await new Promise((r) => setTimeout(r, 100));
    });

    it("requeues when crash recovery finds result.json success but tests fail", async () => {
      const wtPath = path.join(repoPath, "wt-result-tests-fail");
      await fs.mkdir(path.join(wtPath, "node_modules"), { recursive: true });

      const persistedState = {
        projectId,
        currentTaskId: "task-result-tests-fail",
        currentTaskTitle: "Task with result but failing tests",
        currentPhase: "coding" as const,
        branchName: "opensprint/task-result-tests-fail",
        worktreePath: wtPath,
        agentPid: 999999999,
        attempt: 1,
        startedAt: new Date().toISOString(),
        lastTransition: new Date().toISOString(),
        lastOutputTimestamp: null,
        queueDepth: 0,
        totalDone: 0,
        totalFailed: 0,
      };

      const statePath = path.join(repoPath, OPENSPRINT_PATHS.orchestratorState);
      await fs.writeFile(statePath, JSON.stringify(persistedState), "utf-8");

      mockReadResult.mockResolvedValue({ status: "success", summary: "Done" });
      mockGetCommitCountAhead.mockResolvedValue(1);
      mockGetChangedFiles.mockResolvedValue([]);
      mockRunScopedTests.mockResolvedValue({
        passed: 1,
        failed: 2,
        rawOutput: "2 tests failed",
      });

      await orchestrator.ensureRunning(projectId);

      await new Promise((r) => setTimeout(r, 150));

      // Tests failed — should fall through to normal recovery and requeue
      expect(mockBeadsUpdate).toHaveBeenCalledWith(repoPath, "task-result-tests-fail", {
        status: "open",
        assignee: "",
      });
      expect(mockRemoveTaskWorktree).toHaveBeenCalledWith(repoPath, "task-result-tests-fail");
    });

    it("requeues when crash recovery has result.json but no commits (commitCount 0)", async () => {
      const wtPath = path.join(repoPath, "wt-result-no-commits");
      await fs.mkdir(path.join(wtPath, "node_modules"), { recursive: true });

      const persistedState = {
        projectId,
        currentTaskId: "task-result-no-commits",
        currentTaskTitle: "Task with result but no commits",
        currentPhase: "coding" as const,
        branchName: "opensprint/task-result-no-commits",
        worktreePath: wtPath,
        agentPid: 999999999,
        attempt: 1,
        startedAt: new Date().toISOString(),
        lastTransition: new Date().toISOString(),
        lastOutputTimestamp: null,
        queueDepth: 0,
        totalDone: 0,
        totalFailed: 0,
      };

      const statePath = path.join(repoPath, OPENSPRINT_PATHS.orchestratorState);
      await fs.writeFile(statePath, JSON.stringify(persistedState), "utf-8");

      mockReadResult.mockResolvedValue({ status: "success", summary: "Done" });
      mockGetCommitCountAhead.mockResolvedValue(0);

      await orchestrator.ensureRunning(projectId);

      await new Promise((r) => setTimeout(r, 150));

      // No commits — should requeue (result.json without commits is suspicious)
      expect(mockBeadsUpdate).toHaveBeenCalledWith(repoPath, "task-result-no-commits", {
        status: "open",
        assignee: "",
      });
    });

    it("starts fresh when persisted state has no active task", async () => {
      const persistedState = {
        projectId,
        currentTaskId: null,
        currentTaskTitle: null,
        currentPhase: null,
        branchName: null,
        worktreePath: null,
        agentPid: null,
        attempt: 1,
        startedAt: null,
        lastTransition: new Date().toISOString(),
        queueDepth: 0,
        totalDone: 5,
        totalFailed: 1,
      };

      const statePath = path.join(repoPath, OPENSPRINT_PATHS.orchestratorState);
      await fs.writeFile(statePath, JSON.stringify(persistedState), "utf-8");

      mockBeadsReady.mockResolvedValue([]);

      await orchestrator.ensureRunning(projectId);

      await new Promise((r) => setTimeout(r, 150));

      // State file should be cleared
      await expect(
        fs.access(path.join(repoPath, OPENSPRINT_PATHS.orchestratorState))
      ).rejects.toThrow();
    });
  });

  describe("ensureRunning - full loop with task completion", () => {
    it("completes task when coding succeeds and reviewMode is never", async () => {
      const task = {
        id: "task-complete-1",
        title: "Complete me",
        issue_type: "task",
        priority: 2,
        status: "open",
      };

      const wtPathComplete = path.join(repoPath, "wt-complete");
      await fs.mkdir(path.join(wtPathComplete, "node_modules"), {
        recursive: true,
      });

      mockBeadsReady.mockResolvedValue([task]);
      mockBeadsAreAllBlockersClosed.mockResolvedValue(true);
      mockBeadsGetCumulativeAttempts.mockResolvedValue(0);
      mockCreateTaskWorktree.mockResolvedValue(wtPathComplete);
      mockGetActiveDir.mockReturnValue(
        path.join(repoPath, "wt-complete", ".opensprint", "active", "task-complete-1")
      );
      mockBuildContext.mockResolvedValue({});
      mockAssembleTaskDirectory.mockResolvedValue(undefined);
      mockGetChangedFiles.mockResolvedValue([]);
      mockRunScopedTests.mockResolvedValue({
        passed: 3,
        failed: 0,
        rawOutput: "tests passed",
      });
      mockReadResult.mockResolvedValue({ status: "success", summary: "Done" });

      let onExit: (code: number | null) => Promise<void> = async () => {};
      mockInvokeCodingAgent.mockImplementation(
        (_p: string, _c: unknown, opts: { onExit?: (code: number | null) => Promise<void> }) => {
          onExit = opts.onExit ?? (async () => {});
          return { kill: vi.fn(), pid: 12345 };
        }
      );

      await orchestrator.ensureRunning(projectId);

      await new Promise((r) => setTimeout(r, 300));

      mockBeadsShow.mockResolvedValue({ ...task, status: "in_progress" });
      mockMergeToMain.mockResolvedValue(undefined);
      mockCreateSession.mockResolvedValue({ id: "sess-1" });
      mockArchiveSession.mockResolvedValue(undefined);

      await onExit(0);

      await new Promise((r) => setTimeout(r, 300));

      // Should have merged and closed
      expect(mockBeadsClose).toHaveBeenCalledWith(repoPath, "task-complete-1", "Done");
      expect(mockMergeToMain).toHaveBeenCalledWith(repoPath, "opensprint/task-complete-1");
      expect(mockBroadcastToProject).toHaveBeenCalledWith(
        projectId,
        expect.objectContaining({
          type: "agent.completed",
          taskId: "task-complete-1",
          status: "approved",
        })
      );
    });

    it("completes task when review agent approves (result.json status approved)", async () => {
      const task = {
        id: "task-review-approve",
        title: "Task with review",
        issue_type: "task",
        priority: 2,
        status: "open",
      };

      const wtPath = path.join(repoPath, "wt-review");
      await fs.mkdir(path.join(wtPath, "node_modules"), { recursive: true });

      mockGetSettings.mockResolvedValue({
        testFramework: "vitest",
        codingAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
        reviewMode: "always",
      });

      mockBeadsReady.mockResolvedValue([task]);
      mockBeadsAreAllBlockersClosed.mockResolvedValue(true);
      mockBeadsGetCumulativeAttempts.mockResolvedValue(0);
      mockCreateTaskWorktree.mockResolvedValue(wtPath);
      mockGetActiveDir.mockReturnValue(
        path.join(wtPath, ".opensprint", "active", "task-review-approve")
      );
      mockBuildContext.mockResolvedValue({});
      mockAssembleTaskDirectory.mockResolvedValue(undefined);
      mockGetChangedFiles.mockResolvedValue([]);
      mockRunScopedTests.mockResolvedValue({
        passed: 3,
        failed: 0,
        rawOutput: "tests passed",
      });
      mockCaptureBranchDiff.mockResolvedValue("diff content");

      // First call: coding agent result (success); second call: review agent result (approved)
      mockReadResult
        .mockResolvedValueOnce({ status: "success", summary: "Implemented feature" })
        .mockResolvedValueOnce({
          status: "approved",
          summary: "Implementation meets all acceptance criteria.",
        });

      let codingOnExit: (code: number | null) => Promise<void> = async () => {};
      mockInvokeCodingAgent.mockImplementation(
        (_p: string, _c: unknown, opts: { onExit?: (code: number | null) => Promise<void> }) => {
          codingOnExit = opts.onExit ?? (async () => {});
          return { kill: vi.fn(), pid: 12345 };
        }
      );

      let reviewOnExit: (code: number | null) => Promise<void> = async () => {};
      mockInvokeReviewAgent.mockImplementation(
        (_p: string, _c: unknown, opts: { onExit?: (code: number | null) => Promise<void> }) => {
          reviewOnExit = opts.onExit ?? (async () => {});
          return { kill: vi.fn(), pid: 12346 };
        }
      );

      await orchestrator.ensureRunning(projectId);
      await new Promise((r) => setTimeout(r, 300));

      // Coding agent exits with success
      await codingOnExit(0);
      await new Promise((r) => setTimeout(r, 300));

      // Review agent should have been invoked
      expect(mockInvokeReviewAgent).toHaveBeenCalled();
      expect(mockMergeToMain).not.toHaveBeenCalled();
      expect(mockBeadsClose).not.toHaveBeenCalled();

      mockBeadsShow.mockResolvedValue({ ...task, status: "in_progress" });
      mockMergeToMain.mockResolvedValue(undefined);
      mockCreateSession.mockResolvedValue({ id: "sess-1" });
      mockArchiveSession.mockResolvedValue(undefined);

      // Review agent exits with approved
      await reviewOnExit(0);
      await new Promise((r) => setTimeout(r, 300));

      // On result.json approved: merge and Done
      expect(mockMergeToMain).toHaveBeenCalledWith(repoPath, "opensprint/task-review-approve");
      expect(mockBeadsClose).toHaveBeenCalledWith(
        repoPath,
        "task-review-approve",
        "Implemented feature"
      );
      expect(mockBroadcastToProject).toHaveBeenCalledWith(
        projectId,
        expect.objectContaining({
          type: "task.updated",
          taskId: "task-review-approve",
          status: "closed",
          assignee: null,
        })
      );
      expect(mockBroadcastToProject).toHaveBeenCalledWith(
        projectId,
        expect.objectContaining({
          type: "agent.completed",
          taskId: "task-review-approve",
          status: "approved",
        })
      );
    });

    it("treats result.json status 'approve' as approved (normalization)", async () => {
      const task = {
        id: "task-approve-normalize",
        title: "Task with approve status",
        issue_type: "task",
        priority: 2,
        status: "open",
      };

      const wtPath = path.join(repoPath, "wt-approve-norm");
      await fs.mkdir(path.join(wtPath, "node_modules"), { recursive: true });

      mockGetSettings.mockResolvedValue({
        testFramework: "vitest",
        codingAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
        reviewMode: "always",
      });

      mockBeadsReady.mockResolvedValue([task]);
      mockBeadsAreAllBlockersClosed.mockResolvedValue(true);
      mockBeadsGetCumulativeAttempts.mockResolvedValue(0);
      mockCreateTaskWorktree.mockResolvedValue(wtPath);
      mockGetActiveDir.mockReturnValue(
        path.join(wtPath, ".opensprint", "active", "task-approve-normalize")
      );
      mockBuildContext.mockResolvedValue({});
      mockAssembleTaskDirectory.mockResolvedValue(undefined);
      mockGetChangedFiles.mockResolvedValue([]);
      mockRunScopedTests.mockResolvedValue({
        passed: 2,
        failed: 0,
        rawOutput: "ok",
      });
      mockCaptureBranchDiff.mockResolvedValue("");

      mockReadResult
        .mockResolvedValueOnce({ status: "success", summary: "Done" })
        .mockResolvedValueOnce({ status: "approve", summary: "Looks good" });

      let codingOnExit: (code: number | null) => Promise<void> = async () => {};
      mockInvokeCodingAgent.mockImplementation(
        (_p: string, _c: unknown, opts: { onExit?: (code: number | null) => Promise<void> }) => {
          codingOnExit = opts.onExit ?? (async () => {});
          return { kill: vi.fn(), pid: 12345 };
        }
      );

      let reviewOnExit: (code: number | null) => Promise<void> = async () => {};
      mockInvokeReviewAgent.mockImplementation(
        (_p: string, _c: unknown, opts: { onExit?: (code: number | null) => Promise<void> }) => {
          reviewOnExit = opts.onExit ?? (async () => {});
          return { kill: vi.fn(), pid: 12346 };
        }
      );

      await orchestrator.ensureRunning(projectId);
      await new Promise((r) => setTimeout(r, 300));
      await codingOnExit(0);
      await new Promise((r) => setTimeout(r, 300));

      mockMergeToMain.mockResolvedValue(undefined);
      mockCreateSession.mockResolvedValue({ id: "sess-1" });
      mockArchiveSession.mockResolvedValue(undefined);

      await reviewOnExit(0);
      await new Promise((r) => setTimeout(r, 300));

      expect(mockMergeToMain).toHaveBeenCalledWith(repoPath, "opensprint/task-approve-normalize");
      expect(mockBeadsClose).toHaveBeenCalledWith(repoPath, "task-approve-normalize", "Done");
    });
  });

  describe("progressive backoff - test failure retry", () => {
    it("retries immediately when tests fail (attempt 1, not demotion point)", async () => {
      const task = {
        id: "task-test-fail",
        title: "Task with test failure",
        issue_type: "task",
        priority: 2,
        status: "open",
      };

      const wtPath = path.join(repoPath, "wt-fail");
      await fs.mkdir(path.join(wtPath, "node_modules"), { recursive: true });

      mockBeadsReady.mockResolvedValue([task]);
      mockBeadsAreAllBlockersClosed.mockResolvedValue(true);
      mockBeadsGetCumulativeAttempts.mockResolvedValue(0);
      mockCreateTaskWorktree.mockResolvedValue(wtPath);
      mockGetActiveDir.mockReturnValue(
        path.join(repoPath, "wt-fail", ".opensprint", "active", "task-test-fail")
      );
      mockBuildContext.mockResolvedValue({});
      mockAssembleTaskDirectory.mockResolvedValue(undefined);
      mockGetChangedFiles.mockResolvedValue([]);
      // Agent succeeds but tests fail
      mockReadResult.mockResolvedValue({ status: "success", summary: "Code done" });
      mockRunScopedTests.mockResolvedValue({
        passed: 1,
        failed: 2,
        rawOutput: "2 tests failed",
      });

      let onExit: (code: number | null) => Promise<void> = async () => {};
      mockInvokeCodingAgent.mockImplementation(
        (_p: string, _c: unknown, opts: { onExit?: (code: number | null) => Promise<void> }) => {
          onExit = opts.onExit ?? (async () => {});
          return { kill: vi.fn(), pid: 12345 };
        }
      );

      await orchestrator.ensureRunning(projectId);
      await new Promise((r) => setTimeout(r, 300));

      mockBeadsSetCumulativeAttempts.mockResolvedValue(undefined);

      await onExit(0);
      await new Promise((r) => setTimeout(r, 400));

      // Should have added failure comment
      expect(mockBeadsComment).toHaveBeenCalledWith(
        repoPath,
        "task-test-fail",
        expect.stringContaining("Attempt 1 failed [test_failure]")
      );

      // Should have archived session
      expect(mockArchiveSession).toHaveBeenCalled();

      // Should have set cumulative attempts for retry
      expect(mockBeadsSetCumulativeAttempts).toHaveBeenCalledWith(repoPath, "task-test-fail", 1);

      // Should retry (executeCodingPhase called again) - removeTaskWorktree then createTaskWorktree
      expect(mockRemoveTaskWorktree).toHaveBeenCalledWith(repoPath, "task-test-fail");
      // Second call to createTaskWorktree for retry
      expect(mockCreateTaskWorktree.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it("retries when coding agent returns result.json status failed (coding_failure)", async () => {
      const task = {
        id: "task-coding-fail",
        title: "Task with coding failure",
        issue_type: "task",
        priority: 2,
        status: "open",
      };

      const wtPath = path.join(repoPath, "wt-coding-fail");
      await fs.mkdir(path.join(wtPath, "node_modules"), { recursive: true });

      mockBeadsReady.mockResolvedValue([task]);
      mockBeadsAreAllBlockersClosed.mockResolvedValue(true);
      mockBeadsGetCumulativeAttempts.mockResolvedValue(0);
      mockCreateTaskWorktree.mockResolvedValue(wtPath);
      mockGetActiveDir.mockReturnValue(
        path.join(repoPath, "wt-coding-fail", ".opensprint", "active", "task-coding-fail")
      );
      mockBuildContext.mockResolvedValue({});
      mockAssembleTaskDirectory.mockResolvedValue(undefined);
      mockReadResult.mockResolvedValue({
        status: "failed",
        summary: "Could not implement feature due to API limitations",
      });

      let onExit: (code: number | null) => Promise<void> = async () => {};
      mockInvokeCodingAgent.mockImplementation(
        (_p: string, _c: unknown, opts: { onExit?: (code: number | null) => Promise<void> }) => {
          onExit = opts.onExit ?? (async () => {});
          return { kill: vi.fn(), pid: 12345 };
        }
      );

      await orchestrator.ensureRunning(projectId);
      await new Promise((r) => setTimeout(r, 300));

      mockBeadsSetCumulativeAttempts.mockResolvedValue(undefined);

      await onExit(1);
      await new Promise((r) => setTimeout(r, 400));

      expect(mockBeadsComment).toHaveBeenCalledWith(
        repoPath,
        "task-coding-fail",
        expect.stringContaining("Attempt 1 failed [coding_failure]")
      );
      expect(mockArchiveSession).toHaveBeenCalled();
      expect(mockBeadsSetCumulativeAttempts).toHaveBeenCalledWith(repoPath, "task-coding-fail", 1);

      // Retry should pass previousFailure to assembleTaskDirectory
      const assembleCalls = mockAssembleTaskDirectory.mock.calls;
      const retryCall = assembleCalls.find(
        (c: unknown[]) =>
          Array.isArray(c) &&
          c[2] &&
          typeof c[2] === "object" &&
          "previousFailure" in (c[2] as object) &&
          (c[2] as { previousFailure: string | null }).previousFailure !== null
      );
      expect(retryCall).toBeDefined();
      const retryConfig = retryCall![2] as { previousFailure: string | null };
      expect(retryConfig.previousFailure).toContain("API limitations");
    });

    it("retries with agent_crash when coding agent exits without result (exit 143)", async () => {
      const task = {
        id: "task-no-result",
        title: "Task with agent crash",
        issue_type: "task",
        priority: 2,
        status: "open",
      };

      const wtPath = path.join(repoPath, "wt-no-result");
      await fs.mkdir(path.join(wtPath, "node_modules"), { recursive: true });

      mockBeadsReady.mockResolvedValue([task]);
      mockBeadsAreAllBlockersClosed.mockResolvedValue(true);
      mockBeadsGetCumulativeAttempts.mockResolvedValue(0);
      mockCreateTaskWorktree.mockResolvedValue(wtPath);
      mockGetActiveDir.mockReturnValue(
        path.join(repoPath, "wt-no-result", ".opensprint", "active", "task-no-result")
      );
      mockBuildContext.mockResolvedValue({});
      mockAssembleTaskDirectory.mockResolvedValue(undefined);
      mockReadResult.mockResolvedValue(null);

      let onExit: (code: number | null) => Promise<void> = async () => {};
      mockInvokeCodingAgent.mockImplementation(
        (_p: string, _c: unknown, opts: { onExit?: (code: number | null) => Promise<void> }) => {
          onExit = opts.onExit ?? (async () => {});
          return { kill: vi.fn(), pid: 12345 };
        }
      );

      await orchestrator.ensureRunning(projectId);
      await new Promise((r) => setTimeout(r, 300));

      await onExit(143);
      await new Promise((r) => setTimeout(r, 400));

      expect(mockBeadsComment).toHaveBeenCalledWith(
        repoPath,
        "task-no-result",
        expect.stringContaining("Attempt 1 failed [agent_crash]")
      );
      expect(mockArchiveSession).toHaveBeenCalled();
      expect(mockRemoveTaskWorktree).toHaveBeenCalledWith(repoPath, "task-no-result");
      expect(mockCreateTaskWorktree.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it("retries with no_result when coding agent exits without result (non-SIGTERM exit)", async () => {
      const task = {
        id: "task-no-result-other",
        title: "Task with unexpected exit",
        issue_type: "task",
        priority: 2,
        status: "open",
      };

      const wtPath = path.join(repoPath, "wt-no-result-other");
      await fs.mkdir(path.join(wtPath, "node_modules"), { recursive: true });

      mockBeadsReady.mockResolvedValue([task]);
      mockBeadsAreAllBlockersClosed.mockResolvedValue(true);
      mockBeadsGetCumulativeAttempts.mockResolvedValue(0);
      mockCreateTaskWorktree.mockResolvedValue(wtPath);
      mockGetActiveDir.mockReturnValue(
        path.join(repoPath, "wt-no-result-other", ".opensprint", "active", "task-no-result-other")
      );
      mockBuildContext.mockResolvedValue({});
      mockAssembleTaskDirectory.mockResolvedValue(undefined);
      mockReadResult.mockResolvedValue(null);

      let onExit: (code: number | null) => Promise<void> = async () => {};
      mockInvokeCodingAgent.mockImplementation(
        (_p: string, _c: unknown, opts: { onExit?: (code: number | null) => Promise<void> }) => {
          onExit = opts.onExit ?? (async () => {});
          return { kill: vi.fn(), pid: 12345 };
        }
      );

      await orchestrator.ensureRunning(projectId);
      await new Promise((r) => setTimeout(r, 300));

      await onExit(1);
      await new Promise((r) => setTimeout(r, 400));

      expect(mockBeadsComment).toHaveBeenCalledWith(
        repoPath,
        "task-no-result-other",
        expect.stringContaining("Attempt 1 failed [no_result]")
      );
    });
  });
});
