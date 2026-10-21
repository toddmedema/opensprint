import { randomUUID } from "node:crypto";
import { withOperationEffect } from "./operation-effect-context.js";
import { operationService, type DurableOperation } from "./operation.service.js";
import { createLogger } from "../utils/logger.js";
import { identityService, localIdentity } from "./identity.service.js";
import { runWithRequestContext } from "./request-context.js";
import type { ProjectIdentity, ProjectPermission } from "@opensprint/shared";

type Handler = (operation: DurableOperation) => Promise<unknown>;
const log = createLogger("operation-worker");
function requiredPermission(kind: string): ProjectPermission {
  if (kind.startsWith("deployment.")) return "deploy";
  if (kind.startsWith("task.control.")) return "control";
  if (["plan.execute", "plan.reexecute"].includes(kind)) return "control";
  return "edit";
}
async function operationPrincipal(operation: DurableOperation): Promise<ProjectIdentity> {
  // Server identities are assigned only by backend admission paths. Do not
  // reinterpret an arbitrary missing membership as host authority on restart.
  if (
    ["server:auto-deploy", "server:deployment"].includes(operation.actorId) &&
    operation.kind.startsWith("deployment.")
  ) {
    return { ...localIdentity(), actorId: operation.actorId, displayName: "Deployment automation" };
  }
  const principal = await identityService.member(operation.actorId, operation.projectId);
  identityService.require(principal, requiredPermission(operation.kind));
  return principal;
}

/** Server-owned durable work. Interrupted running effects become uncertain, never retried. */
export class OperationWorker {
  private currentOwnerId = `worker:${randomUUID()}`;
  private renewing: Promise<string> | undefined;
  get ownerId(): string {
    return this.currentOwnerId;
  }
  private handlers = new Map<string, Handler>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private active = new Map<string, Promise<DurableOperation>>();
  private scanning = false;
  register(kind: string, handler: Handler): void {
    this.handlers.set(kind, handler);
  }
  start(): void {
    if (this.timer) return;
    this.heartbeat = setInterval(() => {
      void this.renewOwnership().catch((err) => log.error("Operation heartbeat failed", { err }));
    }, 10_000);
    this.heartbeat.unref();
    this.timer = setInterval(() => {
      void this.scan().catch((err) => log.error("Operation scan failed", { err }));
    }, 1000);
    this.timer.unref();
    void this.scan().catch((err) => log.error("Operation recovery failed", { err }));
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.timer = undefined;
    this.heartbeat = undefined;
  }
  private async renewOwnership(): Promise<string> {
    if (this.renewing) return this.renewing;
    const renewing = (async () => {
      const ownerId = this.currentOwnerId;
      try {
        await operationService.heartbeatOwner(ownerId);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "OPERATION_OWNER_EXPIRED"
        )
          throw error;
        // Never resurrect an expired identity: its in-flight effects retain their
        // old fence, while new work receives a fresh independently leased owner.
        this.currentOwnerId = `worker:${randomUUID()}`;
        await operationService.heartbeatOwner(this.currentOwnerId);
        await operationService.recoverExpired();
      }
      return this.currentOwnerId;
    })();
    this.renewing = renewing;
    try {
      return await renewing;
    } finally {
      if (this.renewing === renewing) this.renewing = undefined;
    }
  }
  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.renewOwnership();
      await operationService.recoverExpired();
      for (const operation of await operationService.listQueued()) {
        if (this.handlers.has(operation.kind))
          void this.execute(operation).catch((err) =>
            log.error("Operation failed", { err, operationId: operation.id })
          );
      }
    } finally {
      this.scanning = false;
    }
  }
  async execute(
    operation: DurableOperation,
    immediate?: () => Promise<unknown>
  ): Promise<DurableOperation> {
    const existing = this.active.get(operation.id);
    if (existing) return existing;
    const handler =
      immediate ??
      (this.handlers.has(operation.kind)
        ? () => this.handlers.get(operation.kind)!(operation)
        : undefined);
    if (!handler) throw new Error(`No handler for operation kind ${operation.kind}`);
    const running = (async () => {
      const ownerId = await this.renewOwnership();
      const claimed = await operationService.claim(operation.projectId, operation.id, ownerId);
      if (!claimed) return (await operationService.get(operation.projectId, operation.id))!;
      let principal: ProjectIdentity;
      try {
        principal = await operationPrincipal(claimed);
      } catch (err) {
        // No handler ran, so revoked queued authority has a known failed outcome.
        return operationService.fail(
          operation.projectId,
          operation.id,
          ownerId,
          claimed.generation,
          `Queued operation authorization failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      try {
        const result = await runWithRequestContext(
          {
            principal,
            projectId: claimed.projectId,
            requestId: claimed.requestId,
            expectedRevision: claimed.expectedRevision ?? undefined,
          },
          () => withOperationEffect(claimed, handler)
        );
        return await operationService.complete(
          operation.projectId,
          operation.id,
          ownerId,
          claimed.generation,
          result
        );
      } catch (err) {
        await operationService.uncertain(
          operation.projectId,
          operation.id,
          ownerId,
          claimed.generation,
          err instanceof Error ? err.message : String(err)
        );
        throw err;
      }
    })();
    this.active.set(operation.id, running);
    try {
      return await running;
    } finally {
      this.active.delete(operation.id);
    }
  }
}
export const operationWorker = new OperationWorker();
