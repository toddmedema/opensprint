import { randomUUID } from "node:crypto";
import { databaseNow } from "../db/database-clock.js";
import type { DbClient, DbRow } from "../db/client.js";
import { AppError } from "../middleware/error-handler.js";
import { taskStore } from "./task-store.service.js";
import { appendProjectEvent, lockProject, stableFingerprint } from "./project-event.service.js";

export type OperationStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "uncertain"
  | "cancelled";
export interface DurableOperation {
  id: string;
  projectId: string;
  actorId: string;
  requestId: string;
  kind: string;
  target: string;
  expectedRevision: number | null;
  payload: unknown;
  status: OperationStatus;
  generation: number;
  ownerId: string | null;
  result: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface AcceptOperation {
  projectId: string;
  actorId: string;
  requestId: string;
  kind: string;
  target: string;
  expectedRevision?: number;
  payload: unknown;
}
export interface OperationStore {
  runWrite<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
  runRead<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
}
function fromRow(r: DbRow): DurableOperation {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    actorId: String(r.actor_id),
    requestId: String(r.request_id),
    kind: String(r.kind),
    target: String(r.target),
    expectedRevision: r.expected_revision == null ? null : Number(r.expected_revision),
    payload: JSON.parse(String(r.payload)),
    status: r.status as OperationStatus,
    generation: Number(r.generation),
    ownerId: r.owner_id == null ? null : String(r.owner_id),
    result: r.result == null ? null : JSON.parse(String(r.result)),
    error: r.error == null ? null : String(r.error),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}
async function renewOwner(tx: DbClient, ownerId: string, leaseMs: number): Promise<void> {
  await tx.execute(
    "INSERT INTO operation_owners (owner_id, expires_at) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [ownerId, new Date((await databaseNow(tx)) + leaseMs).toISOString()]
  );
  await tx.queryOne(
    "UPDATE operation_owners SET expires_at = expires_at WHERE owner_id = $1 RETURNING owner_id",
    [ownerId]
  );
  const now = await databaseNow(tx);
  const row = await tx.queryOne(
    "INSERT INTO operation_owners (owner_id, expires_at) VALUES ($1,$2) ON CONFLICT (owner_id) DO UPDATE SET expires_at = excluded.expires_at WHERE operation_owners.expires_at > $3 RETURNING owner_id",
    [ownerId, new Date(now + leaseMs).toISOString(), new Date(now).toISOString()]
  );
  if (!row)
    throw new AppError(409, "OPERATION_OWNER_EXPIRED", "This operation worker lease expired.");
}
export class OperationService {
  async listProject(projectId: string, limit = 50): Promise<DurableOperation[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new AppError(400, "INVALID_OPERATION_PAGE", "Limit must be between 1 and 200.");
    return this.store.runRead(async (tx) =>
      (
        await tx.query(
          "SELECT * FROM durable_operations WHERE project_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2",
          [projectId, limit]
        )
      ).map(fromRow)
    );
  }
  constructor(private readonly store: OperationStore = taskStore) {}
  async accept(input: AcceptOperation): Promise<DurableOperation> {
    if (
      ![input.projectId, input.actorId, input.requestId, input.kind, input.target].every(
        (v) => typeof v === "string" && v.length > 0 && v.length <= 256
      )
    )
      throw new AppError(
        400,
        "INVALID_OPERATION",
        "Project, actor, request, kind and target are required."
      );
    if (
      input.expectedRevision !== undefined &&
      (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
    )
      throw new AppError(400, "INVALID_OPERATION", "Invalid expected revision.");
    const fingerprint = stableFingerprint({
      ...input,
      expectedRevision: input.expectedRevision ?? null,
    });
    return this.store.runWrite(async (tx) => {
      await lockProject(tx, input.projectId);
      const existing = await tx.queryOne(
        "SELECT * FROM durable_operations WHERE project_id = $1 AND request_id = $2",
        [input.projectId, input.requestId]
      );
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new AppError(
            409,
            "OPERATION_ID_REUSED",
            "The request ID belongs to another actor or payload.",
            { operation: fromRow(existing) }
          );
        return fromRow(existing);
      }
      const now = new Date(await databaseNow(tx)).toISOString();
      const id = randomUUID();
      await tx.execute(
        "INSERT INTO durable_operations (id, project_id, actor_id, request_id, kind, target, expected_revision, fingerprint, payload, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10,$10)",
        [
          id,
          input.projectId,
          input.actorId,
          input.requestId,
          input.kind,
          input.target,
          input.expectedRevision ?? null,
          fingerprint,
          JSON.stringify(input.payload),
          now,
        ]
      );
      const operation = fromRow(
        (await tx.queryOne("SELECT * FROM durable_operations WHERE id = $1", [id]))!
      );
      await appendProjectEvent(tx, {
        projectId: input.projectId,
        actorId: input.actorId,
        type: "operation_changed",
        payload: operation,
      });
      return operation;
    });
  }
  async get(projectId: string, id: string): Promise<DurableOperation | null> {
    return this.store.runRead(async (tx) => {
      const row = await tx.queryOne(
        "SELECT * FROM durable_operations WHERE project_id = $1 AND id = $2",
        [projectId, id]
      );
      return row ? fromRow(row) : null;
    });
  }
  async getByRequestId(projectId: string, requestId: string): Promise<DurableOperation | null> {
    return this.store.runRead(async (tx) => {
      const row = await tx.queryOne(
        "SELECT * FROM durable_operations WHERE project_id = $1 AND request_id = $2",
        [projectId, requestId]
      );
      return row ? fromRow(row) : null;
    });
  }
  async claim(projectId: string, id: string, ownerId: string): Promise<DurableOperation | null> {
    return this.store.runWrite(async (tx) => {
      await lockProject(tx, projectId);
      await renewOwner(tx, ownerId, 30_000);
      const row = await tx.queryOne(
        "UPDATE durable_operations SET status = 'running', generation = generation + 1, owner_id = $3, updated_at = $4 WHERE project_id = $1 AND id = $2 AND status = 'queued' RETURNING *",
        [projectId, id, ownerId, new Date(await databaseNow(tx)).toISOString()]
      );
      if (!row) return null;
      const op = fromRow(row);
      await appendProjectEvent(tx, { projectId, type: "operation_changed", payload: op });
      return op;
    });
  }
  async complete(
    projectId: string,
    id: string,
    ownerId: string,
    generation: number,
    result: unknown
  ): Promise<DurableOperation> {
    return this.finish(projectId, id, ownerId, generation, "completed", result);
  }
  async fail(
    projectId: string,
    id: string,
    ownerId: string,
    generation: number,
    error: string
  ): Promise<DurableOperation> {
    return this.finish(projectId, id, ownerId, generation, "failed", null, error);
  }
  async uncertain(
    projectId: string,
    id: string,
    ownerId: string,
    generation: number,
    error: string
  ): Promise<DurableOperation> {
    return this.finish(projectId, id, ownerId, generation, "uncertain", null, error);
  }
  private async finish(
    projectId: string,
    id: string,
    ownerId: string,
    generation: number,
    status: OperationStatus,
    result: unknown,
    error?: string
  ): Promise<DurableOperation> {
    return this.store.runWrite(async (tx) => {
      await lockProject(tx, projectId);
      // Wait for heartbeat transactions before sampling the database clock.
      await tx.queryOne(
        "UPDATE operation_owners SET expires_at = expires_at WHERE owner_id = $1 RETURNING owner_id",
        [ownerId]
      );
      const row = await tx.queryOne(
        "UPDATE durable_operations SET status = $5, result = $6, error = $7, updated_at = $8 WHERE project_id = $1 AND id = $2 AND owner_id = $3 AND generation = $4 AND status = 'running' AND EXISTS (SELECT 1 FROM operation_owners WHERE owner_id = $3 AND expires_at > $8) RETURNING *",
        [
          projectId,
          id,
          ownerId,
          generation,
          status,
          JSON.stringify(result),
          error ?? null,
          new Date(await databaseNow(tx)).toISOString(),
        ]
      );
      if (!row)
        throw new AppError(409, "OPERATION_FENCE_LOST", "Operation ownership changed.", {
          operation: await tx.queryOne(
            "SELECT * FROM durable_operations WHERE project_id = $1 AND id = $2",
            [projectId, id]
          ),
        });
      const op = fromRow(row);
      await appendProjectEvent(tx, { projectId, type: "operation_changed", payload: op });
      return op;
    });
  }
  async heartbeatOwner(ownerId: string, leaseMs = 30_000): Promise<void> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1)
      throw new Error("Invalid operation owner lease.");
    await this.store.runWrite(async (tx) => {
      await renewOwner(tx, ownerId, leaseMs);
    });
  }
  async listQueued(limit = 100): Promise<DurableOperation[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("Invalid operation page size.");
    return this.store.runRead(async (tx) =>
      (
        await tx.query(
          "SELECT * FROM durable_operations WHERE status = 'queued' ORDER BY created_at, id LIMIT $1",
          [limit]
        )
      ).map(fromRow)
    );
  }
  /** Expired external effects remain uncertain until inspected; queued requests remain dispatchable. */
  async recoverExpired(projectId?: string): Promise<number> {
    return this.store.runWrite(async (tx) => {
      const projects = await tx.query(
        "SELECT DISTINCT project_id FROM durable_operations WHERE status = 'running' AND (CAST($1 AS TEXT) IS NULL OR project_id = $1) ORDER BY project_id",
        [projectId ?? null]
      );
      let count = 0;
      for (const project of projects) {
        const id = String(project.project_id);
        await lockProject(tx, id);
        const now = new Date(await databaseNow(tx)).toISOString();
        const rows = await tx.query(
          "UPDATE durable_operations SET status = 'uncertain', generation = generation + 1, error = 'Owner lease expired before completion was confirmed', updated_at = $2 WHERE project_id = $1 AND status = 'running' AND NOT EXISTS (SELECT 1 FROM operation_owners WHERE operation_owners.owner_id = durable_operations.owner_id AND expires_at > $2) RETURNING *",
          [id, now]
        );
        count += rows.length;
        for (const row of rows)
          await appendProjectEvent(tx, {
            projectId: id,
            type: "operation_changed",
            payload: fromRow(row),
          });
      }
      return count;
    });
  }
  /** Restart recovery never blindly retries a possibly executed external effect. */
  async recoverOwner(projectId: string, ownerId: string): Promise<number> {
    return this.store.runWrite(async (tx) => {
      await lockProject(tx, projectId);
      const rows = await tx.query(
        "UPDATE durable_operations SET status = 'uncertain', generation = generation + 1, error = 'Owner ended before completion was confirmed', updated_at = $3 WHERE project_id = $1 AND owner_id = $2 AND status = 'running' RETURNING *",
        [projectId, ownerId, new Date(await databaseNow(tx)).toISOString()]
      );
      for (const row of rows)
        await appendProjectEvent(tx, {
          projectId,
          type: "operation_changed",
          payload: fromRow(row),
        });
      return rows.length;
    });
  }
  async cancel(projectId: string, id: string): Promise<DurableOperation | null> {
    return this.store.runWrite(async (tx) => {
      await lockProject(tx, projectId);
      const row = await tx.queryOne(
        "UPDATE durable_operations SET status = 'cancelled', generation = generation + 1, updated_at = $3 WHERE project_id = $1 AND id = $2 AND status = 'queued' RETURNING *",
        [projectId, id, new Date(await databaseNow(tx)).toISOString()]
      );
      if (!row) return null;
      const op = fromRow(row);
      await appendProjectEvent(tx, { projectId, type: "operation_changed", payload: op });
      return op;
    });
  }
}
export const operationService = new OperationService();
