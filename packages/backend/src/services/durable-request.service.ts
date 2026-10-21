import { randomUUID } from "node:crypto";
import { AppError } from "../middleware/error-handler.js";
import { getRequestContext } from "./request-context.js";
import { operationService } from "./operation.service.js";
import { operationWorker } from "./operation-worker.service.js";

/** Persist acceptance before work starts; browser disconnects never own its lifetime. */
export async function runDurableRequest<T>(
  projectId: string,
  kind: string,
  target: string,
  payload: unknown,
  work: () => Promise<T>,
  identity?: { actorId: string; requestId: string }
): Promise<T> {
  const context = getRequestContext();
  // Direct in-process calls have their own lifecycle; all HTTP mutations carry
  // the server-authenticated context and automatic jobs supply an identity.
  if (!identity && !context) return work();
  const operation = await operationService.accept({
    projectId,
    kind,
    target,
    payload,
    actorId: identity?.actorId ?? context!.principal.actorId,
    requestId: identity?.requestId ?? context?.requestId ?? randomUUID(),
    expectedRevision: context?.expectedRevision,
  });
  if (operation.status === "completed") return operation.result as T;
  const completed = await operationWorker.execute(operation, work);
  if (completed.status === "completed") return completed.result as T;
  throw new AppError(
    409,
    "OPERATION_ACCEPTED",
    "This request already has a durable operation. Inspect its status before submitting another request.",
    { operation: completed }
  );
}
