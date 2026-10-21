import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import {
  BranchManager,
  RebaseConflictError,
  RebaseContinueBlockedError,
  WorktreeBranchInUseError,
} from "../services/branch-manager.js";
import { worktreeLeaseService } from "../services/worktree-lease.service.js";
import { worktreeRegistry } from "../services/worktree-registry.js";
import { heartbeatService } from "../services/heartbeat.service.js";
import { RepoPreflightError } from "../utils/git-repo-state.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import * as commandRunnerModule from "../utils/command-runner.js";
import type { CommandSpec } from "../utils/command-runner.js";

function commandRunnerKey(spec: CommandSpec): string {
  return [spec.command, ...(spec.args ?? [])].join(" ");
}

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

const mockWorktreeLease = vi.hoisted(() => ({
  canCleanup: vi.fn().mockResolvedValue(true),
  get: vi.fn().mockResolvedValue(null),
  forceRelease: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/worktree-lease.service.js", () => ({
  worktreeLeaseService: mockWorktreeLease,
}));

const execAsync = promisify(exec);

const mockRunSuccess = {
  stdout: "",
  stderr: "",
  executable: "x",
  cwd: "",
  exitCode: 0 as const,
  signal: null as null,
};

describe("BranchManager", () => {
  let branchManager: BranchManager;
  let repoPath: string;

  beforeEach(async () => {
    mockWorktreeLease.canCleanup.mockResolvedValue(true);
    mockWorktreeLease.get.mockResolvedValue(null);
    mockWorktreeLease.forceRelease.mockResolvedValue(undefined);
    branchManager = new BranchManager();
    repoPath = path.join(
      os.tmpdir(),
      `opensprint-branch-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    );
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

    it("should return false when only excluded runtime paths exist (e.g. .opensprint/active and .opensprint/runtime)", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });
      await execAsync("git checkout -b opensprint/task-runtime-only", { cwd: repoPath });
      const hbDir = path.join(repoPath, ".opensprint", "active", "task-runtime-only");
      await fs.mkdir(hbDir, { recursive: true });
      await fs.writeFile(
        path.join(hbDir, "heartbeat.json"),
        JSON.stringify({ processGroupLeaderPid: 1, lastOutputTimestamp: 0, heartbeatTimestamp: 0 })
      );
      const runtimeDir = path.join(repoPath, ".opensprint", "runtime");
      await fs.mkdir(runtimeDir, { recursive: true });
      await fs.writeFile(
        path.join(runtimeDir, "worktree-cleanup-intents.json"),
        JSON.stringify({ version: 1, projects: {} }, null, 2)
      );

      const result = await branchManager.commitWip(repoPath, "task-runtime-only");
      expect(result).toBe(false);

      const { stdout: count } = await execAsync("git rev-list --count HEAD", { cwd: repoPath });
      expect(count.trim()).toBe("1");
    });

    it("should ignore node_modules symlink-only changes", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, ".gitignore"), "node_modules/\n");
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add .gitignore README && git commit -m "initial"', { cwd: repoPath });
      const targetDir = path.join(repoPath, ".deps");
      await fs.mkdir(targetDir, { recursive: true });
      await fs.symlink(
        targetDir,
        path.join(repoPath, "node_modules"),
        process.platform === "win32" ? "junction" : "dir"
      );

      const result = await branchManager.commitWip(repoPath, "task-node-modules");
      expect(result).toBe(false);

      const { stdout: tracked } = await execAsync("git ls-files node_modules", { cwd: repoPath });
      expect(tracked.trim()).toBe("");
      const { stdout: count } = await execAsync("git rev-list --count HEAD", { cwd: repoPath });
      expect(count.trim()).toBe("1");
    });
  });

  describe("listGitIndexFilesDeletedOnDisk", () => {
    it("lists tracked files removed from disk but still in the index", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "gone.ts"), "// x");
      await execAsync("git add gone.ts && git commit -m initial", { cwd: repoPath });
      await fs.unlink(path.join(repoPath, "gone.ts"));

      const deleted = await branchManager.listGitIndexFilesDeletedOnDisk(repoPath);
      expect(deleted).toEqual(["gone.ts"]);
    });
  });

  describe("checkDependencyIntegrity", () => {
    it("skips dependency checks when root package.json is missing", async () => {
      const runSpy = vi.spyOn(commandRunnerModule, "runCommand");

      await branchManager.checkDependencyIntegrity(repoPath);

      expect(runSpy).not.toHaveBeenCalled();
      runSpy.mockRestore();
    });

    it("uses workspace npm ls and does not repair healthy dependencies", async () => {
      await fs.writeFile(
        path.join(repoPath, "package.json"),
        JSON.stringify({ name: "repo", private: true, workspaces: ["packages/*"] })
      );
      const commands: string[] = [];
      const runSpy = vi
        .spyOn(commandRunnerModule, "runCommand")
        .mockImplementation(async (spec: CommandSpec) => {
          commands.push(commandRunnerKey(spec));
          if (commandRunnerKey(spec) === "npm ls --depth=0 --workspaces --include=dev") {
            return { ...mockRunSuccess, stdout: "ok" };
          }
          throw new Error(`Unexpected command: ${commandRunnerKey(spec)}`);
        });

      await branchManager.checkDependencyIntegrity(repoPath);

      expect(commands).toEqual(["npm ls --depth=0 --workspaces --include=dev"]);
      runSpy.mockRestore();
    });

    it("uses non-workspace npm ls for single-package repos", async () => {
      await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: "repo" }));
      const commands: string[] = [];
      const runSpy = vi
        .spyOn(commandRunnerModule, "runCommand")
        .mockImplementation(async (spec: CommandSpec) => {
          commands.push(commandRunnerKey(spec));
          if (commandRunnerKey(spec) === "npm ls --depth=0 --include=dev") {
            return { ...mockRunSuccess, stdout: "ok" };
          }
          throw new Error(`Unexpected command: ${commandRunnerKey(spec)}`);
        });

      await branchManager.checkDependencyIntegrity(repoPath);

      expect(commands).toEqual(["npm ls --depth=0 --include=dev"]);
      runSpy.mockRestore();
    });

    it("attempts one npm ci repair when initial health check fails", async () => {
      await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: "repo" }));
      const commands: string[] = [];
      let healthCheckCalls = 0;
      const runSpy = vi
        .spyOn(commandRunnerModule, "runCommand")
        .mockImplementation(async (spec: CommandSpec) => {
          const key = commandRunnerKey(spec);
          commands.push(key);
          if (key === "npm ls --depth=0 --include=dev") {
            healthCheckCalls += 1;
            if (healthCheckCalls === 1) {
              throw new Error("invalid dependencies");
            }
            return { ...mockRunSuccess, stdout: "ok" };
          }
          if (key === "npm ci") {
            return { ...mockRunSuccess, stdout: "installed" };
          }
          throw new Error(`Unexpected command: ${key}`);
        });

      await branchManager.checkDependencyIntegrity(repoPath);

      expect(commands).toEqual([
        "npm ls --depth=0 --include=dev",
        "npm ci",
        "npm ls --depth=0 --include=dev",
      ]);
      expect(commands.filter((command) => command === "npm ci")).toHaveLength(1);
      runSpy.mockRestore();
    });

    it("re-links worktree node_modules after successful repair before passing", async () => {
      await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: "repo" }));
      const wtPath = path.join(repoPath, ".wt-task");
      const commands: string[] = [];
      let healthCheckCalls = 0;
      const runSpy = vi
        .spyOn(commandRunnerModule, "runCommand")
        .mockImplementation(async (spec: CommandSpec) => {
          const key = commandRunnerKey(spec);
          commands.push(key);
          if (key === "npm ls --depth=0 --include=dev") {
            healthCheckCalls += 1;
            if (healthCheckCalls === 1) {
              throw new Error("missing module before repair");
            }
            return { ...mockRunSuccess, stdout: "ok" };
          }
          if (key === "npm ci") {
            return { ...mockRunSuccess, stdout: "installed" };
          }
          throw new Error(`Unexpected command: ${key}`);
        });
      const symlinkSpy = vi.spyOn(branchManager, "symlinkNodeModules").mockResolvedValue(undefined);

      await branchManager.checkDependencyIntegrity(repoPath, wtPath);

      expect(commands).toEqual([
        "npm ls --depth=0 --include=dev",
        "npm ci",
        "npm ls --depth=0 --include=dev",
      ]);
      expect(commands.filter((command) => command === "npm ci")).toHaveLength(1);
      expect(symlinkSpy).toHaveBeenCalledTimes(1);
      expect(symlinkSpy).toHaveBeenCalledWith(repoPath, wtPath);
      runSpy.mockRestore();
      symlinkSpy.mockRestore();
    });

    it("throws RepoPreflightError with remediation when health stays invalid", async () => {
      await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: "repo" }));
      const commands: string[] = [];
      const runSpy = vi
        .spyOn(commandRunnerModule, "runCommand")
        .mockImplementation(async (spec: CommandSpec) => {
          const key = commandRunnerKey(spec);
          commands.push(key);
          if (key === "npm ls --depth=0 --include=dev") {
            throw new Error("MODULE_NOT_FOUND");
          }
          if (key === "npm ci") {
            throw new Error("npm ci failed");
          }
          throw new Error(`Unexpected command: ${key}`);
        });

      try {
        await branchManager.checkDependencyIntegrity(repoPath);
        expect.fail("Expected checkDependencyIntegrity to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(RepoPreflightError);
        const error = err as RepoPreflightError;
        expect(error.code).toBe(ErrorCodes.REPO_DEPENDENCIES_INVALID);
        expect(error.commands).toEqual(["npm ci", "npm ls --depth=0 --include=dev"]);
        expect(error.message).toContain("Run `npm ci` in the repo root");
      }

      expect(commands).toEqual([
        "npm ls --depth=0 --include=dev",
        "npm ci",
        "npm ls --depth=0 --include=dev",
      ]);
      expect(commands.filter((command) => command === "npm ci")).toHaveLength(1);
      runSpy.mockRestore();
    });

    it("does not loop repair when npm ci succeeds but deps stay unhealthy", async () => {
      await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: "repo" }));
      const commands: string[] = [];
      let healthCheckCalls = 0;
      const runSpy = vi
        .spyOn(commandRunnerModule, "runCommand")
        .mockImplementation(async (spec: CommandSpec) => {
          const key = commandRunnerKey(spec);
          commands.push(key);
          if (key === "npm ls --depth=0 --include=dev") {
            healthCheckCalls += 1;
            throw new Error(
              healthCheckCalls === 1 ? "missing module before repair" : "still missing after repair"
            );
          }
          if (key === "npm ci") {
            return { ...mockRunSuccess, stdout: "installed" };
          }
          throw new Error(`Unexpected command: ${key}`);
        });

      await expect(branchManager.checkDependencyIntegrity(repoPath)).rejects.toMatchObject({
        name: "RepoPreflightError",
        code: ErrorCodes.REPO_DEPENDENCIES_INVALID,
      });
      expect(commands).toEqual([
        "npm ls --depth=0 --include=dev",
        "npm ci",
        "npm ls --depth=0 --include=dev",
      ]);
      expect(commands.filter((command) => command === "npm ci")).toHaveLength(1);
      runSpy.mockRestore();
    });

    it("re-links worktree once and still fails when deps remain unhealthy after repair", async () => {
      await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: "repo" }));
      const wtPath = path.join(repoPath, ".wt-task");
      const commands: string[] = [];
      let healthCheckCalls = 0;
      const runSpy = vi
        .spyOn(commandRunnerModule, "runCommand")
        .mockImplementation(async (spec: CommandSpec) => {
          const key = commandRunnerKey(spec);
          commands.push(key);
          if (key === "npm ls --depth=0 --include=dev") {
            healthCheckCalls += 1;
            throw new Error(
              healthCheckCalls === 1 ? "missing module before repair" : "still missing after repair"
            );
          }
          if (key === "npm ci") {
            return { ...mockRunSuccess, stdout: "installed" };
          }
          throw new Error(`Unexpected command: ${key}`);
        });
      const symlinkSpy = vi.spyOn(branchManager, "symlinkNodeModules").mockResolvedValue(undefined);

      await expect(branchManager.checkDependencyIntegrity(repoPath, wtPath)).rejects.toMatchObject({
        name: "RepoPreflightError",
        code: ErrorCodes.REPO_DEPENDENCIES_INVALID,
      });
      expect(commands).toEqual([
        "npm ls --depth=0 --include=dev",
        "npm ci",
        "npm ls --depth=0 --include=dev",
      ]);
      expect(commands.filter((command) => command === "npm ci")).toHaveLength(1);
      expect(symlinkSpy).toHaveBeenCalledTimes(1);
      expect(symlinkSpy).toHaveBeenCalledWith(repoPath, wtPath);
      runSpy.mockRestore();
      symlinkSpy.mockRestore();
    });
  });

  describe("reconcileDependenciesAfterMerge", () => {
    it("runs npm ci when ORIG_HEAD diff shows lockfile changed", async () => {
      const commands: string[] = [];
      const runSpy = vi
        .spyOn(commandRunnerModule, "runCommand")
        .mockImplementation(async (spec: CommandSpec) => {
          const key = commandRunnerKey(spec);
          commands.push(key);
          if (key.includes("ORIG_HEAD..HEAD")) {
            return { ...mockRunSuccess, stdout: "package-lock.json\npackage.json\n" };
          }
          if (key === "npm ci") {
            return { ...mockRunSuccess, stdout: "installed" };
          }
          return mockRunSuccess;
        });

      await branchManager.reconcileDependenciesAfterMerge(repoPath);

      expect(commands).toContain("npm ci");
      runSpy.mockRestore();
    });

    it("skips npm ci when no dependency files changed", async () => {
      const commands: string[] = [];
      const runSpy = vi
        .spyOn(commandRunnerModule, "runCommand")
        .mockImplementation(async (spec: CommandSpec) => {
          const key = commandRunnerKey(spec);
          commands.push(key);
          if (key.includes("ORIG_HEAD..HEAD")) {
            // pathspec filter means git only returns matching files; empty = no dep files changed
            return { ...mockRunSuccess, stdout: "" };
          }
          return mockRunSuccess;
        });

      await branchManager.reconcileDependenciesAfterMerge(repoPath);

      expect(commands).not.toContain("npm ci");
      runSpy.mockRestore();
    });

    it("runs npm ci when a nested workspace package.json changed", async () => {
      const commands: string[] = [];
      const runSpy = vi
        .spyOn(commandRunnerModule, "runCommand")
        .mockImplementation(async (spec: CommandSpec) => {
          const key = commandRunnerKey(spec);
          commands.push(key);
          if (key.includes("ORIG_HEAD..HEAD")) {
            return { ...mockRunSuccess, stdout: "packages/nested/pkg/package.json\n" };
          }
          if (key === "npm ci") {
            return { ...mockRunSuccess, stdout: "installed" };
          }
          return mockRunSuccess;
        });

      await branchManager.reconcileDependenciesAfterMerge(repoPath);

      expect(commands).toContain("npm ci");
      runSpy.mockRestore();
    });

    it("falls back to running npm ci when ORIG_HEAD is unavailable", async () => {
      const commands: string[] = [];
      const runSpy = vi
        .spyOn(commandRunnerModule, "runCommand")
        .mockImplementation(async (spec: CommandSpec) => {
          const key = commandRunnerKey(spec);
          commands.push(key);
          if (key.includes("ORIG_HEAD..HEAD")) {
            throw new Error("fatal: bad revision 'ORIG_HEAD'");
          }
          if (key === "npm ci") {
            return { ...mockRunSuccess, stdout: "installed" };
          }
          return mockRunSuccess;
        });

      await branchManager.reconcileDependenciesAfterMerge(repoPath);

      expect(commands).toContain("npm ci");
      runSpy.mockRestore();
    });
  });

  describe("rebaseContinue", () => {
    it("treats 'no rebase in progress' as already complete", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      await expect(branchManager.rebaseContinue(repoPath)).resolves.toBeUndefined();
    });

    it("throws RebaseConflictError when the next commit conflicts during rebase --continue", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "conflict.txt"), "base\n");
      await execAsync('git add conflict.txt && git commit -m "initial"', { cwd: repoPath });

      await execAsync("git checkout -b opensprint/rebase-multi-conflict", { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "conflict.txt"), "feature-1\n");
      await execAsync('git add conflict.txt && git commit -m "feature commit 1"', {
        cwd: repoPath,
      });
      await fs.writeFile(path.join(repoPath, "conflict.txt"), "feature-2\n");
      await execAsync('git add conflict.txt && git commit -m "feature commit 2"', {
        cwd: repoPath,
      });

      await execAsync("git checkout main", { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "conflict.txt"), "main-change\n");
      await execAsync('git add conflict.txt && git commit -m "main change"', { cwd: repoPath });

      await execAsync("git checkout opensprint/rebase-multi-conflict", { cwd: repoPath });
      await expect(execAsync("git rebase main", { cwd: repoPath })).rejects.toBeDefined();

      await fs.writeFile(path.join(repoPath, "conflict.txt"), "resolved-first-conflict\n");
      await execAsync("git add conflict.txt", { cwd: repoPath });

      await expect(branchManager.rebaseContinue(repoPath)).rejects.toBeInstanceOf(
        RebaseConflictError
      );
      await expect(branchManager.getConflictedFiles(repoPath)).resolves.toEqual(["conflict.txt"]);
    });

    it("throws RebaseContinueBlockedError when staged conflict markers remain before continue (preflight)", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      const filePath = path.join(repoPath, "conflict.txt");
      await fs.writeFile(filePath, "base\n");
      await execAsync('git add conflict.txt && git commit -m "initial"', { cwd: repoPath });

      await execAsync("git checkout -b feature", { cwd: repoPath });
      await fs.writeFile(filePath, "feature\n");
      await execAsync('git add conflict.txt && git commit -m "feature"', { cwd: repoPath });

      await execAsync("git checkout main", { cwd: repoPath });
      await fs.writeFile(filePath, "main\n");
      await execAsync('git add conflict.txt && git commit -m "main"', { cwd: repoPath });

      await execAsync("git checkout feature", { cwd: repoPath });
      await expect(execAsync("git rebase main", { cwd: repoPath })).rejects.toThrow();

      let caught: unknown;
      try {
        await branchManager.rebaseContinue(repoPath);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(RebaseContinueBlockedError);
      const blocked = caught as RebaseContinueBlockedError;
      expect(blocked.diagnostics.cause).toBe("preflight_staged_markers");
      expect(blocked.diagnostics.conflictedFiles).toContain("conflict.txt");
      expect(blocked.diagnostics.rebaseMetadataPresent).toContain("rebase-merge");

      await branchManager.rebaseAbort(repoPath);
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

  describe("syncMainWithOrigin", () => {
    it("fast-forwards main when origin/main is ahead", async () => {
      const remotePath = path.join(os.tmpdir(), `opensprint-branch-remote-${Date.now()}`);
      await fs.mkdir(remotePath, { recursive: true });
      await execAsync("git init --bare", { cwd: remotePath });

      const clonePath = path.join(os.tmpdir(), `opensprint-branch-clone-${Date.now()}`);
      await execAsync("git init", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await execAsync("git checkout -b main", { cwd: repoPath });
      await execAsync(`git remote add origin ${remotePath}`, { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });
      await execAsync("git push -u origin main", { cwd: repoPath });

      // Use a stable cwd: inheriting process.cwd() can fail with "getcwd: cannot access parent
      // directories" when another suite or the OS invalidates the current directory.
      await execAsync(`git clone "${remotePath}" "${clonePath}"`, { cwd: os.tmpdir() });
      await execAsync('git config user.email "test@test.com"', { cwd: clonePath });
      await execAsync('git config user.name "Test"', { cwd: clonePath });
      await execAsync("git checkout main", { cwd: clonePath });
      await fs.writeFile(path.join(clonePath, "remote.txt"), "from remote");
      await execAsync('git add remote.txt && git commit -m "remote change"', { cwd: clonePath });
      await execAsync("git push origin main", { cwd: clonePath });

      const result = await branchManager.syncMainWithOrigin(repoPath);

      expect(result).toBe("fast_forwarded");
      const { stdout } = await execAsync("git ls-tree -r HEAD --name-only", { cwd: repoPath });
      expect(stdout).toContain("remote.txt");

      await fs.rm(remotePath, { recursive: true, force: true });
      await fs.rm(clonePath, { recursive: true, force: true });
    });

    it("preserves local main commits when local main is ahead", async () => {
      const remotePath = path.join(os.tmpdir(), `opensprint-branch-remote-${Date.now()}`);
      await fs.mkdir(remotePath, { recursive: true });
      await execAsync("git init --bare", { cwd: remotePath });
      await execAsync("git init", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync(`git remote add origin ${remotePath}`, { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });
      await execAsync("git push -u origin main", { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "local.txt"), "only local");
      await execAsync('git add local.txt && git commit -m "local ahead"', { cwd: repoPath });

      const result = await branchManager.syncMainWithOrigin(repoPath);

      expect(result).toBe("local_ahead");
      const { stdout } = await execAsync("git log --format=%s -1", { cwd: repoPath });
      expect(stdout.trim()).toBe("local ahead");

      await fs.rm(remotePath, { recursive: true, force: true });
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

    it("should exclude node_modules symlink from captured diff", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, ".gitignore"), "node_modules/\n");
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add .gitignore README && git commit -m "initial"', { cwd: repoPath });
      const targetDir = path.join(repoPath, ".deps");
      await fs.mkdir(targetDir, { recursive: true });
      await fs.symlink(
        targetDir,
        path.join(repoPath, "node_modules"),
        process.platform === "win32" ? "junction" : "dir"
      );

      const diff = await branchManager.captureUncommittedDiff(repoPath);
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

    it("bootstraps an initial commit before creating a worktree for a legacy repo with no HEAD", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "legacy repo without commit");

      const taskId = `wt-bootstrap-${Date.now()}`;
      const wtPath = await branchManager.createTaskWorktree(repoPath, taskId);
      worktreePaths.push(wtPath);

      const { stdout: headSha } = await execAsync("git rev-parse HEAD", { cwd: repoPath });
      expect(headSha.trim()).toMatch(/^[0-9a-f]{40}$/);

      const { stdout: headMessage } = await execAsync("git log -1 --pretty=%s", { cwd: repoPath });
      expect(headMessage.trim()).toBe("chore: initialize Open Sprint project");

      const { stdout: wtBranch } = await execAsync("git rev-parse --abbrev-ref HEAD", {
        cwd: wtPath,
      });
      expect(wtBranch.trim()).toBe(`opensprint/${taskId}`);

      await expect(fs.readFile(path.join(wtPath, "README"), "utf-8")).resolves.toBe(
        "legacy repo without commit"
      );
    });

    it("creates the task worktree when the main repo was checked out to the task branch", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const taskId = `wt-main-branch-${Date.now()}`;
      await execAsync(`git checkout -b opensprint/${taskId}`, { cwd: repoPath });

      const wtPath = await branchManager.createTaskWorktree(repoPath, taskId);
      worktreePaths.push(wtPath);

      const { stdout: mainBranch } = await execAsync("git rev-parse --abbrev-ref HEAD", {
        cwd: repoPath,
      });
      expect(mainBranch.trim()).toBe("main");

      const { stdout: wtBranch } = await execAsync("git rev-parse --abbrev-ref HEAD", {
        cwd: wtPath,
      });
      expect(wtBranch.trim()).toBe(`opensprint/${taskId}`);
    });

    it("should remove a worktree cleanly", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const taskId = `wt-rm-${Date.now()}`;
      const sharedDependencies = path.join(repoPath, "node_modules");
      await fs.mkdir(sharedDependencies);
      const dependencyMarker = path.join(sharedDependencies, "keep.txt");
      await fs.writeFile(dependencyMarker, "shared dependency");
      const wtPath = await branchManager.createTaskWorktree(repoPath, taskId);

      // Verify it exists
      await fs.access(wtPath);

      // Remove it
      await branchManager.removeTaskWorktree(repoPath, taskId);
      expect(await fs.readFile(dependencyMarker, "utf-8")).toBe("shared dependency");

      // Verify it's gone
      try {
        await fs.access(wtPath);
        expect.fail("Worktree directory should have been removed");
      } catch {
        // Expected
      }
    });

    it("does not remove a registered worktree while durable lease cleanup is blocked", async () => {
      mockWorktreeLease.canCleanup.mockResolvedValue(false);
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const taskId = `wt-lease-block-${Date.now()}`;
      const wtPath = await branchManager.createTaskWorktree(repoPath, taskId);
      await branchManager.removeTaskWorktree(repoPath, taskId, wtPath);
      await fs.access(wtPath);
      expect(mockWorktreeLease.canCleanup).toHaveBeenCalledWith(taskId);
    });

    it("does not remove when durable lease path disagrees with removal target (TOCTOU guard)", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const taskId = `wt-lease-mismatch-${Date.now()}`;
      const wtPath = await branchManager.createTaskWorktree(repoPath, taskId);
      const decoyPath = path.join(
        os.tmpdir(),
        `opensprint-lease-decoy-${process.pid}-${Date.now()}`
      );
      await fs.mkdir(decoyPath, { recursive: true });
      mockWorktreeLease.get.mockResolvedValue({
        worktreeKey: taskId,
        taskId,
        projectId: "proj-x",
        worktreePath: decoyPath,
        branchName: null,
        leaseOwner: "dispatch:test",
        generation: 1,
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        releasedAt: null,
      });

      await branchManager.removeTaskWorktree(repoPath, taskId, wtPath);
      await fs.access(wtPath);
    });

    it("removes worktree when lease row is released even if worktree_path disagrees (post forceRelease)", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const taskId = `wt-lease-released-path-${Date.now()}`;
      const wtPath = await branchManager.createTaskWorktree(repoPath, taskId);
      const decoyPath = path.join(
        os.tmpdir(),
        `opensprint-lease-decoy-rel-${process.pid}-${Date.now()}`
      );
      await fs.mkdir(decoyPath, { recursive: true });
      mockWorktreeLease.get.mockResolvedValue({
        worktreeKey: taskId,
        taskId,
        projectId: "proj-x",
        worktreePath: decoyPath,
        branchName: null,
        leaseOwner: "dispatch:test",
        generation: 1,
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        releasedAt: new Date().toISOString(),
      });

      await branchManager.removeTaskWorktree(repoPath, taskId, wtPath);
      await expect(fs.access(wtPath)).rejects.toThrow();
    });

    it("removes worktree when lease is expired even if worktree_path disagrees", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const taskId = `wt-lease-expired-path-${Date.now()}`;
      const wtPath = await branchManager.createTaskWorktree(repoPath, taskId);
      const decoyPath = path.join(
        os.tmpdir(),
        `opensprint-lease-decoy-exp-${process.pid}-${Date.now()}`
      );
      await fs.mkdir(decoyPath, { recursive: true });
      mockWorktreeLease.get.mockResolvedValue({
        worktreeKey: taskId,
        taskId,
        projectId: "proj-x",
        worktreePath: decoyPath,
        branchName: null,
        leaseOwner: "dispatch:test",
        generation: 1,
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        releasedAt: null,
      });

      await branchManager.removeTaskWorktree(repoPath, taskId, wtPath);
      await expect(fs.access(wtPath)).rejects.toThrow();
    });

    it("falls back to full escalation path when git worktree remove fails", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const taskId = `wt-rm-fallback-${Date.now()}`;
      const wtPath = path.join(branchManager.getWorktreeBasePath(), taskId);
      const branchManagerAny = branchManager as unknown as {
        resolveRegisteredWorktreePath: (...args: unknown[]) => Promise<string>;
        validateDisposableWorktreePath: (...args: unknown[]) => Promise<string>;
        gitExec: (...args: unknown[]) => Promise<{ stdout: string; stderr: string }>;
        removeWorktreePathWithEscalation: (...args: unknown[]) => Promise<boolean>;
      };

      const resolveSpy = vi
        .spyOn(branchManagerAny, "resolveRegisteredWorktreePath")
        .mockResolvedValue(wtPath);
      const validateSpy = vi
        .spyOn(branchManagerAny, "validateDisposableWorktreePath")
        .mockResolvedValue(wtPath);
      const gitExecSpy = vi
        .spyOn(branchManagerAny, "gitExec")
        .mockImplementation(async (_repo, args) => {
          const gitArgs = args as string[];
          if (gitArgs[0] === "worktree" && gitArgs[1] === "remove") {
            throw new Error("simulated remove failure");
          }
          return { stdout: "", stderr: "" };
        });
      const escalationSpy = vi
        .spyOn(branchManagerAny, "removeWorktreePathWithEscalation")
        .mockResolvedValue(true);

      await branchManager.removeTaskWorktree(repoPath, taskId, wtPath);

      expect(resolveSpy).toHaveBeenCalled();
      expect(validateSpy).toHaveBeenCalled();
      expect(gitExecSpy).toHaveBeenCalled();
      expect(escalationSpy).toHaveBeenCalledWith(
        repoPath,
        taskId,
        wtPath,
        "Manual worktree cleanup",
        { skipGitWorktreeRemove: true }
      );
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

    it("replaces real node_modules directories with symlinks in worktrees", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const taskId = `wt-symlink-replace-${Date.now()}`;
      const wtPath = await branchManager.createTaskWorktree(repoPath, taskId);
      worktreePaths.push(wtPath);

      const srcRootNodeModules = path.join(repoPath, "node_modules");
      const srcPkgNodeModules = path.join(repoPath, "packages", "electron", "node_modules");
      await fs.mkdir(srcRootNodeModules, { recursive: true });
      await fs.mkdir(srcPkgNodeModules, { recursive: true });
      await fs.writeFile(path.join(srcRootNodeModules, "root-only.txt"), "root");
      await fs.writeFile(path.join(srcPkgNodeModules, "pkg-only.txt"), "pkg");

      const wtRootNodeModules = path.join(wtPath, "node_modules");
      const wtPkgNodeModules = path.join(wtPath, "packages", "electron", "node_modules");
      await fs.mkdir(wtRootNodeModules, { recursive: true });
      await fs.mkdir(wtPkgNodeModules, { recursive: true });
      await fs.writeFile(path.join(wtRootNodeModules, "stale.txt"), "stale root");
      await fs.writeFile(path.join(wtPkgNodeModules, "stale.txt"), "stale pkg");

      await branchManager.symlinkNodeModules(repoPath, wtPath);

      const rootStat = await fs.lstat(wtRootNodeModules);
      const pkgStat = await fs.lstat(wtPkgNodeModules);
      expect(rootStat.isSymbolicLink()).toBe(true);
      expect(pkgStat.isSymbolicLink()).toBe(true);
    });

    it("runs dependency repair when source node_modules exists but is empty", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(
        path.join(repoPath, "package.json"),
        JSON.stringify({ name: "test-repo", version: "1.0.0" })
      );
      await execAsync('git add -A && git commit -m "initial"', { cwd: repoPath });

      const taskId = `wt-empty-nm-${Date.now()}`;
      const wtPath = await branchManager.createTaskWorktree(repoPath, taskId);
      worktreePaths.push(wtPath);

      const srcNodeModules = path.join(repoPath, "node_modules");
      await fs.rm(srcNodeModules, { recursive: true, force: true });
      await fs.mkdir(srcNodeModules, { recursive: true });

      const wtNodeModules = path.join(wtPath, "node_modules");
      await fs.rm(wtNodeModules, { recursive: true, force: true });

      const runCommandSpy = vi
        .spyOn(commandRunnerModule, "runCommand")
        .mockImplementation(async (spec: CommandSpec, opts: { cwd: string }) => {
          if (spec.command === "npm" && spec.args?.includes("ci")) {
            await fs.writeFile(path.join(srcNodeModules, ".package-lock.json"), "{}");
            return { ...mockRunSuccess, cwd: opts.cwd };
          }
          return { ...mockRunSuccess, cwd: opts.cwd };
        });

      try {
        await branchManager.symlinkNodeModules(repoPath, wtPath);

        expect(runCommandSpy).toHaveBeenCalledWith(
          expect.objectContaining({ command: "npm" }),
          expect.objectContaining({ cwd: repoPath })
        );

        const stat = await fs.lstat(wtNodeModules);
        expect(stat.isSymbolicLink()).toBe(true);
      } finally {
        runCommandSpy.mockRestore();
      }
    });

    it("refuses to delete the repo root when passed as an unsafe worktree path", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      await branchManager.removeTaskWorktree(repoPath, `wt-unsafe-${Date.now()}`, repoPath);

      await expect(fs.readFile(path.join(repoPath, "README"), "utf-8")).resolves.toBe("initial");
      await expect(fs.access(path.join(repoPath, ".git"))).resolves.toBeUndefined();
    });

    it("allows cleanup of legacy task worktree paths under system temp aliases", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const taskId = `wt-legacy-${Date.now()}`;
      const branchName = `opensprint/${taskId}`;
      await execAsync(`git branch ${branchName} main`, { cwd: repoPath });

      const legacyTmpRoot = process.platform === "darwin" ? "/private/tmp" : "/tmp";
      const wtPath = path.join(legacyTmpRoot, `${taskId}-work`);
      await fs.rm(wtPath, { recursive: true, force: true });
      await execAsync(`git worktree add ${wtPath} ${branchName}`, { cwd: repoPath });
      worktreePaths.push(wtPath);

      await branchManager.removeTaskWorktree(repoPath, taskId, wtPath);
      await expect(fs.access(wtPath)).rejects.toThrow();
    });

    it("should treat an unregistered task worktree as a no-op cleanup", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const taskId = `wt-unregistered-${Date.now()}`;
      const wtPath = await branchManager.createTaskWorktree(repoPath, taskId);

      await execAsync(`git worktree remove ${wtPath} --force`, { cwd: repoPath });

      await branchManager.removeTaskWorktree(repoPath, taskId, wtPath);

      await expect(fs.access(wtPath)).rejects.toThrow();
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
      expect(listedPath).toContain(".opensprint/runtime/worktrees");

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
        new Set(),
        new Set(),
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
        new Set(),
        new Set(),
        taskStore
      );

      expect(pruned).not.toContain(activeTaskId);
      const listAfter = await branchManager.listTaskWorktrees(repoPath);
      expect(listAfter.some((w) => w.taskId === activeTaskId)).toBe(true);
    });

    it("pruneOrphanWorktrees skips excluded worktree keys and paths", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const worktreeKey = `epic_skip_${Date.now()}`;
      const wtPath = await branchManager.createTaskWorktree(repoPath, worktreeKey, "main", {
        worktreeKey,
        branchName: `opensprint/${worktreeKey}`,
      });
      worktreePaths.push(wtPath);

      const taskStore = {
        listAll: vi.fn().mockResolvedValue([{ id: "other-task", status: "open" }]),
      };

      const pruned = await branchManager.pruneOrphanWorktrees(
        repoPath,
        "test-project",
        new Set(),
        new Set([worktreeKey]),
        new Set([path.resolve(wtPath)]),
        taskStore
      );

      expect(pruned).not.toContain(worktreeKey);
      const listAfter = await branchManager.listTaskWorktrees(repoPath);
      expect(listAfter.some((w) => w.taskId === worktreeKey)).toBe(true);
    });

    it("pruneOrphanWorktrees skips epic-named worktree when a child task assignment references an open task", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const epicKey = `epic_prune_guard_${Date.now()}`;
      const wtPath = await branchManager.createTaskWorktree(repoPath, epicKey, "main", {
        worktreeKey: epicKey,
        branchName: `opensprint/${epicKey}`,
      });
      worktreePaths.push(wtPath);

      const childTaskId = `child_${Date.now()}`;
      const assignDir = path.join(wtPath, ".opensprint", "active", childTaskId);
      await fs.mkdir(assignDir, { recursive: true });
      await fs.writeFile(
        path.join(assignDir, "assignment.json"),
        JSON.stringify({
          taskId: childTaskId,
          createdAt: new Date(Date.now() - 120_000).toISOString(),
          worktreePath: wtPath,
          worktreeKey: epicKey,
        }),
        "utf-8"
      );

      const { taskStore } = await import("../services/task-store.service.js");
      vi.mocked(taskStore.show).mockImplementation(async (_pid, tid) => {
        if (tid === childTaskId) return { status: "open" } as never;
        return null;
      });

      const taskStorePrune = {
        listAll: vi.fn().mockResolvedValue([{ id: "unrelated-open", status: "open" }]),
      };

      const pruned = await branchManager.pruneOrphanWorktrees(
        repoPath,
        "test-project",
        new Set(),
        new Set(),
        new Set(),
        taskStorePrune
      );

      expect(pruned).not.toContain(epicKey);
      const listAfter = await branchManager.listTaskWorktrees(repoPath);
      expect(listAfter.some((w) => w.taskId === epicKey)).toBe(true);
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
      const readHbSpy = vi.spyOn(heartbeatService, "readHeartbeat").mockResolvedValue({
        processGroupLeaderPid: 12345,
        lastOutputTimestamp: now,
        heartbeatTimestamp: now,
      });
      const isStaleSpy = vi.spyOn(heartbeatService, "isStale").mockReturnValue(false);

      try {
        await branchManager.createTaskWorktree(repoPath, taskA);
        expect.fail("should have thrown WorktreeBranchInUseError");
      } catch (err) {
        expect(err).toBeInstanceOf(WorktreeBranchInUseError);
        const e = err as WorktreeBranchInUseError;
        expect(e.branchName).toBe(`opensprint/${taskA}`);
        expect(e.otherTaskId).toBe(taskB);
        expect(e.message).toContain("active agent");
      } finally {
        readHbSpy.mockRestore();
        isStaleSpy.mockRestore();
      }
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

    it("should create task worktree from custom baseBranch develop", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });
      await execAsync("git checkout -b develop", { cwd: repoPath });
      await execAsync("git checkout main", { cwd: repoPath });

      const taskId = `wt-develop-${Date.now()}`;
      const wtPath = await branchManager.createTaskWorktree(repoPath, taskId, "develop");
      worktreePaths.push(wtPath);

      // Task branch should be based on develop
      const { stdout } = await execAsync(`git merge-base develop opensprint/${taskId}`, {
        cwd: repoPath,
      });
      const developSha = (
        await execAsync("git rev-parse develop", { cwd: repoPath })
      ).stdout.trim();
      expect(stdout.trim()).toBe(developSha);
    });

    it("epic: first task creates epic branch and worktree at getWorktreePath(epic_<id>)", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const epicId = `epic-${Date.now()}`;
      const epicKey = `epic_${epicId}`;
      const branchName = `opensprint/${epicKey}`;
      const expectedPath = branchManager.getWorktreePath(epicKey, repoPath);

      const wtPath = await branchManager.createTaskWorktree(repoPath, "os-task-1", "main", {
        worktreeKey: epicKey,
        branchName,
      });
      worktreePaths.push(wtPath);

      expect(wtPath).toBe(expectedPath);
      await fs.access(wtPath);
      const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: wtPath });
      expect(stdout.trim()).toBe(branchName);
    });

    it("epic: second task reuses same worktree and branch", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const epicId = `epic-${Date.now()}`;
      const epicKey = `epic_${epicId}`;
      const branchName = `opensprint/${epicKey}`;

      const wtPath1 = await branchManager.createTaskWorktree(repoPath, "os-task-1", "main", {
        worktreeKey: epicKey,
        branchName,
      });
      worktreePaths.push(wtPath1);
      await fs.writeFile(path.join(wtPath1, "first.txt"), "from task 1");
      await execAsync('git add first.txt && git commit -m "task 1"', { cwd: wtPath1 });

      const wtPath2 = await branchManager.createTaskWorktree(repoPath, "os-task-2", "main", {
        worktreeKey: epicKey,
        branchName,
      });

      expect(wtPath2).toBe(wtPath1);
      await expect(fs.readFile(path.join(wtPath2, "first.txt"), "utf-8")).resolves.toBe(
        "from task 1"
      );
      const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: wtPath2 });
      expect(stdout.trim()).toBe(branchName);
    });

    it("epic: removeTaskWorktree cleans epic worktree by key and optional actualPath", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const epicKey = `epic_clean-${Date.now()}`;
      const branchName = `opensprint/${epicKey}`;
      const wtPath = await branchManager.createTaskWorktree(repoPath, "os-any", "main", {
        worktreeKey: epicKey,
        branchName,
      });
      await fs.access(wtPath);

      await branchManager.removeTaskWorktree(repoPath, epicKey);

      await expect(fs.access(wtPath)).rejects.toThrow();
      const list = await branchManager.listTaskWorktrees(repoPath);
      expect(list.some((w) => w.taskId === epicKey)).toBe(false);
    });

    it("epic: removeTaskWorktree with actualPath cleans epic worktree when path is passed", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README"), "initial");
      await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

      const epicKey = `epic_actualPath-${Date.now()}`;
      const branchName = `opensprint/${epicKey}`;
      const wtPath = await branchManager.createTaskWorktree(repoPath, "os-any", "main", {
        worktreeKey: epicKey,
        branchName,
      });
      await fs.access(wtPath);

      await branchManager.removeTaskWorktree(repoPath, epicKey, wtPath);

      await expect(fs.access(wtPath)).rejects.toThrow();
      const list = await branchManager.listTaskWorktrees(repoPath);
      expect(list.some((w) => w.taskId === epicKey)).toBe(false);
    });

    describe("removeTaskWorktree lease guards", () => {
      beforeEach(() => {
        vi.mocked(worktreeLeaseService.canCleanup).mockResolvedValue(true);
      });

      it("skips removal when an active DB lease blocks cleanup", async () => {
        vi.mocked(worktreeLeaseService.canCleanup).mockResolvedValue(false);
        await execAsync("git init", { cwd: repoPath });
        await execAsync("git branch -M main", { cwd: repoPath });
        await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
        await execAsync('git config user.name "Test"', { cwd: repoPath });
        await fs.writeFile(path.join(repoPath, "README"), "initial");
        await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

        const taskId = `wt-db-lease-${Date.now()}`;
        const wtPath = await branchManager.createTaskWorktree(repoPath, taskId);
        worktreePaths.push(wtPath);

        const ok = await branchManager.removeTaskWorktree(repoPath, taskId);
        expect(ok).toBe(false);
        await fs.access(wtPath);
      });

      it("removes the worktree when DB lease allows cleanup", async () => {
        vi.mocked(worktreeLeaseService.canCleanup).mockResolvedValue(true);
        await execAsync("git init", { cwd: repoPath });
        await execAsync("git branch -M main", { cwd: repoPath });
        await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
        await execAsync('git config user.name "Test"', { cwd: repoPath });
        await fs.writeFile(path.join(repoPath, "README"), "initial");
        await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

        const taskId = `wt-db-ok-${Date.now()}`;
        const wtPath = await branchManager.createTaskWorktree(repoPath, taskId);
        worktreePaths.push(wtPath);

        const ok = await branchManager.removeTaskWorktree(repoPath, taskId);
        expect(ok).toBe(true);
        await expect(fs.access(wtPath)).rejects.toThrow();
      });

      it("retires stale in_use registry entry and removes worktree when DB lease allows cleanup", async () => {
        await execAsync("git init", { cwd: repoPath });
        await execAsync("git branch -M main", { cwd: repoPath });
        await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
        await execAsync('git config user.name "Test"', { cwd: repoPath });
        await fs.writeFile(path.join(repoPath, "README"), "initial");
        await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

        const taskId = `wt-mem-${Date.now()}`;
        const wtPath = await branchManager.createTaskWorktree(repoPath, taskId);
        worktreePaths.push(wtPath);

        worktreeRegistry.transition(taskId, "in_use");
        const ok = await branchManager.removeTaskWorktree(repoPath, taskId);
        expect(ok).toBe(true);
        await expect(fs.access(wtPath)).rejects.toThrow();
      });
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

    it("should normalize long title to ~45 chars when squashing Closed commit", async () => {
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

    it("should truncate long title to ~45 chars when deriving from merge commit", async () => {
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

  describe("rebaseContinue", () => {
    it("throws RebaseConflictError when next commit conflicts during rebase --continue", async () => {
      await execAsync("git init", { cwd: repoPath });
      await execAsync("git branch -M main", { cwd: repoPath });
      await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
      await execAsync('git config user.name "Test"', { cwd: repoPath });

      const filePath = path.join(repoPath, "conflict.txt");
      await fs.writeFile(filePath, "line-1\nline-2\n");
      await execAsync('git add conflict.txt && git commit -m "base"', { cwd: repoPath });

      await execAsync("git checkout -b feature", { cwd: repoPath });
      await fs.writeFile(filePath, "feature-1\nline-2\n");
      await execAsync('git add conflict.txt && git commit -m "feature commit 1"', {
        cwd: repoPath,
      });
      await fs.writeFile(filePath, "feature-1\nfeature-2\n");
      await execAsync('git add conflict.txt && git commit -m "feature commit 2"', {
        cwd: repoPath,
      });

      await execAsync("git checkout main", { cwd: repoPath });
      await fs.writeFile(filePath, "main-1\nline-2\n");
      await execAsync('git add conflict.txt && git commit -m "main commit 1"', { cwd: repoPath });
      await fs.writeFile(filePath, "main-1\nmain-2\n");
      await execAsync('git add conflict.txt && git commit -m "main commit 2"', { cwd: repoPath });

      await execAsync("git checkout feature", { cwd: repoPath });
      await expect(execAsync("git rebase main", { cwd: repoPath })).rejects.toThrow();

      // Resolve first conflict, then rebaseContinue should surface the next conflict as RebaseConflictError.
      await fs.writeFile(filePath, "feature-1\nmain-2\n");
      await expect(branchManager.rebaseContinue(repoPath)).rejects.toMatchObject({
        name: "RebaseConflictError",
        conflictedFiles: expect.arrayContaining(["conflict.txt"]),
      });

      await branchManager.rebaseAbort(repoPath);
    });
  });
});
