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
import { BranchManager } from "./branch-manager.js";
import { getMergeQualityGateCommands } from "./merge-quality-gates.js";

const log = createLogger("merge-quality-gate-runner");
const QUALITY_GATE_FAILURE_OUTPUT_LIMIT = 4000;
const QUALITY_GATE_FAILURE_REASON_LIMIT = 500;
const QUALITY_GATE_AUTO_REPAIR_TIMEOUT_MS = 20 * 60 * 1000;
const QUALITY_GATE_PRECHECK_TIMEOUT_MS = 30_000;
const QUALITY_GATE_ENV_FINGERPRINTS: RegExp[] = [
  /\bmodule_not_found\b/i,
  /\bcannot find module\b/i,
  /\bcannot find package\b/i,
  /\bspawn\s+\S+\s+enoent\b/i,
  /\benoent\b/i,
  /\beacces\b/i,
  /\bmissing script:\b/i,
  /\bnode_modules\b/i,
  /\bnative addon\b/i,
  /\bcould not locate the bindings file\b/i,
  /\bwas compiled against a different node\.js version\b/i,
  /\bnot a git repository\b/i,
  /\bneeded a single revision\b/i,
  /\bpackage\.json\b/i,
  /\bworktree\b/i,
];

export interface MergeQualityGateRunOptions {
  projectId: string;
  repoPath: string;
  worktreePath: string;
  taskId: string;
  branchName: string;
  baseBranch: string;
  validationWorkspace?: "baseline" | "merged_candidate" | "task_worktree" | "repo_root";
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
}

interface MergeQualityGateRunnerDeps {
  runCommand?: (
    spec: CommandSpec,
    options: { cwd: string; timeout?: number }
  ) => Promise<CommandRunResult>;
  symlinkNodeModules?: (repoPath: string, wtPath: string) => Promise<void>;
  commands?: string[];
}

interface PreparedGateCommand {
  label: string;
  spec: CommandSpec;
  executable: string;
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
  /^\s*stderr \|/i,
  /^\s*RUN\s+v?\d/i,
  /^\s*Test Files\s+\d+\s+passed/i,
  /^\s*Tests\s+\d+\s+passed/i,
  /^\s*Start at /i,
  /^\s*Duration /i,
  /^\s*[|\\/-]{2,}\s*$/,
  /^\s*[=-]{3,}\s*$/,
  /^\s*✓\s+/,
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
  { pattern: /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)\b.*[:(]\d+([:,)]\d+)?/i, score: 105 },
  { pattern: /^\s*FAIL\b/i, score: 100 },
  { pattern: /\b(Expected|Received):\b/, score: 95 },
  { pattern: /\berror during build\b/i, score: 90 },
  { pattern: /\b(Command failed|failed)\b/i, score: 75 },
  { pattern: /\bError:/i, score: 70 },
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
  autoRepairAttempted?: boolean;
  autoRepairSucceeded?: boolean;
  autoRepairCommands?: string[];
  autoRepairOutput?: string;
}): MergeQualityGateFailure {
  const output = (params.output ?? "").slice(0, QUALITY_GATE_FAILURE_OUTPUT_LIMIT);
  const outputSnippet =
    (params.outputSnippet ?? getRelevantOutputSnippet(output) ?? "").slice(0, 1800) || undefined;
  const firstErrorLine =
    params.firstErrorLine?.trim() ||
    getFirstMeaningfulErrorLine(outputSnippet) ||
    getFirstMeaningfulErrorLine(output) ||
    getFirstNonEmptyLine(params.reason) ||
    "Unknown quality gate failure";
  return {
    command: params.command,
    reason: params.reason.slice(0, QUALITY_GATE_FAILURE_REASON_LIMIT),
    output,
    outputSnippet,
    worktreePath: params.worktreePath,
    firstErrorLine,
    validationWorkspace: params.validationWorkspace,
    category: params.category,
    autoRepairAttempted: params.autoRepairAttempted ?? false,
    autoRepairSucceeded: params.autoRepairSucceeded ?? false,
    autoRepairCommands: params.autoRepairCommands ?? [],
    autoRepairOutput: params.autoRepairOutput ?? "",
    executable: params.executable?.trim() || undefined,
    cwd: params.cwd?.trim() || undefined,
    exitCode: params.exitCode ?? undefined,
    signal: params.signal ?? undefined,
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
  const category =
    params.category ??
    (isQualityGateEnvironmentFailure({
      reason,
      output,
      firstErrorLine,
      code: typeof commandErr.code === "string" ? commandErr.code : undefined,
      exitCode: typeof commandErr.exitCode === "number" ? commandErr.exitCode : null,
    })
      ? "environment_setup"
      : "quality_gate");

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
  });
}

