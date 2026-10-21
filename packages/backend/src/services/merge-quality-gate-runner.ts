import { realpathSync } from "fs";
import fs from "fs/promises";
import path from "path";
import { createLogger } from "../utils/logger.js";
import { getErrorMessage } from "../utils/error-utils.js";
import {
  CommandRunError,
  resolveCommandExecutable,
  runCommand as runCommandDefault,
  type CommandRunResult,
  type CommandSpec,
} from "../utils/command-runner.js";
import { getGitNoHooksPath } from "../utils/git-no-hooks.js";
import { unlinkWorktreeLinks } from "../utils/worktree-links.js";
import { assertWorktreeIntegrity, rebuildWorktreeIfInvalid } from "../utils/worktree-health.js";
import { BranchManager } from "./branch-manager.js";
import {
  type MergeQualityGateExecutionPlanEntry,
  getMergeQualityGateExecutionPlan,
  type MergeQualityGateProfile,
} from "./merge-quality-gates.js";
import type { DependencyStrategy, ToolchainProfile } from "@opensprint/shared";
import {
  isNodeDependencyStrategy,
  resolveToolchainProfile,
  usesHermeticWorktreeNodeModules,
} from "./toolchain-profile.service.js";
import { ValidationWorkspaceService } from "./validation-workspace.service.js";
import { redactSecretsForUserDisplay } from "../utils/secret-redaction.js";
import { getDeploymentMode } from "./deployment-mode.js";

const log = createLogger("merge-quality-gate-runner");
const QUALITY_GATE_FAILURE_OUTPUT_LIMIT = 4000;
const QUALITY_GATE_FAILURE_REASON_LIMIT = 500;
const QUALITY_GATE_AUTO_REPAIR_TIMEOUT_MS = 20 * 60 * 1000;
const QUALITY_GATE_PRECHECK_TIMEOUT_MS = 30_000;
const NPM_INCLUDE_DEV_ENV = {
  NPM_CONFIG_INCLUDE: "dev",
  npm_config_include: "dev",
  NPM_CONFIG_OMIT: "",
  npm_config_omit: "",
} as const;
const QUALITY_GATE_ENV_FINGERPRINTS: RegExp[] = [
  /\bspawn\s+\S+\s+enoent\b/i,
  /\beacces\b/i,
  /\bmissing script:\b/i,
  /\bnode_modules\b/i,
  /\bnode_modules[\\/]+tinypool[\\/]+dist[\\/]+entry[\\/]+process\.js\b/i,
  /\bemitter\.removeListener is not a function\b/i,
  /\bnative addon\b/i,
  /\bcould not locate the bindings file\b/i,
  /\bwas compiled against a different node\.js version\b/i,
  /\bnot a git repository\b/i,
  /\bneeded a single revision\b/i,
  /\bpackage\.json\b/i,
  /\bworktree\b/i,
  /\bcannot resolve project for repo path\b/i,
  /\bvalidation workspace\b/i,
];
const QUALITY_GATE_ENV_AMBIGUOUS_FINGERPRINTS: RegExp[] = [
  /\bmodule_not_found\b/i,
  /\bcannot find module\b/i,
  /\bcannot find package\b/i,
  /** Bare `enoent` is handled in {@link classifyQualityGateFailureCategory} (worktree source vs env). */
];

/** Matched before compiler/linter heuristics so npm `validate-engines` paths are not misclassified. */
const QUALITY_GATE_NODE_ENGINE_FINGERPRINTS: RegExp[] = [
  /validate-engines\.js/i,
  /\bEBADENGINE\b/i,
  /\bUnsupported engine\b/i,
  /\bengine\s+"node"\s+is\s+incompatible\b/i,
  /\bThe engine "node" is incompatible\b/i,
  /\brequired:\s*\{[^}]*node/i,
];

/** Exported for unit tests; used by {@link classifyQualityGateFailureCategory}. */
export function looksLikeNodeEngineQualityGateFailure(text: string): boolean {
  return QUALITY_GATE_NODE_ENGINE_FINGERPRINTS.some((re) => re.test(text));
}

export interface MergeQualityGateRunOptions {
  projectId: string;
  repoPath: string;
  worktreePath: string;
  taskId: string;
  branchName: string;
  baseBranch: string;
  validationWorkspace?: "baseline" | "merged_candidate" | "task_worktree" | "repo_root";
  qualityGateProfile?: MergeQualityGateProfile;
  toolchainProfile?: ToolchainProfile;
}

export interface MergeQualityGateFailure {
  command: string;
  reason: string;
  output: string;
  outputSnippet?: string;
  worktreePath?: string;
  firstErrorLine?: string;
  validationWorkspace?: "baseline" | "merged_candidate" | "task_worktree" | "repo_root";
  category?: "environment_setup" | "quality_gate";
  autoRepairAttempted?: boolean;
  autoRepairSucceeded?: boolean;
  autoRepairCommands?: string[];
  autoRepairOutput?: string;
  executable?: string;
  cwd?: string;
  exitCode?: number | null;
  signal?: string | null;
  classificationConfidence?: "high" | "low";
  classificationReason?: string;
  /** Bounded `git status --porcelain` captured when a gate fails (post-mortem). */
  gitStatusPorcelainSnippet?: string;
  /** Bounded `git diff --name-status HEAD` for post-mortem (first N lines). */
  gitNameStatusSnippet?: string;
  /** Toolchain snapshot at gate time (orchestrator / event telemetry). */
  gateNodeVersion?: string;
  gateNpmVersion?: string;
  gateDependencyStrategy?: string;
  gateHermeticNodeModules?: boolean;
}

const GATE_FAILURE_GIT_TELEMETRY_MAX = 2000;

