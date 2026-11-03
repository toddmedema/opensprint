import Database from "better-sqlite3";
import express from "express";
import request from "supertest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbClient } from "../db/client.js";
import { createSqliteDbClient } from "../db/sqlite-client.js";
import { runSchema } from "../db/schema.js";
import { GovernanceService } from "../services/governance-store.js";
import { errorHandler } from "../middleware/error-handler.js";

const current = vi.hoisted(() => ({ service: null as unknown as GovernanceService }));
vi.mock("../services/governance.service.js", () => ({
  governanceService: new Proxy(
    {},
    {
      get: (_target, key) => {
        const value = current.service[key as keyof GovernanceService];
        return typeof value === "function" ? value.bind(current.service) : value;
      },
    }
  ),
}));
vi.mock("../websocket/index.js", () => ({ broadcastToProject: vi.fn() }));
import { createGovernanceRouter } from "../routes/governance.js";
import { createGovernedRepoPathGuard } from "../middleware/governance-settings.js";

const secret = "synthetic-secret-".repeat(3);
const PROJECT = "proj-1";
let native: Database.Database, db: DbClient, repoPath: string, app: express.Express;
const human = (req: request.Test) => req.set("x-opensprint-governance-capability", secret);

beforeEach(async () => {
  vi.stubEnv("OPENSPRINT_GOVERNANCE_APPROVAL_SECRET", secret);
  vi.stubEnv("OPENSPRINT_GOVERNANCE_OWNER", "Owner");
  repoPath = mkdtempSync(join(tmpdir(), "governance-routes-"));
  execFileSync("git", ["init", "-q"], { cwd: repoPath });
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "x"],
    { cwd: repoPath }
  );
  native = new Database(":memory:");
  native.pragma("foreign_keys=ON");
  db = createSqliteDbClient(native);
  await runSchema(db, "sqlite");
  current.service = new GovernanceService({
    getDb: async () => db,
    runWrite: (fn) => db.runInTransaction(fn),
  });
  const projectService = {
    getProject: vi.fn(async () => ({ id: PROJECT, repoPath })),
    getSettings: vi.fn(async () => ({ reviewMode: "always" })),
  };
  app = express();
  app.use(express.json());
  app.use("/projects/:projectId/governance", createGovernanceRouter(projectService as never));
  app.put("/projects/:id", createGovernedRepoPathGuard(projectService as never), (_req, res) => {
    res.json({ data: { ok: true } });
  });
  app.use(errorHandler);
});
afterEach(() => {
  vi.unstubAllEnvs();
  native.close();
  rmSync(repoPath, { recursive: true, force: true });
});

async function activePolicy() {
  const release = await current.service.createRelease(
    PROJECT,
    {
      rules: [
        {
          id: "r@1",
          ruleId: "r",
          revision: 1,
          text: "Rule",
          rationale: "Why",
          owner: "Owner",
          paths: [],
          components: [],
          roles: [],
          severity: "standard",
          mandatory: false,
          exceptionEligible: true,
          examples: { compliant: [], noncompliant: [] },
          parentIds: [],
          overrideIds: [],
          conflictIds: [],
          layer: 1,
          sourceHash: "",
        },
      ],
      instructions: {},
      sourceHashes: {},
      enforcementRevision: "a".repeat(40),
    },
    "Owner"
  );
  await current.service.activateRelease(
    PROJECT,
    release.id,
    { expectedActiveReleaseId: null, rationale: "Initial" },
    "Owner"
  );
  return release;
}

describe("repository path of a governed project", () => {
  it("A7: an inactive project moves freely", async () => {
    const response = await request(app).put(`/projects/${PROJECT}`).send({ repoPath: "/elsewhere" });
    expect(response.status).toBe(200);
  });
  it("A7: a governed project needs the capability, and holds while its release is active", async () => {
    await activePolicy();
    const anonymous = await request(app).put(`/projects/${PROJECT}`).send({ repoPath: "/elsewhere" });
    expect(anonymous.status).toBe(403);
    const owner = await human(request(app).put(`/projects/${PROJECT}`)).send({
      repoPath: "/elsewhere",
    });
    expect(owner.status).toBe(409);
    expect(owner.body.error.code).toBe("GOVERNANCE_HOLD");
    const unchanged = await request(app).put(`/projects/${PROJECT}`).send({ repoPath });
    expect(unchanged.status).toBe(200);
  });
});

describe("governance routes", () => {
  it("A10: PATCH config validates its version and rejects unknown keys with a 400", async () => {
    await activePolicy();
    const patch = (body: Record<string, unknown>) =>
      human(request(app).patch(`/projects/${PROJECT}/governance/config`)).send(body);
    expect((await patch({ mode: "shadow" })).status).toBe(400);
    const unknown = await patch({ expectedVersion: 1, mode: "shadow", version: 99 });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("GOVERNANCE_INVALID_INPUT");
    const ok = await patch({ expectedVersion: 1, mode: "shadow" });
    expect(ok.status).toBe(200);
    expect(ok.body.data.version).toBe(2);
  });
  it("A10: a missing source-change assignment is a 404", async () => {
    const response = await request(app).get(`/projects/${PROJECT}/governance/source-changes/none`);
    expect(response.status).toBe(404);
  });
  it("W12: the summary lists cases without their evidence; the case route returns it", async () => {
    const release = await activePolicy();
    await db.execute(
      "INSERT INTO tasks(id,project_id,title,status,created_at,updated_at)VALUES('t',$1,'T','in_progress','x','x')",
      [PROJECT]
    );
    const opened = await current.service.openCase({
      projectId: PROJECT,
      taskId: "t",
      releaseId: release.id,
      state: "fix_required",
      headSha: "h",
      baseSha: "b",
      diffHash: "d",
      changedPaths: ["src/a.ts"],
      title: "T",
      summary: "S",
      findings: [],
      appeals: [],
      evidence: { diff: "x".repeat(10_000), prompts: ["whole prompt"] },
      worktreePath: "/w",
      branchName: "b",
    });
    const summary = await request(app).get(`/projects/${PROJECT}/governance`);
    expect(summary.body.data.cases[0]).not.toHaveProperty("evidence");
    expect(JSON.stringify(summary.body)).not.toContain("whole prompt");
    const detail = await request(app).get(`/projects/${PROJECT}/governance/cases/${opened.id}`);
    expect(detail.body.data.evidence.prompts).toEqual(["whole prompt"]);
  });
  it("W1: the owner reconciles a drifted source snapshot without replay", async () => {
    const release = await activePolicy();
    const response = await human(
      request(app).post(`/projects/${PROJECT}/governance/releases/reconcile-source-snapshot`)
    ).send({ expectedActiveReleaseId: release.id, rationale: "Accept the current sources" });
    expect(response.status).toBe(201);
    expect(response.body.data.rules).toEqual(release.rules);
    expect(await current.service.getActiveReleaseId(PROJECT)).toBe(response.body.data.id);
    const again = await human(
      request(app).post(`/projects/${PROJECT}/governance/releases/reconcile-source-snapshot`)
    ).send({ expectedActiveReleaseId: response.body.data.id, rationale: "Again" });
    expect(again.status).toBe(409);
  });
});
