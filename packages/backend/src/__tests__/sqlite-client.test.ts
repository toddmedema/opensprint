import path from "path";
import { describe, expect, it, vi } from "vitest";
import {
  createSqliteDbClient,
  openSqliteDatabase,
  resolveSqlitePath,
} from "../db/sqlite-client.js";

describe("SQLite query execution", () => {
  it.each(["query", "queryOne", "execute"] as const)(
    "rejects synchronous %s errors",
    async (method) => {
      const error = new Error("invalid SQL");
      const db = {
        prepare: () => {
          throw error;
        },
      };
      const client = createSqliteDbClient(db as unknown as import("better-sqlite3").Database);
      await expect(client[method]("invalid")).rejects.toBe(error);
    }
  );

  it("binds repeated/reordered placeholders, leaves SQL literals/comments intact and supports native bindings", async () => {
    const { db, close } = await openSqliteDatabase(":memory:");
    const client = createSqliteDbClient(db);
    try {
      expect(
        await client.queryOne("SELECT $2 AS a, $1 AS b, $2 AS c, '$1' AS literal -- $3\n", [
          "first",
          "second",
        ])
      ).toEqual({ a: "second", b: "first", c: "second", literal: "$1" });
      expect(await client.queryOne("SELECT ? AS a, ? AS b", [1, 2])).toEqual({ a: 1, b: 2 });
      await client.execute("CREATE TABLE agent_stats (id INTEGER PRIMARY KEY, project_id TEXT)");
      db.transaction(() => {
        const insert = db.prepare("INSERT INTO agent_stats (project_id) VALUES (?)");
        for (let i = 0; i < 501; i++) insert.run("p1");
        insert.run("p2");
      })();
      // The production attempt-retention SQL uses $1 twice and $2 once.
      expect(
        await client.execute(
          `DELETE FROM agent_stats WHERE project_id = $1 AND id IN (
        SELECT id FROM agent_stats WHERE project_id = $1 ORDER BY id ASC LIMIT $2
      )`,
          ["p1", 1]
        )
      ).toBe(1);
      expect(
        await client.queryOne(
          "SELECT COUNT(*)::int AS count FROM agent_stats WHERE project_id = $1",
          ["p1"]
        )
      ).toEqual({ count: 500 });
      expect(
        await client.queryOne("SELECT COUNT(*) AS count FROM agent_stats WHERE project_id = $1", [
          "p2",
        ])
      ).toEqual({ count: 1 });
    } finally {
      close();
    }
  });
});

describe("resolveSqlitePath", () => {
  it("resolves file URL local paths on non-Windows platforms", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    try {
      expect(resolveSqlitePath("file:///tmp/opensprint.sqlite")).toBe(
        path.resolve("/tmp/opensprint.sqlite")
      );
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("normalizes Windows drive-letter file URLs without an extra leading slash", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const resolved = resolveSqlitePath(
        "file:///C:/Users/Alice/.opensprint/data/opensprint.sqlite"
      );
      expect(resolved).toBe(
        path.win32.resolve("C:/Users/Alice/.opensprint/data/opensprint.sqlite")
      );
      expect(resolved.startsWith("\\C:")).toBe(false);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("normalizes Windows UNC file URLs", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      expect(resolveSqlitePath("file://server/share/opensprint.sqlite")).toBe(
        path.win32.resolve("\\\\server\\share\\opensprint.sqlite")
      );
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("normalizes Windows drive-letter sqlite URLs with host component", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      expect(resolveSqlitePath("sqlite://C:/Users/Alice/.opensprint/data/opensprint.sqlite")).toBe(
        path.win32.resolve("C:/Users/Alice/.opensprint/data/opensprint.sqlite")
      );
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("normalizes Windows UNC sqlite URLs", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      expect(resolveSqlitePath("sqlite://server/share/opensprint.sqlite")).toBe(
        path.win32.resolve("\\\\server\\share\\opensprint.sqlite")
      );
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("normalizes legacy repeated sqlite: prefixes", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    try {
      expect(resolveSqlitePath("sqlite:sqlite:./data/opensprint.sqlite")).toBe(
        path.resolve("./data/opensprint.sqlite")
      );
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("normalizes legacy file:/ shorthand to a path", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    try {
      expect(resolveSqlitePath("file:/tmp/opensprint.sqlite")).toBe(
        path.resolve("/tmp/opensprint.sqlite")
      );
    } finally {
      platformSpy.mockRestore();
    }
  });
});
