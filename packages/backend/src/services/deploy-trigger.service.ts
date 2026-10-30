import { agentProcessEnvironment } from "../utils/agent-process-env.js";
import { execSync } from "child_process";
import type { DeployEvent } from "@opensprint/shared";
import { getDefaultDeploymentTarget, getTargetsForDeployEvent } from "@opensprint/shared";
import { ProjectService } from "./project.service.js";
import { deployStorageService } from "./deploy-storage.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("deploy");
const projectService = new ProjectService();

const activeAutoDeployments = new Set<string>();

/** Get git commit hash at HEAD in repo (git rev-parse HEAD) */
function getCommitHash(repoPath: string): string | null {
  try {
    const out = execSync("git rev-parse HEAD", {
      env: agentProcessEnvironment(),
      cwd: repoPath,
      encoding: "utf-8",
    });
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
  options?: {
    waitForCompletion?: boolean;
    expectedCommitHash?: string;
    idempotencyKey?: string;
    assertPublicationLease?: () => Promise<void>;
  }
): Promise<string | null> {
  if (activeAutoDeployments.has(projectId)) {
    if (options?.idempotencyKey)
      throw Object.assign(
        new Error(
          "A deployment is already running; the durable auto-deploy will retry after it completes."
        ),
        { code: "DEPLOYMENT_BUSY" }
      );
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
    if (options?.expectedCommitHash && commitHash !== options.expectedCommitHash)
      throw new Error("Code changed after its published deployment approval.");
    const target = targetName ?? getDefaultDeploymentTarget(settings.deployment);
    const mode = settings.deployment.mode ?? "custom";

    const record = await deployStorageService.createRecord(projectId, previousDeployId, {
      commitHash,
      target,
      mode,
      ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey + ":" + target } : {}),
    });
    if (options?.idempotencyKey) {
      if (record.commitHash !== options.expectedCommitHash)
        throw new Error(
          "Deferred deployment already belongs to a different reviewed revision; inspect it before retrying."
        );
      if (!(await deployStorageService.claimIdempotentRun(projectId, record.id))) {
        activeAutoDeployments.delete(projectId);
        return record.id;
      }
    }

    broadcastToProject(projectId, { type: "deliver.started", deployId: record.id });

    if (!options?.idempotencyKey)
      await deployStorageService.updateRecord(projectId, record.id, { status: "running" });
    if (
      options?.expectedCommitHash &&
      getCommitHash(project.repoPath) !== options.expectedCommitHash
    )
      throw new Error("Published code changed before deployment execution.");

    const { runDeployAsync } = await import("../routes/deliver.js");
    const deploymentLeaseOptions:
      | [
          {
            publicationLeaseHeld: true;
            expectedCommitHash: string;
            assertPublicationLease: () => Promise<void>;
          },
        ]
      | [] =
      options?.expectedCommitHash && options.idempotencyKey && options.assertPublicationLease
        ? [
            {
              publicationLeaseHeld: true,
              expectedCommitHash: options.expectedCommitHash,
              assertPublicationLease: options.assertPublicationLease,
            },
          ]
        : [];
    const deployPromise = runDeployAsync(
      projectId,
      record.id,
      project.repoPath,
      settings,
      target,
      project.name,
      ...deploymentLeaseOptions
    )
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
    if (options?.idempotencyKey) throw err;
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
  event: DeployEvent,
  options?: {
    expectedCommitHash: string;
    idempotencyKey: string;
    assertPublicationLease?: () => Promise<void>;
  }
): Promise<string[]> {
  const settings = await projectService.getSettings(projectId);
  const targetNames = getTargetsForDeployEvent(settings.deployment, event);
  const deployIds: string[] = [];

  for (const targetName of targetNames) {
    const id = await doDeploy(projectId, targetName, { waitForCompletion: true, ...options });
    if (id) deployIds.push(id);
  }

  return deployIds;
}
