import Database from "better-sqlite3";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DbClient } from "../db/client.js";
import { createSqliteDbClient } from "../db/sqlite-client.js";
import { runSchema } from "../db/schema.js";
import { GovernanceService } from "../services/governance-store.js";
import type { StoredTask, CreateOpts } from "../services/task-store.types.js";
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
import {
  GovernanceExecutionService,
  governanceCodeSnapshot,
} from "../services/governance-execution.service.js";
import {
  RemotePublicationGovernanceService,
  RemotePublicationReviewRequiredError,
} from "../services/remote-publication-governance.service.js";
const exec = promisify(execFile);
let root: string,
  repo: string,
  upstream: string,
  remote: string,
  native: Database.Database,
  db: DbClient,
  governance: GovernanceService,
  service: RemotePublicationGovernanceService,
  base: string,
  taskId: string,
  releaseId: string;
let created: number, notifications: ReturnType<typeof vi.fn>;
const git = async (cwd: string, args: string[]) =>
  (await exec("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 })).stdout.trim();
async function commit(cwd: string, message: string) {
  await git(cwd, ["add", "."]);
  return git(cwd, ["commit", "-m", message]);
}
async function insertTask(id: string, options: CreateOpts = {}) {
  const timestamp = new Date().toISOString();
  await db.execute(
    "INSERT INTO tasks(id,project_id,title,status,extra,created_at,updated_at)VALUES($1,'project',$2,$3,$4,$5,$6)",
    [
      id,
      "Task",
      options.initialStatus ?? "open",
      JSON.stringify(options.extra ?? {}),
      timestamp,
      timestamp,
    ]
  );
  await db.execute(
    "INSERT INTO governance_task_scopes(project_id,task_id,scope)VALUES('project',$1,$2)",
    [id, "Ordinary feature"]
  );
  return {
    id,
    title: "Task",
    status: options.initialStatus ?? "open",
    issue_type: "task",
    priority: 0,
    created_at: timestamp,
    updated_at: timestamp,
    ...options.extra,
  } as StoredTask;
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "remote-governance-"));
  repo = path.join(root, "local");
  upstream = path.join(root, "upstream");
  remote = path.join(root, "origin.git");
  await fs.mkdir(repo);
  await git(root, ["init", "--bare", remote]);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await fs.mkdir(path.join(repo, "src"));
  await fs.writeFile(path.join(repo, "src/a.ts"), "export const a = 0;\n");
  await commit(repo, "baseline");
  base = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["remote", "add", "origin", remote]);
  await git(repo, ["push", "-u", "origin", "main"]);
  await git(root, ["clone", "-b", "main", remote, upstream]);
  await git(upstream, ["config", "user.name", "Upstream"]);
  await git(upstream, ["config", "user.email", "upstream@example.com"]);
  native = new Database(":memory:");
  native.pragma("foreign_keys=ON");
  db = createSqliteDbClient(native);
  await runSchema(db, "sqlite");
  governance = new GovernanceService({
    getDb: async () => db,
    runWrite: (fn) => db.runInTransaction(fn),
  });
  current.service = governance;
  const release = await governance.createRelease(
    "project",
    {
      rules: [
        {
          id: "standard@1",
          ruleId: "standard",
          revision: 1,
          text: "Use approved patterns",
          rationale: "Consistency",
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
        },
      ],
      instructions: { coder: "coder", reviewer: "reviewer", judge: "judge" },
      sourceHashes: {},
      enforcementRevision: base,
    },
    "Owner"
  );
  releaseId = release.id;
  await governance.activateRelease(
    "project",
    release.id,
    { expectedActiveReleaseId: null, rationale: "Manual policy" },
    "Owner"
  );
  await governance.configure("project", { mode: "enforced", expectedVersion: 1 }, "Owner");
  created = 0;
  notifications = vi.fn().mockResolvedValue(undefined);
  service = new RemotePublicationGovernanceService({
    governance,
    tasks: {
      create: async (_project, _title, opts) => insertTask(`review-${++created}`, opts),
      show: async (_project, id) => {
        const row = await db.queryOne("SELECT * FROM tasks WHERE project_id='project' AND id=$1", [
          id,
        ]);
        if (!row) throw new Error("Missing task");
        return { ...row, ...JSON.parse(String(row.extra ?? "{}")) } as unknown as StoredTask;
      },
      update: async (_project, id, fields) => {
        const row = await db.queryOne(
          "SELECT extra,status FROM tasks WHERE project_id='project' AND id=$1",
          [id]
        );
        await db.execute(
          "UPDATE tasks SET status=$1,extra=$2 WHERE project_id='project' AND id=$3",
          [
            fields.status ?? row!.status,
            JSON.stringify({ ...JSON.parse(String(row!.extra ?? "{}")), ...fields.extra }),
            id,
          ]
        );
        return {} as StoredTask;
      },
      runWrite: (fn) => db.runInTransaction(fn),
    },
    authority: new GovernanceExecutionService(),
    lease: { acquire: vi.fn().mockResolvedValue({}) },
    notify: notifications,
  });
  taskId = "original";
  await insertTask(taskId);
  await governance.pinTask({
    projectId: "project",
    taskId,
    baseSha: base,
    baseBranch: "main",
    trustedScope: "Ordinary feature",
    instructionsByRole: {},
    worktreePath: repo,
    branchName: "task/original",
  });
  await fs.writeFile(path.join(repo, "src/a.ts"), "export const a = 1;\n");
  await commit(repo, "approved local task");
  const code = await governanceCodeSnapshot(repo, base);
  const pin = (await governance.getTaskPin("project", taskId))!;
  const context = await governance.refreshContext(pin, "reviewer", code.changedPaths);
  await governance.recordReviewApproval({
    projectId: "project",
    taskId,
    releaseId,
    headSha: code.headSha,
    diffHash: code.diffHash,
    receipt: context.receipt,
    gatePassed: true,
    scopeBaseSha: base,
    changedPaths: code.changedPaths,
  });
  await service.registerLocalPublication({
    projectId: "project",
    taskId,
    repoPath: repo,
    branchName: pin.branchName,
    baseBranch: "main",
    candidateHeadSha: code.headSha,
    baseSha: base,
  });
});
it("retains incompatible-release remote contributions and rejects a single-policy review bypass", async () => {
  const firstHead = await git(repo, ["rev-parse", "HEAD"]);
  const original = await governance.getRelease("project", releaseId);
  const stricter = await governance.createRelease(
    "project",
    {
      rules: original.rules.map((rule) => ({
        ...rule,
        id: "standard@2",
        revision: 2,
        text: "Use approved patterns and reject direct writes",
      })),
      instructions: original.instructions,
      sourceHashes: original.sourceHashes,
      enforcementRevision: original.enforcementRevision,
    },
    "Owner"
  );
  // Model an approved ordinary rollout while the first local publication is pending.
  await db.execute(
    "UPDATE project_governance SET active_release_id=$1 WHERE project_id='project'",
    [stricter.id]
  );
  await insertTask("new-policy-task");
  const secondPin = (await governance.pinTask({
    projectId: "project",
    taskId: "new-policy-task",
    baseSha: firstHead,
    baseBranch: "main",
    trustedScope: "Ordinary feature",
    instructionsByRole: {},
    worktreePath: repo,
    branchName: "task/new-policy",
  }))!;
  await fs.writeFile(path.join(repo, "src/b.ts"), "export const b = 1;\n");
  await commit(repo, "second task under stricter policy");
  const reviewed = await governanceCodeSnapshot(repo, firstHead);
  const receipt = (await governance.refreshContext(secondPin, "reviewer", reviewed.changedPaths))
    .receipt;
  await governance.recordReviewApproval({
    projectId: "project",
    taskId: secondPin.taskId,
    releaseId: stricter.id,
    headSha: reviewed.headSha,
    diffHash: reviewed.diffHash,
    receipt,
    gatePassed: true,
    scopeBaseSha: firstHead,
    changedPaths: reviewed.changedPaths,
  });
  await service.registerLocalPublication({
    projectId: "project",
    taskId: secondPin.taskId,
    repoPath: repo,
    branchName: secondPin.branchName,
    baseBranch: "main",
    candidateHeadSha: reviewed.headSha,
    baseSha: firstHead,
  });
  await diverge();
  const batch = await service.beginPush({
    projectId: "project",
    repoPath: repo,
    baseBranch: "main",
  });
  expect(batch.receiptIds).toHaveLength(2);
  await git(repo, ["rebase", "origin/main"]);
  await fs.writeFile(path.join(repo, "src/b.ts"), "export const b = 999;\n");
  await commit(repo, "merger changed newer-policy task");
  await expect(
    service.assertPreparedPush({ projectId: "project", repoPath: repo, baseBranch: "main", batch })
  ).rejects.toBeInstanceOf(RemotePublicationReviewRequiredError);
  const request = (await service.getRemoteReviewRequest("project", "review-1"))!;
  const held = await db.queryOne("SELECT status,extra FROM tasks WHERE id='review-1'");
  expect(held?.status).toBe("blocked");
  expect(JSON.parse(String(held?.extra)).block_reason).toContain("incompatible approved policies");
  expect(await governance.retainsTaskWorktree("project", request.taskId)).toBe(true);
  expect(await fs.stat(request.worktreePath)).toBeTruthy();
  const retainedPin = (await governance.getTaskPin("project", request.taskId))!;
  const currentCode = await governanceCodeSnapshot(request.worktreePath, request.baseSha);
  const currentContext = await governance.refreshContext(
    retainedPin,
    "reviewer",
    currentCode.changedPaths
  );
  // An ordinary reopen and passing review under the first policy cannot replace the second policy.
  await db.execute("UPDATE tasks SET status='open' WHERE id='review-1'");
  await governance.recordReviewApproval({
    projectId: "project",
    taskId: request.taskId,
    releaseId: retainedPin.releaseId,
    headSha: currentCode.headSha,
    diffHash: currentCode.diffHash,
    receipt: currentContext.receipt,
    gatePassed: true,
  });
  await expect(
    service.acceptRemoteReview({
      projectId: "project",
      taskId: request.taskId,
      repoPath: repo,
      cwd: request.worktreePath,
      branchName: request.branchName,
    })
  ).rejects.toThrow("incompatible approved policies");
  expect(await governance.listEvents("project", ["remote_publication_superseded"])).toEqual([]);
});
afterEach(async () => {
  native.close();
  await fs.rm(root, { recursive: true, force: true });
});
async function diverge() {
  await fs.writeFile(path.join(upstream, "src/upstream.ts"), "export const upstream = true;\n");
  await commit(upstream, "independent upstream");
  await git(upstream, ["push", "origin", "main"]);
}
describe("remote publication governance with real divergent Git remotes", () => {
  it("carries unchanged approved blobs through rebase and excludes already-published history", async () => {
    await diverge();
    const batch = await service.beginPush({
      projectId: "project",
      repoPath: repo,
      baseBranch: "main",
    });
    await git(repo, ["rebase", "origin/main"]);
    const prepared = await service.assertPreparedPush({
      projectId: "project",
      repoPath: repo,
      baseBranch: "main",
      batch,
    });
    expect(prepared.receiptIds).toHaveLength(1);
    await git(repo, ["push", "origin", "main"]);
    // Simulate a crash after network success but before the completion record.
    const resumed = new RemotePublicationGovernanceService(
      (service as unknown as { deps: never }).deps
    );
    expect(
      (await resumed.beginPush({ projectId: "project", repoPath: repo, baseBranch: "main" }))
        .receiptIds
    ).toEqual([]);
    expect(created).toBe(0);
  });
  it("retains merger-modified code in a fresh review task and never publishes it implicitly", async () => {
    await diverge();
    const batch = await service.beginPush({
      projectId: "project",
      repoPath: repo,
      baseBranch: "main",
    });
    await git(repo, ["rebase", "origin/main"]);
    await fs.writeFile(path.join(repo, "src/a.ts"), "export const a = 999;\n");
    await commit(repo, "merger changed task code");
    const error = await service
      .assertPreparedPush({ projectId: "project", repoPath: repo, baseBranch: "main", batch })
      .catch((error) => error);
    expect(error).toBeInstanceOf(RemotePublicationReviewRequiredError);
    expect(created).toBe(1);
    const request = await service.getRemoteReviewRequest("project", "review-1");
    expect(request?.candidateSha).toBe(await git(repo, ["rev-parse", "HEAD"]));
    expect(await git(request!.worktreePath, ["rev-parse", "HEAD"])).toBe(request?.candidateSha);
    expect((await governance.getTaskPin("project", "review-1"))?.baseSha).toBe(
      await git(repo, ["rev-parse", "origin/main"])
    );
    expect(await git(upstream, ["show", "origin/main:src/a.ts"])).toContain("a = 0");
    // Duplicate push attempts preserve one request and never reset an active review.
    await db.execute("UPDATE tasks SET status='in_progress' WHERE id='review-1'");
    await service.prepareRemoteReview("project", "review-1", repo);
    expect((await db.queryOne("SELECT status FROM tasks WHERE id='review-1'"))?.status).toBe(
      "in_progress"
    );
    await service
      .assertPreparedPush({ projectId: "project", repoPath: repo, baseBranch: "main", batch })
      .catch(() => {});
    expect(created).toBe(1);
  });
  it("checks a human cancellation before creating a changed-code followup", async () => {
    const pin = (await governance.getTaskPin("project", taskId))!;
    const code = await governanceCodeSnapshot(repo, base);
    const c = await governance.openCase({
      projectId: "project",
      taskId,
      releaseId: pin.releaseId,
      state: "awaiting_human",
      headSha: code.headSha,
      baseSha: base,
      diffHash: code.diffHash,
      changedPaths: code.changedPaths,
      title: "Held",
      summary: "Human decision",
      findings: [],
      appeals: [],
      evidence: { diff: code.diff },
      worktreePath: repo,
      branchName: pin.branchName,
    });
    await governance.resolveCase(
      "project",
      c.id,
      {
        expectedVersion: c.version,
        idempotencyKey: "cancel",
        action: "cancel",
        rationale: "Do not publish",
        headSha: c.headSha,
        diffHash: c.diffHash,
      },
      "Owner"
    );
    await diverge();
    const batch = await service.beginPush({
      projectId: "project",
      repoPath: repo,
      baseBranch: "main",
    });
    await git(repo, ["rebase", "origin/main"]);
    await fs.writeFile(path.join(repo, "src/a.ts"), "export const a = 999;\n");
    await commit(repo, "changed after cancellation");
    await expect(
      service.assertPreparedPush({
        projectId: "project",
        repoPath: repo,
        baseBranch: "main",
        batch,
      })
    ).rejects.toThrow("cancelled");
    expect(created).toBe(0);
  });
  it("rechecks revocation while a remote candidate is waiting for its fresh review", async () => {
    await diverge();
    const batch = await service.beginPush({
      projectId: "project",
      repoPath: repo,
      baseBranch: "main",
    });
    await git(repo, ["rebase", "origin/main"]);
    await fs.writeFile(path.join(repo, "src/a.ts"), "export const a = 999;\n");
    await commit(repo, "new candidate");
    await service
      .assertPreparedPush({ projectId: "project", repoPath: repo, baseBranch: "main", batch })
      .catch(() => {});
    const request = (await service.getRemoteReviewRequest("project", "review-1"))!;
    const code = await governanceCodeSnapshot(request.worktreePath, request.baseSha);
    const pin = (await governance.getTaskPin("project", "review-1"))!;
    const context = await governance.refreshContext(pin, "reviewer", code.changedPaths);
    await governance.recordReviewApproval({
      projectId: "project",
      taskId: "review-1",
      releaseId,
      headSha: code.headSha,
      diffHash: code.diffHash,
      receipt: context.receipt,
      gatePassed: true,
    });
    await governance.revokeRelease("project", releaseId, "Critical authorization issue", "Owner");
    await expect(
      service.acceptRemoteReview({
        projectId: "project",
        taskId: "review-1",
        repoPath: repo,
        cwd: request.worktreePath,
        branchName: request.branchName,
      })
    ).rejects.toThrow();
    expect(
      (await governance.listEvents("project")).filter(
        (e) => e.kind === "remote_publication_superseded"
      )
    ).toEqual([]);
  });
});

