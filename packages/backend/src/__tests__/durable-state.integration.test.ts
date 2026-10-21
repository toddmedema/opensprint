import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestPostgresClient } from "./test-db-helper.js";
import { TaskStoreService } from "../services/task-store.service.js";
import { OperationService } from "../services/operation.service.js";
import { CollaborationService } from "../services/collaboration.service.js";
import { lockProject, appendProjectEvent } from "../services/project-event.service.js";
import { databaseNow } from "../db/database-clock.js";
import type { DbClient } from "../db/client.js";
import {
  assertDeploymentOperation,
  withOperationEffect,
} from "../services/operation-effect-context.js";

const first = await createTestPostgresClient();
const second = first ? await createTestPostgresClient() : null;
if (process.env.CI && (!first || !second))
  throw new Error("Durable-state PostgreSQL concurrency tests require the CI test database.");
const describeDb = first && second ? describe : describe.skip;

describeDb("PostgreSQL durable state across independent server pools", () => {
  const projectId = `durable-${randomUUID()}`;
  const a = first ? new TaskStoreService(first.client) : null;
  const b = second ? new TaskStoreService(second.client) : null;
  afterAll(async () => {
    if (first) {
      await first.client.execute(
        "DELETE FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE project_id = $1)",
        [projectId]
      );
      for (const table of [
        "tasks",
        "resource_revisions",
        "collaboration_events",
        "collaboration_commands",
        "collaboration_projects",
        "durable_operations",
      ])
        await first.client.execute(`DELETE FROM ${table} WHERE project_id = $1`, [projectId]);
      await first.pool.end();
    }
    if (second) await second.pool.end();
  });

  it("serializes version checks and event cursor allocation across connections", async () => {
    await a!.init();
    await b!.init();
    const task = await a!.create(projectId, "Original");
    const commands = await Promise.allSettled([
      a!.updateCollaboratively(
        projectId,
        task.id,
        { title: "Alice" },
        { actorId: "alice", requestId: "edit-a", expectedRevision: 1 }
      ),
      b!.updateCollaboratively(
        projectId,
        task.id,
        { title: "Bob" },
        { actorId: "bob", requestId: "edit-b", expectedRevision: 1 }
      ),
    ]);
    expect(commands.filter((command) => command.status === "fulfilled")).toHaveLength(1);
    expect(commands.find((command) => command.status === "rejected")).toMatchObject({
      reason: { statusCode: 409, details: { revision: 2 } },
    });
    const replay = await new CollaborationService(a!).replay(projectId);
    expect(replay.events.map((event) => event.cursor)).toEqual([1, 2]);
    expect((await b!.show(projectId, task.id)).revision).toBe(2);
  });

  it("does not allocate a later committed cursor while an earlier mutation is uncommitted", async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = a!.runWrite(async (tx) => {
      await lockProject(tx, projectId);
      await appendProjectEvent(tx, { projectId, type: "held", payload: {} });
      entered();
      await gate;
    });
    await started;
    let committed = false;
    const later = b!
      .runWrite(async (tx) => {
        await appendProjectEvent(tx, { projectId, type: "later", payload: {} });
      })
      .then(() => {
        committed = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(committed).toBe(false);
    release();
    await Promise.all([held, later]);
    const replay = await new CollaborationService(a!).replay(projectId);
    expect(replay.events.slice(-2).map((event) => event.type)).toEqual(["held", "later"]);
    expect(replay.events.map((event) => event.cursor)).toEqual(
      replay.events.map((_, index) => index + 1)
    );
  });

  it("permits one operation claim and rejects the prior owner after lease recovery", async () => {
    const operationsA = new OperationService(a!);
    const operationsB = new OperationService(b!);
    const input = {
      projectId,
      actorId: "alice",
      requestId: "deploy",
      kind: "deploy",
      target: "main",
      payload: {},
    };
    const accepted = await Promise.all([operationsA.accept(input), operationsB.accept(input)]);
    expect(accepted[0].id).toBe(accepted[1].id);
    const claims = await Promise.all([
      operationsA.claim(projectId, accepted[0].id, `a-${projectId}`),
      operationsB.claim(projectId, accepted[0].id, `b-${projectId}`),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(Boolean)!;
    await first!.client.execute("UPDATE operation_owners SET expires_at = $1 WHERE owner_id = $2", [
      "2000-01-01T00:00:00.000Z",
      claim.ownerId,
    ]);
    expect(await operationsB.recoverExpired(projectId)).toBe(1);
    await expect(
      operationsA.complete(projectId, claim.id, claim.ownerId!, claim.generation, {})
    ).rejects.toMatchObject({ code: "OPERATION_FENCE_LOST" });
    expect(await operationsB.get(projectId, claim.id)).toMatchObject({ status: "uncertain" });
  });

  it("rejects a deployment write when its lease expires while waiting for the owner row", async () => {
    const operationsA = new OperationService(a!);
    const operationsB = new OperationService(b!);
    const accepted = await operationsA.accept({
      projectId,
      actorId: "alice",
      requestId: "deployment-wait-expiry",
      kind: "deployment.run",
      target: "main",
      payload: {},
    });
    const claim = (await operationsA.claim(projectId, accepted.id, `wait-${projectId}`))!;
    const expiresMs = (await databaseNow(first!.client)) + 1500;
    await first!.client.execute("UPDATE operation_owners SET expires_at=$1 WHERE owner_id=$2", [
      new Date(expiresMs).toISOString(),
      claim.ownerId,
    ]);
    let held!: () => void;
    let proceed!: () => void;
    let blockerPid: number;
    const ownerLocked = new Promise<void>((resolve) => {
      held = resolve;
    });
    const waitingForOwner = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const heartbeat = a!.runWrite(async (tx) => {
      blockerPid = Number((await tx.queryOne("SELECT pg_backend_pid() AS pid"))!.pid);
      await tx.execute("UPDATE operation_owners SET expires_at=expires_at WHERE owner_id=$1", [
        claim.ownerId,
      ]);
      held();
      await waitingForOwner;
      // A real database wait crosses the fixed expiry while this connection owns the row lock.
      await tx.query(
        "SELECT pg_sleep(GREATEST(0.0, ($1::double precision - EXTRACT(EPOCH FROM clock_timestamp()) * 1000) / 1000.0))",
        [expiresMs + 50]
      );
    });
    await ownerLocked;
    const mutation = vi.fn(async (tx: DbClient) => {
      await assertDeploymentOperation(tx, projectId);
      await tx.execute("UPDATE durable_operations SET result=$2 WHERE id=$1", [
        claim.id,
        JSON.stringify({ unexpectedWrite: true }),
      ]);
    });
    const write = withOperationEffect(claim, () => b!.runWrite(mutation));
    const rejected = expect(write).rejects.toMatchObject({ code: "DEPLOYMENT_OWNER_LOST" });
    try {
      // The ownership fence runs before the callback. Observe the real database
      // wait instead of relying on a signal from a callback that must not run.
      await vi.waitFor(
        async () => {
          const blocked = await first!.client.queryOne(
            "SELECT COUNT(*) AS count FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))",
            [blockerPid]
          );
          expect(Number(blocked?.count)).toBeGreaterThan(0);
        },
        { timeout: 5000 }
      );
    } finally {
      proceed();
      // Always release/drain the writer, including failed assertions, so pool
      // teardown cannot hang on an abandoned transaction.
      await Promise.all([heartbeat, rejected]);
    }
    expect(mutation).not.toHaveBeenCalled();
    expect(await databaseNow(second!.client)).toBeGreaterThan(expiresMs);
    expect(await operationsB.get(projectId, claim.id)).toMatchObject({
      status: "running",
      result: null,
    });
  });
});
