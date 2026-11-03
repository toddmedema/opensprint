import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentSession } from "@opensprint/shared";
import { createSqliteDbClient } from "../db/sqlite-client.js";
import type { DbClient } from "../db/client.js";
const guidance = vi.hoisted(() => ({ history: vi.fn().mockReturnValue([]) }));
vi.mock("../services/agent-chat.service.js", () => ({
  agentChatService: { getHistory: guidance.history },
}));
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
        "CREATE TABLE governance_replay_inputs(project_id TEXT,session_id INTEGER,task_id TEXT,payload TEXT,attempt INTEGER,status TEXT,PRIMARY KEY(project_id,session_id))",
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
              policyPin: pin,
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
      expect(refs).toMatch(/\/[0-9a-f]{64}\/base/);
      expect(refs).toMatch(/\/[0-9a-f]{64}\/head/);
      await retainGovernanceReplayInput(db, "p", 33, { ...session, attempt: 3 }, root);
      expect(
        await db.queryOne("SELECT payload FROM governance_replay_inputs WHERE session_id=33")
      ).toBeUndefined();
      guidance.history.mockReturnValue([
        {
          role: "user",
          attempt: 2,
          status: "included",
          timestamp: "2026-10-30T00:00:03.000Z",
          content: "Additional requirement delivered during execution",
        },
      ]);
      await retainGovernanceReplayInput(db, "p", 44, session, root);
      expect(
        await db.queryOne("SELECT payload FROM governance_replay_inputs WHERE session_id=44")
      ).toBeUndefined();
      guidance.history.mockReturnValue([
        {
          role: "user",
          attempt: 2,
          status: "failed",
          timestamp: "2026-10-30T00:00:03.000Z",
          content: "Never reached the model",
        },
      ]);
      await retainGovernanceReplayInput(db, "p", 45, session, root);
      expect(
        await db.queryOne("SELECT payload FROM governance_replay_inputs WHERE session_id=45")
      ).toBeDefined();
      guidance.history.mockReturnValue([]);
    } finally {
      native.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
