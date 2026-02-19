import type { DeploymentTarget } from "./settings.js";

/** Deployment record stored at .opensprint/deployments/<deploy-id>.json */
export interface DeploymentRecord {
  id: string;
  projectId: string;
  status: "pending" | "running" | "success" | "failed" | "rolled_back";
  /** ISO timestamp when deployment started */
  startedAt: string;
  /** ISO timestamp when deployment completed (null if still running) */
  completedAt: string | null;
  /** Git commit SHA at deploy time (git rev-parse HEAD) */
  commitHash?: string | null;
  /** Target name (from targets[].name or staging/production) */
  target?: string | DeploymentTarget;
  /** Deployment mode from settings (expo/custom) */
  mode?: "expo" | "custom";
  /** Deploy URL (e.g. Expo preview link) when successful */
  url?: string;
  /** Error message when failed */
  error?: string;
  /** Log output from deployment process */
  log: string[];
  /** Previous deploy ID for rollback (null if this is the first deploy) */
  previousDeployId?: string | null;
  /** Deploy ID that rolled back this deployment (set when status is rolled_back) */
  rolledBackBy?: string | null;
  /** Beads epic ID for fix tasks when deployment failed due to pre-deploy test failures (PRD §7.5.2) */
  fixEpicId?: string | null;
}