function isQualityGateEnvironmentFailure(failure: {
  reason: string;
  output: string;
  firstErrorLine: string;
  code?: string;
  exitCode?: number | null;
}): boolean {
  if (failure.code === "ENOENT" || failure.code === "EACCES") return true;
  if (failure.exitCode === 127 || failure.exitCode === 126) return true;
  const text = `${failure.reason}\n${failure.output}\n${failure.firstErrorLine}`;
  return QUALITY_GATE_ENV_FINGERPRINTS.some((fingerprint) => fingerprint.test(text));
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

async function prepareGateCommand(
  options: MergeQualityGateRunOptions,
  command: string,
  validationWorkspace: MergeQualityGateFailure["validationWorkspace"],
  runCommand: NonNullable<MergeQualityGateRunnerDeps["runCommand"]>
): Promise<PreparedGateCommandResult> {
  const cwd = options.worktreePath;
  const workspaceFailure = await ensurePathExists(cwd, `Validation workspace is missing: ${cwd}`, {
    command,
    validationWorkspace,
    worktreePath: cwd,
  });
  if (workspaceFailure) return { failure: workspaceFailure };

  const packageJsonPath = path.join(cwd, "package.json");
  const packageJsonFailure = await ensurePathExists(
    packageJsonPath,
    `Validation workspace package.json is missing: ${packageJsonPath}`,
    {
      command,
      validationWorkspace,
      worktreePath: cwd,
    }
  );
  if (packageJsonFailure) return { failure: packageJsonFailure };

  let packageScripts = new Set<string>();
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

  const scriptName = extractNpmRunScriptName(command);
  if (scriptName && !packageScripts.has(scriptName)) {
    return {
      skipped: true,
      packageScripts,
    };
  }

  const nodeModulesFailure = await ensurePathExists(
    path.join(cwd, "node_modules"),
    `Validation workspace node_modules is missing for ${cwd}`,
    {
      command,
      validationWorkspace,
      worktreePath: cwd,
    }
  );
  if (nodeModulesFailure) return { failure: nodeModulesFailure };

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

  const spec = parseCommandSpec(command);
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
    },
    packageScripts,
  };
}

async function repairQualityGateEnvironment(
  options: MergeQualityGateRunOptions,
  validationWorkspace: MergeQualityGateFailure["validationWorkspace"],
  deps: Required<Pick<MergeQualityGateRunnerDeps, "runCommand" | "symlinkNodeModules">>
): Promise<AutoRepairResult> {
  const outputParts: string[] = [];
  const commands: string[] = [];
  const worktreePath = options.worktreePath;
  let recreateSucceeded = true;

  if (validationWorkspace === "baseline") {
    const noHooks = getGitNoHooksPath();
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
  } else {
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
        outputParts.push(
          `[git checkout package.json] ${getErrorMessage(err)}`
        );
      }
    }
  }

  let npmCiSucceeded = false;
  commands.push("npm ci");
  try {
    const result = await deps.runCommand(
      {
        command: "npm",
        args: ["ci"],
      },
      {
        cwd: options.repoPath,
        timeout: QUALITY_GATE_AUTO_REPAIR_TIMEOUT_MS,
      }
    );
    npmCiSucceeded = true;
    const npmCiOutput = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    if (npmCiOutput) outputParts.push(`[npm ci] ${npmCiOutput}`);
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
    if (npmCiOutput) outputParts.push(`[npm ci] ${npmCiOutput}`);
  }

  commands.push("symlinkNodeModules");
  let symlinkSucceeded = true;
  try {
    await deps.symlinkNodeModules(options.repoPath, worktreePath);
  } catch (err) {
    symlinkSucceeded = false;
    outputParts.push(`[symlinkNodeModules] ${getErrorMessage(err)}`);
  }

  return {
    succeeded: recreateSucceeded && npmCiSucceeded && symlinkSucceeded,
    commands,
    output: outputParts.join("\n").slice(0, QUALITY_GATE_FAILURE_OUTPUT_LIMIT),
    worktreePath,
  };
}

async function executePreparedGate(
  prepared: PreparedGateCommand,
  options: MergeQualityGateRunOptions,
  validationWorkspace: MergeQualityGateFailure["validationWorkspace"],
  runCommand: NonNullable<MergeQualityGateRunnerDeps["runCommand"]>
): Promise<MergeQualityGateFailure | null> {
  try {
    await runCommand(prepared.spec, {
      cwd: options.worktreePath,
      timeout: QUALITY_GATE_AUTO_REPAIR_TIMEOUT_MS,
    });
    return null;
  } catch (err) {
    return extractCommandFailure(prepared.label, err, {
      worktreePath: options.worktreePath,
      validationWorkspace,
    });
  }
}

