import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DbClient } from "../db/client.js";
import { createSqliteDbClient } from "../db/sqlite-client.js";
import { runSchema } from "../db/schema.js";
import { MemoryReplayEvidence } from "./replay-evidence-test-helper.js";
import { GovernanceService } from "../services/governance-store.js";
import type { PolicyRuleRevision, PolicyRelease, PolicyEvaluation } from "@opensprint/shared";
const current = vi.hoisted(() => ({
  service: null as unknown as GovernanceService,
  db: null as unknown as DbClient,
  rawSettings: {} as Record<string, unknown>,
  settings: {} as Record<string, unknown>,
}));
vi.mock("../services/project.service.js", () => ({
  ProjectService: class {
    async getSettings() {
      return current.settings;
    }
  },
}));
vi.mock("../services/task-store.service.js", () => ({
  taskStore: { getDb: async () => current.db },
}));
vi.mock("../services/settings-store.service.js", () => ({
  getRawSettingsRecord: async () => current.rawSettings,
}));
vi.mock("../services/agent-instructions.service.js", () => ({
  getCombinedInstructions: async () => "pinned instructions",
}));
vi.mock("../services/governance.service.js", () => ({
  governanceService: new Proxy(
    {},
    {
      get: (_target, key) => {
        const property = current.service[key as keyof GovernanceService];
        return typeof property === "function" ? property.bind(current.service) : property;
      },
    }
  ),
}));
import {
  GovernanceExecutionService,
  governanceCodeSnapshot,
} from "../services/governance-execution.service.js";
import {
  guardGovernedSettings,
  guardGovernedDeploymentSettings,
  guardGovernedGlobalSettings,
  guardGovernedInstructionEdit,
} from "../middleware/governance-settings.js";
import {
  readGovernanceSourceHashes,
  governanceSourceDrift,
  governanceSensitiveSourcePaths,
  resolveGovernanceSensitiveSourcePaths,
  resolveGovernanceCandidateSensitiveSourcePaths,
  assertGovernanceSensitiveSourceApproval,
} from "../services/governance-source-hashes.js";
import type { Request, Response } from "express";
const run = promisify(execFile);
const rule: PolicyRuleRevision = {
  id: "repository@1",
  ruleId: "repository",
  revision: 1,
  text: "Use repositories",
  rationale: "Consistency",
  owner: "owner",
  paths: ["src/**"],
  components: [],
  roles: [],
  severity: "standard",
  mandatory: false,
  exceptionEligible: true,
  examples: { compliant: ["repo"], noncompliant: ["direct"] },
  parentIds: [],
  overrideIds: [],
  conflictIds: [],
  layer: 1,
  sourceHash: "",
};
describe("adversarial governance QA round 1", () => {
  let native: Database.Database;
  let db: DbClient;
  let replayEvidence: MemoryReplayEvidence;
  let service: GovernanceService;
  let repo: string;
  let base: string;
  const projectId = "qa-governance-security";
  const taskId = "qa-task";
  beforeEach(async () => {
    native = new Database(":memory:");
    native.pragma("foreign_keys=ON");
    db = createSqliteDbClient(native);
    current.db = db;
    current.rawSettings = {};
    current.settings = {
      reviewMode: "always",
      reviewAngles: ["security"],
      includeGeneralReview: true,
      simpleComplexityAgent: { type: "claude", model: "baseline", cliCommand: null },
      complexComplexityAgent: { type: "claude", model: "baseline", cliCommand: null },
      testCommand: "npm test",
      enforceMergeGatesOnCodingSuccess: true,
      toolchainProfile: { mergeQualityGateCommands: ["npm run build", "npm run lint", "npm test"] },
    };
    await runSchema(db, "sqlite");
    replayEvidence = new MemoryReplayEvidence();
    service = new GovernanceService({
      getDb: async () => db,
      replayEvidence,
      runWrite: (fn) => db.runInTransaction(fn),
    });
    current.service = service;
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "qa-governance-"));
    await run("git", ["init", "-b", "main"], { cwd: repo });
    await run("git", ["config", "user.name", "QA"], { cwd: repo });
    await run("git", ["config", "user.email", "qa@example.test"], { cwd: repo });
    await fs.mkdir(path.join(repo, "src"));
    await fs.writeFile(path.join(repo, "src", "diagnostic.ts"), "export const diagnostic = 1;\n");
    await run("git", ["add", "."], { cwd: repo });
    await run("git", ["commit", "-m", "base"], { cwd: repo });
    base = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    await db.execute(
      "INSERT INTO tasks(id,project_id,title,status,created_at,updated_at) VALUES($1,$2,'Read-only diagnostic','open',$3,$4)",
      [taskId, projectId, new Date().toISOString(), new Date().toISOString()]
    );
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    native.close();
    await fs.rm(repo, { recursive: true, force: true });
  });
  async function pin(mode: "shadow" | "enforced", sourceHashes: Record<string, string> = {}) {
    const release = await service.createRelease(
      projectId,
      {
        rules: [rule],
        instructions: { coder: "coder", reviewer: "reviewer", judge: "judge" },
        sourceHashes,
        enforcementRevision: base,
      },
      "owner"
    );
    await service.activateRelease(
      projectId,
      release.id,
      { expectedActiveReleaseId: null, rationale: "initial" },
      "owner"
    );
    await service.configure(projectId, { mode, expectedVersion: 1 }, "owner");
    await service.captureTrustedScope(projectId, taskId, "Read-only diagnostic");
    return (await service.pinTask({
      projectId,
      taskId,
      baseSha: base,
      trustedScope: "Read-only diagnostic",
      instructionsByRole: {},
      worktreePath: repo,
      branchName: "task",
    }))!;
  }
  it("shadow disputed findings must not create a blocking case", async () => {
    await pin("shadow");
    await fs.writeFile(path.join(repo, "src", "diagnostic.ts"), "export const diagnostic = 2;\n");
    await run("git", ["add", "."], { cwd: repo });
    await run("git", ["commit", "-m", "task"], { cwd: repo });
    const head = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    const result = await new GovernanceExecutionService().rejected({
      projectId,
      taskId,
      cwd: repo,
      title: "Diagnostic",
      result: {
        status: "rejected",
        summary: "Direct access",
        notes: "",
        findings: [
          {
            id: "finding",
            category: "standard",
            ruleId: rule.ruleId,
            ruleRevisionId: rule.id,
            file: "src/diagnostic.ts",
            codeRevision: head,
            evidence: "line 1 direct access",
            severity: "blocking",
            suggestedRemedy: "repository",
            provenance: { reviewer: "reviewer" },
          },
        ],
      },
      appeals: [
        {
          findingId: "finding",
          requestedException: "Read-only",
          alternatives: ["existing layer lacks diagnostic"],
          whyCompliantOptionsFail: "No accessor",
          tests: ["unit"],
          risks: ["none"],
          proposedLimits: ["read-only"],
        },
      ],
      reviewOutput: "rejected",
    });
    expect(result.waiting).toBe(false);
    expect(await service.hasTaskHold(projectId, taskId)).toBe(false);
  });
  it("task title edits before dispatch must not grant protected scope", async () => {
    await db.execute("UPDATE tasks SET title='Integration diagnostic' WHERE id=$1", [taskId]);
    const edited = await db.queryOne("SELECT title FROM tasks WHERE id=$1", [taskId]);
    await service.captureTrustedScope(projectId, taskId, String(edited!.title));
    await expect(
      new GovernanceExecutionService().assertScope(projectId, taskId, [
        "packages/backend/src/routes/integrations-example.ts",
      ])
    ).rejects.toThrow("Protected path");
  });
  it("unrelated upstream protected changes must not become this task's scope", async () => {
    await service.captureTrustedScope(projectId, taskId, "Read-only diagnostic");
    await run("git", ["checkout", "-b", "task"], { cwd: repo });
    await fs.writeFile(path.join(repo, "src", "diagnostic.ts"), "export const diagnostic = 2;\n");
    await run("git", ["add", "."], { cwd: repo });
    await run("git", ["commit", "-m", "task"], { cwd: repo });
    await run("git", ["checkout", "main"], { cwd: repo });
    await fs.mkdir(path.join(repo, "src", "routes"));
    await fs.writeFile(
      path.join(repo, "src", "routes", "integrations-example.ts"),
      "export const integration = true;\n"
    );
    await run("git", ["add", "."], { cwd: repo });
    await run("git", ["commit", "-m", "unrelated integration task"], { cwd: repo });
    await run("git", ["merge", "--no-commit", "--no-ff", "task"], { cwd: repo });
    const snapshot = await governanceCodeSnapshot(repo, base, "task", true);
    await expect(
      new GovernanceExecutionService().assertScope(projectId, taskId, snapshot.changedPaths)
    ).resolves.toBeUndefined();
  });
  it.each(["lowComplexityAgent", "highComplexityAgent", "reviewAngles", "testCommand"])(
    "ordinary API cannot change governed %s without human capability",
    async (key) => {
      await pin("enforced");
      const failure = await new Promise<unknown>((resolve) => {
        const req = {
          params: { id: projectId },
          body: {
            [key]:
              key === "reviewAngles"
                ? []
                : key === "testCommand"
                  ? "true"
                  : {
                      type: "custom",
                      model: null,
                      cliCommand: "agent-with-different-review-behavior",
                    },
          },
          get: () => undefined,
        } as unknown as Request;
        guardGovernedSettings(req, {} as Response, (error?: unknown) => resolve(error));
      });
      expect(failure).toBeTruthy();
    }
  );
  it("releases the in-process publication gate even when durable lease cleanup loses the DB", async () => {
    let failDelete = true;
    const mockDb = {
      queryOne: async () => ({ config: '{"mode":"enforced"}', version: 1, active_release_id: "r" }),
      execute: async (sql: string) => {
        if (sql.startsWith("DELETE") && failDelete) {
          failDelete = false;
          throw new Error("transient DB disconnect");
        }
        return 1;
      },
    } as unknown as DbClient;
    const isolated = new GovernanceService({
      getDb: async () => mockDb,
      runWrite: (fn) => fn(mockDb),
    });
    await expect(isolated.withPublicationLock("transient", async () => true)).rejects.toThrow(
      "disconnect"
    );
    const second = isolated.withPublicationLock("transient", async () => "recovered");
    const result = await Promise.race([
      second,
      new Promise<string>((resolve) => setTimeout(() => resolve("stuck"), 25)),
    ]);
    expect(result).toBe("recovered");
  });
  it("withholds publication after an expired or stolen lease", async () => {
    let published = false;
    const mockDb = {
      queryOne: async () => ({ config: '{"mode":"enforced"}', version: 1, active_release_id: "r" }),
      execute: async (sql: string) => (sql.startsWith("UPDATE") ? 0 : 1),
    } as unknown as DbClient;
    const isolated = new GovernanceService({
      getDb: async () => mockDb,
      runWrite: (fn) => fn(mockDb),
    });
    await expect(
      isolated.withPublicationLock("stolen", async (assertLease) => {
        await assertLease();
        published = true;
      })
    ).rejects.toMatchObject({ code: "GOVERNANCE_PUBLICATION_LEASE_LOST" });
    expect(published).toBe(false);
  });
  it("requires human authority for inherited global model defaults and audits only hashes and keys", async () => {
    await pin("enforced");
    const body = {
      simpleComplexityAgent: {
        type: "custom",
        model: null,
        cliCommand: "contains-a-private-configuration-value",
      },
    };
    const req = { params: {}, body, get: () => undefined } as unknown as Request;
    const failure = await new Promise<unknown>((resolve) =>
      guardGovernedGlobalSettings(req, {} as Response, (error) => resolve(error))
    );
    expect(failure).toMatchObject({ statusCode: 403 });
    const capability = "authorized-human-".repeat(3);
    vi.stubEnv("OPENSPRINT_GOVERNANCE_OWNER", "QA owner");
    vi.stubEnv("OPENSPRINT_GOVERNANCE_APPROVAL_SECRET", capability);
    req.get = (() => capability) as Request["get"];
    const authorized = await new Promise<unknown>((resolve) =>
      guardGovernedGlobalSettings(req, {} as Response, (error) => resolve(error))
    );
    expect(authorized).toBeUndefined();
    const event = (await service.listEvents(projectId)).find(
      (event) => event.kind === "policy_configuration_change_authorized"
    )!;
    expect(event.actor).toBe("QA owner");
    expect(event.payload.keys).toEqual(["simpleComplexityAgent"]);
    expect(JSON.stringify(event)).not.toContain("contains-a-private-configuration-value");
  });
  it.each(["project", "deliver"] as const)(
    "requires owner authority for %s deployment-command changes",
    async (channel) => {
      await pin("enforced");
      current.settings.deployment = { mode: "custom", customCommand: "npm run deploy" };
      const command = "publish-another-tree";
      const req = {
        params: { id: projectId, projectId },
        body:
          channel === "project"
            ? { deployment: { mode: "custom", customCommand: command } }
            : { customCommand: command },
        get: () => undefined,
      } as unknown as Request;
      const handler =
        channel === "project" ? guardGovernedSettings : guardGovernedDeploymentSettings;
      const invoke = () =>
        new Promise<unknown>((resolve) => handler(req, {} as Response, (error) => resolve(error)));
      expect(await invoke()).toMatchObject({ code: "GOVERNANCE_HUMAN_REQUIRED", statusCode: 403 });
      const capability = "authorized-human-".repeat(3);
      vi.stubEnv("OPENSPRINT_GOVERNANCE_OWNER", "QA owner");
      vi.stubEnv("OPENSPRINT_GOVERNANCE_APPROVAL_SECRET", capability);
      req.get = (() => capability) as Request["get"];
      expect(await invoke()).toBeUndefined();
      const events = await service.listEvents(projectId, [
        "policy_configuration_change_authorized",
      ]);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload.keys).toEqual(["deployment"]);
      expect(JSON.stringify(events)).not.toContain(command);
      expect(JSON.stringify(events)).not.toContain(capability);
    }
  );
  it("does not switch database authority while a governed assignment is live", async () => {
    await pin("enforced");
    const req = {
      params: {},
      body: { databaseUrl: "sqlite:/different-empty-database" },
      get: () => undefined,
    } as unknown as Request;
    const failure = await new Promise<unknown>((resolve) =>
      guardGovernedGlobalSettings(req, {} as Response, (error) => resolve(error))
    );
    expect(failure).toMatchObject({ code: "GOVERNANCE_DATABASE_AUTHORITY_LOCKED" });
    expect(String(failure)).toContain("retains approved governance policy");
  });
  it("detects live checker, raw role, and newly added skill source drift", async () => {
    const before = await readGovernanceSourceHashes(projectId, repo, db);
    await fs.mkdir(path.join(repo, ".opensprint"), { recursive: true });
    await fs.writeFile(
      path.join(repo, ".opensprint", "merge-toolchain.json"),
      JSON.stringify({ toolchainProfile: { mergeQualityGateCommands: ["true"] } })
    );
    await db.execute(
      "INSERT INTO agent_instructions(project_id,role,content,updated_at) VALUES($1,'reviewer','silently weaken review',$2)",
      [projectId, new Date().toISOString()]
    );
    await fs.mkdir(path.join(repo, ".agents"));
    await fs.writeFile(path.join(repo, ".agents", "SKILL.md"), "new policy behavior");
    const currentHashes = await readGovernanceSourceHashes(projectId, repo, db);
    expect(governanceSourceDrift(before, currentHashes)).toEqual(
      expect.arrayContaining([
        ".opensprint/merge-toolchain.json",
        "role-source:reviewer",
        ".agents/SKILL.md",
      ])
    );
  });
  it("policy source approval binds all paths and exact code without changing the governing release", async () => {
    const pinned = await pin("enforced");
    const input = {
      projectId,
      taskId,
      releaseId: pinned.releaseId,
      headSha: base,
      diffHash: "actual-code",
      changedPaths: ["AGENTS.md", ".opensprint/merge-toolchain.json", "src/diagnostic.ts"],
    };
    await expect(assertGovernanceSensitiveSourceApproval(input)).rejects.toMatchObject({
      code: "GOVERNANCE_SOURCE_APPROVAL_REQUIRED",
    });
    await service.audit(projectId, "policy_source_change_approved", "QA owner", {
      ...input,
      changedPaths: governanceSensitiveSourcePaths(input.changedPaths),
      rationale: "Scoped implementation reviewed; gates remain required",
    });
    await expect(assertGovernanceSensitiveSourceApproval(input)).resolves.toBeUndefined();
    await expect(
      assertGovernanceSensitiveSourceApproval({ ...input, diffHash: "changed-after-approval" })
    ).rejects.toThrow();
    expect(await service.getActiveReleaseId(projectId)).toBe(pinned.releaseId);
  });
  it("round 2: disabling without a case does not expose a retained policy's review settings", async () => {
    await pin("enforced");
    await service.configure(projectId, { mode: "disabled", expectedVersion: 2 }, "owner");
    const req = {
      params: { id: projectId },
      body: { reviewAngles: [] },
      get: () => undefined,
    } as unknown as Request;
    const failure = await new Promise<unknown>((resolve) =>
      guardGovernedSettings(req, {} as Response, (error) => resolve(error))
    );
    expect(failure).toMatchObject({ statusCode: 403 });
  });
  it("round 2: configured authority prevents an empty-state DB-switch/onboarding race", async () => {
    const secret = "owner-approval-".repeat(4);
    vi.stubEnv("OPENSPRINT_GOVERNANCE_OWNER", "QA owner");
    vi.stubEnv("OPENSPRINT_GOVERNANCE_APPROVAL_SECRET", secret);
    const query = vi.spyOn(db, "query");
    const req = {
      params: {},
      body: { databaseUrl: "sqlite:/fresh-empty-db" },
      get: () => secret,
    } as unknown as Request;
    const failure = await new Promise<unknown>((resolve) =>
      guardGovernedGlobalSettings(req, {} as Response, (error) => resolve(error))
    );
    expect(failure).toMatchObject({ code: "GOVERNANCE_DATABASE_AUTHORITY_LOCKED" });
    expect(query).not.toHaveBeenCalled();
  });
  it("round 2: case-insensitive policy path spellings cannot evade source approval", async () => {
    const paths = ["agents.md", ".OPENSPRINT/merge-toolchain.json", "packages/new/SKILL.MD"];
    expect(governanceSensitiveSourcePaths(paths)).toEqual([...paths].sort());
    const pinned = await pin("enforced");
    await expect(
      assertGovernanceSensitiveSourceApproval({
        projectId,
        taskId,
        releaseId: pinned.releaseId,
        headSha: base,
        diffHash: "casefold",
        changedPaths: paths,
      })
    ).rejects.toMatchObject({ code: "GOVERNANCE_SOURCE_APPROVAL_REQUIRED" });
  });
  it("round 2: only an evaluated exact source reconciliation installs new hashes and rejects later drift", async () => {
    const originalHashes = await readGovernanceSourceHashes(projectId, repo, db);
    const pinned = await pin("enforced", originalHashes);
    const release = await service.getRelease(projectId, pinned.releaseId);
    const c = await service.openCase({
      projectId,
      taskId,
      releaseId: release.id,
      baseSha: base,
      headSha: base,
      diffHash: "reconciliation-evidence",
      changedPaths: ["src/diagnostic.ts"],
      title: "Clarification",
      summary: "Ruling evidence",
      findings: [
        {
          id: "finding",
          category: "standard",
          ruleId: rule.ruleId,
          ruleRevisionId: rule.id,
          file: "src/diagnostic.ts",
          codeRevision: base,
          evidence: "bounded diagnostic",
          severity: "blocking",
          suggestedRemedy: "repository",
          provenance: { reviewer: "reviewer" },
        },
      ],
      appeals: [],
      evidence: { original: "retained" },
      worktreePath: repo,
      branchName: "task",
    });
    const decision = await service.resolveCase(
      projectId,
      c.id,
      {
        expectedVersion: c.version,
        idempotencyKey: "support",
        action: "allow_once",
        rationale: "bounded diagnostic",
        headSha: base,
        diffHash: c.diffHash,
      },
      "owner"
    );
    await fs.writeFile(path.join(repo, "AGENTS.md"), "Approved revised user prose\n");
    const reconciledHashes = await readGovernanceSourceHashes(projectId, repo, db);
    const proposal = await service.createProposal(projectId, {
      baseReleaseId: release.id,
      title: "Reconcile source and clarify standard",
      rationale: "Human reviewed exact content",
      patches: [
        {
          ruleId: rule.ruleId,
          before: release.rules[0],
          after: {
            ...release.rules[0],
            id: "repository@2",
            revision: 2,
            text: "Use repositories, with explicitly approved bounded diagnostics.",
          },
        },
      ],
      instructions: { coder: "Approved revised user prose\n" },
      sourceHashes: reconciledHashes,
      supportingDecisionIds: [decision.id],
      contraryDecisionIds: [],
      scope: "Diagnostics",
      compatibility: "Existing enforcement supports both releases",
      enforcementRevision: base,
      positiveExamples: ["bounded read"],
      negativeExamples: ["unbounded write"],
    });
    const candidate = await service.previewProposalRelease(projectId, proposal.id);
    expect(candidate.sourceHashes).toEqual(reconciledHashes);
    const verify = async (content: PolicyRelease, client: DbClient) => {
      if (
        governanceSourceDrift(
          content.sourceHashes,
          await readGovernanceSourceHashes(projectId, repo, client)
        ).length
      )
        throw new Error("Policy source drift after evaluation");
    };
    const activation = {
      expectedVersion: proposal.version,
      expectedActiveReleaseId: release.id,
      rationale: "Human approval",
    };
    await expect(
      service.activateProposal(projectId, proposal.id, activation, "owner", verify)
    ).rejects.toThrow("complete");
    const evaluation: PolicyEvaluation = {
      complete: true,
      passed: true,
      executor: `offline-docker:trusted@sha256:${"a".repeat(64)}`,
      fixtureIds: Array.from({ length: 10 }, (_, i) => String(i)),
      heldOutCount: 4,
      positiveCount: 5,
      negativeCount: 5,
      baseline: { taskSuccessRate: 1 },
      candidate: { taskSuccessRate: 1 },
      ...(await replayEvidence.seed(
        service,
        projectId,
        proposal.id,
        candidate.contentHash,
        release.id
      )),
      releaseContentHash: candidate.contentHash,
      measuredAt: new Date().toISOString(),
    };
    const evaluated = await service.recordEvaluation(
      projectId,
      proposal.id,
      evaluation,
      proposal.version
    );
    // Activation now waits for work pinned to the old release, so this task has to finish first.
    await db.execute("UPDATE tasks SET status='closed' WHERE project_id=$1 AND id=$2", [
      projectId,
      c.taskId,
    ]);
    await fs.writeFile(path.join(repo, "AGENTS.md"), "Changed after independent evaluation\n");
    await expect(
      service.activateProposal(
        projectId,
        proposal.id,
        { ...activation, expectedVersion: evaluated.version },
        "owner",
        verify
      )
    ).rejects.toThrow("drift");
    expect(await service.getActiveReleaseId(projectId)).toBe(release.id);
    await fs.writeFile(path.join(repo, "AGENTS.md"), "Approved revised user prose\n");
    const activated = await service.activateProposal(
      projectId,
      proposal.id,
      { ...activation, expectedVersion: evaluated.version },
      "owner",
      verify
    );
    expect((await service.getActiveRelease(projectId))?.sourceHashes).toEqual(reconciledHashes);
    // Rollback used to refuse here, which trapped a project on a bad release whenever sources had
    // moved. It now proceeds under the owner and records the drift for reconciliation.
    const restored = await service.rollback(
      projectId,
      release.id,
      activated.id,
      "Restore the prior policy despite source drift",
      "owner",
      async (content, client) => ({
        sourceDrift: governanceSourceDrift(
          content.sourceHashes,
          await readGovernanceSourceHashes(projectId, repo, client)
        ),
      })
    );
    expect(restored.id).toBe(release.id);
    const [rollback] = await service.listEvents(projectId, ["policy_rollback"]);
    expect(rollback?.payload.sourceDrift).toContain("AGENTS.md");
    const current = await readGovernanceSourceHashes(projectId, repo, db);
    const reconciled = await service.reconcileSourceSnapshot(
      projectId,
      {
        expectedActiveReleaseId: release.id,
        rationale: "Accept current sources",
        sourceHashes: current,
        enforcementRevision: base,
        drift: rollback?.payload.sourceDrift as string[],
      },
      "owner"
    );
    expect(reconciled.rules).toEqual(release.rules);
    expect(reconciled.sourceHashes).toEqual(current);
    expect(await service.getActiveReleaseId(projectId)).toBe(reconciled.id);
  });
  it("round 3: an unchanged full settings payload permits unrelated edits while actual gate changes remain blocked", async () => {
    await pin("enforced");
    const invoke = async (body: Record<string, unknown>) =>
      new Promise<unknown>((resolve) =>
        guardGovernedSettings(
          { params: { id: projectId }, body, get: () => undefined } as unknown as Request,
          {} as Response,
          (error) => resolve(error)
        )
      );
    const payload = { ...current.settings, maxConcurrentCoders: 4, deployment: { mode: "custom" } };
    expect(await invoke(payload)).toBeUndefined();
    expect(
      await invoke({
        ...payload,
        simpleComplexityAgent: {
          ...(current.settings.simpleComplexityAgent as object),
          timeoutMs: 900_000,
        },
        complexComplexityAgent: {
          ...(current.settings.complexComplexityAgent as object),
          timeoutMs: 900_000,
        },
        worktreeBaseBranch: "main",
      })
    ).toBeUndefined();
    expect(
      await invoke({ ...payload, lowComplexityAgent: current.settings.simpleComplexityAgent })
    ).toBeUndefined();
    expect(await invoke({ ...payload, reviewAngles: [] })).toMatchObject({ statusCode: 403 });
    // Gate settings used to be refused outright; now they need the owner, like review settings.
    expect(await invoke({ ...payload, testCommand: "true" })).toMatchObject({ statusCode: 403 });
  });
  it("round 3: scripts true and checker config changes need source authority; dependency-only manifest edits do not", async () => {
    const manifest = {
      scripts: { test: "vitest run", build: "tsc", lint: "eslint src" },
      dependencies: { react: "1.0.0" },
      workspaces: ["packages/frontend"],
    };
    await fs.writeFile(path.join(repo, "package.json"), JSON.stringify(manifest));
    await run("git", ["add", "package.json"], { cwd: repo });
    await run("git", ["commit", "-m", "gate baseline"], { cwd: repo });
    const original = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    const before = await readGovernanceSourceHashes(projectId, repo, db);
    await fs.writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ ...manifest, dependencies: { react: "2.0.0" } })
    );
    await fs.mkdir(path.join(repo, "packages", "dependency-only"), { recursive: true });
    await fs.writeFile(
      path.join(repo, "packages", "dependency-only", "package.json"),
      JSON.stringify({ name: "dependency-only", dependencies: { react: "2.0.0" } })
    );
    await run("git", ["add", "."], { cwd: repo });
    await run("git", ["commit", "-m", "ordinary dependency edit"], { cwd: repo });
    const dependencyHead = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    expect(
      await resolveGovernanceSensitiveSourcePaths({
        repoPath: repo,
        baseSha: original,
        headSha: dependencyHead,
        changedPaths: ["package.json", "packages/dependency-only/package.json"],
      })
    ).toEqual([]);
    expect(
      governanceSourceDrift(before, await readGovernanceSourceHashes(projectId, repo, db))
    ).not.toContain("package.json#gate-scripts");
    expect(
      governanceSourceDrift(before, await readGovernanceSourceHashes(projectId, repo, db))
    ).not.toContain("packages/dependency-only/package.json#gate-scripts");
    expect(
      await resolveGovernanceCandidateSensitiveSourcePaths({
        repoPath: repo,
        baseSha: original,
        changedPaths: ["package.json", "packages/dependency-only/package.json"],
      })
    ).toEqual([]);
    await fs.writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ ...manifest, scripts: { ...manifest.scripts, test: "true" } })
    );
    await fs.writeFile(
      path.join(repo, "vitest.config.ts"),
      "export default { test: { exclude: ['**/*'] } };\n"
    );
    expect(
      await resolveGovernanceCandidateSensitiveSourcePaths({
        repoPath: repo,
        baseSha: original,
        changedPaths: ["package.json", "vitest.config.ts"],
      })
    ).toEqual(["package.json", "vitest.config.ts"]);
    await run("git", ["add", "."], { cwd: repo });
    await run("git", ["commit", "-m", "attempt to suppress hard checks"], { cwd: repo });
    const bypassHead = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    expect(
      await resolveGovernanceSensitiveSourcePaths({
        repoPath: repo,
        baseSha: original,
        headSha: bypassHead,
        changedPaths: ["package.json", "vitest.config.ts"],
      })
    ).toEqual(["package.json", "vitest.config.ts"]);
    const drift = governanceSourceDrift(
      before,
      await readGovernanceSourceHashes(projectId, repo, db)
    );
    expect(drift).toEqual(
      expect.arrayContaining(["package.json#gate-scripts", "vitest.config.ts"])
    );
    const pinned = await pin("enforced");
    await expect(
      assertGovernanceSensitiveSourceApproval({
        projectId,
        taskId,
        releaseId: pinned.releaseId,
        repoPath: repo,
        baseSha: original,
        headSha: bypassHead,
        diffHash: "bypass",
        changedPaths: ["package.json", "vitest.config.ts"],
      })
    ).rejects.toMatchObject({ code: "GOVERNANCE_SOURCE_APPROVAL_REQUIRED" });
  });
  it("round 3: disabled governance cannot expose retained instruction authority to ordinary API edits", async () => {
    await pin("enforced");
    await service.configure(projectId, { mode: "disabled", expectedVersion: 2 }, "owner");
    const failure = await new Promise<unknown>((resolve) =>
      guardGovernedInstructionEdit(
        {
          params: { projectId },
          body: { content: "weaken review" },
          get: () => undefined,
        } as unknown as Request,
        {} as Response,
        (error) => resolve(error)
      )
    );
    // The pinned task is retained work, so the edit needs the owner rather than being impossible.
    expect(failure).toMatchObject({ code: "GOVERNANCE_HUMAN_REQUIRED" });
  });
  it("round 3: disabled governance with no retained work treats instruction edits as ordinary", async () => {
    await pin("enforced");
    await service.configure(projectId, { mode: "disabled", expectedVersion: 2 }, "owner");
    await db.execute("UPDATE tasks SET status='closed' WHERE project_id=$1 AND id=$2", [
      projectId,
      taskId,
    ]);
    const failure = await new Promise<unknown>((resolve) =>
      guardGovernedInstructionEdit(
        { params: { projectId }, body: { content: "edit" }, get: () => undefined } as never,
        {} as Response,
        (error) => resolve(error)
      )
    );
    expect(failure).toBeUndefined();
  });
  it("round 3: cleanup retry removes a real orphaned durable lease after a transient DB failure", async () => {
    await pin("enforced");
    let failCleanup = true;
    const isolated = new GovernanceService({
      getDb: async () => db,
      runWrite: (fn) =>
        db.runInTransaction((tx) =>
          fn({
            ...tx,
            execute: async (sql, params) => {
              if (sql.startsWith("DELETE FROM governance_publication_leases") && failCleanup) {
                failCleanup = false;
                throw new Error("temporary cleanup outage");
              }
              return tx.execute(sql, params);
            },
          })
        ),
    });
    await expect(isolated.withPublicationLock(projectId, async () => "first")).rejects.toThrow(
      "temporary cleanup outage"
    );
    expect(
      await db.queryOne("SELECT token FROM governance_publication_leases WHERE project_id=$1", [
        projectId,
      ])
    ).toBeTruthy();
    await expect(
      isolated.withPublicationLock(projectId, async (assertLease) => {
        await assertLease();
        return "recovered";
      })
    ).resolves.toBe("recovered");
    expect(
      await db.queryOne("SELECT token FROM governance_publication_leases WHERE project_id=$1", [
        projectId,
      ])
    ).toBeUndefined();
  });
  it("round 3: ordinary task reopening cannot turn an explicit human cancellation into consent", async () => {
    const pinned = await pin("enforced");
    const c = await service.openCase({
      projectId,
      taskId,
      releaseId: pinned.releaseId,
      baseSha: base,
      headSha: base,
      diffHash: "cancel-code",
      changedPaths: ["src/diagnostic.ts"],
      title: "Do not ship",
      summary: "Disputed standard",
      findings: [
        {
          id: "finding",
          category: "standard",
          ruleId: rule.ruleId,
          ruleRevisionId: rule.id,
          file: "src/diagnostic.ts",
          codeRevision: base,
          evidence: "Unresolved direct query",
          severity: "blocking",
          suggestedRemedy: "Repository",
          provenance: { reviewer: "reviewer" },
        },
      ],
      appeals: [],
      evidence: { diff: "retained" },
      worktreePath: repo,
      branchName: "task",
    });
    await service.resolveCase(
      projectId,
      c.id,
      {
        expectedVersion: c.version,
        idempotencyKey: "cancel",
        action: "cancel",
        rationale: "Do not ship this task",
        headSha: base,
        diffHash: c.diffHash,
      },
      "owner"
    );
    await db.execute("UPDATE tasks SET status='open' WHERE project_id=$1 AND id=$2", [
      projectId,
      taskId,
    ]);
    const receipt = (await service.refreshContext(pinned, "reviewer", c.changedPaths)).receipt;
    await service.recordReviewApproval({
      projectId,
      taskId,
      releaseId: pinned.releaseId,
      headSha: base,
      diffHash: c.diffHash,
      receipt,
      gatePassed: true,
    });
    await expect(
      service.assertMergeAdmission({
        projectId,
        taskId,
        headSha: base,
        diffHash: c.diffHash,
        changedPaths: c.changedPaths,
      })
    ).rejects.toThrow(/cancel|hold/i);
  });
  it("round 3: an allowance expiring during candidate commit is rejected at final publication", async () => {
    const pinned = await pin("enforced", await readGovernanceSourceHashes(projectId, repo));
    await run("git", ["checkout", "-b", "task"], { cwd: repo });
    await fs.writeFile(path.join(repo, "src/diagnostic.ts"), "export const diagnostic = 2;\n");
    await run("git", ["commit", "-am", "reviewed contribution"], { cwd: repo });
    const reviewed = await governanceCodeSnapshot(repo, base);
    const c = await service.openCase({
      projectId,
      taskId,
      releaseId: pinned.releaseId,
      ...reviewed,
      title: "Temporary exception",
      summary: "Disputed standard",
      findings: [
        {
          id: "finding",
          category: "standard",
          ruleId: rule.ruleId,
          ruleRevisionId: rule.id,
          file: "src/diagnostic.ts",
          codeRevision: reviewed.headSha,
          evidence: "Direct query",
          severity: "blocking",
          suggestedRemedy: "Repository",
          provenance: { reviewer: "reviewer" },
        },
      ],
      appeals: [],
      evidence: { diff: reviewed.diff },
      worktreePath: repo,
      branchName: "task",
    });
    const at = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(at);
    try {
      await service.resolveCase(
        projectId,
        c.id,
        {
          expectedVersion: c.version,
          idempotencyKey: "short-allowance",
          action: "allow_reusable",
          rationale: "Temporary read-only exception",
          headSha: c.headSha,
          diffHash: c.diffHash,
          conditions: {
            version: 1,
            paths: ["src/**"],
            ruleRevisionIds: [rule.id],
            expiresAt: new Date(at + 1_000).toISOString(),
          },
        },
        "owner"
      );
      const receipt = (await service.refreshContext(pinned, "reviewer", reviewed.changedPaths))
        .receipt;
      await service.recordReviewApproval({
        projectId,
        taskId,
        releaseId: pinned.releaseId,
        ...reviewed,
        receipt,
        gatePassed: true,
      });
      const execution = new GovernanceExecutionService();
      await service.withPublicationLock(projectId, async () => {
        await execution.assertPublication({
          projectId,
          taskId,
          repoPath: repo,
          candidatePath: repo,
          branchName: "task",
          baseBranch: "main",
        });
        // A real candidate commit can consume the remaining lifetime; HEAD now has no uncommitted diff.
        await run("git", ["commit", "--allow-empty", "-m", "candidate committed"], { cwd: repo });
        clock.mockReturnValue(at + 2_000);
        await expect(
          execution.assertPublicationAuthority({
            projectId,
            taskId,
            repoPath: repo,
            branchName: "task",
          })
        ).rejects.toThrow(/hold|approval|expir/i);
      });
      expect(await service.hasTaskHold(projectId, taskId)).toBe(true);
      expect((await run("git", ["rev-parse", "main"], { cwd: repo })).stdout.trim()).toBe(base);
    } finally {
      clock.mockRestore();
    }
  });
});
