import { createLogger } from "../utils/logger.js";
import { getErrorMessage } from "../utils/error-utils.js";
import { shellExec as shellExecDefault } from "../utils/shell-exec.js";
import { BranchManager } from "./branch-manager.js";
import { getMergeQualityGateCommands } from "./merge-quality-gates.js";

const log = createLogger("merge-quality-gate-runner");
const QUALITY_GATE_FAILURE_OUTPUT_LIMIT = 4000;
const QUALITY_GATE_FAILURE_REASON_LIMIT = 500;
const QUALITY_GATE_AUTO_REPAIR_TIMEOUT_MS = 20 * 60 * 1000;
const QUALITY_GATE_ENV_FINGERPRINTS: RegExp[] = [
  /\bmodule_not_found\b/i,
  /cannot find module/i,
  /cannot find package/i,
  /enoent[\s\S]*node_modules/i,
  /missing node_modules/i,
  /no such file or directory[\s\S]*node_modules/i,
  /native addon/i,
  /could not locate the bindings file/i,
  /was compiled against a different node\.js version/i,
];

export interface MergeQualityGateRunOptions {
  projectId: string;
  repoPath: string;
  worktreePath: string;
  taskId: string;
  branchName: string;
  baseBranch: string;
}

export interface MergeQualityGateFailure {
  command: string;
  reason: string;
  output: string;
  outputSnippet?: string;
  worktreePath?: string;
  firstErrorLine?: string;
  category?: "environment_setup" | "quality_gate";
  autoRepairAttempted?: boolean;
  autoRepairSucceeded?: boolean;
  autoRepairCommands?: string[];
  autoRepairOutput?: string;
}

