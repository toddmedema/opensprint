/**
 * Tests for SQLite-backed AppDb and DbClient (initAppDb with sqlite dialect).
 */
import { describe, it, expect } from "vitest";
import { initAppDb } from "../db/app-db.js";

describe("initAppDb (SQLite)", () => {
  it("initializes with in-memory SQLite and runs schema", async () => {
    const appDb = await initAppDb("sqlite://:memory:");
    try {
      const client = await appDb.getClient();
      const rows = await client.query("SELECT 1 as one");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ one: 1 });

      const tasksRow = await client.queryOne(
        "SELECT name FROM pragma_table_list WHERE name = ?",
        ["tasks"]
      );
      expect(tasksRow?.name).toBe("tasks");
    } finally {
      await appDb.close();
    }
  });

  it("runWrite runs in transaction and commits", async () => {
    const appDb = await initAppDb("sqlite://:memory:");
    try {
      await appDb.runWrite(async (client) => {
        await client.execute(
          "INSERT INTO tasks (id, project_id, title, issue_type, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          ["os-test1", "proj1", "Test", "task", "open", 2, "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z"]
        );
      });
      const client = await appDb.getClient();
      const row = await client.queryOne("SELECT id, title FROM tasks WHERE id = ?", ["os-test1"]);
      expect(row?.id).toBe("os-test1");
      expect(row?.title).toBe("Test");
    } finally {
      await appDb.close();
    }
  });

  it("converts $1 $2 placeholders to ? for SQLite", async () => {
    const appDb = await initAppDb("sqlite://:memory:");
    try {
      const client = await appDb.getClient();
      const row = await client.queryOne("SELECT $1 as a, $2 as b", ["x", 42]);
      expect(row?.a).toBe("x");
      expect(row?.b).toBe(42);
    } finally {
      await appDb.close();
    }
  });

  it("allows non-SELECT statements through query() without throwing", async () => {
    const appDb = await initAppDb("sqlite://:memory:");
    try {
      const client = await appDb.getClient();
      const rows = await client.query(
        "INSERT INTO tasks (id, project_id, title, issue_type, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ["os-test2", "proj1", "Inserted via query", "task", "open", 2, "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z"]
      );
      expect(rows).toEqual([]);

      const inserted = await client.queryOne("SELECT id FROM tasks WHERE id = ?", ["os-test2"]);
      expect(inserted?.id).toBe("os-test2");
    } finally {
      await appDb.close();
    }
  });
});
