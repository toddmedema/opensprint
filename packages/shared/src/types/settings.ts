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

/** Deployment target config (PRD ?7.5.2/7.5.4): staging/production targets with per-target command/webhook */
export interface DeploymentTargetConfig {
  name: string;
  /** Shell command for this target (custom mode) */
  command?: string;
  /** Webhook URL for this target (custom mode) */
  webhookUrl?: string;
  /** When true, this target is selected by default in the Deliver tab */
  isDefault?: boolean;
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
  /** Auto-deploy when all tasks in an epic reach Done (PRD ?7.5.3). Default: false. */
  autoDeployOnEpicCompletion?: boolean;
  /** Auto-deploy when all critical feedback (bugs) are resolved (PRD ?7.5.3). Default: false. */
  autoDeployOnEvalResolution?: boolean;
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

/** Default deployment configuration (PRD ?6.4, ?7.5.3) */
export const DEFAULT_DEPLOYMENT_CONFIG: DeploymentConfig = {
  mode: "custom",
  autoDeployOnEpicCompletion: false,
  autoDeployOnEvalResolution: false,
  autoResolveFeedbackOnTaskCompletion: false,
};

/** HIL notification mode for each category */
export type HilNotificationMode = "automated" | "notify_and_proceed" | "requires_approval";

/** Human-in-the-loop decision categories (PRD ?6.5.1: test failures are always automated, not configurable) */
export interface HilConfig {
  scopeChanges: HilNotificationMode;
  architectureDecisions: HilNotificationMode;
  dependencyModifications: HilNotificationMode;
}

export type HilConfigInput = HilConfig;

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
  /** Per-provider API keys for rotation when limits are hit. Falls back to process.env when absent. */
  apiKeys?: ApiKeys;
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

/**
 * Parse raw settings into ProjectSettings. Expects two-tier format (simpleComplexityAgent, complexComplexityAgent).
 * Backward compat: accepts legacy lowComplexityAgent/highComplexityAgent.
 * Missing or invalid agent fields default to { type: "cursor", model: null, cliCommand: null }.
 */
export function parseSettings(raw: unknown): ProjectSettings {
  const r = raw as Record<string, unknown>;
  const simpleObj = r?.simpleComplexityAgent ?? r?.lowComplexityAgent;
  const complexObj = r?.complexComplexityAgent ?? r?.highComplexityAgent;
  const gitWorkingMode =
    r?.gitWorkingMode === "worktree" || r?.gitWorkingMode === "branches"
      ? (r.gitWorkingMode as "worktree" | "branches")
      : "worktree";
  const apiKeys = sanitizeApiKeys(r?.apiKeys);

  const base = {
    deployment: (r?.deployment as DeploymentConfig) ?? DEFAULT_DEPLOYMENT_CONFIG,
    hilConfig: (r?.hilConfig as HilConfig) ?? DEFAULT_HIL_CONFIG,
    testFramework: (r?.testFramework as string | null) ?? null,
    gitWorkingMode,
    apiKeys: apiKeys ?? undefined,
  };

  if (simpleObj && typeof simpleObj === "object" && complexObj && typeof complexObj === "object") {
    const simple = simpleObj as AgentConfig;
    const complex = complexObj as AgentConfig;
    return {
      ...(r as Partial<ProjectSettings>),
      simpleComplexityAgent: simple,
      complexComplexityAgent: complex,
      ...base,
    };
  }
  const simple =
    (simpleObj && typeof simpleObj === "object" ? (simpleObj as AgentConfig) : null) ?? DEFAULT_AGENT;
  const complex =
    (complexObj && typeof complexObj === "object" ? (complexObj as AgentConfig) : null) ?? DEFAULT_AGENT;
  return {
    ...(r as Partial<ProjectSettings>),
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
