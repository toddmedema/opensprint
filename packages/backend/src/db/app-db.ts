import pg from "pg";
import type { DbClient } from "./client.js";
import { createPostgresDbClient, getPoolConfig } from "./client.js";
import { runSchema } from "./schema.js";

export interface AppDb {
  getClient(): Promise<DbClient>;
  runWrite<T>(fn: (client: DbClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Tag app connections so task_delete_audit and PG logs show application_name=opensprint-app. */
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
  // #region agent log — initAppDb connection verification
  fetch("http://127.0.0.1:7244/ingest/7b4dbb83-aede-4af0-b5cc-f2f84134fedd",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"743c0d"},body:JSON.stringify({sessionId:"743c0d",location:"app-db.ts:initAppDb",message:"initAppDb_connection",data:{pid:process.pid,hasAppName:urlWithAppName.includes("application_name"),appNameInUrl:urlWithAppName.includes("opensprint-app")},timestamp:Date.now(),hypothesisId:"H2"})}).catch(()=>{});
  // #endregion
  const pool = new pg.Pool(getPoolConfig(urlWithAppName));
  const client = createPostgresDbClient(pool);
  await runSchema(client);

  // #region agent log — verify application_name is set on the connection
  try {
    const _row = await client.queryOne("SELECT current_setting('application_name', true) AS app_name, current_database() AS db");
    fetch("http://127.0.0.1:7244/ingest/7b4dbb83-aede-4af0-b5cc-f2f84134fedd",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"743c0d"},body:JSON.stringify({sessionId:"743c0d",location:"app-db.ts:initAppDb",message:"initAppDb_verified",data:{pid:process.pid,appName:(_row?.app_name as string)??"?",database:(_row?.db as string)??"?"},timestamp:Date.now(),hypothesisId:"H2"})}).catch(()=>{});
  } catch {}
  // #endregion

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
