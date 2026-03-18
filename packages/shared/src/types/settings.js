/** Resolve the default target name from targets array (first isDefault, or first entry, or config.target). */
export function getDefaultDeploymentTarget(config) {
  const targets = config.targets;
  if (targets && targets.length > 0) {
    const def = targets.find((t) => t.isDefault) ?? targets[0];
    return def.name;
  }
  return config.target ?? "production";
}
/** Resolve target config by name. Returns undefined if not found. */
export function getDeploymentTargetConfig(config, targetName) {
  return config.targets?.find((t) => t.name === targetName);
}
/**
 * Get target names that should be deployed for a given event.
 * Returns targets whose autoDeployTrigger matches the event.
 */
export function getTargetsForDeployEvent(config, event) {
  const targets = config.targets;
  if (!targets || targets.length === 0) return [];
  return targets.filter((t) => (t.autoDeployTrigger ?? "none") === event).map((t) => t.name);
}
/**
 * Get target names that should be deployed on nightly schedule.
 * Returns targets whose autoDeployTrigger is "nightly".
 */
export function getTargetsForNightlyDeploy(config) {
  const targets = config.targets;
  if (!targets || targets.length === 0) return [];
  return targets.filter((t) => (t.autoDeployTrigger ?? "none") === "nightly").map((t) => t.name);
}
/** Auto-deploy trigger options for UI dropdown */
export const AUTO_DEPLOY_TRIGGER_OPTIONS = [
  { value: "each_task", label: "Each task" },
  { value: "each_epic", label: "Each feature plan/epic" },
  { value: "eval_resolution", label: "Evaluate resolution" },
  { value: "nightly", label: "Nightly" },
  { value: "none", label: "None" },
];
/**
 * Get targets to display in the deployment UI.
 * Expo mode with empty targets: returns synthetic staging and production.
 * Custom mode: returns targets array (may be empty).
 */
export function getDeploymentTargetsForUi(config) {
  const targets = config.targets;
  if (config.mode === "expo" && (!targets || targets.length === 0)) {
    return [
      { name: "staging", autoDeployTrigger: "none" },
      { name: "production", autoDeployTrigger: "none" },
    ];
  }
  return targets ?? [];
}
/** Default deployment configuration (PRD ?6.4, ?7.5.3) */
export const DEFAULT_DEPLOYMENT_CONFIG = {
  mode: "custom",
  autoResolveFeedbackOnTaskCompletion: false,
};
/**
 * Migrate legacy autoDeployOnEpicCompletion/autoDeployOnEvalResolution to per-target autoDeployTrigger.
 * Applies migrated trigger to the default target. Strips legacy flags from output.
 */
