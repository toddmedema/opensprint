import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { DbClient } from "../db/client.js";
import { createSqliteDbClient } from "../db/sqlite-client.js";
import { runSchema } from "../db/schema.js";
import { GovernanceService } from "../services/governance-store.js";
import type {
  PolicyRelease,
  PolicyRuleRevision,
  ReviewCase,
  StructuredReviewFinding,
} from "@opensprint/shared";
let native: Database.Database, db: DbClient, service: GovernanceService, release: PolicyRelease;
const rule: PolicyRuleRevision = {
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
  examples: { compliant: ["repository.find"], noncompliant: ["db.query"] },
  parentIds: [],
  overrideIds: [],
  conflictIds: [],
  layer: 1,
  sourceHash: "",
};
const finding: StructuredReviewFinding = {
  id: "f1",
  category: "standard",
  ruleId: "repository",
  ruleRevisionId: "repository@1",
  file: "src/diagnostic.ts",
  codeRevision: "b".repeat(40),
  evidence: "Direct access",
  severity: "blocking",
  suggestedRemedy: "Use repository",
  provenance: { reviewer: "Reviewer" },
};
beforeEach(async () => {
  native = new Database(":memory:");
  native.pragma("foreign_keys=ON");
  db = createSqliteDbClient(native);
  await runSchema(db, "sqlite");
  let transactionClient: DbClient | null = null;
  service = new GovernanceService({
    getDb: async () => transactionClient ?? db,
    runWrite: (fn) =>
      db.runInTransaction(async (tx) => {
        transactionClient = tx;
        try {
          return await fn(tx);
        } finally {
          transactionClient = null;
        }
      }),
  });
  release = await service.createRelease(
    "project",
    {
      rules: [rule],
      instructions: { coder: "coder", reviewer: "reviewer", judge: "judge" },
      sourceHashes: {},
      enforcementRevision: "a".repeat(40),
    },
    "Owner"
  );
  await service.activateRelease(
    "project",
    release.id,
    { expectedActiveReleaseId: null, rationale: "Initial manual standards" },
    "Owner"
  );
  await service.configure("project", { mode: "enforced", expectedVersion: 1 }, "Owner");
});
afterEach(() => {
  vi.restoreAllMocks();
  native.close();
});
async function docket(
  taskId: string,
  state: ReviewCase["state"] = "awaiting_reconsideration",
  path = "src/diagnostic.ts"
) {
  const timestamp = new Date().toISOString();
  await db.execute(
    "INSERT INTO tasks(id,project_id,title,status,created_at,updated_at)VALUES($1,'project','Diagnostic','in_progress',$2,$3)",
    [taskId, timestamp, timestamp]
  );
  await service.pinTask({
    projectId: "project",
    taskId,
    baseSha: "a".repeat(40),
    trustedScope: "Diagnostic",
    instructionsByRole: {},
    worktreePath: "/tmp/task",
    branchName: `task/${taskId}`,
  });
  return service.openCase({
    projectId: "project",
    taskId,
    releaseId: release.id,
    state,
    headSha: finding.codeRevision,
    baseSha: "a".repeat(40),
    diffHash: `diff-${taskId}`,
    changedPaths: [path],
    title: "Diagnostic",
    summary: "Disputed standard",
    findings: [{ ...finding, file: path }],
    appeals: [],
    evidence: { completeDiff: "retained" },
    worktreePath: "/tmp/task",
    branchName: `task/${taskId}`,
  });
}
async function recommendation(
  c: ReviewCase,
  disposition: "exception_authorized" | "finding_invalid" = "exception_authorized"
) {
  return service.recordRecommendation(
    "project",
    c.id,
    {
      disposition,
      rationale: "Evidence considered",
      evidence: ["Direct access"],
      ruleIds: ["repository"],
      decisionIds: [],
    },
    c.version
  );
}
async function human(c: ReviewCase, reusable: boolean) {
  return service.resolveCase(
    "project",
    c.id,
    {
      expectedVersion: c.version,
      idempotencyKey: `ruling-${c.id}`,
      action: reusable ? "allow_reusable" : "allow_once",
      rationale: "Diagnostic exception",
      headSha: c.headSha,
      diffHash: c.diffHash,
      ...(reusable
        ? {
            conditions: {
              version: 1 as const,
              paths: ["src/diagnostic.ts"],
              ruleRevisionIds: [rule.id],
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          }
        : {}),
    },
    "Owner"
  );
}
describe("durable bounded adjudication", () => {
  it("reopens an expired allowance as a durable stale docket instead of retrying a closed case forever", async () => {
    const c = await docket("expires", "awaiting_human");
    const at = Date.now();
    await service.resolveCase(
      "project",
      c.id,
      {
        expectedVersion: c.version,
        idempotencyKey: `allow-${c.id}`,
        action: "allow_reusable",
        rationale: "Short diagnostic window",
        headSha: c.headSha,
        diffHash: c.diffHash,
        conditions: {
          version: 1,
          paths: ["src/**"],
          ruleRevisionIds: [rule.id],
          expiresAt: new Date(at + 1000).toISOString(),
        },
      },
      "Owner"
    );
    vi.spyOn(Date, "now").mockReturnValue(at + 2000);
    const stale = await service.getCase("project", c.id);
    expect(stale.state).toBe("stale");
    expect(await service.hasTaskHold("project", c.taskId)).toBe(true);
    expect(await service.retainsTaskWorktree("project", c.taskId)).toBe(true);
    expect(
      (
        await db.queryOne("SELECT status FROM tasks WHERE project_id='project' AND id=$1", [
          c.taskId,
        ])
      )?.status
    ).toBe("blocked");
    expect(
      (
        await db.query(
          "SELECT id FROM governance_outbox WHERE project_id='project' AND case_id=$1 AND state='pending'",
          [c.id]
        )
      ).length
    ).toBeGreaterThan(0);
    expect((await service.getCase("project", c.id)).version).toBe(stale.version);
    await expect(
      service.resolveCase(
        "project",
        c.id,
        {
          expectedVersion: stale.version,
          idempotencyKey: `stale-allow-${c.id}`,
          action: "allow_once",
          rationale: "Retry old approval",
          headSha: c.headSha,
          diffHash: c.diffHash,
        },
        "Owner"
      )
    ).rejects.toThrow("fresh review");
    await service.resolveCase(
      "project",
      c.id,
      {
        expectedVersion: stale.version,
        idempotencyKey: `fix-${c.id}`,
        action: "require_fix",
        rationale: "Revalidate under current evidence",
        headSha: c.headSha,
        diffHash: c.diffHash,
      },
      "Owner"
    );
    expect(await service.hasTaskHold("project", c.taskId)).toBe(false);
  });
  it("claims each model stage once and preserves every omitted blocker", async () => {
    const c = await docket("task");
    expect(await service.claimCaseJob("project", c.id, "reconsideration", c.version)).toBe(true);
    expect(await service.claimCaseJob("project", c.id, "reconsideration", c.version)).toBe(false);
    const updated = await service.recordReconsideration(
      "project",
      c.id,
      { status: "approved", summary: "No details", findings: [], notes: "" },
      c.version
    );
    expect(updated.state).toBe("awaiting_judge");
    expect(updated.findings).toEqual(c.findings);
    await expect(
      service.recordReconsideration(
        "project",
        c.id,
        { status: "approved", summary: "Late", withdrawnFindingIds: [finding.id], notes: "" },
        c.version
      )
    ).rejects.toThrow("stale");
  });
  it("requires explicit reviewer withdrawals, and still requires hard checks and code approval", async () => {
    const c = await docket("task");
    const updated = await service.recordReconsideration(
      "project",
      c.id,
      {
        status: "approved",
        summary: "Finding withdrawn with evidence",
        findings: [],
        withdrawnFindingIds: [finding.id],
        notes: "Repository is already used",
      },
      c.version
    );
    expect(updated).toMatchObject({
      state: "cancelled",
      verifiedDisposition: { kind: "reviewer_withdrew" },
    });
    await expect(
      service.assertMergeAdmission({
        projectId: "project",
        taskId: c.taskId,
        headSha: c.headSha,
        diffHash: c.diffHash,
        changedPaths: c.changedPaths,
      })
    ).rejects.toThrow("Code changed");
  });
  it("one-time rulings cannot supply reusable authority", async () => {
    await human(await docket("precedent", "awaiting_human"), false);
    const c = await recommendation(await docket("new", "awaiting_judge"));
    await expect(
      service.applyVerifiedDisposition("project", c.id, "precedent_applied", c.version)
    ).rejects.toThrow("No explicit compatible human reusable conditions");
    expect(await service.hasTaskHold("project", "new")).toBe(true);
  });
  it("reuses only explicit human predicates and rechecks revocation at merge admission", async () => {
    const decision = await human(await docket("precedent", "awaiting_human"), true);
    const c = await recommendation(await docket("new", "awaiting_judge"));
    const updated = await service.applyVerifiedDisposition(
      "project",
      c.id,
      "precedent_applied",
      c.version
    );
    expect(updated).toMatchObject({
      state: "cancelled",
      verifiedDisposition: { kind: "precedent_applied", decisionIds: [decision.id] },
    });
    const pin = (await service.getTaskPin("project", "new"))!;
    const context = await service.refreshContext(pin, "reviewer", c.changedPaths);
    await service.recordReviewApproval({
      projectId: "project",
      taskId: "new",
      releaseId: release.id,
      headSha: c.headSha,
      diffHash: c.diffHash,
      receipt: context.receipt,
      gatePassed: true,
    });
    await service.revokeDecision("project", decision.id, "Incorrect facts", "Owner");
    await expect(
      service.assertMergeAdmission({
        projectId: "project",
        taskId: "new",
        headSha: c.headSha,
        diffHash: c.diffHash,
        changedPaths: c.changedPaths,
      })
    ).rejects.toThrow();
  });
  it("dismisses only demonstrably inapplicable standards", async () => {
    const c = await recommendation(
      await docket("outside", "awaiting_judge", "docs/readme.md"),
      "finding_invalid"
    );
    expect(
      await service.applyVerifiedDisposition("project", c.id, "finding_not_applicable", c.version)
    ).toMatchObject({ state: "cancelled" });
    const applies = await recommendation(
      await docket("inside", "awaiting_judge"),
      "finding_invalid"
    );
    await expect(
      service.applyVerifiedDisposition(
        "project",
        applies.id,
        "finding_not_applicable",
        applies.version
      )
    ).rejects.toThrow("standard applies");
  });
});
