import os from "os";
import path from "path";
import type { AgentType } from "./agent.js";
import type { PlanComplexity } from "./plan.js";

/** Agent configuration */
export interface AgentConfig {
  type: AgentType;
  model: string | null;
  cliCommand: string | null;
  /** LM Studio server URL when type === "lmstudio". Default (applied in backend/frontend): http://localhost:1234 */
  baseUrl?: string;
}

/** Agent configuration input for project creation */
export type AgentConfigInput = AgentConfig;

/** Deployment mode */
export type DeploymentMode = "expo" | "custom";

/** Deployment target (staging/production) */
export type DeploymentTarget = "staging" | "production";

/** When to auto-deploy to this target (PRD §7.5.3) */
export type AutoDeployTrigger = "each_task" | "each_epic" | "eval_resolution" | "nightly" | "none";

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
  /** Environment variables for this target (passed to deploy command/webhook). */
  envVars?: Record<string, string>;
}

/** Deployment configuration */
export interface DeploymentConfig {
  mode: DeploymentMode;
  /** EAS project ID (expo mode). When set, used for eas init / app.json expo.extra.eas.projectId before first deploy. */
  easProjectId?: string;
  /** Target environment (default: production) */
  target?: DeploymentTarget;
  /** Deployment targets with per-target command/webhook (PRD ?7.5.2/7.5.4) */
  targets?: DeploymentTargetConfig[];
  /**
   * Environment variables for deployment (PRD ?7.5.4).
   * @deprecated Use per-target envVars on targets[]. Kept for migration/fallback only.
   */
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
export function getTargetsForDeployEvent(config: DeploymentConfig, event: DeployEvent): string[] {
  const targets = config.targets;
  if (!targets || targets.length === 0) return [];
  return targets.filter((t) => (t.autoDeployTrigger ?? "none") === event).map((t) => t.name);
}

/**
 * Get target names that should be deployed on nightly schedule.
 * Returns targets whose autoDeployTrigger is "nightly".
 */
export function getTargetsForNightlyDeploy(config: DeploymentConfig): string[] {
  const targets = config.targets;
  if (!targets || targets.length === 0) return [];
  return targets.filter((t) => (t.autoDeployTrigger ?? "none") === "nightly").map((t) => t.name);
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
  const mode = input.mode ?? "custom";
  // Legacy migration: expoConfig.projectId → easProjectId when mode is expo
  const easProjectId =
    input.easProjectId ??
    (mode === "expo" && input.expoConfig?.projectId ? input.expoConfig.projectId : undefined);
  const base: DeploymentConfig = {
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

/** Review angle identifiers for code review agent config */
export type ReviewAngle =
  | "security"
  | "performance"
  | "test_coverage"
  | "code_quality"
  | "design_ux_accessibility";

/** Review angle options for multi-select UI */
export const REVIEW_ANGLE_OPTIONS: { value: ReviewAngle; label: string }[] = [
  { value: "security", label: "Security implications" },
  { value: "performance", label: "Performance impact" },
  { value: "test_coverage", label: "Validating test coverage" },
  { value: "code_quality", label: "Code quality, cleanliness and modularity" },
  { value: "design_ux_accessibility", label: "Design, UX and accessibility" },
];

/** UI-only option for general review (scope + code quality). When selected alone, reviewAngles is empty. */
export const GENERAL_REVIEW_OPTION = "general" as const;

/** All review agent options for UI: General first (checked by default), then angle-specific options. */
export const REVIEW_AGENT_OPTIONS: { value: typeof GENERAL_REVIEW_OPTION | ReviewAngle; label: string }[] = [
  { value: GENERAL_REVIEW_OPTION, label: "General" },
  ...REVIEW_ANGLE_OPTIONS,
];

/** Strategy when file scope is unknown for parallel scheduling */
export type UnknownScopeStrategy = "conservative" | "optimistic";

/** Git working mode: worktree (parallel worktrees) or branches (single branch in main repo) */
export type GitWorkingMode = "worktree" | "branches";

/** Per-project merge strategy: per_task (one branch per task) or per_epic (shared branch per epic) */
export type MergeStrategy = "per_task" | "per_epic";

/** Valid merge strategy values for parsing/validation */
export const VALID_MERGE_STRATEGIES: MergeStrategy[] = ["per_task", "per_epic"];

/** Self-improvement run frequency (default: never). Backend sets lastRunAt/lastCommitSha after each run. */
export type SelfImprovementFrequency = "never" | "after_each_plan" | "daily" | "weekly";

/** Valid self-improvement frequency values for parsing/validation */
export const VALID_SELF_IMPROVEMENT_FREQUENCIES: SelfImprovementFrequency[] = [
  "never",
  "after_each_plan",
  "daily",
  "weekly",
];

/** Bounds for project-level validation timeout override and adaptive timeout values. */
export const MIN_VALIDATION_TIMEOUT_MS = 60_000;
export const MAX_VALIDATION_TIMEOUT_MS = 3_600_000;

/** Self-improvement frequency options for UI dropdown */
export const SELF_IMPROVEMENT_FREQUENCY_OPTIONS: {
  value: SelfImprovementFrequency;
  label: string;
}[] = [
  { value: "never", label: "Never" },
  { value: "after_each_plan", label: "After each Plan" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

/** API key provider env var names (used as keys in apiKeys) */
export type ApiKeyProvider =
  | "ANTHROPIC_API_KEY"
  | "CURSOR_API_KEY"
  | "OPENAI_API_KEY"
  | "GOOGLE_API_KEY";

/** Single API key entry with optional disable markers (rate-limit cooldown or invalid key). */
export interface ApiKeyEntry {
  id: string;
  value: string;
  /** User-defined label (e.g. 'Production', 'Staging'). Optional, display only. */
  label?: string;
  /** ISO8601 timestamp when rate/limit was hit; key is retried after 24h */
  limitHitAt?: string;
  /** ISO8601 timestamp when provider rejected the key as invalid. */
  invalidAt?: string;
}

/** API keys per provider: array of entries ordered by preference (first available used). Order is persisted and restored on reload; user can drag-to-reorder in settings. */
export type ApiKeys = Partial<Record<ApiKeyProvider, ApiKeyEntry[]>>;

/** API key update entry; value may be omitted to preserve the stored key by id. */
export interface ApiKeyUpdateEntry {
  id: string;
  value?: string;
  label?: string;
  limitHitAt?: string;
  invalidAt?: string;
}

/** Partial API key update payload keyed by provider. */
export type ApiKeysUpdate = Partial<Record<ApiKeyProvider, ApiKeyUpdateEntry[]>>;

/**
 * Default database path relative to ~/.opensprint (used by scripts that cannot import shared).
 * Full default URL is getDefaultDatabaseUrl().
 */
export const DEFAULT_DATABASE_PATH_RELATIVE = "data/opensprint.sqlite";

/**
 * Return the default database URL (SQLite under ~/.opensprint/data/opensprint.sqlite).
 * Use when no databaseUrl is configured in env or global-settings.
 * Node only (uses os.homedir and path).
 */
export function getDefaultDatabaseUrl(): string {
  const homedir = os.homedir();
  return path.join(homedir, ".opensprint", "data", "opensprint.sqlite");
}

/** @deprecated Use getDefaultDatabaseUrl() for default. Kept for tests that need a fixed string. */
export const DEFAULT_DATABASE_URL = "postgresql://opensprint:opensprint@localhost:5432/opensprint";

/** Global settings stored at ~/.opensprint/global-settings.json */
export interface GlobalSettings {
  apiKeys?: ApiKeys;
  useCustomCli?: boolean;
  /** PostgreSQL or SQLite connection URL or path. Never stored in the database; only in this JSON file. */
  databaseUrl?: string;
  /** Expo access token (EXPO_TOKEN) for EAS deploy. Stored only in this JSON file. */
  expoToken?: string;
  /** When true (default), show a notification dot on the desktop tray/menu bar icon when human notifications are pending. Desktop only. */
  showNotificationDotInMenuBar?: boolean;
  /** When true (default), show the running agent count to the right of the menu bar icon on macOS. Desktop only. */
  showRunningAgentCountInMenuBar?: boolean;
}

/** Response shape for GET /global-settings (apiKeys masked, expoToken masked) */
export interface GlobalSettingsResponse {
  databaseUrl: string;
  /** Current database dialect so UI can show "Using SQLite" / "Upgrade to PostgreSQL" */
  databaseDialect?: "sqlite" | "postgres";
  apiKeys?: MaskedApiKeys;
  /** Whether expoToken is configured (value never exposed) */
  expoTokenConfigured?: boolean;
  /** When true (default), show notification dot in menu bar when notifications pending. Desktop only. */
  showNotificationDotInMenuBar?: boolean;
  /** When true (default), show running agent count in menu bar on macOS. Desktop only. */
  showRunningAgentCountInMenuBar?: boolean;
}

/** Request body for PUT /global-settings */
export interface GlobalSettingsPutRequest {
  databaseUrl?: string;
  apiKeys?: ApiKeysUpdate;
  /** Expo access token (EXPO_TOKEN). Set to empty string to remove. */
  expoToken?: string;
  /** When false, do not show notification dot in menu bar. Default true. */
  showNotificationDotInMenuBar?: boolean;
  /** When false, do not show running agent count in menu bar. Default true. */
  showRunningAgentCountInMenuBar?: boolean;
}

/** Read-only runtime cache/probe status for Git fields returned by project settings APIs. */
export interface GitRuntimeStatus {
  lastCheckedAt: string | null;
  stale: boolean;
  refreshing: boolean;
}

export type DatabaseDialect = "postgres" | "sqlite";

const SQLITE_PATH_RE = /^(?:[./]|[a-zA-Z]:[\\/]|\\\\)|\.(?:sqlite3?|db)$/i;
const LEGACY_SQLITE_PREFIX_RE = /^sqlite:(?!\/\/)/i;
const LEGACY_FILE_PREFIX_RE = /^file:(?!\/\/)/i;

/**
 * Historically, some UI flows wrote shorthand values like sqlite:C:\path or file:/abs/path.
 * Normalize these legacy forms back to canonical SQLite path/URL inputs.
 */
function normalizeLegacySqliteDatabaseUrl(value: string): string {
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
export function getDatabaseDialect(url: string): DatabaseDialect {
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
export function validateDatabaseUrl(url: string): string {
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
export function maskDatabaseUrl(url: string): string {
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
  label?: string;
  limitHitAt?: string;
  invalidAt?: string;
}

/** Masked API keys for GET /global-settings response */
export type MaskedApiKeys = Partial<Record<ApiKeyProvider, MaskedApiKeyEntry[]>>;

const MASKED_PLACEHOLDER = "••••••••";

/**
 * Transform apiKeys for API response: exclude value, return {id, masked, limitHitAt}.
 * Use for GET /global-settings so raw keys are never exposed.
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
        ...(e.label != null && e.label !== "" && { label: e.label }),
        ...(e.limitHitAt && { limitHitAt: e.limitHitAt }),
        ...(e.invalidAt && { invalidAt: e.invalidAt }),
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
  /**
   * Optional project-level override for orchestrator validation timeout (milliseconds).
   * Use null/undefined to fall back to adaptive timeout.
   */
  validationTimeoutMsOverride?: number | null;
  /**
   * Internal rolling timings used to adapt validation timeout per project.
   * `scoped` tracks related/scoped test runs, `full` tracks full-suite runs.
   */
  validationTimingProfile?: {
    scoped?: number[];
    full?: number[];
    updatedAt?: string;
  };
  /** When to invoke the review agent after coding completes (default: "always") */
  reviewMode?: ReviewMode;
  /** Selected review angles for the review agent. When empty, all angles are covered by default. */
  reviewAngles?: ReviewAngle[];
  /** When true with reviewAngles non-empty, run one general review agent plus one per angle. UI uses this so General stays selected when adding angles. */
  includeGeneralReview?: boolean;
  /** Max concurrent Coder/Reviewer agents per project. 1 = v1 sequential behavior. */
  maxConcurrentCoders?: number;
  /** How to handle tasks with no file-scope prediction: "conservative" (serialize) or "optimistic" (parallelize, rely on merger) */
  unknownScopeStrategy?: UnknownScopeStrategy;
  /** Git working mode: "worktree" (parallel worktrees) or "branches" (single branch in main repo). Default: "worktree". */
  gitWorkingMode?: GitWorkingMode;
  /** Merge strategy: "per_task" (one branch per task, merge on task completion) or "per_epic" (shared epic branch, merge when epic completes). Default: "per_task". */
  mergeStrategy?: MergeStrategy;
  /** Project base branch (task branches are created from and merged into this). Persisted under the legacy field name for backward compatibility. */
  worktreeBaseBranch?: string;
  /** Read-only runtime status: whether the repo can publish to origin, is local-only, or has a remote configured but currently unreachable. */
  gitRemoteMode?: "publishable" | "local_only" | "remote_error";
  /** Read-only runtime cache/probe status for Git fields returned by project settings APIs. */
  gitRuntimeStatus?: GitRuntimeStatus;
  /** When true, show team member settings and allow human assignee selection. Default: false. */
  enableHumanTeammates?: boolean;
  /** Team members (id + name) for human assignees. Stored in project settings. */
  teamMembers?: Array<{ id: string; name: string }>;
  /** Self-improvement run frequency. Default: "never". Client can set; backend does not accept lastRunAt/lastCommitSha from client. */
  selfImprovementFrequency?: SelfImprovementFrequency;
  /** ISO 8601 timestamp of last self-improvement run. Set by backend only after a run. */
  selfImprovementLastRunAt?: string;
  /** Git commit SHA at last self-improvement run. Set by backend only after a run. */
  selfImprovementLastCommitSha?: string;
  /** Next scheduled self-improvement run (daily/weekly). ISO 8601. Computed by backend; only present when frequency is daily or weekly. */
  nextRunAt?: string;
  /** When true, Plan phase supports single-step Execute (generate tasks and run); when false, two-step flow (Generate Tasks then Execute). Default: false. */
  autoExecutePlans?: boolean;
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

/** Valid branch name: alphanumeric, slash, underscore, hyphen, dot */
const BRANCH_NAME_REGEX = /^[a-zA-Z0-9/_.-]+$/;

/** Normalize worktree base branch: empty/invalid → "main"; valid names trimmed. */
export function normalizeWorktreeBaseBranch(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return "main";
  const trimmed = raw.trim();
  if (!BRANCH_NAME_REGEX.test(trimmed)) return "main";
  return trimmed;
}
const VALID_REVIEW_ANGLES: ReviewAngle[] = [
  "security",
  "performance",
  "test_coverage",
  "code_quality",
  "design_ux_accessibility",
];

function parseValidationTimeoutMsOverride(raw: unknown): number | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  const rounded = Math.round(raw);
  if (rounded < MIN_VALIDATION_TIMEOUT_MS || rounded > MAX_VALIDATION_TIMEOUT_MS) {
    return undefined;
  }
  return rounded;
}

function normalizeTimingSamples(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const samples = raw
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .map((v) => Math.round(v))
    .filter((v) => v >= 0);
  if (samples.length === 0) return undefined;
  return samples.slice(-50);
}

function parseValidationTimingProfile(
  raw: unknown
): ProjectSettings["validationTimingProfile"] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const profile = raw as Record<string, unknown>;
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

function parseReviewAngles(raw: unknown): ReviewAngle[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const filtered = raw.filter(
    (v): v is ReviewAngle => typeof v === "string" && VALID_REVIEW_ANGLES.includes(v as ReviewAngle)
  );
  return filtered.length > 0 ? filtered : undefined;
}

/** Parse and validate teamMembers array. Filters invalid entries, trims id/name. Allows empty name when id is present (for add-then-edit flow). Exported for use in project.service. */
export function parseTeamMembers(raw: unknown): Array<{ id: string; name: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  if (raw.length === 0) return [];
  const result: Array<{ id: string; name: string }> = [];
  for (const item of raw) {
    if (item && typeof item === "object" && "id" in item) {
      const obj = item as Record<string, unknown>;
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
export function parseSettings(raw: unknown): ProjectSettings {
  const r = raw as Record<string, unknown>;
  const simpleObj = r?.simpleComplexityAgent ?? r?.lowComplexityAgent;
  const complexObj = r?.complexComplexityAgent ?? r?.highComplexityAgent;
  const gitWorkingMode =
    r?.gitWorkingMode === "worktree" || r?.gitWorkingMode === "branches"
      ? (r.gitWorkingMode as "worktree" | "branches")
      : "worktree";

  const mergeStrategy =
    typeof r?.mergeStrategy === "string" && VALID_MERGE_STRATEGIES.includes(r.mergeStrategy as MergeStrategy)
      ? (r.mergeStrategy as MergeStrategy)
      : "per_task";

  let aiAutonomyLevel: AiAutonomyLevel = DEFAULT_AI_AUTONOMY_LEVEL;
  const rawLevel = r?.aiAutonomyLevel;
  if (
    typeof rawLevel === "string" &&
    VALID_AI_AUTONOMY_LEVELS.includes(rawLevel as AiAutonomyLevel)
  ) {
    aiAutonomyLevel = rawLevel as AiAutonomyLevel;
  } else {
    const legacyHil = r?.hilConfig as HilConfig | undefined;
    if (legacyHil && typeof legacyHil === "object") {
      aiAutonomyLevel = aiAutonomyLevelFromHilConfig(legacyHil);
    }
  }
  const hilConfig = hilConfigFromAiAutonomyLevel(aiAutonomyLevel);

  const enableHumanTeammates = r?.enableHumanTeammates === true;
  const selfImprovementFrequency =
    typeof r?.selfImprovementFrequency === "string" &&
    VALID_SELF_IMPROVEMENT_FREQUENCIES.includes(r.selfImprovementFrequency as SelfImprovementFrequency)
      ? (r.selfImprovementFrequency as SelfImprovementFrequency)
      : "never";
  const base = {
    deployment: migrateDeploymentConfig(r?.deployment),
    aiAutonomyLevel,
    hilConfig,
    testFramework: (r?.testFramework as string | null) ?? null,
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
        ? (r.selfImprovementLastRunAt as string).trim()
        : undefined,
    selfImprovementLastCommitSha:
      typeof r?.selfImprovementLastCommitSha === "string" && r.selfImprovementLastCommitSha.trim()
        ? (r.selfImprovementLastCommitSha as string).trim()
        : undefined,
    autoExecutePlans: r?.autoExecutePlans === true,
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
    (simpleObj && typeof simpleObj === "object" ? (simpleObj as AgentConfig) : null) ??
    DEFAULT_AGENT;
  const complex =
    (complexObj && typeof complexObj === "object" ? (complexObj as AgentConfig) : null) ??
    DEFAULT_AGENT;
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
export const API_KEY_PROVIDERS: ApiKeyProvider[] = [
  "ANTHROPIC_API_KEY",
  "CURSOR_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
];

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
      const existing = currentEntries.find((x) => x.id === id);
      const hasProvidedValue = typeof e.value === "string" && e.value.trim() !== "";
      let value: string;
      if (hasProvidedValue) {
        value = e.value as string;
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
        typeof e.label === "string"
          ? e.label
          : preserveExistingState
            ? existing?.label
            : undefined;
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
 * claude/claude-cli → ANTHROPIC_API_KEY; cursor → CURSOR_API_KEY; openai → OPENAI_API_KEY; google → GOOGLE_API_KEY.
 */
export function getProvidersInUse(settings: ProjectSettings): ApiKeyProvider[] {
  const providers: Set<ApiKeyProvider> = new Set();
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
export function getProviderForAgentType(agentType: AgentConfig["type"]): ApiKeyProvider | null {
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
export function getProvidersRequiringApiKeys(agents: AgentConfig[]): ApiKeyProvider[] {
  const providers: Set<ApiKeyProvider> = new Set();
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