function pathUnderWorktreeRoot(candidate: string, worktreeRoot: string): boolean {
  const relFromRoots = (absFile: string, absRoot: string) => {
    const rel = path.relative(absRoot, absFile);
    return rel !== "" && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  let realRoot: string;
  try {
    realRoot = realpathSync(worktreeRoot);
  } catch {
    realRoot = path.resolve(worktreeRoot);
  }
  const absCandidate = path.resolve(candidate);
  if (
    relFromRoots(absCandidate, path.resolve(worktreeRoot)) ||
    relFromRoots(absCandidate, realRoot)
  ) {
    return true;
  }
  // Missing path segments: walk up until realpathSync succeeds, then re-append suffixes.
  let cur = absCandidate;
  const tail: string[] = [];
  for (;;) {
    try {
      const realPrefix = realpathSync(cur);
      const combined = tail.length > 0 ? path.join(realPrefix, ...tail) : realPrefix;
      return relFromRoots(combined, realRoot);
    } catch {
      tail.unshift(path.basename(cur));
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return false;
}

function isToolishOrDependencyPath(normalizedPosix: string): boolean {
  const n = normalizedPosix.toLowerCase();
  return (
    n.includes("/node_modules/") ||
    n.endsWith("/node_modules") ||
    n.includes("/.git/") ||
    n.includes("/dist/") ||
    n.includes("/coverage/") ||
    n.includes("/build/") ||
    n.includes("/.vite/") ||
    n.endsWith("/package-lock.json") ||
    n.endsWith("/pnpm-lock.yaml") ||
    n.endsWith("/yarn.lock")
  );
}

/**
 * True when failure text indicates ENOENT while opening a source file under the worktree
 * (typically inconsistent refactor: importer exists, module file missing).
 */
export function looksLikeEnoentOpeningMissingWorktreeSource(
  text: string,
  worktreePath: string
): boolean {
  if (!text.trim() || !worktreePath.trim()) return false;
  if (!/\bENOENT\b|no such file or directory/i.test(text)) return false;

  const absRoot = path.resolve(worktreePath);
  const pathPatterns = [
    /,\s*open\s+['"]([^'"]+)['"]/gi,
    /open\s*\(\s*['"]([^'"]+)['"]/gi,
    /['"]([/][^'"]+\.(?:ts|tsx|mts|cts))['"]/gi,
  ];
  for (const pathLike of pathPatterns) {
    let m: RegExpExecArray | null;
    pathLike.lastIndex = 0;
    while ((m = pathLike.exec(text)) !== null) {
      const raw = (m[1] ?? "").trim();
      if (!raw) continue;
      if (!path.isAbsolute(raw) && !/^[A-Za-z]:[\\/]/.test(raw)) continue;
      if (!/\.(?:ts|tsx|mts|cts)$/i.test(raw)) continue;
      const posix = raw.replace(/\\/g, "/");
      if (isToolishOrDependencyPath(posix)) continue;
      if (pathUnderWorktreeRoot(raw, absRoot)) return true;
    }
  }
  return false;
}

async function stripWorktreeNodeModulePaths(worktreePath: string): Promise<void> {
  const rootNm = path.join(worktreePath, "node_modules");
  await fs.rm(rootNm, { recursive: true, force: true }).catch(() => undefined);
  const packagesDir = path.join(worktreePath, "packages");
  let names: string[];
  try {
    names = await fs.readdir(packagesDir);
  } catch {
    return;
  }
  for (const name of names) {
    const pkgDir = path.join(packagesDir, name);
    const st = await fs.stat(pkgDir).catch(() => null);
    if (!st?.isDirectory()) continue;
    await fs
      .rm(path.join(pkgDir, "node_modules"), { recursive: true, force: true })
      .catch(() => undefined);
  }
}

async function prepareHermeticWorktreeNodeModules(
  worktreePath: string,
  runCommand: NonNullable<MergeQualityGateRunnerDeps["runCommand"]>
): Promise<void> {
  await stripWorktreeNodeModulePaths(worktreePath);
  await runCommand(
    { command: "npm", args: ["ci"] },
    {
      cwd: worktreePath,
      timeout: QUALITY_GATE_AUTO_REPAIR_TIMEOUT_MS,
      env: NPM_INCLUDE_DEV_ENV,
    }
  );
}

interface MergeQualityGateRunnerDeps {
  runCommand?: (
    spec: CommandSpec,
    options: { cwd: string; timeout?: number; env?: NodeJS.ProcessEnv }
  ) => Promise<CommandRunResult>;
  symlinkNodeModules?: (repoPath: string, wtPath: string) => Promise<void>;
  commands?: string[];
}

interface PreparedGateCommand {
  label: string;
  spec: CommandSpec;
  executable: string;
  /** Directory where the gate command must run (may differ from options.worktreePath after resolution). */
  executionCwd: string;
}

type PreparedGateCommandResult =
  | {
      prepared: PreparedGateCommand;
      packageScripts: Set<string>;
    }
  | {
      failure: MergeQualityGateFailure;
    }
  | {
      skipped: true;
      packageScripts: Set<string>;
    };

interface AutoRepairResult {
  succeeded: boolean;
  commands: string[];
  output: string;
  worktreePath: string;
}

function hasWorkspaceConfig(workspaces: unknown): boolean {
  if (Array.isArray(workspaces)) return workspaces.length > 0;
  if (workspaces && typeof workspaces === "object") {
    const packages = (workspaces as { packages?: unknown }).packages;
    return Array.isArray(packages) && packages.length > 0;
  }
  return false;
}

async function resolveDependencyHealthCheckArgs(workspacePath: string): Promise<string[]> {
  const packageJsonPath = path.join(workspacePath, "package.json");
  try {
    const raw = await fs.readFile(packageJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as { workspaces?: unknown } | null;
    return hasWorkspaceConfig(parsed?.workspaces)
      ? ["ls", "--depth=0", "--workspaces", "--include=dev"]
      : ["ls", "--depth=0", "--include=dev"];
  } catch {
    return ["ls", "--depth=0", "--include=dev"];
  }
}

async function isNodeModulesUsable(nodeModulesPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(nodeModulesPath);
    if (!stat.isDirectory()) return false;
    const entries = await fs.readdir(nodeModulesPath, { withFileTypes: true });
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function runDependencyHealthCheck(
  workspacePath: string,
  runCommand: NonNullable<MergeQualityGateRunnerDeps["runCommand"]>,
  toolchainProfile?: ToolchainProfile
): Promise<{ healthy: boolean; command: string; output: string }> {
  const resolvedProfile = resolveToolchainProfile(toolchainProfile);
  if (
    resolvedProfile.dependencyStrategy === "none" ||
    !resolvedProfile.dependencyHealthCheckCommand?.trim()
  ) {
    return { healthy: true, command: "dependency health check disabled", output: "" };
  }
  let command = resolvedProfile.dependencyHealthCheckCommand;
  let spec = parseCommandSpec(command);
  if (
    (resolvedProfile.dependencyStrategy === "npm" ||
      resolvedProfile.dependencyStrategy === "npm_ci_worktree") &&
    command.trim() === "npm ls --depth=0 --include=dev"
  ) {
    const args = await resolveDependencyHealthCheckArgs(workspacePath);
    command = `npm ${args.join(" ")}`;
    spec = { command: "npm", args };
  }
  try {
    const result = await runCommand(spec, {
      cwd: workspacePath,
      timeout: QUALITY_GATE_PRECHECK_TIMEOUT_MS,
      ...(spec.command === "npm" ? { env: NPM_INCLUDE_DEV_ENV } : {}),
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    return { healthy: true, command, output };
  } catch (err) {
    const failure = extractCommandFailure(command, err, {
      worktreePath: workspacePath,
      validationWorkspace: "task_worktree",
      category: "environment_setup",
    });
    const output = [failure.reason, failure.output].filter(Boolean).join("\n").trim();
    return { healthy: false, command, output };
  }
}

function parseCommandSpec(command: string): CommandSpec {
  const parts = command
    .trim()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return {
    command: parts[0] ?? "",
    args: parts.slice(1),
  };
}

function extractNpmRunScriptName(command: string): string | null {
  const match = command.trim().match(/^npm\s+run\s+([^\s]+)/i);
  return match?.[1] ?? null;
}

function getFirstNonEmptyLine(value: string | null | undefined): string | null {
  if (!value) return null;
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? null
  );
}

const QUALITY_GATE_NOISE_PATTERNS: RegExp[] = [
  /^\s*> /,
  /^\s*npm (error|err!)/i,
  /^\s*lifecycle script .* failed/i,
  /^\s*exit code \d+/i,
  // Vitest prints app logs after "stdout | …"; bare lines may embed error text inside JSON context.
  /^\d{4}-\d{2}-\d{2}T\S+\s+(?:INFO|WARN|ERROR|DEBUG)\s+\[/i,
  /^\s*stdout \|/i,
  /^\s*stderr \|/i,
  /^\s*RUN\s+v?\d/i,
  /^\s*Test Files\s+\d+\s+passed/i,
  /^\s*Tests\s+\d+\s+passed/i,
  /^\s*Start at /i,
  /^\s*Duration /i,
  /^\s*[|\\/-]{2,}\s*$/,
  /^\s*[=-]{3,}\s*$/,
  /^\s*✓\s+/,
  /** Vitest marks skipped suites/tests with a leading "↓" in TAP-like output. */
  /^\s*↓\s+/,
  /^\s*at\s+\S+/,
  /^\s*node:/i,
];

const QUALITY_GATE_ACTIONABLE_PATTERNS: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /\berror TS\d+\b/i, score: 130 },
  { pattern: /\b(AssertionError|TypeError|ReferenceError|SyntaxError|RangeError):/i, score: 125 },
  { pattern: /\bCannot find (module|package)\b/i, score: 120 },
  {
    pattern: /\b(not exported by|does not provide an export named|failed to resolve import)\b/i,
    score: 115,
  },
  { pattern: /\b\d+:\d+\s+error\b/i, score: 110 },
  { pattern: /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs|py|go|rs|java)\b.*[:(]\d+([:,)]\d+)?/i, score: 105 },
  { pattern: /^\s*FAIL\b/i, score: 100 },
  { pattern: /\b(Expected|Received):\b/, score: 95 },
  { pattern: /\berror during build\b/i, score: 90 },
  { pattern: /\b(Command failed|failed)\b/i, score: 75 },
  { pattern: /\bError:/i, score: 70 },
  {
    pattern: /\bcompiled against a different Node\.js version\b/i,
    score: 128,
  },
  { pattern: /\bNODE_MODULE_VERSION\b/, score: 127 },
];

function isNoiseLine(line: string): boolean {
  return QUALITY_GATE_NOISE_PATTERNS.some((pattern) => pattern.test(line));
}

function actionableScore(line: string): number {
  let score = 0;
  for (const rule of QUALITY_GATE_ACTIONABLE_PATTERNS) {
    if (rule.pattern.test(line)) {
      score = Math.max(score, rule.score);
    }
  }
  return score;
}

function getMeaningfulErrorIndex(lines: string[]): number {
  let bestIndex = -1;
  let bestScore = 0;

  lines.forEach((line, index) => {
    if (!line || isNoiseLine(line)) return;
    const score = actionableScore(line);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  if (bestIndex >= 0) return bestIndex;
  return lines.findIndex((line) => line.length > 0 && !isNoiseLine(line));
}

function getRelevantOutputSnippet(value: string | null | undefined): string {
  if (!value) return "";
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return "";

  const primaryIndex = getMeaningfulErrorIndex(lines);
  if (primaryIndex < 0) return "";

  const start = Math.max(0, primaryIndex - 1);
  const end = Math.min(lines.length, primaryIndex + 6);
  const snippetLines: string[] = [];

  for (let index = start; index < end; index += 1) {
    const line = lines[index]!;
    if (isNoiseLine(line)) continue;
    snippetLines.push(line);
    if (snippetLines.length >= 6) break;
  }

  if (snippetLines.length === 0) {
    snippetLines.push(lines[primaryIndex]!);
  }

  return snippetLines.join("\n").slice(0, QUALITY_GATE_FAILURE_OUTPUT_LIMIT);
}

function getFirstMeaningfulErrorLine(value: string | null | undefined): string | null {
  if (!value) return null;
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  const meaningfulIndex = getMeaningfulErrorIndex(lines);
  return meaningfulIndex >= 0 ? lines[meaningfulIndex]! : getFirstNonEmptyLine(value);
}

function buildFailure(params: {
  command: string;
  reason: string;
  output?: string;
  outputSnippet?: string;
  worktreePath: string;
  validationWorkspace: MergeQualityGateFailure["validationWorkspace"];
  firstErrorLine?: string | null;
  category: "environment_setup" | "quality_gate";
  executable?: string | null;
  cwd?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  classificationConfidence?: "high" | "low";
  classificationReason?: string;
  autoRepairAttempted?: boolean;
  autoRepairSucceeded?: boolean;
  autoRepairCommands?: string[];
  autoRepairOutput?: string;
}): MergeQualityGateFailure {
  const output = (params.output ?? "").slice(0, QUALITY_GATE_FAILURE_OUTPUT_LIMIT);
  const outputSnippetRaw =
    (params.outputSnippet ?? getRelevantOutputSnippet(output) ?? "").slice(0, 1800) || "";
  const outputSnippet = outputSnippetRaw
    ? redactSecretsForUserDisplay(outputSnippetRaw).slice(0, 1800)
    : undefined;
  const firstErrorLineRaw =
    params.firstErrorLine?.trim() ||
    getFirstMeaningfulErrorLine(outputSnippetRaw) ||
    getFirstMeaningfulErrorLine(output) ||
    getFirstNonEmptyLine(params.reason) ||
    "Unknown quality gate failure";
  const firstErrorLine = redactSecretsForUserDisplay(firstErrorLineRaw);
  return {
    command: params.command,
    reason: redactSecretsForUserDisplay(params.reason).slice(0, QUALITY_GATE_FAILURE_REASON_LIMIT),
    output: redactSecretsForUserDisplay(output),
    outputSnippet,
    worktreePath: params.worktreePath,
    firstErrorLine,
    validationWorkspace: params.validationWorkspace,
    category: params.category,
    autoRepairAttempted: params.autoRepairAttempted ?? false,
    autoRepairSucceeded: params.autoRepairSucceeded ?? false,
    autoRepairCommands: params.autoRepairCommands ?? [],
    autoRepairOutput: redactSecretsForUserDisplay(
      (params.autoRepairOutput ?? "").slice(0, QUALITY_GATE_FAILURE_OUTPUT_LIMIT)
    ),
    executable: params.executable?.trim()
      ? redactSecretsForUserDisplay(params.executable.trim())
      : undefined,
    cwd: params.cwd?.trim() ? redactSecretsForUserDisplay(params.cwd.trim()) : undefined,
    exitCode: params.exitCode ?? undefined,
    signal: params.signal ?? undefined,
    classificationConfidence: params.classificationConfidence ?? "high",
    classificationReason: params.classificationReason
      ? redactSecretsForUserDisplay(params.classificationReason)
      : undefined,
  };
}

/** Object literals that bypass buildFailure still need the same persisted diagnostic scrub. */
function redactMergeQualityGateFailureSurface(
  failure: MergeQualityGateFailure
): MergeQualityGateFailure {
  return {
    ...failure,
    reason: redactSecretsForUserDisplay(failure.reason).slice(0, QUALITY_GATE_FAILURE_REASON_LIMIT),
    output: redactSecretsForUserDisplay(failure.output).slice(0, QUALITY_GATE_FAILURE_OUTPUT_LIMIT),
    outputSnippet:
      failure.outputSnippet != null
        ? redactSecretsForUserDisplay(failure.outputSnippet).slice(0, 1800)
        : undefined,
    firstErrorLine: failure.firstErrorLine
      ? redactSecretsForUserDisplay(failure.firstErrorLine)
      : failure.firstErrorLine,
    autoRepairOutput:
      failure.autoRepairOutput != null && failure.autoRepairOutput !== ""
        ? redactSecretsForUserDisplay(failure.autoRepairOutput).slice(
            0,
            QUALITY_GATE_FAILURE_OUTPUT_LIMIT
          )
        : failure.autoRepairOutput,
    classificationReason: failure.classificationReason
      ? redactSecretsForUserDisplay(failure.classificationReason)
      : failure.classificationReason,
    executable: failure.executable
      ? redactSecretsForUserDisplay(failure.executable)
      : failure.executable,
    cwd: failure.cwd ? redactSecretsForUserDisplay(failure.cwd) : failure.cwd,
    gitStatusPorcelainSnippet:
      failure.gitStatusPorcelainSnippet !== undefined
        ? redactSecretsForUserDisplay(failure.gitStatusPorcelainSnippet).slice(
            0,
            GATE_FAILURE_GIT_TELEMETRY_MAX
          )
        : undefined,
    gitNameStatusSnippet:
      failure.gitNameStatusSnippet !== undefined
        ? redactSecretsForUserDisplay(failure.gitNameStatusSnippet).slice(
            0,
            GATE_FAILURE_GIT_TELEMETRY_MAX
          )
        : undefined,
  };
}

async function enrichMergeGateFailureWithGitTelemetry(
  failure: MergeQualityGateFailure,
  gitCwd: string,
  runCommand: NonNullable<MergeQualityGateRunnerDeps["runCommand"]>
): Promise<MergeQualityGateFailure> {
  if (process.env.NODE_ENV === "test") return failure;
  let statusSnippet = "";
  let nameStatusSnippet = "";
  try {
    const st = await runCommand(
      { command: "git", args: ["status", "--porcelain"] },
      {
        cwd: gitCwd,
        timeout: QUALITY_GATE_PRECHECK_TIMEOUT_MS,
      }
    );
    statusSnippet = [st.stdout, st.stderr].filter(Boolean).join("\n").trim();
  } catch {
    // non-fatal
  }
  try {
    const diff = await runCommand(
      { command: "git", args: ["diff", "--name-status", "HEAD"] },
      { cwd: gitCwd, timeout: QUALITY_GATE_PRECHECK_TIMEOUT_MS }
    );
    nameStatusSnippet = [diff.stdout, diff.stderr].filter(Boolean).join("\n").trim();
  } catch {
    // non-fatal
  }

  const lines = nameStatusSnippet.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const boundedNameStatus = lines.slice(0, 80).join("\n").slice(0, GATE_FAILURE_GIT_TELEMETRY_MAX);

  return {
    ...failure,
    gitStatusPorcelainSnippet: redactSecretsForUserDisplay(statusSnippet).slice(
      0,
      GATE_FAILURE_GIT_TELEMETRY_MAX
    ),
    gitNameStatusSnippet: redactSecretsForUserDisplay(boundedNameStatus),
  };
}

type MergeGateRuntimeTelemetryFields = Pick<
  MergeQualityGateFailure,
  "gateNodeVersion" | "gateNpmVersion" | "gateDependencyStrategy" | "gateHermeticNodeModules"
>;

function mergeRuntimeTelemetryIntoFailure(
  failure: MergeQualityGateFailure,
  runtime: MergeGateRuntimeTelemetryFields | null | undefined
): MergeQualityGateFailure {
  if (!runtime) return failure;
  return {
    ...failure,
    ...(runtime.gateNodeVersion != null && { gateNodeVersion: runtime.gateNodeVersion }),
    ...(runtime.gateNpmVersion != null && { gateNpmVersion: runtime.gateNpmVersion }),
    ...(runtime.gateDependencyStrategy != null && {
      gateDependencyStrategy: runtime.gateDependencyStrategy,
    }),
    ...(runtime.gateHermeticNodeModules != null && {
      gateHermeticNodeModules: runtime.gateHermeticNodeModules,
    }),
  };
}

async function captureMergeGateRuntimeTelemetry(
  cwd: string,
  validationWorkspace: MergeQualityGateFailure["validationWorkspace"],
  dependencyStrategy: DependencyStrategy,
  hermeticNodeModules: boolean,
  runCommand: NonNullable<MergeQualityGateRunnerDeps["runCommand"]>
): Promise<{
  fields: MergeGateRuntimeTelemetryFields;
  preflightFailure: MergeQualityGateFailure | null;
}> {
  const baseFields: MergeGateRuntimeTelemetryFields = {
    gateDependencyStrategy: dependencyStrategy,
    gateHermeticNodeModules: hermeticNodeModules,
  };
  if (!isNodeDependencyStrategy(dependencyStrategy)) {
    return { fields: baseFields, preflightFailure: null };
  }
  try {
    const nodeRun = await runCommand({ command: "node", args: ["-v"] }, { cwd, timeout: 15_000 });
    const npmRun = await runCommand(
      { command: "npm", args: ["-v"] },
      { cwd, timeout: 15_000, env: NPM_INCLUDE_DEV_ENV }
    );
    return {
      fields: {
        ...baseFields,
        gateNodeVersion: (nodeRun.stdout ?? "").trim() || undefined,
        gateNpmVersion: (npmRun.stdout ?? "").trim() || undefined,
      },
      preflightFailure: null,
    };
  } catch (err) {
    const preflightFailure = extractCommandFailure("node/npm toolchain preflight", err, {
      worktreePath: cwd,
      validationWorkspace: validationWorkspace ?? "task_worktree",
      category: "environment_setup",
    });
    return {
      fields: {
        ...baseFields,
        gateNodeVersion: "unavailable",
        gateNpmVersion: "unavailable",
      },
      preflightFailure,
    };
  }
}

async function withMergeGateFailureTelemetry(
  failure: MergeQualityGateFailure | null,
  gitCwd: string,
  runCommand: NonNullable<MergeQualityGateRunnerDeps["runCommand"]>,
  runtimeTelemetry?: MergeGateRuntimeTelemetryFields | null
): Promise<MergeQualityGateFailure | null> {
  if (!failure) return null;
  const withRuntime = mergeRuntimeTelemetryIntoFailure(failure, runtimeTelemetry ?? undefined);
  const enriched = await enrichMergeGateFailureWithGitTelemetry(withRuntime, gitCwd, runCommand);
  return redactMergeQualityGateFailureSurface(enriched);
}

/**
 * Vitest assertion text when `expect(res.status).toBe(200)` receives 401/403 (e.g. missing Bearer on /api/v1).
 */
function mergeQualityGateLocalSessionAuthAssertionHint(
  reason: string,
  output: string,
  firstErrorLine: string
): string | null {
  const text = `${reason}\n${output}\n${firstErrorLine}`;
  if (!/expected\s+40[13]\s+to\s+be\s+200/i.test(text)) return null;
  return (
    "Local-session auth drift: use authedSupertest or withLocalSessionAuth for /api/v1 routes " +
    "(packages/backend/src/__tests__/local-auth-test-helpers.ts)."
  );
}

function classifyQualityGateFailureCategory(failure: {
  reason: string;
  output: string;
  firstErrorLine: string;
  code?: string;
  exitCode?: number | null;
  worktreePath?: string;
}): {
  category: "environment_setup" | "quality_gate";
  confidence: "high" | "low";
  reason: string;
} {
  const text = `${failure.reason}\n${failure.output}\n${failure.firstErrorLine}`;
  const wt = failure.worktreePath?.trim();
  if (wt && looksLikeEnoentOpeningMissingWorktreeSource(text, wt)) {
    return {
      category: "quality_gate",
      confidence: "high",
      reason: "missing_worktree_source_file",
    };
  }
  if (looksLikeNodeEngineQualityGateFailure(text)) {
    return {
      category: "environment_setup",
      confidence: "high",
      reason: "node_npm_engine_mismatch",
    };
  }
  if (
    /\berror TS\d+\b/i.test(text) ||
    /\b\d+:\d+\s+error\b/i.test(text) ||
    /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)\b.*[:(]\d+([:,)]\d+)?/i.test(text)
  ) {
    return {
      category: "quality_gate",
      confidence: "high",
      reason: "compiler/linter diagnostic indicates code-level gate failure",
    };
  }
  if (failure.code === "ENOENT" || failure.code === "EACCES") {
    if (failure.code === "ENOENT" && wt && looksLikeEnoentOpeningMissingWorktreeSource(text, wt)) {
      return {
        category: "quality_gate",
        confidence: "high",
        reason: "missing_worktree_source_file",
      };
    }
    return {
      category: "environment_setup",
      confidence: "high",
      reason: `process error code ${failure.code}`,
    };
  }
  if (failure.exitCode === 127 || failure.exitCode === 126) {
    return {
      category: "environment_setup",
      confidence: "high",
      reason: `shell exit code ${failure.exitCode}`,
    };
  }
  if (QUALITY_GATE_ENV_FINGERPRINTS.some((fingerprint) => fingerprint.test(text))) {
    return {
      category: "environment_setup",
      confidence: "high",
      reason: "matched high-confidence environment fingerprint",
    };
  }
  if (QUALITY_GATE_ENV_AMBIGUOUS_FINGERPRINTS.some((fingerprint) => fingerprint.test(text))) {
    if (wt && looksLikeEnoentOpeningMissingWorktreeSource(text, wt)) {
      return {
        category: "quality_gate",
        confidence: "high",
        reason: "missing_worktree_source_file",
      };
    }
    return {
      category: "environment_setup",
      confidence: "low",
      reason: "matched ambiguous environment fingerprint",
    };
  }
  if (/\benoent\b/i.test(text) && wt && looksLikeEnoentOpeningMissingWorktreeSource(text, wt)) {
    return {
      category: "quality_gate",
      confidence: "high",
      reason: "missing_worktree_source_file",
    };
  }
  return {
    category: "quality_gate",
    confidence: "high",
    reason: "no environment fingerprint detected",
  };
}

function extractCommandFailure(
  command: string,
  err: unknown,
  params: {
    worktreePath: string;
    validationWorkspace: MergeQualityGateFailure["validationWorkspace"];
    category?: "environment_setup" | "quality_gate";
  }
): MergeQualityGateFailure {
  const commandErr = err as Partial<CommandRunError>;
  const stdout = typeof commandErr.stdout === "string" ? commandErr.stdout : "";
  const stderr = typeof commandErr.stderr === "string" ? commandErr.stderr : "";
  const rawOutput = [stdout, stderr]
    .filter((part) => part.trim().length > 0)
    .join("\n")
    .trim();
  const output = rawOutput.slice(0, QUALITY_GATE_FAILURE_OUTPUT_LIMIT);
  const outputSnippet = getRelevantOutputSnippet(rawOutput) || output;
  const reason = (
    commandErr.message ?? (err instanceof Error ? err.message : `Command failed: ${command}`)
  ).slice(0, QUALITY_GATE_FAILURE_REASON_LIMIT);
  const firstErrorLine =
    getFirstMeaningfulErrorLine(rawOutput) ??
    getFirstNonEmptyLine(outputSnippet) ??
    getFirstNonEmptyLine(rawOutput) ??
    getFirstNonEmptyLine(reason) ??
    "Unknown quality gate failure";
  const classification = classifyQualityGateFailureCategory({
    reason,
    output,
    firstErrorLine,
    code: typeof commandErr.code === "string" ? commandErr.code : undefined,
    exitCode: typeof commandErr.exitCode === "number" ? commandErr.exitCode : null,
    worktreePath: params.worktreePath,
  });
  const category = params.category ?? classification.category;
  const authHint = mergeQualityGateLocalSessionAuthAssertionHint(reason, output, firstErrorLine);
  const baseClassificationReason =
    params.category != null
      ? `category forced by ${params.category} precheck`
      : classification.reason;
  const classificationReason = authHint
    ? `${baseClassificationReason} | ${authHint}`
    : baseClassificationReason;

  return buildFailure({
    command,
    reason,
    output,
    outputSnippet,
    worktreePath: params.worktreePath,
    validationWorkspace: params.validationWorkspace,
    firstErrorLine,
    category,
    executable: typeof commandErr.executable === "string" ? commandErr.executable : undefined,
    cwd: typeof commandErr.cwd === "string" ? commandErr.cwd : params.worktreePath,
    exitCode: typeof commandErr.exitCode === "number" ? commandErr.exitCode : null,
    signal:
      typeof commandErr.signal === "string" || commandErr.signal == null
        ? (commandErr.signal ?? null)
        : String(commandErr.signal),
    classificationConfidence: params.category != null ? "high" : classification.confidence,
    classificationReason,
  });
}

async function ensurePathExists(
  targetPath: string,
  reason: string,
  params: {
    command: string;
    validationWorkspace: MergeQualityGateFailure["validationWorkspace"];
    worktreePath: string;
  }
): Promise<MergeQualityGateFailure | null> {
  try {
    await fs.access(targetPath);
    return null;
  } catch {
    return buildFailure({
      command: params.command,
      reason,
      worktreePath: params.worktreePath,
      validationWorkspace: params.validationWorkspace,
      category: "environment_setup",
      cwd: params.worktreePath,
    });
  }
}

/** Resolve symlinked / aliased paths (e.g. macOS /var → /private/var) for stable gate cwd. */
async function resolveMergeGateFilesystemRoot(p: string): Promise<string> {
  const resolved = path.resolve(p);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

async function prepareGateCommand(
  options: MergeQualityGateRunOptions,
  command: string,
  validationWorkspace: MergeQualityGateFailure["validationWorkspace"],
  runCommand: NonNullable<MergeQualityGateRunnerDeps["runCommand"]>
): Promise<PreparedGateCommandResult> {
  let cwd = await resolveMergeGateFilesystemRoot(options.worktreePath);
  const resolvedProfile = resolveToolchainProfile(options.toolchainProfile);
  const workspaceFailure = await ensurePathExists(cwd, `Validation workspace is missing: ${cwd}`, {
    command,
    validationWorkspace,
    worktreePath: cwd,
  });
  if (workspaceFailure) return { failure: workspaceFailure };

  const spec = parseCommandSpec(command);
  const npmGate = spec.command === "npm";
  const shouldRunNodePrechecks =
    npmGate && isNodeDependencyStrategy(resolvedProfile.dependencyStrategy);
  let packageScripts = new Set<string>();
  if (shouldRunNodePrechecks) {
    let packageJsonPath = path.join(cwd, "package.json");
    try {
      await fs.access(packageJsonPath);
    } catch {
      const missingAtInput = packageJsonPath;
      try {
        const topLevelResult = await runCommand(
          {
            command: "git",
            args: ["rev-parse", "--show-toplevel"],
          },
          {
            cwd,
            timeout: QUALITY_GATE_PRECHECK_TIMEOUT_MS,
          }
        );
        const topLevel = topLevelResult.stdout.trim();
        if (!topLevel) throw new Error("git show-toplevel empty");
        const topAbs = await resolveMergeGateFilesystemRoot(topLevel);
        const candidate = path.join(topAbs, "package.json");
        await fs.access(candidate);
        cwd = topAbs;
        packageJsonPath = candidate;
      } catch {
        return {
          failure: buildFailure({
            command,
            reason: `Validation workspace package.json is missing: ${missingAtInput}`,
            worktreePath: cwd,
            validationWorkspace,
            category: "environment_setup",
            cwd,
          }),
        };
      }
    }

    try {
      const raw = await fs.readFile(packageJsonPath, "utf-8");
      const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> } | null;
      if (parsed?.scripts && typeof parsed.scripts === "object") {
        packageScripts = new Set(Object.keys(parsed.scripts));
      }
    } catch (err) {
      return {
        failure: buildFailure({
          command,
          reason: `Failed to read validation workspace package.json: ${getErrorMessage(err)}`,
          worktreePath: cwd,
          validationWorkspace,
          category: "environment_setup",
          cwd,
        }),
      };
    }
  }

  const scriptName = extractNpmRunScriptName(command);
  if (scriptName && !packageScripts.has(scriptName)) {
    return {
      skipped: true,
      packageScripts,
    };
  }

  if (shouldRunNodePrechecks) {
    const lockfilePath = path.join(cwd, "package-lock.json");
    const lockfileFailure = await ensurePathExists(
      lockfilePath,
      `Validation workspace package-lock.json is missing: ${lockfilePath}`,
      {
        command,
        validationWorkspace,
        worktreePath: cwd,
      }
    );
    if (lockfileFailure) return { failure: lockfileFailure };
  }

  if (shouldRunNodePrechecks) {
    const nodeModulesPath = path.join(cwd, "node_modules");
    if (!(await isNodeModulesUsable(nodeModulesPath))) {
      return {
        failure: buildFailure({
          command,
          reason: `Validation workspace node_modules is missing or empty at ${nodeModulesPath}`,
          worktreePath: cwd,
          validationWorkspace,
          category: "environment_setup",
          cwd,
        }),
      };
    }
  }

  if (validationWorkspace === "merged_candidate" && shouldRunNodePrechecks) {
    const dependencyHealth = await runDependencyHealthCheck(
      cwd,
      runCommand,
      options.toolchainProfile
    );
    if (!dependencyHealth.healthy) {
      return {
        failure: buildFailure({
          command,
          reason: `Validation workspace dependency health check failed (${dependencyHealth.command})`,
          output: dependencyHealth.output,
          worktreePath: cwd,
          validationWorkspace,
          category: "environment_setup",
          cwd,
        }),
      };
    }
  }

  const gitExecutable = resolveCommandExecutable("git");
  if (!gitExecutable) {
    return {
      failure: buildFailure({
        command,
        reason: "git is not available in PATH for merge validation",
        worktreePath: cwd,
        validationWorkspace,
        category: "environment_setup",
        executable: "git",
        cwd,
      }),
    };
  }

  try {
    await runCommand(
      {
        command: "git",
        args: ["rev-parse", "--verify", "HEAD"],
      },
      {
        cwd,
        timeout: QUALITY_GATE_PRECHECK_TIMEOUT_MS,
      }
    );
  } catch (err) {
    return {
      failure: extractCommandFailure("git rev-parse --verify HEAD", err, {
        worktreePath: cwd,
        validationWorkspace,
        category: "environment_setup",
      }),
    };
  }

  const executable = resolveCommandExecutable(spec.command);
  if (!executable) {
    return {
      failure: buildFailure({
        command,
        reason: `Executable is not available in PATH: ${spec.command}`,
        worktreePath: cwd,
        validationWorkspace,
        category: "environment_setup",
        executable: spec.command,
        cwd,
      }),
    };
  }

  return {
    prepared: {
      label: command,
      spec,
      executable,
      executionCwd: cwd,
    },
    packageScripts,
  };
}

async function repairQualityGateEnvironment(
  options: MergeQualityGateRunOptions,
  validationWorkspace: MergeQualityGateFailure["validationWorkspace"],
  gateCommand: string,
  deps: Required<Pick<MergeQualityGateRunnerDeps, "runCommand" | "symlinkNodeModules">>
): Promise<AutoRepairResult> {
  const outputParts: string[] = [];
  const commands: string[] = [];
  const worktreePath = options.worktreePath;
  const npmGate = parseCommandSpec(gateCommand).command === "npm";
  const hermetic = usesHermeticWorktreeNodeModules(
    resolveToolchainProfile(options.toolchainProfile).dependencyStrategy
  );
  let recreateSucceeded = true;

  if (validationWorkspace === "baseline") {
    const noHooks = getGitNoHooksPath();
    await unlinkWorktreeLinks(worktreePath);
    commands.push("git worktree remove", "git worktree add --detach");
    await deps
      .runCommand(
        {
          command: "git",
          args: ["worktree", "remove", worktreePath, "--force"],
        },
        {
          cwd: options.repoPath,
          timeout: QUALITY_GATE_PRECHECK_TIMEOUT_MS,
        }
      )
      .catch((err) => {
        outputParts.push(
          `[git worktree remove] ${
            extractCommandFailure("git worktree remove", err, {
              worktreePath,
              validationWorkspace,
              category: "environment_setup",
            }).reason
          }`
        );
      });

    try {
      await fs.rm(worktreePath, { recursive: true, force: true });
      await fs.mkdir(path.dirname(worktreePath), { recursive: true });
      await deps.runCommand(
        {
          command: "git",
          args: [
            "-c",
            `core.hooksPath=${noHooks}`,
            "worktree",
            "add",
            "--detach",
            worktreePath,
            options.baseBranch,
          ],
        },
        {
          cwd: options.repoPath,
          timeout: QUALITY_GATE_PRECHECK_TIMEOUT_MS,
        }
      );
    } catch (err) {
      recreateSucceeded = false;
      outputParts.push(
        `[git worktree add] ${
          extractCommandFailure("git worktree add --detach", err, {
            worktreePath,
            validationWorkspace,
            category: "environment_setup",
          }).reason
        }`
      );
    }
  } else if (npmGate) {
    // Non-baseline worktrees: restore missing tracked files (e.g. package.json)
    // from the git index. Unlike baseline repair which recreates the entire worktree,
    // this targeted checkout fixes corrupted/cleaned worktrees without losing changes.
    const packageJsonPath = path.join(worktreePath, "package.json");
    let packageJsonMissing = false;
    try {
      await fs.access(packageJsonPath);
    } catch {
      packageJsonMissing = true;
    }
    if (packageJsonMissing) {
      commands.push("git checkout HEAD -- package.json");
      try {
        await deps.runCommand(
          {
            command: "git",
            args: ["checkout", "HEAD", "--", "package.json"],
          },
          {
            cwd: worktreePath,
            timeout: QUALITY_GATE_PRECHECK_TIMEOUT_MS,
          }
        );
      } catch (err) {
        recreateSucceeded = false;
        outputParts.push(`[git checkout package.json] ${getErrorMessage(err)}`);
      }
    }
  }

  let npmCiSucceeded = !npmGate;
  let symlinkSucceeded = true;
  let worktreeDependencyHealthy = !npmGate;

  if (!npmGate) {
    commands.push("skip npm-specific auto-repair (non-npm gate)");
  } else if (validationWorkspace === "merged_candidate") {
    if (hermetic) {
      commands.push("stripWorktreeNodeModulePaths", "npm ci (hermetic merged_candidate)");
      await stripWorktreeNodeModulePaths(worktreePath);
      try {
        const result = await deps.runCommand(
          { command: "npm", args: ["ci"] },
          {
            cwd: worktreePath,
            timeout: QUALITY_GATE_AUTO_REPAIR_TIMEOUT_MS,
            env: NPM_INCLUDE_DEV_ENV,
          }
        );
        npmCiSucceeded = true;
        const out = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        if (out) outputParts.push(`[npm ci @ ${worktreePath}] ${out}`);
      } catch (err) {
        const fail = extractCommandFailure("npm ci", err, {
          worktreePath,
          validationWorkspace,
          category: "environment_setup",
        });
        outputParts.push([fail.reason, fail.output].filter(Boolean).join("\n").trim());
        npmCiSucceeded = false;
      }
      const nodeModulesUsable = await isNodeModulesUsable(path.join(worktreePath, "node_modules"));
      if (nodeModulesUsable) {
        const worktreeDependencyHealth = await runDependencyHealthCheck(
          worktreePath,
          deps.runCommand,
          options.toolchainProfile
        );
        worktreeDependencyHealthy = worktreeDependencyHealth.healthy;
        if (!worktreeDependencyHealth.healthy) {
          outputParts.push(
            `[worktree dependency health @ ${worktreePath}] ${worktreeDependencyHealth.output}`
          );
        }
      } else {
        worktreeDependencyHealthy = false;
      }
    } else {
      // merged_candidate repair: symlink from main repo is the primary fast path.
      // 1) Check if repo already has healthy node_modules (skip npm ci if so).
      // 2) If not, run npm ci in repo root.
      // 3) Symlink from host to worktree.
      // 4) If symlink doesn't produce usable (non-empty) node_modules, npm ci in worktree.

      const repoNodeModulesHealthy = await isNodeModulesUsable(
        path.join(options.repoPath, "node_modules")
      );
      let repoDependencyHealthy = false;
      if (repoNodeModulesHealthy) {
        const repoDependencyHealth = await runDependencyHealthCheck(
          options.repoPath,
          deps.runCommand,
          options.toolchainProfile
        );
        repoDependencyHealthy = repoDependencyHealth.healthy;
        if (!repoDependencyHealth.healthy) {
          outputParts.push(
            `[repo dependency health @ ${options.repoPath}] ${repoDependencyHealth.output}`
          );
        }
      }

      if (repoNodeModulesHealthy && repoDependencyHealthy) {
        commands.push("repo node_modules + dependency health already healthy (skip npm ci)");
        npmCiSucceeded = true;
        outputParts.push(
          `[repo check] node_modules and dependency health already healthy at ${options.repoPath}`
        );
      } else {
        commands.push("npm ci (repo root)");
        try {
          const result = await deps.runCommand(
            { command: "npm", args: ["ci"] },
            {
              cwd: options.repoPath,
              timeout: QUALITY_GATE_AUTO_REPAIR_TIMEOUT_MS,
              env: NPM_INCLUDE_DEV_ENV,
            }
          );
          npmCiSucceeded = true;
          const npmCiOutput = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
          if (npmCiOutput) outputParts.push(`[npm ci @ ${options.repoPath}] ${npmCiOutput}`);
        } catch (err) {
          const npmCiFailure = extractCommandFailure("npm ci", err, {
            worktreePath: options.repoPath,
            validationWorkspace,
            category: "environment_setup",
          });
          const npmCiOutput = [npmCiFailure.reason, npmCiFailure.output]
            .filter(Boolean)
            .join("\n")
            .trim();
          if (npmCiOutput) outputParts.push(`[npm ci @ ${options.repoPath}] ${npmCiOutput}`);
        }
      }

      commands.push("symlinkNodeModules (merged_candidate)");
      try {
        await deps.symlinkNodeModules(options.repoPath, worktreePath);
      } catch (err) {
        symlinkSucceeded = false;
        outputParts.push(`[symlinkNodeModules] ${getErrorMessage(err)}`);
      }

      const nodeModulesUsable = await isNodeModulesUsable(path.join(worktreePath, "node_modules"));
      if (nodeModulesUsable) {
        const worktreeDependencyHealth = await runDependencyHealthCheck(
          worktreePath,
          deps.runCommand,
          options.toolchainProfile
        );
        worktreeDependencyHealthy = worktreeDependencyHealth.healthy;
        if (!worktreeDependencyHealthy) {
          outputParts.push(
            `[worktree dependency health @ ${worktreePath}] ${worktreeDependencyHealth.output}`
          );
        }
      } else {
        worktreeDependencyHealthy = false;
      }

      if (!nodeModulesUsable || !worktreeDependencyHealthy) {
        commands.push("npm ci (worktree fallback)");
        try {
          const result = await deps.runCommand(
            { command: "npm", args: ["ci"] },
            {
              cwd: worktreePath,
              timeout: QUALITY_GATE_AUTO_REPAIR_TIMEOUT_MS,
              env: NPM_INCLUDE_DEV_ENV,
            }
          );
          npmCiSucceeded = true;
          const out = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
          if (out) outputParts.push(`[npm ci @ ${worktreePath}] ${out}`);
          worktreeDependencyHealthy = true;

          // After successful worktree install, re-symlink from host if its deps
          // are now healthy so future validations can use the fast symlink path.
          if (await isNodeModulesUsable(path.join(options.repoPath, "node_modules"))) {
            try {
              await deps.symlinkNodeModules(options.repoPath, worktreePath);
              outputParts.push(
                `[re-symlink] Re-linked node_modules from host after worktree install`
              );
            } catch {
              // Worktree already has its own node_modules — non-critical
            }
          }
        } catch (err) {
          const fail = extractCommandFailure("npm ci", err, {
            worktreePath,
            validationWorkspace,
            category: "environment_setup",
          });
          const out = [fail.reason, fail.output].filter(Boolean).join("\n").trim();
          if (out) outputParts.push(`[npm ci @ ${worktreePath}] ${out}`);
          worktreeDependencyHealthy = false;
        }
      }
    }
  } else {
    // Non-merged_candidate, non-baseline: npm ci in worktree + re-symlink.
    const installCwd = options.worktreePath;
    commands.push("npm ci");
    try {
      const result = await deps.runCommand(
        { command: "npm", args: ["ci"] },
        {
          cwd: installCwd,
          timeout: QUALITY_GATE_AUTO_REPAIR_TIMEOUT_MS,
          env: NPM_INCLUDE_DEV_ENV,
        }
      );
      npmCiSucceeded = true;
      const npmCiOutput = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      if (npmCiOutput) outputParts.push(`[npm ci @ ${installCwd}] ${npmCiOutput}`);
    } catch (err) {
      const npmCiFailure = extractCommandFailure("npm ci", err, {
        worktreePath,
        validationWorkspace,
        category: "environment_setup",
      });
      const npmCiOutput = [npmCiFailure.reason, npmCiFailure.output]
        .filter(Boolean)
        .join("\n")
        .trim();
      if (npmCiOutput) outputParts.push(`[npm ci @ ${installCwd}] ${npmCiOutput}`);
    }

    if (hermetic) {
      commands.push("skip symlinkNodeModules (hermetic npm_ci_worktree)");
    } else {
      commands.push("symlinkNodeModules");
      try {
        await deps.symlinkNodeModules(options.repoPath, worktreePath);
      } catch (err) {
        symlinkSucceeded = false;
        outputParts.push(`[symlinkNodeModules] ${getErrorMessage(err)}`);
      }
    }
  }

  let succeeded: boolean;
  if (validationWorkspace === "merged_candidate") {
    succeeded = recreateSucceeded && worktreeDependencyHealthy;
  } else {
    succeeded = recreateSucceeded && npmCiSucceeded && (hermetic || symlinkSucceeded);
  }

  if (succeeded && npmGate) {
    const criticalFiles = ["package.json"];
    const missing: string[] = [];
    for (const file of criticalFiles) {
      try {
        await fs.access(path.join(worktreePath, file));
      } catch {
        missing.push(file);
      }
    }
    if (missing.length > 0) {
      succeeded = false;
      outputParts.push(
        `[post-repair verification] Critical files still missing after repair: ${missing.join(", ")}`
      );
    }
  }

  // Assert node_modules exists and is usable after repair — fail with actionable message if not
  if (succeeded && npmGate) {
    const postRepairUsable = await isNodeModulesUsable(path.join(worktreePath, "node_modules"));
    if (!postRepairUsable) {
      succeeded = false;
      outputParts.push(
        `[post-repair verification] node_modules is missing, empty, or inaccessible at ${worktreePath} after all repair attempts. ` +
          `Ensure the host repo has a valid package-lock.json and run 'npm ci' in the repo root.`
      );
    }
  }

  if (succeeded && npmGate) {
    const dependencyHealth = await runDependencyHealthCheck(worktreePath, deps.runCommand);
    if (!dependencyHealth.healthy) {
      succeeded = false;
      outputParts.push(
        `[post-repair verification] Dependency health check failed (${dependencyHealth.command})\n${dependencyHealth.output}`
      );
    }
  }

  return {
    succeeded,
    commands,
    output: outputParts.join("\n").slice(0, QUALITY_GATE_FAILURE_OUTPUT_LIMIT),
    worktreePath,
  };
}

async function executePreparedGate(
  prepared: PreparedGateCommand,
  options: MergeQualityGateRunOptions,
  validationWorkspace: MergeQualityGateFailure["validationWorkspace"],
  runCommand: NonNullable<MergeQualityGateRunnerDeps["runCommand"]>,
  commandEnv?: NodeJS.ProcessEnv
): Promise<MergeQualityGateFailure | null> {
  const cwd = prepared.executionCwd;
  try {
    await runCommand(prepared.spec, {
      cwd,
      timeout: QUALITY_GATE_AUTO_REPAIR_TIMEOUT_MS,
      ...(commandEnv ? { env: commandEnv } : {}),
    });
    return null;
  } catch (err) {
    return extractCommandFailure(prepared.label, err, {
      worktreePath: cwd,
      validationWorkspace,
    });
  }
}

function resolveMergeGateIntegrationWorkerCap(): number {
  const parsed = Number.parseInt(
    process.env.OPENSPRINT_MERGE_GATE_INTEGRATION_MAX_WORKERS ?? "",
    10
  );
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return 2;
}

function buildMergeGateRunId(options: MergeQualityGateRunOptions): string {
  const seed = `${options.projectId}-${options.taskId}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  return `mergegate_${seed.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export async function runMergeQualityGates(
  options: MergeQualityGateRunOptions,
  deps: MergeQualityGateRunnerDeps = {}
): Promise<MergeQualityGateFailure | null> {
  if (process.env.NODE_ENV === "test") return null;
  if (getDeploymentMode() === "isolated-hosted") {
    const { runIsolatedCommand } = await import("./agent/isolated-runner.js");
    const plan = getMergeQualityGateExecutionPlan({
      profile: options.qualityGateProfile,
      toolchainProfile: options.toolchainProfile,
    });
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const commands = plan.map((step) => {
      const env = Object.entries(step.env ?? {})
        .map(([key, value]) => {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
            throw new Error("Invalid isolated gate environment key");
          return `${key}=${quote(String(value ?? ""))}`;
        })
        .join(" ");
      return `( ${env} ${step.command} )`;
    });
    if (!commands.length) return null;
    const result = await runIsolatedCommand(options.worktreePath, commands.join(" && "));
    return result.exitCode === 0
      ? null
      : {
          command: plan.map((item) => item.command).join(" && "),
          reason: "Isolated quality gate failed",
          output: result.output,
          worktreePath: options.worktreePath,
          validationWorkspace: options.validationWorkspace,
          category: "quality_gate",
          exitCode: result.exitCode,
        };
  }

  const normWt = await resolveMergeGateFilesystemRoot(options.worktreePath);
  const normRepo = await resolveMergeGateFilesystemRoot(options.repoPath);

  const effectiveValidationWorkspace =
    options.validationWorkspace ?? (normWt === normRepo ? "repo_root" : "task_worktree");
  if (normWt !== normRepo && effectiveValidationWorkspace === "task_worktree") {
    const integrity = await assertWorktreeIntegrity(normRepo, normWt, options.taskId, "merge");
    if (!integrity.valid) {
      log.warn("Worktree integrity pre-check failed, attempting auto-rebuild", {
        taskId: options.taskId,
        failureReason: integrity.failureReason,
        detail: integrity.detail,
        worktreePath: normWt,
      });

      const branchManager = new BranchManager();
      const rebuildResult = await rebuildWorktreeIfInvalid(
        normRepo,
        normWt,
        options.taskId,
        options.branchName,
        options.baseBranch,
        {
          removeWorktree: (rp, key, ap) =>
            branchManager.removeTaskWorktree(rp, key, ap, { bypassReferenceProtection: true }),
          createWorktree: (rp, tid, bb, opts) =>
            branchManager.createTaskWorktree(rp, tid, bb, opts),
        }
      );

      if (!rebuildResult.rebuilt) {
        return await withMergeGateFailureTelemetry(
          redactMergeQualityGateFailureSurface({
            command: "(pre-gate integrity check)",
            reason: `Worktree integrity check failed and auto-rebuild unsuccessful: ${integrity.detail}${rebuildResult.error ? ` | rebuild error: ${rebuildResult.error}` : ""}`,
            output: "",
            worktreePath: normWt,
            validationWorkspace: options.validationWorkspace,
            category: "environment_setup",
            autoRepairAttempted: true,
            autoRepairSucceeded: false,
          }),
          normWt,
          deps.runCommand ?? runCommandDefault
        );
      }

      log.info("Worktree auto-rebuilt before quality gates", {
        taskId: options.taskId,
        newPath: rebuildResult.newPath,
      });
    }
  }
  const gateOptions: MergeQualityGateRunOptions = {
    ...options,
    worktreePath: normWt,
    repoPath: normRepo,
  };

  const runCommand = deps.runCommand ?? runCommandDefault;
  const resolvedProfileEarly = resolveToolchainProfile(gateOptions.toolchainProfile);
  const gateValidationWorkspace =
    gateOptions.validationWorkspace ?? (normWt === normRepo ? "repo_root" : "task_worktree");

  if (
    usesHermeticWorktreeNodeModules(resolvedProfileEarly.dependencyStrategy) &&
    (gateValidationWorkspace === "task_worktree" || gateValidationWorkspace === "repo_root")
  ) {
    try {
      await prepareHermeticWorktreeNodeModules(normWt, runCommand);
    } catch (err) {
      return await withMergeGateFailureTelemetry(
        extractCommandFailure("npm ci (hermetic pre-gate)", err, {
          worktreePath: normWt,
          validationWorkspace: gateValidationWorkspace,
        }),
        normWt,
        runCommand
      );
    }
  }

  const validationService = new ValidationWorkspaceService();
  const healthCheck = await validationService.verifyWorkspaceHealth(
    normRepo,
    normWt,
    gateOptions.validationWorkspace ?? (normWt === normRepo ? "repo_root" : "task_worktree")
  );
  if (!healthCheck.healthy) {
    log.warn("Workspace health check failed before running quality gates", {
      taskId: gateOptions.taskId,
      worktreePath: normWt,
      errors: healthCheck.errors,
    });
    return await withMergeGateFailureTelemetry(
      redactMergeQualityGateFailureSurface({
        command: "workspace_health_check",
        reason: `Workspace not ready: ${healthCheck.errors.join("; ")}`,
        output: healthCheck.errors.join("\n"),
        worktreePath: normWt,
        validationWorkspace:
          gateOptions.validationWorkspace ?? (normWt === normRepo ? "repo_root" : "task_worktree"),
        category: "environment_setup",
        classificationConfidence: "high",
        classificationReason: "unified workspace health check failed before gate execution",
      }),
      normWt,
      runCommand
    );
  }

  const runtimeCapture = await captureMergeGateRuntimeTelemetry(
    normWt,
    gateOptions.validationWorkspace ?? (normWt === normRepo ? "repo_root" : "task_worktree"),
    resolvedProfileEarly.dependencyStrategy,
    usesHermeticWorktreeNodeModules(resolvedProfileEarly.dependencyStrategy),
    runCommand
  );
  if (runtimeCapture.preflightFailure) {
    return await withMergeGateFailureTelemetry(
      runtimeCapture.preflightFailure,
      normWt,
      runCommand,
      runtimeCapture.fields
    );
  }
  const gateRuntimeFields = runtimeCapture.fields;

  const qualityGateProfile = gateOptions.qualityGateProfile ?? "deterministic";
  const executionPlan: MergeQualityGateExecutionPlanEntry[] = deps.commands
    ? deps.commands.map((command) => ({ command }))
    : getMergeQualityGateExecutionPlan({
        profile: qualityGateProfile,
        testRunId: buildMergeGateRunId(gateOptions),
        integrationWorkerCap: resolveMergeGateIntegrationWorkerCap(),
        toolchainProfile: gateOptions.toolchainProfile,
      });
  const validationWorkspace =
    gateOptions.validationWorkspace ?? (normWt === normRepo ? "repo_root" : "task_worktree");
  const resolvedProfile = resolvedProfileEarly;
  const symlinkNodeModules =
    deps.symlinkNodeModules ??
    (async (repoPath: string, wtPath: string) => {
      const branchManager = new BranchManager();
      await branchManager.symlinkNodeModules(repoPath, wtPath);
    });

  for (const gate of executionPlan) {
    const command = gate.command;
    const commandEnv = gate.env;
    const preparedOrFailure = await prepareGateCommand(
      gateOptions,
      command,
      validationWorkspace,
      runCommand
    );
    if ("skipped" in preparedOrFailure) {
      log.info("Skipping merge quality gate because npm script is not defined", {
        projectId: gateOptions.projectId,
        taskId: gateOptions.taskId,
        command,
        cwd: gateOptions.worktreePath,
      });
      continue;
    }
    if ("failure" in preparedOrFailure) {
      const initialFailure = preparedOrFailure.failure;
      if (initialFailure.category !== "environment_setup") {
        return await withMergeGateFailureTelemetry(
          initialFailure,
          normWt,
          runCommand,
          gateRuntimeFields
        );
      }
      if (
        !isNodeDependencyStrategy(resolvedProfile.dependencyStrategy) ||
        parseCommandSpec(command).command !== "npm"
      ) {
        return await withMergeGateFailureTelemetry(
          initialFailure,
          normWt,
          runCommand,
          gateRuntimeFields
        );
      }

      const autoRepair = await repairQualityGateEnvironment(
        gateOptions,
        validationWorkspace,
        command,
        {
          runCommand,
          symlinkNodeModules,
        }
      );
      const retryPreparedOrFailure = await prepareGateCommand(
        { ...gateOptions, worktreePath: autoRepair.worktreePath },
        command,
        validationWorkspace,
        runCommand
      );
      if ("skipped" in retryPreparedOrFailure) {
        continue;
      }
      if ("failure" in retryPreparedOrFailure) {
        return await withMergeGateFailureTelemetry(
          {
            ...retryPreparedOrFailure.failure,
            autoRepairAttempted: true,
            autoRepairSucceeded: autoRepair.succeeded,
            autoRepairCommands: autoRepair.commands,
            autoRepairOutput: autoRepair.output,
          },
          normWt,
          runCommand,
          gateRuntimeFields
        );
      }
      const retryFailure = await executePreparedGate(
        retryPreparedOrFailure.prepared,
        { ...gateOptions, worktreePath: autoRepair.worktreePath },
        validationWorkspace,
        runCommand,
        commandEnv
      );
      if (retryFailure) {
        return await withMergeGateFailureTelemetry(
          {
            ...retryFailure,
            autoRepairAttempted: true,
            autoRepairSucceeded: autoRepair.succeeded,
            autoRepairCommands: autoRepair.commands,
            autoRepairOutput: autoRepair.output,
          },
          normWt,
          runCommand,
          gateRuntimeFields
        );
      }
      continue;
    }

    log.info("Running merge quality gate", {
      projectId: gateOptions.projectId,
      taskId: gateOptions.taskId,
      command,
      cwd: preparedOrFailure.prepared.executionCwd,
      executable: preparedOrFailure.prepared.executable,
    });
    const initialFailure = await executePreparedGate(
      preparedOrFailure.prepared,
      gateOptions,
      validationWorkspace,
      runCommand,
      commandEnv
    );
    if (!initialFailure) continue;
    if (initialFailure.category !== "environment_setup") {
      log.warn("Merge quality gate failed", {
        projectId: gateOptions.projectId,
        taskId: gateOptions.taskId,
        command,
        reason: initialFailure.reason,
      });
      return await withMergeGateFailureTelemetry(
        initialFailure,
        normWt,
        runCommand,
        gateRuntimeFields
      );
    }
    if (
      !isNodeDependencyStrategy(resolvedProfile.dependencyStrategy) ||
      parseCommandSpec(command).command !== "npm"
    ) {
      return await withMergeGateFailureTelemetry(
        initialFailure,
        normWt,
        runCommand,
        gateRuntimeFields
      );
    }

    const autoRepair = await repairQualityGateEnvironment(
      gateOptions,
      validationWorkspace,
      command,
      {
        runCommand,
        symlinkNodeModules,
      }
    );
    const retryPreparedOrFailure = await prepareGateCommand(
      { ...gateOptions, worktreePath: autoRepair.worktreePath },
      command,
      validationWorkspace,
      runCommand
    );
    if ("skipped" in retryPreparedOrFailure) {
      continue;
    }
    if ("failure" in retryPreparedOrFailure) {
      return await withMergeGateFailureTelemetry(
        {
          ...retryPreparedOrFailure.failure,
          autoRepairAttempted: true,
          autoRepairSucceeded: autoRepair.succeeded,
          autoRepairCommands: autoRepair.commands,
          autoRepairOutput: autoRepair.output,
        },
        normWt,
        runCommand,
        gateRuntimeFields
      );
    }

    log.info("Retrying merge quality gate after environment auto-repair", {
      projectId: gateOptions.projectId,
      taskId: gateOptions.taskId,
      command,
      repairCommands: autoRepair.commands,
      cwd: autoRepair.worktreePath,
    });
    const retryFailure = await executePreparedGate(
      retryPreparedOrFailure.prepared,
      { ...gateOptions, worktreePath: autoRepair.worktreePath },
      validationWorkspace,
      runCommand,
      commandEnv
    );
    if (!retryFailure) continue;

    log.warn("Merge quality gate failed after environment auto-repair retry", {
      projectId: gateOptions.projectId,
      taskId: gateOptions.taskId,
      command,
      reason: retryFailure.reason,
      category: retryFailure.category,
    });
    return await withMergeGateFailureTelemetry(
      {
        ...retryFailure,
        autoRepairAttempted: true,
        autoRepairSucceeded: autoRepair.succeeded,
        autoRepairCommands: autoRepair.commands,
        autoRepairOutput: autoRepair.output,
      },
      normWt,
      runCommand,
      gateRuntimeFields
    );
  }

  return null;
}
