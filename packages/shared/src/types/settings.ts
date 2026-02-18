import type { AgentType } from './agent.js';
import type { PlanComplexity } from './plan.js';

/** Agent configuration */
export interface AgentConfig {
  type: AgentType;
  model: string | null;
  cliCommand: string | null;
}

/** Agent configuration input for project creation */
export type AgentConfigInput = AgentConfig;

/** Per-complexity coding agent overrides. Keys are PlanComplexity levels. */
export type CodingAgentByComplexity = Partial<Record<PlanComplexity, AgentConfig>>;

/** Deployment mode */
export type DeploymentMode = 'expo' | 'custom';

/** Deployment target (staging/production) — legacy, prefer targets array */
export type DeploymentTarget = 'staging' | 'production';

/** Deployment target config (PRD §7.5.2/7.5.4): staging/production targets with per-target command/webhook */
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
  /** Target environment (default: production) — legacy, prefer targets array */
  target?: DeploymentTarget;
  /** Deployment targets with per-target command/webhook (PRD §7.5.2/7.5.4) */
  targets?: DeploymentTargetConfig[];
  /** Environment variables for deployment (PRD §7.5.4) */
  envVars?: Record<string, string>;
  /** Auto-deploy when all tasks in an epic reach Done (PRD §7.5.3). Default: false. */
  autoDeployOnEpicCompletion?: boolean;
  /** Auto-deploy when all critical feedback (bugs) are resolved (PRD §7.5.3). Default: false. */
  autoDeployOnEvalResolution?: boolean;
  /** Auto-resolve feedback when all its created tasks are Done (PRD §10.2). Default: false. */
  autoResolveFeedbackOnTaskCompletion?: boolean;
  expoConfig?: {
    projectId?: string;
    /** OTA update channel (default: preview) */
    channel?: string;
  };
  /** Shell command to run after Build completion (custom mode) — legacy, prefer targets[].command */
  customCommand?: string;
  /** Webhook URL to POST after Build completion (custom mode) — legacy, prefer targets[].webhookUrl */
  webhookUrl?: string;
  /** Shell command for rollback (custom mode) */
  rollbackCommand?: string;
}

export type DeploymentConfigInput = DeploymentConfig;

/** Resolve the default target name from targets array (first isDefault, or first entry, or legacy target) */
export function getDefaultDeploymentTarget(config: DeploymentConfig): string {
  const targets = config.targets;
  if (targets && targets.length > 0) {
    const def = targets.find((t) => t.isDefault) ?? targets[0];
    return def.name;
  }
  return config.target ?? 'production';
}

/** Resolve target config by name. Returns undefined if not found (caller should fall back to legacy customCommand/webhookUrl). */
export function getDeploymentTargetConfig(
  config: DeploymentConfig,
  targetName: string,
): DeploymentTargetConfig | undefined {
  return config.targets?.find((t) => t.name === targetName);
}

/** Default deployment configuration (PRD §6.4, §7.5.3) */
export const DEFAULT_DEPLOYMENT_CONFIG: DeploymentConfig = {
  mode: 'custom',
  autoDeployOnEpicCompletion: false,
  autoDeployOnEvalResolution: false,
  autoResolveFeedbackOnTaskCompletion: false,
};

/** HIL notification mode for each category */
export type HilNotificationMode = 'automated' | 'notify_and_proceed' | 'requires_approval';

/** Human-in-the-loop decision categories (PRD §6.5.1: test failures are always automated, not configurable) */
export interface HilConfig {
  scopeChanges: HilNotificationMode;
  architectureDecisions: HilNotificationMode;
  dependencyModifications: HilNotificationMode;
}

export type HilConfigInput = HilConfig;

/** Review mode controls when the review agent is invoked after coding */
export type ReviewMode = 'always' | 'never' | 'on-failure-only';

/** Default review mode for new projects (PRD §7.3.2: two-agent cycle is recommended) */
export const DEFAULT_REVIEW_MODE: ReviewMode = 'always';

/** Full project settings stored at .opensprint/settings.json */
export interface ProjectSettings {
  planningAgent: AgentConfig;
  codingAgent: AgentConfig;
  /** Optional per-complexity coding agent overrides (PRD §12.4) */
  codingAgentByComplexity?: CodingAgentByComplexity;
  deployment: DeploymentConfig;
  hilConfig: HilConfig;
  testFramework: string | null;
  /** Test command (auto-detected from package.json, default: npm test, overridable) */
  testCommand?: string | null;
  /** When to invoke the review agent after coding completes (default: "always") */
  reviewMode?: ReviewMode;
}

/**
 * Resolve the coding agent config for a given task complexity.
 * Falls back through: exact complexity override → default codingAgent.
 */
export function getCodingAgentForComplexity(
  settings: ProjectSettings,
  complexity: PlanComplexity | undefined,
): AgentConfig {
  if (complexity && settings.codingAgentByComplexity?.[complexity]) {
    return settings.codingAgentByComplexity[complexity]!;
  }
  return settings.codingAgent;
}

/** Default HIL configuration */
export const DEFAULT_HIL_CONFIG: HilConfig = {
  scopeChanges: 'requires_approval',
  architectureDecisions: 'requires_approval',
  dependencyModifications: 'automated',
};
