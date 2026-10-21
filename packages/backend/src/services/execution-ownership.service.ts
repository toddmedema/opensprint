import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { DbClient, DbRow } from "../db/client.js";
import { taskStore } from "./task-store.service.js";
import { databaseNow } from "../db/database-clock.js";

export type ExecutionState =
  | "queued"
  | "running"
  | "stop_requested"
  | "stopped"
  | "completed"
  | "uncertain";
export interface ExecutionFence {
  projectId: string;
  taskId: string;
  runKey: string;
  attemptId: string;
  ownerId: string;
  generation: number;
  leaderGeneration?: number;
}
export interface ExecutionObservation extends ExecutionFence {
  state: ExecutionState;
  expiresAt: string;
}
const executionContext = new AsyncLocalStorage<ExecutionFence | undefined>();
export const backendOwnerId = randomUUID();
const DEFAULT_TTL_MS = 45_000;

export class StaleExecutionOwnerError extends Error {
  constructor() {
    super("Execution ownership expired or was replaced; mutation rejected");
  }
}

function observation(row: DbRow): ExecutionObservation {
  return {
    projectId: String(row.project_id),
    taskId: String(row.task_id),
    runKey: String(row.run_key),
    attemptId: String(row.attempt_id),
    ownerId: String(row.owner_id),
    generation: Number(row.generation),
    ...(row.leader_generation == null ? {} : { leaderGeneration: Number(row.leader_generation) }),
    state: row.state as ExecutionState,
    expiresAt: new Date(Number(row.expires_ms)).toISOString(),
  };
}

/** An UPDATE both checks the fence and locks its row until the caller's transaction commits. */
export async function assertExecutionFenceInTransaction(
  tx: DbClient,
  explicit?: ExecutionFence
): Promise<void> {
  const fence = explicit ?? executionContext.getStore();
  if (!fence) return;
  let leaderExpires: number | undefined;
  // Always lock project before attempt. Check the clock AFTER any lock wait.
  if (fence.leaderGeneration != null) {
    const leader = await tx.execute(
      `UPDATE execution_leases SET updated_at=updated_at WHERE project_id=$1
      AND run_key='__leader__' AND owner_id=$2 AND generation=$3`,
      [fence.projectId, fence.ownerId, fence.leaderGeneration]
    );
    if (leader !== 1) throw new StaleExecutionOwnerError();
    const row = await tx.queryOne(
      `SELECT expires_ms FROM execution_leases WHERE project_id=$1 AND run_key='__leader__'`,
      [fence.projectId]
    );
    leaderExpires = Number(row?.expires_ms);
  }
  const affected = await tx.execute(
    `UPDATE execution_leases SET updated_at = updated_at
    WHERE project_id=$1 AND run_key=$2 AND attempt_id=$3 AND owner_id=$4 AND generation=$5
      AND state IN ('queued','running','stop_requested','completed')`,
    [fence.projectId, fence.runKey, fence.attemptId, fence.ownerId, fence.generation]
  );
  if (affected !== 1) throw new StaleExecutionOwnerError();
  const row = await tx.queryOne(
    `SELECT expires_ms FROM execution_leases WHERE project_id=$1 AND run_key=$2`,
    [fence.projectId, fence.runKey]
  );
  const now = await databaseNow(tx);
  if (!(Number(row?.expires_ms) > now) || (leaderExpires != null && !(leaderExpires > now)))
    throw new StaleExecutionOwnerError();
}
export function withExecutionFence<T>(fence: ExecutionFence, fn: () => Promise<T>): Promise<T> {
  return executionContext.run(fence, fn);
}
export function withoutExecutionFence<T>(fn: () => Promise<T>): Promise<T> {
  return executionContext.run(undefined, fn);
}

export class ExecutionOwnershipService {
  constructor(
    private readonly injectedStore?: Pick<typeof taskStore, "runWrite" | "getDb">,
    readonly ownerId = backendOwnerId
  ) {}
  private get store(): Pick<typeof taskStore, "runWrite" | "getDb"> {
    return this.injectedStore ?? taskStore;
  }

