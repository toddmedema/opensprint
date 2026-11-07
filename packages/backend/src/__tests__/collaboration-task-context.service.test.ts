import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Project, ProjectSettings } from "@opensprint/shared";
import type { StoredTask } from "../services/task-store.service.js";
import {
  CollaborationTaskContextService,
  type CollaborationExecutionSnapshot,
} from "../services/collaboration-task-context.service.js";
import { initAppDb } from "../db/app-db.js";
import * as commandRunner from "../utils/command-runner.js";
import { createTestPostgresClient, createTestProjectId } from "./test-db-helper.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout;
const task: StoredTask = {
  id: "os-task",
  project_id: "project-a",
  title: "Preserve filters",
  status: "in_progress",
  issue_type: "task",
  priority: 2,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-06T10:00:00Z",
};
const patch = (filename: string, content = "safe neighbor") =>
  `diff --git a/${filename} b/${filename}\nindex 1111111..2222222 100644\n--- a/${filename}\n+++ b/${filename}\n@@ -1 +1 @@\n-old\n+${content}\n`;
const unsafeArchiveDiff = () =>
  [
    patch(".env", "root-secret"),
    patch("packages/api/.env.production", "nested-secret"),
    patch(".ENV", "DATABASE_URL=postgres://private/upper-root-secret"),
    patch("packages/api/.ENV.production", "DATABASE_URL=postgres://private/upper-nested-secret"),
    patch(".OpenSprint/assignment.json", "upper-runtime-secret"),
    patch("packages/api/Node_Modules/secret/index.js", "upper-dependency-secret"),
    patch(".GiT/config", "upper-git-secret"),
    patch(".ｅｎｖ", "DATABASE_URL=postgres://private/unicode-env-secret"),
    patch(".openſprint/assignment.json", "unicode-runtime-secret"),
    patch(".opensprint/assignment.json", "runtime-secret"),
    patch("packages/api/.opensprint/run.json", "nested-runtime-secret"),
    patch("node_modules/secret/index.js", "dependency-secret"),
    patch("packages/api/node_modules/secret/index.js", "nested-dependency-secret"),
    'diff --git "a/src/\\056env" "b/src/\\056env"\n--- "a/src/\\056env"\n+++ "b/src/\\056env"\n@@ -1 +1 @@\n+quoted-secret\n',
    "diff --git a/src/app.ts b/src/moved.ts\nsimilarity index 100%\nrename from .env\nrename to src/moved.ts\n",
    "diff --git a/src/binary.bin b/src/binary.bin\nGIT binary patch\nliteral 10\nbinary-secret\n",
    "diff --cc src/combined.ts\ncombined-secret\n",
    "diff --git a/src/unknown.ts b/src/unknown.ts\nunknown metadata\nunknown-secret\n",
    patch("src/safe.ts", "safe-neighbor"),
    patch("src/key-example.ts", "SERVICE_TOKEN=known-secret"),
  ].join("");

