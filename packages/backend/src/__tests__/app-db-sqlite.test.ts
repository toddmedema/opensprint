/**
 * Tests for SQLite-backed AppDb and DbClient (initAppDb with sqlite dialect).
 * Requires a working better-sqlite3 native binding (run `npm rebuild better-sqlite3` after Node upgrades).
 */
import { describe, it, expect } from "vitest";
import { initAppDb } from "../db/app-db.js";
import { randomUUID } from "crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe.sequential("initAppDb (SQLite)", () => {
  it("initializes two connections to one fresh database file concurrently", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-init-"));
    const url = `sqlite://${path.join(root, "fresh.sqlite").replaceAll("\\", "/")}`;
    const results = await Promise.allSettled([initAppDb(url), initAppDb(url)]);
    try {
      expect(
        results.map((result) => result.status),
        results
          .filter((result) => result.status === "rejected")
          .map((result) => String(result.reason))
          .join("\n")
      ).toEqual(["fulfilled", "fulfilled"]);
      for (const result of results)
        if (result.status === "fulfilled")
          expect(
            await (
              await result.value.getClient()
            ).queryOne("SELECT COUNT(*) AS count FROM schema_versions")
          ).toMatchObject({ count: expect.any(Number) });
    } finally {
      await Promise.all(
        results
          .filter((result) => result.status === "fulfilled")
          .map((result) => result.value.close())
      );
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
  it("initializes with in-memory SQLite and runs schema", async () => {
    const appDb = await initAppDb("sqlite://:memory:");
    try {
      const client = await appDb.getClient();
      const rows = await client.query("SELECT 1 as one");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ one: 1 });

      const tasksRow = await client.queryOne("SELECT name FROM pragma_table_list WHERE name = ?", [
        "tasks",
      ]);
      expect(tasksRow?.name).toBe("tasks");
    } finally {
      await appDb.close();
    }
  });

  it("runWrite runs in transaction and commits", async () => {
    const taskId = `os-${randomUUID()}`;
    const appDb = await initAppDb("sqlite://:memory:");
    try {
      await appDb.runWrite(async (client) => {
        await client.execute(
          "INSERT INTO tasks (id, project_id, title, issue_type, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [
            taskId,
            "proj1",
            "Test",
            "task",
            "open",
            2,
            "2025-01-01T00:00:00Z",
            "2025-01-01T00:00:00Z",
          ]
        );
      });
      const client = await appDb.getClient();
      const row = await client.queryOne("SELECT id, title FROM tasks WHERE id = ?", [taskId]);
      expect(row?.id).toBe(taskId);
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
    const taskId = `os-${randomUUID()}`;
    const appDb = await initAppDb("sqlite://:memory:");
    try {
      const client = await appDb.getClient();
      const rows = await client.query(
        "INSERT INTO tasks (id, project_id, title, issue_type, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          taskId,
          "proj1",
          "Inserted via query",
          "task",
          "open",
          2,
          "2025-01-01T00:00:00Z",
          "2025-01-01T00:00:00Z",
        ]
      );
      expect(rows).toEqual([]);

      const inserted = await client.queryOne("SELECT id FROM tasks WHERE id = ?", [taskId]);
      expect(inserted?.id).toBe(taskId);
    } finally {
      await appDb.close();
    }
  });
});
