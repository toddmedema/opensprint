import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DbClient } from "../db/client.js";
import { createSqliteDbClient } from "../db/sqlite-client.js";
import { runSchema } from "../db/schema.js";
import { GovernanceService } from "../services/governance-store.js";
import {
  governanceRuntimeDrift,
  governanceSensitiveSourcePaths,
  governanceSourceDrift,
  readGovernanceSourceHashes,
  resolveGovernanceSensitiveSourcePaths,
} from "../services/governance-source-hashes.js";

const run = promisify(execFile);
let repo: string, native: Database.Database, db: DbClient;
const git = (...args: string[]) => run("git", args, { cwd: repo });
async function commitAll(message: string) {
  await git("add", "-A");
  await git("-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", message);
  return (await git("rev-parse", "HEAD")).stdout.trim();
}
beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "source-hashes-"));
  await git("init", "-q", "-b", "main");
  native = new Database(":memory:");
  db = createSqliteDbClient(native);
  await runSchema(db, "sqlite");
});
afterEach(async () => {
  native.close();
  await fs.rm(repo, { recursive: true, force: true });
});

describe("policy source classification", () => {
  it("A8: a file a configured gate runs is a checker whatever its name", async () => {
    await fs.mkdir(path.join(repo, "tools"));
    await fs.writeFile(path.join(repo, "tools/verify.mjs"), "process.exit(0)\n");
    await fs.writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "app", scripts: { gate: "node tools/verify.mjs" } })
    );
    await fs.mkdir(path.join(repo, ".opensprint"));
    await fs.writeFile(
      path.join(repo, ".opensprint/merge-toolchain.json"),
      JSON.stringify({ toolchainProfile: { mergeQualityGateCommands: ["npm run gate"] } })
    );
    const base = await commitAll("base");
    expect(Object.keys(await readGovernanceSourceHashes("p", repo, db))).toContain(
      "tools/verify.mjs"
    );
    await fs.writeFile(path.join(repo, "tools/verify.mjs"), "// skip every check\n");
    const head = await commitAll("weaken gate");
    expect(
      await resolveGovernanceSensitiveSourcePaths({
        repoPath: repo,
        baseSha: base,
        headSha: head,
        changedPaths: ["tools/verify.mjs"],
      })
    ).toEqual(["tools/verify.mjs"]);
  });
  it("A8: a symlinked checker in the scan is an error, not a silent skip", async () => {
    await fs.mkdir(path.join(repo, "scripts"));
    await fs.writeFile(path.join(repo, "real-check.sh"), "exit 0\n");
    await fs.symlink(path.join(repo, "real-check.sh"), path.join(repo, "scripts/check.sh"));
    await expect(readGovernanceSourceHashes("p", repo, db)).rejects.toThrow("symlink");
  });
  it("A8: governance-named files are policy sources only in the Open Sprint repository", async () => {
    const files = ["src/governance.ts", "src/policy-context.ts"];
    expect(governanceSensitiveSourcePaths(files)).toEqual([]);
    expect(governanceSensitiveSourcePaths(files, { openSprintRepository: true })).toEqual(files);
    await fs.mkdir(path.join(repo, "src"));
    await fs.writeFile(path.join(repo, "src/governance.ts"), "export const a = 1;\n");
    const base = await commitAll("base");
    await fs.writeFile(path.join(repo, "src/governance.ts"), "export const a = 2;\n");
    const head = await commitAll("app change");
    expect(
      await resolveGovernanceSensitiveSourcePaths({
        repoPath: repo,
        baseSha: base,
        headSha: head,
        changedPaths: ["src/governance.ts"],
      })
    ).toEqual([]);
  });
  it("W1: the server's own runtime drifts for audit only", () => {
    const approved = { "runtime:source:policy-context": "a", "AGENTS.md": "x" };
    const current = { "runtime:source:policy-context": "b", "AGENTS.md": "x" };
    expect(governanceSourceDrift(approved, current)).toEqual([]);
    expect(governanceRuntimeDrift(approved, current)).toEqual(["runtime:source:policy-context"]);
  });
});

describe("approved source refresh", () => {
  let service: GovernanceService;
  beforeEach(async () => {
    service = new GovernanceService({
      getDb: async () => db,
      runWrite: (fn) => db.runInTransaction(fn),
    });
  });
  const release = { id: "release-1", sourceHashes: { "AGENTS.md": "old" } };
  const refresh = () =>
    service.refreshApprovedSourceHashes({
      projectId: "p",
      taskId: "t",
      releaseId: "release-1",
      headSha: "h",
      diffHash: "d",
      sourcePaths: ["AGENTS.md"],
      hashes: { "AGENTS.md": "new" },
    });
  it("W1: a merged source moves the approved hash only under an exact human approval", async () => {
    await refresh();
    expect(await service.getApprovedSourceHashes("p", release)).toEqual({ "AGENTS.md": "old" });
    await service.audit("p", "policy_source_change_approved", "system", {
      taskId: "t",
      releaseId: "release-1",
      headSha: "h",
      diffHash: "d",
      changedPaths: ["AGENTS.md"],
    });
    await refresh();
    expect(await service.getApprovedSourceHashes("p", release)).toEqual({ "AGENTS.md": "old" });
    await service.audit("p", "policy_source_change_approved", "Owner", {
      taskId: "t",
      releaseId: "release-1",
      headSha: "other",
      diffHash: "d",
      changedPaths: ["AGENTS.md"],
    });
    await refresh();
    expect(await service.getApprovedSourceHashes("p", release)).toEqual({ "AGENTS.md": "old" });
    await service.audit("p", "policy_source_change_approved", "Owner", {
      taskId: "t",
      releaseId: "release-1",
      headSha: "h",
      diffHash: "d",
      changedPaths: ["AGENTS.md"],
    });
    await refresh();
    expect(await service.getApprovedSourceHashes("p", release)).toEqual({ "AGENTS.md": "new" });
  });
});
