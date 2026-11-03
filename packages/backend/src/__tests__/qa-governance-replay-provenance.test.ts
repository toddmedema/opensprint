import { beforeEach, afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentSession } from "@opensprint/shared";
import { createSqliteDbClient } from "../db/sqlite-client.js";
import type { DbClient } from "../db/client.js";
import {
  captureGovernanceContextArtifacts,
  type GovernanceContextArtifacts,
} from "../services/governance-context-artifacts.js";
import {
  persistGovernanceReplayInput,
  prepareGovernanceReplayInput,
  type GovernanceReplayInput,
} from "../services/governance-replay-input.js";
const exec = promisify(execFile);
async function retainGovernanceReplayInput(
  db: DbClient,
  projectId: string,
  sessionId: number,
  session: AgentSession,
  repoPath: string
): Promise<void> {
  const prepared = await prepareGovernanceReplayInput(db, projectId, session, repoPath);
  if (prepared) await persistGovernanceReplayInput(db, projectId, sessionId, prepared);
}
describe("QA final replay provenance attacks", () => {
  let root: string,
    db: DbClient,
    native: Database.Database,
    base: string,
    artifacts: GovernanceContextArtifacts;
  const session: AgentSession = {
    taskId: "task",
    attempt: 2,
    status: "approved",
    startedAt: "2026-10-30T00:00:02.000Z",
    completedAt: "2026-10-30T00:00:09.000Z",
    agentType: "openai",
    agentModel: "offline",
    gitBranch: "HEAD",
    outputLog: "output",
    gitDiff: null,
    testResults: null,
    failureReason: null,
  };
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "qa-replay-provenance-"));
    await exec("git", ["init", root]);
    await fs.writeFile(path.join(root, "source.ts"), "export const original = true;\n");
    await exec("git", ["add", "source.ts"], { cwd: root });
    await exec(
      "git",
      ["-c", "user.name=QA", "-c", "user.email=qa@example.test", "commit", "-m", "original"],
      { cwd: root }
    );
    base = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const context = path.join(root, "context");
    await fs.mkdir(path.join(context, "deps"), { recursive: true });
    await fs.writeFile(path.join(context, "spec.md"), "original requirements");
    await fs.writeFile(path.join(context, "plan.md"), "original plan");
    await fs.writeFile(path.join(context, "deps", "dependency.diff"), Buffer.from([0, 1, 255, 10]));
    artifacts = await captureGovernanceContextArtifacts(context);
    native = new Database(":memory:");
    db = createSqliteDbClient(native);
    for (const sql of [
      "CREATE TABLE governance_task_pins(project_id TEXT,task_id TEXT,payload TEXT)",
      "CREATE TABLE policy_releases(project_id TEXT,id TEXT,payload TEXT)",
      "CREATE TABLE governance_events(project_id TEXT,kind TEXT,payload TEXT)",
      "CREATE TABLE governance_replay_inputs(project_id TEXT,session_id INTEGER,task_id TEXT,payload TEXT,attempt INTEGER,status TEXT,PRIMARY KEY(project_id,session_id))",
      "CREATE TABLE agent_sessions(id INTEGER)",
    ])
      await db.execute(sql);
    await db.execute("INSERT INTO governance_task_pins VALUES('project','task',$1)", [
      JSON.stringify({
        projectId: "project",
        taskId: "task",
        releaseId: "release",
        baseSha: base,
        mode: "enforced",
        worktreePath: root,
        instructionsByRole: {},
      }),
    ]);
    await db.execute("INSERT INTO policy_releases VALUES('project','release',$1)", [
      JSON.stringify({ id: "release", instructions: {} }),
    ]);
  });
  afterEach(async () => {
    native.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  async function snapshot(
    attempt: number,
    contextArtifacts = artifacts,
    invocationId = `invocation${attempt}`,
    assigned = `2026-10-30T00:00:0${attempt}.000Z`
  ) {
    const event = {
      id: `event-${invocationId}`,
      createdAt: `2026-10-30T00:00:0${attempt}.001Z`,
      payload: {
        taskId: "task",
        role: "coder",
        attempt,
        invocationId,
        assignmentCreatedAt: assigned,
        headSha: base,
        prompt: `full prompt ${attempt}`,
        dynamicContext: `task input ${attempt}`,
        contextArtifacts,
        policyPin: JSON.parse(
          String((await db.queryOne("SELECT payload FROM governance_task_pins"))!.payload)
        ),
      },
    };
    await db.execute("INSERT INTO governance_events VALUES('project','prompt_snapshot',$1)", [
      JSON.stringify(event),
    ]);
  }
  it("does not substitute an earlier attempt when the actual retry's artifact capture failed", async () => {
    await snapshot(1);
    await snapshot(2, { complete: false, files: {}, error: "capture failed" });
    await retainGovernanceReplayInput(db, "project", 22, session, root);
    expect(await db.queryOne("SELECT payload FROM governance_replay_inputs")).toBeUndefined();
  });
  it("keeps the original policy pin when archival follows an authorized replacement-policy revalidation", async () => {
    await snapshot(2);
    await db.execute("UPDATE governance_task_pins SET payload=$1", [
      JSON.stringify({
        projectId: "project",
        taskId: "task",
        releaseId: "replacement",
        baseSha: base,
      }),
    ]);
    await retainGovernanceReplayInput(db, "project", 22, session, root);
    const row = await db.queryOne("SELECT payload FROM governance_replay_inputs");
    expect(row).toBeDefined();
    const input = JSON.parse(String(row!.payload));
    expect(input.pin.releaseId).toBe("release");
    expect(input.release.id).toBe("release");
  });
  it("withholds ambiguous same-attempt invocations rather than choosing a convenient snapshot", async () => {
    await snapshot(2, artifacts, "first");
    await snapshot(2, artifacts, "second");
    await retainGovernanceReplayInput(db, "project", 22, session, root);
    expect(await db.queryOne("SELECT payload FROM governance_replay_inputs")).toBeUndefined();
  });
  it("retains exact retry bytes and complete original requirements after cleanup and session pruning", async () => {
    await snapshot(1);
    await snapshot(2);
    await fs.rm(path.join(root, "context"), { recursive: true });
    await retainGovernanceReplayInput(db, "project", 22, session, root);
    await db.execute("DELETE FROM agent_sessions");
    const value = JSON.parse(
      String(
        (await db.queryOne("SELECT payload FROM governance_replay_inputs WHERE session_id=22"))
          ?.payload
      )
    ) as GovernanceReplayInput;
    expect(value).toMatchObject({
      attempt: 2,
      invocationId: "invocation2",
      taskPrompt: "task input 2",
      baseSha: base,
      headSha: base,
    });
    expect(Buffer.from(value.contextArtifacts.files["spec.md"], "base64").toString()).toBe(
      "original requirements"
    );
    expect(Buffer.from(value.contextArtifacts.files["deps/dependency.diff"], "base64")).toEqual(
      Buffer.from([0, 1, 255, 10])
    );
    expect(value.originalPrompt).toBe("full prompt 2");
  });
});