export async function runMergeQualityGates(
  options: MergeQualityGateRunOptions,
  deps: MergeQualityGateRunnerDeps = {}
): Promise<MergeQualityGateFailure | null> {
  if (process.env.NODE_ENV === "test") return null;

  const runCommand = deps.runCommand ?? runCommandDefault;
  const commands = deps.commands ?? getMergeQualityGateCommands();
  const validationWorkspace =
    options.validationWorkspace ??
    (options.worktreePath === options.repoPath ? "repo_root" : "task_worktree");
  const symlinkNodeModules =
    deps.symlinkNodeModules ??
    (async (repoPath: string, wtPath: string) => {
      const branchManager = new BranchManager();
      await branchManager.symlinkNodeModules(repoPath, wtPath);
    });

  for (const command of commands) {
    const preparedOrFailure = await prepareGateCommand(
      options,
      command,
      validationWorkspace,
      runCommand
    );
    if ("skipped" in preparedOrFailure) {
      log.info("Skipping merge quality gate because npm script is not defined", {
        projectId: options.projectId,
        taskId: options.taskId,
        command,
        cwd: options.worktreePath,
      });
      continue;
    }
    if ("failure" in preparedOrFailure) {
      const initialFailure = preparedOrFailure.failure;
      if (initialFailure.category !== "environment_setup") {
        return initialFailure;
      }

      const autoRepair = await repairQualityGateEnvironment(options, validationWorkspace, {
        runCommand,
        symlinkNodeModules,
      });
      const retryPreparedOrFailure = await prepareGateCommand(
        { ...options, worktreePath: autoRepair.worktreePath },
        command,
        validationWorkspace,
        runCommand
      );
      if ("skipped" in retryPreparedOrFailure) {
        continue;
      }
      if ("failure" in retryPreparedOrFailure) {
        return {
          ...retryPreparedOrFailure.failure,
          autoRepairAttempted: true,
          autoRepairSucceeded: autoRepair.succeeded,
          autoRepairCommands: autoRepair.commands,
          autoRepairOutput: autoRepair.output,
        };
      }
      const retryFailure = await executePreparedGate(
        retryPreparedOrFailure.prepared,
        { ...options, worktreePath: autoRepair.worktreePath },
        validationWorkspace,
        runCommand
      );
      if (retryFailure) {
        return {
          ...retryFailure,
          autoRepairAttempted: true,
          autoRepairSucceeded: autoRepair.succeeded,
          autoRepairCommands: autoRepair.commands,
          autoRepairOutput: autoRepair.output,
        };
      }
      continue;
    }

    log.info("Running merge quality gate", {
      projectId: options.projectId,
      taskId: options.taskId,
      command,
      cwd: options.worktreePath,
      executable: preparedOrFailure.prepared.executable,
    });
    const initialFailure = await executePreparedGate(
      preparedOrFailure.prepared,
      options,
      validationWorkspace,
      runCommand
    );
    if (!initialFailure) continue;
    if (initialFailure.category !== "environment_setup") {
      log.warn("Merge quality gate failed", {
        projectId: options.projectId,
        taskId: options.taskId,
        command,
        reason: initialFailure.reason,
      });
      return initialFailure;
    }

    const autoRepair = await repairQualityGateEnvironment(options, validationWorkspace, {
      runCommand,
      symlinkNodeModules,
    });
    const retryPreparedOrFailure = await prepareGateCommand(
      { ...options, worktreePath: autoRepair.worktreePath },
      command,
      validationWorkspace,
      runCommand
    );
    if ("skipped" in retryPreparedOrFailure) {
      continue;
    }
    if ("failure" in retryPreparedOrFailure) {
      return {
        ...retryPreparedOrFailure.failure,
        autoRepairAttempted: true,
        autoRepairSucceeded: autoRepair.succeeded,
        autoRepairCommands: autoRepair.commands,
        autoRepairOutput: autoRepair.output,
      };
    }

    log.info("Retrying merge quality gate after environment auto-repair", {
      projectId: options.projectId,
      taskId: options.taskId,
      command,
      repairCommands: autoRepair.commands,
      cwd: autoRepair.worktreePath,
    });
    const retryFailure = await executePreparedGate(
      retryPreparedOrFailure.prepared,
      { ...options, worktreePath: autoRepair.worktreePath },
      validationWorkspace,
      runCommand
    );
    if (!retryFailure) continue;

    log.warn("Merge quality gate failed after environment auto-repair retry", {
      projectId: options.projectId,
      taskId: options.taskId,
      command,
      reason: retryFailure.reason,
      category: retryFailure.category,
    });
    return {
      ...retryFailure,
      autoRepairAttempted: true,
      autoRepairSucceeded: autoRepair.succeeded,
      autoRepairCommands: autoRepair.commands,
      autoRepairOutput: autoRepair.output,
    };
  }

  return null;
}
