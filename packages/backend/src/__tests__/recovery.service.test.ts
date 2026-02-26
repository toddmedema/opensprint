import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { RecoveryService } from "../services/recovery.service.js";

const TEST_PID = 99999;
const mockFindStaleHeartbeats = vi.fn();
const mockKill = vi.fn();

vi.mock("../services/heartbeat.service.js", () => ({
  heartbeatService: {
    findStaleHeartbeats: (...args: unknown[]) => mockFindStaleHeartbeats(...args),
    readHeartbeat: vi.fn().mockResolvedValue(null),
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
    findOrphanedAssignments: vi.fn().mockResolvedValue([]),
    findOrphanedAssignmentsFromWorktrees: vi.fn().mockResolvedValue([]),
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
    getWorktreePath: vi.fn().mockImplementation((taskId: string) =>
      path.join(os.tmpdir(), "opensprint-worktrees", taskId)
    ),
    commitWip: vi.fn().mockResolvedValue(undefined),
    listTaskWorktrees: vi.fn().mockResolvedValue([]),
    removeTaskWorktree: vi.fn().mockResolvedValue(undefined),
    pruneOrphanWorktrees: vi.fn().mockResolvedValue([]),
  })),
}));

import { taskStore } from "../services/task-store.service.js";

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

  it("terminates orphaned agent process before recovering task when heartbeat.pid is alive", async () => {
    const worktreeBase = path.join(os.tmpdir(), "opensprint-worktrees");
    mockFindStaleHeartbeats.mockResolvedValue([
      {
        taskId: "task-stale",
        heartbeat: {
          pid: TEST_PID,
          lastOutputTimestamp: 0,
          heartbeatTimestamp: Date.now() - 3 * 60 * 1000,
        },
      },
    ]);

    // process.kill(pid, 0) = alive; process.kill(pid, 'SIGTERM') = ok
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
    expect(sigtermCalls).toContainEqual([TEST_PID, "SIGTERM"]);
    expect(vi.mocked(taskStore.update)).toHaveBeenCalledWith(
      "proj-1",
      "task-stale",
      expect.objectContaining({ status: "open" })
    );
  });

  it("does not call process.kill when heartbeat.pid is missing or invalid", async () => {
    mockFindStaleHeartbeats.mockResolvedValue([
      {
        taskId: "task-stale",
        heartbeat: {
          pid: undefined,
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

  it("does not call SIGTERM when process is already dead (isPidAlive returns false)", async () => {
    mockFindStaleHeartbeats.mockResolvedValue([
      {
        taskId: "task-stale",
        heartbeat: {
          pid: TEST_PID,
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
});
