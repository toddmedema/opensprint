import { execSync } from "child_process";
import type { DeployEvent } from "@opensprint/shared";
import { getDefaultDeploymentTarget, getTargetsForDeployEvent } from "@opensprint/shared";
import { ProjectService } from "./project.service.js";
import { deployStorageService } from "./deploy-storage.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { runDeployAsync } from "../routes/deliver.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("deploy");
const projectService = new ProjectService();

const activeAutoDeployments = new Set<string>();

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
 * Perform a single deploy for a project and target. Used internally for both
 * triggerDeploy (fire-and-forget) and triggerDeployForEvent (sequential).
 * When waitForCompletion is true, awaits runDeployAsync before resolving.
 */
async function doDeploy(
  projectId: string,
  targetName: string | undefined,
  options?: { waitForCompletion?: boolean }
): Promise<string | null> {
  if (activeAutoDeployments.has(projectId)) {
    log.warn("Skipping auto-deploy: deployment already in progress", { projectId });
    return null;
  }

  try {
    activeAutoDeployments.add(projectId);

    const project = await projectService.getProject(projectId);
    const settings = await projectService.getSettings(projectId);

    const latest = await deployStorageService.getLatestDeploy(projectId);
    const previousDeployId = latest?.id ?? null;

    const commitHash = getCommitHash(project.repoPath);
    const target = targetName ?? getDefaultDeploymentTarget(settings.deployment);
    const mode = settings.deployment.mode ?? "custom";

    const record = await deployStorageService.createRecord(projectId, previousDeployId, {
      commitHash,
      target,
      mode,
    });

    broadcastToProject(projectId, { type: "deliver.started", deployId: record.id });

    await deployStorageService.updateRecord(projectId, record.id, { status: "running" });

    const deployPromise = runDeployAsync(projectId, record.id, project.repoPath, settings, target)
      .catch((err) => {
        log.error("Deploy failed", { deployId: record.id, err });
      })
      .finally(() => {
        activeAutoDeployments.delete(projectId);
      });

    if (options?.waitForCompletion) {
      await deployPromise;
    }

    return record.id;
  } catch (err) {
    activeAutoDeployments.delete(projectId);
    log.error("Trigger deploy failed for project", { projectId, err });
    return null;
  }
}

/**
 * Trigger a full deployment for a project (PRD §7.5).
 * Creates a deployment record, broadcasts deliver.started, and runs the deploy pipeline
 * (pre-deploy tests, then Expo or custom command/webhook).
 * When targetName is provided, deploys to that target; otherwise uses default target.
 * Returns the deploy ID. Does not throw — logs errors.
 * Prevents concurrent deployments per project.
 */
export async function triggerDeploy(
  projectId: string,
  targetName?: string
): Promise<string | null> {
  return doDeploy(projectId, targetName);
}

/**
 * Trigger deploys for all targets with matching autoDeployTrigger for the given event.
 * Runs deploys sequentially per project to avoid concurrent deploys.
 */
export async function triggerDeployForEvent(
  projectId: string,
  event: DeployEvent
): Promise<string[]> {
  const settings = await projectService.getSettings(projectId);
  const targetNames = getTargetsForDeployEvent(settings.deployment, event);
  const deployIds: string[] = [];

  for (const targetName of targetNames) {
    const id = await doDeploy(projectId, targetName, { waitForCompletion: true });
    if (id) deployIds.push(id);
  }

  return deployIds;
}
