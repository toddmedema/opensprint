export const PROJECT_PERMISSIONS = [
  "read",
  "discuss",
  "edit",
  "control",
  "approve",
  "publish",
  "deploy",
  "manage",
] as const;
export type ProjectPermission = (typeof PROJECT_PERMISSIONS)[number];
export type RuntimeDeploymentMode = "trusted-local" | "shared-host" | "isolated-hosted";
export interface ProjectIdentity {
  actorId: string;
  displayName: string;
  role: "viewer" | "participant" | "controller";
  permissions: ProjectPermission[];
  local: boolean;
  credentialHash?: string;
}
