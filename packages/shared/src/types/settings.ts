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

/** Deployment configuration */
export interface DeploymentConfig {
  mode: DeploymentMode;
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

/** Default deployment configuration (PRD §6.4) */
export const DEFAULT_DEPLOYMENT_CONFIG: DeploymentConfig = {
  mode: 'custom',
};

/** HIL notification mode for each category */
export type HilNotificationMode = 'automated' | 'notify_and_proceed' | 'requires_approval';

/** Human-in-the-loop decision categories */
export interface HilConfig {
  scopeChanges: HilNotificationMode;
  architectureDecisions: HilNotificationMode;
  dependencyModifications: HilNotificationMode;
  testFailuresAndRetries: HilNotificationMode;
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
  testFailuresAndRetries: 'automated',
};
