import { randomUUID } from "node:crypto";
import { AppError } from "../middleware/error-handler.js";
import { taskStore } from "./task-store.service.js";
import { assertResourceRevision, lockProject } from "./project-event.service.js";
import { getRequestContext } from "./request-context.js";
import { operationService } from "./operation.service.js";
import { operationWorker } from "./operation-worker.service.js";

export type TaskControlAction = "done" | "delete" | "retry" | "unblock";

/** Admit control with its displayed revision before any process or filesystem effect. */
export async function runDurableTaskControl<T>(
  projectId: string,
  taskId: string,
  action: TaskControlAction,
  payload: unknown,
  work: () => Promise<T>
): Promise<T> {
  const context = getRequestContext();
  if (!context) return work();
  const operation = await taskStore.runWrite(async (tx) => {
    await lockProject(tx, projectId);
    const accepted = await operationService.accept({
      projectId,
      actorId: context.principal.actorId,
      requestId: context.requestId ?? randomUUID(),
      expectedRevision: context.expectedRevision,
      kind: `task.control.${action}`,
      target: taskId,
      payload,
    });
    if (accepted.status === "queued" && context.expectedRevision !== undefined)
      await assertResourceRevision(
        tx,
        projectId,
        "task",
        taskId,
        context.expectedRevision,
        await taskStore.show(projectId, taskId, tx)
      );
    return accepted;
  });
  if (operation.status === "completed") return operation.result as T;
  // The admission transaction has committed before the worker performs effects.
  const result = await operationWorker.execute(operation, work);
  if (result.status === "completed") return result.result as T;
  throw new AppError(
    409,
    "OPERATION_ACCEPTED",
    "Inspect the existing control operation before submitting another request.",
    { operation: result }
  );
}
