import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { OrphanRecoveryService } from "../services/orphan-recovery.service.js";
import { resetLogLevelCache } from "../utils/logger.js";

const execAsync = promisify(exec);

// Mock ProjectService so getProjectByRepoPath returns a project for any path (tests use temp dirs not in index)
let mockGitWorkingMode: "worktree" | "branches" = "worktree";
vi.mock("../services/project.service.js", () => ({
  ProjectService: vi.fn().mockImplementation(() => ({
    getProjectByRepoPath: vi
      .fn()
      .mockImplementation((repoPath: string) => Promise.resolve({ id: "test-proj", repoPath })),
    getSettings: vi
      .fn()
      .mockImplementation(() => Promise.resolve({ gitWorkingMode: mockGitWorkingMode })),
  })),
}));

// Mock TaskStoreService
let mockListInProgress: { id: string; status: string; assignee: string }[] = [];
let mockUpdateCalls: Array<{ id: string; status: string; assignee: string }> = [];
let mockShowResult: { id: string; status: string } | null = null;

vi.mock("../services/task-store.service.js", () => {
  const mockInstance = {
    listInProgressWithAgentAssignee: vi
      .fn()
      .mockImplementation(() => Promise.resolve(mockListInProgress)),
    show: vi.fn().mockImplementation(async (_repo: string, id: string) => {
      if (mockShowResult && mockShowResult.id === id) return mockShowResult;
      throw new Error("Task not found");
    }),
    update: vi
      .fn()
      .mockImplementation(
        async (_repo: string, id: string, opts: { status?: string; assignee?: string }) => {
          mockUpdateCalls.push({ id, status: opts.status ?? "", assignee: opts.assignee ?? "" });
          return { id, status: opts.status ?? "open", assignee: opts.assignee ?? "" };
        }
      ),
    sync: vi.fn().mockResolvedValue(undefined),
  };
  return {
    TaskStoreService: vi.fn().mockImplementation(() => mockInstance),
    taskStore: mockInstance,
  };
});

