import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentSession } from "@opensprint/shared";
import { createSqliteDbClient } from "../db/sqlite-client.js";
import {
  retainGovernanceReplayInput,
  type GovernanceReplayInput,
} from "../services/governance-replay-input.js";
const exec = promisify(execFile);
describe("exact retained replay provenance", () => {
  it("binds the actual retry invocation and survives ordinary session pruning without a disputed case", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "replay-provenance-"));
    const native = new Database(":memory:");
    const db = createSqliteDbClient(native);
    try {
      await exec("git", ["init", root]);
      await fs.writeFile(path.join(root, "x.ts"), "export const value = 1;\n");
      await exec("git", ["add", "x.ts"], { cwd: root });
      await exec(
        "git",
        ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "original"],
        { cwd: root }
      );
      const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
      for (const sql of [
        "CREATE TABLE governance_task_pins(project_id TEXT,task_id TEXT,payload TEXT)",
        "CREATE TABLE policy_releases(project_id TEXT,id TEXT,payload TEXT)",
        "CREATE TABLE governance_events(project_id TEXT,kind TEXT,payload TEXT)",
        "CREATE TABLE governance_replay_inputs(project_id TEXT,session_id INTEGER,task_id TEXT,payload TEXT,PRIMARY KEY(project_id,session_id))",
        "CREATE TABLE agent_sessions(id INTEGER)",
      ])
        await db.execute(sql);
      const pin = {
        projectId: "p",
        taskId: "t",
        releaseId: "r",
        baseSha: base,
        instructionsByRole: {},
        mode: "enforced",
      };
      await db.execute("INSERT INTO governance_task_pins VALUES('p','t',$1)", [
        JSON.stringify(pin),
      ]);
      await db.execute("INSERT INTO policy_releases VALUES('p','r',$1)", [
        JSON.stringify({ id: "r", instructions: {} }),
      ]);
      for (const attempt of [1, 2])
        await db.execute("INSERT INTO governance_events VALUES('p','prompt_snapshot',$1)", [
          JSON.stringify({
            id: `prompt${attempt}`,
            createdAt: `2026-10-30T00:00:0${attempt}.001Z`,
            payload: {
              taskId: "t",
              role: "coder",
              attempt,
              invocationId: `invoke${attempt}`,
              assignmentCreatedAt: `2026-10-30T00:00:0${attempt}.000Z`,
              headSha: base,
              prompt: `old policy + complete task${attempt}`,
              dynamicContext: `original input${attempt}`,
              contextArtifacts: {
                complete: true,
                files: {
                  "spec.md": Buffer.from("original requirements").toString("base64"),
                  "plan.md": Buffer.from("original plan").toString("base64"),
                },
              },
            },
          }),
        ]);
      const session: AgentSession = {
        taskId: "t",
        attempt: 2,
        status: "approved",
        startedAt: "2026-10-30T00:00:02.000Z",
        completedAt: "2026-10-30T00:00:09.000Z",
        agentType: "openai",
        agentModel: "test",
        gitBranch: "HEAD",
        outputLog: "full session",
        gitDiff: "",
        testResults: null,
        failureReason: null,
      };
      await retainGovernanceReplayInput(db, "p", 22, session, root);
      await db.execute("DELETE FROM agent_sessions");
      const input = JSON.parse(
        String(
          (await db.queryOne("SELECT payload FROM governance_replay_inputs WHERE session_id=22"))
            ?.payload
        )
      ) as GovernanceReplayInput;
      expect(input).toMatchObject({
        sessionId: 22,
        attempt: 2,
        invocationId: "invoke2",
        promptEventId: "prompt2",
        taskPrompt: "original input2",
        baseSha: base,
        headSha: base,
        originalPrompt: "old policy + complete task2",
      });
      const refs = (
        await exec(
          "git",
          ["for-each-ref", "--format=%(refname)", "refs/opensprint/replay-inputs"],
          { cwd: root }
        )
      ).stdout;
      expect(refs).toContain("/22/base");
      expect(refs).toContain("/22/head");
      await retainGovernanceReplayInput(db, "p", 33, { ...session, attempt: 3 }, root);
      expect(
        await db.queryOne("SELECT payload FROM governance_replay_inputs WHERE session_id=33")
      ).toBeUndefined();
    } finally {
      native.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
