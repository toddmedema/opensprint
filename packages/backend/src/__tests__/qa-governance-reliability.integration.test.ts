import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { DbClient } from "../db/client.js";
import type { PolicyRuleRevision, PolicyEvaluation } from "@opensprint/shared";
import { createSqliteDbClient } from "../db/sqlite-client.js";
import { runSchema } from "../db/schema.js";
import { GovernanceService } from "../services/governance-store.js";
import { createTestPostgresClient } from "./test-db-helper.js";
import { resetProjectScopedTestData } from "./test-db-helper.js";
import { copyDatabaseRows } from "../services/migrate-to-postgres.service.js";
import { GOVERNANCE_TABLES_IN_DEPENDENCY_ORDER } from "../db/governance-schema.js";

const singleton = vi.hoisted(() => ({
  db: null as DbClient | null,
  svc: null as GovernanceService | null,
}));
vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    getDb: async () => singleton.db,
    runWrite: async (fn: (db: DbClient) => Promise<unknown>) => singleton.db!.runInTransaction(fn),
  },
}));
vi.mock("../services/governance.service.js", () => ({
  governanceService: {
    hasTaskHold: async (projectId: string, taskId: string) =>
      singleton.svc!.hasTaskHold(projectId, taskId),
    retainsTaskWorktree: async (projectId: string, taskId: string) =>
      singleton.svc!.retainsTaskWorktree(projectId, taskId),
  },
}));
import { WorktreeLeaseService } from "../services/worktree-lease.service.js";

