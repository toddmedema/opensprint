import { taskStore } from "./task-store.service.js";
import { operationService, type DurableOperation } from "./operation.service.js";
import {
  appendProjectEvent,
  lockProject,
  resourceChanged,
  stableFingerprint,
} from "./project-event.service.js";
import { AppError } from "../middleware/error-handler.js";

export interface ManualOperationOutcome {
  expectedGeneration: number;
  outcome: "completed" | "failed";
  reason: string;
}

/** Record a controller's inspected outcome. This never dispatches or repeats work. */
export async function reconcileOperation(
  projectId: string,
  id: string,
  input: ManualOperationOutcome,
  actorId: string,
  requestId: string
): Promise<DurableOperation> {
  if (
    !Number.isSafeInteger(input.expectedGeneration) ||
    input.expectedGeneration < 0 ||
    !["completed", "failed"].includes(input.outcome) ||
    !input.reason.trim() ||
    input.reason.length > 2000 ||
    !actorId ||
    !requestId
  )
    throw new AppError(
      400,
      "INVALID_RECONCILIATION",
      "A generation, inspected outcome, actor, request identity and reason are required."
    );
  const fingerprint = stableFingerprint({ ...input, actorId });
  await taskStore.runWrite(async (tx) => {
    await lockProject(tx, projectId);
    const operation = await tx.queryOne(
      "SELECT * FROM durable_operations WHERE project_id = $1 AND id = $2",
      [projectId, id]
    );
    if (!operation) throw new AppError(404, "OPERATION_NOT_FOUND", "Operation not found.");
    const previous = operation.result
      ? (JSON.parse(String(operation.result)) as {
          manualResolution?: { requestId: string; fingerprint: string };
        })
      : null;
    if (previous?.manualResolution?.requestId === requestId) {
      if (previous.manualResolution.fingerprint !== fingerprint)
        throw new AppError(
          409,
          "REQUEST_ID_REUSED",
          "This resolution request belongs to another decision."
        );
      return;
    }
    const now = new Date().toISOString();
    const result = {
      manualResolution: { ...input, actorId, requestId, fingerprint, recordedAt: now },
    };
    const changed = await tx.execute(
      "UPDATE durable_operations SET status = $4, generation = generation + 1, result = $5, error = $6, updated_at = $7 WHERE project_id = $1 AND id = $2 AND generation = $3 AND status = 'uncertain'",
      [
        projectId,
        id,
        input.expectedGeneration,
        input.outcome,
        JSON.stringify(result),
        input.outcome === "failed" ? input.reason : null,
        now,
      ]
    );
    if (changed !== 1)
      throw new AppError(
        409,
        "OPERATION_RECONCILIATION_CONFLICT",
        "The operation changed or its outcome is already known. Refresh before resolving it."
      );
    if (operation.kind === "deployment.run") {
      const deployment = await tx.queryOne(
        "SELECT * FROM deployments WHERE project_id = $1 AND id = $2",
        [projectId, id]
      );
      if (deployment) {
        const log = JSON.parse(String(deployment.log ?? "[]")) as string[];
        log.push(`Manually reconciled by ${actorId}: ${input.outcome}. ${input.reason}`);
        await tx.execute(
          "UPDATE deployments SET status = $3, completed_at = $4, error = $5, log = $6 WHERE project_id = $1 AND id = $2",
          [
            projectId,
            id,
            input.outcome === "completed" ? "success" : "failed",
            now,
            input.outcome === "failed" ? input.reason : null,
            JSON.stringify(log),
          ]
        );
        await resourceChanged(
          tx,
          projectId,
          "deployment",
          id,
          {
            status: input.outcome === "completed" ? "success" : "failed",
            reconciliation: result.manualResolution,
          },
          actorId
        );
      }
    }
    await appendProjectEvent(tx, {
      projectId,
      actorId,
      type: "operation_changed",
      payload: { id, status: input.outcome, generation: input.expectedGeneration + 1, result },
    });
  });
  return (await operationService.get(projectId, id))!;
}
