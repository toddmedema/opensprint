import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initAppDb, type AppDb } from "../db/app-db.js";
const state = vi.hoisted(() => ({
  repo: "",
  current: true,
  db: null as AppDb | null,
  gate: vi.fn(),
  queue: vi.fn(),
}));
vi.mock("../services/project.service.js", () => ({
  ProjectService: vi.fn().mockImplementation(() => ({
    getProject: async () => ({ repoPath: state.repo }),
    getSettings: async () => ({
      toolchainProfile: { mergeQualityGateCommands: ["build", "test"] },
    }),
  })),
}));
vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    show: async () => ({ title: "Implement feature", description: "" }),
    getDb: () => state.db!.getClient(),
    runWrite: (fn: Parameters<AppDb["runWrite"]>[0]) => state.db!.runWrite(fn),
  },
}));
vi.mock("../services/execution-ownership.service.js", () => ({
  executionOwnershipService: {
    assertCurrent: async () => {
      if (!state.current) throw new Error("Stale owner");
    },
    fenced: async (_fence: unknown, fn: Parameters<AppDb["runWrite"]>[0]) => {
      if (!state.current) throw new Error("Stale owner");
      return state.db!.runWrite(fn);
    },
  },
}));
vi.mock("../services/agent/isolated-runner.js", () => ({ runIsolatedCommand: state.gate }));
vi.mock("../services/git-commit-queue.service.js", () => ({
  gitCommitQueue: {
    enqueueAndWait: async (job: { run(): Promise<void> }) => {
      await state.queue();
      return job.run();
    },
  },
}));
import {
  publishWorkerArtifact,
  reconcileWorkerArtifact,
} from "../services/worker-artifact-publisher.service.js";
const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim();
describe("trusted worker artifact publisher", () => {
  let root: string, worktree: string, bundle: string, base: string;
  const fence = {
    projectId: "project",
    taskId: "task",
    runKey: "task:coder",
    attemptId: "attempt",
    ownerId: "owner",
    generation: 1,
  };
  beforeEach(async () => {
    state.current = true;
    state.db = await initAppDb("sqlite://:memory:");
    await (
      await state.db.getClient()
    ).execute(
      `INSERT INTO execution_leases
      (project_id,run_key,task_id,attempt_id,owner_id,generation,expires_ms,state,updated_at)
      VALUES ('project','task:coder','task','attempt','owner',1,$1,'running',$2)`,
      [Date.now() + 60_000, new Date().toISOString()]
    );
    state.gate.mockReset().mockResolvedValue({ exitCode: 0, output: "Passed" });
    state.queue.mockReset().mockResolvedValue(undefined);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-artifact-test-"));
    state.repo = path.join(root, "repo");
    await fs.mkdir(state.repo);
    await git(state.repo, "init", "-b", "main");
    await git(state.repo, "config", "user.name", "Test");
    await git(state.repo, "config", "user.email", "test@example.test");
    await fs.writeFile(path.join(state.repo, "source.txt"), "Original\n");
    await fs.writeFile(path.join(state.repo, ".gitattributes"), "*.txt text eol=lf\n");
    await git(state.repo, "add", ".");
    await git(state.repo, "commit", "-m", "Initial");
    base = await git(state.repo, "rev-parse", "HEAD");
    worktree = path.join(root, "task");
    await git(state.repo, "worktree", "add", "-b", "opensprint/task", worktree);
    const worker = path.join(root, "worker");
    await git(root, "clone", "--no-local", state.repo, worker);
    await git(worker, "config", "user.name", "Worker");
    await git(worker, "config", "user.email", "worker@example.test");
    await git(worker, "checkout", "-b", "submission");
    await fs.writeFile(path.join(worker, "source.txt"), "Implemented\n");
    await git(worker, "add", ".");
    await git(worker, "commit", "-m", "Feature");
    bundle = path.join(root, "worker.bundle");
    await git(worker, "bundle", "create", bundle, "refs/heads/submission");
  });
  afterEach(async () => {
    await state.db?.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const publish = () =>
    publishWorkerArtifact({
      fence,
      bundlePath: bundle,
      expectedBase: base,
      branchName: "opensprint/task",
      targetWorktreePath: worktree,
    });
  it("validates one immutable bundle in isolated gates and publishes only its prepared branch", async () => {
    const result = await publish();
    expect(await git(state.repo, "rev-parse", "HEAD")).toBe(base);
    expect(await git(worktree, "rev-parse", "HEAD")).toBe(result.commitSha);
    expect(
      (await fs.readFile(path.join(worktree, "source.txt"), "utf8")).replace(/\r\n/g, "\n")
    ).toBe("Implemented\n");
    expect(state.gate).toHaveBeenCalledOnce();
    expect(state.gate.mock.calls[0]?.[1]).toBe("(build) && (test)");
    expect(await reconcileWorkerArtifact("project", "attempt", 1, worktree)).toBe("published");
  });
  it("rejects a stale owner after gates before any task branch advancement", async () => {
    state.gate.mockImplementation(async () => {
      state.current = false;
      return { exitCode: 0, output: "Passed" };
    });
    await expect(publish()).rejects.toThrow("Stale owner");
    expect(await git(worktree, "rev-parse", "HEAD")).toBe(base);
  });
  it("rejects a renamed control file instead of inspecting only its new name", async () => {
    const worker = path.join(root, "worker");
    await git(worker, "mv", ".gitattributes", "notes.md");
    await git(worker, "commit", "-m", "Rename instructions");
    await fs.unlink(bundle);
    await git(worker, "bundle", "create", bundle, "refs/heads/submission");
    await expect(publish()).rejects.toThrow("control-plane");
    expect(state.gate).not.toHaveBeenCalled();
    expect(await git(worktree, "rev-parse", "HEAD")).toBe(base);
  });
  it.each(["gates", "canonical queue"])(
    "rejects cancellation during %s before advancing the prepared branch",
    async (stage) => {
      const stop = async () => {
        await (
          await state.db!.getClient()
        ).execute("UPDATE execution_leases SET state='stop_requested' WHERE project_id='project'");
      };
      if (stage === "gates")
        state.gate.mockImplementation(async () => {
          await stop();
          return { exitCode: 0, output: "Passed" };
        });
      else state.queue.mockImplementation(stop);
      await expect(publish()).rejects.toThrow("stopped or completed");
      expect(await git(worktree, "rev-parse", "HEAD")).toBe(base);
      expect(await git(state.repo, "rev-parse", "HEAD")).toBe(base);
      expect(await reconcileWorkerArtifact("project", "attempt", 1, worktree)).toBe(
        stage === "gates" ? null : "uncertain"
      );
    }
  );
  it("leaves an interrupted checkout explicitly uncertain without replaying the write", async () => {
    const result = await publish();
    await git(worktree, "reset", "--hard", base);
    expect(await reconcileWorkerArtifact("project", "attempt", 1, worktree)).toBe("uncertain");
    expect(await git(worktree, "rev-parse", "HEAD")).toBe(base);
    expect(result.commitSha).not.toBe(base);
  });
  it.each(["symlink", "case-folded-control-file"])(
    "rejects a %s before trusted checkout or gates",
    async (kind) => {
      const worker = path.join(root, "worker");
      const filename = kind === "symlink" ? "host-link" : "agents.md";
      await fs.writeFile(path.join(worker, filename), "../../private-host-data");
      await git(worker, "add", "--", filename);
      if (kind === "symlink") {
        const hash = await git(worker, "hash-object", "-w", filename);
        await git(worker, "update-index", "--cacheinfo", `120000,${hash},${filename}`);
      }
      await git(worker, "commit", "-m", "Untrusted surface");
      await fs.unlink(bundle);
      await git(worker, "bundle", "create", bundle, "refs/heads/submission");
      await expect(publish()).rejects.toThrow(kind === "symlink" ? "symlinks" : "control-plane");
      expect(state.gate).not.toHaveBeenCalled();
      expect(await git(worktree, "rev-parse", "HEAD")).toBe(base);
    }
  );
});
