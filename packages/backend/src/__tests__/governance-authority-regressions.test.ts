import Database from "better-sqlite3";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type {
  PolicyDecision,
  PolicyRelease,
  PolicyRuleRevision,
  ReviewCase,
  ResolveGovernanceCaseInput,
  StructuredReviewFinding,
} from "@opensprint/shared";
import type { DbClient } from "../db/client.js";
import { createSqliteDbClient } from "../db/sqlite-client.js";
import { runSchema } from "../db/schema.js";
import { createTestPostgresClient, resetProjectScopedTestData } from "./test-db-helper.js";
import { GovernanceService } from "../services/governance-store.js";
import {
  auditProtectedPaths,
  auditProtectedPathsForGrant,
} from "../services/protected-path-policy.js";

const PROJECT = "project";
let native: Database.Database, db: DbClient, service: GovernanceService, release: PolicyRelease;
const rule = (over: Partial<PolicyRuleRevision> = {}): PolicyRuleRevision => ({
  id: "repository@1",
  ruleId: "repository",
  revision: 1,
  text: "Use repositories",
  rationale: "Consistent storage",
  owner: "Owner",
  paths: ["src/**"],
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
  ...over,
});
const finding = (over: Partial<StructuredReviewFinding> = {}): StructuredReviewFinding => ({
  id: "f1",
  category: "standard",
  ruleId: "repository",
  ruleRevisionId: "repository@1",
  file: "src/a.ts",
  codeRevision: "b".repeat(40),
  evidence: "Direct access",
  severity: "blocking",
  suggestedRemedy: "Use repository",
  provenance: { reviewer: "Reviewer" },
  ...over,
});
const roleScoped = rule({
  id: "coder-only@1",
  ruleId: "coder-only",
  roles: ["coder"],
  exceptionEligible: false,
});
const mandatoryOutOfPath = rule({ id: "always@1", ruleId: "always", mandatory: true });

async function setup(rules: PolicyRuleRevision[], mode: "enforced" | "shadow" = "enforced") {
  release = await service.createRelease(
    PROJECT,
    {
      rules,
      instructions: { coder: "c", reviewer: "r", judge: "j" },
      sourceHashes: {},
      enforcementRevision: "a".repeat(40),
    },
    "Owner"
  );
  await service.activateRelease(
    PROJECT,
    release.id,
    { expectedActiveReleaseId: null, rationale: "Initial" },
    "Owner"
  );
  await service.configure(PROJECT, { mode, expectedVersion: 1 }, "Owner");
}
async function pinned(taskId: string, status = "in_progress") {
  const at = new Date().toISOString();
  await db.execute(
    "INSERT INTO tasks(id,project_id,title,status,created_at,updated_at)VALUES($1,$2,'T',$3,$4,$5)",
    [taskId, PROJECT, status, at, at]
  );
  await service.pinTask({
    projectId: PROJECT,
    taskId,
    baseSha: "a".repeat(40),
    trustedScope: "",
    instructionsByRole: {},
    worktreePath: "/tmp/task",
    branchName: `task/${taskId}`,
  });
}
async function docket(
  taskId: string,
  state: ReviewCase["state"],
  over: Partial<StructuredReviewFinding> = {},
  fresh = true
) {
  if (fresh) await pinned(taskId);
  const f = finding(over);
  return service.openCase({
    projectId: PROJECT,
    taskId,
    releaseId: release.id,
    state,
    headSha: f.codeRevision,
    baseSha: "a".repeat(40),
    diffHash: `diff-${taskId}`,
    changedPaths: [f.file],
    title: "T",
    summary: "S",
    findings: [f],
    appeals: [],
    evidence: {},
    worktreePath: "/tmp/task",
    branchName: `task/${taskId}`,
  });
}
const ruling = (
  c: ReviewCase,
  action: ResolveGovernanceCaseInput["action"],
  extra: Partial<ResolveGovernanceCaseInput> = {}
): ResolveGovernanceCaseInput => ({
  expectedVersion: c.version,
  idempotencyKey: `key-${c.id}-${action}-${c.version}`,
  action,
  rationale: "Human rationale",
  headSha: c.headSha,
  diffHash: c.diffHash,
  ...extra,
});
const taskRow = (id: string) =>
  db.queryOne("SELECT status,assignee,extra FROM tasks WHERE project_id=$1 AND id=$2", [
    PROJECT,
    id,
  ]);