describe("OrphanRecoveryService", () => {
  let service: OrphanRecoveryService;
  let repoPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGitWorkingMode = "worktree";
    service = new OrphanRecoveryService();
    repoPath = path.join(os.tmpdir(), `orphan-recovery-test-${Date.now()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await execAsync("git init", { cwd: repoPath });
    await execAsync("git branch -M main", { cwd: repoPath });
    await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
    await execAsync('git config user.name "Test"', { cwd: repoPath });
    // Need an initial commit for worktree operations
    await fs.writeFile(path.join(repoPath, "README.md"), "test");
    await execAsync('git add -A && git commit -m "init"', { cwd: repoPath });
    mockListInProgress = [];
    mockUpdateCalls = [];
    mockShowResult = null;
  });

  afterEach(async () => {
    try {
      // Clean up any worktrees
      await execAsync("git worktree prune", { cwd: repoPath }).catch(() => {});
      await fs.rm(repoPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("should recover orphaned tasks and reset to open without checkout", async () => {
    mockListInProgress = [{ id: "task-orphan-1", status: "in_progress", assignee: "Frodo" }];

    const { recovered } = await service.recoverOrphanedTasks(repoPath);

    expect(recovered).toEqual(["task-orphan-1"]);
    expect(mockUpdateCalls).toHaveLength(1);
    expect(mockUpdateCalls[0]).toMatchObject({
      id: "task-orphan-1",
      status: "open",
      assignee: "",
    });

    // Verify we're still on main (no checkout occurred)
    const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: repoPath });
    expect(stdout.trim()).toBe("main");
  });

  it("should exclude task when excludeTaskId is provided as string", async () => {
    mockListInProgress = [
      { id: "task-a", status: "in_progress", assignee: "Frodo" },
      { id: "task-b", status: "in_progress", assignee: "Frodo" },
    ];

    const { recovered } = await service.recoverOrphanedTasks(repoPath, "task-a");

    expect(recovered).toEqual(["task-b"]);
    expect(mockUpdateCalls).toHaveLength(1);
    expect(mockUpdateCalls[0].id).toBe("task-b");
  });

  it("should exclude multiple tasks when excludeTaskIds is provided as array", async () => {
    mockListInProgress = [
      { id: "task-a", status: "in_progress", assignee: "Frodo" },
      { id: "task-b", status: "in_progress", assignee: "Frodo" },
      { id: "task-c", status: "in_progress", assignee: "Frodo" },
    ];

    const { recovered } = await service.recoverOrphanedTasks(repoPath, ["task-a", "task-c"]);

    expect(recovered).toEqual(["task-b"]);
    expect(mockUpdateCalls).toHaveLength(1);
    expect(mockUpdateCalls[0].id).toBe("task-b");
  });

  it("should return empty when no orphaned tasks", async () => {
    mockListInProgress = [];

    const { recovered } = await service.recoverOrphanedTasks(repoPath);

    expect(recovered).toEqual([]);
    expect(mockUpdateCalls).toHaveLength(0);
  });

  it("should clean up stale worktrees during recovery", async () => {
    const taskId = `task-wt-${Date.now()}`;
    const wtPath = path.join(os.tmpdir(), "opensprint-worktrees", taskId);

    // Remove any stale worktree from previous runs
    try {
      await execAsync(`git worktree remove -f ${wtPath}`, { cwd: repoPath });
    } catch {
      /* ignore */
    }

    // Create a branch and worktree to simulate an abandoned agent
    await execAsync(`git branch opensprint/${taskId} main`, { cwd: repoPath });
    await fs.mkdir(path.dirname(wtPath), { recursive: true });
    await execAsync(`git worktree add ${wtPath} opensprint/${taskId}`, { cwd: repoPath });

    mockListInProgress = [{ id: taskId, status: "in_progress", assignee: "Frodo" }];

    const { recovered } = await service.recoverOrphanedTasks(repoPath);

    expect(recovered).toContain(taskId);

    // Verify worktree was cleaned up
    try {
      await fs.access(wtPath);
      // If we get here, the directory still exists — fail
      expect.fail("Worktree directory should have been removed");
    } catch {
      // Expected: worktree directory removed
    }

    // Verify we're still on main
    const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: repoPath });
    expect(stdout.trim()).toBe("main");

    // Clean up
    await execAsync(`git branch -D opensprint/${taskId}`, { cwd: repoPath }).catch(() => {});
  });

  it("should skip removeTaskWorktree when gitWorkingMode is branches", async () => {
    mockGitWorkingMode = "branches";
    mockListInProgress = [{ id: "task-branches-1", status: "in_progress", assignee: "Frodo" }];

    const { recovered } = await service.recoverOrphanedTasks(repoPath);

    expect(recovered).toEqual(["task-branches-1"]);
    expect(mockUpdateCalls).toHaveLength(1);
    expect(mockUpdateCalls[0]).toMatchObject({
      id: "task-branches-1",
      status: "open",
      assignee: "",
    });
    // In Branches mode we use repoPath for commitWip and skip removeTaskWorktree
    // (no worktree was created). Main repo stays on whatever branch it was.
  });

  it("should log warning when recovering orphaned tasks", async () => {
    const originalLogLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "warn";
    resetLogLevelCache();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockListInProgress = [{ id: "task-1", status: "in_progress", assignee: "Frodo" }];

    await service.recoverOrphanedTasks(repoPath);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Recovered orphaned tasks"));
    warnSpy.mockRestore();
    process.env.LOG_LEVEL = originalLogLevel;
    resetLogLevelCache();
  });

  it("should commit uncommitted changes as WIP before removing worktree", async () => {
    const taskId = `task-wip-${Date.now()}`;
    const wtPath = path.join(os.tmpdir(), "opensprint-worktrees", taskId);

    // Remove any stale worktree from previous runs
    try {
      await execAsync(`git worktree remove -f ${wtPath}`, { cwd: repoPath });
    } catch {
      /* ignore */
    }

    // Create branch and worktree with uncommitted changes
    await execAsync(`git branch opensprint/${taskId} main`, { cwd: repoPath });
    await fs.mkdir(path.dirname(wtPath), { recursive: true });
    await execAsync(`git worktree add ${wtPath} opensprint/${taskId}`, { cwd: repoPath });
    await fs.writeFile(path.join(wtPath, "orphan-wip.txt"), "uncommitted work");
    // Do NOT commit — simulate agent killed mid-edit

    mockListInProgress = [{ id: taskId, status: "in_progress", assignee: "Frodo" }];

    const { recovered } = await service.recoverOrphanedTasks(repoPath);

    expect(recovered).toContain(taskId);

    // Verify WIP was committed: branch should have the file committed
    const { stdout } = await execAsync(`git log -1 --oneline opensprint/${taskId}`, {
      cwd: repoPath,
    });
    expect(stdout).toContain("WIP");
    const { stdout: fileContent } = await execAsync(
      `git show opensprint/${taskId}:orphan-wip.txt`,
      { cwd: repoPath }
    );
    expect(fileContent.trim()).toBe("uncommitted work");

    // Clean up
    await execAsync(`git worktree prune`, { cwd: repoPath }).catch(() => {});
    await execAsync(`git branch -D opensprint/${taskId}`, { cwd: repoPath }).catch(() => {});
  });

  describe("recoverFromStaleHeartbeats", () => {
    it("recovers tasks with stale heartbeat files", async () => {
      const taskId = "task-stale-hb";
      const worktreeBase = path.join(os.tmpdir(), "opensprint-worktrees");
      const wtPath = path.join(worktreeBase, taskId);

      await execAsync(`git branch opensprint/${taskId} main`, { cwd: repoPath });
      await fs.mkdir(path.dirname(wtPath), { recursive: true });
      await execAsync(`git worktree add ${wtPath} opensprint/${taskId}`, { cwd: repoPath });
      await fs.mkdir(path.join(wtPath, ".opensprint", "active", taskId), { recursive: true });
      await fs.writeFile(
        path.join(wtPath, ".opensprint", "active", taskId, "heartbeat.json"),
        JSON.stringify({
          processGroupLeaderPid: 12345,
          lastOutputTimestamp: 0,
          heartbeatTimestamp: Date.now() - 3 * 60 * 1000, // 3 min ago
        })
      );

      mockShowResult = { id: taskId, status: "in_progress" };

      const { recovered } = await service.recoverFromStaleHeartbeats(repoPath);

      expect(recovered).toContain(taskId);
      expect(mockUpdateCalls.some((c) => c.id === taskId && c.status === "open")).toBe(true);

      await execAsync(`git worktree remove ${wtPath} --force`, { cwd: repoPath }).catch(() => {});
      await execAsync(`git branch -D opensprint/${taskId}`, { cwd: repoPath }).catch(() => {});
    });

    it("excludes task when excludeTaskId is provided", async () => {
      const taskId = "task-exclude";
      const worktreeBase = path.join(os.tmpdir(), "opensprint-worktrees");
      const wtPath = path.join(worktreeBase, taskId);

      await execAsync(`git branch opensprint/${taskId} main`, { cwd: repoPath });
      await fs.mkdir(path.dirname(wtPath), { recursive: true });
      await execAsync(`git worktree add ${wtPath} opensprint/${taskId}`, { cwd: repoPath });
      await fs.mkdir(path.join(wtPath, ".opensprint", "active", taskId), { recursive: true });
      await fs.writeFile(
        path.join(wtPath, ".opensprint", "active", taskId, "heartbeat.json"),
        JSON.stringify({
          processGroupLeaderPid: 1,
          lastOutputTimestamp: 0,
          heartbeatTimestamp: Date.now() - 3 * 60 * 1000,
        })
      );

      mockShowResult = { id: taskId, status: "in_progress" };

      const { recovered } = await service.recoverFromStaleHeartbeats(repoPath, taskId);

      expect(recovered).not.toContain(taskId);

      await execAsync(`git worktree remove ${wtPath} --force`, { cwd: repoPath }).catch(() => {});
      await execAsync(`git branch -D opensprint/${taskId}`, { cwd: repoPath }).catch(() => {});
    });
  });
});
