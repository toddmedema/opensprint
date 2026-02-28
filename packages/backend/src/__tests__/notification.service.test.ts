import { describe, it, expect, beforeEach, vi } from "vitest";
import initSqlJs from "sql.js";
import { NotificationService } from "../services/notification.service.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import type { DbClient } from "../db/client.js";
import { createSqliteDbClient, SCHEMA_SQL_SQLITE } from "./test-db-helper.js";

let sharedClient: DbClient;
vi.mock("../services/task-store.service.js", async () => ({
  taskStore: {
    async getDb() {
      if (!sharedClient) throw new Error("sharedClient not initialized");
      return sharedClient;
    },
    async runWrite<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
      if (!sharedClient) throw new Error("sharedClient not initialized");
      return fn(sharedClient);
    },
  },
  TaskStoreService: vi.fn(),
  SCHEMA_SQL: "",
}));

describe("NotificationService", () => {
  let service: NotificationService;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(SCHEMA_SQL_SQLITE);
    sharedClient = createSqliteDbClient(db);
    service = new NotificationService();
  });

  describe("create", () => {
    it("creates a notification with open status", async () => {
      const result = await service.create({
        projectId: "proj-1",
        source: "plan",
        sourceId: "plan-abc",
        questions: [
          { id: "q1", text: "What is the target audience?" },
          { id: "q2", text: "What is the deadline?" },
        ],
      });

      expect(result.id).toMatch(/^oq-[0-9a-f]{8}$/);
      expect(result.projectId).toBe("proj-1");
      expect(result.source).toBe("plan");
      expect(result.sourceId).toBe("plan-abc");
      expect(result.questions).toHaveLength(2);
      expect(result.questions[0]).toEqual({
        id: "q1",
        text: "What is the target audience?",
        createdAt: expect.any(String),
      });
      expect(result.questions[1]).toEqual({
        id: "q2",
        text: "What is the deadline?",
        createdAt: expect.any(String),
      });
      expect(result.status).toBe("open");
      expect(result.resolvedAt).toBeNull();
    });

    it("persists notification to database", async () => {
      const created = await service.create({
        projectId: "proj-2",
        source: "execute",
        sourceId: "task-xyz",
        questions: [{ id: "q1", text: "Clarify scope?" }],
      });

      const listed = await service.listByProject("proj-2");
      expect(listed).toHaveLength(1);
      expect(listed[0]!.id).toBe(created.id);
      expect(listed[0]!.source).toBe("execute");
      expect(listed[0]!.sourceId).toBe("task-xyz");
    });
  });

  describe("createApiBlocked", () => {
    it("creates API-blocked notification with error code", async () => {
      const result = await service.createApiBlocked({
        projectId: "proj-1",
        source: "execute",
        sourceId: "task-1",
        message: "Rate limit exceeded. Add more API keys.",
        errorCode: "rate_limit",
      });

      expect(result.id).toMatch(/^ab-[0-9a-f]{8}$/);
      expect(result.projectId).toBe("proj-1");
      expect(result.source).toBe("execute");
      expect(result.sourceId).toBe("task-1");
      expect(result.kind).toBe("api_blocked");
      expect(result.errorCode).toBe("rate_limit");
      expect(result.questions).toHaveLength(1);
      expect(result.questions[0]!.text).toBe("Rate limit exceeded. Add more API keys.");
      expect(result.status).toBe("open");
    });

    it("api-blocked notifications appear in listByProject", async () => {
      await service.createApiBlocked({
        projectId: "proj-x",
        source: "execute",
        sourceId: "task-1",
        message: "Invalid API key",
        errorCode: "auth",
      });

      const list = await service.listByProject("proj-x");
      expect(list).toHaveLength(1);
      expect(list[0]!.kind).toBe("api_blocked");
      expect(list[0]!.errorCode).toBe("auth");
    });
  });

  describe("listByProject", () => {
    it("returns only open notifications for the project", async () => {
      await service.create({
        projectId: "proj-a",
        source: "plan",
        sourceId: "p1",
        questions: [{ id: "q1", text: "Q1" }],
      });
      await service.create({
        projectId: "proj-a",
        source: "prd",
        sourceId: "s1",
        questions: [{ id: "q2", text: "Q2" }],
      });
      await service.create({
        projectId: "proj-b",
        source: "plan",
        sourceId: "p2",
        questions: [{ id: "q3", text: "Q3" }],
      });

      const list = await service.listByProject("proj-a");
      expect(list).toHaveLength(2);
      expect(list.map((n) => n.sourceId)).toContain("p1");
      expect(list.map((n) => n.sourceId)).toContain("s1");
      expect(list.map((n) => n.sourceId)).not.toContain("p2");
    });

    it("excludes resolved notifications", async () => {
      const created = await service.create({
        projectId: "proj-c",
        source: "eval",
        sourceId: "fb-1",
        questions: [{ id: "q1", text: "Q1" }],
      });
      await service.resolve("proj-c", created.id);

      const list = await service.listByProject("proj-c");
      expect(list).toHaveLength(0);
    });

    it("returns empty array when no notifications", async () => {
      const list = await service.listByProject("proj-empty");
      expect(list).toEqual([]);
    });
  });

  describe("listGlobal", () => {
    it("returns all open notifications across projects", async () => {
      await service.create({
        projectId: "proj-x",
        source: "plan",
        sourceId: "p1",
        questions: [{ id: "q1", text: "Q1" }],
      });
      await service.create({
        projectId: "proj-y",
        source: "execute",
        sourceId: "t1",
        questions: [{ id: "q2", text: "Q2" }],
      });

      const list = await service.listGlobal();
      expect(list).toHaveLength(2);
      expect(list.map((n) => n.projectId)).toContain("proj-x");
      expect(list.map((n) => n.projectId)).toContain("proj-y");
    });

    it("excludes resolved notifications", async () => {
      const created = await service.create({
        projectId: "proj-z",
        source: "plan",
        sourceId: "p1",
        questions: [{ id: "q1", text: "Q1" }],
      });
      await service.resolve("proj-z", created.id);

      const list = await service.listGlobal();
      expect(list).toHaveLength(0);
    });
  });

  describe("resolve", () => {
    it("marks notification as resolved", async () => {
      const created = await service.create({
        projectId: "proj-r",
        source: "plan",
        sourceId: "plan-1",
        questions: [{ id: "q1", text: "Q1" }],
      });

      const resolved = await service.resolve("proj-r", created.id);
      expect(resolved.status).toBe("resolved");
      expect(resolved.resolvedAt).toBeTruthy();

      const list = await service.listByProject("proj-r");
      expect(list).toHaveLength(0);
    });

    it("throws NOTIFICATION_NOT_FOUND when notification does not exist", async () => {
      const err = await service.resolve("proj-r", "oq-nonexistent").catch((e) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(404);
      expect((err as AppError).code).toBe(ErrorCodes.NOTIFICATION_NOT_FOUND);
    });

    it("throws when project ID does not match", async () => {
      const created = await service.create({
        projectId: "proj-match",
        source: "plan",
        sourceId: "p1",
        questions: [{ id: "q1", text: "Q1" }],
      });

      const err = await service.resolve("proj-wrong", created.id).catch((e) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(404);
    });
  });

  describe("deleteAll", () => {
    it("deletes all notifications and returns count", async () => {
      await service.create({
        projectId: "proj-1",
        source: "plan",
        sourceId: "p1",
        questions: [{ id: "q1", text: "Q1" }],
      });
      await service.create({
        projectId: "proj-2",
        source: "execute",
        sourceId: "t1",
        questions: [{ id: "q2", text: "Q2" }],
      });

      const deleted = await service.deleteAll();

      expect(deleted).toBe(2);
      expect(await service.listGlobal()).toHaveLength(0);
    });

    it("returns 0 when no notifications exist", async () => {
      const deleted = await service.deleteAll();
      expect(deleted).toBe(0);
    });

    it("is idempotent — second call returns 0", async () => {
      await service.create({
        projectId: "proj-1",
        source: "plan",
        sourceId: "p1",
        questions: [{ id: "q1", text: "Q1" }],
      });

      const first = await service.deleteAll();
      expect(first).toBe(1);

      const second = await service.deleteAll();
      expect(second).toBe(0);
    });
  });
});