describe("CollaborationTaskContextService", () => {
  let directory: string;
  let service: CollaborationTaskContextService;
  let execution: CollaborationExecutionSnapshot | null;
  const readExecution = vi.fn<() => CollaborationExecutionSnapshot | null>();
  const getActiveRun = vi.fn();
  const show = vi.fn();
  const listAll = vi.fn();
  const query = vi.fn();
  const queryOne = vi.fn();
  const projectService = {
    getProject: vi.fn(),
    getSettings: vi.fn(),
  };
  const getDb = vi.fn();

  beforeEach(async () => {
    vi.resetAllMocks();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-shared-context-"));
    await git(directory, "init", "--initial-branch=main");
    await fs.writeFile(path.join(directory, "app.ts"), "export const enabled = false;\n");
    await git(directory, "add", "app.ts");
    await git(directory, "commit", "-m", "initial source");
    await git(directory, "switch", "-c", "opensprint/os-task");
    execution = {
      attemptId: "attempt-2",
      attempt: 2,
      branchName: "opensprint/os-task",
      worktreePath: directory,
      output: ["Checking navigation…\n"],
      uncertain: false,
    };
    readExecution.mockImplementation(() => execution);
    getActiveRun.mockReturnValue({
      taskId: task.id,
      attemptId: "attempt-2",
      attempt: 2,
      supported: true,
      reason: null,
    });
    projectService.getProject.mockResolvedValue({
      id: "project-a",
      name: "Shared sample",
      repoPath: directory,
    } as Project);
    projectService.getSettings.mockResolvedValue({ worktreeBaseBranch: "main" } as ProjectSettings);
    show.mockResolvedValue(task);
    listAll.mockResolvedValue([task]);
    query.mockResolvedValue([]);
    queryOne.mockResolvedValue(null);
    getDb.mockResolvedValue({ query, queryOne });
    service = new CollaborationTaskContextService({
      projectService,
      taskStore: { show, listAll, getDb },
      readExecution,
      getActiveRun,
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("validates project and task membership before inspecting an execution", async () => {
    show.mockRejectedValue(Object.assign(new Error("Unknown project task"), { statusCode: 404 }));
    await expect(service.getTaskContext("project-a", "foreign-task")).rejects.toThrow(
      "Unknown project task"
    );
    expect(show).toHaveBeenCalledWith("project-a", "foreign-task");
    expect(readExecution).not.toHaveBeenCalled();
    expect(getActiveRun).not.toHaveBeenCalled();
    expect(getDb).not.toHaveBeenCalled();
    await expect(service.assertTaskExists("project-a", "foreign-task")).rejects.toThrow();
  });

  it("returns task catch-up fields and only unresolved Execute questions", async () => {
    listAll.mockResolvedValue([
      {
        ...task,
        completed_at: "2026-11-06T10:30:00Z",
        last_execution_summary: {
          at: "2026-11-06T10:30:00Z",
          attempt: 2,
          outcome: "success",
          phase: "coding",
          summary: "Implemented navigation state",
        },
      },
    ]);
    query.mockResolvedValue([
      { source_id: task.id, questions: JSON.stringify([{ text: "Should filters be shareable?" }]) },
      { source_id: task.id, questions: "malformed" },
    ]);
    const overview = await service.getOverview("project-a");
    expect(overview.projectName).toBe("Shared sample");
    expect(Number.isFinite(Date.parse(overview.observedAt!))).toBe(true);
    expect(overview.tasks[0]).toMatchObject({
      id: task.id,
      updatedAt: task.updated_at,
      completedAt: "2026-11-06T10:30:00Z",
      summary: "Implemented navigation state",
      questions: ["Should filters be shareable?"],
    });
    expect(query.mock.calls[0]?.[1]).toEqual(["project-a"]);
  });

  it("shows committed, staged and tracked working source changes without changing the index", async () => {
    await fs.writeFile(path.join(directory, "app.ts"), "export const enabled = true;\n");
    await git(directory, "add", "app.ts");
    await git(directory, "commit", "-m", "implement filter state");
    await fs.writeFile(
      path.join(directory, "app.ts"),
      "export const enabled = true;\nexport const shared = true;\n"
    );
    await git(directory, "add", "app.ts");
    await fs.writeFile(path.join(directory, "new-file.ts"), "export const page = 1;\n");
    await git(directory, "add", "new-file.ts");
    await fs.writeFile(path.join(directory, "untracked.ts"), "untracked content stays private\n");
    await fs.appendFile(path.join(directory, "app.ts"), "export const working = true;\n");
    await fs.writeFile(path.join(directory, ".env"), "PRIVATE_SECRET=should-not-appear\n");
    await fs.mkdir(path.join(directory, ".opensprint"));
    await fs.writeFile(path.join(directory, ".opensprint", "secret.json"), "private-runtime-data");
    const before = await git(directory, "diff", "--cached");
    const context = await service.getTaskContext("project-a", task.id);
    expect(context).toMatchObject({
      source: "active",
      sourceAttempt: 2,
      sourceAttemptId: "attempt-2",
      activeRun: { attemptId: "attempt-2" },
      output: "Checking navigation…\n",
    });
    expect(context.diff).toContain("+export const enabled = true;");
    expect(context.diff).toContain("+export const shared = true;");
    expect(context.diff).toContain("new-file.ts");
    expect(context.diff).toContain("+export const working = true;");
    expect(context.diff).not.toContain("untracked content stays private");
    expect(context.diff).not.toContain("untracked.ts");
    expect(context.diff).not.toContain("PRIVATE_SECRET");
    expect(context.diff).not.toContain("private-runtime-data");
    expect(context.diffRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(context.unavailableReason).toBeUndefined();
    expect(await git(directory, "diff", "--cached")).toBe(before);
    expect((await git(directory, "status", "--porcelain")).trim()).toContain("?? untracked.ts");
  });

  it("omits new untracked source until it is explicitly staged", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const filename = path.join(directory, "new-source.ts");
    await fs.writeFile(filename, "export const newlyAdded = true;\n");
    const initial = await service.getTaskContext("project-a", task.id);
    expect(initial.diff).not.toContain("newlyAdded");
    expect((await git(directory, "status", "--porcelain")).trim()).toContain("?? new-source.ts");
    await git(directory, "add", "new-source.ts");
    const before = await git(directory, "diff", "--cached");
    clock.mockReturnValue(4_001);
    const staged = await service.getTaskContext("project-a", task.id);
    expect(staged.diff).toContain("+export const newlyAdded = true;");
    expect(await git(directory, "diff", "--cached")).toBe(before);
  });

  it("cannot expose an untracked file through a parent link swapped during context IO", async () => {
    const external = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-private-untracked-"));
    try {
      const privateContent = "host file content that has no recognizable credential pattern";
      await fs.writeFile(path.join(external, "new-source.ts"), privateContent);
      const source = path.join(directory, "src");
      await fs.mkdir(source);
      await fs.writeFile(path.join(source, "new-source.ts"), "ordinary untracked source\n");
      const run = commandRunner.runCommand;
      vi.spyOn(commandRunner, "runCommand").mockImplementation(async (command, options) => {
        if (command.args?.includes("diff")) {
          await fs.rm(source, { recursive: true, force: true });
          await fs.symlink(external, source, "junction");
        }
        return run(command, options);
      });
      const context = await service.getTaskContext("project-a", task.id);
      expect(context.diff).not.toContain(privateContent);
      expect(context.diff).not.toContain("new-source.ts");
      expect(context.unavailableReason).toBeUndefined();
      expect(await fs.readFile(path.join(source, "new-source.ts"), "utf8")).toBe(privateContent);
    } finally {
      await fs.rm(external, { recursive: true, force: true });
    }
  });

  it("never opens untracked content after an attacker can replace its inspected parent", async () => {
    const external = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-private-untracked-race-"));
    try {
      const privateContent = "private host bytes behind a replaced source directory";
      await fs.writeFile(path.join(external, "new-source.ts"), privateContent);
      const source = path.join(directory, "src");
      const filename = path.join(source, "new-source.ts");
      await fs.mkdir(source);
      await fs.writeFile(filename, "ordinary untracked source\n");
      const inspect = fs.lstat;
      const inspections = vi
        .spyOn(fs, "lstat")
        .mockImplementation(async (candidate, ...options) => {
          const stat = await inspect(candidate, ...options);
          if (String(candidate) === filename) {
            await fs.rm(source, { recursive: true, force: true });
            await fs.symlink(external, source, "junction");
          }
          return stat;
        });
      const context = await service.getTaskContext("project-a", task.id);
      expect(context.diff).not.toContain(privateContent);
      expect(context.diff).not.toContain("ordinary untracked source");
      expect(inspections.mock.calls.some(([candidate]) => String(candidate) === filename)).toBe(
        false
      );
      expect(context.unavailableReason).toBeUndefined();
    } finally {
      await fs.rm(external, { recursive: true, force: true });
    }
  });

  it("captures the catch-up observation boundary before loading tasks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-06T10:00:00Z"));
    projectService.getProject.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-11-06T10:01:00Z"));
      return { id: "project-a", name: "Shared sample", repoPath: directory } as Project;
    });
    const overview = await service.getOverview("project-a");
    expect(overview.observedAt).toBe("2026-11-06T10:00:00.000Z");
    vi.useRealTimers();
  });

  it("excludes case-equivalent sensitive paths from the live projection", async () => {
    await fs.writeFile(
      path.join(directory, ".ENV"),
      "DATABASE_URL=postgres://private/live-upper-root-secret\n"
    );
    await fs.mkdir(path.join(directory, "packages/api"), { recursive: true });
    await fs.writeFile(
      path.join(directory, "packages/api/.ENV.production"),
      "DATABASE_URL=postgres://private/live-upper-nested-secret\n"
    );
    await fs.mkdir(path.join(directory, ".OpenSprint"), { recursive: true });
    await fs.writeFile(
      path.join(directory, ".OpenSprint/assignment.json"),
      "live-upper-runtime-secret\n"
    );
    await fs.mkdir(path.join(directory, "packages/api/Node_Modules"), { recursive: true });
    await fs.writeFile(
      path.join(directory, "packages/api/Node_Modules/index.js"),
      "live-upper-dependency-secret\n"
    );
    await fs.writeFile(path.join(directory, "neighbor.ts"), "export const shared = true;\n");
    await git(directory, "add", "--force", ".");
    const context = await service.getTaskContext("project-a", task.id);
    expect(context.diff).toContain("+export const shared = true;");
    expect(context.diff).not.toContain("live-upper-");
    expect(context.diff).not.toContain("DATABASE_URL");
  });

  it("will not inspect a different repository placed at a trusted-looking worktree path", async () => {
    const other = path.join(directory, "other-repo");
    await fs.mkdir(other);
    await git(other, "init", "--initial-branch=main");
    await fs.writeFile(path.join(other, "secret.txt"), "foreign-project-content");
    await git(other, "add", ".");
    await git(other, "commit", "-m", "foreign content");
    await git(other, "switch", "-c", "opensprint/os-task");
    execution!.worktreePath = other;
    const context = await service.getTaskContext("project-a", task.id);
    expect(context.diff).toBe("");
    expect(context.unavailableReason).toMatch(/could not be verified/);
  });

  it("will not show changes after the checkout is switched away from the task branch", async () => {
    await git(directory, "switch", "main");
    await fs.writeFile(path.join(directory, "app.ts"), "unrelated edits\n");
    const context = await service.getTaskContext("project-a", task.id);
    expect(context.diff).toBe("");
    expect(context.unavailableReason).toBeTruthy();
  });

  it("does not treat unverified recovered execution as a live shared run", async () => {
    execution!.uncertain = true;
    const context = await service.getTaskContext("project-a", task.id);
    expect(context).toMatchObject({ source: "none", activeRun: null, output: "", diff: "" });
    expect(context.unavailableReason).toMatch(/ownership is being verified/);
    expect(projectService.getSettings).not.toHaveBeenCalled();
  });

  it("rejects a response when an attempt is replaced during context IO", async () => {
    readExecution
      .mockReturnValueOnce(execution)
      .mockReturnValue({ ...execution!, attemptId: "attempt-3", attempt: 3 });
    await expect(service.getTaskContext("project-a", task.id)).rejects.toMatchObject({
      code: "AGENT_ATTEMPT_CHANGED",
      statusCode: 409,
    });
  });

  it("keeps the newest bounded display output after redaction", async () => {
    execution!.output = ["old".repeat(100_000), "newest output"];
    const context = await service.getTaskContext("project-a", task.id);
    expect(context.output.length).toBe(256 * 1024);
    expect(context.output.endsWith("newest output")).toBe(true);
    expect(context.outputTruncated).toBe(true);
  });

  it("redacts a credential across provider events before the display boundary removes its prefix", async () => {
    const secret = "split-event-credential";
    execution!.output = [
      "SERVICE_",
      "TOKEN=",
      secret,
      "\n",
      "x".repeat(256 * 1024 - secret.length - 1),
    ];
    const context = await service.getTaskContext("project-a", task.id);
    expect(context.output).not.toContain(secret);
    expect(context.output).toContain("[REDACTED]");
    expect(context.outputTruncated).toBe(true);
    expect(Buffer.byteLength(context.output, "utf8")).toBeLessThanOrEqual(256 * 1024);
  });

  it("omits a partial credential prefix already evicted by the managed runner", async () => {
    execution!.output = [
      "evicted-prefix-credential\n",
      "Safe later output\nSERVICE_TOKEN=complete-credential",
    ];
    execution!.outputTruncated = true;
    const context = await service.getTaskContext("project-a", task.id);
    expect(context.output).toBe("Safe later output\nSERVICE_TOKEN=[REDACTED]");
    expect(context.outputTruncated).toBe(true);
  });

  it("keeps a valid UTF-8 tail within the byte budget", async () => {
    execution!.output = ["🧭".repeat(70_000), "newest"];
    const context = await service.getTaskContext("project-a", task.id);
    expect(Buffer.byteLength(context.output, "utf8")).toBeLessThanOrEqual(256 * 1024);
    expect(context.output).not.toContain("�");
    expect(context.output.endsWith("newest")).toBe(true);
  });

  it.each(["file", "parent"])("never follows an agent-writable output %s symlink", async (kind) => {
    const external = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-private-output-"));
    try {
      const privateOutput = "private-host-material-without-a-recognizable-secret-prefix";
      await fs.writeFile(path.join(external, "agent-output.log"), privateOutput);
      const active = path.join(directory, ".opensprint", "active", task.id);
      await fs.mkdir(path.dirname(active), { recursive: true });
      if (kind === "parent") {
        await fs.symlink(external, active, "junction");
      } else {
        await fs.mkdir(active);
        await fs.symlink(
          path.join(external, "agent-output.log"),
          path.join(active, "agent-output.log")
        );
      }
      execution!.output = [];
      const context = await service.getTaskContext("project-a", task.id);
      expect(context.output).toBe("");
      expect(JSON.stringify(context)).not.toContain(privateOutput);
      expect(context.unavailableReason).toBeUndefined();
    } finally {
      await fs.rm(external, { recursive: true, force: true });
    }
  });

  it("shares only managed output even when an ordinary checkout log exists", async () => {
    const active = path.join(directory, ".opensprint", "active", task.id);
    await fs.mkdir(active, { recursive: true });
    await fs.writeFile(path.join(active, "agent-output.log"), "Agent-writable disk output");
    execution!.output = [];
    expect((await service.getTaskContext("project-a", task.id)).output).toBe("");
    execution!.output = ["Managed live output"];
    expect((await service.getTaskContext("project-a", task.id)).output).toBe("Managed live output");
  });

  it("does not share recovered output tailed from an agent-writable checkout", async () => {
    await fs.writeFile(path.join(directory, "app.ts"), "verified source change\n");
    execution!.output = ["private host file bytes with no recognizable credential pattern"];
    execution!.outputFromFile = true;
    const context = await service.getTaskContext("project-a", task.id);
    expect(context.output).toBe("");
    expect(context.diff).toContain("+verified source change");
    expect(context.source).toBe("active");
    expect(context.unavailableReason).toBeUndefined();
  });

  it("shares one read across simultaneous followers without retaining stale results", async () => {
    const [first, second] = await Promise.all([
      service.getTaskContext("project-a", task.id),
      service.getTaskContext("project-a", task.id),
    ]);
    expect(first).toEqual(second);
    expect(show).toHaveBeenCalledTimes(1);
    execution!.output = ["New output after the shared read"];
    const refreshed = await service.getTaskContext("project-a", task.id);
    expect(refreshed.output).toBe("New output after the shared read");
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("reuses expensive diffs across staggered viewers while verifying ownership and keeping output fresh", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const commands = vi.spyOn(commandRunner, "runCommand");
    await fs.mkdir(path.join(directory, "src"));
    for (let index = 0; index < 24; index++) {
      await fs.writeFile(
        path.join(directory, "src", `source-${index}.ts`),
        `export const n = ${index};\n`
      );
    }
    await git(directory, "add", "src");
    const first = await service.getTaskContext("project-a", task.id);
    expect(first.diff).toContain("source-23.ts");
    const firstReadCommands = commands.mock.calls.length;
    expect(firstReadCommands).toBe(6);
    const started = performance.now();
    for (let viewer = 1; viewer < 5; viewer++) {
      execution!.output = [`Latest output for viewer ${viewer}`];
      const current = await service.getTaskContext("project-a", task.id);
      expect(current.output).toBe(`Latest output for viewer ${viewer}`);
      expect(current.diff).toBe(first.diff);
    }
    // Every later read still proves repository common-dir and task branch with
    // three Git checks, while reusing the bounded aggregate patch.
    expect(commands.mock.calls.length - firstReadCommands).toBe(4 * 3);
    console.info(
      JSON.stringify({
        contextViewers: 5,
        stagedSourceFiles: 24,
        firstReadGitCommands: firstReadCommands,
        laterViewersGitCommands: commands.mock.calls.length - firstReadCommands,
        uncachedEquivalentGitCommands: firstReadCommands * 5,
        elapsedLaterViewersMs: Math.round(performance.now() - started),
      })
    );
    await fs.writeFile(
      path.join(directory, "src", "source-23.ts"),
      "export const changed = true;\n"
    );
    clock.mockReturnValue(4_001);
    const refreshed = await service.getTaskContext("project-a", task.id);
    expect(refreshed.diff).toContain("+export const changed = true;");
    expect(commands.mock.calls.length).toBe(firstReadCommands + 4 * 3 + firstReadCommands);
  });

  it("does not reuse cached diffs after attempt, base settings or checkout ownership changes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const commands = vi.spyOn(commandRunner, "runCommand");
    await fs.writeFile(path.join(directory, "app.ts"), "first change\n");
    await service.getTaskContext("project-a", task.id);
    await fs.writeFile(path.join(directory, "app.ts"), "new attempt change\n");
    execution = { ...execution!, attemptId: "attempt-3", attempt: 3 };
    getActiveRun.mockReturnValue({
      taskId: task.id,
      attemptId: "attempt-3",
      attempt: 3,
      supported: true,
      reason: null,
    });
    expect((await service.getTaskContext("project-a", task.id)).diff).toContain(
      "+new attempt change"
    );
    await fs.writeFile(path.join(directory, "app.ts"), "new comparison change\n");
    projectService.getSettings.mockResolvedValue({
      worktreeBaseBranch: "opensprint/os-task",
    } as ProjectSettings);
    expect((await service.getTaskContext("project-a", task.id)).diff).toContain(
      "+new comparison change"
    );
    await git(directory, "switch", "main");
    const context = await service.getTaskContext("project-a", task.id);
    expect(context.diff).toBe("");
    expect(context.unavailableReason).toBeTruthy();
    show.mockRejectedValue(new Error("Task was deleted"));
    await expect(service.getTaskContext("project-a", task.id)).rejects.toThrow("Task was deleted");
    expect(commands.mock.calls.length).toBeGreaterThan(3);
  });

  it("retries failed diff reads instead of retaining an error in the cache", async () => {
    projectService.getSettings.mockRejectedValueOnce(new Error("Settings unavailable"));
    await fs.writeFile(path.join(directory, "app.ts"), "visible after retry\n");
    expect((await service.getTaskContext("project-a", task.id)).unavailableReason).toBeTruthy();
    const context = await service.getTaskContext("project-a", task.id);
    expect(context.diff).toContain("+visible after retry");
    expect(context.unavailableReason).toBeUndefined();
  });

  it("does not share mutable response objects between simultaneous followers", async () => {
    const [first, second] = await Promise.all([
      service.getTaskContext("project-a", task.id),
      service.getTaskContext("project-a", task.id),
    ]);
    first.task.title = "Changed by one caller";
    first.activeRun!.control = { runId: "attempt-2", controllerId: "caller", revision: 1 };
    expect(second.task.title).toBe(task.title);
    expect(second.activeRun!.control).toBeUndefined();
  });

  it("bounds large live diffs and marks the prefix as truncated", async () => {
    await fs.writeFile(path.join(directory, "app.ts"), "new-line\n".repeat(50_000));
    const context = await service.getTaskContext("project-a", task.id);
    expect(context.diff.length).toBeLessThanOrEqual(256 * 1024);
    expect(context.diffTruncated).toBe(true);
    expect(context.diff).toContain("+new-line");
  });

  it("reads an archived latest attempt without pretending it is an active run", async () => {
    execution = null;
    queryOne.mockResolvedValue({
      attempt: 5,
      output: "partial leading line\narchived output",
      diff: patch("src/archive.ts", "archived diff"),
      output_length: 900_000,
      diff_length: 5,
    });
    const context = await service.getTaskContext("project-a", task.id);
    expect(context).toMatchObject({
      activeRun: null,
      source: "archived",
      sourceAttempt: 5,
      output: "archived output",
      outputTruncated: true,
    });
    expect(context.diff).toContain("+archived diff");
    expect(queryOne.mock.calls[0]?.[1]).toEqual(["project-a", task.id, 256 * 1024]);
    expect(getActiveRun).not.toHaveBeenCalled();
  });

  it("applies the same conservative path and known-credential filter to historical patches", async () => {
    execution = null;
    queryOne.mockResolvedValue({
      attempt: 5,
      output: "SERVICE_TOKEN=archived-credential",
      diff: unsafeArchiveDiff(),
      output_length: 33,
      diff_length: 2000,
    });
    const context = await service.getTaskContext("project-a", task.id);
    expect(context.diff).toContain("safe-neighbor");
    expect(context.diff).toContain("SERVICE_TOKEN=[REDACTED]");
    for (const secret of [
      "root-secret",
      "nested-secret",
      "upper-root-secret",
      "upper-nested-secret",
      "upper-runtime-secret",
      "upper-dependency-secret",
      "upper-git-secret",
      "unicode-env-secret",
      "unicode-runtime-secret",
      "runtime-secret",
      "nested-runtime-secret",
      "dependency-secret",
      "nested-dependency-secret",
      "quoted-secret",
      "binary-secret",
      "combined-secret",
      "unknown-secret",
      "known-secret",
    ])
      expect(context.diff).not.toContain(secret);
    expect(context.output).not.toContain("archived-credential");
    expect(context.output).toContain("[REDACTED]");
  });

  it("discards an archived credential fragment whose prefix was cut by the bounded SQL read", async () => {
    execution = null;
    queryOne.mockResolvedValue({
      attempt: 5,
      output: "cut-credential-value\nUseful neighbor\nSERVICE_TOKEN=full-value",
      output_length: 900_000,
    });
    const context = await service.getTaskContext("project-a", task.id);
    expect(context.output).toBe("Useful neighbor\nSERVICE_TOKEN=[REDACTED]");
    expect(context.outputTruncated).toBe(true);
    queryOne.mockResolvedValue({
      attempt: 5,
      output: "SERVICE_TOKEN=\nnext-line-credential\nSafe later output",
      output_length: 900_000,
    });
    expect((await service.getTaskContext("project-a", task.id)).output).toBe("Safe later output");
    queryOne.mockResolvedValue({
      attempt: 5,
      output: "uncertain-long-line-secret",
      output_length: 900_000,
    });
    expect((await service.getTaskContext("project-a", task.id)).output).toBe("");
  });

  it.each([
    ["OKEN=\npartial-env-value\nsafe", "safe"],
    ["earer\n\n \t\npartial-bearer-value\nsafe", "safe"],
    ["uthorization:\n\npartial-header-value\nsafe", "safe"],
    ["OKEN\n=\npartial-env-value\nsafe", "safe"],
    ["uthorization\n \n:\n partial-header-value\nsafe", "safe"],
    ["\n\npartial-value\nsafe", "safe"],
    ["ordinary-cut-value\nsafe neighbor\nfinal", "safe neighbor\nfinal"],
    ["SERVICE_TOKEN=\ncomplete-env-value\nsafe", "safe"],
    ["Bearer\ncomplete-bearer-value-which-is-long-enough\nsafe", "safe"],
    ["OKEN\n=inline-env-value\nsafe", "safe"],
    ["uthorization\n: inline header value\nsafe", "safe"],
  ])(
    "omits possible multiline credential continuations in an archived bounded tail (%s)",
    async (output, expected) => {
      execution = null;
      queryOne.mockResolvedValue({ attempt: 5, output, output_length: 900_000 });
      const context = await service.getTaskContext("project-a", task.id);
      expect(context.output).toBe(expected);
      expect(context.outputTruncated).toBe(true);
    }
  );

  it("rejects archived output if a new attempt starts before its read finishes", async () => {
    readExecution.mockReturnValueOnce(null).mockReturnValue(execution);
    await expect(service.getTaskContext("project-a", task.id)).rejects.toMatchObject({
      code: "AGENT_ATTEMPT_CHANGED",
    });
  });
});

