import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { initAppDb, POSTGRES_SCHEMA_LOCK_KEY, type AppDb } from "../db/app-db.js";
import { getTestDatabaseUrl } from "./test-db-helper.js";
import { ExecutionOwnershipService } from "../services/execution-ownership.service.js";
import { ExecutionOutputService } from "../services/execution-output.service.js";
import type { DbClient } from "../db/client.js";

describe("concurrent PostgreSQL application initialization", () => {
  it("reads output metadata and retained chunks from the same snapshot during concurrent append", async () => {
    const db = await initAppDb(await getTestDatabaseUrl());
    const projectId = `output-snapshot-${randomUUID()}`;
    const store = {
      runWrite: db.runWrite.bind(db),
      runRead: db.runRead!.bind(db),
      getDb: db.getClient.bind(db),
    };
    const output = new ExecutionOutputService(store, 64 * 1024);
    try {
      const fence = (await new ExecutionOwnershipService(store, "writer").acquire({
        projectId,
        taskId: "task",
        runKey: "task:coding",
        attemptId: "attempt",
      }))!;
      await output.append(fence, "a".repeat(64 * 1024));
      let appended = false;
      const interleave = (tx: DbClient): DbClient => ({
        ...tx,
        queryOne: async (sql, params) => {
          const row = await tx.queryOne(sql, params);
          if (!appended && sql.includes("SELECT * FROM execution_output_streams")) {
            appended = true;
            // This independent transaction deletes the old chunk between the reader's queries.
            await output.append(fence, "b".repeat(64 * 1024));
          }
          return row;
        },
      });
      const reader = new ExecutionOutputService({
        getDb: store.getDb,
        runWrite: (fn) => store.runWrite((tx) => fn(interleave(tx))),
        runRead: (fn) => store.runRead((tx) => fn(interleave(tx))),
      });
      expect(await reader.read(projectId, fence.attemptId)).toMatchObject({
        status: "ok",
        content: "a".repeat(64 * 1024),
        startOffset: 0,
        endOffset: 64 * 1024,
        nextOffset: 64 * 1024,
      });
      expect(appended).toBe(true);
      expect(await output.read(projectId, fence.attemptId)).toMatchObject({
        status: "offset_expired",
        nextOffset: 64 * 1024,
      });
    } finally {
      try {
        const client = await db.getClient();
        for (const table of [
          "execution_output_chunks",
          "execution_output_streams",
          "execution_leases",
        ])
          await client.execute(`DELETE FROM ${table} WHERE project_id=$1`, [projectId]);
      } finally {
        await db.close();
      }
    }
  });

  it("serializes fresh-schema DDL and legacy plan migration across independent pools", async () => {
    const url = new URL(await getTestDatabaseUrl());
    const admin = new pg.Pool({ connectionString: url.toString() });
    const namespace = "app_init_" + randomUUID().replaceAll("-", "");
    url.searchParams.set("options", `-c search_path=${namespace}`);
    const initialized: AppDb[] = [];
    let blocker: pg.PoolClient | undefined;
    let pending: Promise<PromiseSettledResult<AppDb>[]> | undefined;
    try {
      await admin.query(`CREATE SCHEMA "${namespace}"`);
      blocker = await admin.connect();
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock($1, $2)", [...POSTGRES_SCHEMA_LOCK_KEY]);
      pending = Promise.allSettled([initAppDb(url.toString()), initAppDb(url.toString())]);
      await vi.waitFor(
        async () => {
          const locks = await admin.query(
            "SELECT COUNT(*) AS count FROM pg_locks WHERE locktype='advisory' AND classid=$1::oid AND objid=$2::oid AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND NOT granted",
            [...POSTGRES_SCHEMA_LOCK_KEY]
          );
          expect(Number(locks.rows[0]?.count)).toBeGreaterThanOrEqual(2);
        },
        { timeout: 15_000, interval: 50 }
      );
      await blocker.query("COMMIT");
      blocker.release();
      blocker = undefined;
      const results = await pending;
      pending = undefined;
      for (const result of results) {
        if (result.status === "fulfilled") initialized.push(result.value);
      }
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      const client = await initialized[0]!.getClient();
      expect(
        Number((await client.queryOne("SELECT COUNT(*) AS count FROM schema_versions"))?.count)
      ).toBeGreaterThan(0);
      await client.execute("ALTER TABLE plans ALTER COLUMN current_version_number DROP NOT NULL");
      await client.execute(
        "INSERT INTO plans (project_id,plan_id,epic_id,content,metadata,updated_at,current_version_number) VALUES ($1,$2,'legacy-epic',$3,$4,$5,NULL)",
        ["startup", "legacy", "# Legacy plan", "{}", new Date().toISOString()]
      );
      const migrated = await Promise.allSettled([
        initAppDb(url.toString()),
        initAppDb(url.toString()),
      ]);
      for (const result of migrated) {
        if (result.status === "fulfilled") initialized.push(result.value);
      }
      expect(migrated.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      const versions = await client.query(
        "SELECT version_number FROM plan_versions WHERE project_id=$1 AND plan_id=$2",
        ["startup", "legacy"]
      );
      expect(versions).toEqual([{ version_number: 1 }]);
      expect(
        await client.queryOne(
          "SELECT current_version_number FROM plans WHERE project_id=$1 AND plan_id=$2",
          ["startup", "legacy"]
        )
      ).toEqual({ current_version_number: 1 });
    } finally {
      if (blocker) {
        await blocker.query("ROLLBACK").catch(() => {});
        blocker.release();
      }
      if (pending)
        for (const result of await pending) {
          if (result.status === "fulfilled") initialized.push(result.value);
        }
      try {
        await Promise.all(initialized.map((db) => db.close()));
        await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      } finally {
        await admin.end();
      }
    }
  }, 45_000);
});
