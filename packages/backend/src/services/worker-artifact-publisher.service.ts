import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executionOwnershipService, type ExecutionFence } from "./execution-ownership.service.js";
import { gitCommitQueue } from "./git-commit-queue.service.js";
import { ProjectService } from "./project.service.js";
import { taskStore } from "./task-store.service.js";
import { auditProtectedPaths } from "./protected-path-policy.js";
import { getMergeQualityGateCommands } from "./merge-quality-gates.js";
import { runIsolatedCommand } from "./agent/isolated-runner.js";
import { getGitNoHooksPath } from "../utils/git-no-hooks.js";
import type { DbClient } from "../db/client.js";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (
    await exec(
      "git",
      ["-c", `core.hooksPath=${getGitNoHooksPath()}`, "-c", "protocol.file.allow=always", ...args],
      {
        cwd,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          PATH: process.env.PATH ?? process.env.Path,
          SYSTEMROOT: process.env.SYSTEMROOT,
          USERPROFILE: process.env.USERPROFILE,
          HOME: process.env.HOME,
          TEMP: os.tmpdir(),
          TMP: os.tmpdir(),
          GIT_TERMINAL_PROMPT: "0",
          GIT_LFS_SKIP_SMUDGE: "1",
        },
      }
    )
  ).stdout.trim();
}

export interface WorkerArtifactSubmission {
  fence: ExecutionFence;
  bundlePath: string;
  expectedBase: string;
  branchName: string;
  targetWorktreePath: string;
}

async function assertPublishable(tx: DbClient, fence: ExecutionFence): Promise<void> {
  // The generic execution fence permits stop acknowledgements and completion
  // bookkeeping. Publication needs the narrower running authority under its lock.
  const row = await tx.queryOne(
    `SELECT state FROM execution_leases WHERE project_id=$1 AND run_key=$2
      AND attempt_id=$3 AND owner_id=$4 AND generation=$5`,
    [fence.projectId, fence.runKey, fence.attemptId, fence.ownerId, fence.generation]
  );
  if (row?.state !== "running")
    throw new Error("Worker publication was stopped or completed before acceptance");
}

