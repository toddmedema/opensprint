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
  "spec-publication.service",
  "collaboration.service",
  "collaboration-access.service",
  "agent-chat.service",
  "agentic-loop",
  "agent-lifecycle",
  "agent/agent-runner",
  "settings-store.service",
  "project/project-settings-update-flow",
  "project-mutation-lock",
  "../routes/spec-publication",
  "../routes/collaboration",
  "../db/publication-schema",
  "../db/collaboration-schema",
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

/** Open Sprint's own runtime paths: a managed repo's unrelated app.ts or schema.ts must not match. */
const RUNTIME_POLICY_SOURCE_PATHS = new Set(
  RUNTIME_POLICY_SOURCES.map((source) =>
    path.posix.normalize(`packages/backend/src/services/${source}`).toLowerCase()
  )
);

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

const COMMAND_RUNNERS = /^(?:npm|pnpm|yarn|bun)$/;
const repoRelative = (token: string): string | null => {
  const file = path.posix.normalize(token.replace(/^['"]|['"]$/g, "").replaceAll("\\", "/"));
  return file.startsWith("/") || file.startsWith("..") || file === "." ? null : file;
};
/**
 * The files a configured gate really runs, whatever they are called: `node tools/verify.mjs`
 * escapes the name-based checker list. Root package scripts are followed by name. O(tokens).
 */
export async function governanceGateCheckerPaths(
  repoPath: string,
  projectId?: string
): Promise<string[]> {
  const commands: string[] = [];
  const addProfile = (record: unknown) => {
    const { toolchainProfile, testCommand } = (record ?? {}) as {
      toolchainProfile?: { mergeQualityGateCommands?: unknown };
      testCommand?: unknown;
    };
    const configured = toolchainProfile?.mergeQualityGateCommands;
    if (Array.isArray(configured)) commands.push(...configured.map(String));
    if (typeof testCommand === "string") commands.push(testCommand);
  };
  const override = await optionalText(path.join(repoPath, ".opensprint/merge-toolchain.json"));
  try {
    addProfile(override ? JSON.parse(override) : null);
  } catch {
    /* Malformed overrides are hashed as text, so editing one is already drift. */
  }
  if (projectId) {
    const { getRawSettingsRecord } = await import("./settings-store.service.js");
    addProfile(await getRawSettingsRecord(projectId).catch(() => null));
  }
  let scripts: Record<string, unknown> = {};
  try {
    scripts = manifestGateContent(await optionalText(path.join(repoPath, "package.json")))
      .scripts as Record<string, unknown>;
  } catch {
    /* An unparseable manifest is classified as a checker change by its own path. */
  }
  const files = new Set<string>();
  const seen = new Set<string>();
  const visit = async (command: string): Promise<void> => {
    if (seen.has(command)) return;
    seen.add(command);
    const tokens = command.split(/\s+|&&|\|\||;|\|/).filter(Boolean);
    for (const [index, token] of tokens.entries()) {
      if (COMMAND_RUNNERS.test(token)) {
        const name = tokens[index + 1] === "run" ? tokens[index + 2] : tokens[index + 1];
        const script = name ? scripts[name] : undefined;
        if (typeof script === "string") await visit(script);
      }
      const file = repoRelative(token);
      if (!file) continue;
      const kind = await fs.lstat(path.join(repoPath, file)).catch(() => null);
      if (kind?.isFile() || kind?.isSymbolicLink()) files.add(file);
    }
  };
  for (const command of commands) await visit(command);
  return [...files].sort();
}

/** The Open Sprint repository governs its own runtime; a managed repo's governance.ts is its own code. */
async function isOpenSprintRepository(repoPath: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(repoPath, "package.json"), "utf8")) as {
      name?: unknown;
    };
    if (manifest.name !== "opensprint") return false;
    await fs.access(path.join(repoPath, "packages/backend/src/services/governance-store.ts"));
    return true;
  } catch {
    return false;
  }
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
      if (ignoredDirectories.has(entry.name.toLowerCase())) continue;
      if (entry.isSymbolicLink()) {
        // A skipped link would let a checker's real content change without any hash moving. An
        // unrelated file link is inert; a linked directory could hide anything.
        const lowerName = entry.name.toLowerCase();
        const target = await fs.stat(path.join(repoPath, child)).catch(() => null);
        if (
          target?.isDirectory() ||
          ["agents.md", "skill.md", "package.json"].includes(lowerName) ||
          isCheckerSource(child)
        )
          governanceError(
            `Policy source ${child} is a symlink; reconcile its content into an approved source snapshot.`
          );
      } else if (entry.isDirectory()) await visitNestedInstructions(child);
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
  for (const file of await governanceGateCheckerPaths(repoPath, projectId)) {
    if ((await fs.lstat(path.join(repoPath, file))).isSymbolicLink())
      governanceError(
        `Gate checker ${file} is a symlink; reconcile its content into an approved source snapshot.`
      );
    hashes[file] = governanceHash(await fs.readFile(path.join(repoPath, file), "utf8"));
  }
  return hashes;
}

