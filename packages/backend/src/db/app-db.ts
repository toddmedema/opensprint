import pg from "pg";
import type { DbClient } from "./client.js";
import { createPostgresDbClient, getPoolConfig } from "./client.js";
import { runSchema } from "./schema.js";

export interface AppDb {
  getClient(): Promise<DbClient>;
  runWrite<T>(fn: (client: DbClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Tag app connections so PG logs show application_name=opensprint-app. */
function addApplicationName(url: string, name: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("application_name", name);
    return u.toString();
  } catch {
    return url;
  }
}

export async function initAppDb(databaseUrl: string): Promise<AppDb> {
  const urlWithAppName = addApplicationName(databaseUrl, "opensprint-app");
  const pool = new pg.Pool(getPoolConfig(urlWithAppName));
  const client = createPostgresDbClient(pool);
  await runSchema(client);

  return {
    async getClient(): Promise<DbClient> {
      return client;
    },
    async runWrite<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
      return client.runInTransaction(fn);
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