it("resumes publication only after a real remote conflict's retained candidate receives fresh review", async () => {
  await fs.writeFile(path.join(upstream, "src/a.ts"), "export const a = 7;\n");
  await commit(upstream, "conflicting upstream code");
  await git(upstream, ["push", "origin", "main"]);
  const batch = await service.beginPush({
    projectId: "project",
    repoPath: repo,
    baseBranch: "main",
  });
  await expect(git(repo, ["rebase", "origin/main"])).rejects.toThrow();
  await fs.writeFile(path.join(repo, "src/a.ts"), "export const a = 999;\n");
  await git(repo, ["add", "src/a.ts"]);
  await git(repo, ["-c", "core.editor=true", "rebase", "--continue"]);
  await expect(
    service.assertPreparedPush({ projectId: "project", repoPath: repo, baseBranch: "main", batch })
  ).rejects.toBeInstanceOf(RemotePublicationReviewRequiredError);
  expect(await git(repo, ["show", "origin/main:src/a.ts"])).toContain("a = 7");
  const request = (await service.getRemoteReviewRequest("project", "review-1"))!;
  const code = await governanceCodeSnapshot(request.worktreePath, request.baseSha);
  const pin = (await governance.getTaskPin("project", "review-1"))!;
  const context = await governance.refreshContext(pin, "reviewer", code.changedPaths);
  await governance.recordReviewApproval({
    projectId: "project",
    taskId: "review-1",
    releaseId: pin.releaseId,
    headSha: code.headSha,
    diffHash: code.diffHash,
    receipt: context.receipt,
    gatePassed: true,
    scopeBaseSha: request.baseSha,
    changedPaths: code.changedPaths,
  });
  await service.acceptRemoteReview({
    projectId: "project",
    taskId: "review-1",
    repoPath: repo,
    cwd: request.worktreePath,
    branchName: request.branchName,
  });
  const next = await service.beginPush({
    projectId: "project",
    repoPath: repo,
    baseBranch: "main",
  });
  expect(next.receiptIds).toHaveLength(1);
  const prepared = await service.assertPreparedPush({
    projectId: "project",
    repoPath: repo,
    baseBranch: "main",
    batch: next,
  });
  await git(repo, ["push", "origin", "main"]);
  await service.completePush("project", prepared);
  expect(
    (await service.beginPush({ projectId: "project", repoPath: repo, baseBranch: "main" }))
      .receiptIds
  ).toEqual([]);
  const receipt = (await governance.listEvents("project"))
    .filter((e) => e.kind === "local_publication_registered")
    .at(-1)!.payload.receipt as { scopesByPath: Record<string, string[]> };
  expect(receipt.scopesByPath["src/a.ts"]).toEqual(["Ordinary feature"]);
});

