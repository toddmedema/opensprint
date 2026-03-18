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
export declare function getDefaultDeploymentTarget(config: DeploymentConfig): string;
/** Resolve target config by name. Returns undefined if not found. */
export declare function getDeploymentTargetConfig(
  config: DeploymentConfig,
  targetName: string
): DeploymentTargetConfig | undefined;
/** Deploy event types that can trigger auto-deploy (excludes "nightly" which is schedule-based) */
export type DeployEvent = "each_task" | "each_epic" | "eval_resolution";
/**
 * Get target names that should be deployed for a given event.
 * Returns targets whose autoDeployTrigger matches the event.
 */
export declare function getTargetsForDeployEvent(
  config: DeploymentConfig,
  event: DeployEvent
): string[];
/**
 * Get target names that should be deployed on nightly schedule.
 * Returns targets whose autoDeployTrigger is "nightly".
 */
export declare function getTargetsForNightlyDeploy(config: DeploymentConfig): string[];
/** Auto-deploy trigger options for UI dropdown */
export declare const AUTO_DEPLOY_TRIGGER_OPTIONS: {
  value: AutoDeployTrigger;
  label: string;
}[];
/**
 * Get targets to display in the deployment UI.
 * Expo mode with empty targets: returns synthetic staging and production.
 * Custom mode: returns targets array (may be empty).
 */
export declare function getDeploymentTargetsForUi(
  config: DeploymentConfig
): DeploymentTargetConfig[];
/** Default deployment configuration (PRD ?6.4, ?7.5.3) */
export declare const DEFAULT_DEPLOYMENT_CONFIG: DeploymentConfig;
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
export declare const AI_AUTONOMY_LEVELS: {
  value: AiAutonomyLevel;
  label: string;
}[];
/** Default AI autonomy level for new projects */
export declare const DEFAULT_AI_AUTONOMY_LEVEL: AiAutonomyLevel;
/**
 * Derive HilConfig from AiAutonomyLevel for HIL service and agents.
 * - confirm_all: all categories require approval
 * - major_only: scopeChanges + architectureDecisions require approval; dependencyModifications automated
 * - full: all automated
 */
export declare function hilConfigFromAiAutonomyLevel(level: AiAutonomyLevel): HilConfig;
/**
 * Derive AiAutonomyLevel from legacy HilConfig (migration).
 */
export declare function aiAutonomyLevelFromHilConfig(hilConfig: HilConfig): AiAutonomyLevel;
/** Review mode controls when the review agent is invoked after coding */
export type ReviewMode = "always" | "never" | "on-failure-only";
/** Default review mode for new projects (PRD ?7.3.2: two-agent cycle is recommended) */
export declare const DEFAULT_REVIEW_MODE: ReviewMode;
/** Review angle identifiers for code review agent config */
export type ReviewAngle =
  | "security"
  | "performance"
  | "test_coverage"
  | "code_quality"
  | "design_ux_accessibility";
/** Review angle options for multi-select UI */
export declare const REVIEW_ANGLE_OPTIONS: {
  value: ReviewAngle;
  label: string;
}[];
/** UI-only option for general review (scope + code quality). When selected alone, reviewAngles is empty. */
export declare const GENERAL_REVIEW_OPTION: "general";
/** All review agent options for UI: General first (checked by default), then angle-specific options. */
export declare const REVIEW_AGENT_OPTIONS: {
  value: typeof GENERAL_REVIEW_OPTION | ReviewAngle;
  label: string;
}[];
/** Strategy when file scope is unknown for parallel scheduling */
export type UnknownScopeStrategy = "conservative" | "optimistic";
/** Git working mode: worktree (parallel worktrees) or branches (single branch in main repo) */
export type GitWorkingMode = "worktree" | "branches";
/** Per-project merge strategy: per_task (one branch per task) or per_epic (shared branch per epic) */
export type MergeStrategy = "per_task" | "per_epic";
/** Valid merge strategy values for parsing/validation */
export declare const VALID_MERGE_STRATEGIES: MergeStrategy[];
/** Self-improvement run frequency (default: never). Backend sets lastRunAt/lastCommitSha after each run. */
export type SelfImprovementFrequency = "never" | "after_each_plan" | "daily" | "weekly";
/** Valid self-improvement frequency values for parsing/validation */
export declare const VALID_SELF_IMPROVEMENT_FREQUENCIES: SelfImprovementFrequency[];
/** Bounds for project-level validation timeout override and adaptive timeout values. */
export declare const MIN_VALIDATION_TIMEOUT_MS = 60000;
export declare const MAX_VALIDATION_TIMEOUT_MS = 3600000;
/** Self-improvement frequency options for UI dropdown */
export declare const SELF_IMPROVEMENT_FREQUENCY_OPTIONS: {
  value: SelfImprovementFrequency;
  label: string;
}[];
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
 * Full default URL is built in backend via getDefaultDatabaseUrl() (Node only).
 */
export declare const DEFAULT_DATABASE_PATH_RELATIVE = "data/opensprint.sqlite";
/** @deprecated Use backend getDefaultDatabaseUrl() for default. Kept for tests that need a fixed string. */
export declare const DEFAULT_DATABASE_URL =
  "postgresql://opensprint:opensprint@localhost:5432/opensprint";
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
/**
 * Return the database dialect from a validated database URL.
 * Use after validateDatabaseUrl so the URL is known to be valid.
 */
