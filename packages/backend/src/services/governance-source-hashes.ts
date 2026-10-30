import { agentProcessEnvironment } from "../utils/agent-process-env.js";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AGENT_ROLE_CANONICAL_ORDER } from "@opensprint/shared";
import type { DbClient } from "../db/client.js";
import { getOpenSprintDefaultInstructions } from "./agent-default-instructions.js";
import { governanceHash, governanceError } from "./policy-context.js";
const git = promisify(execFile);
const RUNTIME_POLICY_SOURCES = [
  "context-assembler",
  "governance-execution.service",
  "governance-store",
  "governance-source-hashes",
  "policy-context",
  "protected-path-policy",
  "agent-result-validation",
  "review-synthesizer.service",
  "review-findings",
  "task-phase-coordinator",
  "git-commit-queue.service",
  "merge-quality-gates",
  "merge-quality-gate-runner",
  "test-runner",
  "deployment-service",
  "nightly-deploy-scheduler.service",
  "scaffold-recovery.service",
  "project/project-scaffold-flow",
  "project/project-scaffold-recovery",
  "toolchain-profile.service",
  "policy-evaluation.service",
  "isolated-replay-runner.service",
  "replay-source-archive",
  "replay-fixture.service",
  "governance-replay-input",
  "governance-context-artifacts",
  "remote-publication-governance.service",
  "remote-publication-review-context",
  "orchestrator-review.service",
  "orchestrator-dispatch.service",
  "phase-executor.service",
  "merge-coordinator.service",
  "orchestrator.service",
  "recovery.service",
  "worktree-lease.service",
  "branch-manager",
  "orphan-recovery.service",
  "watchdog.service",
  "orchestrator-recovery.service",
  "notification.service",
  "task.service",
  "task-store.service",
  "feedback-cancel.service",
  "project.service",
  "project/project-archive-delete-flow",
  "project/project-runtime-contract",
  "deferred-auto-deploy.service",
  "deploy-trigger.service",
  "governance-deployment.service",
  "deployment-service",
  "../routes/deliver",
  "../app",
  "../db/governance-schema",
  "../db/schema",
  "experiment-scoring.service",
  "experiment-replay.service",
  "self-improvement-experiment.service",
  "self-improvement-runner.service",
  "self-improvement.service",
  "behavior-version-store.core",
  "behavior-version-store.service",
  "congress.service",
  "congress-job",
  "agent.service",
  "agent-client",
  "agent-tools",
  "agent-global-concurrency.service",
  "../middleware/governance-auth",
  "../middleware/governance-settings",
  "../utils/agent-process-env",
  "../utils/command-runner",
  "../utils/shell-exec",
  "../utils/expo-install",
  "../utils/expo-auth-check",
  "../utils/eas-project-link",
  "../utils/scaffold-expo-deps",
  "../routes/deliver",
  "../routes/governance",
  "../routes/governance-replay",
  "../routes/global-settings",
  "../routes/agents",
  "../routes/projects",
  "../routes/notifications",
  "../routes/tasks",
] as const;

