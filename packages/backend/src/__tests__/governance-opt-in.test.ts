import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Request, Response } from "express";
import type { PolicyRuleRevision } from "@opensprint/shared";
import type { DbClient } from "../db/client.js";
import { createSqliteDbClient } from "../db/sqlite-client.js";
import { runSchema } from "../db/schema.js";
import { GovernanceService, PUBLICATION_LEASE_TTL_MS } from "../services/governance-store.js";
import type { GovernanceStoreDeps } from "../services/governance-store.js";
import type { CreateOpts, StoredTask } from "../services/task-store.types.js";
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
  governanceBranchPathSnapshot,
  governanceCodeSnapshot,
} from "../services/governance-execution.service.js";
import { RemotePublicationGovernanceService } from "../services/remote-publication-governance.service.js";
import { governanceSensitiveSourcePaths } from "../services/governance-source-hashes.js";
import { requireGovernanceHumanWhenActive } from "../middleware/governance-settings.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await exec("git", args, { cwd })).stdout.trim();
let native: Database.Database, db: DbClient, root: string;
const rows = async (table: string, projectId: string) =>
  (await db.query(`SELECT 1 AS present FROM ${table} WHERE project_id=$1`, [projectId])).length;
const service = (overrides: Partial<GovernanceStoreDeps> = {}) =>
  new GovernanceService({
    getDb: async () => db,
    runWrite: (fn) => db.runInTransaction(fn),
    ...overrides,
  });
