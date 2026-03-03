import { describe, expect, it } from "vitest";
import { buildVitestSchemaName, createTestProjectId } from "./test-db-helper.js";

describe("test-db-helper schema naming", () => {
  it("builds a stable run-scoped schema name", () => {
    const schema = buildVitestSchemaName("run-1234-5678", "worker/2");
    expect(schema).toBe("vitest_run_1234_5678_worker_2");
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
});