it.each([false, true])(
  "handles closed-task policy revocation with remote completed=%s",
  async (completed) => {
    if (completed) {
      const batch = await service.beginPush({
        projectId: "project",
        repoPath: repo,
        baseBranch: "main",
      });
      const prepared = await service.assertPreparedPush({
        projectId: "project",
        repoPath: repo,
        baseBranch: "main",
        batch,
      });
      await git(repo, ["push", "origin", "main"]);
      await service.completePush("project", prepared);
    }
    await db.execute("UPDATE tasks SET status='closed' WHERE id=$1", [taskId]);
    await governance.revokeRelease(
      "project",
      releaseId,
      "Critical authorization regression",
      "Owner"
    );
    const row = await db.queryOne("SELECT status FROM tasks WHERE id=$1", [taskId]);
    expect(row?.status).toBe(completed ? "closed" : "blocked");
    expect(await governance.hasTaskHold("project", taskId)).toBe(!completed);
  }
);

it.each([false, true])(
  "handles closed-task allowance expiry with remote completed=%s",
  async (completed) => {
    const code = await governanceCodeSnapshot(repo, base);
    const c = await governance.openCase({
      projectId: "project",
      taskId,
      releaseId,
      state: "awaiting_human",
      headSha: code.headSha,
      baseSha: base,
      diffHash: code.diffHash,
      changedPaths: code.changedPaths,
      title: "Diagnostic exception",
      summary: "Exception",
      findings: [
        {
          id: "finding",
          category: "standard",
          ruleId: "standard",
          ruleRevisionId: "standard@1",
          file: "src/a.ts",
          codeRevision: code.headSha,
          evidence: "Read-only diagnostic",
          severity: "blocking",
          suggestedRemedy: "Use repository",
          provenance: { reviewer: "Reviewer" },
        },
      ],
      appeals: [],
      evidence: { diff: code.diff },
      worktreePath: repo,
      branchName: "task/original",
    });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await governance.resolveCase(
      "project",
      c.id,
      {
        expectedVersion: c.version,
        idempotencyKey: "reusable",
        action: "allow_reusable",
        rationale: "Temporary diagnostic",
        headSha: c.headSha,
        diffHash: c.diffHash,
        conditions: { version: 1, paths: ["src/a.ts"], ruleRevisionIds: ["standard@1"], expiresAt },
      },
      "Owner"
    );
    if (completed) {
      const batch = await service.beginPush({
        projectId: "project",
        repoPath: repo,
        baseBranch: "main",
      });
      const prepared = await service.assertPreparedPush({
        projectId: "project",
        repoPath: repo,
        baseBranch: "main",
        batch,
      });
      await git(repo, ["push", "origin", "main"]);
      await service.completePush("project", prepared);
    }
    await db.execute("UPDATE tasks SET status='closed' WHERE id=$1", [taskId]);
    const date = vi.spyOn(Date, "now").mockReturnValue(Date.parse(expiresAt) + 1);
    try {
      await governance.refreshExpiredApprovals("project");
      const row = await db.queryOne("SELECT status FROM tasks WHERE id=$1", [taskId]);
      expect(row?.status).toBe(completed ? "closed" : "blocked");
      expect(await governance.hasTaskHold("project", taskId)).toBe(!completed);
    } finally {
      date.mockRestore();
    }
  }
);

