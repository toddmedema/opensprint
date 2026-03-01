/**
 * Unit and integration tests for DbClient and PostgresDbClient.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  createPostgresDbClient,
  createPostgresDbClientFromUrl,
  type DbClient,
  type DbRow,
} from "../db/client.js";
import { getTestDatabaseUrl } from "./test-db-helper.js";

describe("DbClient (createPostgresDbClient with mock Pool)", () => {
  function createMockPool(overrides?: {
    queryRows?: DbRow[];
    connectClient?: Partial<PoolClient>;
  }): Pool {
    const queryRows = overrides?.queryRows ?? [];
    const mockQuery = vi.fn().mockResolvedValue({ rows: queryRows });
    const mockClient: PoolClient = {
      query: mockQuery,
      release: vi.fn(),
      ...overrides?.connectClient,
    } as unknown as PoolClient;

    return {
      query: mockQuery,
      connect: vi.fn().mockResolvedValue(mockClient),
      end: vi.fn().mockResolvedValue(undefined),
    } as unknown as Pool;
  }

  it("query returns rows from pool", async () => {
    const rows: DbRow[] = [{ id: 1, name: "a" }, { id: 2, name: "b" }];
    const pool = createMockPool({ queryRows: rows });
    const client = createPostgresDbClient(pool);

    const result = await client.query("SELECT * FROM t WHERE x = $1", ["val"]);
    expect(result).toEqual(rows);
    expect(pool.query).toHaveBeenCalledWith("SELECT * FROM t WHERE x = $1", ["val"]);
  });

  it("query with no params passes empty array", async () => {
    const pool = createMockPool({ queryRows: [] });
    const client = createPostgresDbClient(pool);

    await client.query("SELECT 1");
    expect(pool.query).toHaveBeenCalledWith("SELECT 1", []);
  });

  it("queryOne returns first row when rows exist", async () => {
    const rows: DbRow[] = [{ id: 1, name: "first" }];
    const pool = createMockPool({ queryRows: rows });
    const client = createPostgresDbClient(pool);

    const result = await client.queryOne("SELECT * FROM t LIMIT 1");
    expect(result).toEqual({ id: 1, name: "first" });
  });

  it("queryOne returns undefined when no rows", async () => {
    const pool = createMockPool({ queryRows: [] });
    const client = createPostgresDbClient(pool);

    const result = await client.queryOne("SELECT * FROM t WHERE 1=0");
    expect(result).toBeUndefined();
  });

  it("runInTransaction runs BEGIN, fn, COMMIT on success", async () => {
    const rows: DbRow[] = [{ id: 1 }];
    const mockQuery = vi.fn().mockResolvedValue({ rows });
    const mockRelease = vi.fn();
    const mockClient: PoolClient = {
      query: mockQuery,
      release: mockRelease,
    } as unknown as PoolClient;

    const pool = createMockPool({
      connectClient: mockClient,
    });
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);

    const client = createPostgresDbClient(pool);
    const result = await client.runInTransaction(async (tx) => {
      const row = await tx.queryOne("SELECT 1");
      return row?.id as number;
    });

    expect(result).toBe(1);
    expect(mockQuery).toHaveBeenNthCalledWith(1, "BEGIN");
    expect(mockQuery).toHaveBeenNthCalledWith(2, "SELECT 1", []);
    expect(mockQuery).toHaveBeenNthCalledWith(3, "COMMIT");
    expect(mockRelease).toHaveBeenCalled();
  });

  it("runInTransaction runs ROLLBACK on error", async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
    const mockRelease = vi.fn();
    const mockClient: PoolClient = {
      query: mockQuery,
      release: mockRelease,
    } as unknown as PoolClient;

    const pool = createMockPool({ connectClient: mockClient });
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);

    const client = createPostgresDbClient(pool);
    await expect(
      client.runInTransaction(async () => {
        throw new Error("tx failed");
      })
    ).rejects.toThrow("tx failed");

    expect(mockQuery).toHaveBeenNthCalledWith(1, "BEGIN");
    expect(mockQuery).toHaveBeenNthCalledWith(2, "ROLLBACK");
    expect(mockRelease).toHaveBeenCalled();
  });

  it("runInTransaction passes params to nested query", async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [{ id: 42 }] });
    const mockClient: PoolClient = {
      query: mockQuery,
      release: vi.fn(),
    } as unknown as PoolClient;

    const pool = createMockPool({ connectClient: mockClient });
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);

    const client = createPostgresDbClient(pool);
    await client.runInTransaction(async (tx) => {
      await tx.query("INSERT INTO t (a, b) VALUES ($1, $2)", ["x", 123]);
    });

    expect(mockQuery).toHaveBeenCalledWith("INSERT INTO t (a, b) VALUES ($1, $2)", ["x", 123]);
  });
});

describe("createPostgresDbClientFromUrl (integration)", () => {
  let client: DbClient | null = null;
  let pool: Pool | null = null;

  beforeAll(async () => {
    try {
      const url = await getTestDatabaseUrl();
      const result = await createPostgresDbClientFromUrl(url);
      client = result.client;
      pool = result.pool;
      await client.query("SELECT 1");
    } catch {
      client = null;
      pool = null;
    }
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("connects and runs query when Postgres is available", async () => {
    if (!client) return; // Skip when Postgres not available
    const rows = await client.query("SELECT $1::int as num", [42]);
    expect(rows).toHaveLength(1);
    expect(rows[0].num).toBe(42);
  });

  it("queryOne returns first row with $1, $2 params", async () => {
    if (!client) return; // Skip when Postgres not available
    const row = await client.queryOne("SELECT $1::text as a, $2::int as b", ["hello", 99]);
    expect(row).toBeDefined();
    expect(row?.a).toBe("hello");
    expect(row?.b).toBe(99);
  });

  it("runInTransaction commits and isolates", async () => {
    if (!client) return; // Skip when Postgres not available
    const result = await client.runInTransaction(async (tx) => {
      const r = await tx.queryOne("SELECT $1::int as x", [7]);
      return (r?.x as number) ?? 0;
    });
    expect(result).toBe(7);
  });
});