function migrateDeploymentConfig(raw) {
  const input = raw ?? DEFAULT_DEPLOYMENT_CONFIG;
  const mode = input.mode ?? "custom";
  // Legacy migration: expoConfig.projectId → easProjectId when mode is expo
  const easProjectId =
    input.easProjectId ??
    (mode === "expo" && input.expoConfig?.projectId ? input.expoConfig.projectId : undefined);
  const base = {
    ...DEFAULT_DEPLOYMENT_CONFIG,
    mode,
    easProjectId,
    target: input.target,
    targets: input.targets,
    envVars: input.envVars,
    autoResolveFeedbackOnTaskCompletion: input.autoResolveFeedbackOnTaskCompletion,
    expoConfig: input.expoConfig,
    customCommand: input.customCommand,
    webhookUrl: input.webhookUrl,
    rollbackCommand: input.rollbackCommand,
    nightlyDeployTime: input.nightlyDeployTime,
  };
  // Migrate top-level envVars to per-target: merge into default target, or create staging/production for Expo
  if (input.envVars && Object.keys(input.envVars).length > 0) {
    const existingTargets = base.targets ?? [];
    if (existingTargets.length > 0) {
      const defaultIdx =
        existingTargets.findIndex((t) => t.isDefault) >= 0
          ? existingTargets.findIndex((t) => t.isDefault)
          : 0;
      const migratedTargets = existingTargets.map((t, i) =>
        i === defaultIdx ? { ...t, envVars: { ...t.envVars, ...input.envVars } } : t
      );
      base.targets = migratedTargets;
    } else {
      base.targets = [
        { name: "staging", envVars: { ...input.envVars } },
        { name: "production", envVars: { ...input.envVars } },
      ];
    }
  }
  const epic = input.autoDeployOnEpicCompletion === true;
  const evalRes = input.autoDeployOnEvalResolution === true;
  if (!epic && !evalRes) return base;
  const resolvedTrigger = epic ? "each_epic" : "eval_resolution";
  const defaultTargetName = getDefaultDeploymentTarget(base);
  const existingTargets = base.targets ?? [];
  const targetIndex = existingTargets.findIndex((t) => t.name === defaultTargetName);
  const migratedTargets = [...existingTargets];
  if (targetIndex >= 0) {
    migratedTargets[targetIndex] = {
      ...migratedTargets[targetIndex],
      autoDeployTrigger: resolvedTrigger,
    };
  } else {
    migratedTargets.push({ name: defaultTargetName, autoDeployTrigger: resolvedTrigger });
  }
  return { ...base, targets: migratedTargets };
}
/** Labels for AI Autonomy slider (left to right) */
export const AI_AUTONOMY_LEVELS = [
  { value: "confirm_all", label: "Confirm all scope changes" },
  { value: "major_only", label: "Major scope changes only" },
  { value: "full", label: "Full autonomy" },
];
/** Default AI autonomy level for new projects */
export const DEFAULT_AI_AUTONOMY_LEVEL = "full";
/**
 * Derive HilConfig from AiAutonomyLevel for HIL service and agents.
 * - confirm_all: all categories require approval
 * - major_only: scopeChanges + architectureDecisions require approval; dependencyModifications automated
 * - full: all automated
 */
export function hilConfigFromAiAutonomyLevel(level) {
  switch (level) {
    case "confirm_all":
      return {
        scopeChanges: "requires_approval",
        architectureDecisions: "requires_approval",
        dependencyModifications: "requires_approval",
      };
    case "major_only":
      return {
        scopeChanges: "requires_approval",
        architectureDecisions: "requires_approval",
        dependencyModifications: "automated",
      };
    case "full":
    default:
      return {
        scopeChanges: "automated",
        architectureDecisions: "automated",
        dependencyModifications: "automated",
      };
  }
}
/**
 * Derive AiAutonomyLevel from legacy HilConfig (migration).
 */
