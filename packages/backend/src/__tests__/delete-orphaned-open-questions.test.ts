import { describe, it, expect, beforeEach, vi } from "vitest";
import { deleteOrphanedOpenQuestions } from "../services/delete-orphaned-open-questions.js";
import type { DbClient } from "../db/client.js";

const { testClientRef } = vi.hoisted(() => ({
  testClientRef: { current: null as DbClient | null },
}));
vi.mock("../services/task-store.service.js", async () => {
  const { createTestPostgresClient } = await import("./test-db-helper.js");
  const dbResult = await createTestPostgresClient();
  testClientRef.current = dbResult?.client ?? null;
  return {
    taskStore: {
      async init() {},
      async getDb() {
        if (!testClientRef.current) throw new Error("testClient not initialized");
        return testClientRef.current;
      },
      async runWrite<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
        if (!testClientRef.current) throw new Error("testClient not initialized");
        return fn(testClientRef.current);
      },
    },
    TaskStoreService: vi.fn(),
    SCHEMA_SQL: "",
    _postgresAvailable: !!dbResult,
  };
});

const mockProjects: Array<{ id: string; name: string; repoPath: string; createdAt: string }> = [];

vi.mock("../services/project-index.js", () => ({
  getProjects: vi.fn(async () => mockProjects),
}));

async function insertOpenQuestion(
  client: DbClient,
  id: string,
  projectId: string,
  options?: { status?: string }
): Promise<void> {
  const status = options?.status ?? "open";
  const createdAt = new Date().toISOString();
  await client.execute(
    `INSERT INTO open_questions (id, project_id, source, source_id, questions, status, created_at, kind)
     VALUES ($1, $2, 'plan', 'plan-1', '[]', $3, $4, 'open_question')`,
    [id, projectId, status, createdAt]
  );
}

async function countOpenQuestions(client: DbClient): Promise<number> {
  const row = await client.queryOne("SELECT COUNT(*)::int as cnt FROM open_questions");
  const cnt = row?.cnt;
  return typeof cnt === "number" ? cnt : Number(cnt ?? 0);
}

const deleteOrphanedTaskStoreMod = await import("../services/task-store.service.js");
const deleteOrphanedPostgresOk =
  (deleteOrphanedTaskStoreMod as { _postgresAvailable?: boolean })._postgresAvailable ?? false;

describe.skipIf(!deleteOrphanedPostgresOk)("deleteOrphanedOpenQuestions", () => {
  beforeEach(async () => {
    if (!testClientRef.current) throw new Error("Postgres required");
    await testClientRef.current.execute("DELETE FROM open_questions");
    mockProjects.length = 0;
  });

  it("returns zero when no orphaned rows exist", async () => {
    mockProjects.push({
      id: "proj-1",
      name: "Project 1",
      repoPath: "/path/1",
      createdAt: new Date().toISOString(),
    });
    await insertOpenQuestion(testClientRef.current!, "oq-1", "proj-1");

    const result = await deleteOrphanedOpenQuestions();

    expect(result.deletedCount).toBe(0);
    expect(result.deletedIds).toEqual([]);
    expect(await countOpenQuestions(testClientRef.current!)).toBe(1);
  });

  it("deletes orphaned rows and leaves valid rows", async () => {
    mockProjects.push(
      { id: "proj-1", name: "P1", repoPath: "/p1", createdAt: new Date().toISOString() },
      { id: "proj-2", name: "P2", repoPath: "/p2", createdAt: new Date().toISOString() }
    );
    await insertOpenQuestion(testClientRef.current!, "oq-1", "proj-1");
    await insertOpenQuestion(testClientRef.current!, "oq-2", "proj-2");
    await insertOpenQuestion(testClientRef.current!, "oq-3", "proj-deleted");
    await insertOpenQuestion(testClientRef.current!, "oq-4", "proj-ghost");

    const result = await deleteOrphanedOpenQuestions();

    expect(result.deletedCount).toBe(2);
    expect(result.deletedIds).toHaveLength(2);
    expect(result.deletedIds.map((r) => r.id).sort()).toEqual(["oq-3", "oq-4"]);
    expect(result.deletedIds.map((r) => r.project_id).sort()).toEqual([
      "proj-deleted",
      "proj-ghost",
    ]);
    expect(await countOpenQuestions(testClientRef.current!)).toBe(2);
  });

  it("is idempotent — second run deletes nothing", async () => {
    mockProjects.push({
      id: "proj-1",
      name: "P1",
      repoPath: "/p1",
      createdAt: new Date().toISOString(),
    });
    await insertOpenQuestion(testClientRef.current!, "oq-1", "proj-orphan");

    const first = await deleteOrphanedOpenQuestions();
    expect(first.deletedCount).toBe(1);
    expect(await countOpenQuestions(testClientRef.current!)).toBe(0);

    const second = await deleteOrphanedOpenQuestions();
    expect(second.deletedCount).toBe(0);
    expect(second.deletedIds).toEqual([]);
  });

  it("deletes all rows when project index is empty", async () => {
    await insertOpenQuestion(testClientRef.current!, "oq-1", "proj-a");
    await insertOpenQuestion(testClientRef.current!, "oq-2", "proj-b");

    const result = await deleteOrphanedOpenQuestions();

    expect(result.deletedCount).toBe(2);
    expect(await countOpenQuestions(testClientRef.current!)).toBe(0);
  });
});
