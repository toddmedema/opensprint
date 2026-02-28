import { describe, it, expect, beforeEach, vi } from "vitest";
import initSqlJs from "sql.js";
import { migrateComplexitySimpleToComplex } from "../services/migrate-complexity-simple-complex.js";
import type { DbClient } from "../db/client.js";
import { createSqliteDbClient, SCHEMA_SQL_SQLITE } from "./test-db-helper.js";

let testClient: DbClient;

vi.mock("../services/task-store.service.js", async () => ({
  taskStore: {
      async init() {},
      async getDb() {
        if (!testClient) throw new Error("testClient not initialized");
        return testClient;
      },
      async runWrite<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
        if (!testClient) throw new Error("testClient not initialized");
        return fn(testClient);
      },
    },
  TaskStoreService: vi.fn(),
  SCHEMA_SQL: "",
}));

async function insertTask(
  client: DbClient,
  id: string,
  projectId: string,
  options?: { extra?: string; complexity?: number }
): Promise<void> {
  const now = new Date().toISOString();
  const extra = options?.extra ?? "{}";
  const complexity = options?.complexity ?? null;
  await client.execute(
    `INSERT INTO tasks (id, project_id, title, description, issue_type, status, priority, labels, created_at, updated_at, complexity, extra)
     VALUES ($1, $2, 'Task', '', 'task', 'open', 2, '[]', $3, $4, $5, $6)`,
    [id, projectId, now, now, complexity, extra]
  );
}

async function getTask(
  client: DbClient,
  id: string,
  projectId: string
): Promise<{ complexity: number | null; extra: string }> {
  const row = await client.queryOne(
    "SELECT complexity, extra FROM tasks WHERE id = $1 AND project_id = $2",
    [id, projectId]
  );
  if (!row) throw new Error(`Task ${id} not found`);
  return row as { complexity: number | null; extra: string };
}

describe("migrateComplexitySimpleToComplex", () => {
  beforeEach(async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(SCHEMA_SQL_SQLITE);
    testClient = createSqliteDbClient(db);
  });

  it("returns zero when no legacy complexity exists", async () => {
    await insertTask(testClient, "os-1", "proj-1", { extra: "{}" });
    await insertTask(testClient, "os-2", "proj-1", { extra: '{"sourceFeedbackIds":["fb-1"]}' });

    const result = await migrateComplexitySimpleToComplex();

    expect(result.migratedCount).toBe(0);
    expect(result.details).toEqual([]);
  });

  it("migrates simple to 3 and removes from extra", async () => {
    await insertTask(testClient, "os-1", "proj-1", { extra: '{"complexity":"simple"}' });

    const result = await migrateComplexitySimpleToComplex();

    expect(result.migratedCount).toBe(1);
    expect(result.details).toEqual([{ id: "os-1", projectId: "proj-1", from: "simple", to: 3 }]);

    const row = await getTask(testClient, "os-1", "proj-1");
    expect(row.complexity).toBe(3);
    expect(JSON.parse(row.extra)).not.toHaveProperty("complexity");
  });

  it("migrates complex to 7 and removes from extra", async () => {
    await insertTask(testClient, "os-2", "proj-1", { extra: '{"complexity":"complex"}' });

    const result = await migrateComplexitySimpleToComplex();

    expect(result.migratedCount).toBe(1);
    expect(result.details).toEqual([{ id: "os-2", projectId: "proj-1", from: "complex", to: 7 }]);

    const row = await getTask(testClient, "os-2", "proj-1");
    expect(row.complexity).toBe(7);
    expect(JSON.parse(row.extra)).not.toHaveProperty("complexity");
  });

  it("migrates multiple tasks across projects", async () => {
    await insertTask(testClient, "os-a", "proj-1", { extra: '{"complexity":"simple"}' });
    await insertTask(testClient, "os-b", "proj-1", { extra: '{"complexity":"complex"}' });
    await insertTask(testClient, "os-c", "proj-2", { extra: '{"complexity":"simple"}' });

    const result = await migrateComplexitySimpleToComplex();

    expect(result.migratedCount).toBe(3);
    expect(result.details).toHaveLength(3);
    expect(result.details.map((d) => d.id).sort()).toEqual(["os-a", "os-b", "os-c"]);

    expect((await getTask(testClient, "os-a", "proj-1")).complexity).toBe(3);
    expect((await getTask(testClient, "os-b", "proj-1")).complexity).toBe(7);
    expect((await getTask(testClient, "os-c", "proj-2")).complexity).toBe(3);
  });

  it("preserves other extra fields when removing complexity", async () => {
    await insertTask(testClient, "os-1", "proj-1", {
      extra: '{"complexity":"simple","sourceFeedbackIds":["fb-1"],"block_reason":null}',
    });

    const result = await migrateComplexitySimpleToComplex();

    expect(result.migratedCount).toBe(1);
    const extra = JSON.parse((await getTask(testClient, "os-1", "proj-1")).extra);
    expect(extra).toEqual({ sourceFeedbackIds: ["fb-1"], block_reason: null });
    expect(extra).not.toHaveProperty("complexity");
  });

  it("is idempotent — second run migrates nothing", async () => {
    await insertTask(testClient, "os-1", "proj-1", { extra: '{"complexity":"simple"}' });

    const first = await migrateComplexitySimpleToComplex();
    expect(first.migratedCount).toBe(1);

    const second = await migrateComplexitySimpleToComplex();
    expect(second.migratedCount).toBe(0);
    expect(second.details).toEqual([]);
  });

  it("skips tasks with numeric or plan complexity in extra", async () => {
    await insertTask(testClient, "os-1", "proj-1", { extra: '{"complexity":3}' });
    await insertTask(testClient, "os-2", "proj-1", { extra: '{"complexity":"low"}' });
    await insertTask(testClient, "os-3", "proj-1", { extra: '{"complexity":"medium"}' });

    const result = await migrateComplexitySimpleToComplex();

    expect(result.migratedCount).toBe(0);
    expect(result.details).toEqual([]);
  });
});