export function aiAutonomyLevelFromHilConfig(hilConfig) {
  const { scopeChanges, architectureDecisions, dependencyModifications } = hilConfig;
  const allRequireApproval =
    scopeChanges === "requires_approval" &&
    architectureDecisions === "requires_approval" &&
    dependencyModifications === "requires_approval";
  if (allRequireApproval) return "confirm_all";
  const majorRequireApproval =
    scopeChanges === "requires_approval" &&
    architectureDecisions === "requires_approval" &&
    dependencyModifications === "automated";
  if (majorRequireApproval) return "major_only";
  return "full";
}
/** Default review mode for new projects (PRD ?7.3.2: two-agent cycle is recommended) */
export const DEFAULT_REVIEW_MODE = "always";
/** Review angle options for multi-select UI */
export const REVIEW_ANGLE_OPTIONS = [
  { value: "security", label: "Security implications" },
  { value: "performance", label: "Performance impact" },
  { value: "test_coverage", label: "Validating test coverage" },
  { value: "code_quality", label: "Code quality, cleanliness and modularity" },
  { value: "design_ux_accessibility", label: "Design, UX and accessibility" },
];
/** UI-only option for general review (scope + code quality). When selected alone, reviewAngles is empty. */
export const GENERAL_REVIEW_OPTION = "general";
/** All review agent options for UI: General first (checked by default), then angle-specific options. */
export const REVIEW_AGENT_OPTIONS = [
  { value: GENERAL_REVIEW_OPTION, label: "General" },
  ...REVIEW_ANGLE_OPTIONS,
];
/** Valid merge strategy values for parsing/validation */
export const VALID_MERGE_STRATEGIES = ["per_task", "per_epic"];
/** Valid self-improvement frequency values for parsing/validation */
export const VALID_SELF_IMPROVEMENT_FREQUENCIES = ["never", "after_each_plan", "daily", "weekly"];
/** Bounds for project-level validation timeout override and adaptive timeout values. */
export const MIN_VALIDATION_TIMEOUT_MS = 60_000;
export const MAX_VALIDATION_TIMEOUT_MS = 3_600_000;
/** Self-improvement frequency options for UI dropdown */
export const SELF_IMPROVEMENT_FREQUENCY_OPTIONS = [
  { value: "never", label: "Never" },
  { value: "after_each_plan", label: "After each Plan" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];
/**
 * Default database path relative to ~/.opensprint (used by scripts that cannot import shared).
 * Full default URL is built in backend via getDefaultDatabaseUrl() (Node only).
 */
export const DEFAULT_DATABASE_PATH_RELATIVE = "data/opensprint.sqlite";
/** @deprecated Use backend getDefaultDatabaseUrl() for default. Kept for tests that need a fixed string. */
export const DEFAULT_DATABASE_URL = "postgresql://opensprint:opensprint@localhost:5432/opensprint";
const SQLITE_PATH_RE = /^(?:[./]|[a-zA-Z]:[\\/]|\\\\)|\.(?:sqlite3?|db)$/i;
const LEGACY_SQLITE_PREFIX_RE = /^sqlite:(?!\/\/)/i;
const LEGACY_FILE_PREFIX_RE = /^file:(?!\/\/)/i;
/**
 * Historically, some UI flows wrote shorthand values like sqlite:C:\path or file:/abs/path.
 * Normalize these legacy forms back to canonical SQLite path/URL inputs.
 */
function normalizeLegacySqliteDatabaseUrl(value) {
  let normalized = value.trim();
  let guard = 0;
  while (LEGACY_SQLITE_PREFIX_RE.test(normalized) && guard < 16) {
    normalized = normalized.replace(/^sqlite:/i, "").trim();
    guard += 1;
  }
  if (LEGACY_FILE_PREFIX_RE.test(normalized)) {
    normalized = normalized.replace(/^file:/i, "").trim();
  }
  return normalized;
}
/**
 * Return the database dialect from a validated database URL.
 * Use after validateDatabaseUrl so the URL is known to be valid.
 */
export function getDatabaseDialect(url) {
  const trimmed = normalizeLegacySqliteDatabaseUrl(url);
  if (/^postgres(ql)?:\/\//i.test(trimmed)) return "postgres";
  if (/^sqlite:\/\//i.test(trimmed) || /^file:\/\//i.test(trimmed)) return "sqlite";
  if (SQLITE_PATH_RE.test(trimmed)) return "sqlite";
  return "postgres";
}
/**
 * Validate that a string is a valid database URL (PostgreSQL or SQLite).
 * Accepts postgres://, postgresql://, sqlite://<path>, file://<path>, or a path to a .sqlite/.db file.
 * @throws Error if invalid
 */
export function validateDatabaseUrl(url) {
  if (typeof url !== "string" || !url.trim()) {
    throw new Error("databaseUrl must be a non-empty string");
  }
  const trimmed = normalizeLegacySqliteDatabaseUrl(url);
  if (/^postgres(ql)?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
        throw new Error("databaseUrl must use postgres or postgresql scheme");
      }
      if (!parsed.hostname) {
        throw new Error("databaseUrl must have a host");
      }
      return trimmed;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("databaseUrl")) {
        throw err;
      }
      throw new Error("databaseUrl must be a valid PostgreSQL connection URL");
    }
  }
  if (/^sqlite:\/\//i.test(trimmed) || /^file:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const pathPart = parsed.pathname || parsed.hostname || "";
      if (!pathPart || pathPart === "/") {
        throw new Error("databaseUrl must include a path for SQLite");
      }
      return trimmed;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("databaseUrl")) {
        throw err;
      }
      throw new Error("databaseUrl must be a valid SQLite/file URL");
    }
  }
  if (SQLITE_PATH_RE.test(trimmed)) {
    return trimmed;
  }
  throw new Error(
    "databaseUrl must start with postgres:// or postgresql://, or be a SQLite path (sqlite://, file://, or path ending in .sqlite/.db)"
  );
}
/**
 * Mask a database URL for API responses: host/port visible, password redacted for Postgres;
 * for SQLite/file URLs returns a canonical SQLite URL/path string.
 */
