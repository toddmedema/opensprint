import { exec } from "child_process";
import { promisify } from "util";
import type { AgentConfig } from "@opensprint/shared";
import { AgentClient } from "./agent-client.js";
import { createLogger } from "../utils/logger.js";
import { getErrorMessage } from "../utils/error-utils.js";

const execAsync = promisify(exec);
const log = createLogger("scaffold-recovery");

const RECOVERY_TIMEOUT_MS = 120_000;
const VERIFY_TIMEOUT_MS = 15_000;
/**
 * Key-resolution context for pre-project scaffolding flows.
 * Scaffolding runs before a real project record exists, but AgentClient still
 * needs a projectId to resolve CURSOR_API_KEY from global settings (instead of
 * falling back to Cursor keychain/session auth).
 */
const SCAFFOLD_RECOVERY_PROJECT_ID = "__scaffold_recovery__";

export type InitErrorCategory =
  | "missing_node"
  | "missing_npm"
  | "missing_npx"
  | "missing_expo_cli"
  | "permission_denied"
  | "network_error"
  | "unknown";

export interface InitErrorClassification {
  category: InitErrorCategory;
  recoverable: boolean;
  tool?: string;
  summary: string;
  rawError: string;
}

export interface RecoveryResult {
  success: boolean;
  category: InitErrorCategory;
  agentOutput?: string;
  errorMessage?: string;
}

const CATEGORY_PATTERNS: Array<{
  category: InitErrorCategory;
  patterns: RegExp[];
  tool: string;
  recoverable: boolean;
}> = [
  {
    category: "missing_node",
    patterns: [
      /node:\s*command not found/i,
      /node:\s*not found/i,
      /ENOENT.*node/i,
      /'node' is not recognized/i,
    ],
    tool: "node",
    recoverable: true,
  },
  {
    category: "missing_npx",
    patterns: [
      /npx:\s*command not found/i,
      /npx:\s*not found/i,
      /ENOENT.*npx/i,
      /'npx' is not recognized/i,
    ],
    tool: "npx",
    recoverable: true,
  },
  {
    category: "missing_npm",
    patterns: [
      /npm:\s*command not found/i,
      /npm:\s*not found/i,
      /ENOENT.*npm/i,
      /'npm' is not recognized/i,
      /npm ERR! code ENOENT/i,
    ],
    tool: "npm",
    recoverable: true,
  },
  {
    category: "missing_expo_cli",
    patterns: [
      /expo:\s*command not found/i,
      /create-expo-app.*not found/i,
      /Cannot find module.*expo/i,
      /expo is not installed/i,
    ],
    tool: "expo",
    recoverable: true,
  },
  {
    category: "permission_denied",
    patterns: [/EACCES/i, /permission denied/i, /EPERM/i],
    tool: "",
    recoverable: true,
  },
  {
    category: "network_error",
    patterns: [
      /ENOTFOUND/i,
      /ETIMEDOUT/i,
      /ECONNREFUSED/i,
      /network.*error/i,
      /getaddrinfo/i,
      /EAI_AGAIN/i,
    ],
    tool: "",
    recoverable: false,
  },
];

export function classifyInitError(errorOutput: string): InitErrorClassification {
  for (const { category, patterns, tool, recoverable } of CATEGORY_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(errorOutput)) {
        return {
          category,
          recoverable,
          tool: tool || undefined,
          summary: buildSummary(category, tool),
          rawError: errorOutput.slice(0, 2000),
        };
      }
    }
  }
  return {
    category: "unknown",
    recoverable: false,
    summary: "An unexpected error occurred during project initialization",
    rawError: errorOutput.slice(0, 2000),
  };
}

function buildSummary(category: InitErrorCategory, tool: string): string {
  switch (category) {
    case "missing_node":
      return "Node.js is not installed or not in PATH";
    case "missing_npm":
      return "npm is not installed or not in PATH";
    case "missing_npx":
      return "npx is not installed or not in PATH";
    case "missing_expo_cli":
      return "Expo CLI / create-expo-app is not available";
    case "permission_denied":
      return `Permission denied while running ${tool || "command"}`;
    case "network_error":
      return "Network error — check your internet connection";
    default:
      return "An unexpected error occurred during project initialization";
  }
}

