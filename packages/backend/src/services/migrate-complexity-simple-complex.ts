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

  await taskStore.runWrite(async (client) => {
    const taskRows = await client.query("SELECT id, project_id, extra FROM tasks");

    for (const row of taskRows) {
      const r = row as { id: string; project_id: string; extra: string };
      let extra: Record<string, unknown>;
      try {
        extra = JSON.parse(r.extra || "{}");
      } catch {
        continue;
      }
      const raw = extra.complexity;
      if (raw !== "simple" && raw !== "complex") continue;

      const to = raw === "simple" ? 3 : 7;
      const { complexity: _removed, ...rest } = extra;
      const newExtra = JSON.stringify(rest);

      await client.execute(
        "UPDATE tasks SET complexity = $1, extra = $2 WHERE id = $3 AND project_id = $4",
        [to, newExtra, r.id, r.project_id]
      );
      migratedCount++;
      details.push({ id: r.id, projectId: r.project_id, from: raw, to });
    }
  });

  return { migratedCount, details };
}
