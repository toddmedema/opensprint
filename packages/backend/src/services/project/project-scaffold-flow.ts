import { agentProcessEnvironment } from "../../utils/agent-process-env.js";
import fs from "fs/promises";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import type {
  CreateProjectRequest,
  ScaffoldProjectRequest,
  ScaffoldProjectResponse,
  ScaffoldRecoveryInfo,
} from "@opensprint/shared";
import {
  DEFAULT_AI_AUTONOMY_LEVEL,
  DEFAULT_DEPLOYMENT_CONFIG,
  DEFAULT_AGENT_CONFIG,
} from "@opensprint/shared";
import { AppError } from "../../middleware/error-handler.js";
import { ErrorCodes } from "../../middleware/error-codes.js";
import type { AgentConfigInput } from "../../schemas/agent-config.js";
import { getErrorMessage } from "../../utils/error-utils.js";
import { createLogger } from "../../utils/logger.js";
import { assertSupportedRepoPath } from "../../utils/repo-path-policy.js";
import {
  ensureExpoReactTypeDevDependencies,
  ensureExpoLintMergeGateTooling,
} from "../../utils/scaffold-expo-deps.js";
import { getMergeQualityGateCommands } from "../merge-quality-gates.js";
import {
  checkScaffoldPrerequisites,
  runScaffoldCommandWithRecovery,
} from "./project-scaffold-recovery.js";
import { extractNpmRunScriptName } from "./project-settings-helpers.js";

const execAsync = promisify(exec);
const log = createLogger("project-scaffold");

export type ScaffoldProjectFlowDeps = {
  createProject: (input: CreateProjectRequest) => Promise<ScaffoldProjectResponse["project"]>;
};

