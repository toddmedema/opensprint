/**
 * DbClient abstraction for database access.
 * Supports PostgreSQL via pg.Pool. Uses $1, $2, ... parameter substitution.
 * No sql.js types.
 */

import type { Pool, PoolClient } from "pg";

/** Row returned from a query (column names as keys). */
export type DbRow = Record<string, unknown>;

/**
 * Client interface for executing SQL queries.
 * SQL uses $1, $2, ... placeholders; params are passed as an array.
 */
export interface DbClient {
  /**
   * Execute a query and return all rows.
   * @param sql - SQL with $1, $2, ... placeholders
   * @param params - Values for placeholders
   */
  query(sql: string, params?: unknown[]): Promise<DbRow[]>;

  /**
   * Execute a query and return the first row, or undefined if none.
   * @param sql - SQL with $1, $2, ... placeholders
   * @param params - Values for placeholders
   */
  queryOne(sql: string, params?: unknown[]): Promise<DbRow | undefined>;

  /**
   * Execute a statement (INSERT/UPDATE/DELETE) and return the number of rows affected.
   */
  execute(sql: string, params?: unknown[]): Promise<number>;

  /**
   * Run a function inside a transaction. The function receives a client
   * scoped to the transaction (same query/queryOne API).
   * On success, the transaction is committed. On throw, it is rolled back.
   */
  runInTransaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T>;
}

/**
 * Create a DbClient from a pg Pool. Uses the pool for queries.
 * runInTransaction acquires a client from the pool, runs BEGIN/fn/COMMIT or ROLLBACK.
 */
export function createPostgresDbClient(pool: Pool): DbClient {
  const clientFromPool = (client: PoolClient): DbClient => ({
    async query(sql: string, params?: unknown[]): Promise<DbRow[]> {
      const result = await client.query(sql, params ?? []);
      return (result.rows as DbRow[]) ?? [];
    },
    async queryOne(sql: string, params?: unknown[]): Promise<DbRow | undefined> {
      const result = await client.query(sql, params ?? []);
      const rows = result.rows as DbRow[];
      return rows.length > 0 ? rows[0] : undefined;
    },
    async execute(sql: string, params?: unknown[]): Promise<number> {
      const result = await client.query(sql, params ?? []);
      return result.rowCount ?? 0;
    },
    async runInTransaction<T>(fn: (txClient: DbClient) => Promise<T>): Promise<T> {
      // Already in a transaction; reuse this client
      return fn(clientFromPool(client));
    },
  });

  return {
    async query(sql: string, params?: unknown[]): Promise<DbRow[]> {
      const result = await pool.query(sql, params ?? []);
      return (result.rows as DbRow[]) ?? [];
    },
    async queryOne(sql: string, params?: unknown[]): Promise<DbRow | undefined> {
      const result = await pool.query(sql, params ?? []);
      const rows = result.rows as DbRow[];
      return rows.length > 0 ? rows[0] : undefined;
    },
    async execute(sql: string, params?: unknown[]): Promise<number> {
      const result = await pool.query(sql, params ?? []);
      return result.rowCount ?? 0;
    },
    async runInTransaction<T>(fn: (txClient: DbClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const txClient = clientFromPool(client);
        const result = await fn(txClient);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Build pool options from connection string and optional env (for production tuning).
 * Env: PG_POOL_MAX, PG_POOL_IDLE_TIMEOUT_MS, PG_POOL_CONNECTION_TIMEOUT_MS.
 */
export function getPoolConfig(connectionString: string): {
  connectionString: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
} {
  const config: {
    connectionString: string;
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
  } = { connectionString };
  const max = process.env.PG_POOL_MAX;
  if (max != null && max !== "") {
    const n = parseInt(max, 10);
    if (!Number.isNaN(n)) config.max = n;
  }
  const idle = process.env.PG_POOL_IDLE_TIMEOUT_MS;
  if (idle != null && idle !== "") {
    const n = parseInt(idle, 10);
    if (!Number.isNaN(n)) config.idleTimeoutMillis = n;
  }
  const conn = process.env.PG_POOL_CONNECTION_TIMEOUT_MS;
  if (conn != null && conn !== "") {
    const n = parseInt(conn, 10);
    if (!Number.isNaN(n)) config.connectionTimeoutMillis = n;
  }
  return config;
}

/**
 * Create a PostgresDbClient from a database URL.
 * The pool is created from the URL; caller is responsible for closing it via pool.end().
 */
export async function createPostgresDbClientFromUrl(
  databaseUrl: string
): Promise<{ client: DbClient; pool: Pool }> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool(getPoolConfig(databaseUrl));
  const client = createPostgresDbClient(pool);
  return { client, pool };
}