function buildRecoveryPrompt(classification: InitErrorClassification, projectPath: string): string {
  const lines = [
    "A project initialization command failed. Please diagnose and fix the issue.",
    "",
    `Error category: ${classification.category}`,
    `Summary: ${classification.summary}`,
    `Project path: ${projectPath}`,
    `Platform: ${process.platform} (${process.arch})`,
    "",
    "Error output:",
    "```",
    classification.rawError,
    "```",
    "",
    "Instructions:",
  ];

  switch (classification.category) {
    case "missing_node":
    case "missing_npm":
    case "missing_npx":
      lines.push(
        "- Install Node.js (which includes npm and npx).",
        "- On macOS: try `brew install node` or download from https://nodejs.org",
        "- On Linux: try `curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs`",
        "- Verify by running: `node --version && npm --version && npx --version`"
      );
      break;
    case "missing_expo_cli":
      lines.push(
        "- Install create-expo-app globally: `npm install -g create-expo-app@latest`",
        "- Or ensure npx is available so it can run create-expo-app on demand.",
        "- Verify by running: `npx create-expo-app --version`"
      );
      break;
    case "permission_denied":
      lines.push(
        "- Fix file permissions for the project directory.",
        `- Try: \`sudo chown -R $(whoami) ${projectPath}\``,
        "- Or adjust npm global prefix: `npm config set prefix ~/.npm-global`"
      );
      break;
    default:
      lines.push(
        "- Analyze the error output and attempt to fix the root cause.",
        "- Run diagnostic commands to understand the issue."
      );
  }

  lines.push(
    "",
    "After fixing, verify the tool is available by running the verification command.",
    "Do NOT run the original scaffolding command — just fix the missing dependency."
  );

  return lines.join("\n");
}

function verifyCommandForCategory(category: InitErrorCategory): string | null {
  switch (category) {
    case "missing_node":
      return "node --version";
    case "missing_npm":
      return "npm --version";
    case "missing_npx":
      return "npx --version";
    case "missing_expo_cli":
      return "npx create-expo-app --version";
    default:
      return null;
  }
}

export async function attemptRecovery(
  classification: InitErrorClassification,
  projectPath: string,
  agentConfig: AgentConfig
): Promise<RecoveryResult> {
  if (!classification.recoverable) {
    return {
      success: false,
      category: classification.category,
      errorMessage: `${classification.summary}. This error requires manual intervention.`,
    };
  }

  log.info("Attempting agent-driven recovery", {
    category: classification.category,
    tool: classification.tool,
    projectPath,
  });

  const prompt = buildRecoveryPrompt(classification, projectPath);
  const client = new AgentClient();

  let agentOutput: string;
  try {
    const response = await client.invoke({
      config: agentConfig,
      prompt,
      systemPrompt:
        "You are a system administrator fixing a development environment issue. Execute commands to resolve the problem. Be concise.",
      cwd: projectPath,
      projectId: SCAFFOLD_RECOVERY_PROJECT_ID,
    });
    agentOutput = response.content;
  } catch (err) {
    const msg = getErrorMessage(err, "Agent invocation failed");
    log.warn("Recovery agent failed to run", { err: msg });
    return {
      success: false,
      category: classification.category,
      errorMessage: `Recovery agent could not run: ${msg}`,
    };
  }

  const verifyCmd = verifyCommandForCategory(classification.category);
  if (verifyCmd) {
    try {
      await execAsync(verifyCmd, { timeout: VERIFY_TIMEOUT_MS });
      log.info("Recovery verification passed", { category: classification.category, verifyCmd });
      return {
        success: true,
        category: classification.category,
        agentOutput,
      };
    } catch (verifyErr) {
      const msg = getErrorMessage(verifyErr);
      log.warn("Recovery verification failed", {
        category: classification.category,
        verifyCmd,
        err: msg,
      });
      return {
        success: false,
        category: classification.category,
        agentOutput,
        errorMessage: `Agent attempted recovery but verification failed: ${classification.summary}. ${msg}`,
      };
    }
  }

  return {
    success: true,
    category: classification.category,
    agentOutput,
  };
}

export { RECOVERY_TIMEOUT_MS };