interface MergeQualityGateRunnerDeps {
  shellExec?: typeof shellExecDefault;
  symlinkNodeModules?: (repoPath: string, wtPath: string) => Promise<void>;
  commands?: string[];
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

/** Runner/npm noise we skip when looking for the first meaningful error line. */
const NOISE_LINE = /^\s*(>|npm ERR!)/;

/** Lines that look like a real compiler/test error (file:line, error TS, Error:, etc.). */
const MEANINGFUL_ERROR_LINE =
  /error\s+TS\d+|Error:|AssertionError:|:\s*error\s|Cannot find|failed|FAIL\s|\.(ts|tsx|js|jsx):\d+/i;

function getFirstMeaningfulErrorLine(value: string | null | undefined): string | null {
  if (!value) return null;
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const meaningful = lines.find(
    (line) => !NOISE_LINE.test(line) && MEANINGFUL_ERROR_LINE.test(line)
  );
  return meaningful ?? getFirstNonEmptyLine(value);
}

function extractShellFailure(
  command: string,
  err: unknown
): { reason: string; output: string; firstErrorLine: string } {
  const e = err as { stdout?: string; stderr?: string; message?: string };
  const output = [e.stdout ?? "", e.stderr ?? ""]
    .filter((part) => part.trim().length > 0)
    .join("\n")
    .trim()
    .slice(0, QUALITY_GATE_FAILURE_OUTPUT_LIMIT);
  const reason = (e.message ?? `Command failed: ${command}`).slice(
    0,
    QUALITY_GATE_FAILURE_REASON_LIMIT
  );
  const firstErrorLine =
    getFirstMeaningfulErrorLine(output) ??
    getFirstNonEmptyLine(output) ??
    getFirstNonEmptyLine(reason) ??
    "Unknown quality gate failure";
  return { reason, output, firstErrorLine };
}

function isQualityGateEnvironmentFailure(failure: {
  reason: string;
  output: string;
  firstErrorLine: string;
}): boolean {
  const text = `${failure.reason}\n${failure.output}\n${failure.firstErrorLine}`;
  return QUALITY_GATE_ENV_FINGERPRINTS.some((fingerprint) => fingerprint.test(text));
}

async function repairQualityGateEnvironment(
  repoPath: string,
  wtPath: string,
  deps: Required<Pick<MergeQualityGateRunnerDeps, "shellExec" | "symlinkNodeModules">>
): Promise<{ succeeded: boolean; commands: string[]; output: string }> {
  const outputParts: string[] = [];
  const repairRoot = wtPath === repoPath ? wtPath : repoPath;
  let npmCiSucceeded = false;
  try {
    const { stdout, stderr } = await deps.shellExec("npm ci", {
      cwd: repairRoot,
      timeout: QUALITY_GATE_AUTO_REPAIR_TIMEOUT_MS,
    });
    npmCiSucceeded = true;
    const npmCiOutput = [stdout, stderr].filter(Boolean).join("\n").trim();
    if (npmCiOutput) outputParts.push(`[npm ci] ${npmCiOutput}`);
  } catch (err) {
    const npmCiFailure = extractShellFailure("npm ci", err);
    const npmCiOutput = [npmCiFailure.reason, npmCiFailure.output]
      .filter(Boolean)
      .join("\n")
      .trim();
    if (npmCiOutput) outputParts.push(`[npm ci] ${npmCiOutput}`);
  }

  let symlinkSucceeded = true;
  try {
    await deps.symlinkNodeModules(repoPath, wtPath);
  } catch (err) {
    symlinkSucceeded = false;
    outputParts.push(`[symlinkNodeModules] ${getErrorMessage(err)}`);
  }

  return {
    succeeded: npmCiSucceeded && symlinkSucceeded,
    commands: ["npm ci", "symlinkNodeModules"],
    output: outputParts.join("\n").slice(0, QUALITY_GATE_FAILURE_OUTPUT_LIMIT),
  };
}

export async function runMergeQualityGates(
  options: MergeQualityGateRunOptions,
  deps: MergeQualityGateRunnerDeps = {}
): Promise<MergeQualityGateFailure | null> {
  // Test suites mock merge coordination heavily; skip expensive quality-gate execution in test runtime.
  if (process.env.NODE_ENV === "test") return null;

  const execute = deps.shellExec ?? shellExecDefault;
  const commands = deps.commands ?? getMergeQualityGateCommands();
  const symlinkNodeModules =
    deps.symlinkNodeModules ??
    (async (repoPath: string, wtPath: string) => {
      const branchManager = new BranchManager();
      await branchManager.symlinkNodeModules(repoPath, wtPath);
    });
  const cwd = options.worktreePath;

  for (const command of commands) {
    try {
      log.info("Running merge quality gate", {
        projectId: options.projectId,
        taskId: options.taskId,
        command,
        cwd,
      });
      await execute(command, {
        cwd,
        timeout: QUALITY_GATE_AUTO_REPAIR_TIMEOUT_MS,
      });
    } catch (err) {
      const initialFailure = extractShellFailure(command, err);
      const isEnvironmentFailure = isQualityGateEnvironmentFailure(initialFailure);
      if (!isEnvironmentFailure) {
        log.warn("Merge quality gate failed", {
          projectId: options.projectId,
          taskId: options.taskId,
          command,
          reason: initialFailure.reason,
        });
        return {
          command,
          reason: initialFailure.reason,
          output: initialFailure.output,
          outputSnippet: initialFailure.output.slice(0, 1800),
          worktreePath: options.worktreePath,
          firstErrorLine: initialFailure.firstErrorLine,
          category: "quality_gate",
          autoRepairAttempted: false,
          autoRepairSucceeded: false,
          autoRepairCommands: [],
          autoRepairOutput: "",
        };
      }

      const autoRepair = await repairQualityGateEnvironment(
        options.repoPath,
        options.worktreePath,
        {
          shellExec: execute,
          symlinkNodeModules,
        }
      );
      try {
        log.info("Retrying merge quality gate after environment auto-repair", {
          projectId: options.projectId,
          taskId: options.taskId,
          command,
          repairCommands: autoRepair.commands,
        });
        await execute(command, {
          cwd,
          timeout: QUALITY_GATE_AUTO_REPAIR_TIMEOUT_MS,
        });
        continue;
      } catch (retryErr) {
        const retryFailure = extractShellFailure(command, retryErr);
        const retryStillEnvironmentFailure = isQualityGateEnvironmentFailure(retryFailure);
        const category = retryStillEnvironmentFailure ? "environment_setup" : "quality_gate";
        log.warn("Merge quality gate failed after environment auto-repair retry", {
          projectId: options.projectId,
          taskId: options.taskId,
          command,
          reason: retryFailure.reason,
          category,
        });
        return {
          command,
          reason: retryFailure.reason,
          output: retryFailure.output,
          outputSnippet: retryFailure.output.slice(0, 1800),
          worktreePath: options.worktreePath,
          firstErrorLine: retryFailure.firstErrorLine,
          category,
          autoRepairAttempted: true,
          autoRepairSucceeded: autoRepair.succeeded,
          autoRepairCommands: autoRepair.commands,
          autoRepairOutput: autoRepair.output,
        };
      }
    }
  }

  return null;
}
