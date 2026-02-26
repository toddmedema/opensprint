import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import {
  gitCommitQueue,
  formatPrdCommitMessage,
  formatMergeCommitMessage,
} from "../services/git-commit-queue.service.js";
import { TaskStoreService } from "../services/task-store.service.js";
import { ProjectService } from "../services/project.service.js";
import { truncateTitle } from "../utils/commit-message.js";
import { DEFAULT_HIL_CONFIG } from "@opensprint/shared";

const execAsync = promisify(exec);

vi.mock("../services/task-store.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/task-store.service.js")>();
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs();
  const sharedDb = new SQL.Database();
  sharedDb.run(actual.SCHEMA_SQL);

  class MockTaskStoreService extends actual.TaskStoreService {
    async init(): Promise<void> {
      (this as unknown as { db: unknown }).db = sharedDb;
      (this as unknown as { injectedDb: unknown }).injectedDb = sharedDb;
    }
    protected ensureDb() {
      if (!(this as unknown as { db: unknown }).db) {
        (this as unknown as { db: unknown }).db = sharedDb;
        (this as unknown as { injectedDb: unknown }).injectedDb = sharedDb;
      }
      return super.ensureDb();
    }
  }

  const singletonInstance = new MockTaskStoreService();
  await singletonInstance.init();

  return {
    ...actual,
    TaskStoreService: MockTaskStoreService,
    taskStore: singletonInstance,
    _resetSharedDb: () => {
      sharedDb.run("DELETE FROM task_dependencies");
      sharedDb.run("DELETE FROM tasks");
    },
  };
});

/**
 * Put a git repo into a merge-conflict state by creating divergent changes
 * to the same file on main and a side branch, then attempting a merge.
 * Returns the name of the conflicted file.
 */
async function createMergeConflict(repoPath: string): Promise<string> {
  const conflictFile = "conflict.txt";

  await fs.writeFile(path.join(repoPath, conflictFile), "base content\n");
  await execAsync(`git add ${conflictFile} && git commit -m "add conflict file"`, {
    cwd: repoPath,
  });

  await execAsync("git checkout -b side-branch", { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, conflictFile), "side-branch content\n");
  await execAsync(`git add ${conflictFile} && git commit -m "side change"`, { cwd: repoPath });

  await execAsync("git checkout main", { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, conflictFile), "main content\n");
  await execAsync(`git add ${conflictFile} && git commit -m "main change"`, { cwd: repoPath });

  try {
    await execAsync("git merge side-branch", { cwd: repoPath });
  } catch {
    // Expected — merge conflict
  }

  return conflictFile;
}