export function maskDatabaseUrl(url) {
  if (typeof url !== "string" || !url.trim()) return "";
  const trimmed = normalizeLegacySqliteDatabaseUrl(url);
  if (getDatabaseDialect(trimmed) === "sqlite") {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.password) {
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return "***";
  }
}
/**
 * Returns true if the database URL host is local (localhost or 127.0.0.1).
 */
export function isLocalDatabaseUrl(databaseUrl) {
  try {
    const parsed = new URL(databaseUrl);
    const host = (parsed.hostname || "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}
const MASKED_PLACEHOLDER = "••••••••";
/**
 * Transform apiKeys for API response: exclude value, return {id, masked, limitHitAt}.
 * Use for GET /global-settings so raw keys are never exposed.
 */
export function maskApiKeysForResponse(apiKeys) {
  if (!apiKeys || Object.keys(apiKeys).length === 0) return undefined;
  const result = {};
  for (const provider of API_KEY_PROVIDERS) {
    const entries = apiKeys[provider];
    if (entries && entries.length > 0) {
      result[provider] = entries.map((e) => ({
        id: e.id,
        masked: MASKED_PLACEHOLDER,
        ...(e.label != null && e.label !== "" && { label: e.label }),
        ...(e.limitHitAt && { limitHitAt: e.limitHitAt }),
        ...(e.invalidAt && { invalidAt: e.invalidAt }),
      }));
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
/**
 * Resolve the agent config for a planning role based on plan complexity.
 * - Dreamer: always complexComplexityAgent
 * - Analyst: always simpleComplexityAgent
 * - Planner, Harmonizer, Auditor, Summarizer: inherit plan complexity (getAgentForComplexity)
 */
export function getAgentForPlanningRole(settings, role, planComplexity) {
  if (role === "dreamer") return settings.complexComplexityAgent;
  if (role === "analyst") return settings.simpleComplexityAgent;
  return getAgentForComplexity(settings, planComplexity);
}
/**
 * Resolve the agent config for a given task complexity.
 * high/very_high → complexComplexityAgent; low/medium/undefined → simpleComplexityAgent.
 */
export function getAgentForComplexity(settings, complexity) {
  if (complexity === "high" || complexity === "very_high") {
    return settings.complexComplexityAgent;
  }
  return settings.simpleComplexityAgent;
}
/** Default agent config when settings are missing */
const DEFAULT_AGENT = { type: "cursor", model: null, cliCommand: null };
const VALID_AI_AUTONOMY_LEVELS = ["confirm_all", "major_only", "full"];
/** Valid branch name: alphanumeric, slash, underscore, hyphen, dot */
const BRANCH_NAME_REGEX = /^[a-zA-Z0-9/_.-]+$/;
/** Normalize worktree base branch: empty/invalid → "main"; valid names trimmed. */
export function normalizeWorktreeBaseBranch(raw) {
  if (typeof raw !== "string" || !raw.trim()) return "main";
  const trimmed = raw.trim();
  if (!BRANCH_NAME_REGEX.test(trimmed)) return "main";
  return trimmed;
}
const VALID_REVIEW_ANGLES = [
  "security",
  "performance",
  "test_coverage",
  "code_quality",
  "design_ux_accessibility",
];
function parseValidationTimeoutMsOverride(raw) {
  if (raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  const rounded = Math.round(raw);
  if (rounded < MIN_VALIDATION_TIMEOUT_MS || rounded > MAX_VALIDATION_TIMEOUT_MS) {
    return undefined;
  }
  return rounded;
}
function normalizeTimingSamples(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const samples = raw
    .filter((v) => typeof v === "number" && Number.isFinite(v))
    .map((v) => Math.round(v))
    .filter((v) => v >= 0);
  if (samples.length === 0) return undefined;
  return samples.slice(-50);
}
function parseValidationTimingProfile(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const profile = raw;
  const scoped = normalizeTimingSamples(profile.scoped);
  const full = normalizeTimingSamples(profile.full);
  const updatedAt =
    typeof profile.updatedAt === "string" && profile.updatedAt.trim()
      ? profile.updatedAt.trim()
      : undefined;
  if (!scoped && !full && !updatedAt) return undefined;
  return {
    ...(scoped && { scoped }),
    ...(full && { full }),
    ...(updatedAt && { updatedAt }),
  };
}
function parseReviewAngles(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const filtered = raw.filter((v) => typeof v === "string" && VALID_REVIEW_ANGLES.includes(v));
  return filtered.length > 0 ? filtered : undefined;
}
/** Parse and validate teamMembers array. Filters invalid entries, trims id/name. Allows empty name when id is present (for add-then-edit flow). Exported for use in project.service. */
export function parseTeamMembers(raw) {
  if (!Array.isArray(raw)) return undefined;
  if (raw.length === 0) return [];
  const result = [];
  for (const item of raw) {
    if (item && typeof item === "object" && "id" in item) {
      const obj = item;
      const id = obj.id;
      const name = obj.name;
      if (typeof id === "string" && id.trim()) {
        result.push({
          id: id.trim(),
          name: typeof name === "string" ? name.trim() : "",
        });
      }
    }
  }
  return result.length > 0 ? result : undefined;
}
/**
 * Parse raw settings into ProjectSettings. Expects two-tier format (simpleComplexityAgent, complexComplexityAgent).
 * Backward compat: accepts legacy lowComplexityAgent/highComplexityAgent.
 * aiAutonomyLevel is source of truth; hilConfig derived from it. Legacy hilConfig migrates to aiAutonomyLevel.
 */
export function parseSettings(raw) {
  const r = raw;
  const simpleObj = r?.simpleComplexityAgent ?? r?.lowComplexityAgent;
  const complexObj = r?.complexComplexityAgent ?? r?.highComplexityAgent;
  const gitWorkingMode =
    r?.gitWorkingMode === "worktree" || r?.gitWorkingMode === "branches"
      ? r.gitWorkingMode
      : "worktree";
  const mergeStrategy =
    typeof r?.mergeStrategy === "string" && VALID_MERGE_STRATEGIES.includes(r.mergeStrategy)
      ? r.mergeStrategy
      : "per_task";
  let aiAutonomyLevel = DEFAULT_AI_AUTONOMY_LEVEL;
  const rawLevel = r?.aiAutonomyLevel;
  if (typeof rawLevel === "string" && VALID_AI_AUTONOMY_LEVELS.includes(rawLevel)) {
    aiAutonomyLevel = rawLevel;
  } else {
    const legacyHil = r?.hilConfig;
    if (legacyHil && typeof legacyHil === "object") {
      aiAutonomyLevel = aiAutonomyLevelFromHilConfig(legacyHil);
    }
  }
  const hilConfig = hilConfigFromAiAutonomyLevel(aiAutonomyLevel);
  const enableHumanTeammates = r?.enableHumanTeammates === true;
  const selfImprovementFrequency =
    typeof r?.selfImprovementFrequency === "string" &&
    VALID_SELF_IMPROVEMENT_FREQUENCIES.includes(r.selfImprovementFrequency)
      ? r.selfImprovementFrequency
      : "never";
  const base = {
    deployment: migrateDeploymentConfig(r?.deployment),
    aiAutonomyLevel,
    hilConfig,
    testFramework: r?.testFramework ?? null,
    gitWorkingMode,
    mergeStrategy,
    worktreeBaseBranch: normalizeWorktreeBaseBranch(r?.worktreeBaseBranch),
    reviewAngles: parseReviewAngles(r?.reviewAngles),
    includeGeneralReview: r?.includeGeneralReview === true ? true : undefined,
    validationTimeoutMsOverride: parseValidationTimeoutMsOverride(r?.validationTimeoutMsOverride),
    validationTimingProfile: parseValidationTimingProfile(r?.validationTimingProfile),
    enableHumanTeammates,
    teamMembers: parseTeamMembers(r?.teamMembers),
    selfImprovementFrequency,
    selfImprovementLastRunAt:
      typeof r?.selfImprovementLastRunAt === "string" && r.selfImprovementLastRunAt.trim()
        ? r.selfImprovementLastRunAt.trim()
        : undefined,
    selfImprovementLastCommitSha:
      typeof r?.selfImprovementLastCommitSha === "string" && r.selfImprovementLastCommitSha.trim()
        ? r.selfImprovementLastCommitSha.trim()
        : undefined,
    autoExecutePlans: r?.autoExecutePlans === true,
  };
  const runAgentEnhancementExperiments = r?.runAgentEnhancementExperiments === true;
  const { apiKeys: _omitApiKeys, ...rest } = r;
  if (simpleObj && typeof simpleObj === "object" && complexObj && typeof complexObj === "object") {
    const simple = simpleObj;
    const complex = complexObj;
    return {
      ...rest,
      simpleComplexityAgent: simple,
      complexComplexityAgent: complex,
      ...base,
      runAgentEnhancementExperiments,
    };
  }
  const simple = (simpleObj && typeof simpleObj === "object" ? simpleObj : null) ?? DEFAULT_AGENT;
  const complex =
    (complexObj && typeof complexObj === "object" ? complexObj : null) ?? DEFAULT_AGENT;
  return {
    ...rest,
    simpleComplexityAgent: simple,
    complexComplexityAgent: complex,
    ...base,
    runAgentEnhancementExperiments,
  };
}
/** Default HIL configuration (all categories default to automated for new projects) */
export const DEFAULT_HIL_CONFIG = {
  scopeChanges: "automated",
  architectureDecisions: "automated",
  dependencyModifications: "automated",
};
/** Valid API key provider names */
export const API_KEY_PROVIDERS = [
  "ANTHROPIC_API_KEY",
  "CURSOR_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
];
/**
 * Validate a single API key entry. Returns the entry if valid; throws if invalid.
 */
export function validateApiKeyEntry(entry) {
  if (!entry || typeof entry !== "object") {
    throw new Error("API key entry must be an object");
  }
  const e = entry;
  const id = e.id;
  const value = e.value;
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("API key entry must have a non-empty string id");
  }
  if (typeof value !== "string") {
    throw new Error("API key entry must have a string value");
  }
  const limitHitAt = e.limitHitAt;
  if (limitHitAt !== undefined && limitHitAt !== null) {
    if (typeof limitHitAt !== "string") {
      throw new Error("API key limitHitAt must be a string (ISO8601)");
    }
  }
  const invalidAt = e.invalidAt;
  if (invalidAt !== undefined && invalidAt !== null) {
    if (typeof invalidAt !== "string") {
      throw new Error("API key invalidAt must be a string (ISO8601)");
    }
  }
  const label = e.label;
  if (label !== undefined && label !== null && typeof label !== "string") {
    throw new Error("API key label must be a string");
  }
  return {
    id: id.trim(),
    value,
    ...(label != null && { label: String(label) }),
    ...(limitHitAt != null && limitHitAt !== "" && { limitHitAt: String(limitHitAt) }),
    ...(invalidAt != null && invalidAt !== "" && { invalidAt: String(invalidAt) }),
  };
}
/**
 * Merge incoming apiKeys with current. When an entry has id but no value (frontend
 * sends masked data), use the existing value from current so we can persist unchanged keys.
 * Providers in incoming replace/merge; providers not in incoming are removed (replace semantics).
 */
export function mergeApiKeysWithCurrent(incoming, current) {
  if (incoming == null || typeof incoming !== "object" || Array.isArray(incoming)) {
    return current;
  }
  const obj = incoming;
  const result = {};
  for (const provider of API_KEY_PROVIDERS) {
    const arr = obj[provider];
    if (arr == null) continue;
    if (!Array.isArray(arr)) continue;
    if (arr.length === 0) continue;
    const currentEntries = current?.[provider] ?? [];
    const merged = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const e = item;
      const id = typeof e.id === "string" ? e.id.trim() : "";
      if (!id) continue;
      const existing = currentEntries.find((x) => x.id === id);
      const hasProvidedValue = typeof e.value === "string" && e.value.trim() !== "";
      let value;
      if (hasProvidedValue) {
        value = e.value;
      } else {
        value = existing?.value ?? "";
      }
      if (!value) continue;
      const valueChanged = Boolean(existing && hasProvidedValue && existing.value !== value);
      const preserveExistingState = !valueChanged;
      const limitHitAt =
        typeof e.limitHitAt === "string"
          ? e.limitHitAt
          : preserveExistingState
            ? existing?.limitHitAt
            : undefined;
      const invalidAt =
        typeof e.invalidAt === "string"
          ? e.invalidAt
          : preserveExistingState
            ? existing?.invalidAt
            : undefined;
      const label =
        typeof e.label === "string" ? e.label : preserveExistingState ? existing?.label : undefined;
      merged.push({
        id,
        value,
        ...(label !== undefined && { label }),
        ...(limitHitAt ? { limitHitAt } : {}),
        ...(invalidAt ? { invalidAt } : {}),
      });
    }
    if (merged.length > 0) {
      result[provider] = merged;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
/**
 * Sanitize raw apiKeys into valid ApiKeys. Returns undefined if input is empty/invalid.
 * Backward compat: ignores unknown provider keys; validates entries for known providers.
 */
export function sanitizeApiKeys(raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw;
  const result = {};
  for (const provider of API_KEY_PROVIDERS) {
    const arr = obj[provider];
    if (arr == null) continue;
    if (!Array.isArray(arr)) continue;
    const entries = [];
    for (const item of arr) {
      try {
        entries.push(validateApiKeyEntry(item));
      } catch {
        // Skip invalid entries
      }
    }
    if (entries.length > 0) {
      result[provider] = entries;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
/**
 * Get API key providers in use based on agent config (simple + complex).
 * claude/claude-cli → ANTHROPIC_API_KEY; cursor → CURSOR_API_KEY; openai → OPENAI_API_KEY; google → GOOGLE_API_KEY.
 */
export function getProvidersInUse(settings) {
  const providers = new Set();
  const agents = [settings.simpleComplexityAgent, settings.complexComplexityAgent];
  for (const a of agents) {
    if (a.type === "claude" || a.type === "claude-cli") providers.add("ANTHROPIC_API_KEY");
    if (a.type === "cursor") providers.add("CURSOR_API_KEY");
    if (a.type === "openai") providers.add("OPENAI_API_KEY");
    if (a.type === "google") providers.add("GOOGLE_API_KEY");
  }
  return Array.from(providers);
}
/**
 * Map agent type to API key provider. Returns null for claude-cli/custom/lmstudio (CLI uses local auth; LM Studio runs locally without API key).
 */
export function getProviderForAgentType(agentType) {
  switch (agentType) {
    case "claude":
      return "ANTHROPIC_API_KEY";
    case "cursor":
      return "CURSOR_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "google":
      return "GOOGLE_API_KEY";
    case "lmstudio":
      return null;
    default:
      return null;
  }
}
/**
 * Get API key providers required when using Claude API, Cursor, OpenAI, or Google (validation only).
 * claude → ANTHROPIC_API_KEY; cursor → CURSOR_API_KEY; openai → OPENAI_API_KEY; google → GOOGLE_API_KEY.
 * claude-cli and custom do not require API keys (CLI uses local auth).
 */
export function getProvidersRequiringApiKeys(agents) {
  const providers = new Set();
  for (const a of agents) {
    if (a.type === "claude") providers.add("ANTHROPIC_API_KEY");
    if (a.type === "cursor") providers.add("CURSOR_API_KEY");
    if (a.type === "openai") providers.add("OPENAI_API_KEY");
    if (a.type === "google") providers.add("GOOGLE_API_KEY");
  }
  return Array.from(providers);
}
/**
 * Check if limitHitAt is older than 24 hours (key is available again).
 */
export function isLimitHitExpired(limitHitAt) {
  if (!limitHitAt) return true;
  try {
    const ts = new Date(limitHitAt).getTime();
    if (Number.isNaN(ts)) return true;
    return Date.now() - ts > 24 * 60 * 60 * 1000;
  } catch {
    return true;
  }
}
//# sourceMappingURL=settings.js.map