export async function runScaffoldProjectFlow(
  deps: ScaffoldProjectFlowDeps,
  input: ScaffoldProjectRequest
): Promise<ScaffoldProjectResponse> {
  const name = (input.name ?? "").trim();
  const parentPath = (input.parentPath ?? "").trim();
  const template = input.template;

  if (!name) {
    throw new AppError(400, ErrorCodes.INVALID_INPUT, "Project name is required");
  }
  if (!parentPath) {
    throw new AppError(400, ErrorCodes.INVALID_INPUT, "Project folder (parentPath) is required");
  }
  if (template !== "web-app-expo-react" && template !== "empty") {
    throw new AppError(
      400,
      ErrorCodes.INVALID_INPUT,
      `Unsupported template: ${template}. Supported templates: "web-app-expo-react", "empty".`
    );
  }

  const repoPath = path.resolve(parentPath);
  assertSupportedRepoPath(repoPath);

  if (template === "empty") {
    await fs.mkdir(repoPath, { recursive: true });

    const createRequest: CreateProjectRequest = {
      name,
      repoPath,
      ...(input.simpleComplexityAgent !== undefined && {
        simpleComplexityAgent: input.simpleComplexityAgent as AgentConfigInput,
      }),
      ...(input.complexComplexityAgent !== undefined && {
        complexComplexityAgent: input.complexComplexityAgent as AgentConfigInput,
      }),
      deployment: DEFAULT_DEPLOYMENT_CONFIG,
      aiAutonomyLevel: DEFAULT_AI_AUTONOMY_LEVEL,
      gitWorkingMode: "worktree",
      maxConcurrentCoders: 1,
      testFramework: null,
    };

    const project = await deps.createProject(createRequest);
    return { project };
  }

  const prereq = await checkScaffoldPrerequisites();
  if (prereq.missing.length > 0) {
    const list = prereq.missing.join(", ");
    const msg =
      prereq.missing.length === 1
        ? `${list} is not installed or not available in PATH. ` +
          (prereq.missing[0] === "Git"
            ? "Install Git from https://git-scm.com/ and ensure it is in your PATH, then try again."
            : "Install Node.js from https://nodejs.org/ and ensure it is in your PATH, then try again.")
        : `${list} are not installed or not available in PATH. ` +
          "Install Git from https://git-scm.com/ and Node.js from https://nodejs.org/, ensure both are in your PATH, then try again.";
    throw new AppError(400, ErrorCodes.SCAFFOLD_PREREQUISITES_MISSING, msg, {
      missing: prereq.missing,
    });
  }

  const agentConfig = (input.simpleComplexityAgent ?? DEFAULT_AGENT_CONFIG) as AgentConfigInput & {
    type:
      | "cursor"
      | "claude"
      | "claude-cli"
      | "codex"
      | "custom"
      | "openai"
      | "google"
      | "lmstudio"
      | "ollama";
  };
  let recovery: ScaffoldRecoveryInfo | undefined;

  if (template === "web-app-expo-react") {
    await fs.mkdir(repoPath, { recursive: true });

    const scaffoldResult = await runScaffoldCommandWithRecovery(
      "npx create-expo-app@latest . --template blank --yes",
      repoPath,
      agentConfig,
      "Failed to scaffold Expo app"
    );
    if (scaffoldResult.recovery) {
      recovery = scaffoldResult.recovery;
    }
    if (!scaffoldResult.success) {
      throw new AppError(500, ErrorCodes.SCAFFOLD_INIT_FAILED, scaffoldResult.errorMessage!, {
        repoPath,
        recovery,
      });
    }

    const installResult = await runScaffoldCommandWithRecovery(
      "npm install --include=dev",
      repoPath,
      agentConfig,
      "Failed to run npm install"
    );
    if (!recovery && installResult.recovery) {
      recovery = installResult.recovery;
    }
    if (!installResult.success) {
      throw new AppError(500, ErrorCodes.SCAFFOLD_INIT_FAILED, installResult.errorMessage!, {
        repoPath,
        recovery: installResult.recovery ?? recovery,
      });
    }

    try {
      await execAsync("npx expo install react-dom react-native-web", {
        env: agentProcessEnvironment(),
        cwd: repoPath,
      });
    } catch (expoInstallErr) {
      const msg = getErrorMessage(
        expoInstallErr,
        "Failed to install Expo web dependencies (react-dom, react-native-web)"
      );
      throw new AppError(
        500,
        ErrorCodes.SCAFFOLD_INIT_FAILED,
        `Expo web dependencies could not be installed: ${msg}. Ensure Expo CLI is available and try again.`,
        { repoPath, recovery }
      );
    }

    const tsResult = await runScaffoldCommandWithRecovery(
      "npx expo install typescript @types/react @types/react-dom",
      repoPath,
      agentConfig,
      "Failed to install TypeScript and React type definitions"
    );
    if (!recovery && tsResult.recovery) {
      recovery = tsResult.recovery;
    }
    if (!tsResult.success) {
      throw new AppError(500, ErrorCodes.SCAFFOLD_INIT_FAILED, tsResult.errorMessage!, {
        repoPath,
        recovery: tsResult.recovery ?? recovery,
      });
    }

    try {
      await ensureExpoReactTypeDevDependencies(repoPath);
    } catch (ensureErr) {
      const msg = getErrorMessage(
        ensureErr,
        "Could not ensure @types/react and @types/react-dom are installed"
      );
      throw new AppError(500, ErrorCodes.SCAFFOLD_INIT_FAILED, msg, {
        repoPath,
        recovery,
      });
    }

    try {
      await ensureExpoLintMergeGateTooling(repoPath);
    } catch (lintSetupErr) {
      const msg = getErrorMessage(
        lintSetupErr,
        "Could not install ESLint tooling for merge quality gates (eslint / eslint-config-expo)"
      );
      throw new AppError(500, ErrorCodes.SCAFFOLD_INIT_FAILED, msg, {
        repoPath,
        recovery,
      });
    }

    const lintAfterScaffold = await runScaffoldCommandWithRecovery(
      "npm run lint",
      repoPath,
      agentConfig,
      "npm run lint failed after scaffold (check ESLint config and dependencies)"
    );
    if (!recovery && lintAfterScaffold.recovery) {
      recovery = lintAfterScaffold.recovery;
    }
    if (!lintAfterScaffold.success) {
      throw new AppError(500, ErrorCodes.SCAFFOLD_INIT_FAILED, lintAfterScaffold.errorMessage!, {
        repoPath,
        recovery: lintAfterScaffold.recovery ?? recovery,
      });
    }

    const tsconfigPath = path.join(repoPath, "tsconfig.json");
    try {
      await fs.access(tsconfigPath);
      const typecheckResult = await runScaffoldCommandWithRecovery(
        "npx tsc --noEmit",
        repoPath,
        agentConfig,
        "TypeScript check failed after scaffold (fix missing typings or tsconfig)"
      );
      if (!recovery && typecheckResult.recovery) {
        recovery = typecheckResult.recovery;
      }
      if (!typecheckResult.success) {
        throw new AppError(500, ErrorCodes.SCAFFOLD_INIT_FAILED, typecheckResult.errorMessage!, {
          repoPath,
          recovery: typecheckResult.recovery ?? recovery,
        });
      }
    } catch (accessErr) {
      if (accessErr instanceof AppError) {
        throw accessErr;
      }
    }

    let packageScripts = new Set<string>();
    try {
      const packageJsonRaw = await fs.readFile(path.join(repoPath, "package.json"), "utf-8");
      const packageJson = JSON.parse(packageJsonRaw) as {
        scripts?: Record<string, unknown>;
      } | null;
      if (packageJson?.scripts && typeof packageJson.scripts === "object") {
        packageScripts = new Set(Object.keys(packageJson.scripts));
      }
    } catch {
      // If package.json cannot be read here, gate command execution below will fail with context.
    }
    for (const gateCommand of getMergeQualityGateCommands()) {
      const scriptName = extractNpmRunScriptName(gateCommand);
      if (scriptName && !packageScripts.has(scriptName)) {
        log.info("Skipping scaffold merge-gate command; npm script is not defined", {
          repoPath,
          command: gateCommand,
        });
        continue;
      }
      const gateResult = await runScaffoldCommandWithRecovery(
        gateCommand,
        repoPath,
        agentConfig,
        `Scaffold merge quality gate failed (${gateCommand})`
      );
      if (!recovery && gateResult.recovery) {
        recovery = gateResult.recovery;
      }
      if (!gateResult.success) {
        throw new AppError(500, ErrorCodes.SCAFFOLD_INIT_FAILED, gateResult.errorMessage!, {
          repoPath,
          recovery: gateResult.recovery ?? recovery,
        });
      }
    }
  }

  const simpleInput = input.simpleComplexityAgent ?? DEFAULT_AGENT_CONFIG;
  const complexInput = input.complexComplexityAgent ?? DEFAULT_AGENT_CONFIG;
  const createRequest: CreateProjectRequest = {
    name,
    repoPath,
    simpleComplexityAgent: simpleInput as AgentConfigInput,
    complexComplexityAgent: complexInput as AgentConfigInput,
    deployment: DEFAULT_DEPLOYMENT_CONFIG,
    aiAutonomyLevel: DEFAULT_AI_AUTONOMY_LEVEL,
    gitWorkingMode: "worktree",
    maxConcurrentCoders: 1,
    testFramework: null,
  };

  const project = await deps.createProject(createRequest);

  return { project, ...(recovery && { recovery }) };
}
