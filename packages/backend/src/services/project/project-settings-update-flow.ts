import type { ApiKeyProvider, ProjectSettings, ProjectSettingsApiUpdate } from "@opensprint/shared";
import {
  DEFAULT_AI_AUTONOMY_LEVEL,
  getProvidersRequiringApiKeys,
  hilConfigFromAiAutonomyLevel,
  MAX_TOTAL_CONCURRENT_AGENTS_CAP,
  mergeDeploymentConfigPatch,
  MIN_VALIDATION_TIMEOUT_MS,
  MAX_VALIDATION_TIMEOUT_MS,
  omitInheritedAgentTiersForStore,
  parseTeamMembers,
  VALID_MERGE_STRATEGIES,
  VALID_SELF_IMPROVEMENT_FREQUENCIES,
} from "@opensprint/shared";
import type { SelfImprovementFrequency } from "@opensprint/shared";
import { AppError } from "../../middleware/error-handler.js";
import { ErrorCodes } from "../../middleware/error-codes.js";
import { parseAgentConfig } from "../../schemas/agent-config.js";
import { getErrorMessage } from "../../utils/error-utils.js";
import { getGlobalSettings } from "../global-settings.service.js";
import { transformRawSettingsInStore } from "../settings-store.service.js";
import { projectGitRuntimeCache } from "../project-git-runtime-cache.js";
import { projectSettingsFromRaw } from "./project-settings-from-raw.js";
import {
  clampValidationTimeoutMs,
  toCanonicalSettings,
  VALID_AI_AUTONOMY_LEVELS,
} from "./project-settings-helpers.js";

export type UpdateSettingsFlowDeps = {
  getRepoPath: (projectId: string) => Promise<string>;
  getSettingsWithRuntimeState: (projectId: string) => Promise<ProjectSettings>;
};