/** Exact known policy surfaces require a human scoped implementation authorization, independently of review votes. */
export function governanceSensitiveSourcePaths(
  changedPaths: string[],
  options: { openSprintRepository?: boolean; gateCheckers?: string[] } = {}
): string[] {
  const gateCheckers = new Set(options.gateCheckers ?? []);
  return changedPaths
    .filter((file) => {
      // Git preserves spelling but supported macOS filesystems can resolve these names case-insensitively.
      const normalized = file.replaceAll("\\", "/").toLowerCase();
      if (gateCheckers.has(file)) return true;
      if (RUNTIME_POLICY_SOURCE_PATHS.has(normalized.replace(/\.[cm]?[jt]s$/, ""))) return true;
      if (path.posix.basename(normalized) === "package.json" || isCheckerSource(normalized))
        return true;
      if (/(^|\/)(agents|skill)\.md$/.test(normalized)) return true;
      if (
        /^(\.agents\/|\.codex\/|\.opensprint\/agents\/|\.opensprint\/merge-toolchain\.json$)/.test(
          normalized
        )
      )
        return true;
      if (normalized.includes("/__tests__/") || !options.openSprintRepository) return false;
      return /(^|\/)(agent-default-instructions|agent-result-validation|agent-process-env|context-assembler|policy-context|protected-path-policy|governance[^/]*|review-synthesizer\.service|task-phase-coordinator|git-commit-queue\.service|merge-quality-gates|toolchain-profile\.service)\.[cm]?[jt]s$/.test(
        normalized
      );
    })
    .sort();
}

async function classifySourcePaths(
  repoPath: string,
  changedPaths: string[],
  projectId?: string
): Promise<string[]> {
  return governanceSensitiveSourcePaths(changedPaths, {
    openSprintRepository: await isOpenSprintRepository(repoPath),
    gateCheckers: await governanceGateCheckerPaths(repoPath, projectId),
  });
}

/** Manifest dependency edits are ordinary code work; only verified script/workspace changes govern hard checks. */
export async function resolveGovernanceSensitiveSourcePaths(input: {
  repoPath: string;
  baseSha: string;
  scopeBaseSha?: string;
  headSha: string;
  changedPaths: string[];
  projectId?: string;
}): Promise<string[]> {
  const candidates = await classifySourcePaths(input.repoPath, input.changedPaths, input.projectId);
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
  projectId?: string;
}): Promise<string[]> {
  if (!/^[a-f0-9]{40,64}$/i.test(input.baseSha))
    governanceError("An immutable candidate base is required for source authority checks.");
  const result: string[] = [];
  for (const file of await classifySourcePaths(
    input.repoPath,
    input.changedPaths,
    input.projectId
  )) {
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

function allSourceDrift(
  approved: Record<string, string>,
  current: Record<string, string>
): string[] {
  const keys = new Set([...Object.keys(approved), ...Object.keys(current)]);
  return [...keys]
    .filter((key) => !key.startsWith("role:") && approved[key] !== current[key])
    .sort();
}

/**
 * New source additions/removals count as drift; compare only actual source keys, not legacy
 * rendered-role receipts. The server's own runtime is not repository policy: every Open Sprint
 * upgrade would otherwise stop all governed work, so it is reported by
 * {@link governanceRuntimeDrift} and audited instead.
 */
export function governanceSourceDrift(
  approved: Record<string, string>,
  current: Record<string, string>
): string[] {
  return allSourceDrift(approved, current).filter((key) => !key.startsWith("runtime:"));
}

export function governanceRuntimeDrift(
  approved: Record<string, string>,
  current: Record<string, string>
): string[] {
  return allSourceDrift(approved, current).filter((key) => key.startsWith("runtime:"));
}

/** Current hashes for exactly these repository paths, for refreshing an approved snapshot. */
export function governanceSourceHashesForPaths(
  current: Record<string, string>,
  paths: string[]
): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const file of paths)
    for (const key of [file, `${file}#gate-scripts`])
      if (current[key] !== undefined) hashes[key] = current[key];
  return hashes;
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
