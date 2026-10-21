import { initAppDb } from "../db/app-db.js";
import type { DbClient } from "../db/client.js";
/** Real repository transactions behind tests that mock only task/agent orchestration. */
export async function createSqliteRepositoryFixture() {
  const db = await initAppDb("sqlite://:memory:");
  return {
    getDb: () => db.getClient(),
    runRead: <T>(fn: (tx: DbClient) => Promise<T>) => db.runRead!(fn),
    runWrite: <T>(fn: (tx: DbClient) => Promise<T>) => db.runWrite(fn),
  };
}
