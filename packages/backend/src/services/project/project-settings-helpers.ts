import type { CreateProjectRequest, ProjectSettings } from "@opensprint/shared";
import {
  DEFAULT_AI_AUTONOMY_LEVEL,
  DEFAULT_AGENT_CONFIG,
  DEFAULT_DEPLOYMENT_CONFIG,
  DEFAULT_HIL_CONFIG,
  DEFAULT_REVIEW_MODE,
  DEFAULT_TASK_SIZE,
  hilConfigFromAiAutonomyLevel,
  MAX_TOTAL_CONCURRENT_AGENTS_CAP,
  MIN_VALIDATION_TIMEOUT_MS,
  MAX_VALIDATION_TIMEOUT_MS,
  parseSettings,
} from "@opensprint/shared";
import type { AiAutonomyLevel, HilConfig } from "@opensprint/shared";

export const DEFAULT_VALIDATION_TIMEOUT_MS = 300_000;
export const VALIDATION_TIMEOUT_BUFFER_MS = 30_000;
export const VALIDATION_TIMEOUT_MULTIPLIER = 1.8;
export const VALIDATION_TIMING_SAMPLE_LIMIT = 30;

const VALID_AI_AUTONOMY_LEVELS: AiAutonomyLevel[] = ["confirm_all", "major_only", "full"];

/** Resolve aiAutonomyLevel and hilConfig from create/update input. aiAutonomyLevel takes precedence. */
export function resolveAiAutonomyAndHil(input: {
  aiAutonomyLevel?: AiAutonomyLevel;
  hilConfig?: CreateProjectRequest["hilConfig"];
}): { aiAutonomyLevel: AiAutonomyLevel; hilConfig: HilConfig } {
  const level = input.aiAutonomyLevel;
  if (typeof level === "string" && VALID_AI_AUTONOMY_LEVELS.includes(level)) {
    return { aiAutonomyLevel: level, hilConfig: hilConfigFromAiAutonomyLevel(level) };
  }
  const legacy = input.hilConfig;
  if (legacy && typeof legacy === "object") {
    const derived = parseSettings({ hilConfig: legacy });
    return {
      aiAutonomyLevel: derived.aiAutonomyLevel ?? DEFAULT_AI_AUTONOMY_LEVEL,
      hilConfig: derived.hilConfig,
    };
  }
  return {
    aiAutonomyLevel: DEFAULT_AI_AUTONOMY_LEVEL,
    hilConfig: DEFAULT_HIL_CONFIG,
  };
}

/** Normalize path for comparison: trim and remove trailing slashes. */
export function normalizeRepoPath(p: string): string {
  return p.trim().replace(/\/+$/, "") || "";
}

export function extractNpmRunScriptName(command: string): string | null {
  const match = command.trim().match(/^npm\s+run\s+([^\s]+)/i);
  return match?.[1] ?? null;
}

export function clampValidationTimeoutMs(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_VALIDATION_TIMEOUT_MS;
  const rounded = Math.round(raw);
  return Math.min(MAX_VALIDATION_TIMEOUT_MS, Math.max(MIN_VALIDATION_TIMEOUT_MS, rounded));
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return DEFAULT_VALIDATION_TIMEOUT_MS;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx]!;
}

export function normalizeValidationSample(raw: number): number | null {
  if (!Number.isFinite(raw)) return null;
  const rounded = Math.round(raw);
  if (rounded <= 0) return null;
  return Math.min(rounded, MAX_VALIDATION_TIMEOUT_MS);
}

export function isPreferredRepoPathEntry(
  candidate: { updatedAt: string | null; createdAt: string },
  current: { updatedAt: string | null; createdAt: string }
): boolean {
  if (candidate.updatedAt !== null && current.updatedAt === null) {
    return true;
  }
  if (candidate.updatedAt === null && current.updatedAt !== null) {
    return false;
  }

  const candidateSortKey = candidate.updatedAt ?? candidate.createdAt;
  const currentSortKey = current.updatedAt ?? current.createdAt;
  if (candidateSortKey !== currentSortKey) {
    return candidateSortKey > currentSortKey;
  }

  return candidate.createdAt > current.createdAt;
}

/** Build default ProjectSettings for a repo (no user input). Used when adopting or repairing. */
export function buildDefaultSettings(): ProjectSettings {
  return {
    taskSize: DEFAULT_TASK_SIZE,
    simpleComplexityAgent: { ...DEFAULT_AGENT_CONFIG },
    complexComplexityAgent: { ...DEFAULT_AGENT_CONFIG },
    deployment: { ...DEFAULT_DEPLOYMENT_CONFIG },
    aiAutonomyLevel: DEFAULT_AI_AUTONOMY_LEVEL,
    hilConfig: { ...DEFAULT_HIL_CONFIG },
    testFramework: null,
    testCommand: null,
    toolchainProfile: undefined,
    validationTimeoutMsOverride: null,
    reviewMode: DEFAULT_REVIEW_MODE,
    maxConcurrentCoders: 1,
    unknownScopeStrategy: "optimistic",
    gitWorkingMode: "worktree",
    mergeStrategy: "per_task",
    deliveryMode: "direct",
    worktreeBaseBranch: "main",
    enableHumanTeammates: false,
    selfImprovementFrequency: "never",
    autoExecutePlans: false,
    runAgentEnhancementExperiments: false,
    selfImprovementPendingCandidateId: undefined,
    selfImprovementActiveBehaviorVersionId: undefined,
    selfImprovementBehaviorVersions: undefined,
    selfImprovementBehaviorHistory: undefined,
  };
}

