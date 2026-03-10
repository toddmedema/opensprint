/**
 * Schema content tests. Only imports from db/schema.ts (no Drizzle or DB).
 */
import { describe, it, expect } from "vitest";
import { getSchemaSql, runSchema, SCHEMA_SQL, SCHEMA_SQL_SQLITE } from "../db/schema.js";

describe("schema", () => {
  it("runSchema succeeds for Postgres (mock client)", async () => {
    const statements: string[] = [];
    await runSchema(
      {
        query: async (sql: string) => {
          statements.push(sql);
          return [];
        },
      },
      "postgres"
    );
    expect(statements.some((s) => s.includes("plan_versions"))).toBe(true);
    expect(statements.some((s) => s.includes("current_version_number"))).toBe(true);
  });

  it("runSchema succeeds for SQLite (mock client)", async () => {
    const statements: string[] = [];
    await runSchema(
      {
        query: async (sql: string) => {
          statements.push(sql);
          if (sql.startsWith("PRAGMA table_info("))
            return [{ name: "project_id" }, { name: "plan_id" }];
          return [];
        },
      },
      "sqlite"
    );
    expect(statements.some((s) => s.includes("plan_versions"))).toBe(true);
  });

  it("Postgres schema includes plan_versions table and plans version columns", () => {
    const sql = getSchemaSql("postgres");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS plan_versions");
    expect(sql).toContain("project_id");
    expect(sql).toContain("plan_id");
    expect(sql).toContain("version_number");
    expect(sql).toContain("title");
    expect(sql).toContain("content");
    expect(sql).toContain("metadata");
    expect(sql).toContain("created_at");
    expect(sql).toContain("is_executed_version");
    expect(sql).toContain("SERIAL PRIMARY KEY");
    expect(sql).toContain("BOOLEAN");
    expect(sql).toContain("idx_plan_versions_project_plan_version");
    expect(sql).toContain("current_version_number");
    expect(sql).toContain("last_executed_version_number");
    expect(SCHEMA_SQL).toContain("plan_versions");
    expect(SCHEMA_SQL).toContain("current_version_number");
    expect(SCHEMA_SQL).toContain("last_executed_version_number");
  });

  it("SQLite schema includes plan_versions table and plans version columns", () => {
    const sql = getSchemaSql("sqlite");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS plan_versions");
    expect(sql).toContain("INTEGER PRIMARY KEY AUTOINCREMENT");
    expect(sql).toContain("is_executed_version");
    expect(sql).toContain("INTEGER NOT NULL DEFAULT 0");
    expect(sql).toContain("idx_plan_versions_project_plan_version");
    expect(sql).toContain("current_version_number");
    expect(sql).toContain("last_executed_version_number");
    expect(SCHEMA_SQL_SQLITE).toContain("plan_versions");
    expect(SCHEMA_SQL_SQLITE).toContain("current_version_number");
    expect(SCHEMA_SQL_SQLITE).toContain("last_executed_version_number");
  });
});
