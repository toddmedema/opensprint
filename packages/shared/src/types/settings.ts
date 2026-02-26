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

/** Full project settings stored in global database (~/.opensprint/settings.json) keyed by project_id */
export interface ProjectSettings {
  lowComplexityAgent: AgentConfig;
  highComplexityAgent: AgentConfig;
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
 * - Dreamer: always highComplexityAgent
 * - Analyst: always lowComplexityAgent
 * - Planner, Harmonizer, Auditor, Summarizer: inherit plan complexity (getAgentForComplexity)
 */
export function getAgentForPlanningRole(
  settings: ProjectSettings,
  role: PlanningRole,
  planComplexity?: PlanComplexity
): AgentConfig {
  if (role === "dreamer") return settings.highComplexityAgent;
  if (role === "analyst") return settings.lowComplexityAgent;
  return getAgentForComplexity(settings, planComplexity);
}

/**
 * Resolve the agent config for a given task complexity.
 * high/very_high → highComplexityAgent; low/medium/undefined → lowComplexityAgent.
 */
export function getAgentForComplexity(
  settings: ProjectSettings,
  complexity: PlanComplexity | undefined
): AgentConfig {
  if (complexity === "high" || complexity === "very_high") {
    return settings.highComplexityAgent;
  }
  return settings.lowComplexityAgent;
}

/** Default agent config when settings are missing */
const DEFAULT_AGENT: AgentConfig = { type: "cursor", model: null, cliCommand: null };

/**
 * Parse raw settings into ProjectSettings. Expects two-tier format (lowComplexityAgent, highComplexityAgent).
 * Missing or invalid agent fields default to { type: "cursor", model: null, cliCommand: null }.
 * Already-valid settings pass through unchanged.
 */
export function parseSettings(raw: unknown): ProjectSettings {
  const r = raw as Record<string, unknown>;
  const lowObj = r?.lowComplexityAgent;
  const highObj = r?.highComplexityAgent;
  const gitWorkingMode =
    r?.gitWorkingMode === "worktree" || r?.gitWorkingMode === "branches"
      ? (r.gitWorkingMode as "worktree" | "branches")
      : "worktree";

  if (lowObj && typeof lowObj === "object" && highObj && typeof highObj === "object") {
    const result = raw as ProjectSettings;
    if (result.gitWorkingMode === gitWorkingMode) {
      return result;
    }
    return { ...result, gitWorkingMode };
  }
  const low =
    (lowObj && typeof lowObj === "object" ? (lowObj as AgentConfig) : null) ?? DEFAULT_AGENT;
  const high =
    (highObj && typeof highObj === "object" ? (highObj as AgentConfig) : null) ?? DEFAULT_AGENT;
  return {
    ...(r as Partial<ProjectSettings>),
    lowComplexityAgent: low,
    highComplexityAgent: high,
    deployment: (r?.deployment as DeploymentConfig) ?? DEFAULT_DEPLOYMENT_CONFIG,
    hilConfig: (r?.hilConfig as HilConfig) ?? DEFAULT_HIL_CONFIG,
    testFramework: (r?.testFramework as string | null) ?? null,
    gitWorkingMode,
  } as ProjectSettings;
}

/** Default HIL configuration (all categories default to automated for new projects) */
export const DEFAULT_HIL_CONFIG: HilConfig = {
  scopeChanges: "automated",
  architectureDecisions: "automated",
  dependencyModifications: "automated",
};
