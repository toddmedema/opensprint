import { taskStore } from "./task-store.service.js";
import { AppError } from "../middleware/error-handler.js";
import { lockProject } from "./project-event.service.js";
export class PresenceService {
  async snapshot(projectId: string) {
    const now = new Date().toISOString();
    return taskStore.runRead(async (tx) => ({
      people: (
        await tx.query(
          `SELECT p.actor_id, u.display_name, p.focus, p.typing, p.typing_expires_at FROM collaboration_presence p LEFT JOIN collaboration_users u ON u.actor_id=p.actor_id WHERE p.project_id=$1 AND p.expires_at>$2`,
          [projectId, now]
        )
      ).map((row) => ({
        actorId: String(row.actor_id),
        displayName: String(row.display_name ?? "Host"),
        focus: row.focus,
        typing: !!row.typing && String(row.typing_expires_at) > now,
      })),
      presenter: await tx.queryOne(
        "SELECT actor_id, focus, revision FROM collaboration_presenters WHERE project_id=$1 AND expires_at>$2",
        [projectId, now]
      ),
    }));
  }
  async heartbeat(
    projectId: string,
    actorId: string,
    input: { connectionId: string; typing: boolean; focus: string }
  ) {
    await taskStore.runWrite(async (tx) => {
      const now = Date.now();
      await tx.execute("DELETE FROM collaboration_presence WHERE expires_at < $1", [
        new Date(now).toISOString(),
      ]);
      await tx.execute(
        `INSERT INTO collaboration_presence (project_id,actor_id,connection_id,typing,typing_expires_at,focus,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(project_id,actor_id,connection_id) DO UPDATE SET typing=excluded.typing,typing_expires_at=excluded.typing_expires_at,focus=excluded.focus,expires_at=excluded.expires_at`,
        [
          projectId,
          actorId,
          input.connectionId,
          input.typing ? 1 : 0,
          new Date(now + 5_000).toISOString(),
          input.focus,
          new Date(now + 25_000).toISOString(),
        ]
      );
      await tx.execute(
        "UPDATE collaboration_presenters SET expires_at=$3, focus=$4 WHERE project_id=$1 AND actor_id=$2 AND expires_at>$5",
        [
          projectId,
          actorId,
          new Date(now + 25_000).toISOString(),
          input.focus,
          new Date(now).toISOString(),
        ]
      );
    });
  }
  async present(
    projectId: string,
    actorId: string,
    input: { expectedRevision: number; focus: string | null }
  ) {
    return taskStore.runWrite(async (tx) => {
      await lockProject(tx, projectId);
      const current = await tx.queryOne(
        "SELECT * FROM collaboration_presenters WHERE project_id=$1",
        [projectId]
      );
      const active = current && String(current.expires_at) > new Date().toISOString();
      if (
        (active ? Number(current.revision) : 0) !== input.expectedRevision ||
        (active && current.actor_id !== actorId)
      )
        throw new AppError(
          409,
          "PRESENTER_CHANGED",
          "The presenter changed. Refresh before presenting.",
          { current }
        );
      const revision = Number(current?.revision ?? 0) + 1;
      await tx.execute(
        `INSERT INTO collaboration_presenters (project_id,actor_id,focus,revision,expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(project_id) DO UPDATE SET actor_id=excluded.actor_id,focus=excluded.focus,revision=excluded.revision,expires_at=excluded.expires_at`,
        [
          projectId,
          input.focus ? actorId : null,
          input.focus,
          revision,
          new Date(Date.now() + (input.focus ? 25_000 : 0)).toISOString(),
        ]
      );
      return { actor_id: actorId, focus: input.focus, revision };
    });
  }
}
export const presenceService = new PresenceService();