it.each([false, true])(
  "handles closed-task decision revocation with remote completed=%s",
  async (completed) => {
    const code = await governanceCodeSnapshot(repo, base);
    const c = await governance.openCase({
      projectId: "project",
      taskId,
      releaseId,
      state: "awaiting_human",
      headSha: code.headSha,
      baseSha: base,
      diffHash: code.diffHash,
      changedPaths: code.changedPaths,
      title: "One-time diagnostic",
      summary: "Exception",
      findings: [
        {
          id: "finding",
          category: "standard",
          ruleId: "standard",
          ruleRevisionId: "standard@1",
          file: "src/a.ts",
          codeRevision: code.headSha,
          evidence: "Read-only diagnostic",
          severity: "blocking",
          suggestedRemedy: "Use repository",
          provenance: { reviewer: "Reviewer" },
        },
      ],
      appeals: [],
      evidence: { diff: code.diff },
      worktreePath: repo,
      branchName: "task/original",
    });
    const d = await governance.resolveCase(
      "project",
      c.id,
      {
        expectedVersion: c.version,
        idempotencyKey: "once",
        action: "allow_once",
        rationale: "Task allowance",
        headSha: c.headSha,
        diffHash: c.diffHash,
      },
      "Owner"
    );
    if (completed) {
      const batch = await service.beginPush({
        projectId: "project",
        repoPath: repo,
        baseBranch: "main",
      });
      const prepared = await service.assertPreparedPush({
        projectId: "project",
        repoPath: repo,
        baseBranch: "main",
        batch,
      });
      await git(repo, ["push", "origin", "main"]);
      await service.completePush("project", prepared);
    }
    await db.execute("UPDATE tasks SET status='closed' WHERE id=$1", [taskId]);
    await governance.revokeDecision("project", d.id, "Incorrect supporting facts", "Owner");
    const row = await db.queryOne("SELECT status FROM tasks WHERE id=$1", [taskId]);
    expect(row?.status).toBe(completed ? "closed" : "blocked");
    expect(await governance.hasTaskHold("project", taskId)).toBe(!completed);
  }
);

