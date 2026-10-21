import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  buildVitestSchemaName,
  createTestProjectId,
  resetProjectScopedTestData,
  seedPrdMetadataFixture,
} from "./test-db-helper.js";
import { initAppDb } from "../db/app-db.js";

describe("test-db-helper schema naming", () => {
  const savedSchemaScope = process.env.OPENSPRINT_VITEST_SCHEMA_SCOPE;

  beforeEach(() => {
    // Vitest project `test.env` sets a scope; clear so "no scope" naming stays deterministic.
    delete process.env.OPENSPRINT_VITEST_SCHEMA_SCOPE;
  });

  afterEach(() => {
    if (savedSchemaScope !== undefined) {
      process.env.OPENSPRINT_VITEST_SCHEMA_SCOPE = savedSchemaScope;
    } else {
      delete process.env.OPENSPRINT_VITEST_SCHEMA_SCOPE;
    }
  });

  it("builds a stable run-scoped schema name", () => {
    const schema = buildVitestSchemaName("run-1234-5678", "worker/2");
    expect(schema).toBe("vitest_run_1234_5678_worker_2");
  });

  it("prefixes schema with OPENSPRINT_VITEST_SCHEMA_SCOPE when set (multi-project Vitest isolation)", () => {
    process.env.OPENSPRINT_VITEST_SCHEMA_SCOPE = "int";
    const schema = buildVitestSchemaName("run-1234-5678", "worker/2");
    expect(schema).toBe("vitest_int_run_1234_5678_worker_2");
  });

  it("caps the schema length within Postgres identifier limits", () => {
    const schema = buildVitestSchemaName("r".repeat(80), "w".repeat(80));
    expect(schema.length).toBeLessThanOrEqual(63);
  });

  it("creates unique test project ids", () => {
    const a = createTestProjectId("task-store");
    const b = createTestProjectId("task-store");
    expect(a).toMatch(/^task-store-/);
    expect(b).toMatch(/^task-store-/);
    expect(a).not.toBe(b);
  });

  it("seeds and updates chat PRD metadata against the actual SQLite NOT NULL schema", async () => {
    const database = await initAppDb("sqlite://:memory:");
    try {
      const client = await database.getClient();
      await seedPrdMetadataFixture(client, "chat-project", {
        version: 1,
        changeLog: [],
        sections: { feature_list: { version: 1 } },
      });
      await seedPrdMetadataFixture(client, "chat-project", {
        version: 2,
        changeLog: [],
        sections: { feature_list: { version: 2 } },
      });
      const row = await client.queryOne("SELECT * FROM prd_metadata WHERE project_id=$1", [
        "chat-project",
      ]);
      expect(row).toMatchObject({
        project_id: "chat-project",
        version: 2,
        change_log: "[]",
        section_versions: '{"feature_list":2}',
      });
      expect(typeof row?.updated_at).toBe("string");
      expect(Number.isFinite(Date.parse(String(row?.updated_at)))).toBe(true);
    } finally {
      await database.close();
    }
  });

  it("clears reusable project draft and replay state while preserving settings and other projects", async () => {
    const database = await initAppDb("sqlite://:memory:");
    try {
      const client = await database.getClient();
      for (const project of ["reset", "other"]) {
        await client.execute("INSERT INTO spec_draft_heads (project_id,revision) VALUES ($1,3)", [
          project,
        ]);
        await client.execute(
          "INSERT INTO collaboration_projects (project_id,cursor) VALUES ($1,4)",
          [project]
        );
        await client.execute(
          "INSERT INTO project_settings (project_id,settings,revision,updated_at) VALUES ($1,'{}',2,'now')",
          [project]
        );
      }
      await resetProjectScopedTestData(client, "reset");
      expect(
        await client.queryOne("SELECT revision FROM spec_draft_heads WHERE project_id='reset'")
      ).toBeUndefined();
      expect(
        await client.queryOne("SELECT cursor FROM collaboration_projects WHERE project_id='reset'")
      ).toBeUndefined();
      expect(
        await client.queryOne("SELECT revision FROM spec_draft_heads WHERE project_id='other'")
      ).toEqual({ revision: 3 });
      expect(
        await client.queryOne("SELECT revision FROM project_settings WHERE project_id='reset'")
      ).toEqual({ revision: 2 });
    } finally {
      await database.close();
    }
  });
});