export async function runUpdateSettingsFlow(
  deps: UpdateSettingsFlowDeps,
  projectId: string,
  updates: ProjectSettingsApiUpdate
): Promise<ProjectSettings> {
  await deps.getRepoPath(projectId);
  const gs = await getGlobalSettings();
  let baseBranchChanged = false;
  await transformRawSettingsInStore(projectId, (diskRaw) => {
    const workingRaw: Record<string, unknown> = { ...diskRaw };

    const {
      selfImprovementLastRunAt: _stripLastRunAt,
      selfImprovementLastCommitSha: _stripLastSha,
      nextRunAt: _stripNextRunAt,
      validationTimingProfile: _stripValidationTimingProfile,
      maxTotalConcurrentAgents: maxTotalConcurrentAgentsUpdate,
      ...sanitizedUpdates
    } = updates as Partial<ProjectSettings> & {
      selfImprovementLastRunAt?: unknown;
      selfImprovementLastCommitSha?: unknown;
      nextRunAt?: unknown;
      validationTimingProfile?: unknown;
    };

    const bodyLegacy = sanitizedUpdates as Partial<ProjectSettings> & {
      lowComplexityAgent?: unknown;
      highComplexityAgent?: unknown;
    };
    const simpleUpdate = Object.prototype.hasOwnProperty.call(
      sanitizedUpdates,
      "simpleComplexityAgent"
    )
      ? sanitizedUpdates.simpleComplexityAgent
      : Object.prototype.hasOwnProperty.call(bodyLegacy, "lowComplexityAgent")
        ? bodyLegacy.lowComplexityAgent
        : undefined;
    const complexUpdate = Object.prototype.hasOwnProperty.call(
      sanitizedUpdates,
      "complexComplexityAgent"
    )
      ? sanitizedUpdates.complexComplexityAgent
      : Object.prototype.hasOwnProperty.call(bodyLegacy, "highComplexityAgent")
        ? bodyLegacy.highComplexityAgent
        : undefined;

    if (simpleUpdate === null) {
      delete workingRaw.simpleComplexityAgent;
      delete workingRaw.lowComplexityAgent;
    } else if (simpleUpdate !== undefined) {
      try {
        workingRaw.simpleComplexityAgent = parseAgentConfig(simpleUpdate, "simpleComplexityAgent");
        delete workingRaw.lowComplexityAgent;
      } catch (err) {
        const msg = getErrorMessage(err, "Invalid simple complexity agent configuration");
        throw new AppError(400, ErrorCodes.INVALID_AGENT_CONFIG, msg);
      }
    }

    if (complexUpdate === null) {
      delete workingRaw.complexComplexityAgent;
      delete workingRaw.highComplexityAgent;
    } else if (complexUpdate !== undefined) {
      try {
        workingRaw.complexComplexityAgent = parseAgentConfig(
          complexUpdate,
          "complexComplexityAgent"
        );
        delete workingRaw.highComplexityAgent;
      } catch (err) {
        const msg = getErrorMessage(err, "Invalid complex complexity agent configuration");
        throw new AppError(400, ErrorCodes.INVALID_AGENT_CONFIG, msg);
      }
    }

    const current = projectSettingsFromRaw(workingRaw, gs);
    const simpleComplexityAgent = current.simpleComplexityAgent;
    const complexComplexityAgent = current.complexComplexityAgent;

    const agentConfigChanged = simpleUpdate !== undefined || complexUpdate !== undefined;
    const requiredProviders = agentConfigChanged
      ? getProvidersRequiringApiKeys([simpleComplexityAgent, complexComplexityAgent])
      : [];
    if (requiredProviders.length > 0) {
      const missing: ApiKeyProvider[] = [];
      for (const provider of requiredProviders) {
        const entries = gs.apiKeys?.[provider];
        if (!Array.isArray(entries) || entries.length === 0) {
          missing.push(provider);
        }
      }
      if (missing.length > 0) {
        throw new AppError(400, ErrorCodes.INVALID_AGENT_CONFIG, "Configure API keys in Settings.");
      }
    }

    const aiAutonomyLevel =
      typeof sanitizedUpdates.aiAutonomyLevel === "string" &&
      VALID_AI_AUTONOMY_LEVELS.includes(sanitizedUpdates.aiAutonomyLevel)
        ? sanitizedUpdates.aiAutonomyLevel
        : (current.aiAutonomyLevel ?? DEFAULT_AI_AUTONOMY_LEVEL);
    const hilConfig = hilConfigFromAiAutonomyLevel(aiAutonomyLevel);
    const gitWorkingMode =
      sanitizedUpdates.gitWorkingMode === "worktree" ||
      sanitizedUpdates.gitWorkingMode === "branches"
        ? sanitizedUpdates.gitWorkingMode
        : (current.gitWorkingMode ?? "worktree");
    const teamMembers =
      sanitizedUpdates.teamMembers !== undefined
        ? parseTeamMembers(sanitizedUpdates.teamMembers)
        : current.teamMembers;
    if (
      sanitizedUpdates.mergeStrategy !== undefined &&
      (typeof sanitizedUpdates.mergeStrategy !== "string" ||
        !VALID_MERGE_STRATEGIES.includes(sanitizedUpdates.mergeStrategy as "per_task" | "per_epic"))
    ) {
      throw new AppError(
        400,
        ErrorCodes.INVALID_INPUT,
        "Merge strategy must be “Per task” (merge to main after each task) or “Per epic” (merge to main when the whole epic is done)."
      );
    }
    const mergeStrategy =
      sanitizedUpdates.mergeStrategy !== undefined &&
      VALID_MERGE_STRATEGIES.includes(sanitizedUpdates.mergeStrategy as "per_task" | "per_epic")
        ? (sanitizedUpdates.mergeStrategy as "per_task" | "per_epic")
        : (current.mergeStrategy ?? "per_task");
    if (
      sanitizedUpdates.selfImprovementFrequency !== undefined &&
      (typeof sanitizedUpdates.selfImprovementFrequency !== "string" ||
        !VALID_SELF_IMPROVEMENT_FREQUENCIES.includes(
          sanitizedUpdates.selfImprovementFrequency as SelfImprovementFrequency
        ))
    ) {
      throw new AppError(
        400,
        ErrorCodes.INVALID_INPUT,
        "selfImprovementFrequency must be one of: never, after_each_plan, daily, weekly"
      );
    }
    const selfImprovementFrequency =
      sanitizedUpdates.selfImprovementFrequency !== undefined &&
      VALID_SELF_IMPROVEMENT_FREQUENCIES.includes(
        sanitizedUpdates.selfImprovementFrequency as SelfImprovementFrequency
      )
        ? (sanitizedUpdates.selfImprovementFrequency as SelfImprovementFrequency)
        : (current.selfImprovementFrequency ?? "never");
    const autoExecutePlans =
      sanitizedUpdates.autoExecutePlans !== undefined
        ? sanitizedUpdates.autoExecutePlans === true
        : (current.autoExecutePlans ?? false);
    if (
      sanitizedUpdates.runAgentEnhancementExperiments !== undefined &&
      typeof sanitizedUpdates.runAgentEnhancementExperiments !== "boolean"
    ) {
      throw new AppError(
        400,
        ErrorCodes.INVALID_INPUT,
        "runAgentEnhancementExperiments must be a boolean"
      );
    }
    const runAgentEnhancementExperiments =
      sanitizedUpdates.runAgentEnhancementExperiments !== undefined
        ? sanitizedUpdates.runAgentEnhancementExperiments === true
        : (current.runAgentEnhancementExperiments ?? false);
    if (
      sanitizedUpdates.validationTimeoutMsOverride !== undefined &&
      sanitizedUpdates.validationTimeoutMsOverride !== null &&
      (typeof sanitizedUpdates.validationTimeoutMsOverride !== "number" ||
        !Number.isFinite(sanitizedUpdates.validationTimeoutMsOverride))
    ) {
      throw new AppError(
        400,
        ErrorCodes.INVALID_INPUT,
        "validationTimeoutMsOverride must be a number (milliseconds) or null"
      );
    }
    if (
      typeof sanitizedUpdates.validationTimeoutMsOverride === "number" &&
      (sanitizedUpdates.validationTimeoutMsOverride < MIN_VALIDATION_TIMEOUT_MS ||
        sanitizedUpdates.validationTimeoutMsOverride > MAX_VALIDATION_TIMEOUT_MS)
    ) {
      throw new AppError(
        400,
        ErrorCodes.INVALID_INPUT,
        `validationTimeoutMsOverride must be between ${MIN_VALIDATION_TIMEOUT_MS} and ${MAX_VALIDATION_TIMEOUT_MS} milliseconds`
      );
    }
    const validationTimeoutMsOverride =
      sanitizedUpdates.validationTimeoutMsOverride === undefined
        ? (current.validationTimeoutMsOverride ?? null)
        : sanitizedUpdates.validationTimeoutMsOverride === null
          ? null
          : clampValidationTimeoutMs(sanitizedUpdates.validationTimeoutMsOverride);

    let maxTotalConcurrentAgents = current.maxTotalConcurrentAgents;
    if (maxTotalConcurrentAgentsUpdate !== undefined) {
      if (maxTotalConcurrentAgentsUpdate === null) {
        maxTotalConcurrentAgents = undefined;
      } else if (
        typeof maxTotalConcurrentAgentsUpdate === "number" &&
        Number.isFinite(maxTotalConcurrentAgentsUpdate) &&
        maxTotalConcurrentAgentsUpdate >= 1
      ) {
        maxTotalConcurrentAgents = Math.min(
          MAX_TOTAL_CONCURRENT_AGENTS_CAP,
          Math.max(1, Math.round(maxTotalConcurrentAgentsUpdate))
        );
      } else {
        throw new AppError(
          400,
          ErrorCodes.INVALID_INPUT,
          `maxTotalConcurrentAgents must be a number from 1 to ${MAX_TOTAL_CONCURRENT_AGENTS_CAP}, or null to clear`
        );
      }
    }

    const { deployment: deploymentPatch, ...sanitizedWithoutDeployment } = sanitizedUpdates;
    const mergedDeployment =
      deploymentPatch !== undefined
        ? mergeDeploymentConfigPatch(current.deployment, deploymentPatch)
        : current.deployment;

    const effectiveSettings: ProjectSettings = {
      ...current,
      ...sanitizedWithoutDeployment,
      simpleComplexityAgent,
      complexComplexityAgent,
      aiAutonomyLevel,
      hilConfig,
      gitWorkingMode,
      teamMembers,
      mergeStrategy,
      selfImprovementFrequency,
      autoExecutePlans,
      runAgentEnhancementExperiments,
      validationTimeoutMsOverride,
      maxTotalConcurrentAgents,
      deployment: mergedDeployment,
    };
    const updated: ProjectSettings = {
      ...effectiveSettings,
      ...(gitWorkingMode === "branches" && { maxConcurrentCoders: 1 }),
    };
    const {
      simpleComplexityAgentInherited: _stripSimpleInherited,
      complexComplexityAgentInherited: _stripComplexInherited,
      ...settingsForCanonical
    } = updated;
    const canonical = toCanonicalSettings(settingsForCanonical);
    const toPersist = omitInheritedAgentTiersForStore(
      canonical as unknown as Record<string, unknown>,
      workingRaw
    ) as unknown as ProjectSettings;
    baseBranchChanged =
      (toPersist.worktreeBaseBranch ?? "main") !== (current.worktreeBaseBranch ?? "main");
    return toPersist as unknown as Record<string, unknown>;
  });
  if (baseBranchChanged) {
    projectGitRuntimeCache.invalidate(projectId);
  }
  return deps.getSettingsWithRuntimeState(projectId);
}
