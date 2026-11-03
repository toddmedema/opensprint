import { agentProcessEnvironment } from "../../utils/agent-process-env.js";
import { exec } from "child_process";
import { promisify } from "util";
import type { ScaffoldRecoveryInfo } from "@opensprint/shared";
import type { AgentConfigInput } from "../../schemas/agent-config.js";
import { getErrorMessage } from "../../utils/error-utils.js";
import { createLogger } from "../../utils/logger.js";
import { classifyInitError, attemptRecovery } from "../scaffold-recovery.service.js";

const execAsync = promisify(exec);
const log = createLogger("project");

/** Check that git and node are available before scaffolding. */
export async function checkScaffoldPrerequisites(): Promise<{ missing: string[] }> {
  const missing: string[] = [];
  const timeout = 5000;

  const isCommandNotFound = (err: unknown): boolean => {
    const msg = err instanceof Error ? err.message : String(err);
    const code =
      err && typeof err === "object" && "code" in err ? (err as { code?: string }).code : undefined;
    return (
      code === "ENOENT" ||
      /command not found/i.test(msg) ||
      /not recognized/i.test(msg) ||
      /not found/i.test(msg)
    );
  };

  try {
    await execAsync("git --version", { env: agentProcessEnvironment(), timeout });
  } catch (err) {
    if (isCommandNotFound(err)) {
      missing.push("Git");
    } else {
      throw err;
    }
  }

  try {
    await execAsync("node --version", { env: agentProcessEnvironment(), timeout });
  } catch (err) {
    if (isCommandNotFound(err)) {
      missing.push("Node.js");
    } else {
      throw err;
    }
  }

  return { missing };
}

/**
 * Run a shell command with agent-driven error recovery.
 * On failure: classifies the error, invokes an agent to fix it, retries once.
 */
export async function runScaffoldCommandWithRecovery(
  command: string,
  cwd: string,
  agentConfig: AgentConfigInput & { type: string },
  fallbackMessage: string
): Promise<{ success: boolean; errorMessage?: string; recovery?: ScaffoldRecoveryInfo }> {
  try {
    await execAsync(command, { env: agentProcessEnvironment(), cwd });
    return { success: true };
  } catch (firstErr) {
    const rawError = getErrorMessage(firstErr, fallbackMessage);
    const classification = classifyInitError(rawError);

    log.info("Scaffold command failed, attempting recovery", {
      command,
      category: classification.category,
      recoverable: classification.recoverable,
    });

    if (!classification.recoverable) {
      return {
        success: false,
        errorMessage: `${classification.summary}: ${rawError}`,
        recovery: {
          attempted: false,
          success: false,
          errorCategory: classification.category,
          errorSummary: classification.summary,
        },
      };
    }

    const recoveryResult = await attemptRecovery(classification, cwd, agentConfig);

    if (!recoveryResult.success) {
      return {
        success: false,
        errorMessage: recoveryResult.errorMessage ?? `${classification.summary}: ${rawError}`,
        recovery: {
          attempted: true,
          success: false,
          errorCategory: classification.category,
          errorSummary: classification.summary,
          agentOutput: recoveryResult.agentOutput,
        },
      };
    }

    log.info("Recovery agent succeeded, retrying command", { command });
    try {
      await execAsync(command, { env: agentProcessEnvironment(), cwd });
      return {
        success: true,
        recovery: {
          attempted: true,
          success: true,
          errorCategory: classification.category,
          errorSummary: classification.summary,
          agentOutput: recoveryResult.agentOutput,
        },
      };
    } catch (retryErr) {
      const retryMsg = getErrorMessage(retryErr, fallbackMessage);
      return {
        success: false,
        errorMessage: `Recovery agent ran but the command still failed: ${retryMsg}`,
        recovery: {
          attempted: true,
          success: false,
          errorCategory: classification.category,
          errorSummary: classification.summary,
          agentOutput: recoveryResult.agentOutput,
        },
      };
    }
  }
}
