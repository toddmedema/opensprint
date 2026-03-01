import type { AgentType } from "./agent.js";
import type { PlanComplexity } from "./plan.js";

/** Agent configuration */
export interface AgentConfig {
  type: AgentType;
  model: string | null;
  cliCommand: string | null;
}

/** Agent configuration input for project creation */
export type AgentConfigInput = AgentConfig;

/** Deployment mode */
export type DeploymentMode = "expo" | "custom";

/** Deployment target (staging/production) */
export type DeploymentTarget = "staging" | "production";

/** When to auto-deploy to this target (PRD §7.5.3) */
export type AutoDeployTrigger =
  | "each_task"
  | "each_epic"
  | "eval_resolution"
  | "nightly"
  | "none";

/** Deployment target config (PRD ?7.5.2/7.5.4): staging/production targets with per-target command/webhook */
export interface DeploymentTargetConfig {
  name: string;
  /** Shell command for this target (custom mode) */
  command?: string;
  /** Webhook URL for this target (custom mode) */
  webhookUrl?: string;
  /** Shell command for rollback (custom mode) */
  rollbackCommand?: string;
  /** When true, this target is selected by default in the Deliver tab */
  isDefault?: boolean;
  /** When to auto-deploy to this target. Default: "none". */
  autoDeployTrigger?: AutoDeployTrigger;
}

/** Deployment configuration */
export interface DeploymentConfig {
  mode: DeploymentMode;
  /** Target environment (default: production) */
  target?: DeploymentTarget;
  /** Deployment targets with per-target command/webhook (PRD ?7.5.2/7.5.4) */
  targets?: DeploymentTargetConfig[];
  /** Environment variables for deployment (PRD ?7.5.4) */
  envVars?: Record<string, string>;
  /** Auto-resolve feedback when all its created tasks are Done (PRD ?10.2). Default: false. */
  autoResolveFeedbackOnTaskCompletion?: boolean;
  expoConfig?: {
    projectId?: string;
    /** OTA update channel (default: preview) */
    channel?: string;
  };
  /** Shell command to run after Build completion (custom mode) */
  customCommand?: string;
  /** Webhook URL to POST after Build completion (custom mode) */
  webhookUrl?: string;
  /** Shell command for rollback (custom mode) */
  rollbackCommand?: string;
  /** Time for nightly deploys in local timezone (HH:mm, e.g. "02:00"). Default: "02:00". */
  nightlyDeployTime?: string;
}

export type DeploymentConfigInput = DeploymentConfig;

/** Resolve the default target name from targets array (first isDefault, or first entry, or config.target). */
export function getDefaultDeploymentTarget(config: DeploymentConfig): string {
  const targets = config.targets;
  if (targets && targets.length > 0) {
    const def = targets.find((t) => t.isDefault) ?? targets[0];
    return def.name;
  }
  return config.target ?? "production";
}

/** Resolve target config by name. Returns undefined if not found. */
export function getDeploymentTargetConfig(
  config: DeploymentConfig,
  targetName: string
): DeploymentTargetConfig | undefined {
  return config.targets?.find((t) => t.name === targetName);
}

/** Deploy event types that can trigger auto-deploy (excludes "nightly" which is schedule-based) */
export type DeployEvent = "each_task" | "each_epic" | "eval_resolution";

/**
 * Get target names that should be deployed for a given event.
 * Returns targets whose autoDeployTrigger matches the event.
 */
export function getTargetsForDeployEvent(
  config: DeploymentConfig,
  event: DeployEvent
): string[] {
  const targets = config.targets;
  if (!targets || targets.length === 0) return [];
  return targets
    .filter((t) => (t.autoDeployTrigger ?? "none") === event)
    .map((t) => t.name);
}

/**
 * Get target names that should be deployed on nightly schedule.
 * Returns targets whose autoDeployTrigger is "nightly".
 */
export function getTargetsForNightlyDeploy(config: DeploymentConfig): string[] {
  const targets = config.targets;
  if (!targets || targets.length === 0) return [];
  return targets
    .filter((t) => (t.autoDeployTrigger ?? "none") === "nightly")
    .map((t) => t.name);
}

