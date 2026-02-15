import type { AgentType } from './agent.js';

/** Agent configuration */
export interface AgentConfig {
  type: AgentType;
  model: string | null;
  cliCommand: string | null;
}

/** Agent configuration input for project creation */
export type AgentConfigInput = AgentConfig;

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
}

export type DeploymentConfigInput = DeploymentConfig;

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

/** Full project settings stored at .opensprint/settings.json */
export interface ProjectSettings {
  planningAgent: AgentConfig;
  codingAgent: AgentConfig;
  deployment: DeploymentConfig;
  hilConfig: HilConfig;
  testFramework: string | null;
}

/** Default HIL configuration */
export const DEFAULT_HIL_CONFIG: HilConfig = {
  scopeChanges: 'requires_approval',
  architectureDecisions: 'requires_approval',
  dependencyModifications: 'automated',
  testFailuresAndRetries: 'automated',
};
