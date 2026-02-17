/** Deployment record stored at .opensprint/deployments/<deploy-id>.json */
export interface DeploymentRecord {
  id: string;
  projectId: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  /** ISO timestamp when deployment started */
  startedAt: string;
  /** ISO timestamp when deployment completed (null if still running) */
  completedAt: string | null;
  /** Deploy URL (e.g. Expo preview link) when successful */
  url?: string;
  /** Error message when failed */
  error?: string;
  /** Log output from deployment process */
  log: string[];
  /** Previous deploy ID for rollback (null if this is the first deploy) */
  previousDeployId?: string | null;
}
