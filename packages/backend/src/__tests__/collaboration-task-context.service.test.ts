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

  it("shows committed, staged and untracked source changes without changing the index", async () => {
    await fs.writeFile(path.join(directory, "app.ts"), "export const enabled = true;\n");
    await git(directory, "add", "app.ts");
    await git(directory, "commit", "-m", "implement filter state");
    await fs.writeFile(
      path.join(directory, "app.ts"),
      "export const enabled = true;\nexport const shared = true;\n"
    );
    await git(directory, "add", "app.ts");
    await fs.writeFile(path.join(directory, "new-file.ts"), "export const page = 1;\n");
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
    expect(context.diff).not.toContain("PRIVATE_SECRET");
    expect(context.diff).not.toContain("private-runtime-data");
    expect(context.diffRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(context.unavailableReason).toBeUndefined();
    expect(await git(directory, "diff", "--cached")).toBe(before);
    expect((await git(directory, "status", "--porcelain")).trim()).toContain("?? new-file.ts");
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

  it("keeps the newest bounded output instead of joining the whole log", async () => {
    execution!.output = ["old".repeat(100_000), "newest output"];
    const context = await service.getTaskContext("project-a", task.id);
    expect(context.output.length).toBe(256 * 1024);
    expect(context.output.endsWith("newest output")).toBe(true);
    expect(context.outputTruncated).toBe(true);
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
      output: "archived output",
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
        [projectId, 2, "a".repeat(300_000) + "newest"],
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
      expect(context.output).toHaveLength(256 * 1024);
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