const rule: PolicyRuleRevision = {
  id: "repo@1",
  ruleId: "repo",
  revision: 1,
  text: "Use a repository",
  rationale: "Consistency",
  owner: "Owner",
  paths: ["src/**"],
  components: [],
  roles: [],
  severity: "standard",
  mandatory: false,
  exceptionEligible: true,
  examples: { compliant: ["repo.get"], noncompliant: ["db.get"] },
  parentIds: [],
  overrideIds: [],
  conflictIds: [],
  layer: 1,
  sourceHash: "source1",
};
const pg = await createTestPostgresClient();
const native = new Database(":memory:");
native.pragma("foreign_keys=ON");
const sqlite = createSqliteDbClient(native);
for (const dialect of ["sqlite", "postgres"] as const)
  describe.skipIf(dialect === "postgres" && !pg)(`governance QA reliability (${dialect})`, () => {
    let db: DbClient;
    beforeAll(async () => {
      db = dialect === "sqlite" ? sqlite : pg!.client;
      await runSchema(db, dialect);
    });
    const service = (client = db) =>
      new GovernanceService({
        getDb: async () => client,
        runWrite: (fn) => client.runInTransaction(fn),
      });
    async function fixture(client = db) {
      const projectId = `qa-${randomUUID()}`;
      const taskId = `os-${randomUUID()}`;
      const svc = service(client);
      await client.execute(
        "INSERT INTO tasks(id,project_id,title,status,created_at,updated_at) VALUES($1,$2,'Diagnostic','in_progress',$3,$4)",
        [taskId, projectId, new Date().toISOString(), new Date().toISOString()]
      );
      const release = await svc.createRelease(
        projectId,
        {
          rules: [rule],
          instructions: { coder: "Coder", reviewer: "Reviewer" },
          sourceHashes: {},
          enforcementRevision: "a".repeat(40),
        },
        "Owner"
      );
      await svc.activateRelease(
        projectId,
        release.id,
        { expectedActiveReleaseId: null, rationale: "Initial" },
        "Owner"
      );
      await svc.configure(projectId, { mode: "enforced", expectedVersion: 1 }, "Owner");
      await svc.pinTask({
        projectId,
        taskId,
        baseSha: "a".repeat(40),
        trustedScope: "Diagnostic",
        instructionsByRole: {},
        worktreePath: "/tmp/qa-governance",
        branchName: "opensprint/qa",
      });
      const c = await svc.openCase({
        projectId,
        taskId,
        releaseId: release.id,
        headSha: "b".repeat(40),
        diffHash: "diff1",
        baseSha: "a".repeat(40),
        changedPaths: ["src/diagnostic.ts"],
        title: "Diagnostic",
        summary: "Disputed standard",
        findings: [
          {
            id: "finding",
            category: "standard",
            ruleId: rule.ruleId,
            ruleRevisionId: rule.id,
            file: "src/diagnostic.ts",
            codeRevision: "b".repeat(40),
            evidence: "Direct query",
            severity: "blocking",
            suggestedRemedy: "Use repository",
            provenance: { reviewer: "reviewer" },
          },
        ],
        appeals: [],
        evidence: { diff: "full" },
        worktreePath: "/tmp/qa-governance",
        branchName: "opensprint/qa",
      });
      const decision = await svc.resolveCase(
        projectId,
        c.id,
        {
          expectedVersion: c.version,
          idempotencyKey: "allow",
          action: "allow_once",
          rationale: "Bounded",
          headSha: c.headSha,
          diffHash: c.diffHash,
        },
        "Owner"
      );
      return { projectId, taskId, svc, release, c, decision };
    }
    it("retains an expired waiting worktree until a resumed review actually claims it", async () => {
      const f = await fixture();
      singleton.db = db;
      singleton.svc = f.svc;
      const leases = new WorktreeLeaseService();
      await leases.acquire({
        projectId: f.projectId,
        taskId: f.taskId,
        worktreeKey: f.taskId,
        worktreePath: f.c.worktreePath,
        leaseOwner: "before-human-wait",
        ttlMs: -1,
      });
      const task = await db.queryOne(
        "SELECT status,extra FROM tasks WHERE project_id=$1 AND id=$2",
        [f.projectId, f.taskId]
      );
      expect(task?.status).toBe("open");
      expect(JSON.parse(String(task?.extra)).governance_resume).toBe(true);
      expect(await leases.canCleanup(f.taskId)).toBe(false);
      await db.execute(
        "UPDATE tasks SET status='in_progress',extra='{}' WHERE project_id=$1 AND id=$2",
        [f.projectId, f.taskId]
      );
      expect(await leases.canCleanup(f.taskId)).toBe(false);
      await db.execute("UPDATE tasks SET status='closed' WHERE project_id=$1 AND id=$2", [
        f.projectId,
        f.taskId,
      ]);
      expect(await leases.canCleanup(f.taskId)).toBe(true);
    });
    it("delivers a committed docket through a retryable outbox with a stable notification identity", async () => {
      const f = await fixture();
      const pending = await f.svc.openCase({
        ...f.c,
        idempotencyKey: "new-docket",
        state: "awaiting_human",
      });
      const delivered = vi.fn(async (notification: { id: string; projectId: string }) => {
        expect(
          await db.queryOne("SELECT id FROM open_questions WHERE project_id=$1 AND id=$2", [
            notification.projectId,
            notification.id,
          ])
        ).toBeTruthy();
        expect(
          (
            await db.queryOne(
              "SELECT state FROM governance_outbox WHERE project_id=$1 AND case_id=$2",
              [f.projectId, pending.id]
            )
          )?.state
        ).toBe("pending");
        if (delivered.mock.calls.length === 1)
          throw new Error("notification transport unavailable");
      });
      const sender = new GovernanceService({
        getDb: async () => db,
        runWrite: (fn) => db.runInTransaction(fn),
        onNotification: delivered,
      });
      await expect(sender.deliverOutbox(f.projectId)).rejects.toThrow("transport unavailable");
      expect(
        (
          await db.queryOne(
            "SELECT state FROM governance_outbox WHERE project_id=$1 AND case_id=$2",
            [f.projectId, pending.id]
          )
        )?.state
      ).toBe("pending");
      await sender.deliverOutbox(f.projectId);
      await sender.deliverOutbox(f.projectId);
      expect(delivered).toHaveBeenCalledTimes(2);
      expect(delivered.mock.calls.map(([notification]) => notification.id)).toEqual([
        `gov-${pending.id}`,
        `gov-${pending.id}`,
      ]);
      expect(
        await db.query("SELECT id FROM open_questions WHERE project_id=$1 AND kind='governance'", [
          f.projectId,
        ])
      ).toHaveLength(1);
      expect(
        (
          await db.queryOne(
            "SELECT state FROM governance_outbox WHERE project_id=$1 AND case_id=$2",
            [f.projectId, pending.id]
          )
        )?.state
      ).toBe("delivered");
      await db.execute(
        "UPDATE open_questions SET status='resolved',resolved_at=$1 WHERE project_id=$2 AND id=$3",
        [new Date().toISOString(), f.projectId, `gov-${pending.id}`]
      );
      const reopened = {
        ...pending,
        state: "stale",
        version: pending.version + 1,
        updatedAt: new Date().toISOString(),
      };
      await db.execute(
        "UPDATE review_cases SET state='stale',version=$1,payload=$2 WHERE project_id=$3 AND id=$4",
        [reopened.version, JSON.stringify(reopened), f.projectId, pending.id]
      );
      await db.execute(
        "UPDATE governance_outbox SET state='pending',payload=$1 WHERE project_id=$2 AND case_id=$3",
        [
          JSON.stringify({ caseId: pending.id, caseVersion: reopened.version }),
          f.projectId,
          pending.id,
        ]
      );
      await sender.deliverOutbox(f.projectId);
      await sender.deliverOutbox(f.projectId);
      expect(delivered).toHaveBeenCalledTimes(3);
      const notification = await db.queryOne(
        "SELECT status,resolved_at,scope_change_metadata FROM open_questions WHERE project_id=$1 AND id=$2",
        [f.projectId, `gov-${pending.id}`]
      );
      expect(notification?.status).toBe("open");
      expect(notification?.resolved_at).toBeNull();
      expect(JSON.parse(String(notification?.scope_change_metadata)).caseVersion).toBe(
        reopened.version
      );
    });
    it("mines advisory fixes and false positives without human rulings or new commits, without granting precedent authority", async () => {
      const projectId = `mining-${randomUUID()}`;
      const svc = service();
      const release = await svc.createRelease(
        projectId,
        {
          rules: [rule],
          instructions: { coder: "coder", reviewer: "reviewer" },
          sourceHashes: {},
          enforcementRevision: "a".repeat(40),
        },
        "Owner"
      );
      await svc.activateRelease(
        projectId,
        release.id,
        { expectedActiveReleaseId: null, rationale: "Initial" },
        "Owner"
      );
      await svc.configure(
        projectId,
        { expectedVersion: 1, mode: "enforced", recurrenceThreshold: 2 },
        "Owner"
      );
      const cases = [];
      for (const index of [1, 2]) {
        const taskId = `os-${randomUUID()}`;
        await db.execute(
          "INSERT INTO tasks(id,project_id,title,status,created_at,updated_at)VALUES($1,$2,'Diagnostic','in_progress',$3,$4)",
          [taskId, projectId, new Date().toISOString(), new Date().toISOString()]
        );
        await svc.pinTask({
          projectId,
          taskId,
          baseSha: "a".repeat(40),
          trustedScope: "Diagnostic",
          instructionsByRole: {},
          worktreePath: "/tmp/mining",
          branchName: `task/${taskId}`,
        });
        const c = await svc.openCase({
          projectId,
          taskId,
          releaseId: release.id,
          headSha: "b".repeat(40),
          diffHash: `diff${index}`,
          baseSha: "a".repeat(40),
          changedPaths: ["src/diagnostic.ts"],
          title: "Diagnostic",
          summary: "Rule finding",
          state: index === 1 ? "fix_required" : "awaiting_reconsideration",
          findings: [
            {
              id: `finding${index}`,
              category: "standard",
              ruleId: rule.ruleId,
              ruleRevisionId: rule.id,
              file: "src/diagnostic.ts",
              codeRevision: "b".repeat(40),
              evidence: "Direct query",
              severity: "blocking",
              suggestedRemedy: "Use repository",
              provenance: { reviewer: "reviewer" },
            },
          ],
          appeals: [],
          evidence: { diff: "complete" },
          worktreePath: "/tmp/mining",
          branchName: `task/${taskId}`,
        });
        cases.push(c);
        if (index === 1) {
          const pin = (await svc.getTaskPin(projectId, taskId))!;
          await svc.recordReviewApproval({
            projectId,
            taskId,
            headSha: "c".repeat(40),
            diffHash: "fixed",
            releaseId: release.id,
            receipt: (await svc.refreshContext(pin, "reviewer", c.changedPaths)).receipt,
            gatePassed: true,
          });
          expect(await svc.mineDecisions(projectId)).toHaveLength(0);
        } else
          await svc.recordReconsideration(
            projectId,
            c.id,
            {
              status: "approved",
              summary: "Unsupported applicability",
              findings: [],
              withdrawnFindingIds: [`finding${index}`],
              notes: "Withdrawn with evidence",
            },
            c.version
          );
      }
      const nominations = await svc.mineDecisions(projectId);
      expect(nominations).toHaveLength(1);
      expect(nominations[0].supportingDecisionIds).toEqual([]);
      expect(nominations[0].supportingEventIds?.length).toBeGreaterThan(0);
      expect(nominations[0].contraryEventIds?.length).toBeGreaterThan(0);
      expect(await svc.listDecisions(projectId)).toHaveLength(0);
      expect(
        await svc.findPrecedent(projectId, release.id, [rule.id], ["src/diagnostic.ts"])
      ).toHaveLength(0);
      expect(await svc.mineDecisions(projectId)).toHaveLength(0);
      const advisory = await svc.createProposal(projectId, {
        sourceNominationId: nominations[0].id,
        baseReleaseId: release.id,
        title: "Clarify repository scope",
        rationale: "Observed fixes and reviewer false positives",
        patches: [
          {
            ruleId: rule.ruleId,
            before: release.rules[0],
            after: {
              ...release.rules[0],
              id: "repo@2",
              revision: 2,
              text: "Use the repository when its query API applies",
            },
          },
        ],
        supportingDecisionIds: [],
        contraryDecisionIds: [],
        supportingEventIds: nominations[0].supportingEventIds,
        contraryEventIds: nominations[0].contraryEventIds,
        scope: "Diagnostics",
        compatibility: "Same checker",
        enforcementRevision: release.enforcementRevision,
        positiveExamples: ["repository query"],
        negativeExamples: ["unsafe write"],
      });
      expect(advisory.state).toBe("draft");
      const late = {
        id: `0000-${randomUUID()}`,
        projectId,
        caseId: cases[0].id,
        kind: "judge_recommended",
        actor: "judge",
        createdAt: "2020-01-01T00:00:00Z",
        payload: { recommendation: { disposition: "human_required" } },
      };
      await db.execute(
        "INSERT INTO governance_events(project_id,id,kind,payload,created_at)VALUES($1,$2,$3,$4,$5)",
        [projectId, late.id, late.kind, JSON.stringify(late), late.createdAt]
      );
      expect(await svc.mineDecisions(projectId)).toHaveLength(1);
      expect(await svc.mineDecisions(projectId)).toHaveLength(0);
    });
    it.skipIf(dialect !== "postgres")(
      "atomically enforces the task-wide budget across simultaneous case workers",
      async () => {
        const f = await fixture();
        let reads = 0;
        let release!: () => void;
        const bothRead = new Promise<void>((resolve) => {
          release = resolve;
        });
        const parallel = () =>
          new GovernanceService({
            getDb: async () => db,
            runWrite: (fn) =>
              db.runInTransaction(async (tx) =>
                fn({
                  ...tx,
                  queryOne: async (sql, params) => {
                    const row = await tx.queryOne(sql, params);
                    if (sql.startsWith("SELECT tokens,cost_usd,elapsed_ms,appeals")) {
                      if (++reads === 2) release();
                      await bothRead;
                    }
                    return row;
                  },
                })
              ),
          });
        const results = await Promise.allSettled([
          parallel().consumeBudget(f.projectId, f.taskId, { tokens: 60_000 }),
          parallel().consumeBudget(f.projectId, f.taskId, { tokens: 60_000 }),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        expect((await f.svc.getBudgetUsage(f.projectId, f.taskId)).tokens).toBe(60_000);
      }
    );
    it.skipIf(dialect !== "postgres")(
      "rejects activation when a concurrent reviewer already rejected that proposal version",
      async () => {
        const f = await fixture();
        const before = f.release.rules[0];
        const after = {
          ...before,
          id: "repo@2",
          revision: 2,
          text: "Use a repository except approved diagnostics",
          sourceHash: "source2",
        };
        const p = await f.svc.createProposal(f.projectId, {
          baseReleaseId: f.release.id,
          title: "Diagnostic amendment",
          rationale: "Observed rulings",
          patches: [{ ruleId: rule.ruleId, before, after }],
          supportingDecisionIds: [f.decision.id],
          contraryDecisionIds: [],
          scope: "Diagnostic",
          compatibility: "Same enforcement",
          enforcementRevision: f.release.enforcementRevision,
          positiveExamples: ["bounded read"],
          negativeExamples: ["unbounded write"],
        });
        const candidate = await f.svc.previewProposalRelease(f.projectId, p.id);
        const e: PolicyEvaluation = {
          complete: true,
          passed: true,
          executor: "offline-docker:trusted@sha256:digest",
          fixtureIds: ["1", "2"],
          heldOutCount: 2,
          positiveCount: 1,
          negativeCount: 1,
          baseline: { taskSuccessRate: 1 },
          candidate: { taskSuccessRate: 1 },
          artifactHash: "artifact",
          releaseContentHash: candidate.contentHash,
          measuredAt: new Date().toISOString(),
        };
        const evaluated = await f.svc.recordEvaluation(f.projectId, p.id, e, p.version);
        let observed!: () => void;
        let resume!: () => void;
        const activationObserved = new Promise<void>((resolve) => {
          observed = resolve;
        });
        const rejectionCommitted = new Promise<void>((resolve) => {
          resume = resolve;
        });
        const racing = new GovernanceService({
          getDb: async () => db,
          runWrite: (fn) =>
            db.runInTransaction(async (tx) =>
              fn({
                ...tx,
                queryOne: async (sql, params) => {
                  const row = await tx.queryOne(sql, params);
                  if (
                    sql.startsWith("SELECT payload FROM policy_proposals") &&
                    params?.[1] === p.id
                  ) {
                    observed();
                    await rejectionCommitted;
                  }
                  return row;
                },
              })
            ),
        });
        const activation = racing.activateProposal(
          f.projectId,
          p.id,
          {
            expectedVersion: evaluated.version,
            expectedActiveReleaseId: f.release.id,
            rationale: "Approve evaluated amendment",
          },
          "Owner"
        );
        await activationObserved;
        await service().rejectProposal(
          f.projectId,
          p.id,
          evaluated.version,
          "Do not activate",
          "Another reviewer"
        );
        resume();
        await expect(activation).rejects.toThrow(/changed|concurrent|stale/i);
        expect(await f.svc.getActiveReleaseId(f.projectId)).toBe(f.release.id);
      }
    );
    it.skipIf(dialect !== "postgres")(
      "migrates complete durable governance authority and replay session IDs in FK order",
      async () => {
        const sourceNative = new Database(":memory:");
        sourceNative.pragma("foreign_keys=ON");
        const source = createSqliteDbClient(sourceNative);
        try {
          await runSchema(source, "sqlite");
          const f = await fixture(source);
          const pending = await f.svc.openCase({
            ...f.c,
            findings: f.c.findings.map((finding) => ({ ...finding, id: "pending-finding" })),
            idempotencyKey: "pending-after-allow",
            state: "awaiting_human",
          });
          await f.svc.recordPromptSnapshot(
            f.projectId,
            f.taskId,
            "coder",
            "full original prompt",
            pending.headSha
          );
          await source.execute(
            "UPDATE project_governance SET decision_cursor=$1 WHERE project_id=$2",
            [f.decision.id, f.projectId]
          );
          const sessionId = 1_000_000 + (parseInt(randomUUID().slice(0, 8), 16) % 1_000_000);
          await source.execute(
            "INSERT INTO agent_sessions(id,project_id,task_id,attempt,agent_type,agent_model,started_at,completed_at,status,git_branch) VALUES($1,$2,$3,1,'claude','offline',$4,$5,'rejected','opensprint/qa')",
            [sessionId, f.projectId, f.taskId, new Date().toISOString(), new Date().toISOString()]
          );
          const replayPayload = JSON.stringify({
            sessionId,
            taskId: f.taskId,
            attempt: 1,
            originalPrompt: "full immutable original prompt",
            taskPrompt: "dynamic inputs",
            baseSha: f.c.baseSha,
            headSha: f.c.headSha,
            diff: "complete binary diff",
            changedPaths: f.c.changedPaths,
            release: f.release,
            pin: await f.svc.getTaskPin(f.projectId, f.taskId),
          });
          await source.execute(
            "INSERT INTO governance_replay_inputs(project_id,session_id,task_id,payload) VALUES($1,$2,$3,$4)",
            [f.projectId, sessionId, f.taskId, replayPayload]
          );
          singleton.db = source;
          singleton.svc = f.svc;
          await new WorktreeLeaseService().acquire({
            projectId: f.projectId,
            taskId: f.taskId,
            worktreeKey: f.taskId,
            worktreePath: f.c.worktreePath,
            leaseOwner: "waiting-case",
          });
          await copyDatabaseRows(source, db);
          const migrated = service();
          expect(await migrated.getActiveReleaseId(f.projectId)).toBe(f.release.id);
          expect(await migrated.hasTaskHold(f.projectId, f.taskId)).toBe(true);
          expect((await migrated.getCase(f.projectId, pending.id)).evidence).toEqual(
            pending.evidence
          );
          expect((await migrated.getPromptSnapshots(f.projectId, f.taskId))[0].payload.prompt).toBe(
            "full original prompt"
          );
          expect(
            (
              await db.queryOne(
                "SELECT decision_cursor FROM project_governance WHERE project_id=$1",
                [f.projectId]
              )
            )?.decision_cursor
          ).toBe(f.decision.id);
          expect(
            (await db.queryOne("SELECT task_id FROM agent_sessions WHERE id=$1", [sessionId]))
              ?.task_id
          ).toBe(f.taskId);
          expect(
            (
              await db.queryOne("SELECT task_id FROM worktree_leases WHERE worktree_key=$1", [
                f.taskId,
              ])
            )?.task_id
          ).toBe(f.taskId);
          for (const table of GOVERNANCE_TABLES_IN_DEPENDENCY_ORDER) {
            const before = await source.query(`SELECT * FROM ${table} WHERE project_id=$1`, [
              f.projectId,
            ]);
            const byIdentity = (a: Record<string, unknown>, b: Record<string, unknown>) =>
              String(a.id ?? a.task_id ?? a.project_id).localeCompare(
                String(b.id ?? b.task_id ?? b.project_id)
              );
            expect(
              (await db.query(`SELECT * FROM ${table} WHERE project_id=$1`, [f.projectId])).sort(
                byIdentity
              )
            ).toEqual(before.sort(byIdentity));
          }
          const next = await db.queryOne(
            "INSERT INTO agent_sessions(project_id,task_id,attempt,agent_type,agent_model,started_at,status,git_branch) VALUES($1,$2,2,'claude','offline',$3,'rejected','opensprint/qa') RETURNING id",
            [f.projectId, f.taskId, new Date().toISOString()]
          );
          expect(Number(next?.id)).toBeGreaterThan(sessionId);
          await db.execute("DELETE FROM agent_sessions WHERE project_id=$1", [f.projectId]);
          expect(
            (
              await db.queryOne(
                "SELECT payload FROM governance_replay_inputs WHERE project_id=$1 AND session_id=$2",
                [f.projectId, sessionId]
              )
            )?.payload
          ).toBe(replayPayload);
          await resetProjectScopedTestData(db, f.projectId);
          for (const table of GOVERNANCE_TABLES_IN_DEPENDENCY_ORDER)
            expect(
              await db.query(`SELECT * FROM ${table} WHERE project_id=$1`, [f.projectId])
            ).toHaveLength(0);
        } finally {
          sourceNative.close();
        }
      }
    );
  });
afterAll(async () => {
  native.close();
  await pg?.pool.end();
});
