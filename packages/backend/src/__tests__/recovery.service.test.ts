import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { RecoveryService } from "../services/recovery.service.js";

const TEST_PID = 99999;
const mockFindStaleHeartbeats = vi.fn();
const mockKill = vi.fn();
const mockReadHeartbeat = vi.fn();
const mockFindOrphanedAssignments = vi.fn();
const mockFindOrphanedAssignmentsFromWorktrees = vi.fn();
const mockReadAssignmentAt = vi.fn();

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
    listAll: vi.fn().mockResolvedValue([]),
    listInProgressWithAgentAssignee: vi.fn().mockResolvedValue([]),
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

vi.mock("../services/branch-manager.js", () => ({
  BranchManager: vi.fn().mockImplementation(() => ({
    getWorktreeBasePath: vi.fn().mockReturnValue(path.join(os.tmpdir(), "opensprint-worktrees")),
    getWorktreePath: vi
      .fn()
      .mockImplementation((taskId: string) =>
        path.join(os.tmpdir(), "opensprint-worktrees", taskId)
      ),
    commitWip: vi.fn().mockResolvedValue(undefined),
    listTaskWorktrees: vi.fn().mockResolvedValue([]),
    removeTaskWorktree: vi.fn().mockResolvedValue(undefined),
    pruneOrphanWorktrees: vi.fn().mockResolvedValue([]),
  })),
}));

import { taskStore } from "../services/task-store.service.js";
import { eventLogService } from "../services/event-log.service.js";

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

  it("terminates orphaned agent process group before recovering task when the leader is alive", async () => {
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

    vi.useFakeTimers();
    const runPromise = service.runFullRecovery("proj-1", tmpDir, host);
    await vi.advanceTimersByTimeAsync(2500); // advance past SIGTERM wait
    await runPromise;

    const sigtermCalls = mockKill.mock.calls.filter((c) => c[1] === "SIGTERM");
    expect(sigtermCalls).toContainEqual([-TEST_PID, "SIGTERM"]);
    expect(vi.mocked(taskStore.update)).toHaveBeenCalledWith(
      "proj-1",
      "task-stale",
      expect.objectContaining({ status: "open" })
    );
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
  });
});
