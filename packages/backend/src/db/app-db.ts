import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import type { DbClient } from "./client.js";
import { createPostgresDbClient, getPoolConfig } from "./client.js";
import { runSchema } from "./schema.js";
import { createSqliteDbClient, openSqliteDatabase, resolveSqlitePath } from "./sqlite-client.js";
import { getDatabaseDialect } from "@opensprint/shared";
import { migratePlanVersions } from "../services/migrate-plan-versions.service.js";

// Drizzle is loaded dynamically in initPostgresAppDb so Vitest can load this file without resolving drizzle-orm.
// Type matches the return of drizzle({ client, schema }) from drizzle-orm/node-postgres.
export type DrizzlePg = import("drizzle-orm/node-postgres").NodePgDatabase<Record<string, unknown>>;

// Stable database-scoped key shared by every backend's PostgreSQL schema initializer.
export const POSTGRES_SCHEMA_LOCK_KEY = [0x4f535052, 0x5343484d] as const;

export interface AppDb {
  getClient(): Promise<DbClient>;
  runWrite<T>(fn: (client: DbClient) => Promise<T>): Promise<T>;
  /** Coherent snapshot; SQLite shares the connection lock with every writer. */
  runRead?<T>(fn: (client: DbClient) => Promise<T>): Promise<T>;
  /** Serialize a group of operations without opening a transaction (e.g. VACUUM). */
  runExclusive?<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
  /** When using Postgres, returns a Drizzle instance for type-safe queries. Null for SQLite. */
  getDrizzle?(): Promise<DrizzlePg | null>;
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

async function initPostgresAppDb(databaseUrl: string): Promise<AppDb> {
  const [{ drizzle }, schemaModule] = await Promise.all([
    import("drizzle-orm/node-postgres"),
    import("./drizzle-schema-pg.js"),
  ]);
  const urlWithAppName = addApplicationName(databaseUrl, "opensprint-app");
  const pool = new pg.Pool(getPoolConfig(urlWithAppName));
  const client = createPostgresDbClient(pool);
  try {
    await client.runInTransaction(async (tx) => {
      // IF NOT EXISTS alone does not serialize concurrent PostgreSQL catalog writes.
      await tx.query("SELECT pg_advisory_xact_lock($1, $2)", [...POSTGRES_SCHEMA_LOCK_KEY]);
      await runSchema(tx, "postgres");
      await migratePlanVersions(tx);
    });
    const drizzleInstance = drizzle({ client: pool, schema: schemaModule });
    return {
      async getClient(): Promise<DbClient> {
        return client;
      },
      async runWrite<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
        return client.runInTransaction(fn);
      },
      async runRead<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
        return client.runInTransaction(async (tx) => {
          await tx.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
          return fn(tx);
        });
      },
      async close(): Promise<void> {
        await pool.end();
      },
      async getDrizzle(): Promise<DrizzlePg | null> {
        return drizzleInstance;
      },
    };
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
}

const sqliteInitializations = new Map<string, Promise<void>>();
async function initSqliteAppDb(databaseUrl: string): Promise<AppDb> {
  const resolved = resolveSqlitePath(databaseUrl);
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const previous = sqliteInitializations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const queued = new Promise<void>((resolve) => {
    release = resolve;
  });
  sqliteInitializations.set(key, queued);
  await previous;
  try {
    return await openInitializedSqliteAppDb(databaseUrl);
  } finally {
    release();
    if (sqliteInitializations.get(key) === queued) sqliteInitializations.delete(key);
  }
}

async function openInitializedSqliteAppDb(databaseUrl: string): Promise<AppDb> {
  const { db, close } = await openSqliteDatabase(databaseUrl);
  const client = createSqliteDbClient(db);
  try {
    await client.runInTransaction(async (tx) => {
      await runSchema(tx, "sqlite");
      await migratePlanVersions(tx);
    });
  } catch (error) {
    try {
      close();
    } catch {
      /* Preserve the migration failure. */
    }
    throw error;
  }

  // All repositories use the same SQLite connection. A service-local mutex cannot
  // prevent another repository from entering a transaction or seeing uncommitted
  // writes on that connection. Keep the lock at its owner and make nested use safe.
  const scope = new AsyncLocalStorage<{ active: boolean; transactionTail: Promise<void> }>();
  const transactionScope = new AsyncLocalStorage<{ active: boolean; client: DbClient }>();
  let tail = Promise.resolve();
  const runExclusive = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (scope.getStore()?.active) return fn();
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const context = { active: true, transactionTail: Promise.resolve() };
    try {
      return await scope.run(context, fn);
    } finally {
      context.active = false;
      release();
    }
  };
  const runTransaction = <T>(fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    runExclusive(async () => {
      const context = scope.getStore()!;
      const inherited = transactionScope.getStore();
      if (inherited?.active) return fn(inherited.client);
      // Sibling transactions inside runExclusive must still queue. Only calls
      // descended from the transaction callback may reuse that transaction.
      const previous = context.transactionTail;
      let release!: () => void;
      context.transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await client.runInTransaction(async (tx) => {
          const transaction = { active: true, client: tx };
          try {
            return await transactionScope.run(transaction, () => fn(tx));
          } finally {
            transaction.active = false;
          }
        });
      } finally {
        release();
      }
    });
  const currentClient = () => {
    const transaction = transactionScope.getStore();
    return transaction?.active ? transaction.client : client;
  };
  const sharedClient: DbClient = {
    dialect: "sqlite",
    query: (sql, params) => runExclusive(() => currentClient().query(sql, params)),
    queryOne: (sql, params) => runExclusive(() => currentClient().queryOne(sql, params)),
    execute: (sql, params) => runExclusive(() => currentClient().execute(sql, params)),
    runInTransaction: runTransaction,
  };

  return {
    async getClient(): Promise<DbClient> {
      return sharedClient;
    },
    async runWrite<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
      return runTransaction(fn);
    },
    runRead: runTransaction,
    runExclusive,
    async close(): Promise<void> {
      close();
    },
  };
}

export async function initAppDb(databaseUrl: string): Promise<AppDb> {
  const dialect = getDatabaseDialect(databaseUrl);
  if (dialect === "sqlite") {
    return initSqliteAppDb(databaseUrl);
  }
  return initPostgresAppDb(databaseUrl);
}
