/**
 * Delete orphaned open_questions rows whose project_id references a project
 * that no longer exists in the project index.
 *
 * Idempotent and safe to run multiple times.
 *
 * @returns { deletedCount: number; deletedIds: string[] }
 */
import { taskStore } from "./task-store.service.js";
import { getProjects } from "./project-index.js";

export async function deleteOrphanedOpenQuestions(): Promise<{
  deletedCount: number;
  deletedIds: Array<{ id: string; project_id: string }>;
}> {
  await taskStore.init();

  const projects = await getProjects();
  const validProjectIds = new Set(projects.map((p) => p.id));

  const client = await taskStore.getDb();
  const rows = await client.query("SELECT id, project_id FROM open_questions");
  const allRows = rows as { id: string; project_id: string }[];

  const orphaned = allRows.filter((r) => !validProjectIds.has(r.project_id));

  if (orphaned.length === 0) {
    return { deletedCount: 0, deletedIds: [] };
  }

  await taskStore.runWrite(async (tx) => {
    for (const row of orphaned) {
      await tx.execute(
        "DELETE FROM open_questions WHERE id = $1 AND project_id = $2",
        [row.id, row.project_id]
      );
    }
  });

  return {
    deletedCount: orphaned.length,
    deletedIds: orphaned,
  };
}
