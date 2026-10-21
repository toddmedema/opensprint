import { AsyncLocalStorage } from "node:async_hooks";
import type { DurableOperation } from "./operation.service.js";
import type { DbClient } from "../db/client.js";
import { databaseNow } from "../db/database-clock.js";
import { AppError } from "../middleware/error-handler.js";
import { lockProject } from "./project-event.service.js";
const context = new AsyncLocalStorage<DurableOperation>();
export function withOperationEffect<T>(
  operation: DurableOperation,
  fn: () => Promise<T>
): Promise<T> {
  return context.run(operation, fn);
}
export function deploymentOperationProjectId(): string | undefined {
  const operation = context.getStore();
  return operation?.kind.startsWith("deployment.") ? operation.projectId : undefined;
}
export async function assertDeploymentOperation(tx: DbClient, projectId: string): Promise<void> {
  return assertOperationEffect(tx, projectId, "deployment.");
}
export async function assertTaskControlOperation(tx: DbClient, projectId: string): Promise<void> {
  return assertOperationEffect(tx, projectId, "task.control.");
}
/** Every durable handler, including planning and chat, must retain its lease before writing. */
export async function assertCurrentOperation(tx: DbClient): Promise<void> {
  const operation = context.getStore();
  if (!operation) return;
  await lockProject(tx, operation.projectId);
  await assertOperationEffect(tx, operation.projectId, "");
}
async function assertOperationEffect(
  tx: DbClient,
  projectId: string,
  prefix: string
): Promise<void> {
  const operation = context.getStore();
  if (!operation?.kind.startsWith(prefix)) return;
  // Callers hold the project lock. Wait for heartbeat writers before sampling
  // time, so a lease cannot remain valid using a timestamp from before a wait.
  await tx.queryOne(
    "UPDATE operation_owners SET expires_at=expires_at WHERE owner_id=$1 RETURNING owner_id",
    [operation.ownerId]
  );
  const now = new Date(await databaseNow(tx)).toISOString();
  const affected = await tx.execute(
    `UPDATE durable_operations SET updated_at=updated_at WHERE project_id=$1 AND id=$2 AND owner_id=$3 AND generation=$4 AND status='running' AND EXISTS(SELECT 1 FROM operation_owners WHERE owner_id=$3 AND expires_at>$5)`,
    [projectId, operation.id, operation.ownerId, operation.generation, now]
  );
  if (affected !== 1)
    throw new AppError(
      409,
      operation.kind.startsWith("deployment.")
        ? "DEPLOYMENT_OWNER_LOST"
        : operation.kind.startsWith("task.control.")
          ? "TASK_CONTROL_OWNER_LOST"
          : "OPERATION_FENCE_LOST",
      "This operation owner expired or its outcome was reconciled."
    );
}