export declare function getDatabaseDialect(url: string): DatabaseDialect;
/**
 * Validate that a string is a valid database URL (PostgreSQL or SQLite).
 * Accepts postgres://, postgresql://, sqlite://<path>, file://<path>, or a path to a .sqlite/.db file.
 * @throws Error if invalid
 */
export declare function validateDatabaseUrl(url: string): string;
/**
 * Mask a database URL for API responses: host/port visible, password redacted for Postgres;
 * for SQLite/file URLs returns a canonical SQLite URL/path string.
 */
export declare function maskDatabaseUrl(url: string): string;
/**
 * Returns true if the database URL host is local (localhost or 127.0.0.1).
 */
export declare function isLocalDatabaseUrl(databaseUrl: string): boolean;
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
/**
 * Transform apiKeys for API response: exclude value, return {id, masked, limitHitAt}.
 * Use for GET /global-settings so raw keys are never exposed.
 */
export declare function maskApiKeysForResponse(
  apiKeys: ApiKeys | undefined
): MaskedApiKeys | undefined;
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
  teamMembers?: Array<{
    id: string;
    name: string;
  }>;
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
  /** When true, self-improvement runs execute the experiment/promote pipeline; when false, runs are audit-only. Default: false. */
  runAgentEnhancementExperiments?: boolean;
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
export declare function getAgentForPlanningRole(
  settings: ProjectSettings,
  role: PlanningRole,
  planComplexity?: PlanComplexity
): AgentConfig;
/**
 * Resolve the agent config for a given task complexity.
 * high/very_high → complexComplexityAgent; low/medium/undefined → simpleComplexityAgent.
 */
export declare function getAgentForComplexity(
  settings: ProjectSettings,
  complexity: PlanComplexity | undefined
): AgentConfig;
/** Normalize worktree base branch: empty/invalid → "main"; valid names trimmed. */
export declare function normalizeWorktreeBaseBranch(raw: unknown): string;
/** Parse and validate teamMembers array. Filters invalid entries, trims id/name. Allows empty name when id is present (for add-then-edit flow). Exported for use in project.service. */
export declare function parseTeamMembers(raw: unknown):
  | Array<{
      id: string;
      name: string;
    }>
  | undefined;
/**
 * Parse raw settings into ProjectSettings. Expects two-tier format (simpleComplexityAgent, complexComplexityAgent).
 * Backward compat: accepts legacy lowComplexityAgent/highComplexityAgent.
 * aiAutonomyLevel is source of truth; hilConfig derived from it. Legacy hilConfig migrates to aiAutonomyLevel.
 */
export declare function parseSettings(raw: unknown): ProjectSettings;
/** Default HIL configuration (all categories default to automated for new projects) */
export declare const DEFAULT_HIL_CONFIG: HilConfig;
/** Valid API key provider names */
export declare const API_KEY_PROVIDERS: ApiKeyProvider[];
/**
 * Validate a single API key entry. Returns the entry if valid; throws if invalid.
 */
export declare function validateApiKeyEntry(entry: unknown): ApiKeyEntry;
/**
 * Merge incoming apiKeys with current. When an entry has id but no value (frontend
 * sends masked data), use the existing value from current so we can persist unchanged keys.
 * Providers in incoming replace/merge; providers not in incoming are removed (replace semantics).
 */
export declare function mergeApiKeysWithCurrent(
  incoming: unknown,
  current: ApiKeys | undefined
): ApiKeys | undefined;
/**
 * Sanitize raw apiKeys into valid ApiKeys. Returns undefined if input is empty/invalid.
 * Backward compat: ignores unknown provider keys; validates entries for known providers.
 */
export declare function sanitizeApiKeys(raw: unknown): ApiKeys | undefined;
/**
 * Get API key providers in use based on agent config (simple + complex).
 * claude/claude-cli → ANTHROPIC_API_KEY; cursor → CURSOR_API_KEY; openai → OPENAI_API_KEY; google → GOOGLE_API_KEY.
 */
export declare function getProvidersInUse(settings: ProjectSettings): ApiKeyProvider[];
/**
 * Map agent type to API key provider. Returns null for claude-cli/custom/lmstudio (CLI uses local auth; LM Studio runs locally without API key).
 */
export declare function getProviderForAgentType(
  agentType: AgentConfig["type"]
): ApiKeyProvider | null;
/**
 * Get API key providers required when using Claude API, Cursor, OpenAI, or Google (validation only).
 * claude → ANTHROPIC_API_KEY; cursor → CURSOR_API_KEY; openai → OPENAI_API_KEY; google → GOOGLE_API_KEY.
 * claude-cli and custom do not require API keys (CLI uses local auth).
 */
export declare function getProvidersRequiringApiKeys(agents: AgentConfig[]): ApiKeyProvider[];
/**
 * Check if limitHitAt is older than 24 hours (key is available again).
 */
export declare function isLimitHitExpired(limitHitAt: string | undefined): boolean;
//# sourceMappingURL=settings.d.ts.map