describe.each(["sqlite", "postgres"] as const)("collaboration archived context (%s)", (dialect) => {
  it("reads the newest project-scoped session with portable bounded substrings", async () => {
    const sqlite = dialect === "sqlite" ? await initAppDb("sqlite://:memory:") : null;
    const postgres = dialect === "postgres" ? await createTestPostgresClient() : null;
    if (dialect === "postgres" && !postgres) {
      throw new Error(
        "The isolated PostgreSQL test database is required for context portability checks."
      );
    }
    const client = sqlite ? await sqlite.getClient() : postgres!.client;
    const projectId = createTestProjectId("collaboration-context");
    try {
      for (const [scope, attempt, output] of [
        [projectId, 1, "old"],
        [projectId, 2, "a\n".repeat(150_000) + "newest"],
        [projectId + "-other", 3, "foreign"],
      ] as const) {
        await client.execute(
          `INSERT INTO agent_sessions(project_id, task_id, attempt, agent_type, agent_model, started_at, status, output_log, git_branch, git_diff)
           VALUES ($1,$2,$3,'openai','test','2026-11-06T10:00:00Z','success',$4,'task-branch',$5)`,
          [scope, task.id, attempt, output, unsafeArchiveDiff()]
        );
      }
      const service = new CollaborationTaskContextService({
        projectService: {
          getProject: vi
            .fn()
            .mockResolvedValue({ id: projectId, name: "Sample", repoPath: "/unused" } as Project),
          getSettings: vi.fn(),
        },
        taskStore: {
          show: vi.fn().mockResolvedValue(task),
          listAll: vi.fn(),
          getDb: async () => client,
        },
        readExecution: () => null,
        getActiveRun: () => null,
      });
      const context = await service.getTaskContext(projectId, task.id);
      expect(context.sourceAttempt).toBe(2);
      expect(Buffer.byteLength(context.output, "utf8")).toBeLessThanOrEqual(256 * 1024);
      expect(context.output.length).toBeGreaterThan(256 * 1024 - 3);
      expect(context.output.endsWith("newest")).toBe(true);
      expect(context.outputTruncated).toBe(true);
      expect(context.diff).toContain("safe-neighbor");
      expect(context.diff).toContain("SERVICE_TOKEN=[REDACTED]");
      for (const secret of [
        "root-secret",
        "nested-secret",
        "upper-root-secret",
        "upper-nested-secret",
        "upper-runtime-secret",
        "upper-dependency-secret",
        "upper-git-secret",
        "unicode-env-secret",
        "unicode-runtime-secret",
        "runtime-secret",
        "nested-runtime-secret",
        "dependency-secret",
        "nested-dependency-secret",
        "quoted-secret",
        "binary-secret",
        "combined-secret",
        "unknown-secret",
        "known-secret",
      ])
        expect(context.diff).not.toContain(secret);
      const boundarySecret = "complete-secret-at-truncation-boundary";
      const usefulNeighbor = "safe final output\n";
      const suffix =
        "\n" +
        "x".repeat(256 * 1024 - boundarySecret.length - usefulNeighbor.length - 1) +
        usefulNeighbor;
      await client.execute(
        `INSERT INTO agent_sessions(project_id, task_id, attempt, agent_type, agent_model, started_at, status, output_log, git_branch)
         VALUES ($1,$2,4,'openai','test','2026-11-06T10:00:00Z','success',$3,'task-branch')`,
        [projectId, task.id, `SERVICE_TOKEN=${boundarySecret}${suffix}`]
      );
      const boundaryContext = await service.getTaskContext(projectId, task.id);
      expect(boundaryContext.sourceAttempt).toBe(4);
      expect(boundaryContext.output).not.toContain(boundarySecret);
      expect(boundaryContext.output.endsWith(usefulNeighbor)).toBe(true);
      expect(boundaryContext.outputTruncated).toBe(true);
    } finally {
      await client.execute("DELETE FROM agent_sessions WHERE project_id = $1 OR project_id = $2", [
        projectId,
        projectId + "-other",
      ]);
      await sqlite?.close();
      await postgres?.pool.end();
    }
  });
});
