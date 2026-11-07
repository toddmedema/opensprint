import type { DbClient } from "./client.js";
import { AppError } from "../middleware/error-handler.js";

/** Hold the durable project lifecycle row until this write transaction completes. */
export async function assertCollaborationProjectWritable(
  tx: DbClient,
  projectId: string
): Promise<void> {
  await tx.execute(
    "INSERT INTO collaboration_project_lifecycle (project_id,deleted_at) VALUES ($1,NULL) ON CONFLICT (project_id) DO NOTHING",
    [projectId]
  );
  const state = await tx.queryOne(
    "UPDATE collaboration_project_lifecycle SET deleted_at = deleted_at WHERE project_id = $1 RETURNING deleted_at",
    [projectId]
  );
  if (!state || state.deleted_at != null) {
    throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found.");
  }
}

/** Permanently retire an ID under the same transaction lock used by every collaboration writer. */
export async function retireCollaborationProject(tx: DbClient, projectId: string): Promise<void> {
  await tx.execute(
    "INSERT INTO collaboration_project_lifecycle (project_id,deleted_at) VALUES ($1,$2) ON CONFLICT (project_id) DO UPDATE SET deleted_at=excluded.deleted_at",
    [projectId, new Date().toISOString()]
  );
}