it("reconciles an offline-startup expiry hold from exact origin proof without granting future authority", async () => {
  const code = await governanceCodeSnapshot(repo, base);
  const c = await governance.openCase({
    projectId: "project",
    taskId,
    releaseId,
    state: "awaiting_human",
    headSha: code.headSha,
    baseSha: base,
    diffHash: code.diffHash,
    changedPaths: code.changedPaths,
    title: "Temporary diagnostic",
    summary: "Exception",
    findings: [
      {
        id: "finding",
        category: "standard",
        ruleId: "standard",
        ruleRevisionId: "standard@1",
        file: "src/a.ts",
        codeRevision: code.headSha,
        evidence: "Diagnostic",
        severity: "blocking",
        suggestedRemedy: "Repository",
        provenance: { reviewer: "Reviewer" },
      },
    ],
    appeals: [],
    evidence: { diff: code.diff },
    worktreePath: repo,
    branchName: "task/original",
  });
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  await governance.resolveCase(
    "project",
    c.id,
    {
      expectedVersion: c.version,
      idempotencyKey: "temporary",
      action: "allow_reusable",
      rationale: "Short lived diagnostic",
      headSha: c.headSha,
      diffHash: c.diffHash,
      conditions: { version: 1, paths: ["src/a.ts"], ruleRevisionIds: ["standard@1"], expiresAt },
    },
    "Owner"
  );
  await db.execute("UPDATE tasks SET status='closed' WHERE id=$1", [taskId]);
  const batch = await service.beginPush({
    projectId: "project",
    repoPath: repo,
    baseBranch: "main",
  });
  await service.assertPreparedPush({
    projectId: "project",
    repoPath: repo,
    baseBranch: "main",
    batch,
  });
  await git(repo, ["push", "origin", "main"]);
  // Crash before completePush, then an offline startup discovers expiry before it can fetch origin.
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(expiresAt) + 1);
  try {
    await governance.refreshExpiredApprovals("project");
    expect(await governance.hasTaskHold("project", taskId)).toBe(true);
    const recovered = await service.beginPush({
      projectId: "project",
      repoPath: repo,
      baseBranch: "main",
    });
    expect(recovered.receiptIds).toEqual([]);
    expect(await governance.hasTaskHold("project", taskId)).toBe(false);
    expect((await db.queryOne("SELECT status FROM tasks WHERE id=$1", [taskId]))?.status).toBe(
      "closed"
    );
    expect((await governance.getCase("project", c.id)).publishedRemediationOnly).toBe(true);
    expect(await governance.getReviewApproval("project", taskId)).toBeNull();
    await expect(
      governance.assertMergeAdmission({
        projectId: "project",
        taskId,
        headSha: code.headSha,
        diffHash: code.diffHash,
        changedPaths: code.changedPaths,
      })
    ).rejects.toThrow("Code changed");
  } finally {
    clock.mockRestore();
  }
});
