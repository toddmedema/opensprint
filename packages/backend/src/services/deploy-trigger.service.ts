import { execSync } from "child_process";
import { getDefaultDeploymentTarget } from "@opensprint/shared";
import { ProjectService } from "./project.service.js";
import { deployStorageService } from "./deploy-storage.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { runDeployAsync } from "../routes/deploy.js";

const projectService = new ProjectService();

/** Get git commit hash at HEAD in repo (git rev-parse HEAD) */
function getCommitHash(repoPath: string): string | null {
  try {
    const out = execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf-8" });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Trigger a full deployment for a project (PRD §7.5).
 * Creates a deployment record, broadcasts deliver.started, and runs the deploy pipeline
 * (pre-deploy tests, then Expo or custom command/webhook).
 * Returns the deploy ID. Does not throw — logs errors.
 */
export async function triggerDeploy(projectId: string): Promise<string | null> {
  try {
    const project = await projectService.getProject(projectId);
    const settings = await projectService.getSettings(projectId);

    const latest = await deployStorageService.getLatestDeploy(projectId);
    const previousDeployId = latest?.id ?? null;

    const commitHash = getCommitHash(project.repoPath);
    const target = getDefaultDeploymentTarget(settings.deployment);
    const mode = settings.deployment.mode ?? "custom";

    const record = await deployStorageService.createRecord(projectId, previousDeployId, {
      commitHash,
      target,
      mode,
    });

    broadcastToProject(projectId, { type: "deliver.started", deployId: record.id });

    await deployStorageService.updateRecord(projectId, record.id, { status: "running" });

    runDeployAsync(projectId, record.id, project.repoPath, settings, target).catch((err) => {
      console.error(`[deploy] Deploy ${record.id} failed:`, err);
    });

    return record.id;
  } catch (err) {
    console.error(`[deploy] Trigger deploy failed for project ${projectId}:`, err);
    return null;
  }
}
