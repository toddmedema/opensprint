/**
 * One-time migration: map legacy task/epic complexity strings to integers.
 * - "simple" → 3
 * - "complex" → 7
 *
 * Migrates tasks (including epics) where tasks.extra JSON contains
 * complexity: "simple" or complexity: "complex". Updates the complexity
 * column and removes complexity from extra JSON.
 *
 * Idempotent and safe to run multiple times.
 *
 * @returns { migratedCount: number; details: Array }
 */
import { taskStore } from "./task-store.service.js";

export async function migrateComplexitySimpleToComplex(): Promise<{
  migratedCount: number;
  details: Array<{ id: string; projectId: string; from: string; to: number }>;
}> {
  await taskStore.init();

  const details: Array<{ id: string; projectId: string; from: string; to: number }> = [];
  let migratedCount = 0;

  await taskStore.runWrite(async (db) => {
    const taskStmt = db.prepare("SELECT id, project_id, extra FROM tasks");
    const taskRows: Array<{ id: string; project_id: string; extra: string }> = [];
    while (taskStmt.step()) {
      const row = taskStmt.getAsObject() as { id: string; project_id: string; extra: string };
      taskRows.push(row);
    }
    taskStmt.free();

    for (const row of taskRows) {
      let extra: Record<string, unknown>;
      try {
        extra = JSON.parse(row.extra || "{}");
      } catch {
        continue;
      }
      const raw = extra.complexity;
      if (raw !== "simple" && raw !== "complex") continue;

      const to = raw === "simple" ? 3 : 7;
      const { complexity: _removed, ...rest } = extra;
      const newExtra = JSON.stringify(rest);

      db.run(
        "UPDATE tasks SET complexity = ?, extra = ? WHERE id = ? AND project_id = ?",
        [to, newExtra, row.id, row.project_id]
      );
      migratedCount++;
      details.push({ id: row.id, projectId: row.project_id, from: raw, to });
    }
  });

  return { migratedCount, details };
}
