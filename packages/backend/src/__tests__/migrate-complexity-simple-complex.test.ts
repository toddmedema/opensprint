import { describe, it, expect, beforeEach, vi } from "vitest";
import initSqlJs, { type Database } from "sql.js";
import { SCHEMA_SQL } from "../services/task-store.service.js";
import { migrateComplexitySimpleToComplex } from "../services/migrate-complexity-simple-complex.js";

let testDb: Database;

vi.mock("../services/task-store.service.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../services/task-store.service.js")>();
  return {
    ...mod,
    taskStore: {
      async init() {},
      async getDb() {
        if (!testDb) throw new Error("testDb not initialized");
        return testDb;
      },
      async runWrite<T>(fn: (db: Database) => Promise<T>): Promise<T> {
        if (!testDb) throw new Error("testDb not initialized");
        return fn(testDb);
      },
    },
  };
});

function insertTask(
  db: Database,
  id: string,
  projectId: string,
  options?: { extra?: string; complexity?: number }
): void {
  const now = new Date().toISOString();
  const extra = options?.extra ?? "{}";
  const complexity = options?.complexity ?? null;
  db.run(
    `INSERT INTO tasks (id, project_id, title, description, issue_type, status, priority, labels, created_at, updated_at, complexity, extra)
     VALUES (?, ?, 'Task', '', 'task', 'open', 2, '[]', ?, ?, ?, ?)`,
    [id, projectId, now, now, complexity, extra]
  );
}

function getTask(db: Database, id: string, projectId: string): { complexity: number | null; extra: string } {
  const stmt = db.prepare("SELECT complexity, extra FROM tasks WHERE id = ? AND project_id = ?");
  stmt.bind([id, projectId]);
  const row = stmt.step() ? (stmt.getAsObject() as { complexity: number | null; extra: string }) : null;
  stmt.free();
  if (!row) throw new Error(`Task ${id} not found`);
  return row;
}

describe("migrateComplexitySimpleToComplex", () => {
  beforeEach(async () => {
    const SQL = await initSqlJs();
    testDb = new SQL.Database();
    testDb.run(SCHEMA_SQL);
  });

  it("returns zero when no legacy complexity exists", async () => {
    insertTask(testDb, "os-1", "proj-1", { extra: "{}" });
    insertTask(testDb, "os-2", "proj-1", { extra: '{"sourceFeedbackIds":["fb-1"]}' });

    const result = await migrateComplexitySimpleToComplex();

    expect(result.migratedCount).toBe(0);
    expect(result.details).toEqual([]);
  });

  it("migrates simple to 3 and removes from extra", async () => {
    insertTask(testDb, "os-1", "proj-1", { extra: '{"complexity":"simple"}' });

    const result = await migrateComplexitySimpleToComplex();

    expect(result.migratedCount).toBe(1);
    expect(result.details).toEqual([{ id: "os-1", projectId: "proj-1", from: "simple", to: 3 }]);

    const row = getTask(testDb, "os-1", "proj-1");
    expect(row.complexity).toBe(3);
    expect(JSON.parse(row.extra)).not.toHaveProperty("complexity");
  });

  it("migrates complex to 7 and removes from extra", async () => {
    insertTask(testDb, "os-2", "proj-1", { extra: '{"complexity":"complex"}' });

    const result = await migrateComplexitySimpleToComplex();

    expect(result.migratedCount).toBe(1);
    expect(result.details).toEqual([{ id: "os-2", projectId: "proj-1", from: "complex", to: 7 }]);

    const row = getTask(testDb, "os-2", "proj-1");
    expect(row.complexity).toBe(7);
    expect(JSON.parse(row.extra)).not.toHaveProperty("complexity");
  });

  it("migrates multiple tasks across projects", async () => {
    insertTask(testDb, "os-a", "proj-1", { extra: '{"complexity":"simple"}' });
    insertTask(testDb, "os-b", "proj-1", { extra: '{"complexity":"complex"}' });
    insertTask(testDb, "os-c", "proj-2", { extra: '{"complexity":"simple"}' });

    const result = await migrateComplexitySimpleToComplex();

    expect(result.migratedCount).toBe(3);
    expect(result.details).toHaveLength(3);
    expect(result.details.map((d) => d.id).sort()).toEqual(["os-a", "os-b", "os-c"]);

    expect(getTask(testDb, "os-a", "proj-1").complexity).toBe(3);
    expect(getTask(testDb, "os-b", "proj-1").complexity).toBe(7);
    expect(getTask(testDb, "os-c", "proj-2").complexity).toBe(3);
  });

  it("preserves other extra fields when removing complexity", async () => {
    insertTask(testDb, "os-1", "proj-1", {
      extra: '{"complexity":"simple","sourceFeedbackIds":["fb-1"],"block_reason":null}',
    });

    const result = await migrateComplexitySimpleToComplex();

    expect(result.migratedCount).toBe(1);
    const extra = JSON.parse(getTask(testDb, "os-1", "proj-1").extra);
    expect(extra).toEqual({ sourceFeedbackIds: ["fb-1"], block_reason: null });
    expect(extra).not.toHaveProperty("complexity");
  });

  it("is idempotent — second run migrates nothing", async () => {
    insertTask(testDb, "os-1", "proj-1", { extra: '{"complexity":"simple"}' });

    const first = await migrateComplexitySimpleToComplex();
    expect(first.migratedCount).toBe(1);

    const second = await migrateComplexitySimpleToComplex();
    expect(second.migratedCount).toBe(0);
    expect(second.details).toEqual([]);
  });

  it("skips tasks with numeric or plan complexity in extra", async () => {
    insertTask(testDb, "os-1", "proj-1", { extra: '{"complexity":3}' });
    insertTask(testDb, "os-2", "proj-1", { extra: '{"complexity":"low"}' });
    insertTask(testDb, "os-3", "proj-1", { extra: '{"complexity":"medium"}' });

    const result = await migrateComplexitySimpleToComplex();

    expect(result.migratedCount).toBe(0);
    expect(result.details).toEqual([]);
  });
});
