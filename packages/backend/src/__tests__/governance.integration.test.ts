import { randomUUID } from "crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type {
  PolicyRuleRevision,
  StructuredReviewFinding,
  PolicyEvaluation,
} from "@opensprint/shared";
import type { DbClient } from "../db/client.js";
import { createSqliteDbClient } from "../db/sqlite-client.js";
import { runSchema } from "../db/schema.js";
import { GovernanceService } from "../services/governance-store.js";
import { ReplayFixtureService } from "../services/replay-fixture.service.js";
import { createTestPostgresClient } from "./test-db-helper.js";
import { MemoryReplayEvidence } from "./replay-evidence-test-helper.js";

const pg = await createTestPostgresClient();
const sqlitedb = new Database(":memory:");
sqlitedb.pragma("foreign_keys=ON");
const sqlite = createSqliteDbClient(sqlitedb);
const fixtureRule: PolicyRuleRevision = {
  id: "repository@1",
  ruleId: "repository",
  revision: 1,
  text: "Use the repository layer.",
  rationale: "Storage consistency.",
  owner: "owner",
  paths: ["src/**"],
  components: [],
  roles: [],
  severity: "standard",
  mandatory: false,
  exceptionEligible: true,
  examples: { compliant: ["repo.find()"], noncompliant: ["db.query()"] },
  parentIds: [],
  overrideIds: [],
  conflictIds: [],
  layer: 1,
  sourceHash: "",
};
for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !pg)(`review governance (${dialect})`, () => {
    let db: DbClient;
    let serial = Promise.resolve();
    beforeAll(async () => {
      db = dialect === "sqlite" ? sqlite : pg!.client;
      await runSchema(db, dialect);
      await runSchema(db, dialect);
    });
    const replayEvidence = new MemoryReplayEvidence();
    const service = () =>
      new GovernanceService({
        getDb: async () => db,
        replayEvidence,
        runWrite: (fn) => {
          const task = serial.then(() => db.runInTransaction(fn));
          serial = task.then(
            () => {},
            () => {}
          );
          return task;
        },
      });
    async function fixture() {
      const projectId = `gov-${randomUUID()}`,
        taskId = `os-${randomUUID()}`,
        svc = service();
      await db.execute(
        "INSERT INTO tasks(id,project_id,title,status,created_at,updated_at) VALUES($1,$2,'Diagnostic','in_progress',$3,$4)",
        [taskId, projectId, new Date().toISOString(), new Date().toISOString()]
      );
      await db.execute(
        "INSERT INTO governance_task_scopes(project_id,task_id,scope) VALUES($1,$2,'original')",
        [projectId, taskId]
      );
      const release = await svc.createRelease(
        projectId,
        {
          rules: [fixtureRule],
          instructions: {
            coder: "frozen coder",
            reviewer: "frozen reviewer",
            judge: "frozen judge",
          },
          sourceHashes: {},
          enforcementRevision: "a".repeat(40),
        },
        "owner"
      );
      await svc.activateRelease(
        projectId,
        release.id,
        { expectedActiveReleaseId: null, rationale: "Approve manually entered standards" },
        "owner"
      );
      await svc.configure(projectId, { mode: "enforced", expectedVersion: 1 }, "owner");
      const pin = (await svc.pinTask({
        projectId,
        taskId,
        baseSha: "a".repeat(40),
        trustedScope: "Read-only diagnostics",
        instructionsByRole: { coder: "live mutated instructions" },
        worktreePath: "/tmp/governance-test",
        branchName: "task/diagnostic",
      }))!;
      const finding: StructuredReviewFinding = {
        id: "finding-1",
        category: "standard",
        ruleId: fixtureRule.ruleId,
        ruleRevisionId: fixtureRule.id,
        file: "src/diagnostic.ts",
        codeRevision: "b".repeat(40),
        evidence: "Direct query at line 12.",
        severity: "blocking",
        suggestedRemedy: "Use a repository method.",
        provenance: { reviewer: "reviewer" },
      };
      const caseInput = {
        projectId,
        taskId,
        releaseId: release.id,
        headSha: "b".repeat(40),
        diffHash: "diff-1",
        baseSha: pin.baseSha,
        changedPaths: ["src/diagnostic.ts"],
        title: "Diagnostic access",
        summary: "A read-only diagnostic needs an exception.",
        findings: [finding],
        appeals: [],
        evidence: {
          diff: "complete untruncated diff",
          alternatives: ["repository does not expose this query"],
        },
        worktreePath: pin.worktreePath,
        branchName: pin.branchName,
      };
      return { svc, projectId, taskId, release, pin, finding, caseInput };
    }
    it("validates and clears separate human-approved reconsideration configuration", async () => {
      const f = await fixture();
      await expect(
        f.svc.configure(
          f.projectId,
          {
            expectedVersion: 2,
            reconsiderationAgent: { type: "claude-cli", model: "cli-model", cliCommand: null },
          },
          "owner"
        )
      ).rejects.toThrow(/tool-free Claude or OpenAI/);
      await expect(
        f.svc.configure(
          f.projectId,
          {
            expectedVersion: 2,
            reconsiderationTokenPricing: { inputPerMillionUsd: -1, outputPerMillionUsd: 2 },
          },
          "owner"
        )
      ).rejects.toThrow(/Reconsideration token price/);
      const configured = await f.svc.configure(
        f.projectId,
        {
          expectedVersion: 2,
          reconsiderationAgent: { type: "claude", model: "reviewer-model", cliCommand: null },
          reconsiderationTokenPricing: { inputPerMillionUsd: 3, outputPerMillionUsd: 5 },
          judgeAgent: { type: "openai", model: "judge-model", cliCommand: null },
          judgeTokenPricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
        },
        "owner"
      );
      expect(configured.reconsiderationAgent?.model).toBe("reviewer-model");
      expect(configured.judgeAgent?.model).toBe("judge-model");
      const cleared = await f.svc.configure(
        f.projectId,
        {
          expectedVersion: configured.version,
          reconsiderationAgent: null,
          reconsiderationTokenPricing: null,
        },
        "owner"
      );
      expect(cleared.reconsiderationAgent).toBeNull();
      expect(cleared.reconsiderationTokenPricing).toBeNull();
      expect(cleared.judgeAgent?.model).toBe("judge-model");
      const humanOnly = await f.svc.configure(
        f.projectId,
        {
          expectedVersion: cleared.version,
          judgeAgent: null,
          judgeTokenPricing: null,
        },
        "owner"
      );
      expect(humanOnly.judgeAgent).toBeNull();
      expect(humanOnly.judgeTokenPricing).toBeNull();
      expect((await service().getConfig(f.projectId)).judgeAgent).toBeNull();
    });
    it("pins immutable policy and trusted scope across retries and live edits", async () => {
      const f = await fixture();
      expect(f.pin.instructionsByRole.coder).toBe("frozen coder");
      expect(await f.svc.captureTrustedScope(f.projectId, f.taskId, "original")).toBe("original");
      expect(await f.svc.captureTrustedScope(f.projectId, f.taskId, "integration unlock")).toBe(
        "original"
      );
      const next = await f.svc.pinTask({ ...f.pin, instructionsByRole: { coder: "changed" } });
      expect(next).toEqual(f.pin);
      const context = await f.svc.refreshContext(f.pin, "coder", f.caseInput.changedPaths);
      expect(context.content).toContain("frozen coder");
    });
    it("persists cases before durable notification delivery and survives reconstructed service", async () => {
      const f = await fixture();
      const c = await f.svc.openCase(f.caseInput);
      expect(await f.svc.hasTaskHold(f.projectId, f.taskId)).toBe(true);
      const restarted = service();
      expect((await restarted.getCase(f.projectId, c.id)).evidence).toEqual(f.caseInput.evidence);
      await restarted.deliverOutbox(f.projectId);
      await restarted.deliverOutbox(f.projectId);
      expect(
        await db.query("SELECT id FROM open_questions WHERE project_id=$1 AND kind='governance'", [
          f.projectId,
        ])
      ).toHaveLength(1);
      expect((await db.queryOne("SELECT status FROM tasks WHERE id=$1", [f.taskId]))?.status).toBe(
        "blocked"
      );
    });
    it("atomically records an idempotent one-time ruling with exact code binding and resumes review", async () => {
      const f = await fixture();
      const c = await f.svc.openCase(f.caseInput);
      const input = {
        expectedVersion: c.version,
        idempotencyKey: "ruling-1",
        action: "allow_once" as const,
        rationale: "The diagnostic is bounded and read-only",
        headSha: c.headSha,
        diffHash: c.diffHash,
      };
      const d = await f.svc.resolveCase(f.projectId, c.id, input, "owner");
      expect(await f.svc.resolveCase(f.projectId, c.id, input, "owner")).toEqual(d);
      expect(await f.svc.hasTaskHold(f.projectId, f.taskId)).toBe(false);
      const task = await db.queryOne("SELECT status,extra FROM tasks WHERE id=$1", [f.taskId]);
      expect(task?.status).toBe("open");
      expect(JSON.parse(String(task?.extra)).governance_resume).toBe(true);
      await expect(
        f.svc.resolveCase(f.projectId, c.id, { ...input, rationale: "different" }, "owner")
      ).rejects.toThrow(/Idempotency/);
      expect(
        await f.svc.findPrecedent(f.projectId, f.release.id, [fixtureRule.id], c.changedPaths)
      ).toHaveLength(1);
    });
    it("rejects stale versions stale code and attempts to waive hard defects", async () => {
      const f = await fixture();
      const c = await f.svc.openCase(f.caseInput);
      const input = {
        expectedVersion: 999,
        idempotencyKey: "ruling",
        action: "allow_once" as const,
        rationale: "read-only",
        headSha: c.headSha,
        diffHash: c.diffHash,
      };
      await expect(f.svc.resolveCase(f.projectId, c.id, input, "owner")).rejects.toThrow(/changed/);
      await expect(
        f.svc.resolveCase(
          f.projectId,
          c.id,
          { ...input, expectedVersion: 1, headSha: "changed" },
          "owner"
        )
      ).rejects.toThrow(/stale code/);
      const defect = await f.svc.openCase({
        ...f.caseInput,
        idempotencyKey: "defect",
        findings: [{ ...f.finding, id: "defect", category: "defect" }],
      });
      await expect(
        f.svc.resolveCase(
          f.projectId,
          defect.id,
          { ...input, expectedVersion: 1, idempotencyKey: "defect-ruling" },
          "owner"
        )
      ).rejects.toThrow(/cannot waive/);
    });
    it("cannot merge through holds disabled configuration direct reopening or stale review approvals", async () => {
      const f = await fixture();
      const c = await f.svc.openCase(f.caseInput);
      await db.execute("UPDATE tasks SET status='open' WHERE id=$1", [f.taskId]);
      await expect(
        f.svc.configure(f.projectId, { mode: "disabled", expectedVersion: 2 }, "owner")
      ).rejects.toThrow(/holds/);
      await expect(f.svc.assertMergeAdmission({ ...f.caseInput })).rejects.toThrow(/hold/);
      await f.svc.resolveCase(
        f.projectId,
        c.id,
        {
          expectedVersion: 1,
          idempotencyKey: "allow",
          action: "allow_once",
          rationale: "bounded",
          headSha: c.headSha,
          diffHash: c.diffHash,
        },
        "owner"
      );
      await expect(f.svc.assertMergeAdmission({ ...f.caseInput })).rejects.toThrow(/review/);
      const receipt = (await f.svc.refreshContext(f.pin, "reviewer", c.changedPaths)).receipt;
      await f.svc.recordReviewApproval({ ...f.caseInput, receipt, gatePassed: true });
      await expect(f.svc.assertMergeAdmission({ ...f.caseInput })).resolves.toBeUndefined();
      await expect(
        f.svc.assertMergeAdmission({ ...f.caseInput, headSha: "rebased" })
      ).rejects.toThrow(/changed/);
    });
    it("differentiates reusable rulings from discoverable once evidence and revokes pending approvals", async () => {
      const f = await fixture();
      const c = await f.svc.openCase(f.caseInput);
      const d = await f.svc.resolveCase(
        f.projectId,
        c.id,
        {
          expectedVersion: 1,
          idempotencyKey: "reusable",
          action: "allow_reusable",
          rationale: "Only bounded diagnostics",
          headSha: c.headSha,
          diffHash: c.diffHash,
          conditions: {
            version: 1,
            paths: ["src/diagnostic.ts"],
            ruleRevisionIds: [fixtureRule.id],
            expiresAt: "2099-01-01T00:00:00Z",
          },
        },
        "owner"
      );
      expect(
        await f.svc.findPrecedent(
          f.projectId,
          f.release.id,
          [fixtureRule.id],
          ["src/diagnostic.ts"]
        )
      ).toHaveLength(1);
      expect(
        await f.svc.findPrecedent(f.projectId, f.release.id, [fixtureRule.id], ["src/unrelated.ts"])
      ).toHaveLength(0);
      await f.svc.revokeDecision(f.projectId, d.id, "Counterexample invalidates reuse", "owner");
      expect(await f.svc.hasTaskHold(f.projectId, f.taskId)).toBe(true);
      expect(
        await f.svc.findPrecedent(f.projectId, f.release.id, [fixtureRule.id], c.changedPaths)
      ).toHaveLength(0);
      expect((await f.svc.listDecisions(f.projectId))[0].revokedAt).toBeTruthy();
    });
    it("cumulates budgets across commits and preserves evidence despite ordinary session pruning", async () => {
      const f = await fixture();
      await f.svc.consumeBudget(f.projectId, f.taskId, { appeals: 3 });
      await expect(f.svc.consumeBudget(f.projectId, f.taskId, { appeals: 1 })).rejects.toThrow(
        /budget exhausted/
      );
      const c = await f.svc.openCase(f.caseInput);
      await f.svc.recordPromptSnapshot(
        f.projectId,
        f.taskId,
        "coder",
        "complete prompt",
        "b".repeat(40)
      );
      await db.execute("DELETE FROM agent_sessions WHERE project_id=$1", [f.projectId]);
      expect((await f.svc.getCase(f.projectId, c.id)).evidence).toEqual(f.caseInput.evidence);
      expect((await f.svc.getPromptSnapshots(f.projectId, f.taskId))[0].payload.prompt).toBe(
        "complete prompt"
      );
    });
    it("refuses activation when retained replay evidence is missing, changed, or unbound", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "replay-evidence-"));
      const repo = path.join(root, "repo");
      const run = promisify(execFile);
      try {
        await fs.mkdir(repo);
        await run("git", ["init", "-q"], { cwd: repo });
        await run(
          "git",
          ["-c", "user.name=T", "-c", "user.email=t@e.test", "commit", "--allow-empty", "-m", "x"],
          { cwd: repo }
        );
        const sha = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
        const store = new ReplayFixtureService(path.join(root, "evidence"));
        const f = await fixture();
        const svc = new GovernanceService({
          getDb: async () => db,
          runWrite: (fn) => db.runInTransaction(fn),
          replayEvidence: store,
        });
        const c = await svc.openCase(f.caseInput);
        const d = await svc.resolveCase(
          f.projectId,
          c.id,
          {
            expectedVersion: 1,
            idempotencyKey: "binding",
            action: "allow_once",
            rationale: "bounded",
            headSha: c.headSha,
            diffHash: c.diffHash,
          },
          "owner"
        );
        const p = await svc.createProposal(f.projectId, {
          baseReleaseId: f.release.id,
          title: "Amend",
          rationale: "ruling",
          patches: [
            {
              ruleId: fixtureRule.ruleId,
              before: f.release.rules[0],
              after: { ...f.release.rules[0], id: "repository@3", revision: 3, text: "Amended." },
            },
          ],
          supportingDecisionIds: [d.id],
          contraryDecisionIds: [],
          scope: "src",
          compatibility: "same",
          enforcementRevision: f.release.enforcementRevision,
          positiveExamples: ["ok"],
          negativeExamples: ["bad"],
        });
        const candidate = await svc.previewProposalRelease(f.projectId, p.id);
        const stored = await Promise.all(
          (["compliant", "defect"] as const).map((label, i) =>
            store.capture(
              {
                version: 1,
                projectId: f.projectId,
                sessionId: i + 1,
                baseCommitSha: sha,
                taskPrompt: "task",
                instructions: {
                  general: "g",
                  roles: { coder: "c", reviewer: "r" },
                  templates: { coder: "c", reviewer: "r", finalReview: "f", selfImprovement: "s" },
                },
                toolchain: "offline",
                rubric: {
                  id: "rubric",
                  text: "text",
                  checks: [{ name: "check", command: "true", args: [] }],
                },
                label,
                holdout: true,
                humanActor: "owner",
                createdAt: "2026-10-30T00:00:00Z",
              },
              repo
            )
          )
        );
        const fixtureCoverage = stored.map((s, i) => ({
          fixtureId: String(s.fixture.sessionId),
          fixtureHash: s.hash,
          taskId: `held-out-${i}`,
          label: s.fixture.label,
          expectedOutcome: i ? ("block_or_avoid" as const) : ("accept" as const),
          holdout: true,
          evidenceTask: false,
          amendedRuleSelected: true,
          contentDiffers: true,
        }));
        const artifactHash = await store.saveEvaluation(f.projectId, {
          proposalId: p.id,
          candidateRelease: { contentHash: candidate.contentHash },
          fixtureHashes: stored.map((s) => s.hash),
          complete: true,
          passed: true,
        });
        const evaluated = await svc.recordEvaluation(
          f.projectId,
          p.id,
          {
            complete: true,
            passed: true,
            executor: "offline-docker:trusted",
            fixtureIds: ["1", "2"],
            heldOutCount: 2,
            positiveCount: 1,
            negativeCount: 1,
            fixtureCoverage,
            baseline: { taskSuccessRate: 1 },
            candidate: { taskSuccessRate: 1 },
            artifactHash,
            releaseContentHash: candidate.contentHash,
            measuredAt: new Date().toISOString(),
          },
          p.version
        );
        const activate = () =>
          svc.activateProposal(
            f.projectId,
            p.id,
            {
              expectedVersion: evaluated.version,
              expectedActiveReleaseId: f.release.id,
              rationale: "accepted",
            },
            "owner"
          );
        // Files are intact but no database binding exists yet.
        await expect(activate()).rejects.toThrow("does not match this evaluation");
        for (const [i, s] of stored.entries())
          await svc.recordReplayFixture(f.projectId, {
            sessionId: s.fixture.sessionId,
            taskId: `held-out-${i}`,
            releaseId: f.release.id,
            hash: s.hash,
          });
        await expect(
          svc.recordReplayFixture(f.projectId, {
            sessionId: 1,
            taskId: "held-out-0",
            releaseId: f.release.id,
            hash: "replacement",
          })
        ).rejects.toThrow("immutable");
        const dir = path.join(
          root,
          "evidence",
          (await fs.readdir(path.join(root, "evidence")))[0]!
        );
        const artifactFile = path.join(dir, "evaluations", `${artifactHash}.json`);
        const artifact = await fs.readFile(artifactFile, "utf8");
        await fs.writeFile(artifactFile, artifact.replace("true", "false"));
        await expect(activate()).rejects.toThrow("evidence is unavailable");
        await fs.rm(artifactFile);
        await expect(activate()).rejects.toThrow("evidence is unavailable");
        await fs.writeFile(artifactFile, artifact);
        const fixtureFile = path.join(dir, "2.json");
        const original = await fs.readFile(fixtureFile, "utf8");
        await fs.writeFile(fixtureFile, original.replace('"task"', '"changed"'));
        await expect(activate()).rejects.toThrow("evidence is unavailable");
        await fs.writeFile(fixtureFile, original);
        // Valid evidence still cannot strand unfinished work under the previous release.
        await expect(activate()).rejects.toMatchObject({ code: "GOVERNANCE_HOLD" });
        await db.execute("UPDATE tasks SET status='closed' WHERE project_id=$1 AND id=$2", [
          f.projectId,
          f.taskId,
        ]);
        expect((await activate()).rules[0].text).toBe("Amended.");
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
    it("mines human decisions without commits and refuses synthetic or stale proposal activation", async () => {
      const f = await fixture();
      await f.svc.configure(f.projectId, { expectedVersion: 2, recurrenceThreshold: 1 }, "owner");
      const c = await f.svc.openCase(f.caseInput);
      const d = await f.svc.resolveCase(
        f.projectId,
        c.id,
        {
          expectedVersion: 1,
          idempotencyKey: "once",
          action: "allow_once",
          rationale: "bounded diagnostic",
          headSha: c.headSha,
          diffHash: c.diffHash,
        },
        "owner"
      );
      const nominations = await f.svc.mineDecisions(f.projectId);
      expect(nominations).toHaveLength(1);
      expect(await f.svc.mineDecisions(f.projectId)).toHaveLength(0);
      const p = await f.svc.createProposal(f.projectId, {
        baseReleaseId: f.release.id,
        sourceNominationId: nominations[0].id,
        title: "Diagnostic clarification",
        rationale: "ruling",
        patches: [
          {
            ruleId: fixtureRule.ruleId,
            before: f.release.rules[0],
            after: {
              ...f.release.rules[0],
              id: "repository@2",
              revision: 2,
              text: "Use repositories; diagnostics require explicit approval.",
            },
          },
        ],
        supportingDecisionIds: [d.id],
        contraryDecisionIds: [],
        scope: "src diagnostics",
        compatibility: "same checker compatible both releases",
        enforcementRevision: f.release.enforcementRevision,
        positiveExamples: ["approved read only"],
        negativeExamples: ["writes bypass repository"],
      });
      const candidate = await f.svc.previewProposalRelease(f.projectId, p.id);
      const incomplete: PolicyEvaluation = {
        complete: false,
        passed: false,
        executor: "docker-isolated",
        fixtureIds: ["fixture"],
        heldOutCount: 1,
        positiveCount: 1,
        negativeCount: 1,
        baseline: { passed: 1 },
        candidate: { passed: 1 },
        ...(await replayEvidence.seed(
          f.svc,
          f.projectId,
          p.id,
          candidate.contentHash,
          f.release.id
        )),
        releaseContentHash: candidate.contentHash,
        measuredAt: new Date().toISOString(),
      };
      await f.svc.recordEvaluation(f.projectId, p.id, incomplete, p.version);
      await expect(
        f.svc.activateProposal(
          f.projectId,
          p.id,
          { expectedVersion: 2, expectedActiveReleaseId: f.release.id, rationale: "try" },
          "owner"
        )
      ).rejects.toThrow(/complete/);
      const evaluated = await f.svc.recordEvaluation(
        f.projectId,
        p.id,
        { ...incomplete, complete: true, passed: true },
        2
      );
      // The source task has completed before a new release is activated.
      await db.execute("UPDATE tasks SET status='closed' WHERE project_id=$1 AND id=$2", [
        f.projectId,
        f.taskId,
      ]);
      const activated = await f.svc.activateProposal(
        f.projectId,
        p.id,
        {
          expectedVersion: evaluated.version,
          expectedActiveReleaseId: f.release.id,
          rationale: "measured evidence accepted",
        },
        "owner"
      );
      expect((await f.svc.getActiveRelease(f.projectId))?.rules[0].id).toBe("repository@2");
      await f.svc.rollback(
        f.projectId,
        f.release.id,
        activated.id,
        "Restore prior policy",
        "owner"
      );
      expect((await f.svc.getActiveRelease(f.projectId))?.rules[0].id).toBe("repository@1");
    });
  });
}
afterAll(() => sqlitedb.close());