/** Untrusted workers return bytes, never authority to change the canonical repository. */
export async function publishWorkerArtifact(
  input: WorkerArtifactSubmission
): Promise<{ commitSha: string }> {
  const { fence, expectedBase, branchName, targetWorktreePath } = input;
  if (
    !/^[a-f0-9]{40,64}$/.test(expectedBase) ||
    !branchName ||
    branchName.startsWith("-") ||
    branchName.startsWith("refs/")
  )
    throw new Error("Invalid immutable worker submission");
  const bundlePath = await fs.realpath(path.resolve(input.bundlePath));
  const stat = await fs.stat(bundlePath);
  if (!stat.isFile() || stat.size > 256 * 1024 * 1024)
    throw new Error("Invalid worker bundle size");
  await executionOwnershipService.assertCurrent(fence);
  const project = await new ProjectService().getProject(fence.projectId);
  const canonicalCommon = await fs.realpath(
    path.resolve(project.repoPath, await git(project.repoPath, "rev-parse", "--git-common-dir"))
  );
  const targetCommon = await fs.realpath(
    path.resolve(targetWorktreePath, await git(targetWorktreePath, "rev-parse", "--git-common-dir"))
  );
  if (
    canonicalCommon !== targetCommon ||
    path.resolve(targetWorktreePath) === path.resolve(project.repoPath)
  )
    throw new Error("Worker destination must be a prepared task worktree");
  if (
    (await git(targetWorktreePath, "symbolic-ref", "--short", "HEAD")) !== branchName ||
    (await git(targetWorktreePath, "rev-parse", "HEAD")) !== expectedBase
  )
    throw new Error("Worker destination changed");
  const advertised = (await git(targetWorktreePath, "bundle", "list-heads", bundlePath))
    .split("\n")
    .filter(Boolean);
  if (
    advertised.length !== 1 ||
    !/^[a-f0-9]{40,64} (?:HEAD|refs\/heads\/[a-zA-Z0-9_./-]+)$/.test(advertised[0]!)
  )
    throw new Error("A worker bundle must advertise one immutable commit");
  const commitSha = advertised[0]!.split(" ")[0]!;
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-artifact-validation-"));
  try {
    await git(staging, "clone", "--no-local", "--no-checkout", "--", project.repoPath, ".");
    await git(staging, "remote", "remove", "origin");
    await git(
      staging,
      "fetch",
      "--no-tags",
      "--",
      bundlePath,
      `${commitSha}:refs/opensprint/submission`
    );
    await git(staging, "merge-base", "--is-ancestor", expectedBase, commitSha);
    // Worker commits may only extend their exact assigned parent, without merges.
    if (await git(staging, "rev-list", "--merges", `${expectedBase}..${commitSha}`))
      throw new Error("Worker artifact contains merge commits");
    const files = (
      await git(staging, "diff", "--no-renames", "--name-only", "-z", expectedBase, commitSha)
    )
      .split("\0")
      .filter(Boolean);
    if (
      files.some(
        (file) =>
          /(^|\/)(?:\.git|\.opensprint)(?:\/|$)/i.test(file) ||
          /(^|\/)(?:AGENTS\.md|\.gitattributes|\.gitmodules)$/i.test(file)
      )
    )
      throw new Error("Worker artifact changes control-plane files");
    const changed = new Set(files);
    const entries = (await git(staging, "ls-tree", "-rz", commitSha)).split("\0").filter(Boolean);
    if (
      entries.some((entry) => {
        const tab = entry.indexOf("\t");
        return tab >= 0 && changed.has(entry.slice(tab + 1)) && /^(120000|160000) /.test(entry);
      })
    )
      throw new Error(
        "Worker artifact cannot introduce host symlinks or submodule execution surfaces"
      );
    const task = await taskStore.show(fence.projectId, fence.taskId);
    if (
      !auditProtectedPaths(files, String(task.title ?? ""), String(task.description ?? "")).allowed
    )
      throw new Error("Worker artifact changes protected paths outside task scope");
    await git(staging, "checkout", "--detach", commitSha);
    const settings = await new ProjectService().getSettings(fence.projectId);
    const commands = getMergeQualityGateCommands(settings.toolchainProfile);
    if (commands.length) {
      const command = commands.map((command) => `(${command})`).join(" && ");
      const result = await runIsolatedCommand(staging, command, 20 * 60_000);
      if (result.exitCode !== 0)
        throw new Error(`Worker artifact gate failed: ${command}: ${result.output.slice(-2000)}`);
    }
    if (
      (await git(staging, "rev-parse", "HEAD")) !== commitSha ||
      (await git(staging, "status", "--porcelain", "--untracked-files=no"))
    )
      throw new Error("Validation changed the immutable worker artifact");
    await executionOwnershipService.fenced(fence, async (tx) => {
      await assertPublishable(tx, fence);
      await tx.execute(
        `INSERT INTO worker_artifact_publications
        (project_id,attempt_id,generation,owner_id,branch_name,base_sha,commit_sha,status,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'validated',$8)`,
        [
          fence.projectId,
          fence.attemptId,
          fence.generation,
          fence.ownerId,
          branchName,
          expectedBase,
          commitSha,
          new Date().toISOString(),
        ]
      );
    });
    const ref = `refs/opensprint/validated/${randomUUID()}`;
    await gitCommitQueue.enqueueAndWait({
      type: "repository_operation",
      repoPath: project.repoPath,
      run: async () => {
        await executionOwnershipService.assertCurrent(fence);
        const destinationBranch = await git(targetWorktreePath, "symbolic-ref", "--short", "HEAD");
        const destinationHead = await git(targetWorktreePath, "rev-parse", "HEAD");
        const destinationStatus = await git(targetWorktreePath, "status", "--porcelain");
        if (
          destinationBranch !== branchName ||
          destinationHead !== expectedBase ||
          destinationStatus
        )
          throw new Error(
            `Worker destination changed during validation: ${destinationBranch}, ${destinationHead}, ${destinationStatus}`
          );
        await git(targetWorktreePath, "fetch", "--no-tags", "--", staging, `${commitSha}:${ref}`);
        try {
          // Bounded local Git CAS/checkout is the deliberate SQL-lock exception:
          // lease takeover must wait. Gates/import/network stay outside SQL.
          // The immutable intent survives a crash in the external-effect gap.
          await executionOwnershipService.fenced(fence, async (tx) => {
            await assertPublishable(tx, fence);
            await git(
              targetWorktreePath,
              "update-ref",
              `refs/heads/${branchName}`,
              commitSha,
              expectedBase
            );
            await git(targetWorktreePath, "reset", "--hard", commitSha);
            await tx.execute(
              "UPDATE worker_artifact_publications SET status = 'published', updated_at = $4 WHERE project_id = $1 AND attempt_id = $2 AND generation = $3",
              [fence.projectId, fence.attemptId, fence.generation, new Date().toISOString()]
            );
          });
        } finally {
          await git(targetWorktreePath, "update-ref", "-d", ref);
        }
      },
    });
    return { commitSha };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

/** Read-only Git observation after a publisher crash; never replays its write. */
export async function reconcileWorkerArtifact(
  projectId: string,
  attemptId: string,
  generation: number,
  targetWorktreePath: string
): Promise<"published" | "uncertain" | null> {
  const db = await taskStore.getDb();
  const record = await db.queryOne(
    "SELECT * FROM worker_artifact_publications WHERE project_id = $1 AND attempt_id = $2 AND generation = $3",
    [projectId, attemptId, generation]
  );
  if (!record) return null;
  let verified = false;
  try {
    verified =
      (await git(targetWorktreePath, "symbolic-ref", "--short", "HEAD")) === record.branch_name &&
      (await git(targetWorktreePath, "rev-parse", "HEAD")) === record.commit_sha &&
      !(await git(targetWorktreePath, "status", "--porcelain", "--untracked-files=no"));
  } catch {
    /* Explicit uncertainty preserves the external-effect boundary. */
  }
  const status = verified ? "published" : "uncertain";
  await taskStore.runWrite((tx) =>
    tx.execute(
      "UPDATE worker_artifact_publications SET status = $4, updated_at = $5 WHERE project_id = $1 AND attempt_id = $2 AND generation = $3",
      [projectId, attemptId, generation, status, new Date().toISOString()]
    )
  );
  return status;
}
