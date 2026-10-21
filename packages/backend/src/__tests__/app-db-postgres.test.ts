import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbClient } from "../db/client.js";

const state = vi.hoisted(() => ({
  steps: [] as string[],
  failure: "",
  client: null as DbClient | null,
  pool: { end: vi.fn(async () => {}) },
}));
vi.mock("pg", () => ({
  default: {
    Pool: class {
      constructor() {
        return state.pool;
      }
    },
  },
}));
vi.mock("../db/client.js", () => ({
  getPoolConfig: (connectionString: string) => ({ connectionString }),
  createPostgresDbClient: () => state.client,
}));
vi.mock("../db/schema.js", () => ({
  runSchema: async (tx: DbClient) => {
    expect(tx).not.toBe(state.client);
    state.steps.push("schema");
    if (state.failure === "schema") throw new Error("schema failed");
  },
}));
vi.mock("../services/migrate-plan-versions.service.js", () => ({
  migratePlanVersions: async (tx: DbClient) => {
    expect(tx).not.toBe(state.client);
    state.steps.push("migration");
    if (state.failure === "migration") throw new Error("migration failed");
  },
}));
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => {
    state.steps.push("drizzle");
    return {};
  },
}));
vi.mock("../db/drizzle-schema-pg.js", () => ({}));
import { initAppDb, POSTGRES_SCHEMA_LOCK_KEY } from "../db/app-db.js";

describe("PostgreSQL application schema startup", () => {
  beforeEach(() => {
    state.steps = [];
    state.failure = "";
    state.pool.end.mockReset().mockImplementation(async () => {
      state.steps.push("close");
    });
    const tx: DbClient = {
      dialect: "postgres",
      query: vi.fn(async (sql, params) => {
        expect(sql).toBe("SELECT pg_advisory_xact_lock($1, $2)");
        expect(params).toEqual([...POSTGRES_SCHEMA_LOCK_KEY]);
        state.steps.push("lock");
        return [];
      }),
      queryOne: vi.fn(),
      execute: vi.fn(),
      runInTransaction: vi.fn(),
    };
    state.client = {
      dialect: "postgres",
      query: vi.fn(),
      queryOne: vi.fn(),
      execute: vi.fn(),
      runInTransaction: async (fn) => {
        state.steps.push("begin");
        try {
          const result = await fn(tx);
          state.steps.push("commit");
          return result;
        } catch (error) {
          state.steps.push("rollback");
          throw error;
        }
      },
    };
  });
  it("holds one transaction-scoped lock through schema DDL and plan migration", async () => {
    const db = await initAppDb("postgresql://test/test_db");
    expect(state.steps).toEqual(["begin", "lock", "schema", "migration", "commit", "drizzle"]);
    expect(await db.getClient()).toBe(state.client);
    await db.close();
    expect(state.pool.end).toHaveBeenCalledOnce();
  });
  it.each(["schema", "migration"])(
    "rolls back and releases the pool when %s initialization fails",
    async (failure) => {
      state.failure = failure;
      await expect(initAppDb("postgresql://test/test_db")).rejects.toThrow(failure + " failed");
      expect(state.steps.at(-2)).toBe("rollback");
      expect(state.steps.at(-1)).toBe("close");
      expect(state.steps).not.toContain("commit");
      expect(state.steps).not.toContain("drizzle");
    }
  );
});