const rule: PolicyRuleRevision = {
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
/** A project with an approved policy, enforced: the state every "active" path must keep working in. */
async function activeProject(svc: GovernanceService): Promise<string> {
  const projectId = `active-${randomUUID()}`;
  const release = await svc.createRelease(
    projectId,
    {
      rules: [rule],
      instructions: { coder: "c", reviewer: "r" },
      sourceHashes: {},
      enforcementRevision: "a".repeat(40),
    },
    "owner"
  );
  await svc.activateRelease(
    projectId,
    release.id,
    { expectedActiveReleaseId: null, rationale: "go" },
    "owner"
  );
  await svc.configure(projectId, { mode: "enforced", expectedVersion: 1 }, "owner");
  return projectId;
}
const insertLease = (projectId: string, owner: string | null, expiresAt: string) =>
  db.execute(
    "INSERT INTO governance_publication_leases(project_id,token,expires_at,owner) VALUES($1,$2,$3,$4)",
    [projectId, `token-${randomUUID()}`, expiresAt, owner]
  );
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

beforeEach(async () => {
  native = new Database(":memory:");
  db = createSqliteDbClient(native);
  await runSchema(db, "sqlite");
  current.service = service();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "governance-opt-in-"));
});
afterEach(async () => {
  native.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe("isGovernanceInactive", () => {
  it("is true only with no mode, release, case or pin", async () => {
    const svc = service();
    expect(await svc.isGovernanceInactive("never-enabled")).toBe(true);
    expect(await svc.isGovernanceInactive(await activeProject(svc))).toBe(false);
    await db.execute(
      "INSERT INTO policy_releases(project_id,id,content_hash,payload) VALUES('retained','r','h','{}')"
    );
    await db.execute(
      "INSERT INTO governance_task_pins(project_id,task_id,release_id,payload) VALUES('retained','t','r','{}')"
    );
    expect(await svc.isGovernanceInactive("retained")).toBe(false);
  });
});

describe("isGovernanceInactive with the database unreachable", () => {
  const unreachable = service.bind(null, {
    getDb: () =>
      Promise.reject(Object.assign(new Error("refused"), { code: "TASK_STORE_INIT_FAILED" })),
  });
  afterEach(() => vi.unstubAllEnvs());
  it("fails closed when a restarted server lost its credentials and cannot read retained authority", async () => {
    vi.stubEnv("OPENSPRINT_GOVERNANCE_OWNER", "");
    vi.stubEnv("OPENSPRINT_GOVERNANCE_APPROVAL_SECRET", "");
    await expect(unreachable().isGovernanceInactive("p")).rejects.toThrow("refused");
    const publish = vi.fn();
    await expect(unreachable().withPublicationLock("p", publish)).rejects.toThrow("refused");
    expect(publish).not.toHaveBeenCalled();
  });
  it("fails closed when approval authority is configured", async () => {
    vi.stubEnv("OPENSPRINT_GOVERNANCE_OWNER", "Owner");
    vi.stubEnv("OPENSPRINT_GOVERNANCE_APPROVAL_SECRET", "x".repeat(32));
    await expect(unreachable().isGovernanceInactive("p")).rejects.toThrow("refused");
  });
  it("fails closed on an error that says nothing about reachability", async () => {
    vi.stubEnv("OPENSPRINT_GOVERNANCE_OWNER", "");
    vi.stubEnv("OPENSPRINT_GOVERNANCE_APPROVAL_SECRET", "");
    const broken = service({ getDb: () => Promise.reject(new Error("schema corrupted")) });
    await expect(broken.isGovernanceInactive("p")).rejects.toThrow("schema corrupted");
  });
});

describe("publication lease", () => {
  it("takes no lease on an inactive project, even past a stale row", async () => {
    await insertLease("off", "other-host|1|boot", inAnHour());
    await expect(service().withPublicationLock("off", async () => "ran")).resolves.toBe("ran");
    await service().withPublicationLock("clean", async () => {});
    expect(await rows("governance_publication_leases", "clean")).toBe(0);
  });

  it("uses a short TTL and records its owner on an active project", async () => {
    const svc = service({ publicationOwner: "me" });
    const projectId = await activeProject(svc);
    await svc.withPublicationLock(projectId, async () => {
      const lease = await db.queryOne(
        "SELECT expires_at,owner FROM governance_publication_leases WHERE project_id=$1",
        [projectId]
      );
      expect(lease?.owner).toBe("me");
      expect(Date.parse(String(lease?.expires_at)) - Date.now()).toBeLessThanOrEqual(
        PUBLICATION_LEASE_TTL_MS
      );
    });
    expect(PUBLICATION_LEASE_TTL_MS).toBeLessThanOrEqual(5 * 60_000);
  });

  it("clears a crashed owner at startup without waiting for the lease to expire", async () => {
    const svc = service({
      publicationOwner: "restarted",
      isPublicationOwnerAlive: (owner) => owner === "live-peer",
    });
    const crashed = await activeProject(svc);
    const peer = await activeProject(svc);
    await insertLease(crashed, "crashed", inAnHour());
    await insertLease(peer, "live-peer", inAnHour());

    expect(await svc.clearDeadPublicationLeases()).toBe(1);

    await expect(svc.withPublicationLock(crashed, async () => "recovered")).resolves.toBe(
      "recovered"
    );
    await expect(svc.withPublicationLock(peer, async () => "stolen")).rejects.toMatchObject({
      code: "GOVERNANCE_PUBLICATION_LEASE_BUSY",
    });
  });

  it("recovers a dead owner's lease on contention, for a human ruling after a restart", async () => {
    const svc = service({ publicationOwner: "restarted", isPublicationOwnerAlive: () => false });
    const projectId = await activeProject(svc);
    await insertLease(projectId, "crashed", inAnHour());
    await expect(svc.withPublicationLock(projectId, async () => "ok")).resolves.toBe("ok");
  });

  it("does not need the lease to deliver an empty outbox", async () => {
    const svc = service({ isPublicationOwnerAlive: () => true });
    const projectId = await activeProject(svc);
    await insertLease(projectId, "live-peer", inAnHour());
    await expect(svc.deliverOutbox(projectId)).resolves.toBeUndefined();
  });
});

describe("no governance writes while inactive", () => {
  it("captures no scope and leaves read paths out of write transactions", async () => {
    const runWrite = vi.fn(() => Promise.reject(new Error("database is read-only")));
    const svc = service({ runWrite });
    await expect(svc.captureTrustedScope("off", "task", "scope")).resolves.toBe("");
    await expect(svc.listCases("off")).resolves.toEqual([]);
    await expect(svc.hasTaskHold("off", "task")).resolves.toBe(false);
    await expect(svc.deliverOutbox("off")).resolves.toBeUndefined();
    expect(runWrite).not.toHaveBeenCalled();
    expect(await rows("governance_task_scopes", "off")).toBe(0);
  });

  it("still captures a scope for an active project", async () => {
    const svc = service();
    const projectId = await activeProject(svc);
    await svc.captureTrustedScope(projectId, "task", "scope");
    expect(await rows("governance_task_scopes", projectId)).toBe(1);
  });
});

describe("remote publication of an inactive project (real Git)", () => {
  let repo: string, created: number;
  const tasks = {
    create: async (_project: string, _title: string, _opts: CreateOpts) => {
      created++;
      return { id: `review-${created}` } as StoredTask;
    },
    update: async () => ({}) as StoredTask,
    show: async () => ({ status: "blocked" }) as StoredTask,
    runWrite: <T>(fn: (client: DbClient) => Promise<T>) => db.runInTransaction(fn),
  };
  const remote = () =>
    new RemotePublicationGovernanceService({
      governance: current.service,
      tasks,
      authority: { assertPublicationAuthority: async () => {} },
      lease: { acquire: async () => ({}) },
      notify: async () => {},
    } as never);
  beforeEach(async () => {
    created = 0;
    const origin = path.join(root, "origin.git");
    repo = path.join(root, "repo");
    await git(root, "init", "--bare", "-b", "main", origin);
    await git(root, "init", "-b", "main", repo);
    await git(repo, "config", "user.name", "QA");
    await git(repo, "config", "user.email", "qa@example.test");
    await git(repo, "remote", "add", "origin", origin);
    await fs.writeFile(path.join(repo, "README.md"), "base\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "base");
    await git(repo, "push", "-u", "origin", "main");
  });

  it.each([
    ["a protected path", "src/routes/oauth.ts"],
    ["a basename-sensitive file", "src/context-assembler.ts"],
    ["a checker config", "vitest.config.ts"],
  ])("pushes %s without review, tasks or receipts", async (_label, file) => {
    await fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await fs.writeFile(path.join(repo, file), "export {};\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "work");
    const head = await git(repo, "rev-parse", "HEAD");
    const service = remote();

    expect(
      await service.registerLocalPublication({
        projectId: "off",
        taskId: "t",
        repoPath: repo,
        branchName: "opensprint/t",
        baseBranch: "main",
        candidateHeadSha: head,
        baseSha: await git(repo, "rev-parse", "HEAD~1"),
      })
    ).toBeNull();
    const batch = await service.beginPush({ projectId: "off", repoPath: repo, baseBranch: "main" });
    const prepared = await service.assertPreparedPush({
      projectId: "off",
      repoPath: repo,
      baseBranch: "main",
      batch,
    });
    await service.completePush("off", prepared);

    expect(prepared.headSha).toBe(head);
    expect(created).toBe(0);
    expect(await rows("governance_events", "off")).toBe(0);
  });

  it("offers the current HEAD for deployment with no publication receipts", async () => {
    await fs.writeFile(path.join(repo, "unpublished.txt"), "x\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "local");
    expect(await remote().getDeployableHead("off", repo, "main")).toBe(
      await git(repo, "rev-parse", "HEAD")
    );
  });
});

describe("merge admission snapshots (real Git)", () => {
  let repo: string;
  beforeEach(async () => {
    repo = path.join(root, "snapshot");
    await git(root, "init", "-b", "main", repo);
    await git(repo, "config", "user.name", "QA");
    await git(repo, "config", "user.email", "qa@example.test");
    await fs.writeFile(path.join(repo, "a.txt"), "base\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "base");
  });

  it("ignores main-only changes and returns no file bytes", async () => {
    await git(repo, "checkout", "-b", "task");
    await fs.writeFile(path.join(repo, "task.txt"), "task\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "task");
    await git(repo, "checkout", "main");
    await fs.mkdir(path.join(repo, "src/routes"), { recursive: true });
    await fs.writeFile(path.join(repo, "src/routes/oauth.ts"), "main only\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "main moved");
    await git(repo, "checkout", "task");

    const snapshot = await governanceBranchPathSnapshot(repo, "main");

    expect(snapshot.changedPaths).toEqual(["task.txt"]);
    expect(snapshot).not.toHaveProperty("diff");
  });

  it("hashes real bytes rather than running a repository textconv filter", async () => {
    const marker = path.join(root, "textconv-ran");
    const filter = path.join(root, "filter.sh");
    await fs.writeFile(filter, `#!/bin/sh\ntouch "${marker}"\ncat "$1"\n`, { mode: 0o755 });
    await fs.writeFile(path.join(repo, ".gitattributes"), "*.txt diff=evil\n");
    await git(repo, "config", "diff.evil.textconv", filter);
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "attrs");
    const base = await git(repo, "rev-parse", "HEAD");
    await fs.writeFile(path.join(repo, "a.txt"), "changed\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "change");

    await governanceCodeSnapshot(repo, base);

    await expect(fs.access(marker)).rejects.toThrow();
  });
});

describe("runtime source classification", () => {
  it("does not mistake a managed repo's own files for Open Sprint runtime sources", () => {
    expect(
      governanceSensitiveSourcePaths([
        "src/app.ts",
        "server/db/schema.ts",
        "lib/project.service.ts",
        "routes/projects.ts",
      ])
    ).toEqual([]);
  });

  it("still classifies Open Sprint's own runtime paths", () => {
    const paths = [
      "packages/backend/src/app.ts",
      "packages/backend/src/db/schema.ts",
      "packages/backend/src/routes/projects.ts",
      "packages/backend/src/services/merge-coordinator.service.ts",
      "packages/backend/src/services/project/project-settings-update-flow.ts",
    ];
    expect(governanceSensitiveSourcePaths(paths)).toEqual([...paths].sort());
  });
});

describe("requireGovernanceHumanWhenActive", () => {
  const call = (projectId: string) =>
    new Promise<unknown>((resolve) =>
      requireGovernanceHumanWhenActive(
        { params: { id: projectId }, get: () => undefined } as unknown as Request,
        {} as Response,
        resolve
      )
    );
  afterEach(() => vi.unstubAllEnvs());
  it("passes an inactive project and demands the capability on an active one", async () => {
    vi.stubEnv("OPENSPRINT_GOVERNANCE_OWNER", "");
    vi.stubEnv("OPENSPRINT_GOVERNANCE_APPROVAL_SECRET", "");
    expect(await call("off")).toBeUndefined();
    expect(await call(await activeProject(current.service))).toMatchObject({
      code: "GOVERNANCE_HUMAN_REQUIRED",
    });
  });
});