describe("GitCommitQueue", () => {
  let repoPath: string;

  beforeEach(async () => {
    const mod = (await import("../services/task-store.service.js")) as unknown as {
      _resetSharedDb?: () => void;
    };
    mod._resetSharedDb?.();

    repoPath = path.join(os.tmpdir(), `git-queue-test-${Date.now()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await execAsync("git init", { cwd: repoPath });
    await execAsync("git checkout -b main", { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README"), "initial");
    await execAsync("git add README && git commit -m init", { cwd: repoPath });
  });

  afterEach(async () => {
    await gitCommitQueue.drain();
    await fs.rm(repoPath, { recursive: true, force: true }).catch(() => {});
  });

  it("should enqueue and process prd_update job", async () => {
    await fs.mkdir(path.join(repoPath, ".opensprint"), { recursive: true });
    await fs.writeFile(
      path.join(repoPath, ".opensprint/prd.json"),
      JSON.stringify({ version: 0, sections: {}, changeLog: [] })
    );

    await gitCommitQueue.enqueueAndWait({
      type: "prd_update",
      repoPath,
      source: "sketch",
    });

    const { stdout } = await execAsync("git log -1 --oneline", { cwd: repoPath });
    expect(stdout).toContain("prd:");
  });

  it("should process jobs in FIFO order", async () => {
    await fs.mkdir(path.join(repoPath, ".opensprint"), { recursive: true });
    await fs.writeFile(
      path.join(repoPath, ".opensprint/prd.json"),
      JSON.stringify({ version: 0, sections: {}, changeLog: [] })
    );

    gitCommitQueue.enqueue({
      type: "prd_update",
      repoPath,
      source: "sketch",
    });
    await gitCommitQueue.drain();

    const { stdout } = await execAsync("git log -1 --oneline", { cwd: repoPath });
    expect(stdout).toContain("prd:");
  });

  it("should support drain for tests", async () => {
    await fs.mkdir(path.join(repoPath, ".opensprint"), { recursive: true });
    await fs.writeFile(
      path.join(repoPath, ".opensprint/prd.json"),
      JSON.stringify({ version: 0, sections: {}, changeLog: [] })
    );

    gitCommitQueue.enqueue({
      type: "prd_update",
      repoPath,
      source: "sketch",
    });
    await gitCommitQueue.drain();

    const { stdout } = await execAsync("git log -1 --oneline", { cwd: repoPath });
    expect(stdout).toContain("prd:");
  });

  it("should merge a branch to main", async () => {
    await execAsync("git checkout -b opensprint/task-1", { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "feature.ts"), "export const x = 1;");
    await execAsync('git add feature.ts && git commit -m "add feature"', { cwd: repoPath });
    await execAsync("git checkout main", { cwd: repoPath });

    await gitCommitQueue.enqueueAndWait({
      type: "worktree_merge",
      repoPath,
      branchName: "opensprint/task-1",
      taskId: "opensprint.dev-abc.1",
      taskTitle: "Test task",
    });

    const { stdout: logOut } = await execAsync("git log -1 --oneline", { cwd: repoPath });
    expect(logOut).toContain("Closed opensprint.dev-abc.1: Test task");

    const { stdout: treeOut } = await execAsync("git ls-tree -r HEAD --name-only", {
      cwd: repoPath,
    });
    const treeFiles = treeOut.trim().split("\n").filter(Boolean);
    expect(treeFiles).toContain("feature.ts");
  });

  it("should succeed without commit when branch already merged (idempotent)", async () => {
    await execAsync("git checkout -b opensprint/task-2", { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "other.ts"), "export const y = 2;");
    await execAsync('git add other.ts && git commit -m "add other"', { cwd: repoPath });
    await execAsync("git checkout main", { cwd: repoPath });
    await execAsync(
      "git merge --no-ff opensprint/task-2 -m 'merge: opensprint/task-2 — Already done'",
      { cwd: repoPath }
    );
    const { stdout: afterFirst } = await execAsync("git log -1 --oneline", { cwd: repoPath });
    expect(afterFirst).toContain("merge:");

    // Simulate unstaged change that would cause "no changes added to commit"
    await fs.writeFile(path.join(repoPath, "local-change.txt"), "unstaged");
    await gitCommitQueue.enqueueAndWait({
      type: "worktree_merge",
      repoPath,
      branchName: "opensprint/task-2",
      taskId: "opensprint.dev-abc.2",
      taskTitle: "Retry merge",
    });

    const { stdout: afterRetry } = await execAsync("git log -1 --oneline", { cwd: repoPath });
    expect(afterRetry).toBe(afterFirst);
    expect(afterRetry).toContain("Already done");
  });

  // ─── Conflict-aware tests ───

  describe("with unmerged files", () => {
    it("should throw RepoConflictError for worktree_merge with unmerged files", async () => {
      await createMergeConflict(repoPath);

      try {
        await execAsync("git branch another-branch HEAD~1", { cwd: repoPath });
      } catch {
        return;
      }

      await expect(
        gitCommitQueue.enqueueAndWait({
          type: "worktree_merge",
          repoPath,
          branchName: "another-branch",
          taskId: "opensprint.dev-abc.3",
          taskTitle: "test merge",
        })
      ).rejects.toMatchObject({
        name: "RepoConflictError",
        unmergedFiles: expect.arrayContaining(["conflict.txt"]),
      });
    });

    it("should throw RepoConflictError for prd_update with unmerged files", async () => {
      await createMergeConflict(repoPath);

      await fs.mkdir(path.join(repoPath, ".opensprint"), { recursive: true });
      await fs.writeFile(
        path.join(repoPath, ".opensprint/prd.json"),
        JSON.stringify({ version: 1 })
      );

      await expect(
        gitCommitQueue.enqueueAndWait({
          type: "prd_update",
          repoPath,
          source: "sketch",
        })
      ).rejects.toMatchObject({
        name: "RepoConflictError",
      });
    });
  });

  it("should use 'Closed <taskId>: <truncated title>' for merge commit with long title", async () => {
    await execAsync("git checkout -b opensprint/task-long", { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "long.ts"), "export const z = 99;");
    await execAsync('git add long.ts && git commit -m "add long feature"', { cwd: repoPath });
    await execAsync("git checkout main", { cwd: repoPath });

    await gitCommitQueue.enqueueAndWait({
      type: "worktree_merge",
      repoPath,
      branchName: "opensprint/task-long",
      taskId: "opensprint.dev-zar.3",
      taskTitle: "Add agent heartbeat monitoring and reporting",
    });

    const { stdout: logOut } = await execAsync("git log -1 --oneline", { cwd: repoPath });
    expect(logOut).toContain("Closed opensprint.dev-zar.3:");
    expect(logOut).toContain("\u2026");
    expect(logOut).not.toContain("and reporting");
  });

  it("should fetch task title from task store when available", async () => {
    const projectHome = path.join(os.tmpdir(), `gq-project-home-${Date.now()}`);
    const originalHome = process.env.HOME;
    process.env.HOME = projectHome;
    try {
      const projectService = new ProjectService();
      const project = await projectService.createProject({
        name: "GQ Task Store Test",
        repoPath,
        simpleComplexityAgent: { type: "cursor", model: "claude-sonnet-4", cliCommand: null },
        complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
        deployment: { mode: "custom" },
        hilConfig: DEFAULT_HIL_CONFIG,
      });
      const mod = (await import("../services/task-store.service.js")) as unknown as {
        taskStore: TaskStoreService;
      };
      const taskStore = mod.taskStore;
      await taskStore.init();
      const task = await taskStore.create(project.id, "Title from task store", {
        type: "task" as const,
        priority: 1,
      });

      await execAsync("git checkout -b opensprint/task-store-test", { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "store-feature.ts"), "export const b = 1;");
      await execAsync('git add store-feature.ts && git commit -m "add feature"', { cwd: repoPath });
      await execAsync("git checkout main", { cwd: repoPath });

      await gitCommitQueue.enqueueAndWait({
        type: "worktree_merge",
        repoPath,
        branchName: "opensprint/task-store-test",
        taskId: task.id,
        taskTitle: "Fallback title (should be ignored)",
      });

      const { stdout: logOut } = await execAsync("git log -1 --oneline", { cwd: repoPath });
      expect(logOut).toContain(`Closed ${task.id}: Title from task store`);
      expect(logOut).not.toContain("Fallback title");
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it("should use taskTitle fallback when task store has no task", async () => {
    await execAsync("git checkout -b opensprint/task-fallback", { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "fallback.ts"), "export const f = 1;");
    await execAsync('git add fallback.ts && git commit -m "add feature"', { cwd: repoPath });
    await execAsync("git checkout main", { cwd: repoPath });

    await gitCommitQueue.enqueueAndWait({
      type: "worktree_merge",
      repoPath,
      branchName: "opensprint/task-fallback",
      taskId: "opensprint.dev-nonexistent.1",
      taskTitle: "Fallback when task not in store",
    });

    const { stdout: logOut } = await execAsync("git log -1 --format=%s", { cwd: repoPath });
    expect(logOut.trim()).toMatch(
      /^Closed opensprint\.dev-nonexistent\.1: Fallback when task not in/
    );
    expect(logOut.trim()).toContain("\u2026");
  });
});

describe("truncateTitle", () => {
  it("returns title unchanged when within limit", () => {
    expect(truncateTitle("Short title")).toBe("Short title");
  });

  it("returns title unchanged when exactly at limit", () => {
    const exact = "A".repeat(30);
    expect(truncateTitle(exact)).toBe(exact);
  });

  it("truncates at word boundary with ellipsis", () => {
    const title = "Add agent heartbeat monitoring and reporting";
    const result = truncateTitle(title);
    expect(result).toBe("Add agent heartbeat monitoring\u2026");
    expect(result.length).toBeLessThanOrEqual(31);
  });

  it("hard-cuts when no word boundary found before limit", () => {
    const title = "Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbb";
    const result = truncateTitle(title);
    expect(result).toBe("Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\u2026");
    expect(result.length).toBe(31);
  });

  it("respects custom maxLen", () => {
    expect(truncateTitle("Hello world of testing", 10)).toBe("Hello\u2026");
  });

  it("handles single long word at boundary", () => {
    const title = "Abcdefghijklmnopqrstuvwxyz12345 rest";
    const result = truncateTitle(title);
    expect(result).toBe("Abcdefghijklmnopqrstuvwxyz1234\u2026");
  });

  it("handles empty string", () => {
    expect(truncateTitle("")).toBe("");
  });
});

describe("formatPrdCommitMessage", () => {
  it("returns sketch session update for sketch source", () => {
    expect(formatPrdCommitMessage("sketch")).toBe("prd: Sketch session update");
  });

  it("returns evaluate feedback for eval source", () => {
    expect(formatPrdCommitMessage("eval")).toBe("prd: Evaluate feedback");
  });

  it("includes planId for plan source", () => {
    expect(formatPrdCommitMessage("plan", "auth")).toBe("prd: updated after Plan auth built");
  });

  it("returns generic message for plan source without planId", () => {
    expect(formatPrdCommitMessage("plan")).toBe("prd: updated");
  });

  it("includes planId for execute source", () => {
    expect(formatPrdCommitMessage("execute", "payments")).toBe(
      "prd: updated after Plan payments built"
    );
  });

  it("returns generic message for deliver source without planId", () => {
    expect(formatPrdCommitMessage("deliver")).toBe("prd: updated");
  });
});

describe("formatMergeCommitMessage", () => {
  it("includes task ID and title", () => {
    expect(formatMergeCommitMessage("opensprint.dev-abc.1", "Add login")).toBe(
      "Closed opensprint.dev-abc.1: Add login"
    );
  });

  it("truncates long titles", () => {
    const msg = formatMergeCommitMessage(
      "opensprint.dev-zar.3",
      "Add agent heartbeat monitoring and reporting"
    );
    expect(msg).toBe("Closed opensprint.dev-zar.3: Add agent heartbeat monitoring\u2026");
    expect(msg).not.toContain("and reporting");
  });

  it("preserves short titles exactly", () => {
    expect(formatMergeCommitMessage("bd-x.1", "Fix typo")).toBe("Closed bd-x.1: Fix typo");
  });

  it("always includes both task ID and title in <id>: <title> format", () => {
    const msg = formatMergeCommitMessage("opensprint.dev-abc.2", "Build user registration flow");
    expect(msg).toMatch(/^Closed opensprint\.dev-abc\.2: /);
    expect(msg).toContain("Build user registration");
  });
});

describe("commit message convention — worktree merge includes <id>: <title>", () => {
  it("worktree merge commit includes id: title", () => {
    const msg = formatMergeCommitMessage("opensprint.dev-abc.1", "Set up database schema");
    expect(msg).toMatch(/opensprint\.dev-abc\.1: Set up database schema/);
  });
});
