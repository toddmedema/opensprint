import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import * as worktreeHealth from "../utils/worktree-health.js";
import { RecoveryService } from "../services/recovery.service.js";

const TEST_PID = 99999;
const mockFindStaleHeartbeats = vi.fn();
const mockKill = vi.fn();
const mockReadHeartbeat = vi.fn();
const mockFindOrphanedAssignments = vi.fn();
const mockFindOrphanedAssignmentsFromWorktrees = vi.fn();
const mockReadAssignmentAt = vi.fn();
const mockListCleanupIntents = vi.fn();
const mockRemoveCleanupIntent = vi.fn();
const mockRemoveTaskWorktree = vi.fn();
const mockDeleteBranch = vi.fn();
const mockPruneOrphanWorktrees = vi.fn();
const mockListTaskWorktrees = vi.fn();
const mockCanCleanupLease = vi.fn();

vi.mock("../services/heartbeat.service.js", () => ({
  heartbeatService: {
    findStaleHeartbeats: (...args: unknown[]) => mockFindStaleHeartbeats(...args),
    readHeartbeat: (...args: unknown[]) => mockReadHeartbeat(...args),
    deleteHeartbeat: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    show: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
    setMergeStage: vi.fn().mockResolvedValue(undefined),
    listAll: vi.fn().mockResolvedValue([]),
    listInProgressWithAgentAssignee: vi.fn().mockResolvedValue([]),
    listInProgressWithoutAssignee: vi.fn().mockResolvedValue([]),
    comment: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../services/event-log.service.js", () => ({
  eventLogService: {
    append: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../services/crash-recovery.service.js", () => ({
  CrashRecoveryService: vi.fn().mockImplementation(() => ({
    findOrphanedAssignments: (...args: unknown[]) => mockFindOrphanedAssignments(...args),
    findOrphanedAssignmentsFromWorktrees: (...args: unknown[]) =>
      mockFindOrphanedAssignmentsFromWorktrees(...args),
    readAssignmentAt: (...args: unknown[]) => mockReadAssignmentAt(...args),
    deleteAssignmentAt: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../services/project.service.js", () => ({
  ProjectService: vi.fn().mockImplementation(() => ({
    getSettings: vi.fn().mockResolvedValue({ gitWorkingMode: "worktree" }),
  })),
}));

vi.mock("../services/worktree-cleanup-intent.service.js", () => ({
  worktreeCleanupIntentService: {
    list: (...args: unknown[]) => mockListCleanupIntents(...args),
    removeBestEffort: (...args: unknown[]) => mockRemoveCleanupIntent(...args),
  },
}));

vi.mock("../services/worktree-lease.service.js", () => ({
  worktreeLeaseService: {
    canCleanup: (...args: unknown[]) => mockCanCleanupLease(...args),
    forceRelease: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("../services/branch-manager.js", () => ({
  BranchManager: vi.fn().mockImplementation(() => ({
    getWorktreeBasePath: vi.fn().mockReturnValue(path.join(os.tmpdir(), "opensprint-worktrees")),
    getLegacyWorktreeBasePath: vi
      .fn()
      .mockReturnValue(path.join(os.tmpdir(), "opensprint-worktrees-legacy")),
    getWorktreePath: vi
      .fn()
      .mockImplementation((taskId: string) =>
        path.join(os.tmpdir(), "opensprint-worktrees", taskId)
      ),
    commitWip: vi.fn().mockResolvedValue(undefined),
    listTaskWorktrees: (...args: unknown[]) => mockListTaskWorktrees(...args),
    removeTaskWorktree: (...args: unknown[]) => mockRemoveTaskWorktree(...args),
    deleteBranch: (...args: unknown[]) => mockDeleteBranch(...args),
    pruneOrphanWorktrees: (...args: unknown[]) => mockPruneOrphanWorktrees(...args),
  })),
}));

import { taskStore } from "../services/task-store.service.js";
import { eventLogService } from "../services/event-log.service.js";
import { worktreeLeaseService } from "../services/worktree-lease.service.js";

describe("RecoveryService — stale heartbeat recovery", () => {
  let tmpDir: string;
  let service: RecoveryService;
  const originalKill = process.kill;

  const host = {
    getSlottedTaskIds: () => [] as string[],
    getActiveAgentIds: () => [] as string[],
  };

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `recovery-test-${Date.now()}`);
    await fs.mkdir(path.join(tmpDir, ".git"), { recursive: true });
    service = new RecoveryService();
    vi.clearAllMocks();
    mockFindStaleHeartbeats.mockResolvedValue([]);
    mockReadHeartbeat.mockResolvedValue(null);
    mockFindOrphanedAssignments.mockResolvedValue([]);
    mockFindOrphanedAssignmentsFromWorktrees.mockResolvedValue([]);
    mockReadAssignmentAt.mockResolvedValue(null);
    mockListCleanupIntents.mockResolvedValue([]);
    mockRemoveCleanupIntent.mockResolvedValue(undefined);
    mockRemoveTaskWorktree.mockResolvedValue(true);
    mockDeleteBranch.mockResolvedValue(undefined);
    mockPruneOrphanWorktrees.mockResolvedValue([]);
    mockListTaskWorktrees.mockResolvedValue([]);
    mockCanCleanupLease.mockResolvedValue(true);
    vi.mocked(taskStore.listInProgressWithAgentAssignee).mockResolvedValue([]);
    vi.mocked(taskStore.listInProgressWithoutAssignee).mockResolvedValue([]);
    vi.mocked(taskStore.show).mockResolvedValue({
      id: "task-stale",
      status: "in_progress",
      assignee: "agent",
    } as never);
  });

  afterEach(async () => {
    process.kill = originalKill;
    vi.useRealTimers();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("preserves a live orphan whose process ownership cannot be verified", async () => {
    mockFindStaleHeartbeats.mockResolvedValue([
      {
        taskId: "task-stale",
        heartbeat: {
          processGroupLeaderPid: TEST_PID,
          lastOutputTimestamp: 0,
          heartbeatTimestamp: Date.now() - 3 * 60 * 1000,
        },
      },
    ]);

    // process.kill(pid, 0) = alive; process group SIGTERM/SIGKILL succeed
    process.kill = mockKill as unknown as typeof process.kill;
    mockKill.mockImplementation((pid: number, signal: number | string) => {
      if (signal === 0) return; // isPidAlive: don't throw
      if (signal === "SIGTERM" || signal === "SIGKILL") return;
      throw new Error("Unknown signal");
    });

    await service.runFullRecovery("proj-1", tmpDir, host);

    const sigtermCalls = mockKill.mock.calls.filter((c) => c[1] === "SIGTERM");
    expect(sigtermCalls).toEqual([]);
    expect(vi.mocked(taskStore.update)).not.toHaveBeenCalled();
  });

  it("does not call process.kill when processGroupLeaderPid is missing or invalid", async () => {
    mockFindStaleHeartbeats.mockResolvedValue([
      {
        taskId: "task-stale",
        heartbeat: {
          processGroupLeaderPid: undefined,
          lastOutputTimestamp: 0,
          heartbeatTimestamp: Date.now() - 3 * 60 * 1000,
        },
      },
    ]);

    process.kill = mockKill as unknown as typeof process.kill;
    mockKill.mockImplementation(() => {
      throw new Error("Should not be called");
    });

    await service.runFullRecovery("proj-1", tmpDir, host);

    expect(mockKill).not.toHaveBeenCalledWith(expect.anything(), "SIGTERM");
    expect(vi.mocked(taskStore.update)).toHaveBeenCalledWith(
      "proj-1",
      "task-stale",
      expect.objectContaining({ status: "open" })
    );
  });

  it("does not call SIGTERM when the process-group leader is already dead", async () => {
    mockFindStaleHeartbeats.mockResolvedValue([
      {
        taskId: "task-stale",
        heartbeat: {
          processGroupLeaderPid: TEST_PID,
          lastOutputTimestamp: 0,
          heartbeatTimestamp: Date.now() - 3 * 60 * 1000,
        },
      },
    ]);

    process.kill = mockKill as unknown as typeof process.kill;
    mockKill.mockImplementation((_pid: number, signal: number | string) => {
      if (signal === 0) throw new Error("No such process"); // isPidAlive returns false
      throw new Error("Should not reach other signals");
    });

    await service.runFullRecovery("proj-1", tmpDir, host);

    expect(mockKill).not.toHaveBeenCalledWith(expect.anything(), "SIGTERM");
    expect(vi.mocked(taskStore.update)).toHaveBeenCalledWith(
      "proj-1",
      "task-stale",
      expect.objectContaining({ status: "open" })
    );
  });

  it("resumes review-phase assignments through the host instead of requeueing", async () => {
    const reviewHost = {
      ...host,
      reattachSlot: vi.fn().mockResolvedValue(false),
      resumeReviewPhase: vi.fn().mockResolvedValue(true),
    };
    vi.mocked(taskStore.listAll).mockResolvedValue([
      {
        id: "task-stale",
        status: "in_progress",
        assignee: "Boromir",
      } as never,
    ]);

    mockFindOrphanedAssignments.mockResolvedValue([
      {
        taskId: "task-stale",
        assignment: {
          taskId: "task-stale",
          projectId: "proj-1",
          phase: "review",
          branchName: "opensprint/task-stale",
          worktreePath: "/tmp/review-wt",
          promptPath: "/tmp/review-wt/.opensprint/active/task-stale/prompt.md",
          agentConfig: { type: "cursor", model: "gpt-5", cliCommand: null },
          attempt: 3,
          createdAt: new Date().toISOString(),
        },
      },
    ]);
    mockReadHeartbeat.mockResolvedValue({
      processGroupLeaderPid: TEST_PID,
      lastOutputTimestamp: Date.now(),
      heartbeatTimestamp: Date.now(),
    });
    process.kill = mockKill as unknown as typeof process.kill;
    mockKill.mockImplementation((pid: number, signal: number | string) => {
      if (signal === 0 && pid === TEST_PID) return;
      throw new Error("Should not send other signals");
    });

    await service.runFullRecovery("proj-1", tmpDir, reviewHost, { includeGupp: true });

    expect(reviewHost.resumeReviewPhase).toHaveBeenCalledWith(
      "proj-1",
      tmpDir,
      expect.objectContaining({ id: "task-stale" }),
      expect.objectContaining({ phase: "review", attempt: 3 }),
      { pidAlive: true }
    );
    expect(vi.mocked(taskStore.update)).not.toHaveBeenCalledWith(
      "proj-1",
      "task-stale",
      expect.objectContaining({ status: "open" })
    );
  });

  it.each(["live", "complete", "pending"])(
    "inspects a fresh on-disk %s assignment while preserving cleanup protection",
    async (mode) => {
      const taskId = `fresh-${mode}`;
      const promptDir = path.join(tmpDir, ".opensprint", "active", taskId);
      const assignment = {
        taskId,
        projectId: "proj-1",
        phase: "coding" as const,
        branchName: `opensprint/${taskId}`,
        worktreePath: tmpDir,
        promptPath: path.join(promptDir, "prompt.md"),
        agentConfig: { type: "cursor", model: "gpt-5", cliCommand: null },
        attempt: 1,
        createdAt: new Date().toISOString(),
      };
      await fs.mkdir(promptDir, { recursive: true });
      await fs.writeFile(path.join(promptDir, "assignment.json"), JSON.stringify(assignment));
      if (mode === "complete") {
        await fs.writeFile(
          path.join(promptDir, "result.json"),
          JSON.stringify({ status: "success" })
        );
      }
      const recoveryHost = {
        ...host,
        reattachSlot: vi.fn().mockResolvedValue(true),
        handleCompletedAssignment: vi.fn().mockResolvedValue(true),
      };
      vi.mocked(taskStore.listAll).mockResolvedValue([
        { id: taskId, status: "in_progress" } as never,
      ]);
      vi.mocked(taskStore.listInProgressWithAgentAssignee).mockResolvedValue([
        { id: taskId, status: "in_progress", updated_at: new Date(0).toISOString() } as never,
      ]);
      mockFindOrphanedAssignments.mockResolvedValue([{ taskId, assignment }]);
      mockReadHeartbeat.mockResolvedValue(
        mode === "live"
          ? {
              processGroupLeaderPid: TEST_PID,
              lastOutputTimestamp: Date.now(),
              heartbeatTimestamp: Date.now(),
            }
          : null
      );
      process.kill = mockKill as unknown as typeof process.kill;
      mockKill.mockImplementation(() => true);

      const result = await service.runFullRecovery("proj-1", tmpDir, recoveryHost, {
        includeGupp: true,
      });

      expect(result.reattached).toEqual(mode === "pending" ? [] : [taskId]);
      expect(vi.mocked(taskStore.update)).not.toHaveBeenCalled();
      expect(mockRemoveTaskWorktree).not.toHaveBeenCalled();
      if (mode === "live") expect(recoveryHost.reattachSlot).toHaveBeenCalledOnce();
      if (mode === "complete")
        expect(recoveryHost.handleCompletedAssignment).toHaveBeenCalledOnce();
    }
  );

  it("does not delete worktrees after a task-store lookup failure", async () => {
    mockFindStaleHeartbeats.mockResolvedValue([
      {
        taskId: "lookup-failure",
        heartbeat: {
          processGroupLeaderPid: TEST_PID,
          lastOutputTimestamp: 0,
          heartbeatTimestamp: 0,
        },
      },
    ]);
    vi.mocked(taskStore.show).mockRejectedValueOnce(new Error("database temporarily unavailable"));
    await service.runFullRecovery("proj-1", tmpDir, host);
    expect(mockRemoveTaskWorktree).not.toHaveBeenCalled();
    expect(vi.mocked(taskStore.update)).not.toHaveBeenCalled();
  });

  it("does not delete a recoverable checkout when persisting the requeue fails", async () => {
    mockFindStaleHeartbeats.mockResolvedValue([
      {
        taskId: "write-failure",
        heartbeat: { processGroupLeaderPid: 0, lastOutputTimestamp: 0, heartbeatTimestamp: 0 },
      },
    ]);
    vi.mocked(taskStore.show).mockResolvedValueOnce({
      id: "write-failure",
      status: "in_progress",
    } as never);
    vi.mocked(taskStore.update).mockRejectedValueOnce(
      new Error("database temporarily unavailable")
    );
    const result = await service.runFullRecovery("proj-1", tmpDir, host);
    expect(result.requeued).toEqual([]);
    expect(mockRemoveTaskWorktree).not.toHaveBeenCalled();
  });

  it("completes orphaned assignments with terminal result.json during startup recovery", async () => {
    const completedHost = {
      ...host,
      handleCompletedAssignment: vi.fn().mockResolvedValue(true),
    };
    const promptDir = path.join(tmpDir, ".opensprint", "active", "task-stale");
    await fs.mkdir(promptDir, { recursive: true });
    await fs.writeFile(
      path.join(promptDir, "result.json"),
      JSON.stringify({ status: "success", summary: "done" }),
      "utf-8"
    );

    vi.mocked(taskStore.listAll).mockResolvedValue([
      {
        id: "task-stale",
        status: "in_progress",
        assignee: "Frodo",
      } as never,
    ]);
    mockFindOrphanedAssignments.mockResolvedValue([
      {
        taskId: "task-stale",
        assignment: {
          taskId: "task-stale",
          projectId: "proj-1",
          phase: "coding",
          branchName: "opensprint/task-stale",
          worktreePath: tmpDir,
          promptPath: path.join(promptDir, "prompt.md"),
          agentConfig: { type: "cursor", model: "gpt-5", cliCommand: null },
          attempt: 2,
          createdAt: new Date().toISOString(),
        },
      },
    ]);

    const result = await service.runFullRecovery("proj-1", tmpDir, completedHost, {
      includeGupp: true,
    });

    expect(completedHost.handleCompletedAssignment).toHaveBeenCalledWith(
      "proj-1",
      tmpDir,
      expect.objectContaining({ id: "task-stale" }),
      expect.objectContaining({ phase: "coding", attempt: 2 })
    );
    expect(result.reattached).toEqual(["task-stale"]);
    expect(result.requeued).toEqual([]);
    expect(vi.mocked(taskStore.update)).not.toHaveBeenCalled();
  });

  it("reattaches a stale heartbeat with a live process-group leader when assignment is present", async () => {
    const recoverableHost = {
      ...host,
      handleRecoverableHeartbeatGap: vi.fn().mockResolvedValue(true),
    };

    mockFindStaleHeartbeats.mockResolvedValue([
      {
        taskId: "task-stale",
        heartbeat: {
          processGroupLeaderPid: TEST_PID,
          lastOutputTimestamp: Date.now() - 3 * 60 * 1000,
          heartbeatTimestamp: Date.now() - 3 * 60 * 1000,
        },
      },
    ]);
    mockReadAssignmentAt.mockResolvedValue({
      taskId: "task-stale",
      projectId: "proj-1",
      phase: "coding",
      branchName: "opensprint/task-stale",
      worktreePath: "/tmp/wt",
      promptPath: "/tmp/wt/.opensprint/active/task-stale/prompt.md",
      agentConfig: { type: "cursor", model: "gpt-5", cliCommand: null },
      attempt: 2,
      createdAt: new Date().toISOString(),
    });

    process.kill = mockKill as unknown as typeof process.kill;
    mockKill.mockImplementation((pid: number, signal: number | string) => {
      if (signal === 0 && pid === TEST_PID) return;
      throw new Error("Should not send kill signals for recoverable heartbeat gaps");
    });

    const result = await service.runFullRecovery("proj-1", tmpDir, recoverableHost);

    expect(recoverableHost.handleRecoverableHeartbeatGap).toHaveBeenCalledWith(
      "proj-1",
      tmpDir,
      expect.objectContaining({ id: "task-stale" }),
      expect.objectContaining({ phase: "coding", attempt: 2 })
    );
    expect(result.reattached).toEqual(["task-stale"]);
    expect(result.requeued).toEqual([]);
    expect(vi.mocked(taskStore.update)).not.toHaveBeenCalled();
  });

  it("completes stale-heartbeat tasks when the orphaned assignment already has terminal result.json", async () => {
    const completedHost = {
      ...host,
      handleCompletedAssignment: vi.fn().mockResolvedValue(true),
    };
    const promptDir = path.join(tmpDir, ".opensprint", "active", "task-stale");
    await fs.mkdir(promptDir, { recursive: true });
    await fs.writeFile(
      path.join(promptDir, "result.json"),
      JSON.stringify({ status: "success", summary: "done" }),
      "utf-8"
    );

    mockFindStaleHeartbeats.mockResolvedValue([
      {
        taskId: "task-stale",
        heartbeat: {
          processGroupLeaderPid: TEST_PID,
          lastOutputTimestamp: Date.now() - 3 * 60 * 1000,
          heartbeatTimestamp: Date.now() - 3 * 60 * 1000,
        },
      },
    ]);
    mockReadAssignmentAt.mockResolvedValue({
      taskId: "task-stale",
      projectId: "proj-1",
      phase: "coding",
      branchName: "opensprint/task-stale",
      worktreePath: tmpDir,
      promptPath: path.join(promptDir, "prompt.md"),
      agentConfig: { type: "cursor", model: "gpt-5", cliCommand: null },
      attempt: 2,
      createdAt: new Date().toISOString(),
    });

    process.kill = mockKill as unknown as typeof process.kill;
    mockKill.mockImplementation((_pid: number, signal: number | string) => {
      if (signal === 0) throw new Error("No such process");
      throw new Error("Should not send kill signals for terminal results");
    });

    const result = await service.runFullRecovery("proj-1", tmpDir, completedHost);

    expect(completedHost.handleCompletedAssignment).toHaveBeenCalledWith(
      "proj-1",
      tmpDir,
      expect.objectContaining({ id: "task-stale" }),
      expect.objectContaining({ phase: "coding", attempt: 2 })
    );
    expect(result.reattached).toEqual(["task-stale"]);
    expect(result.requeued).toEqual([]);
    expect(vi.mocked(taskStore.update)).not.toHaveBeenCalled();
  });

  it("completes slotted tasks with terminal result.json during slot reconciliation", async () => {
    const completedHost = {
      getSlottedTaskIds: () => ["task-stale"],
      getActiveAgentIds: () => [] as string[],
      handleCompletedAssignment: vi.fn().mockResolvedValue(true),
      removeStaleSlot: vi.fn().mockResolvedValue(undefined),
    };
    const promptDir = path.join(tmpDir, ".opensprint", "active", "task-stale");
    await fs.mkdir(promptDir, { recursive: true });
    await fs.writeFile(
      path.join(promptDir, "result.json"),
      JSON.stringify({ status: "approved", summary: "done" }),
      "utf-8"
    );

    vi.mocked(taskStore.listAll).mockResolvedValue([
      {
        id: "task-stale",
        status: "in_progress",
        assignee: "Boromir",
      } as never,
    ]);
    mockReadAssignmentAt.mockResolvedValue({
      taskId: "task-stale",
      projectId: "proj-1",
      phase: "review",
      branchName: "opensprint/task-stale",
      worktreePath: tmpDir,
      promptPath: path.join(promptDir, "prompt.md"),
      agentConfig: { type: "cursor", model: "gpt-5", cliCommand: null },
      attempt: 3,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const result = await service.runFullRecovery("proj-1", tmpDir, completedHost);

    expect(completedHost.handleCompletedAssignment).toHaveBeenCalledWith(
      "proj-1",
      tmpDir,
      expect.objectContaining({ id: "task-stale" }),
      expect.objectContaining({ phase: "review", attempt: 3 })
    );
    expect(result.cleaned).toContain("task-stale");
    expect(result.requeued).toEqual([]);
    expect(vi.mocked(taskStore.update)).not.toHaveBeenCalled();
    expect(completedHost.removeStaleSlot).not.toHaveBeenCalled();
  });

  it("keeps very recent slotted tasks during recovery grace window", async () => {
    const graceHost = {
      getSlottedTaskIds: () => ["task-stale"],
      getActiveAgentIds: () => [] as string[],
      removeStaleSlot: vi.fn().mockResolvedValue(undefined),
      handleCompletedAssignment: vi.fn().mockResolvedValue(false),
    };

    vi.mocked(taskStore.listAll).mockResolvedValue([
      {
        id: "task-stale",
        status: "in_progress",
        assignee: "Frodo",
      } as never,
    ]);
    mockReadAssignmentAt.mockResolvedValue({
      taskId: "task-stale",
      projectId: "proj-1",
      phase: "coding",
      branchName: "opensprint/task-stale",
      worktreePath: tmpDir,
      promptPath: path.join(tmpDir, ".opensprint", "active", "task-stale", "prompt.md"),
      agentConfig: { type: "cursor", model: "gpt-5", cliCommand: null },
      attempt: 1,
      createdAt: new Date().toISOString(),
    });

    const result = await service.runFullRecovery("proj-1", tmpDir, graceHost);

    expect(result.cleaned).not.toContain("task-stale");
    expect(graceHost.removeStaleSlot).not.toHaveBeenCalled();
    expect(vi.mocked(taskStore.update)).not.toHaveBeenCalledWith(
      "proj-1",
      "task-stale",
      expect.objectContaining({ status: "open" })
    );
  });

  it("does not recover a slotted task while its agent is still active", async () => {
    const activeHost = {
      getSlottedTaskIds: () => ["task-stale"],
      getActiveAgentIds: () => ["task-stale"],
      removeStaleSlot: vi.fn().mockResolvedValue(undefined),
      handleCompletedAssignment: vi.fn().mockResolvedValue(false),
    };

    vi.mocked(taskStore.listAll).mockResolvedValue([
      {
        id: "task-stale",
        status: "in_progress",
        assignee: "Frodo",
      } as never,
    ]);
    mockReadAssignmentAt.mockResolvedValue({
      taskId: "task-stale",
      projectId: "proj-1",
      phase: "coding",
      branchName: "opensprint/task-stale",
      worktreePath: tmpDir,
      promptPath: path.join(tmpDir, ".opensprint", "active", "task-stale", "prompt.md"),
      agentConfig: { type: "cursor", model: "gpt-5", cliCommand: null },
      attempt: 1,
      createdAt: new Date().toISOString(),
    });

    const result = await service.runFullRecovery("proj-1", tmpDir, activeHost);

    expect(result.cleaned).not.toContain("task-stale");
    expect(activeHost.removeStaleSlot).not.toHaveBeenCalled();
    expect(vi.mocked(taskStore.update)).not.toHaveBeenCalledWith(
      "proj-1",
      "task-stale",
      expect.objectContaining({ status: "open" })
    );
  });

  it("does not recover a slotted task when heartbeat output is fresh but PID is unavailable", async () => {
    const heartbeatGuardHost = {
      getSlottedTaskIds: () => ["task-stale"],
      getActiveAgentIds: () => [] as string[],
      removeStaleSlot: vi.fn().mockResolvedValue(undefined),
      handleCompletedAssignment: vi.fn().mockResolvedValue(false),
    };

    vi.mocked(taskStore.listAll).mockResolvedValue([
      {
        id: "task-stale",
        status: "in_progress",
        assignee: "Ted",
      } as never,
    ]);
    mockReadAssignmentAt.mockResolvedValue({
      taskId: "task-stale",
      projectId: "proj-1",
      phase: "coding",
      branchName: "opensprint/task-stale",
      worktreePath: tmpDir,
      promptPath: path.join(tmpDir, ".opensprint", "active", "task-stale", "prompt.md"),
      agentConfig: { type: "cursor", model: "composer-2", cliCommand: null },
      attempt: 2,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });
    mockReadHeartbeat.mockResolvedValue({
      processGroupLeaderPid: 0,
      lastOutputTimestamp: Date.now(),
      heartbeatTimestamp: Date.now(),
    });

    const result = await service.runFullRecovery("proj-1", tmpDir, heartbeatGuardHost);

    expect(result.cleaned).not.toContain("task-stale");
    expect(heartbeatGuardHost.removeStaleSlot).not.toHaveBeenCalled();
    expect(vi.mocked(taskStore.update)).not.toHaveBeenCalledWith(
      "proj-1",
      "task-stale",
      expect.objectContaining({ status: "open" })
    );
  });

  it("does not recover a slotted task when heartbeat is fresh but output is stale and PID is unavailable", async () => {
    const heartbeatGuardHost = {
      getSlottedTaskIds: () => ["task-stale"],
      getActiveAgentIds: () => [] as string[],
      removeStaleSlot: vi.fn().mockResolvedValue(undefined),
      handleCompletedAssignment: vi.fn().mockResolvedValue(false),
    };

    vi.mocked(taskStore.listAll).mockResolvedValue([
      {
        id: "task-stale",
        status: "in_progress",
        assignee: "Ted",
      } as never,
    ]);
    mockReadAssignmentAt.mockResolvedValue({
      taskId: "task-stale",
      projectId: "proj-1",
      phase: "coding",
      branchName: "opensprint/task-stale",
      worktreePath: tmpDir,
      promptPath: path.join(tmpDir, ".opensprint", "active", "task-stale", "prompt.md"),
      agentConfig: { type: "cursor", model: "composer-2", cliCommand: null },
      attempt: 2,
      createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    mockReadHeartbeat.mockResolvedValue({
      processGroupLeaderPid: 0,
      lastOutputTimestamp: Date.now() - 10 * 60_000,
      heartbeatTimestamp: Date.now() - 10_000,
    });

    const result = await service.runFullRecovery("proj-1", tmpDir, heartbeatGuardHost);

    expect(result.cleaned).not.toContain("task-stale");
    expect(heartbeatGuardHost.removeStaleSlot).not.toHaveBeenCalled();
    expect(vi.mocked(taskStore.update)).not.toHaveBeenCalledWith(
      "proj-1",
      "task-stale",
      expect.objectContaining({ status: "open" })
    );
  });

  it("replays persisted cleanup intents during recovery", async () => {
    mockListCleanupIntents.mockResolvedValue([
      {
        taskId: "task-merged",
        branchName: "opensprint/task-merged",
        worktreePath: "/tmp/wt-merged",
        gitWorkingMode: "worktree",
        worktreeKey: "epic_123",
        createdAt: new Date(Date.now() - 120_000).toISOString(),
        reason: "merge_success",
      },
    ]);

    const result = await service.runFullRecovery("proj-1", tmpDir, host);

    expect(vi.mocked(worktreeLeaseService.forceRelease)).toHaveBeenCalledWith("epic_123");
    expect(mockRemoveTaskWorktree).toHaveBeenCalledWith(tmpDir, "epic_123", "/tmp/wt-merged");
    expect(mockDeleteBranch).toHaveBeenCalledWith(tmpDir, "opensprint/task-merged");
    expect(mockRemoveCleanupIntent).toHaveBeenCalledWith(tmpDir, "proj-1", "task-merged");
    expect(result.cleaned).toContain("cleanup_intent:task-merged");
  });

  it("does not replay cleanup intent when worktree still holds an active task assignment (overlap guard)", async () => {
    const wtHeld = path.join(tmpDir, "wt-held");
    const childTaskId = "child-active-epic";
    const assignDir = path.join(wtHeld, ".opensprint", "active", childTaskId);
    await fs.mkdir(assignDir, { recursive: true });
    await fs.writeFile(
      path.join(assignDir, "assignment.json"),
      JSON.stringify({
        taskId: childTaskId,
        createdAt: new Date(Date.now() - 600_000).toISOString(),
        worktreePath: wtHeld,
        worktreeKey: "epic_overlap",
      }),
      "utf-8"
    );

    mockListCleanupIntents.mockResolvedValue([
      {
        taskId: "task-merged-parent",
        branchName: "opensprint/task-merged-parent",
        worktreePath: wtHeld,
        gitWorkingMode: "worktree",
        worktreeKey: "epic_overlap",
      },
    ]);

    vi.mocked(taskStore.listAll).mockResolvedValue([
      { id: "task-merged-parent", status: "closed" } as never,
    ]);
    vi.mocked(taskStore.show).mockImplementation(async (_pid, tid) => {
      if (tid === childTaskId) return { status: "open" } as never;
      return { id: tid, status: "closed" } as never;
    });

    mockRemoveTaskWorktree.mockClear();

    const result = await service.runFullRecovery("proj-1", tmpDir, host);

    expect(mockRemoveTaskWorktree).not.toHaveBeenCalled();
    expect(mockRemoveCleanupIntent).not.toHaveBeenCalledWith(
      tmpDir,
      "proj-1",
      "task-merged-parent"
    );
    expect(result.cleaned).not.toContain("cleanup_intent:task-merged-parent");
  });

  it("does not replay cleanup intents within post-merge cooldown window", async () => {
    vi.mocked(taskStore.listAll).mockResolvedValue([
      { id: "task-merged", status: "closed" } as never,
    ]);
    mockListCleanupIntents.mockResolvedValue([
      {
        taskId: "task-merged",
        branchName: "opensprint/task-merged",
        worktreePath: "/tmp/wt-merged",
        gitWorkingMode: "worktree",
        worktreeKey: "task-merged",
        createdAt: new Date().toISOString(),
        reason: "merge_success",
      },
    ]);

    const result = await service.runFullRecovery("proj-1", tmpDir, host);

    expect(vi.mocked(worktreeLeaseService.forceRelease)).not.toHaveBeenCalled();
    expect(mockRemoveTaskWorktree).not.toHaveBeenCalledWith(
      tmpDir,
      "task-merged",
      "/tmp/wt-merged"
    );
    expect(result.cleaned).not.toContain("cleanup_intent:task-merged");
  });

  it("does not replay cleanup intents for in-progress tasks", async () => {
    mockListCleanupIntents.mockResolvedValue([
      {
        taskId: "task-in-progress",
        branchName: "opensprint/task-in-progress",
        worktreePath: "/tmp/wt-in-progress",
        gitWorkingMode: "worktree",
        worktreeKey: "task-in-progress",
      },
    ]);
    vi.mocked(taskStore.listAll).mockResolvedValue([
      {
        id: "task-in-progress",
        status: "in_progress",
      } as never,
    ]);

    const result = await service.runFullRecovery("proj-1", tmpDir, host);

    expect(mockRemoveTaskWorktree).not.toHaveBeenCalledWith(
      tmpDir,
      "task-in-progress",
      "/tmp/wt-in-progress"
    );
    expect(mockDeleteBranch).not.toHaveBeenCalledWith(tmpDir, "opensprint/task-in-progress");
    expect(mockRemoveCleanupIntent).not.toHaveBeenCalledWith(tmpDir, "proj-1", "task-in-progress");
    expect(result.cleaned).not.toContain("cleanup_intent:task-in-progress");
  });

  it("cleans stale inactive blocked/open worktrees after TTL", async () => {
    const staleUpdatedAt = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    mockListTaskWorktrees.mockResolvedValue([
      { taskId: "task-blocked", worktreePath: "/tmp/wt-blocked" },
    ]);
    vi.mocked(taskStore.listAll).mockResolvedValue([
      { id: "task-blocked", status: "blocked", updated_at: staleUpdatedAt } as never,
    ]);

    const result = await service.runFullRecovery("proj-1", tmpDir, host);

    expect(mockRemoveTaskWorktree).toHaveBeenCalledWith(tmpDir, "task-blocked", "/tmp/wt-blocked");
    expect(result.cleaned).toContain("stale_inactive_worktree:task-blocked");
  });

  describe("orphaned in_progress tasks (agent assignee, no process)", () => {
    it("resets tasks with agent assignee when no slot or active agent", async () => {
      vi.mocked(taskStore.listInProgressWithAgentAssignee).mockResolvedValue([
        {
          id: "task-orphan",
          project_id: "proj-1",
          title: "Orphan task",
          status: "in_progress",
          assignee: "Frodo",
        } as never,
      ]);

      const result = await service.runFullRecovery("proj-1", tmpDir, host);

      expect(result.requeued).toContain("task-orphan");
      expect(vi.mocked(taskStore.update)).toHaveBeenCalledWith(
        "proj-1",
        "task-orphan",
        expect.objectContaining({ status: "open", assignee: "" })
      );
      expect(vi.mocked(eventLogService.append)).toHaveBeenCalledWith(
        tmpDir,
        expect.objectContaining({
          taskId: "task-orphan",
          event: "recovery.agent_assignee_no_process_reset",
          data: expect.objectContaining({
            assignee: "Frodo",
            reason: "no process for agent assignee",
          }),
        })
      );
      expect(vi.mocked(taskStore.comment)).toHaveBeenCalledWith(
        "proj-1",
        "task-orphan",
        "Watchdog: no running process for agent assignee. Task requeued for next attempt."
      );
    });

    it("does not reset recently updated agent-assigned in-progress tasks within grace window", async () => {
      vi.mocked(taskStore.listInProgressWithAgentAssignee).mockResolvedValue([
        {
          id: "task-just-started-assigned",
          project_id: "proj-1",
          title: "Recently started assigned task",
          status: "in_progress",
          assignee: "Frodo",
          updated_at: new Date().toISOString(),
        } as never,
      ]);

      const result = await service.runFullRecovery("proj-1", tmpDir, host);

      expect(result.requeued).toEqual([]);
      expect(vi.mocked(taskStore.update)).not.toHaveBeenCalledWith(
        "proj-1",
        "task-just-started-assigned",
        expect.objectContaining({ status: "open", assignee: "" })
      );
    });

    it("does not reset tasks that are slotted or have active agent", async () => {
      vi.mocked(taskStore.listInProgressWithAgentAssignee).mockResolvedValue([
        { id: "task-slotted", status: "in_progress", assignee: "Samwise" } as never,
        { id: "task-active", status: "in_progress", assignee: "Merry" } as never,
      ]);

      const hostWithExcludes = {
        getSlottedTaskIds: (projectId: string) => (projectId === "proj-1" ? ["task-slotted"] : []),
        getActiveAgentIds: (projectId: string) => (projectId === "proj-1" ? ["task-active"] : []),
      };

      const result = await service.runFullRecovery("proj-1", tmpDir, hostWithExcludes);

      expect(result.requeued).toEqual([]);
      expect(vi.mocked(taskStore.update)).not.toHaveBeenCalledWith(
        "proj-1",
        "task-slotted",
        expect.any(Object)
      );
      expect(vi.mocked(taskStore.update)).not.toHaveBeenCalledWith(
        "proj-1",
        "task-active",
        expect.any(Object)
      );
    });

    it("does not reset tasks when heartbeat is fresh without PID", async () => {
      vi.mocked(taskStore.listInProgressWithAgentAssignee).mockResolvedValue([
        {
          id: "task-heartbeat-guard",
          project_id: "proj-1",
          title: "Heartbeat guard task",
          status: "in_progress",
          assignee: "Frodo",
          updated_at: new Date().toISOString(),
        } as never,
      ]);
      mockReadHeartbeat.mockResolvedValue({
        processGroupLeaderPid: 0,
        lastOutputTimestamp: Date.now(),
        heartbeatTimestamp: Date.now(),
      });

      const result = await service.runFullRecovery("proj-1", tmpDir, host);

      expect(result.requeued).not.toContain("task-heartbeat-guard");
      expect(vi.mocked(taskStore.update)).not.toHaveBeenCalledWith(
        "proj-1",
        "task-heartbeat-guard",
        expect.objectContaining({ status: "open" })
      );
    });
  });

  describe("assignee-less in_progress tasks", () => {
    it("resets stale in-progress tasks that have no assignee, slot, or active agent", async () => {
      const staleUpdatedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      vi.mocked(taskStore.listInProgressWithoutAssignee).mockResolvedValue([
        {
          id: "task-merge-retry",
          project_id: "proj-1",
          title: "Merge retry task",
          status: "in_progress",
          assignee: "",
          updated_at: staleUpdatedAt,
        } as never,
      ]);

      const result = await service.runFullRecovery("proj-1", tmpDir, host);

      expect(result.requeued).toContain("task-merge-retry");
      expect(vi.mocked(taskStore.update)).toHaveBeenCalledWith(
        "proj-1",
        "task-merge-retry",
        expect.objectContaining({ status: "open", assignee: "" })
      );
      expect(vi.mocked(eventLogService.append)).toHaveBeenCalledWith(
        tmpDir,
        expect.objectContaining({
          taskId: "task-merge-retry",
          event: "recovery.in_progress_without_assignee_reset",
          data: expect.objectContaining({
            reason: "in_progress task had no assignee, slot, or active agent",
            updatedAt: staleUpdatedAt,
          }),
        })
      );
      expect(vi.mocked(taskStore.comment)).toHaveBeenCalledWith(
        "proj-1",
        "task-merge-retry",
        "Watchdog: in-progress task had no assignee or active slot. Task requeued for next attempt."
      );
    });

    it("does not reset recently updated assignee-less in-progress tasks", async () => {
      vi.mocked(taskStore.listInProgressWithoutAssignee).mockResolvedValue([
        {
          id: "task-just-started",
          status: "in_progress",
          assignee: "",
          updated_at: new Date().toISOString(),
        } as never,
      ]);

      const result = await service.runFullRecovery("proj-1", tmpDir, host);

      expect(result.requeued).toEqual([]);
      expect(vi.mocked(taskStore.update)).not.toHaveBeenCalledWith(
        "proj-1",
        "task-just-started",
        expect.any(Object)
      );
    });
  });

  describe("stale assignment telemetry", () => {
    it("emits recovery.stale_assignment event with stale_success reason when terminal result exists", async () => {
      const completedHost = {
        ...host,
        handleCompletedAssignment: vi.fn().mockResolvedValue(true),
      };
      const promptDir = path.join(tmpDir, ".opensprint", "active", "task-done");
      await fs.mkdir(promptDir, { recursive: true });
      await fs.writeFile(
        path.join(promptDir, "result.json"),
        JSON.stringify({ status: "success", summary: "done" }),
        "utf-8"
      );

      const staleCreatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      vi.mocked(taskStore.listAll).mockResolvedValue([
        { id: "task-done", status: "in_progress", assignee: "agent" } as never,
      ]);
      mockFindOrphanedAssignments.mockResolvedValue([
        {
          taskId: "task-done",
          assignment: {
            taskId: "task-done",
            projectId: "proj-1",
            phase: "coding",
            branchName: "opensprint/task-done",
            worktreePath: tmpDir,
            promptPath: path.join(promptDir, "prompt.md"),
            agentConfig: { type: "cursor", model: "gpt-5", cliCommand: null },
            attempt: 3,
            createdAt: staleCreatedAt,
            retryContext: { failureType: "agent_crash" },
          },
        },
      ]);

      await service.runFullRecovery("proj-1", tmpDir, completedHost, { includeGupp: true });

      expect(vi.mocked(eventLogService.append)).toHaveBeenCalledWith(
        tmpDir,
        expect.objectContaining({
          taskId: "task-done",
          event: "recovery.stale_assignment",
          data: expect.objectContaining({
            reason: "stale_success",
            attempt: 3,
            phase: "coding",
            failureType: "agent_crash",
          }),
        })
      );
    });

    it("emits recovery.stale_assignment with pid_dead_requeue reason when no terminal result exists", async () => {
      const guppHost = {
        ...host,
        handleCompletedAssignment: vi.fn().mockResolvedValue(false),
      };
      const staleCreatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      vi.mocked(taskStore.listAll).mockResolvedValue([
        { id: "task-dead", status: "in_progress", assignee: "agent" } as never,
      ]);
      mockFindOrphanedAssignments.mockResolvedValue([
        {
          taskId: "task-dead",
          assignment: {
            taskId: "task-dead",
            projectId: "proj-1",
            phase: "coding",
            branchName: "opensprint/task-dead",
            worktreePath: tmpDir,
            promptPath: path.join(tmpDir, ".opensprint", "active", "task-dead", "prompt.md"),
            agentConfig: { type: "cursor", model: "gpt-5", cliCommand: null },
            attempt: 2,
            createdAt: staleCreatedAt,
          },
        },
      ]);

      await service.runFullRecovery("proj-1", tmpDir, guppHost, { includeGupp: true });

      expect(vi.mocked(eventLogService.append)).toHaveBeenCalledWith(
        tmpDir,
        expect.objectContaining({
          taskId: "task-dead",
          event: "recovery.stale_assignment",
          data: expect.objectContaining({
            reason: "pid_dead_requeue",
            attempt: 2,
            phase: "coding",
            failureType: null,
          }),
        })
      );
    });

    it("completes task via late result.json re-read instead of requeueing (TOCTOU fix)", async () => {
      let callCount = 0;
      const promptDir = path.join(tmpDir, ".opensprint", "active", "task-late");
      await fs.mkdir(promptDir, { recursive: true });

      const guppHost = {
        ...host,
        handleCompletedAssignment: vi.fn().mockResolvedValue(true),
      };

      vi.mocked(taskStore.listAll).mockResolvedValue([
        { id: "task-late", status: "in_progress", assignee: "Gandalf" } as never,
      ]);

      mockFindOrphanedAssignments.mockResolvedValue([
        {
          taskId: "task-late",
          assignment: {
            taskId: "task-late",
            projectId: "proj-1",
            phase: "coding",
            branchName: "opensprint/task-late",
            worktreePath: tmpDir,
            promptPath: path.join(promptDir, "prompt.md"),
            agentConfig: { type: "cursor", model: "gpt-5", cliCommand: null },
            attempt: 1,
            createdAt: new Date().toISOString(),
          },
        },
      ]);

      // Simulate the race: first read returns null, second read finds success
      const originalReadFile = fs.readFile;
      const resultPath = path.join(promptDir, "result.json");
      const spy = vi.spyOn(fs, "readFile").mockImplementation(async (...args: unknown[]) => {
        const filePath = args[0] as string;
        if (filePath === resultPath) {
          callCount++;
          if (callCount === 1) {
            throw new Error("ENOENT");
          }
          return JSON.stringify({ status: "success" });
        }
        return originalReadFile.call(
          fs,
          ...(args as Parameters<typeof originalReadFile>)
        ) as Promise<string>;
      });

      const result = await service.runFullRecovery("proj-1", tmpDir, guppHost, {
        includeGupp: true,
      });

      spy.mockRestore();

      expect(guppHost.handleCompletedAssignment).toHaveBeenCalledWith(
        "proj-1",
        tmpDir,
        expect.objectContaining({ id: "task-late" }),
        expect.objectContaining({ phase: "coding" })
      );
      expect(result.reattached).toEqual(["task-late"]);
      expect(result.requeued).toEqual([]);
      // Should NOT have been requeued
      expect(vi.mocked(taskStore.update)).not.toHaveBeenCalledWith(
        "proj-1",
        "task-late",
        expect.objectContaining({ status: "open" })
      );
    });

    it("requeues when both initial and late result.json reads return null", async () => {
      const promptDir = path.join(tmpDir, ".opensprint", "active", "task-noresult");
      await fs.mkdir(promptDir, { recursive: true });
      // No result.json written at all

      const guppHost = {
        ...host,
        handleCompletedAssignment: vi.fn().mockResolvedValue(false),
      };

      vi.mocked(taskStore.listAll).mockResolvedValue([
        { id: "task-noresult", status: "in_progress", assignee: "Aragorn" } as never,
      ]);

      mockFindOrphanedAssignments.mockResolvedValue([
        {
          taskId: "task-noresult",
          assignment: {
            taskId: "task-noresult",
            projectId: "proj-1",
            phase: "coding",
            branchName: "opensprint/task-noresult",
            worktreePath: tmpDir,
            promptPath: path.join(promptDir, "prompt.md"),
            agentConfig: { type: "cursor", model: "gpt-5", cliCommand: null },
            attempt: 1,
            createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
          },
        },
      ]);

      const result = await service.runFullRecovery("proj-1", tmpDir, guppHost, {
        includeGupp: true,
      });

      expect(result.requeued).toEqual(["task-noresult"]);
      expect(vi.mocked(taskStore.update)).toHaveBeenCalledWith(
        "proj-1",
        "task-noresult",
        expect.objectContaining({ status: "open" })
      );
    });

    it("emits recovery.stale_assignment with task_not_found reason for orphaned assignment", async () => {
      const guppHost = {
        ...host,
        handleCompletedAssignment: vi.fn().mockResolvedValue(false),
      };
      vi.mocked(taskStore.listAll).mockResolvedValue([]);
      mockFindOrphanedAssignments.mockResolvedValue([
        {
          taskId: "task-gone",
          assignment: {
            taskId: "task-gone",
            projectId: "proj-1",
            phase: "coding",
            branchName: "opensprint/task-gone",
            worktreePath: tmpDir,
            promptPath: path.join(tmpDir, ".opensprint", "active", "task-gone", "prompt.md"),
            agentConfig: { type: "cursor", model: "gpt-5", cliCommand: null },
            attempt: 1,
            createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
          },
        },
      ]);

      await service.runFullRecovery("proj-1", tmpDir, guppHost, { includeGupp: true });

      expect(vi.mocked(eventLogService.append)).toHaveBeenCalledWith(
        tmpDir,
        expect.objectContaining({
          taskId: "task-gone",
          event: "recovery.stale_assignment",
          data: expect.objectContaining({
            reason: "task_not_found",
          }),
        })
      );
    });
  });

  describe("worktree lease integration", () => {
    function makeAssignment(taskId: string, worktreePath: string, worktreeKey?: string) {
      return {
        taskId,
        projectId: "proj-1",
        phase: "coding",
        branchName: `opensprint/${taskId}`,
        ...(worktreeKey ? { worktreeKey } : {}),
        worktreePath,
        promptPath: path.join(worktreePath, ".opensprint", "active", taskId, "prompt.md"),
        agentConfig: { type: "cursor", model: "gpt-5", cliCommand: null },
        attempt: 1,
        createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      };
    }

    it("skips worktree removal when active lease exists (canCleanup returns false)", async () => {
      mockCanCleanupLease.mockResolvedValue(false);

      const wtPath = path.join(tmpDir, "worktree-leased");
      await fs.mkdir(wtPath, { recursive: true });
      const assignmentPath = path.join(
        tmpDir,
        ".opensprint",
        "active",
        "task-leased",
        "assignment.json"
      );
      await fs.mkdir(path.dirname(assignmentPath), { recursive: true });
      await fs.writeFile(assignmentPath, JSON.stringify(makeAssignment("task-leased", wtPath)));

      const guppHost = {
        ...host,
        handleCompletedAssignment: vi.fn().mockResolvedValue(false),
      };

      vi.mocked(taskStore.listAll).mockResolvedValue([]);
      mockFindOrphanedAssignments.mockResolvedValue([
        { taskId: "task-leased", assignment: makeAssignment("task-leased", wtPath) },
      ]);

      await service.runFullRecovery("proj-1", tmpDir, guppHost, { includeGupp: true });

      expect(mockCanCleanupLease).toHaveBeenCalledWith("task-leased");
      expect(mockRemoveTaskWorktree).not.toHaveBeenCalled();
      await expect(fs.access(assignmentPath)).resolves.toBeUndefined();
    });

    it("proceeds with worktree removal when lease is released (canCleanup returns true)", async () => {
      mockCanCleanupLease.mockResolvedValue(true);

      const wtPath = path.join(tmpDir, "worktree-released");
      await fs.mkdir(wtPath, { recursive: true });

      const guppHost = {
        ...host,
        handleCompletedAssignment: vi.fn().mockResolvedValue(false),
      };

      vi.mocked(taskStore.listAll).mockResolvedValue([]);
      mockFindOrphanedAssignments.mockResolvedValue([
        { taskId: "task-released", assignment: makeAssignment("task-released", wtPath) },
      ]);

      await service.runFullRecovery("proj-1", tmpDir, guppHost, { includeGupp: true });

      expect(mockCanCleanupLease).toHaveBeenCalledWith("task-released");
      expect(mockRemoveTaskWorktree).toHaveBeenCalledWith(tmpDir, "task-released", wtPath, {
        ignoreLiveTaskStatusForTaskIds: new Set(["task-released"]),
      });
    });

    it("preserves the worktree when lease ownership cannot be checked", async () => {
      mockCanCleanupLease.mockRejectedValue(new Error("DB unavailable"));

      const wtPath = path.join(tmpDir, "worktree-err");
      await fs.mkdir(wtPath, { recursive: true });

      const guppHost = {
        ...host,
        handleCompletedAssignment: vi.fn().mockResolvedValue(false),
      };

      vi.mocked(taskStore.listAll).mockResolvedValue([]);
      mockFindOrphanedAssignments.mockResolvedValue([
        { taskId: "task-err", assignment: makeAssignment("task-err", wtPath) },
      ]);

      await service.runFullRecovery("proj-1", tmpDir, guppHost, { includeGupp: true });

      expect(mockRemoveTaskWorktree).not.toHaveBeenCalled();
    });

    it("checks cleanup lease and removal using assignment worktreeKey for epic worktrees", async () => {
      mockCanCleanupLease.mockResolvedValue(false);

      const wtPath = path.join(tmpDir, "epic_123");
      await fs.mkdir(wtPath, { recursive: true });

      const guppHost = {
        ...host,
        handleCompletedAssignment: vi.fn().mockResolvedValue(false),
      };

      vi.mocked(taskStore.listAll).mockResolvedValue([]);
      mockFindOrphanedAssignments.mockResolvedValue([
        { taskId: "123.1", assignment: makeAssignment("123.1", wtPath, "epic_123") },
      ]);

      await service.runFullRecovery("proj-1", tmpDir, guppHost, { includeGupp: true });

      expect(mockCanCleanupLease).toHaveBeenCalledWith("epic_123");
      expect(mockRemoveTaskWorktree).not.toHaveBeenCalled();
    });

    it("derives epic worktreeKey from path when assignment omits worktreeKey", async () => {
      mockCanCleanupLease.mockResolvedValue(false);

      const wtPath = path.join(tmpDir, "epic_456");
      await fs.mkdir(wtPath, { recursive: true });

      const guppHost = {
        ...host,
        handleCompletedAssignment: vi.fn().mockResolvedValue(false),
      };

      vi.mocked(taskStore.listAll).mockResolvedValue([]);
      mockFindOrphanedAssignments.mockResolvedValue([
        { taskId: "456.2", assignment: makeAssignment("456.2", wtPath) },
      ]);

      await service.runFullRecovery("proj-1", tmpDir, guppHost, { includeGupp: true });

      expect(mockCanCleanupLease).toHaveBeenCalledWith("epic_456");
      expect(mockRemoveTaskWorktree).not.toHaveBeenCalled();
    });
  });

  describe("active-slot exclusion prevents worktree destruction (git_entry_missing fix)", () => {
    function makeAssignment(
      taskId: string,
      worktreePath: string,
      extra?: Partial<Record<string, unknown>>
    ) {
      return {
        taskId,
        projectId: "proj-1",
        phase: "coding" as const,
        branchName: `opensprint/${taskId}`,
        worktreePath,
        promptPath: path.join(worktreePath, ".opensprint", "active", taskId, "prompt.md"),
        agentConfig: { type: "cursor", model: "gpt-5", cliCommand: null },
        attempt: 2,
        createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        ...extra,
      };
    }

    it("does not remove worktree for status_mismatch assignment when task has active slot", async () => {
      const wtPath = path.join(tmpDir, "worktree-active");
      await fs.mkdir(wtPath, { recursive: true });

      const slottedHost = {
        getSlottedTaskIds: () => ["task-active"],
        getActiveAgentIds: () => [] as string[],
        getSlottedWorktreeKeys: () => ["task-active"],
        getSlottedWorktreePaths: () => [wtPath],
        handleCompletedAssignment: vi.fn().mockResolvedValue(false),
      };

      vi.mocked(taskStore.listAll).mockResolvedValue([
        { id: "task-active", status: "open", assignee: "" } as never,
      ]);

      mockFindOrphanedAssignments.mockResolvedValue([
        { taskId: "task-active", assignment: makeAssignment("task-active", wtPath) },
      ]);

      await service.runFullRecovery("proj-1", tmpDir, slottedHost, { includeGupp: true });

      expect(mockRemoveTaskWorktree).not.toHaveBeenCalled();
      expect(vi.mocked(taskStore.update)).not.toHaveBeenCalledWith(
        "proj-1",
        "task-active",
        expect.objectContaining({ status: "open" })
      );
    });

    it("does not remove worktree when worktree key matches active slot even if task status is not in_progress", async () => {
      const wtPath = path.join(tmpDir, "worktree-slotted");
      await fs.mkdir(wtPath, { recursive: true });

      const slottedHost = {
        getSlottedTaskIds: () => ["task-slotted"],
        getActiveAgentIds: () => [] as string[],
        getSlottedWorktreeKeys: () => ["task-slotted"],
        getSlottedWorktreePaths: () => [wtPath],
        handleCompletedAssignment: vi.fn().mockResolvedValue(false),
      };

      vi.mocked(taskStore.listAll).mockResolvedValue([
        { id: "task-slotted", status: "blocked", assignee: "" } as never,
      ]);

      mockFindOrphanedAssignments.mockResolvedValue([
        { taskId: "task-slotted", assignment: makeAssignment("task-slotted", wtPath) },
      ]);

      await service.runFullRecovery("proj-1", tmpDir, slottedHost, { includeGupp: true });

      expect(mockRemoveTaskWorktree).not.toHaveBeenCalled();
    });

    it("does not remove worktree when worktree path matches active slot path", async () => {
      const wtPath = path.join(tmpDir, "worktree-path-match");
      await fs.mkdir(wtPath, { recursive: true });

      const pathMatchHost = {
        getSlottedTaskIds: () => [] as string[],
        getActiveAgentIds: () => [] as string[],
        getSlottedWorktreeKeys: () => [] as string[],
        getSlottedWorktreePaths: () => [wtPath],
        handleCompletedAssignment: vi.fn().mockResolvedValue(false),
      };

      vi.mocked(taskStore.listAll).mockResolvedValue([
        { id: "task-path", status: "open", assignee: "" } as never,
      ]);

      mockFindOrphanedAssignments.mockResolvedValue([
        { taskId: "task-path", assignment: makeAssignment("task-path", wtPath) },
      ]);

      await service.runFullRecovery("proj-1", tmpDir, pathMatchHost, { includeGupp: true });

      expect(mockRemoveTaskWorktree).not.toHaveBeenCalled();
    });

    it("still cleans up non-slotted stale assignments normally", async () => {
      mockCanCleanupLease.mockResolvedValue(true);
      const wtPath = path.join(tmpDir, "worktree-stale");
      await fs.mkdir(wtPath, { recursive: true });

      const mixedHost = {
        getSlottedTaskIds: () => ["task-active"],
        getActiveAgentIds: () => [] as string[],
        getSlottedWorktreeKeys: () => ["task-active"],
        getSlottedWorktreePaths: () => [path.join(tmpDir, "worktree-active")],
        handleCompletedAssignment: vi.fn().mockResolvedValue(false),
      };

      vi.mocked(taskStore.listAll).mockResolvedValue([
        { id: "task-stale-gone", status: "open", assignee: "" } as never,
      ]);

      mockFindOrphanedAssignments.mockResolvedValue([
        { taskId: "task-stale-gone", assignment: makeAssignment("task-stale-gone", wtPath) },
      ]);

      await service.runFullRecovery("proj-1", tmpDir, mixedHost, { includeGupp: true });

      expect(mockRemoveTaskWorktree).toHaveBeenCalledWith(tmpDir, "task-stale-gone", wtPath, {
        ignoreLiveTaskStatusForTaskIds: new Set(["task-stale-gone"]),
      });
    });

    it("skips cleanup for activeAgentIds even without explicit slot", async () => {
      const wtPath = path.join(tmpDir, "worktree-agent");
      await fs.mkdir(wtPath, { recursive: true });

      const agentHost = {
        getSlottedTaskIds: () => [] as string[],
        getActiveAgentIds: () => ["task-agent-active"],
        handleCompletedAssignment: vi.fn().mockResolvedValue(false),
      };

      vi.mocked(taskStore.listAll).mockResolvedValue([
        { id: "task-agent-active", status: "in_progress", assignee: "Gandalf" } as never,
      ]);

      mockFindOrphanedAssignments.mockResolvedValue([
        { taskId: "task-agent-active", assignment: makeAssignment("task-agent-active", wtPath) },
      ]);

      await service.runFullRecovery("proj-1", tmpDir, agentHost, { includeGupp: true });

      expect(mockRemoveTaskWorktree).not.toHaveBeenCalled();
    });

    it("propagates reattached shared epic worktree key/path to prune exclusion sets", async () => {
      const epicWtPath = path.join(tmpDir, "epic_shared");
      await fs.mkdir(epicWtPath, { recursive: true });

      const reattachHost = {
        getSlottedTaskIds: () => [] as string[],
        getActiveAgentIds: () => [] as string[],
        reattachSlot: vi.fn().mockResolvedValue(true),
        handleCompletedAssignment: vi.fn().mockResolvedValue(false),
      };

      vi.mocked(taskStore.listAll).mockResolvedValue([
        { id: "task-epic-child", status: "in_progress", assignee: "Agent" } as never,
      ]);

      mockReadHeartbeat.mockResolvedValue({
        processGroupLeaderPid: TEST_PID,
        heartbeatTimestamp: Date.now(),
        lastOutputTimestamp: Date.now(),
      });
      process.kill = ((pid: number, sig?: number | string) => {
        if (pid === TEST_PID && (sig === 0 || sig === undefined)) return true;
        return originalKill.call(process, pid, sig);
      }) as typeof process.kill;

      mockFindOrphanedAssignments.mockResolvedValue([
        {
          taskId: "task-epic-child",
          assignment: makeAssignment("task-epic-child", epicWtPath, {
            worktreeKey: "epic_shared",
          }),
        },
      ]);

      await service.runFullRecovery("proj-1", tmpDir, reattachHost, { includeGupp: true });

      expect(reattachHost.reattachSlot).toHaveBeenCalled();
      expect(mockPruneOrphanWorktrees).toHaveBeenCalledWith(
        tmpDir,
        "proj-1",
        expect.any(Set),
        expect.objectContaining({ has: expect.any(Function) }),
        expect.objectContaining({ has: expect.any(Function) }),
        expect.anything()
      );

      const pruneCall = mockPruneOrphanWorktrees.mock.calls[0];
      const pruneExcludeKeys: Set<string> = pruneCall[3];
      const pruneExcludePaths: Set<string> = pruneCall[4];
      expect(pruneExcludeKeys.has("epic_shared")).toBe(true);
      expect(pruneExcludePaths.has(path.resolve(epicWtPath))).toBe(true);
    });

    it("propagates requeued shared epic worktree key/path to prune exclusion sets", async () => {
      mockCanCleanupLease.mockResolvedValue(false);

      const epicWtPath = path.join(tmpDir, "epic_requeue_shared");
      await fs.mkdir(epicWtPath, { recursive: true });

      const requeueHost = {
        getSlottedTaskIds: () => [] as string[],
        getActiveAgentIds: () => [] as string[],
        handleCompletedAssignment: vi.fn().mockResolvedValue(false),
      };

      vi.mocked(taskStore.listAll).mockResolvedValue([
        { id: "task-epic-requeue", status: "in_progress", assignee: "Agent" } as never,
      ]);

      mockReadHeartbeat.mockResolvedValue(null);
      mockFindOrphanedAssignments.mockResolvedValue([
        {
          taskId: "task-epic-requeue",
          assignment: makeAssignment("task-epic-requeue", epicWtPath, {
            worktreeKey: "epic_requeue_shared",
          }),
        },
      ]);

      await service.runFullRecovery("proj-1", tmpDir, requeueHost, { includeGupp: true });

      expect(vi.mocked(taskStore.update)).toHaveBeenCalledWith(
        "proj-1",
        "task-epic-requeue",
        expect.objectContaining({ status: "open", assignee: "" })
      );
      expect(mockPruneOrphanWorktrees).toHaveBeenCalledWith(
        tmpDir,
        "proj-1",
        expect.any(Set),
        expect.objectContaining({ has: expect.any(Function) }),
        expect.objectContaining({ has: expect.any(Function) }),
        expect.anything()
      );

      const pruneCall = mockPruneOrphanWorktrees.mock.calls[0];
      const pruneExcludeKeys: Set<string> = pruneCall[3];
      const pruneExcludePaths: Set<string> = pruneCall[4];
      expect(pruneExcludeKeys.has("epic_requeue_shared")).toBe(true);
      expect(pruneExcludePaths.has(path.resolve(epicWtPath))).toBe(true);
    });
  });

  describe("overlapping assign/cleanup stress (git_entry_missing guard)", () => {
    it("does not replay cleanup intent when only fresh on-disk assignments exist (no slot yet) under worktree base", async () => {
      const base = path.join(os.tmpdir(), "opensprint-worktrees");
      const wtKey = `stress-gap-${Date.now()}`;
      const wtPath = path.join(base, wtKey);
      try {
        await fs.mkdir(path.join(wtPath, ".opensprint", "active", "task-live"), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(wtPath, ".opensprint", "active", "task-live", "assignment.json"),
          JSON.stringify({
            taskId: "task-live",
            createdAt: new Date().toISOString(),
            worktreePath: wtPath,
            worktreeKey: wtKey,
          }),
          "utf-8"
        );

        const hostNoSlots = {
          getSlottedTaskIds: () => [] as string[],
          getActiveAgentIds: () => [] as string[],
        };

        mockListCleanupIntents.mockResolvedValue([
          {
            taskId: "task-merged-old",
            branchName: "opensprint/task-merged-old",
            worktreePath: wtPath,
            gitWorkingMode: "worktree",
            worktreeKey: wtKey,
          },
        ]);

        vi.mocked(taskStore.listAll).mockResolvedValue([
          { id: "task-live", status: "in_progress" } as never,
          { id: "task-merged-old", status: "closed" } as never,
        ]);
        vi.mocked(taskStore.show).mockImplementation(async (_p, id) => {
          if (id === "task-live") return { status: "in_progress" } as never;
          return { status: "closed" } as never;
        });

        mockRemoveTaskWorktree.mockClear();
        const result = await service.runFullRecovery("proj-1", tmpDir, hostNoSlots);

        expect(mockRemoveTaskWorktree).not.toHaveBeenCalled();
        expect(result.cleaned).not.toContain("cleanup_intent:task-merged-old");
      } finally {
        await fs.rm(wtPath, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("records zero forbidden-delete regressions when active slot blocks intent replay (metrics field)", async () => {
      const wtHeld = path.join(tmpDir, "wt-slot-stress");
      await fs.mkdir(path.join(wtHeld, ".opensprint", "active", "child-slot"), { recursive: true });
      await fs.writeFile(
        path.join(wtHeld, ".opensprint", "active", "child-slot", "assignment.json"),
        JSON.stringify({
          taskId: "child-slot",
          createdAt: new Date(Date.now() - 60_000).toISOString(),
          worktreePath: wtHeld,
          worktreeKey: "epic_slot_stress",
        }),
        "utf-8"
      );

      mockListCleanupIntents.mockResolvedValue([
        {
          taskId: "parent-merged",
          branchName: "opensprint/parent-merged",
          worktreePath: wtHeld,
          gitWorkingMode: "worktree",
          worktreeKey: "epic_slot_stress",
        },
      ]);

      // Omit worktree key/path from slot exclusions so replay reaches on-disk protection
      // (mirrors races where the slot holder path is not yet mirrored into exclude sets).
      const slottedHost = {
        getSlottedTaskIds: () => ["child-slot"],
        getActiveAgentIds: () => [] as string[],
        getSlottedWorktreeKeys: () => [] as string[],
        getSlottedWorktreePaths: () => [] as string[],
      };

      vi.mocked(taskStore.listAll).mockResolvedValue([
        { id: "parent-merged", status: "closed" } as never,
      ]);
      vi.mocked(taskStore.show).mockImplementation(async (_p, tid) => {
        if (tid === "child-slot") return { status: "in_progress" } as never;
        return { status: "closed" } as never;
      });

      const blockedSpy = vi.spyOn(worktreeHealth, "logWorktreeCleanupBlocked");

      mockRemoveTaskWorktree.mockClear();
      mockDeleteBranch.mockClear();
      await service.runFullRecovery("proj-1", tmpDir, slottedHost);
      expect(mockRemoveTaskWorktree).not.toHaveBeenCalled();
      expect(mockDeleteBranch).not.toHaveBeenCalled();
      expect(blockedSpy).toHaveBeenCalledTimes(1);
      expect(blockedSpy).toHaveBeenCalledWith(
        "replay_cleanup_intent",
        expect.objectContaining({
          projectId: "proj-1",
          cleanupTrigger: "recovery_replay",
          reason: expect.stringMatching(/active_task/),
        })
      );
      blockedSpy.mockRestore();
    });
  });
});
