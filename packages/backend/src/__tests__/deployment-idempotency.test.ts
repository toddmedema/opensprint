import Database from "better-sqlite3";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import type { DbClient } from "../db/client.js";
import { createSqliteDbClient } from "../db/sqlite-client.js";
import { runSchema } from "../db/schema.js";
const state = vi.hoisted(() => ({ db: null as unknown as DbClient }));
vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    getDb: async () => state.db,
    runWrite: <T>(fn: (db: DbClient) => Promise<T>) => state.db.runInTransaction(fn),
  },
}));
import { DeployStorageService } from "../services/deploy-storage.service.js";
let native: Database.Database;
beforeEach(async () => {
  native = new Database(":memory:");
  state.db = createSqliteDbClient(native);
  await runSchema(state.db, "sqlite");
});
afterEach(() => native.close());
it("uses one durable deployment record and one launch claim across service restarts", async () => {
  const first = new DeployStorageService();
  const options = {
    commitHash: "reviewed-head",
    target: "production",
    mode: "custom" as const,
    idempotencyKey: "job:production",
  };
  const one = await first.createRecord("project", null, options);
  const restarted = new DeployStorageService();
  const two = await restarted.createRecord("project", null, options);
  expect(two.id).toBe(one.id);
  expect(await first.claimIdempotentRun("project", one.id)).toBe(true);
  expect(await restarted.claimIdempotentRun("project", two.id)).toBe(false);
  expect((await restarted.getRecord("project", two.id))?.status).toBe("running");
  expect(
    (await state.db.query("SELECT id FROM deployments WHERE project_id='project'")).length
  ).toBe(1);
});
