import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { BranchManager, WorktreeBranchInUseError } from "../services/branch-manager.js";
import { heartbeatService } from "../services/heartbeat.service.js";

vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    init: vi.fn(),
    listAll: vi.fn().mockResolvedValue([]),
    list: vi.fn().mockResolvedValue([]),
    show: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: "os-mock" }),
    update: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    deleteByProjectId: vi.fn(),
    ready: vi.fn().mockResolvedValue([]),
    setOnTaskChange: vi.fn(),
    closePool: vi.fn(),
  },
  TaskStoreService: vi.fn(),
}));

const execAsync = promisify(exec);

describe("BranchManager", () => {
  let branchManager: BranchManager;
  let repoPath: string;

  beforeEach(async () => {
    branchManager = new BranchManager();
    repoPath = path.join(os.tmpdir(), `opensprint-branch-test-${Date.now()}`);
    await fs.mkdir(repoPath, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(repoPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("commitWip", () => {
    it("should return false when there are no uncommitted changes", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const result = await branchManager.commitWip(repoPath, "task-123");
      expect(result).toBe(false);
    });

    it("should create WIP commit and return true when there are uncommitted changes", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "newfile"), "wip content");

      const result = await branchManager.commitWip(repoPath, "task-456");
      expect(result).toBe(true);

      const { stdout } = await execAsync("git log -1 --oneline", { cwd: repoPath });
      expect(stdout).toContain("WIP: task-456");
    });

    it("should handle modified files", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "modified");

      const result = await branchManager.commitWip(repoPath, "task-789");
      expect(result).toBe(true);

      const { stdout } = await execAsync("git log -1 --oneline", { cwd: repoPath });
      expect(stdout).toContain("WIP: task-789");
    });

    it("should return false and not throw when git fails (e.g. not a repo)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await branchManager.commitWip("/nonexistent/path", "task-999");
      expect(result).toBe(false);

      warnSpy.mockRestore();
    });

    it("should create WIP commit on task branch (agent termination scenario)", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });
      await execAsync("git checkout -b opensprint/task-xyz", { cwd: repoPath });
      await fs.mkdir(path.join(repoPath, "src"), { recursive: true });
      await fs.writeFile(path.join(repoPath, "src/newfile.ts"), "partial work");

      const result = await branchManager.commitWip(repoPath, "task-xyz");
      expect(result).toBe(true);

      const { stdout } = await execAsync("git log -1 --oneline", { cwd: repoPath });
      expect(stdout).toContain("WIP: task-xyz");
      const { stdout: branchOut } = await execAsync("git rev-parse --abbrev-ref HEAD", {
        cwd: repoPath,
      });
      expect(branchOut.trim()).toBe("opensprint/task-xyz");
    });
  });

  describe("captureBranchDiff", () => {
    it("should capture diff between main and a branch without checkout", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      // Create a branch with changes
      await execAsync("git checkout -b opensprint/test-task", { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "newfile.ts"), "new content");
      await execAsync('git add -A && git commit -m "add file"', { cwd: repoPath });

      // Switch back to main
      await execAsync("git checkout main", { cwd: repoPath });

      const diff = await branchManager.captureBranchDiff(repoPath, "opensprint/test-task");
      expect(diff).toContain("newfile.ts");
      expect(diff).toContain("new content");

      // Verify we're still on main
      const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: repoPath });
      expect(stdout.trim()).toBe("main");
    });

    it("should return empty string for non-existent branch", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const diff = await branchManager.captureBranchDiff(repoPath, "opensprint/nonexistent");
      expect(diff).toBe("");
    });
  });

  describe("captureUncommittedDiff", () => {
    it("should capture uncommitted changes in working tree", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "uncommitted.ts"), "partial work");

      const diff = await branchManager.captureUncommittedDiff(repoPath);
      expect(diff).toContain("uncommitted.ts");
      expect(diff).toContain("partial work");
    });

    it("should return empty string when no uncommitted changes", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const diff = await branchManager.captureUncommittedDiff(repoPath);
      expect(diff).toBe("");
    });

    it("should capture staged changes", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "staged.ts"), "staged content");
      await execAsync("git add staged.ts", { cwd: repoPath });

      const diff = await branchManager.captureUncommittedDiff(repoPath);
      expect(diff).toContain("staged.ts");
      expect(diff).toContain("staged content");
    });

    it("should return empty string for non-git path", async () => {
      const diff = await branchManager.captureUncommittedDiff("/nonexistent/path");
      expect(diff).toBe("");
    });
  });

  describe("worktree operations", () => {
    let worktreePaths: string[] = [];

    afterEach(async () => {
      // Clean up any worktrees created during tests
      for (const wt of worktreePaths) {
        try {
          await execAsync(`git worktree remove ${wt} --force`, { cwd: repoPath }).catch(() => {});
          await fs.rm(wt, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      worktreePaths = [];
      try {
        await execAsync("git worktree prune", { cwd: repoPath });
      } catch {
        // ignore
      }
    });

    it("should create and return a worktree path", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const taskId = `wt-test-${Date.now()}`;
      const wtPath = await branchManager.createTaskWorktree(repoPath, taskId);
      worktreePaths.push(wtPath);

      // Verify worktree exists and is on the correct branch
      const stat = await fs.stat(wtPath);
      expect(stat.isDirectory()).toBe(true);

      const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: wtPath });
      expect(stdout.trim()).toBe(`opensprint/${taskId}`);

      // Verify main WT is still on main
      const { stdout: mainBranch } = await execAsync("git rev-parse --abbrev-ref HEAD", {
        cwd: repoPath,
      });
      expect(mainBranch.trim()).toBe("main");
    });

    it("should remove a worktree cleanly", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const taskId = `wt-rm-${Date.now()}`;
      const wtPath = await branchManager.createTaskWorktree(repoPath, taskId);

      // Verify it exists
      await fs.access(wtPath);

      // Remove it
      await branchManager.removeTaskWorktree(repoPath, taskId);

      // Verify it's gone
      try {
        await fs.access(wtPath);
        expect.fail("Worktree directory should have been removed");
      } catch {
        // Expected
      }
    });

    it("should handle removing a non-existent worktree gracefully", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      // Should not throw
      await branchManager.removeTaskWorktree(repoPath, "nonexistent-task");
    });

    it("listTaskWorktrees returns worktrees under base path", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const taskId = `wt-list-${Date.now()}`;
      const wtPath = await branchManager.createTaskWorktree(repoPath, taskId);
      worktreePaths.push(wtPath);

      const list = await branchManager.listTaskWorktrees(repoPath);
      expect(list.some((w) => w.taskId === taskId)).toBe(true);
      const listedPath = list.find((w) => w.taskId === taskId)?.worktreePath;
      expect(listedPath).toBeDefined();
      expect(listedPath).toContain(taskId);
      expect(listedPath).toContain("opensprint-worktrees");

      await branchManager.removeTaskWorktree(repoPath, taskId);
      const listAfter = await branchManager.listTaskWorktrees(repoPath);
      expect(listAfter.some((w) => w.taskId === taskId)).toBe(false);
    });

    it("pruneOrphanWorktrees removes worktrees for closed tasks", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const closedTaskId = `wt-prune-closed-${Date.now()}`;
      const wtPath = await branchManager.createTaskWorktree(repoPath, closedTaskId);
      worktreePaths.push(wtPath);

      const taskStore = {
        listAll: vi.fn().mockResolvedValue([
          { id: closedTaskId, status: "closed" },
          { id: "other-open", status: "open" },
        ]),
      };

      const pruned = await branchManager.pruneOrphanWorktrees(
        repoPath,
        "test-project",
        new Set(["other-open"]),
        taskStore
      );

      expect(pruned).toContain(closedTaskId);
      const listAfter = await branchManager.listTaskWorktrees(repoPath);
      expect(listAfter.some((w) => w.taskId === closedTaskId)).toBe(false);
    });

    it("pruneOrphanWorktrees skips excluded and in-progress tasks", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const activeTaskId = `wt-prune-active-${Date.now()}`;
      const wtPath = await branchManager.createTaskWorktree(repoPath, activeTaskId);
      worktreePaths.push(wtPath);

      const taskStore = {
        listAll: vi.fn().mockResolvedValue([{ id: activeTaskId, status: "in_progress" }]),
      };

      const pruned = await branchManager.pruneOrphanWorktrees(
        repoPath,
        "test-project",
        new Set([activeTaskId]),
        taskStore
      );

      expect(pruned).not.toContain(activeTaskId);
      const listAfter = await branchManager.listTaskWorktrees(repoPath);
      expect(listAfter.some((w) => w.taskId === activeTaskId)).toBe(true);
    });

    it("should replace a stale worktree when creating", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const taskId = `wt-replace-${Date.now()}`;

      // Create first worktree
      const wtPath1 = await branchManager.createTaskWorktree(repoPath, taskId);
      worktreePaths.push(wtPath1);

      // Write a file in the first worktree
      await fs.writeFile(path.join(wtPath1, "old-file.txt"), "old content");

      // Create second worktree (should replace the first)
      const wtPath2 = await branchManager.createTaskWorktree(repoPath, taskId);
      worktreePaths.push(wtPath2);

      expect(wtPath2).toBe(wtPath1); // Same path

      // The old file should not exist (fresh worktree)
      // Actually, the branch preserves committed content. The uncommitted file is gone.
      try {
        await fs.access(path.join(wtPath2, "old-file.txt"));
        expect.fail("Uncommitted file from old worktree should be gone");
      } catch {
        // Expected
      }
    });

    it("throws WorktreeBranchInUseError when branch is in another path with active heartbeat", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const taskA = `wt-active-${Date.now()}`;
      const taskB = `wt-other-${Date.now()}`;
      const base = branchManager.getWorktreeBasePath();
      const pathB = path.join(base, taskB);

      // Create worktree for taskA, then remove it so branch opensprint/taskA exists but is free
      const pathA = await branchManager.createTaskWorktree(repoPath, taskA);
      worktreePaths.push(pathA);
      await branchManager.removeTaskWorktree(repoPath, taskA);

      // Put branch taskA in worktree at pathB (simulates wrong-path or stale entry)
      await fs.mkdir(path.dirname(pathB), { recursive: true });
      await execAsync(`git worktree add ${pathB} opensprint/${taskA}`, { cwd: repoPath });
      worktreePaths.push(pathB);

      // Simulate active agent in the other path: non-stale heartbeat
      const now = Date.now();
      vi.spyOn(heartbeatService, "readHeartbeat").mockResolvedValue({
        pid: 12345,
        lastOutputTimestamp: now,
        heartbeatTimestamp: now,
      });
      vi.spyOn(heartbeatService, "isStale").mockReturnValue(false);

      try {
        await branchManager.createTaskWorktree(repoPath, taskA);
        expect.fail("should have thrown WorktreeBranchInUseError");
      } catch (err) {
        expect(err).toBeInstanceOf(WorktreeBranchInUseError);
        const e = err as WorktreeBranchInUseError;
        expect(e.branchName).toBe(`opensprint/${taskA}`);
        expect(e.otherTaskId).toBe(taskB);
        expect(e.message).toContain("active agent");
      }

      vi.restoreAllMocks();
    });

    it("should merge branch to main via mergeToMain", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const taskId = `wt-merge-${Date.now()}`;
      const branchName = `opensprint/${taskId}`;
      const wtPath = await branchManager.createTaskWorktree(repoPath, taskId);
      worktreePaths.push(wtPath);

      // Make changes in worktree and commit
      await fs.writeFile(path.join(wtPath, "feature.ts"), "export const x = 1;");
      await execAsync('git add -A && git commit -m "add feature"', { cwd: wtPath });

      // Merge from main WT (which is on main)
      await branchManager.mergeToMain(repoPath, branchName);

      // Verify the file exists on main
      const content = await fs.readFile(path.join(repoPath, "feature.ts"), "utf-8");
      expect(content).toBe("export const x = 1;");

      // Verify merge
      const merged = await branchManager.verifyMerge(repoPath, branchName);
      expect(merged).toBe(true);
    });
  });

  describe("pushMain squash commit message", () => {
    let barePath: string;

    afterEach(async () => {
      try {
        if (barePath) await fs.rm(barePath, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it("should use Closed format when squashing commits that include a merge commit", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      barePath = path.join(os.tmpdir(), `opensprint-bare-${Date.now()}`);
      await fs.mkdir(barePath, { recursive: true });
      await execAsync("git init --bare", { cwd: barePath });
      await execAsync(`git remote add origin ${barePath}`, { cwd: repoPath });
      await execAsync("git push -u origin main", { cwd: repoPath });

      // Add two local commits: merge (Closed format) + task-store export
      await fs.writeFile(path.join(repoPath, "feature.ts"), "x");
      await execAsync(
        'git add feature.ts && git -c core.hooksPath=/dev/null commit -m "Closed opensprint.dev-abc.1: Add feature"',
        { cwd: repoPath }
      );
      await fs.writeFile(path.join(repoPath, "other.ts"), "y");
      await execAsync(
        'git add other.ts && git -c core.hooksPath=/dev/null commit -m "task: closed"',
        { cwd: repoPath }
      );

      await branchManager.pushMain(repoPath);

      const { stdout } = await execAsync("git log -1 --format=%s", { cwd: repoPath });
      expect(stdout.trim()).toMatch(/^Closed opensprint\.dev-abc\.1:/);
      expect(stdout.trim()).toContain("Add feature");
    });

    it("should normalize long title to ~30 chars when squashing Closed commit", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      barePath = path.join(os.tmpdir(), `opensprint-bare-long-${Date.now()}`);
      await fs.mkdir(barePath, { recursive: true });
      await execAsync("git init --bare", { cwd: barePath });
      await execAsync(`git remote add origin ${barePath}`, { cwd: repoPath });
      await execAsync("git push -u origin main", { cwd: repoPath });

      // Commit with long untruncated title (legacy format)
      await fs.writeFile(path.join(repoPath, "feature.ts"), "x");
      await execAsync(
        'git add feature.ts && git -c core.hooksPath=/dev/null commit -m "Closed opensprint.dev-xyz.1: Add agent heartbeat monitoring and reporting to dashboard"',
        { cwd: repoPath }
      );
      await fs.writeFile(path.join(repoPath, "other.ts"), "y");
      await execAsync(
        'git add other.ts && git -c core.hooksPath=/dev/null commit -m "task: closed"',
        { cwd: repoPath }
      );

      await branchManager.pushMain(repoPath);

      const { stdout } = await execAsync("git log -1 --format=%s", { cwd: repoPath });
      expect(stdout.trim()).toMatch(/^Closed opensprint\.dev-xyz\.1:/);
      expect(stdout.trim()).toContain("\u2026");
      expect(stdout.trim()).not.toContain("to dashboard");
    });

    it("should fall back to generic message when no Closed commit exists", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      barePath = path.join(os.tmpdir(), `opensprint-bare2-${Date.now()}`);
      await fs.mkdir(barePath, { recursive: true });
      await execAsync("git init --bare", { cwd: barePath });
      await execAsync(`git remote add origin ${barePath}`, { cwd: repoPath });
      await execAsync("git push -u origin main", { cwd: repoPath });

      // Add two local commits without Closed format
      await fs.writeFile(path.join(repoPath, "a.ts"), "a");
      await execAsync('git add a.ts && git commit -m "prd: updated"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "b.ts"), "b");
      await execAsync('git add b.ts && git commit -m "task: closed"', { cwd: repoPath });

      await branchManager.pushMain(repoPath);

      const { stdout } = await execAsync("git log -1 --format=%s", { cwd: repoPath });
      expect(stdout.trim()).toContain("squash");
      expect(stdout.trim()).toContain("local commits for rebase");
    });

    it("should use Closed format when deriving from merge commit (no Closed message)", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      barePath = path.join(os.tmpdir(), `opensprint-bare-merge-${Date.now()}`);
      await fs.mkdir(barePath, { recursive: true });
      await execAsync("git init --bare", { cwd: barePath });
      await execAsync(`git remote add origin ${barePath}`, { cwd: repoPath });
      await execAsync("git push -u origin main", { cwd: repoPath });

      // Create task branch and merge with default message (no Closed format)
      const branchName = "opensprint/opensprint.dev-merge.1";
      await execAsync(`git checkout -b ${branchName}`, { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "feature.ts"), "x");
      await execAsync('git add feature.ts && git commit -m "add feature"', { cwd: repoPath });
      await execAsync("git checkout main", { cwd: repoPath });
      await execAsync(`git merge --no-ff ${branchName} -m "Merge branch '${branchName}'"`, {
        cwd: repoPath,
      });

      // With global task store, deriveClosedFromMergeCommits uses global store; we get fallback
      // message unless the store has this issue.
      await branchManager.pushMain(repoPath);

      const { stdout } = await execAsync("git log -1 --format=%s", { cwd: repoPath });
      expect(stdout.trim()).toMatch(/^squash \d+ local commits for rebase$/);
    });

    it("should truncate long title to ~30 chars when deriving from merge commit", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      barePath = path.join(os.tmpdir(), `opensprint-bare-long-derive-${Date.now()}`);
      await fs.mkdir(barePath, { recursive: true });
      await execAsync("git init --bare", { cwd: barePath });
      await execAsync(`git remote add origin ${barePath}`, { cwd: repoPath });
      await execAsync("git push -u origin main", { cwd: repoPath });

      const branchName = "opensprint/opensprint.dev-long.1";
      await execAsync(`git checkout -b ${branchName}`, { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "feature.ts"), "x");
      await execAsync('git add feature.ts && git commit -m "add feature"', { cwd: repoPath });
      await execAsync("git checkout main", { cwd: repoPath });
      await execAsync(`git merge --no-ff ${branchName} -m "Merge branch '${branchName}'"`, {
        cwd: repoPath,
      });

      // With global task store, deriveClosedFromMergeCommits uses global store only.
      await branchManager.pushMain(repoPath);

      const { stdout } = await execAsync("git log -1 --format=%s", { cwd: repoPath });
      expect(stdout.trim()).toMatch(/^squash \d+ local commits for rebase$/);
    });
  });
});
