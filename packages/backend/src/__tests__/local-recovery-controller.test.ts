import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initAppDb, type AppDb } from "../db/app-db.js";
import { LocalRecoveryController } from "../services/local-recovery-controller.js";
import { LocalRecoveryStore } from "../services/local-recovery-store.js";
import { isLocalRecoveryCapacityReleased } from "../services/local-recovery-capacity.js";
import {
  parseCommandSpec,
  type MergeQualityGateFailure,
} from "../services/merge-quality-gate-runner.js";
import { createTestPostgresClient } from "./test-db-helper.js";
import type { DbClient } from "../db/client.js";

const failure = (
  reason = "matched high-confidence environment fingerprint"
): MergeQualityGateFailure => ({
  command: "project-check",
  reason: "Dependency installation is unavailable",
  output: "dependency fixture missing",
  category: "environment_setup",
  classificationReason: reason,
});

describe.each(["sqlite", "postgres"] as const)("local recovery persistence (%s)", (dialect) => {
  let app: AppDb | undefined;
  let close: () => Promise<unknown>;
  let client: DbClient;
  let store: LocalRecoveryStore;
  let workspace: string;
  let projectId: string;
  beforeEach(async () => {
    if (dialect === "sqlite") {
      app = await initAppDb("sqlite://:memory:");
      client = await app.getClient();
      close = () => app!.close();
    } else {
      const pg = await createTestPostgresClient();
      if (!pg) throw new Error("Isolated PostgreSQL test database is required");
      client = pg.client;
      close = () => pg.pool.end();
    }
    store = new LocalRecoveryStore(async () => client, "fixture-host");
    workspace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "local-recovery-fixture-"))
    );
    projectId = randomUUID();
  });
  afterEach(async () => {
    for (const table of [
      "local_recovery_tasks",
      "local_recovery_requests",
      "local_recovery_reviews",
      "local_recovery_incidents",
      "local_execution_profiles",
      "local_validation_authorities",
    ])
      await client.execute(`DELETE FROM ${table} WHERE project_id=$1`, [projectId]);
    await close();
    await fs.rm(workspace, { recursive: true, force: true });
  });
  function fixture() {
    const options = {
      projectId,
      taskId: "task",
      repoPath: workspace,
      worktreePath: workspace,
      baseBranch: "main",
      branchName: "opensprint/task",
      toolchainProfile: {
        dependencyStrategy: "none" as const,
        mergeQualityGateCommands: ["project-check"],
        dependencyHealthCheckCommand: "project-health",
        dependencyInstallCommand: "project-install",
      },
    };
    const capture = async () => ({
      authorityHash: "authority",
      contextHash: "context",
      head: "head",
      cwd: workspace,
      inputs: [],
    });
    return { options, capture };
  }
  it("repairs once, independently verifies, remembers the repair, and retains completed code", async () => {
    const { options, capture } = fixture();
    const source = path.join(workspace, "completed-work.txt");
    await fs.writeFile(source, "uncommitted completed task");
    let installed = false;
    const commands: string[] = [];
    const runner = vi.fn(async (spec: { command: string }, opts: { cwd: string }) => {
      commands.push(spec.command);
      if (spec.command === "project-health" && !installed)
        throw new Error("fixture dependency missing");
      if (spec.command === "project-install") installed = true;
      return {
        stdout: "ok",
        stderr: "",
        executable: spec.command,
        cwd: opts.cwd,
        exitCode: 0,
        signal: null,
      };
    });
    let checks = 0;
    const controller = new LocalRecoveryController(store, { capture, runCommand: runner });
    const result = await controller.run({
      ...options,
      checkpoint: {
        phase: "coding",
        attempt: 1,
        phaseResult: {
          codingDiff: "retained",
          codingSummary: "completed",
          testResults: null,
          testOutput: "",
        },
      },
      validate: async () => {
        checks++;
        return installed ? null : failure();
      },
    });
    expect(result).toBeNull();
    expect(checks).toBe(2);
    expect(commands.filter((c) => c === "project-install")).toHaveLength(1);
    expect(await fs.readFile(source, "utf8")).toBe("uncommitted completed task");
    expect(await store.recipe(projectId, "context")).toBe("repair_dependencies");
    expect((await store.checkpointForTask(projectId, "task"))?.phaseResult?.codingSummary).toBe(
      "completed"
    );
  });
  it("waits for a foreign owner without install, lock deletion, or a new coding attempt", async () => {
    const { options, capture } = fixture();
    const marker = path.join(workspace, "foreign-lock");
    await fs.writeFile(marker, "another owner");
    let busy = true,
      checks = 0;
    const runner = vi.fn();
    const waiting: boolean[] = [];
    const controller = new LocalRecoveryController(store, {
      capture,
      runCommand: runner,
      isAlive: () => busy,
      wait: async () => {
        busy = false;
      },
    });
    const result = await controller.run({
      ...options,
      onWaiting: (w) => waiting.push(w),
      validate: async () =>
        checks++ === 0
          ? {
              ...failure("validation_resource_busy"),
              output:
                "Waiting for validation in /foreign/checkout (PID 424242); running suites remain uninterrupted.",
            }
          : null,
    });
    expect(result).toBeNull();
    expect(checks).toBe(2);
    expect(runner).not.toHaveBeenCalled();
    expect(waiting).toContain(true);
    expect(await fs.readFile(marker, "utf8")).toBe("another owner");
  });
  it("uses a declared readiness probe for an unfamiliar reservation format", async () => {
    const { options, capture } = fixture();
    let ready = false,
      checks = 0;
    const runner = vi.fn(async (spec: { command: string }, opts: { cwd: string }) => {
      expect(spec.command).toBe("resource-ready");
      if (!ready) throw new Error("busy");
      return {
        stdout: "",
        stderr: "",
        executable: spec.command,
        cwd: opts.cwd,
        exitCode: 0,
        signal: null,
      };
    });
    const controller = new LocalRecoveryController(store, {
      capture,
      runCommand: runner,
      wait: async () => {
        ready = true;
      },
    });
    const result = await controller.run({
      ...options,
      toolchainProfile: { ...options.toolchainProfile, resourceProbeCommand: "resource-ready" },
      validate: async () => (checks++ === 0 ? failure("checkout_reserved") : null),
    });
    expect(result).toBeNull();
    expect(runner).toHaveBeenCalledTimes(2);
  });
  it("fences competing owners atomically and prevents a stale result from replacing state", async () => {
    const row = await store.create(projectId, workspace, "context");
    const second = new LocalRecoveryStore(async () => client, "fixture-host");
    const third = new LocalRecoveryStore(async () => client, "fixture-host");
    const claims = await Promise.all([second.claim(row), third.claim(row)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    row.state = "passed";
    await expect(store.save(row)).rejects.toThrow(/ownership changed/);
    expect((await store.get(projectId, workspace))?.state).toBe("validating");
  });
  it("preserves repair budgets and checkpoints when a dead owner is recovered", async () => {
    const { options, capture } = fixture();
    const row = await store.create(projectId, workspace, "context");
    row.data.attempts = 1;
    row.data.commands = 7;
    row.data.recoveryStartedAt = Date.now();
    row.data.deadlineAt = Date.now() + 10000;
    await store.save(row);
    await store.checkpoint(row, "task", {
      worktreePath: workspace,
      head: "head",
      branchName: options.branchName,
      baseBranch: "main",
      contextHash: "context",
      attempt: 1,
    });
    const restarted = new LocalRecoveryStore(async () => client, "fixture-host");
    const controller = new LocalRecoveryController(restarted, { capture, isAlive: () => false });
    expect(await controller.run({ ...options, validate: async () => null })).toBeNull();
    const restored = await restarted.get(projectId, workspace);
    expect(restored?.generation).toBe(2);
    expect(restored?.data.attempts).toBe(1);
    expect(restored?.data.commands).toBe(7);
  });
  it("pins check authority independently of editable task files and retains rejected review outcomes", async () => {
    await store.pinAuthority(projectId, "task", "attempt-1", "original");
    await store.pinAuthority(projectId, "task", "attempt-1", "weakened");
    expect(await store.authority(projectId, "task", "attempt-1")).toBe("original");
    await store.rememberReview(projectId, "task", "attempt-1", "security", {
      status: "rejected",
      exitCode: 0,
      result: { status: "rejected", summary: "Required finding remains", issues: ["must fix"] },
    });
    const reopened = new LocalRecoveryStore(async () => client);
    expect((await reopened.reviews(projectId, "task", "attempt-1"))[0]?.outcome.status).toBe(
      "rejected"
    );
  });
});

describe("recovery execution boundaries", () => {
  it("releases coding capacity only after every worker is observed stopped", () => {
    expect(
      isLocalRecoveryCapacityReleased({
        localRecoveryWaiting: true,
        agent: { activeProcess: { pid: 1 } },
      })
    ).toBe(false);
    expect(
      isLocalRecoveryCapacityReleased({
        localRecoveryWaiting: true,
        agent: { activeProcess: null },
        reviewAgents: new Map([["qa", { agent: { activeProcess: { pid: 2 } } }]]),
      })
    ).toBe(false);
    expect(
      isLocalRecoveryCapacityReleased({
        localRecoveryWaiting: true,
        agent: { activeProcess: null },
      })
    ).toBe(true);
  });
  it("preserves quoted argv and rejects unexecuted shell pipeline tails", () => {
    expect(parseCommandSpec('python3 "tools/check fixture.py" --mode "full suite"')).toEqual({
      command: "python3",
      args: ["tools/check fixture.py", "--mode", "full suite"],
    });
    expect(() => parseCommandSpec("npm run build && npm run test")).toThrow(/explicit shell/);
    expect(parseCommandSpec('sh -c "make build && make test"')).toEqual({
      command: "sh",
      args: ["-c", "make build && make test"],
    });
  });
});
