import { beforeEach, afterEach, describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { createSqliteDbClient } from "../db/sqlite-client.js";
import { EXECUTION_SCHEMA_SQL } from "../db/execution-schema.js";
import {
  ExecutionOwnershipService,
  ProjectLeadershipService,
  assertExecutionFenceInTransaction,
  withExecutionFence,
} from "../services/execution-ownership.service.js";
import { ExecutionOutputService } from "../services/execution-output.service.js";
import type { DbClient } from "../db/client.js";

describe("database execution fencing", () => {
  let db: Database.Database, client: DbClient;
  let store: {
    runWrite: <T>(fn: (tx: DbClient) => Promise<T>) => Promise<T>;
    runRead: <T>(fn: (tx: DbClient) => Promise<T>) => Promise<T>;
    getDb: () => Promise<DbClient>;
  };
  let first: ExecutionOwnershipService, second: ExecutionOwnershipService;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(EXECUTION_SCHEMA_SQL);
    client = createSqliteDbClient(db);
    let queue = Promise.resolve();
    store = {
      getDb: async () => client,
      runRead: (fn) => store.runWrite(fn),
      runWrite: <T>(fn: (tx: DbClient) => Promise<T>) => {
        const result = queue.then(() => client.runInTransaction(fn));
        queue = result.then(
          () => {},
          () => {}
        );
        return result;
      },
    };
    first = new ExecutionOwnershipService(store, "backend-a");
    second = new ExecutionOwnershipService(store, "backend-b");
  });
  afterEach(() => db.close());
  const input = { projectId: "p", taskId: "t", runKey: "t:coding", attemptId: "attempt-a" };
  it("admits only one concurrent owner and never confuses backend identity with a PID", async () => {
    const claims = await Promise.all([
      first.acquire(input),
      second.acquire({ ...input, attemptId: "attempt-b" }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.ownerId).toBe("backend-a");
  });
  it("increments the generation on takeover and rejects stale heartbeat, transition, output and result writes", async () => {
    const old = (await first.acquire(input))!;
    await client.execute("UPDATE execution_leases SET expires_ms=0");
    const current = (await second.acquire({ ...input, attemptId: "attempt-b" }))!;
    expect(current.generation).toBe(old.generation + 1);
    expect(await first.heartbeat(old)).toBe(false);
    await expect(first.transition(old, "completed")).rejects.toThrow("ownership");
    await expect(new ExecutionOutputService(store).append(old, "obsolete")).rejects.toThrow(
      "ownership"
    );
    await expect(
      withExecutionFence(old, () =>
        store.runWrite(async (tx) => {
          await assertExecutionFenceInTransaction(tx);
          await tx.execute("UPDATE execution_leases SET state='completed'");
        })
      )
    ).rejects.toThrow("ownership");
    expect((await second.observe("p", "t"))[0]?.state).toBe("queued");
  });
  it("fences an otherwise current attempt after project leadership changes", async () => {
    const leaderA = new ProjectLeadershipService(first),
      leaderB = new ProjectLeadershipService(second);
    expect(await leaderA.acquireOrRenew("p")).toBe(true);
    expect(await leaderB.acquireOrRenew("p")).toBe(false);
    const run = (await first.acquire({
      ...input,
      leaderGeneration: leaderA.getFence("p")!.generation,
    }))!;
    await client.execute("UPDATE execution_leases SET expires_ms=0 WHERE run_key='__leader__'");
    expect(await leaderB.acquireOrRenew("p")).toBe(true);
    await expect(first.assertCurrent(run)).rejects.toThrow("ownership");
  });
  it("reports uncertain expired execution and observes stop request separately from completion", async () => {
    const run = (await first.acquire(input))!;
    await first.transition(run, "running");
    expect(await second.requestStop("p", run.attemptId)).toBe(true);
    expect((await first.observe("p", "t"))[0]?.state).toBe("stop_requested");
    await first.transition(run, "stopped");
    expect((await first.observe("p", "t"))[0]?.state).toBe("stopped");
    const next = (await second.acquire({ ...input, attemptId: "next" }))!;
    await client.execute("UPDATE execution_leases SET expires_ms=0 WHERE attempt_id=$1", [
      next.attemptId,
    ]);
    expect((await second.observe("p", "t"))[0]?.state).toBe("uncertain");
  });
  it("retains bounded durable byte offsets across readers, distinguishes expired offsets and rejects invalid UTF-8 boundaries", async () => {
    const run = (await first.acquire(input))!;
    const output = new ExecutionOutputService(store, 64 * 1024);
    await output.append(run, "a".repeat(64 * 1024));
    await output.append(run, "b".repeat(64 * 1024));
    const fresh = new ExecutionOutputService(store);
    expect(await fresh.read("p", run.attemptId, 0)).toMatchObject({
      status: "offset_expired",
      nextOffset: 64 * 1024,
    });
    expect(await fresh.read("p", run.attemptId, 64 * 1024)).toMatchObject({
      status: "ok",
      content: "b".repeat(64 * 1024),
      nextOffset: 128 * 1024,
    });
    await output.append(run, "😀");
    await expect(fresh.read("p", run.attemptId, 128 * 1024 + 1)).rejects.toThrow("UTF-8");
    expect((await fresh.read("other", run.attemptId)).status).toBe("unknown_attempt");
  });
});
