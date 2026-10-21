import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createSqliteDbClient } from "../db/sqlite-client.js";
import { COLLABORATION_SCHEMA_SQL } from "../db/collaboration-schema.js";
import { PROJECT_CATALOG_SCHEMA_SQL } from "../db/project-catalog-schema.js";
import { getProjects, setProjectIndexPathForTesting } from "../services/project-index.js";
import {
  ProjectCatalogService,
  projectCatalogService,
} from "../services/project-catalog.service.js";
import type { DbClient } from "../db/client.js";

describe("shared SQL project catalog", () => {
  let root: string, firstDb: Database.Database, secondDb: Database.Database;
  let first: ProjectCatalogService, second: ProjectCatalogService, db: DbClient;
  const project = {
    id: "p",
    name: "Project",
    repoPath: "/shared/repositories/p",
    createdAt: "2026-10-21T00:00:00Z",
  };
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-test-"));
    firstDb = new Database(path.join(root, "catalog.sqlite"));
    firstDb.pragma("journal_mode = WAL");
    firstDb.exec(COLLABORATION_SCHEMA_SQL + PROJECT_CATALOG_SCHEMA_SQL);
    secondDb = new Database(path.join(root, "catalog.sqlite"));
    db = createSqliteDbClient(firstDb);
    const other = createSqliteDbClient(secondDb);
    const store = (client: DbClient) => ({
      runWrite: <T>(fn: (tx: DbClient) => Promise<T>) => client.runInTransaction(fn),
      runRead: <T>(fn: (tx: DbClient) => Promise<T>) => client.runInTransaction(fn),
    });
    first = new ProjectCatalogService(store(db));
    second = new ProjectCatalogService(store(other));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setProjectIndexPathForTesting(null);
    firstDb.close();
    secondDb.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  it("discovers additions and merged updates immediately on an independent replica", async () => {
    await Promise.all([first.add(project), second.add({ ...project, id: "other", name: "Other" })]);
    expect((await second.list()).map((row) => row.id).sort()).toEqual(["other", "p"]);
    const revision = await second.revision();
    await Promise.all([
      first.update("p", { name: "Renamed" }),
      second.update("p", { repoPath: "/shared/moved" }),
    ]);
    expect((await second.list()).find((row) => row.id === "p")).toMatchObject({
      name: "Renamed",
      repoPath: "/shared/moved",
    });
    expect(await first.revision()).toBeGreaterThan(revision);
  });
  it("imports each legacy source once and never resurrects a project from a stale replica file", async () => {
    await first.importLegacy("/host-a/.opensprint/projects.json", [project]);
    await first.remove("p");
    await second.importLegacy("/host-b/.opensprint/projects.json", [project]);
    expect(await second.list()).toEqual([]);
    expect(await second.hasImported("/host-b/.opensprint/projects.json")).toBe(true);
    expect(await db.queryOne("SELECT deleted FROM project_catalog WHERE project_id='p'")).toEqual({
      deleted: 1,
    });
    await first.add({ ...project, name: "Explicitly re-added" });
    await second.importLegacy("/host-a/.opensprint/projects.json", [
      { ...project, name: "Old legacy name" },
    ]);
    expect((await first.list())[0]?.name).toBe("Explicitly re-added");
  });
  it("commits catalog revision and semantic outbox with the catalog mutation", async () => {
    await first.add(project);
    const rows = await db.query("SELECT event FROM collaboration_events WHERE project_id='p'");
    const event = JSON.parse(String(rows[0]?.event));
    expect(event).toMatchObject({
      type: "project_changed",
      payload: { id: "p", catalogRevision: await second.revision(), state: project },
    });
    await second.remove("p");
    expect(await first.list()).toEqual([]);
    const last = await db.queryOne(
      "SELECT event FROM collaboration_events WHERE project_id='p' ORDER BY cursor DESC LIMIT 1"
    );
    expect(JSON.parse(String(last?.event)).payload.state).toBeNull();
  });
  it("production wrapper imports once and keeps SQL readable after the obsolete legacy file is corrupted", async () => {
    vi.stubEnv("HOME", root);
    setProjectIndexPathForTesting(null);
    await fs.mkdir(path.join(root, ".opensprint"), { recursive: true });
    const legacy = path.join(root, ".opensprint", "projects.json");
    await fs.writeFile(legacy, JSON.stringify({ projects: [project] }));
    vi.spyOn(projectCatalogService, "hasImported").mockImplementation(
      first.hasImported.bind(first)
    );
    vi.spyOn(projectCatalogService, "importLegacy").mockImplementation(
      first.importLegacy.bind(first)
    );
    vi.spyOn(projectCatalogService, "list").mockImplementation(first.list.bind(first));
    expect(await getProjects()).toEqual([project]);
    await fs.writeFile(legacy, "obsolete corrupt file");
    expect(await getProjects()).toEqual([project]);
    expect(projectCatalogService.importLegacy).toHaveBeenCalledOnce();
    await second.remove(project.id);
    expect(await getProjects()).toEqual([]);
  });
});