/** Build canonical ProjectSettings for persistence. */
export function toCanonicalSettings(s: ProjectSettings): ProjectSettings {
  const aiAutonomyLevel = s.aiAutonomyLevel ?? DEFAULT_AI_AUTONOMY_LEVEL;
  return {
    taskSize: s.taskSize ?? DEFAULT_TASK_SIZE,
    simpleComplexityAgent: s.simpleComplexityAgent,
    complexComplexityAgent: s.complexComplexityAgent,
    deployment: s.deployment,
    aiAutonomyLevel,
    hilConfig: hilConfigFromAiAutonomyLevel(aiAutonomyLevel),
    testFramework: s.testFramework ?? null,
    testCommand: s.testCommand ?? null,
    ...(s.toolchainProfile && { toolchainProfile: s.toolchainProfile }),
    validationTimeoutMsOverride:
      typeof s.validationTimeoutMsOverride === "number"
        ? clampValidationTimeoutMs(s.validationTimeoutMsOverride)
        : null,
    ...(s.validationTimingProfile && {
      validationTimingProfile: {
        ...(Array.isArray(s.validationTimingProfile.scoped) &&
          s.validationTimingProfile.scoped.length > 0 && {
            scoped: s.validationTimingProfile.scoped
              .map((sample) => normalizeValidationSample(sample))
              .filter((sample): sample is number => sample !== null)
              .slice(-VALIDATION_TIMING_SAMPLE_LIMIT),
          }),
        ...(Array.isArray(s.validationTimingProfile.full) &&
          s.validationTimingProfile.full.length > 0 && {
            full: s.validationTimingProfile.full
              .map((sample) => normalizeValidationSample(sample))
              .filter((sample): sample is number => sample !== null)
              .slice(-VALIDATION_TIMING_SAMPLE_LIMIT),
          }),
        ...(s.validationTimingProfile.updatedAt && {
          updatedAt: s.validationTimingProfile.updatedAt,
        }),
      },
    }),
    reviewMode: s.reviewMode ?? DEFAULT_REVIEW_MODE,
    ...(s.reviewAngles && s.reviewAngles.length > 0 && { reviewAngles: s.reviewAngles }),
    ...(s.includeGeneralReview === true && { includeGeneralReview: true }),
    maxConcurrentCoders: s.maxConcurrentCoders ?? 1,
    ...(typeof s.maxTotalConcurrentAgents === "number" &&
      Number.isFinite(s.maxTotalConcurrentAgents) &&
      s.maxTotalConcurrentAgents >= 1 && {
        maxTotalConcurrentAgents: Math.min(
          MAX_TOTAL_CONCURRENT_AGENTS_CAP,
          Math.max(1, Math.round(s.maxTotalConcurrentAgents))
        ),
      }),
    unknownScopeStrategy: s.unknownScopeStrategy ?? "optimistic",
    gitWorkingMode: s.gitWorkingMode ?? "worktree",
    mergeStrategy: s.mergeStrategy ?? "per_task",
    deliveryMode: s.deliveryMode ?? "direct",
    worktreeBaseBranch: s.worktreeBaseBranch ?? "main",
    enableHumanTeammates: s.enableHumanTeammates === true,
    ...(s.teamMembers && s.teamMembers.length > 0 && { teamMembers: s.teamMembers }),
    selfImprovementFrequency: s.selfImprovementFrequency ?? "never",
    ...(s.selfImprovementLastRunAt !== undefined && {
      selfImprovementLastRunAt: s.selfImprovementLastRunAt,
    }),
    ...(s.selfImprovementLastCommitSha !== undefined && {
      selfImprovementLastCommitSha: s.selfImprovementLastCommitSha,
    }),
    autoExecutePlans: s.autoExecutePlans === true,
    runAgentEnhancementExperiments: s.runAgentEnhancementExperiments === true,
    ...(s.selfImprovementReviewerAgents &&
      s.selfImprovementReviewerAgents.length > 0 && {
        selfImprovementReviewerAgents: s.selfImprovementReviewerAgents,
      }),
    ...(s.selfImprovementIncludeGeneralReview === true && {
      selfImprovementIncludeGeneralReview: true,
    }),
    ...(s.selfImprovementPendingCandidateId && {
      selfImprovementPendingCandidateId: s.selfImprovementPendingCandidateId,
    }),
    ...(s.selfImprovementActiveBehaviorVersionId && {
      selfImprovementActiveBehaviorVersionId: s.selfImprovementActiveBehaviorVersionId,
    }),
    ...(Array.isArray(s.selfImprovementBehaviorVersions) &&
      s.selfImprovementBehaviorVersions.length > 0 && {
        selfImprovementBehaviorVersions: s.selfImprovementBehaviorVersions
          .filter((v) => v?.id && v?.promotedAt)
          .map((v) => ({ id: v.id, promotedAt: v.promotedAt })),
      }),
    ...(Array.isArray(s.selfImprovementBehaviorHistory) &&
      s.selfImprovementBehaviorHistory.length > 0 && {
        selfImprovementBehaviorHistory: s.selfImprovementBehaviorHistory
          .filter((h) => h?.timestamp && h?.action)
          .map((h) => ({
            timestamp: h.timestamp,
            action: h.action,
            ...(h.behaviorVersionId && { behaviorVersionId: h.behaviorVersionId }),
            ...(h.candidateId && { candidateId: h.candidateId }),
          })),
      }),
  };
}

export { VALID_AI_AUTONOMY_LEVELS };