  /** One atomic upsert handles both initial acquisition and expired-owner takeover. */
  async acquire(input: {
    projectId: string;
    taskId: string;
    runKey: string;
    attemptId: string;
    ttlMs?: number;
    leaderGeneration?: number;
    supersedes?: ExecutionFence;
  }): Promise<ExecutionFence | null> {
    if (
      input.supersedes &&
      (input.supersedes.projectId !== input.projectId ||
        input.supersedes.runKey !== input.runKey ||
        input.supersedes.ownerId !== this.ownerId)
    )
      throw new StaleExecutionOwnerError();
    return this.store.runWrite(async (tx) => {
      const now = await databaseNow(tx);
      const rows = await tx.query(
        `INSERT INTO execution_leases
        (project_id,run_key,task_id,attempt_id,owner_id,generation,expires_ms,state,updated_at,leader_generation)
        VALUES ($1,$2,$3,$4,$5,1,$6,'queued',$7,$9)
        ON CONFLICT (project_id,run_key) DO UPDATE SET
          task_id=excluded.task_id, attempt_id=excluded.attempt_id, owner_id=excluded.owner_id,
          generation=execution_leases.generation+1, expires_ms=excluded.expires_ms,
          state='queued',updated_at=excluded.updated_at,leader_generation=excluded.leader_generation
        WHERE execution_leases.expires_ms <= $8 OR execution_leases.state IN ('stopped','completed')
          OR (execution_leases.owner_id=$5 AND execution_leases.attempt_id=$10 AND execution_leases.generation=$11)
        RETURNING *`,
        [
          input.projectId,
          input.runKey,
          input.taskId,
          input.attemptId,
          this.ownerId,
          now + (input.ttlMs ?? DEFAULT_TTL_MS),
          new Date(now).toISOString(),
          now,
          input.leaderGeneration ?? null,
          input.supersedes?.attemptId ?? null,
          input.supersedes?.generation ?? null,
        ]
      );
      return rows[0] ? observation(rows[0]) : null;
    });
  }
  async assertCurrent(fence: ExecutionFence): Promise<void> {
    await this.store.runWrite((tx) => assertExecutionFenceInTransaction(tx, fence));
  }
  async fenced<T>(fence: ExecutionFence, fn: (tx: DbClient) => Promise<T>): Promise<T> {
    return this.store.runWrite(async (tx) => {
      await assertExecutionFenceInTransaction(tx, fence);
      return fn(tx);
    });
  }
  async heartbeat(fence: ExecutionFence, ttlMs = DEFAULT_TTL_MS): Promise<boolean> {
    return this.store
      .runWrite(async (tx) => {
        await assertExecutionFenceInTransaction(tx, fence);
        const now = await databaseNow(tx);
        return (
          (await tx.execute(
            `UPDATE execution_leases SET expires_ms=$1,updated_at=$2
        WHERE project_id=$3 AND run_key=$4 AND attempt_id=$5 AND owner_id=$6 AND generation=$7
          AND expires_ms > $8 AND state IN ('queued','running','stop_requested')`,
            [
              now + ttlMs,
              new Date(now).toISOString(),
              fence.projectId,
              fence.runKey,
              fence.attemptId,
              fence.ownerId,
              fence.generation,
              now,
            ]
          )) === 1
        );
      })
      .catch((err) => {
        if (err instanceof StaleExecutionOwnerError) return false;
        throw err;
      });
  }
  async transition(fence: ExecutionFence, state: ExecutionState): Promise<void> {
    await this.fenced(fence, async (tx) => {
      const affected = await tx.execute(
        `UPDATE execution_leases SET state=$1
      WHERE project_id=$2 AND run_key=$3 AND generation=$4${state === "running" ? " AND state='queued'" : ""}`,
        [state, fence.projectId, fence.runKey, fence.generation]
      );
      if (affected !== 1) throw new Error("Execution was stopped before launch");
    });
  }
  /** Serialize the final synchronous launch with cross-replica stop/takeover acceptance. */
  async launch<T>(fence: ExecutionFence, start: () => T): Promise<T> {
    // Child promises must not inherit the temporary SQL transaction's AsyncLocalStorage.
    const invocation = new AsyncResource("opensprint-execution-launch");
    try {
      return await this.fenced(fence, async (tx) => {
        const row = await tx.queryOne(
          `SELECT state FROM execution_leases WHERE project_id=$1 AND run_key=$2`,
          [fence.projectId, fence.runKey]
        );
        if (row?.state !== "running") throw new Error("Execution was stopped before launch");
        return invocation.runInAsyncScope(start);
      });
    } finally {
      invocation.emitDestroy();
    }
  }
  /** A controller on any replica may request stop; only the owner observes exit and confirms stopped. */
  async requestStop(projectId: string, attemptId: string): Promise<boolean> {
    return this.store.runWrite(
      async (tx) =>
        (await tx.execute(
          `UPDATE execution_leases SET state='stop_requested'
      WHERE project_id=$1 AND attempt_id=$2 AND state IN ('queued','running')`,
          [projectId, attemptId]
        )) > 0
    );
  }
  async observe(projectId: string, taskId?: string): Promise<ExecutionObservation[]> {
    const db = await this.store.getDb();
    const rows = await db.query(
      `SELECT * FROM execution_leases WHERE project_id=$1 AND run_key!='__leader__'${taskId ? " AND task_id=$2" : ""}`,
      taskId ? [projectId, taskId] : [projectId]
    );
    const now = await databaseNow(db);
    return rows.map((row) => {
      const run = observation(row);
      if (Number(row.expires_ms) <= now && !["stopped", "completed"].includes(run.state))
        run.state = "uncertain";
      return run;
    });
  }
}
export const executionOwnershipService = new ExecutionOwnershipService();

/** Independent PostgreSQL replicas contend on the same row, never on a PID/file. */
export class ProjectLeadershipService {
  constructor(private readonly ownership = executionOwnershipService) {}
  private readonly leases = new Map<string, ExecutionFence>();
  getFence(projectId: string): ExecutionFence | undefined {
    return this.leases.get(projectId);
  }
  async acquireOrRenew(projectId: string): Promise<boolean> {
    const old = this.leases.get(projectId);
    if (old && (await this.ownership.heartbeat(old))) return true;
    this.leases.delete(projectId);
    const next = await this.ownership.acquire({
      projectId,
      taskId: "__project__",
      runKey: "__leader__",
      attemptId: randomUUID(),
    });
    if (next) this.leases.set(projectId, next);
    return Boolean(next);
  }
  async assertCurrent(projectId: string): Promise<void> {
    const fence = this.leases.get(projectId);
    if (!fence) throw new StaleExecutionOwnerError();
    await this.ownership.assertCurrent(fence);
  }
}
export const projectLeadershipService = new ProjectLeadershipService();
