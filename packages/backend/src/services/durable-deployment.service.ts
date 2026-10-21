import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProjectService } from "./project.service.js";
import { operationService, type DurableOperation } from "./operation.service.js";
import { operationWorker } from "./operation-worker.service.js";
import { getRequestContext } from "./request-context.js";
import { stableFingerprint } from "./project-event.service.js";
import { deployStorageService } from "./deploy-storage.service.js";
import { AppError } from "../middleware/error-handler.js";
import { createLogger } from "../utils/logger.js";
import { withDeploymentEffect, requestDeploymentStop } from "./deployment-control.service.js";
import { getDefaultDeploymentTarget, getDeploymentTargetConfig } from "@opensprint/shared";
import { checkDeploymentExpoAuth } from "./deployment-expo-isolation.service.js";

const exec = promisify(execFile);
const projects = new ProjectService();
const log = createLogger("durable-deployment");
type DeploymentAction = {
  action: "deploy" | "expo" | "rollback";
  target?: string;
  variant?: "beta" | "prod";
  rollbackDeployId?: string;
  baseSha: string;
  settingsHash: string;
};

async function perform(operation: DurableOperation): Promise<unknown> {
  const payload = operation.payload as DeploymentAction;
  const project = await projects.getProject(operation.projectId);
  const settings = await projects.getSettings(operation.projectId);
  const baseSha = (
    await exec("git", ["rev-parse", "HEAD"], { cwd: project.repoPath, encoding: "utf8" })
  ).stdout.trim();
  if (
    baseSha !== payload.baseSha ||
    stableFingerprint(settings.deployment) !== payload.settingsHash
  )
    throw new AppError(
      409,
      "DEPLOYMENT_CHANGED",
      "Deployment settings or Git commit changed after acceptance; inspect and submit a fresh request."
    );
  const previous = payload.rollbackDeployId
    ? await deployStorageService.getRecord(operation.projectId, payload.rollbackDeployId)
    : await deployStorageService.getLatestDeploy(operation.projectId);
  const record = await deployStorageService.createRecord(operation.projectId, previous?.id, {
    id: operation.id,
    commitHash: baseSha,
    target:
      payload.target ??
      (payload.action === "expo"
        ? payload.variant === "prod"
          ? "production"
          : "staging"
        : getDefaultDeploymentTarget(settings.deployment)),
    mode: settings.deployment.mode ?? "custom",
    exclusive: true,
  });
  await deployStorageService.updateRecord(operation.projectId, record.id, { status: "running" });
  const { runDeployAsync, runExplicitExpoDeployment, runExplicitRollback } =
    await import("../routes/deliver.js");
  try {
    await withDeploymentEffect(operation.projectId, record.id, async () => {
      if (payload.action === "rollback")
        await runExplicitRollback(
          operation.projectId,
          record.id,
          project.repoPath,
          settings,
          payload.rollbackDeployId!
        );
      else if (payload.action === "expo")
        await runExplicitExpoDeployment(
          operation.projectId,
          record.id,
          project.repoPath,
          settings,
          payload.variant!,
          project.name
        );
      else
        await runDeployAsync(
          operation.projectId,
          record.id,
          project.repoPath,
          settings,
          payload.target,
          project.name
        );
    });
  } catch (err) {
    await deployStorageService.updateRecord(operation.projectId, record.id, {
      status: "uncertain",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  const completed = await deployStorageService.getRecord(operation.projectId, record.id);
  if (completed?.status === "uncertain")
    throw new AppError(
      409,
      "DEPLOYMENT_OUTCOME_UNCERTAIN",
      "Inspect the deployment provider before reconciling this operation."
    );
  return {
    deployId: record.id,
    record: completed,
  };
}
operationWorker.register("deployment.run", perform);
operationWorker.register("deployment.stop", (op) => requestDeploymentStop(op.projectId, op.target));

export async function acceptDeployment(
  projectId: string,
  input: Omit<DeploymentAction, "baseSha" | "settingsHash">,
  identity?: { requestId: string; actorId: string }
): Promise<{ deployId: string; operationId: string }> {
  const context = getRequestContext();
  const actorId = identity?.actorId ?? context?.principal.actorId ?? "server:deployment";
  const requestId = identity?.requestId ?? context?.requestId ?? randomUUID();
  const existing = await operationService.getByRequestId(projectId, requestId);
  if (existing) {
    const old = existing.payload as DeploymentAction;
    if (
      existing.actorId !== actorId ||
      existing.kind !== "deployment.run" ||
      stableFingerprint({
        action: old.action,
        target: old.target,
        variant: old.variant,
        rollbackDeployId: old.rollbackDeployId,
      }) !== stableFingerprint(input)
    )
      throw new AppError(
        409,
        "OPERATION_ID_REUSED",
        "Request identity belongs to another deployment action."
      );
    return { deployId: existing.id, operationId: existing.id };
  }
  const project = await projects.getProject(projectId);
  const settings = await projects.getSettings(projectId);
  if (input.action === "expo") {
    if (settings.deployment.mode !== "expo")
      throw new AppError(
        400,
        "EXPO_REQUIRED",
        "Expo deploy is only available when deployment mode is 'expo'"
      );
    const target = input.variant === "prod" ? "production" : "staging";
    const environment =
      getDeploymentTargetConfig(settings.deployment, target)?.envVars ??
      settings.deployment.envVars;
    const auth = await checkDeploymentExpoAuth(project.repoPath, settings.deployment, environment);
    if (!auth.ok) throw new AppError(400, auth.code, auth.message, { prompt: auth.prompt });
  }
  const baseSha = (
    await exec("git", ["rev-parse", "HEAD"], { cwd: project.repoPath, encoding: "utf8" })
  ).stdout.trim();
  const operation = await operationService.accept({
    projectId,
    actorId,
    requestId,
    kind: "deployment.run",
    target: input.target ?? input.action,
    payload: { ...input, baseSha, settingsHash: stableFingerprint(settings.deployment) },
  });
  if (operation.status === "queued")
    void operationWorker
      .execute(operation)
      .catch((err) =>
        log.error("Deployment operation needs reconciliation", { err, operationId: operation.id })
      );
  return { deployId: operation.id, operationId: operation.id };
}
