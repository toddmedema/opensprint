import type { ProjectIndexEntry } from "@opensprint/shared";
import type { DbClient, DbRow } from "../db/client.js";
import { taskStore } from "./task-store.service.js";
import { appendProjectEvent, lockProject } from "./project-event.service.js";

interface CatalogStore {
  runWrite<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
  runRead<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
}
function entry(row: DbRow): ProjectIndexEntry {
  return {
    id: String(row.project_id),
    name: String(row.name),
    repoPath: String(row.repo_path),
    createdAt: String(row.created_at),
  };
}
/** SQL is the catalog authority. Per-host legacy files are imported once and never receive writes. */
export class ProjectCatalogService {
  constructor(private readonly injectedStore?: CatalogStore) {}
  private get store(): CatalogStore {
    return this.injectedStore ?? taskStore;
  }
  async hasImported(source: string): Promise<boolean> {
    return this.store.runRead(async (tx) =>
      Boolean(
        await tx.queryOne("SELECT source FROM project_catalog_migrations WHERE source=$1", [source])
      )
    );
  }
  async importLegacy(source: string, entries: ProjectIndexEntry[]): Promise<void> {
    await this.store.runWrite(async (tx) => {
      const claimed = await tx.execute(
        "INSERT INTO project_catalog_migrations (source) VALUES ($1) ON CONFLICT DO NOTHING",
        [source]
      );
      if (!claimed) return;
      let changed = false;
      for (const project of [...entries].sort((a, b) => a.id.localeCompare(b.id))) {
        // A tombstone is a conflicting row too: an old replica's file cannot resurrect deletion.
        const added = await tx.execute(
          `INSERT INTO project_catalog (project_id,name,repo_path,created_at,updated_at,revision,deleted)
          VALUES ($1,$2,$3,$4,$5,1,0) ON CONFLICT DO NOTHING`,
          [project.id, project.name, project.repoPath, project.createdAt, new Date().toISOString()]
        );
        changed ||= added > 0;
      }
      if (changed)
        await tx.execute("UPDATE project_catalog_clock SET revision=revision+1 WHERE singleton=1");
    });
  }
  async list(): Promise<ProjectIndexEntry[]> {
    return this.store.runRead(async (tx) =>
      (
        await tx.query(
          "SELECT * FROM project_catalog WHERE deleted=0 ORDER BY created_at,project_id"
        )
      ).map(entry)
    );
  }
  async revision(): Promise<number> {
    return this.store.runRead(async (tx) =>
      Number(
        (await tx.queryOne("SELECT revision FROM project_catalog_clock WHERE singleton=1"))
          ?.revision ?? 0
      )
    );
  }
  async add(project: ProjectIndexEntry): Promise<void> {
    await this.store.runWrite(async (tx) => {
      await lockProject(tx, project.id);
      await tx.execute(
        `INSERT INTO project_catalog (project_id,name,repo_path,created_at,updated_at,revision,deleted)
        VALUES ($1,$2,$3,$4,$5,1,0) ON CONFLICT(project_id) DO UPDATE SET name=excluded.name,repo_path=excluded.repo_path,
          created_at=excluded.created_at,updated_at=excluded.updated_at,deleted=0,revision=project_catalog.revision+1`,
        [project.id, project.name, project.repoPath, project.createdAt, new Date().toISOString()]
      );
      await this.changed(tx, project.id, project);
    });
  }
  async remove(id: string): Promise<void> {
    await this.store.runWrite(async (tx) => {
      await lockProject(tx, id);
      await tx.execute(
        `INSERT INTO project_catalog (project_id,name,repo_path,created_at,updated_at,revision,deleted)
        VALUES ($1,'','',$2,$2,1,1) ON CONFLICT(project_id) DO UPDATE SET deleted=1,revision=project_catalog.revision+1,updated_at=excluded.updated_at`,
        [id, new Date().toISOString()]
      );
      await this.changed(tx, id, null);
    });
  }
  async update(
    id: string,
    updates: Partial<Omit<ProjectIndexEntry, "id">>
  ): Promise<ProjectIndexEntry | null> {
    return this.store.runWrite(async (tx) => {
      await lockProject(tx, id);
      const row = await tx.queryOne(
        "SELECT * FROM project_catalog WHERE project_id=$1 AND deleted=0",
        [id]
      );
      if (!row) return null;
      const next = { ...entry(row), ...updates, id };
      await tx.execute(
        `UPDATE project_catalog SET name=$2,repo_path=$3,created_at=$4,updated_at=$5,revision=revision+1 WHERE project_id=$1 AND deleted=0`,
        [id, next.name, next.repoPath, next.createdAt, new Date().toISOString()]
      );
      await this.changed(tx, id, next);
      return next;
    });
  }
  private async changed(
    tx: DbClient,
    id: string,
    project: ProjectIndexEntry | null
  ): Promise<void> {
    const clock = await tx.queryOne(
      "UPDATE project_catalog_clock SET revision=revision+1 WHERE singleton=1 RETURNING revision"
    );
    await appendProjectEvent(tx, {
      projectId: id,
      type: "project_changed",
      payload: { id, state: project, catalogRevision: Number(clock!.revision) },
    });
  }
}
export const projectCatalogService = new ProjectCatalogService();