/** Gate configuration and executable checker sources, independent of the instructions they enforce. */
function isCheckerSource(file: string): boolean {
  const normalized = file.replaceAll("\\", "/").toLowerCase();
  const name = path.posix.basename(normalized);
  if (/^(vitest|eslint|vite|jest|webpack|rollup|playwright|cypress)(\..+)?\.[cm]?[jt]s$/.test(name))
    return true;
  if (
    /^tsconfig(?:[.-].+)?\.json$/.test(name) ||
    [
      "tsconfig.json",
      ".eslintrc",
      ".eslintrc.json",
      ".eslintrc.js",
      ".eslintrc.cjs",
      "biome.json",
      "biome.jsonc",
    ].includes(name)
  )
    return true;
  if (/(^|\/)(\.github\/workflows|\.husky)\//.test(normalized)) return true;
  return (
    /(^|\/)(scripts?|checks?)\//.test(normalized) &&
    /(?:\.(?:[cm]?[jt]s|tsx|sh|bash|zsh|py|rb|pl|ps1|bat)|\/[^/.]+)$/.test(normalized)
  );
}

function manifestGateContent(text: string): { scripts: unknown; workspaces: unknown } {
  if (!text) return { scripts: {}, workspaces: null };
  const manifest = JSON.parse(text) as Record<string, unknown>;
  const workspaces =
    Array.isArray(manifest.workspaces) && !manifest.workspaces.length
      ? null
      : (manifest.workspaces ?? null);
  return { scripts: manifest.scripts ?? {}, workspaces };
}

async function optionalText(file: string | URL): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** Raw source snapshots deliberately avoid getCombinedInstructions, which can return approved release content. */
export async function readGovernanceSourceHashes(
  projectId: string,
  repoPath: string,
  client?: DbClient
): Promise<Record<string, string>> {
  const db = client ?? (await (await import("./task-store.service.js")).taskStore.getDb());
  const hashes: Record<string, string> = {
    "AGENTS.md": governanceHash(await optionalText(path.join(repoPath, "AGENTS.md"))),
    ".opensprint/merge-toolchain.json": governanceHash(
      await optionalText(path.join(repoPath, ".opensprint/merge-toolchain.json"))
    ),
  };
  const rows = await db.query(
    "SELECT role,content FROM agent_instructions WHERE project_id=$1 ORDER BY role",
    [projectId]
  );
  const rawRoles = new Map(rows.map((row) => [String(row.role), String(row.content ?? "")]));
  for (const role of AGENT_ROLE_CANONICAL_ORDER) {
    hashes[`role-source:${role}`] = governanceHash(rawRoles.get(role) ?? "");
    hashes[`runtime:defaults:${role}`] = governanceHash(getOpenSprintDefaultInstructions(role));
  }
  const extension = new URL(import.meta.url).pathname.endsWith(".ts") ? "ts" : "js";
  for (const file of RUNTIME_POLICY_SOURCES) {
    hashes[`runtime:source:${file}`] = governanceHash(
      await optionalText(new URL(`./${file}.${extension}`, import.meta.url))
    );
  }
  // File-based role instructions/skills are proposals/evidence, but edits must still be visible as drift.
  for (const directory of [".opensprint/agents", ".agents", ".codex"]) {
    const visit = async (relative: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(path.join(repoPath, relative), { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const child = path.posix.join(relative, entry.name);
        if (entry.isSymbolicLink())
          governanceError(
            `Policy source ${child} is a symlink; reconcile its content into an approved source snapshot.`
          );
        if (entry.isDirectory()) await visit(child);
        else if (entry.isFile())
          hashes[child] = governanceHash(await fs.readFile(path.join(repoPath, child), "utf8"));
      }
    };
    await visit(directory);
  }
  const ignoredDirectories = new Set([
    ".git",
    "node_modules",
    "dist",
    "coverage",
    ".opensprint",
    ".agents",
    ".codex",
  ]);
  const visitNestedInstructions = async (relative: string): Promise<void> => {
    const entries = await fs.readdir(path.join(repoPath, relative), { withFileTypes: true });
    for (const entry of entries) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory() && !ignoredDirectories.has(entry.name.toLowerCase()))
        await visitNestedInstructions(child);
      else if (entry.isFile()) {
        if (entry.name.toLowerCase() === "package.json") {
          const projection = manifestGateContent(
            await fs.readFile(path.join(repoPath, child), "utf8")
          );
          if (governanceHash(projection) !== governanceHash(manifestGateContent("")))
            hashes[`${child}#gate-scripts`] = governanceHash(projection);
        } else if (
          ["agents.md", "skill.md"].includes(entry.name.toLowerCase()) ||
          isCheckerSource(child)
        )
          hashes[child] = governanceHash(await fs.readFile(path.join(repoPath, child), "utf8"));
      }
    }
  };
  await visitNestedInstructions("");
  return hashes;
}

/** Exact known policy surfaces require a human scoped implementation authorization, independently of review votes. */
export function governanceSensitiveSourcePaths(changedPaths: string[]): string[] {
  return changedPaths
    .filter((file) => {
      // Git preserves spelling but supported macOS filesystems can resolve these names case-insensitively.
      const normalized = file.replaceAll("\\", "/").toLowerCase();
      if (
        RUNTIME_POLICY_SOURCES.some((source) =>
          new RegExp(
            `^${path.posix.basename(source).replaceAll(".", "\\.")}\\.[cm]?[jt]s$`,
            "i"
          ).test(path.posix.basename(normalized))
        )
      )
        return true;
      if (path.posix.basename(normalized) === "package.json" || isCheckerSource(normalized))
        return true;
      if (/(^|\/)(agents|skill)\.md$/.test(normalized)) return true;
      if (
        /^(\.agents\/|\.codex\/|\.opensprint\/agents\/|\.opensprint\/merge-toolchain\.json$)/.test(
          normalized
        )
      )
        return true;
      if (normalized.includes("/__tests__/")) return false;
      return /(^|\/)(agent-default-instructions|agent-result-validation|agent-process-env|context-assembler|policy-context|protected-path-policy|governance[^/]*|review-synthesizer\.service|task-phase-coordinator|git-commit-queue\.service|merge-quality-gates|toolchain-profile\.service)\.[cm]?[jt]s$/.test(
        normalized
      );
    })
    .sort();
}

