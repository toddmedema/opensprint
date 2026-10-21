import { execSync } from "child_process";
import type { DeployEvent } from "@opensprint/shared";
import { getTargetsForDeployEvent } from "@opensprint/shared";
import { ProjectService } from "./project.service.js";
import { acceptDeployment } from "./durable-deployment.service.js";
import { operationService } from "./operation.service.js";
import { operationWorker } from "./operation-worker.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("deploy");
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
 * Perform a single deploy for a project and target. Used internally for both
 * triggerDeploy (fire-and-forget) and triggerDeployForEvent (sequential).
 * When waitForCompletion is true, awaits runDeployAsync before resolving.
 */
async function doDeploy(
  projectId: string,
  targetName: string | undefined,
  options?: { waitForCompletion?: boolean; requestId?: string }
): Promise<string | null> {
  try {
    const accepted = await acceptDeployment(
      projectId,
      { action: "deploy", target: targetName },
      options?.requestId
        ? { actorId: "server:auto-deploy", requestId: options.requestId }
        : undefined
    );
    if (options?.waitForCompletion) {
      const operation = await operationService.get(projectId, accepted.operationId);
      if (operation) await operationWorker.execute(operation);
    }
    return accepted.deployId;
  } catch (err) {
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
  const project = await projectService.getProject(projectId);
  const commit = getCommitHash(project.repoPath);

  for (const targetName of targetNames) {
    const id = await doDeploy(projectId, targetName, {
      waitForCompletion: true,
      requestId: `auto:${event}:${commit}:${targetName}`,
    });
    if (id) deployIds.push(id);
  }

  return deployIds;
}