/** Auto-deploy trigger options for UI dropdown */
export const AUTO_DEPLOY_TRIGGER_OPTIONS: { value: AutoDeployTrigger; label: string }[] = [
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
export function getDeploymentTargetsForUi(config: DeploymentConfig): DeploymentTargetConfig[] {
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
export const DEFAULT_DEPLOYMENT_CONFIG: DeploymentConfig = {
  mode: "custom",
  autoResolveFeedbackOnTaskCompletion: false,
};

/** Legacy deployment shape (pre-migration) with top-level auto-deploy flags */
interface LegacyDeploymentInput extends Record<string, unknown> {
  autoDeployOnEpicCompletion?: boolean;
  autoDeployOnEvalResolution?: boolean;
}

/**
 * Migrate legacy autoDeployOnEpicCompletion/autoDeployOnEvalResolution to per-target autoDeployTrigger.
 * Applies migrated trigger to the default target. Strips legacy flags from output.
 */
function migrateDeploymentConfig(raw: unknown): DeploymentConfig {
  const input = (raw ?? DEFAULT_DEPLOYMENT_CONFIG) as LegacyDeploymentInput & DeploymentConfig;
  const base: DeploymentConfig = {
    ...DEFAULT_DEPLOYMENT_CONFIG,
    mode: input.mode ?? "custom",
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

  const epic = input.autoDeployOnEpicCompletion === true;
  const evalRes = input.autoDeployOnEvalResolution === true;
  if (!epic && !evalRes) return base;

  const resolvedTrigger: AutoDeployTrigger = epic ? "each_epic" : "eval_resolution";
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

/** HIL notification mode for each category */
export type HilNotificationMode = "automated" | "notify_and_proceed" | "requires_approval";

/** Human-in-the-loop decision categories (PRD ?6.5.1: test failures are always automated, not configurable) */
export interface HilConfig {
  scopeChanges: HilNotificationMode;
  architectureDecisions: HilNotificationMode;
  dependencyModifications: HilNotificationMode;
}

export type HilConfigInput = HilConfig;

/** AI Autonomy level: single slider replacing per-category HIL config */
export type AiAutonomyLevel = "confirm_all" | "major_only" | "full";

/** Labels for AI Autonomy slider (left to right) */
export const AI_AUTONOMY_LEVELS: { value: AiAutonomyLevel; label: string }[] = [
  { value: "confirm_all", label: "Confirm all scope changes" },
  { value: "major_only", label: "Major scope changes only" },
  { value: "full", label: "Full autonomy" },
];

/** Default AI autonomy level for new projects */
export const DEFAULT_AI_AUTONOMY_LEVEL: AiAutonomyLevel = "full";

/**
 * Derive HilConfig from AiAutonomyLevel for HIL service and agents.
 * - confirm_all: all categories require approval
 * - major_only: scopeChanges + architectureDecisions require approval; dependencyModifications automated
 * - full: all automated
 */
export function hilConfigFromAiAutonomyLevel(level: AiAutonomyLevel): HilConfig {
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
export function aiAutonomyLevelFromHilConfig(hilConfig: HilConfig): AiAutonomyLevel {
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

/** Review mode controls when the review agent is invoked after coding */
export type ReviewMode = "always" | "never" | "on-failure-only";

/** Default review mode for new projects (PRD ?7.3.2: two-agent cycle is recommended) */
export const DEFAULT_REVIEW_MODE: ReviewMode = "always";

/** Strategy when file scope is unknown for parallel scheduling */
export type UnknownScopeStrategy = "conservative" | "optimistic";

/** Git working mode: worktree (parallel worktrees) or branches (single branch in main repo) */
export type GitWorkingMode = "worktree" | "branches";

/** API key provider env var names (used as keys in apiKeys) */
export type ApiKeyProvider = "ANTHROPIC_API_KEY" | "CURSOR_API_KEY";

/** Single API key entry with optional limit-hit timestamp */
export interface ApiKeyEntry {
  id: string;
  value: string;
  /** ISO8601 timestamp when rate/limit was hit; key is retried after 24h */
  limitHitAt?: string;
}

/** API keys per provider: array of entries ordered by preference (first available used) */
export type ApiKeys = Partial<Record<ApiKeyProvider, ApiKeyEntry[]>>;

/** Default PostgreSQL URL when databaseUrl is not configured */
export const DEFAULT_DATABASE_URL =
  "postgresql://opensprint:opensprint@localhost:5432/opensprint";

/** Global settings stored at ~/.opensprint/global-settings.json */
export interface GlobalSettings {
  apiKeys?: ApiKeys;
  useCustomCli?: boolean;
  /** PostgreSQL connection URL. Never stored in the database; only in this JSON file. */
  databaseUrl?: string;
}

/**
 * Validate that a string is a valid PostgreSQL URL format.
 * Accepts postgres:// or postgresql:// schemes.
 * @throws Error if invalid
 */
export function validateDatabaseUrl(url: string): string {
  if (typeof url !== "string" || !url.trim()) {
    throw new Error("databaseUrl must be a non-empty string");
  }
  const trimmed = url.trim();
  if (!/^postgres(ql)?:\/\//i.test(trimmed)) {
    throw new Error("databaseUrl must start with postgres:// or postgresql://");
  }
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

/**
 * Mask a database URL for API responses: host/port visible, password redacted.
 * Returns e.g. postgresql://user:***@localhost:5432/dbname
 */
export function maskDatabaseUrl(url: string): string {
  if (typeof url !== "string" || !url.trim()) return "";
  try {
    const parsed = new URL(url);
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
export function isLocalDatabaseUrl(databaseUrl: string): boolean {
  try {
    const parsed = new URL(databaseUrl);
    const host = (parsed.hostname || "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

/** Masked API key entry for API responses (never exposes raw value) */
export interface MaskedApiKeyEntry {
  id: string;
  masked: string;
  limitHitAt?: string;
}

/** Masked API keys for GET /projects/:id/settings response */
export type MaskedApiKeys = Partial<Record<ApiKeyProvider, MaskedApiKeyEntry[]>>;

const MASKED_PLACEHOLDER = "••••••••";

/**
 * Transform apiKeys for API response: exclude value, return {id, masked, limitHitAt}.
 * Use for GET /projects/:id/settings so raw keys are never exposed.
 */
export function maskApiKeysForResponse(apiKeys: ApiKeys | undefined): MaskedApiKeys | undefined {
  if (!apiKeys || Object.keys(apiKeys).length === 0) return undefined;
  const result: MaskedApiKeys = {};
  for (const provider of API_KEY_PROVIDERS) {
    const entries = apiKeys[provider];
    if (entries && entries.length > 0) {
      result[provider] = entries.map((e) => ({
        id: e.id,
        masked: MASKED_PLACEHOLDER,
        ...(e.limitHitAt && { limitHitAt: e.limitHitAt }),
      }));
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Full project settings stored in global database (~/.opensprint/settings.json) keyed by project_id */
export interface ProjectSettings {
  simpleComplexityAgent: AgentConfig;
  complexComplexityAgent: AgentConfig;
  deployment: DeploymentConfig;
  /** AI Autonomy level (source of truth). HilConfig is derived from this for HIL service. */
  aiAutonomyLevel?: AiAutonomyLevel;
  /** @deprecated Derived from aiAutonomyLevel. Kept for backward compat; use hilConfigFromAiAutonomyLevel(aiAutonomyLevel) when reading. */
  hilConfig: HilConfig;
  testFramework: string | null;
  /** Test command (auto-detected from package.json, default: npm test, overridable) */
  testCommand?: string | null;
  /** When to invoke the review agent after coding completes (default: "always") */
  reviewMode?: ReviewMode;
  /** Max concurrent Coder/Reviewer agents per project. 1 = v1 sequential behavior. */
  maxConcurrentCoders?: number;
  /** How to handle tasks with no file-scope prediction: "conservative" (serialize) or "optimistic" (parallelize, rely on merger) */
  unknownScopeStrategy?: UnknownScopeStrategy;
  /** Git working mode: "worktree" (parallel worktrees) or "branches" (single branch in main repo). Default: "worktree". */
  gitWorkingMode?: GitWorkingMode;
}

/** Planning agent roles — Dreamer/Analyst use fixed tiers; others inherit plan complexity */
export type PlanningRole =
  | "dreamer"
  | "planner"
  | "harmonizer"
  | "analyst"
  | "summarizer"
  | "auditor";

/**
 * Resolve the agent config for a planning role based on plan complexity.
 * - Dreamer: always complexComplexityAgent
 * - Analyst: always simpleComplexityAgent
 * - Planner, Harmonizer, Auditor, Summarizer: inherit plan complexity (getAgentForComplexity)
 */
export function getAgentForPlanningRole(
  settings: ProjectSettings,
  role: PlanningRole,
  planComplexity?: PlanComplexity
): AgentConfig {
  if (role === "dreamer") return settings.complexComplexityAgent;
  if (role === "analyst") return settings.simpleComplexityAgent;
  return getAgentForComplexity(settings, planComplexity);
}

/**
 * Resolve the agent config for a given task complexity.
 * high/very_high → complexComplexityAgent; low/medium/undefined → simpleComplexityAgent.
 */
export function getAgentForComplexity(
  settings: ProjectSettings,
  complexity: PlanComplexity | undefined
): AgentConfig {
  if (complexity === "high" || complexity === "very_high") {
    return settings.complexComplexityAgent;
  }
  return settings.simpleComplexityAgent;
}

/** Default agent config when settings are missing */
const DEFAULT_AGENT: AgentConfig = { type: "cursor", model: null, cliCommand: null };

const VALID_AI_AUTONOMY_LEVELS: AiAutonomyLevel[] = ["confirm_all", "major_only", "full"];

/**
 * Parse raw settings into ProjectSettings. Expects two-tier format (simpleComplexityAgent, complexComplexityAgent).
 * Backward compat: accepts legacy lowComplexityAgent/highComplexityAgent.
 * aiAutonomyLevel is source of truth; hilConfig derived from it. Legacy hilConfig migrates to aiAutonomyLevel.
 */
export function parseSettings(raw: unknown): ProjectSettings {
  const r = raw as Record<string, unknown>;
  const simpleObj = r?.simpleComplexityAgent ?? r?.lowComplexityAgent;
  const complexObj = r?.complexComplexityAgent ?? r?.highComplexityAgent;
  const gitWorkingMode =
    r?.gitWorkingMode === "worktree" || r?.gitWorkingMode === "branches"
      ? (r.gitWorkingMode as "worktree" | "branches")
      : "worktree";

  let aiAutonomyLevel: AiAutonomyLevel = DEFAULT_AI_AUTONOMY_LEVEL;
  const rawLevel = r?.aiAutonomyLevel;
  if (typeof rawLevel === "string" && VALID_AI_AUTONOMY_LEVELS.includes(rawLevel as AiAutonomyLevel)) {
    aiAutonomyLevel = rawLevel as AiAutonomyLevel;
  } else {
    const legacyHil = r?.hilConfig as HilConfig | undefined;
    if (legacyHil && typeof legacyHil === "object") {
      aiAutonomyLevel = aiAutonomyLevelFromHilConfig(legacyHil);
    }
  }
  const hilConfig = hilConfigFromAiAutonomyLevel(aiAutonomyLevel);

  const base = {
    deployment: migrateDeploymentConfig(r?.deployment),
    aiAutonomyLevel,
    hilConfig,
    testFramework: (r?.testFramework as string | null) ?? null,
    gitWorkingMode,
  };

  const { apiKeys: _omitApiKeys, ...rest } = r as Partial<ProjectSettings> & { apiKeys?: unknown };
  if (simpleObj && typeof simpleObj === "object" && complexObj && typeof complexObj === "object") {
    const simple = simpleObj as AgentConfig;
    const complex = complexObj as AgentConfig;
    return {
      ...rest,
      simpleComplexityAgent: simple,
      complexComplexityAgent: complex,
      ...base,
    } as ProjectSettings;
  }
  const simple =
    (simpleObj && typeof simpleObj === "object" ? (simpleObj as AgentConfig) : null) ?? DEFAULT_AGENT;
  const complex =
    (complexObj && typeof complexObj === "object" ? (complexObj as AgentConfig) : null) ?? DEFAULT_AGENT;
  return {
    ...rest,
    simpleComplexityAgent: simple,
    complexComplexityAgent: complex,
    ...base,
  } as ProjectSettings;
}

/** Default HIL configuration (all categories default to automated for new projects) */
export const DEFAULT_HIL_CONFIG: HilConfig = {
  scopeChanges: "automated",
  architectureDecisions: "automated",
  dependencyModifications: "automated",
};

/** Valid API key provider names */
export const API_KEY_PROVIDERS: ApiKeyProvider[] = ["ANTHROPIC_API_KEY", "CURSOR_API_KEY"];

/**
 * Validate a single API key entry. Returns the entry if valid; throws if invalid.
 */
export function validateApiKeyEntry(entry: unknown): ApiKeyEntry {
  if (!entry || typeof entry !== "object") {
    throw new Error("API key entry must be an object");
  }
  const e = entry as Record<string, unknown>;
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
  return {
    id: id.trim(),
    value,
    ...(limitHitAt != null && limitHitAt !== "" && { limitHitAt: String(limitHitAt) }),
  };
}

/**
 * Merge incoming apiKeys with current. When an entry has id but no value (frontend
 * sends masked data), use the existing value from current so we can persist unchanged keys.
 * Providers in incoming replace/merge; providers not in incoming are removed (replace semantics).
 */
export function mergeApiKeysWithCurrent(
  incoming: unknown,
  current: ApiKeys | undefined
): ApiKeys | undefined {
  if (incoming == null || typeof incoming !== "object" || Array.isArray(incoming)) {
    return current;
  }
  const obj = incoming as Record<string, unknown>;
  const result: ApiKeys = {};
  for (const provider of API_KEY_PROVIDERS) {
    const arr = obj[provider];
    if (arr == null) continue;
    if (!Array.isArray(arr)) continue;
    if (arr.length === 0) continue;
    const currentEntries = current?.[provider] ?? [];
    const merged: ApiKeyEntry[] = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const e = item as Record<string, unknown>;
      const id = typeof e.id === "string" ? e.id.trim() : "";
      if (!id) continue;
      let value: string;
      if (typeof e.value === "string" && e.value.trim()) {
        value = e.value;
      } else {
        const existing = currentEntries.find((x) => x.id === id);
        value = existing?.value ?? "";
      }
      if (!value) continue;
      merged.push({
        id,
        value,
        ...(e.limitHitAt != null && typeof e.limitHitAt === "string" && { limitHitAt: e.limitHitAt }),
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
export function sanitizeApiKeys(raw: unknown): ApiKeys | undefined {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const result: ApiKeys = {};
  for (const provider of API_KEY_PROVIDERS) {
    const arr = obj[provider];
    if (arr == null) continue;
    if (!Array.isArray(arr)) continue;
    const entries: ApiKeyEntry[] = [];
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
 * claude/claude-cli → ANTHROPIC_API_KEY; cursor → CURSOR_API_KEY.
 */
export function getProvidersInUse(settings: ProjectSettings): ApiKeyProvider[] {
  const providers: Set<ApiKeyProvider> = new Set();
  const agents = [settings.simpleComplexityAgent, settings.complexComplexityAgent];
  for (const a of agents) {
    if (a.type === "claude" || a.type === "claude-cli") providers.add("ANTHROPIC_API_KEY");
    if (a.type === "cursor") providers.add("CURSOR_API_KEY");
  }
  return Array.from(providers);
}

/**
 * Check if limitHitAt is older than 24 hours (key is available again).
 */
export function isLimitHitExpired(limitHitAt: string | undefined): boolean {
  if (!limitHitAt) return true;
  try {
    const ts = new Date(limitHitAt).getTime();
    if (Number.isNaN(ts)) return true;
    return Date.now() - ts > 24 * 60 * 60 * 1000;
  } catch {
    return true;
  }
}