const open = async (id: string) =>
  (
    await db.queryOne("SELECT status FROM open_questions WHERE project_id=$1 AND id=$2", [
      PROJECT,
      id,
    ])
  )?.status;

let pg: Awaited<ReturnType<typeof createTestPostgresClient>> = null;
beforeAll(async () => {
  pg = await createTestPostgresClient();
});
afterAll(async () => {
  await pg?.pool.end();
});
const leaseOwner = { alive: true };

describe.each(["sqlite", "postgres"] as const)("on %s", (dialect) => {
  beforeEach(async (context) => {
    if (dialect === "postgres") {
      // A missing Postgres skips these cases; the report must then call validation incomplete.
      if (!pg) return context.skip();
      db = pg.client;
      await resetProjectScopedTestData(db, PROJECT);
      await db.execute("DELETE FROM governance_publication_leases WHERE project_id=$1", [PROJECT]);
    } else {
      native = new Database(":memory:");
      native.pragma("foreign_keys=ON");
      db = createSqliteDbClient(native);
      await runSchema(db, "sqlite");
    }
    leaseOwner.alive = true;
    let tx: DbClient | null = null;
    service = new GovernanceService({
      getDb: async () => tx ?? db,
      runWrite: (fn) =>
        db.runInTransaction(async (client) => {
          tx = client;
          try {
            return await fn(client);
          } finally {
            tx = null;
          }
        }),
      publicationOwner: "restarted",
      isPublicationOwnerAlive: (owner) => owner === "restarted" || leaseOwner.alive,
    });
  });
  afterEach(() => {
    if (dialect === "sqlite") native.close();
  });

  describe("publication lease recovery", () => {
    it("W13: a crashed owner's lease is cleared at startup and on contention", async () => {
      await setup([rule()]);
      const inAnHour = new Date(Date.now() + 3_600_000).toISOString();
      await db.execute(
        "INSERT INTO governance_publication_leases(project_id,token,expires_at,owner) VALUES($1,'crashed',$2,'host|1|gone')",
        [PROJECT, inAnHour]
      );
      await expect(service.withPublicationLock(PROJECT, async () => "busy")).rejects.toMatchObject({
        code: "GOVERNANCE_PUBLICATION_LEASE_BUSY",
      });
      leaseOwner.alive = false;
      expect(await service.clearDeadPublicationLeases()).toBe(1);
      await db.execute(
        "INSERT INTO governance_publication_leases(project_id,token,expires_at,owner) VALUES($1,'crashed-again',$2,'host|2|gone')",
        [PROJECT, inAnHour]
      );
      await expect(service.withPublicationLock(PROJECT, async () => "recovered")).resolves.toBe(
        "recovered"
      );
      expect(
        await db.queryOne("SELECT token FROM governance_publication_leases WHERE project_id=$1", [
          PROJECT,
        ])
      ).toBeFalsy();
    });
  });

  describe("model authority over findings", () => {
    it("A1: a model cannot withdraw an applicable exception-eligible finding; it escalates", async () => {
      await setup([rule()]);
      const c = await docket("t", "awaiting_reconsideration");
      const next = await service.recordReconsideration(
        PROJECT,
        c.id,
        { status: "approved", summary: "x", withdrawnFindingIds: ["f1"], notes: "" },
        c.version
      );
      expect(next.state).toBe("awaiting_judge");
      expect(next.findings.map((f) => f.id)).toEqual(["f1"]);
      expect(next.verifiedDisposition).toBeUndefined();
    });
    it("A1: withdrawal stays available where the rule does not apply to the file", async () => {
      await setup([rule()]);
      const c = await docket("t", "awaiting_reconsideration", { file: "docs/a.md" });
      const next = await service.recordReconsideration(
        PROJECT,
        c.id,
        { status: "approved", summary: "x", withdrawnFindingIds: ["f1"], notes: "" },
        c.version
      );
      expect(next).toMatchObject({
        state: "cancelled",
        verifiedDisposition: { kind: "reviewer_withdrew" },
      });
    });
    it("A6: a role-scoped path-applicable rule cannot be dismissed as not applicable", async () => {
      await setup([roleScoped]);
      const c = await docket("t", "awaiting_human", {
        ruleId: "coder-only",
        ruleRevisionId: "coder-only@1",
      });
      await expect(
        service.applyVerifiedDisposition(PROJECT, c.id, "finding_not_applicable", c.version)
      ).rejects.toThrow("The cited standard applies");
      expect(await service.hasTaskHold(PROJECT, "t")).toBe(true);
    });
    it("A6: a mandatory rule applies regardless of path", async () => {
      await setup([mandatoryOutOfPath]);
      const c = await docket("t", "awaiting_human", {
        ruleId: "always",
        ruleRevisionId: "always@1",
        file: "docs/a.md",
      });
      await expect(
        service.applyVerifiedDisposition(PROJECT, c.id, "finding_not_applicable", c.version)
      ).rejects.toThrow("The cited standard applies");
    });
    it("A10: a non-blocking standard without a rule passes the store as it passes the parser", async () => {
      await setup([rule()]);
      await pinned("t");
      const f = finding({ severity: "warning", ruleId: undefined, ruleRevisionId: undefined });
      const opened = await service.openCase({
        projectId: PROJECT,
        taskId: "t",
        releaseId: release.id,
        state: "fix_required",
        headSha: f.codeRevision,
        baseSha: "a".repeat(40),
        diffHash: "d",
        changedPaths: [f.file],
        title: "T",
        summary: "S",
        findings: [f],
        appeals: [],
        evidence: {},
        worktreePath: "/tmp/task",
        branchName: "task/t",
      });
      expect(opened.state).toBe("fix_required");
    });
  });

  describe("mode and pin admission", () => {
    const admission = (taskId: string) =>
      service.assertMergeAdmission({
        projectId: PROJECT,
        taskId,
        headSha: "b".repeat(40),
        diffHash: "d",
        changedPaths: ["src/a.ts"],
      });
    it("A2: a shadow pin is judged at the stricter current mode after enforcement", async () => {
      await setup([rule()], "shadow");
      await pinned("t");
      await service.configure(PROJECT, { mode: "enforced", expectedVersion: 2 }, "Owner");
      await expect(admission("t")).rejects.toThrow("Code changed");
    });
    it("A2: a pinless task is denied in enforced mode", async () => {
      await setup([rule()]);
      await expect(admission("unpinned")).rejects.toMatchObject({ code: "GOVERNANCE_NOT_PINNED" });
    });
    it("A2: a pinless task still passes in shadow mode", async () => {
      await setup([rule()], "shadow");
      await expect(admission("unpinned")).resolves.toBeUndefined();
    });
  });

  describe("trusted scope", () => {
    it("A3: enforced grants come from human authorization and match structured values only", async () => {
      await setup([rule()]);
      await db.execute(
        "INSERT INTO governance_task_scopes(project_id,task_id,scope) VALUES($1,'t','oauth integration')",
        [PROJECT]
      );
      await db.execute(
        "INSERT INTO tasks(id,project_id,title,status,created_at,updated_at)VALUES('t',$1,'T','open','x','x')",
        [PROJECT]
      );
      expect(await service.getAuthorizedScope(PROJECT, "t")).toBeNull();
      await service.authorizeTaskScope(PROJECT, "t", "integration, oauth", "Needed", "Owner");
      expect(await service.getAuthorizedScope(PROJECT, "t")).toBe("integration, oauth");
      const file = ["src/routes/integrations-x.ts"];
      expect(auditProtectedPathsForGrant(file, "integration, oauth").allowed).toBe(true);
      expect(auditProtectedPathsForGrant(file, "no integration work here").allowed).toBe(false);
      expect(auditProtectedPathsForGrant(file, "reintegration").allowed).toBe(false);
    });
    it("A3: other modes use word boundaries over mutable wording", () => {
      const file = ["src/routes/oauth.ts"];
      expect(auditProtectedPaths(file, "Update OAuth flow", "").allowed).toBe(true);
      expect(auditProtectedPaths(file, "Fix disintegration metric", "").allowed).toBe(false);
      expect(auditProtectedPaths(file, "todoistic rename", "").allowed).toBe(false);
      expect(auditProtectedPaths(file, "token-encryption rotation", "").allowed).toBe(true);
    });
  });

  describe("reusable decisions", () => {
    const conditions = () => ({
      version: 1 as const,
      paths: ["src/**"],
      ruleRevisionIds: ["repository@1"],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    async function recommended(c: ReviewCase) {
      return service.recordRecommendation(
        PROJECT,
        c.id,
        {
          disposition: "exception_authorized",
          rationale: "r",
          evidence: ["e"],
          ruleIds: ["repository"],
          decisionIds: [],
        },
        c.version
      );
    }
    it("A4: a reusable ruling from a critically revoked release grants nothing", async () => {
      await setup([rule()]);
      const first = await docket("a", "awaiting_human");
      await service.resolveCase(
        PROJECT,
        first.id,
        ruling(first, "allow_reusable", { conditions: conditions() }),
        "Owner"
      );
      const c = await recommended(await docket("b", "awaiting_judge"));
      await service.revokeRelease(PROJECT, release.id, "critical", "Owner");
      await expect(
        service.applyVerifiedDisposition(PROJECT, c.id, "precedent_applied", c.version)
      ).rejects.toThrow();
      expect((await service.getCase(PROJECT, c.id)).state).toBe("awaiting_human");
    });
    it("A4: a reusable ruling does not cross into a case under another release", async () => {
      await setup([rule()]);
      const first = await docket("a", "awaiting_human");
      await service.resolveCase(
        PROJECT,
        first.id,
        ruling(first, "allow_reusable", { conditions: conditions() }),
        "Owner"
      );
      const other = await service.createRelease(
        PROJECT,
        {
          rules: [rule()],
          instructions: {},
          sourceHashes: {},
          enforcementRevision: "c".repeat(40),
        },
        "Owner"
      );
      await pinned("b");
      const f = finding();
      const c = await recommended(
        await service.openCase({
          projectId: PROJECT,
          taskId: "b",
          releaseId: other.id,
          state: "awaiting_judge",
          headSha: f.codeRevision,
          baseSha: "a".repeat(40),
          diffHash: "diff-b",
          changedPaths: [f.file],
          title: "T",
          summary: "S",
          findings: [f],
          appeals: [],
          evidence: {},
          worktreePath: "/tmp/task",
          branchName: "task/b",
        })
      );
      await expect(
        service.applyVerifiedDisposition(PROJECT, c.id, "precedent_applied", c.version)
      ).rejects.toThrow("No explicit compatible");
    });
  });

  describe("human rulings", () => {
    it("A5: request_evidence cannot launder a stale case", async () => {
      await setup([rule()]);
      const c = await docket("t", "stale");
      await expect(
        service.resolveCase(PROJECT, c.id, ruling(c, "request_evidence"), "Owner")
      ).rejects.toMatchObject({ code: "GOVERNANCE_STALE_CODE" });
    });
    it("A5: request_evidence cannot launder a human-cancelled case", async () => {
      await setup([rule()]);
      const c = await docket("t", "awaiting_human");
      await service.resolveCase(PROJECT, c.id, ruling(c, "cancel"), "Owner");
      const cancelled = await service.getCase(PROJECT, c.id);
      await expect(
        service.resolveCase(PROJECT, c.id, ruling(cancelled, "request_evidence"), "Owner")
      ).rejects.toMatchObject({ code: "GOVERNANCE_STALE_CODE" });
      expect((await service.getCase(PROJECT, c.id)).humanCancelled).toBe(true);
    });
    it("W11: abandon ends a human-cancelled case and closes the task", async () => {
      await setup([rule()]);
      const c = await docket("t", "awaiting_human");
      await service.resolveCase(PROJECT, c.id, ruling(c, "cancel"), "Owner");
      const cancelled = await service.getCase(PROJECT, c.id);
      const d = await service.resolveCase(PROJECT, c.id, ruling(cancelled, "abandon"), "Owner");
      expect(d.action).toBe("abandon");
      expect(await service.hasTaskHold(PROJECT, "t")).toBe(false);
      expect((await service.getCase(PROJECT, c.id)).abandoned).toBe(true);
      expect((await taskRow("t"))?.status).toBe("closed");
    });
    it("W11: abandon leaves the task blocked while another hold remains", async () => {
      await setup([rule()]);
      const first = await docket("t", "awaiting_human");
      const second = await docket("t", "awaiting_human", { id: "f2", evidence: "Other" }, false);
      await service.resolveCase(PROJECT, first.id, ruling(first, "abandon"), "Owner");
      expect(second.id).not.toBe(first.id);
      expect(await service.hasTaskHold(PROJECT, "t")).toBe(true);
      expect((await taskRow("t"))?.status).toBe("blocked");
    });
  });

  describe("decision revocation", () => {
    async function allowed(taskId: string) {
      const c = await docket(taskId, "awaiting_human");
      return {
        c,
        d: (await service.resolveCase(
          PROJECT,
          c.id,
          ruling(c, "allow_once"),
          "Owner"
        )) as PolicyDecision,
      };
    }
    it("A9: revocation is idempotent and matches the expiry path's task update", async () => {
      await setup([rule()]);
      const { c, d } = await allowed("t");
      await db.execute("UPDATE tasks SET status='in_progress',assignee='Frodo' WHERE id='t'");
      await service.revokeDecision(PROJECT, d.id, "Bad", "Owner");
      const once = await service.getCase(PROJECT, c.id);
      await service.revokeDecision(PROJECT, d.id, "Bad", "Owner");
      expect((await service.getCase(PROJECT, c.id)).version).toBe(once.version);
      expect(await service.listEvents(PROJECT, ["decision_revoked"])).toHaveLength(1);
      const task = await taskRow("t");
      expect(task?.status).toBe("blocked");
      expect(task?.assignee ?? null).toBeNull();
      expect(JSON.parse(String(task?.extra))).toMatchObject({
        governance_resume: null,
        block_reason: "Governance allowance revoked",
      });
    });
    it("A9: a case with a later decision is not reopened by revoking the earlier one", async () => {
      await setup([rule()]);
      const c = await docket("t", "awaiting_human");
      const asked = await service.resolveCase(
        PROJECT,
        c.id,
        ruling(c, "request_evidence"),
        "Owner"
      );
      const evidenced = await service.appendCaseEvidence(
        PROJECT,
        c.id,
        c.version + 1,
        { note: "More" },
        "Owner"
      );
      await new Promise((resolve) => setTimeout(resolve, 2));
      await service.resolveCase(PROJECT, c.id, ruling(evidenced, "require_fix"), "Owner");
      expect(await service.revokeDecision(PROJECT, asked.id, "Bad", "Owner")).toEqual([]);
      expect((await service.getCase(PROJECT, c.id)).state).toBe("fix_required");
    });
    it("A9: returns the tasks whose running agents must pause", async () => {
      await setup([rule()]);
      const { d } = await allowed("t");
      expect(await service.revokeDecision(PROJECT, d.id, "Bad", "Owner")).toEqual(["t"]);
    });
  });

  describe("configuration", () => {
    it("A10: unknown keys are rejected, integers enforced, expectedVersion not persisted", async () => {
      await setup([rule()]);
      await expect(
        service.configure(PROJECT, { expectedVersion: 2, injected: true } as never, "Owner")
      ).rejects.toMatchObject({ code: "GOVERNANCE_INVALID_INPUT", statusCode: 400 });
      await expect(
        service.configure(PROJECT, { expectedVersion: 2, maxAppeals: 1.5 }, "Owner")
      ).rejects.toMatchObject({ code: "GOVERNANCE_INVALID_INPUT", statusCode: 400 });
      const next = await service.configure(
        PROJECT,
        { expectedVersion: 2, maxCostUsd: 1.5 },
        "Owner"
      );
      expect(next.maxCostUsd).toBe(1.5);
      const row = await db.queryOne("SELECT config FROM project_governance WHERE project_id=$1", [
        PROJECT,
      ]);
      expect(JSON.parse(String(row?.config))).not.toHaveProperty("expectedVersion");
    });
    it("A10: the judge agent is validated like the reconsideration agent", async () => {
      await setup([rule()]);
      await expect(
        service.configure(
          PROJECT,
          {
            expectedVersion: 2,
            judgeAgent: { type: "cursor", model: "x", cliCommand: "rm -rf /" },
          } as never,
          "Owner"
        )
      ).rejects.toMatchObject({ code: "GOVERNANCE_INVALID_INPUT" });
    });
    it("A10: disabling is refused for a human-cancelled hold", async () => {
      await setup([rule()]);
      const c = await docket("t", "awaiting_human");
      await service.resolveCase(PROJECT, c.id, ruling(c, "cancel"), "Owner");
      await expect(
        service.configure(PROJECT, { expectedVersion: 2, mode: "disabled" }, "Owner")
      ).rejects.toThrow("holds");
    });
  });

  describe("notifications and holds", () => {
    it("A11: resolving one case keeps the other held case's notification open", async () => {
      await setup([rule()]);
      const held = await docket("t", "awaiting_human", { id: "f2", evidence: "Other" });
      const judged = await docket("t", "awaiting_human", {}, false);
      await service.deliverOutbox(PROJECT);
      expect(await open(`gov-${held.id}`)).toBe("open");
      await service.applyVerifiedDisposition(PROJECT, judged.id, "fix_required", judged.version);
      expect(await open(`gov-${judged.id}`)).toBe("resolved");
      expect(await open(`gov-${held.id}`)).toBe("open");
    });
    it("A11: a human-cancelled case still counts as a hold when a sibling resolves", async () => {
      await setup([rule()]);
      const cancelled = await docket("t", "awaiting_human", { id: "f2", evidence: "Other" });
      await service.resolveCase(PROJECT, cancelled.id, ruling(cancelled, "cancel"), "Owner");
      const judged = await docket("t", "awaiting_human", {}, false);
      await db.execute("UPDATE tasks SET status='blocked' WHERE id='t'");
      await service.applyVerifiedDisposition(PROJECT, judged.id, "fix_required", judged.version);
      expect((await taskRow("t"))?.status).toBe("blocked");
    });
  });

  describe("activation and audit atomicity", () => {
    it("W7: activation is refused while a closed task with pending publication has another pin", async () => {
      await setup([rule()]);
      await pinned("t", "closed");
      await service.audit(PROJECT, "local_publication_registered", "system", {
        receipt: { id: "r1", taskId: "t", remoteExpected: true, owners: [{ taskId: "t" }] },
      });
      const other = await service.createRelease(
        PROJECT,
        {
          rules: [rule()],
          instructions: {},
          sourceHashes: {},
          enforcementRevision: "c".repeat(40),
        },
        "Owner"
      );
      await service.audit(PROJECT, "release_activated", "Owner", { releaseId: other.id });
      await expect(
        service.rollback(PROJECT, other.id, release.id, "Back", "Owner")
      ).rejects.toMatchObject({ code: "GOVERNANCE_HOLD" });
    });
    it("W13: a failed publication audit leaves no staged release", async () => {
      await expect(
        service.createRelease(
          PROJECT,
          {
            rules: [rule()],
            instructions: {},
            sourceHashes: {},
            enforcementRevision: "c".repeat(40),
            publication: { rationale: "   ", expectedActiveReleaseId: null },
          },
          "Owner"
        )
      ).rejects.toMatchObject({ code: "GOVERNANCE_INVALID_INPUT" });
      expect(await service.listReleases(PROJECT)).toEqual([]);
    });
    it("W13: a release and its rationale commit together", async () => {
      const created = await service.createRelease(
        PROJECT,
        {
          rules: [rule()],
          instructions: {},
          sourceHashes: {},
          enforcementRevision: "c".repeat(40),
          publication: { rationale: "Because", expectedActiveReleaseId: null },
        },
        "Owner"
      );
      const events = await service.listEvents(PROJECT, ["release_published"]);
      expect(events.map((e) => e.payload)).toMatchObject([
        { releaseId: created.id, rationale: "Because", expectedActiveReleaseId: null },
      ]);
    });
  });
});