/** Manifest dependency edits are ordinary code work; only verified script/workspace changes govern hard checks. */
export async function resolveGovernanceSensitiveSourcePaths(input: {
  repoPath: string;
  baseSha: string;
  scopeBaseSha?: string;
  headSha: string;
  changedPaths: string[];
}): Promise<string[]> {
  const candidates = governanceSensitiveSourcePaths(input.changedPaths);
  const baseSha = input.scopeBaseSha ?? input.baseSha;
  if (!/^[a-f0-9]{40,64}$/i.test(baseSha) || !/^[a-f0-9]{40,64}$/i.test(input.headSha))
    governanceError(
      "Immutable source revisions are required to classify policy-sensitive code changes."
    );
  const result: string[] = [];
  for (const file of candidates) {
    if (path.posix.basename(file.replaceAll("\\", "/")).toLowerCase() !== "package.json") {
      result.push(file);
      continue;
    }
    const readAt = async (sha: string): Promise<string> => {
      try {
        return (
          await git("git", ["show", `${sha}:${file}`], {
            env: agentProcessEnvironment(),
            cwd: input.repoPath,
            timeout: 10_000,
            maxBuffer: 8 * 1024 * 1024,
          })
        ).stdout;
      } catch {
        const entries = (
          await git("git", ["ls-tree", "--name-only", "-z", sha, "--", file], {
            env: agentProcessEnvironment(),
            cwd: input.repoPath,
            timeout: 10_000,
          })
        ).stdout;
        if (!entries) return "";
        throw new Error(`Cannot retrieve complete checker manifest ${file}`);
      }
    };
    try {
      const before = manifestGateContent(await readAt(baseSha));
      const after = manifestGateContent(await readAt(input.headSha));
      if (governanceHash(before) !== governanceHash(after)) result.push(file);
    } catch {
      result.push(file);
    } // Missing/unparseable authority cannot make a checker change ordinary.
  }
  return result.sort();
}

/** Classify the actual uncommitted merge candidate without confusing dependency metadata with checkers. */
export async function resolveGovernanceCandidateSensitiveSourcePaths(input: {
  repoPath: string;
  baseSha: string;
  changedPaths: string[];
}): Promise<string[]> {
  if (!/^[a-f0-9]{40,64}$/i.test(input.baseSha))
    governanceError("An immutable candidate base is required for source authority checks.");
  const result: string[] = [];
  for (const file of governanceSensitiveSourcePaths(input.changedPaths)) {
    if (path.posix.basename(file.replaceAll("\\", "/")).toLowerCase() !== "package.json") {
      result.push(file);
      continue;
    }
    try {
      let before = "";
      try {
        before = (
          await git("git", ["show", `${input.baseSha}:${file}`], {
            env: agentProcessEnvironment(),
            cwd: input.repoPath,
            timeout: 10_000,
            maxBuffer: 8 * 1024 * 1024,
          })
        ).stdout;
      } catch {
        if (
          (
            await git("git", ["ls-tree", "--name-only", "-z", input.baseSha, "--", file], {
              env: agentProcessEnvironment(),
              cwd: input.repoPath,
              timeout: 10_000,
            })
          ).stdout
        )
          throw new Error("Candidate baseline manifest cannot be retrieved");
      }
      const absolute = path.join(input.repoPath, file);
      const kind = await fs.lstat(absolute).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (kind && !kind.isFile())
        throw new Error("Candidate checker manifests must be regular files");
      const after = kind ? await fs.readFile(absolute, "utf8") : "";
      if (
        governanceHash(manifestGateContent(before)) !== governanceHash(manifestGateContent(after))
      )
        result.push(file);
    } catch {
      result.push(file);
    }
  }
  return result.sort();
}

/** New source additions/removals count as drift; compare only actual source keys, not legacy rendered-role receipts. */
export function governanceSourceDrift(
  approved: Record<string, string>,
  current: Record<string, string>
): string[] {
  const keys = new Set([...Object.keys(approved), ...Object.keys(current)]);
  return [...keys]
    .filter((key) => !key.startsWith("role:") && approved[key] !== current[key])
    .sort();
}

export async function assertGovernanceSensitiveSourceApproval(input: {
  projectId: string;
  taskId: string;
  releaseId: string;
  headSha: string;
  diffHash: string;
  changedPaths: string[];
  repoPath?: string;
  baseSha?: string;
  scopeBaseSha?: string;
}): Promise<void> {
  const sensitive =
    input.repoPath && input.baseSha
      ? await resolveGovernanceSensitiveSourcePaths({
          ...input,
          repoPath: input.repoPath,
          baseSha: input.baseSha,
        })
      : governanceSensitiveSourcePaths(input.changedPaths);
  if (!sensitive.length) return;
  const { governanceService } = await import("./governance.service.js");
  const events = await governanceService.listEvents(input.projectId, [
    "policy_source_change_approved",
  ]);
  const approval = events.find(
    (event) =>
      event.kind === "policy_source_change_approved" &&
      event.actor !== "system" &&
      event.payload.taskId === input.taskId &&
      event.payload.releaseId === input.releaseId &&
      event.payload.headSha === input.headSha &&
      event.payload.diffHash === input.diffHash &&
      governanceHash(event.payload.changedPaths) === governanceHash(sensitive)
  );
  if (!approval)
    governanceError(
      "Policy-sensitive source changes require an explicit authorized human implementation approval bound to every changed policy path and the exact code. Hard checks remain required.",
      "GOVERNANCE_SOURCE_APPROVAL_REQUIRED"
    );
}
