import { describe, it, expect, beforeEach, vi } from "vitest";
import { NotificationService } from "../services/notification.service.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import type { DbClient } from "../db/client.js";

const { sharedClientRef } = vi.hoisted(() => ({
  sharedClientRef: { current: null as DbClient | null },
}));
vi.mock("../services/task-store.service.js", async () => {
  const { createTestPostgresClient } = await import("./test-db-helper.js");
  const dbResult = await createTestPostgresClient();
  sharedClientRef.current = dbResult?.client ?? null;
  return {
    taskStore: {
      async getDb() {
        if (!sharedClientRef.current) throw new Error("sharedClient not initialized");
        return sharedClientRef.current;
      },
      async runWrite<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
        if (!sharedClientRef.current) throw new Error("sharedClient not initialized");
        return fn(sharedClientRef.current);
      },
    },
    TaskStoreService: vi.fn(),
    SCHEMA_SQL: "",
    _postgresAvailable: !!dbResult,
  };
});

const notifTaskStoreMod = await import("../services/task-store.service.js");
const notifPostgresOk =
  (notifTaskStoreMod as { _postgresAvailable?: boolean })._postgresAvailable ?? false;

describe.skipIf(!notifPostgresOk)("NotificationService", () => {
  let service: NotificationService;

  beforeEach(async () => {
    if (!sharedClientRef.current) throw new Error("Postgres required");
    await sharedClientRef.current.execute("DELETE FROM open_questions");
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

  describe("createHilApproval", () => {
    it("creates HIL approval with scopeChangeMetadata and persists for diff display", async () => {
      const scopeChangeMetadata = {
        scopeChangeSummary: "• feature_list: Add mobile app",
        scopeChangeProposedUpdates: [
          {
            section: "feature_list",
            changeLogEntry: "Add mobile app",
            content: "1. Web dashboard\n2. Mobile app",
          },
        ],
      };
      const result = await service.createHilApproval({
        projectId: "proj-hil",
        source: "eval",
        sourceId: "fb-1",
        description: "Approve scope change?",
        category: "scopeChanges",
        scopeChangeMetadata,
      });

      expect(result.id).toMatch(/^hil-[0-9a-f]{8}$/);
      expect(result.kind).toBe("hil_approval");
      expect(result.scopeChangeMetadata).toEqual(scopeChangeMetadata);

      const list = await service.listByProject("proj-hil");
      expect(list).toHaveLength(1);
      expect(list[0]!.scopeChangeMetadata).toEqual(scopeChangeMetadata);
      expect(list[0]!.scopeChangeMetadata!.scopeChangeProposedUpdates[0]!.content).toBe(
        "1. Web dashboard\n2. Mobile app"
      );
    });
  });

  describe("hasOpenPrdSpecHilApproval", () => {
    it("returns true when project has open HIL approval with scope_change_metadata", async () => {
      await service.createHilApproval({
        projectId: "proj-prd-hil",
        source: "eval",
        sourceId: "fb-1",
        description: "Approve SPEC changes?",
        category: "scopeChanges",
        scopeChangeMetadata: {
          scopeChangeSummary: "Update feature_list",
          scopeChangeProposedUpdates: [
            { section: "feature_list", changeLogEntry: "Add item", content: "1. A\n2. B" },
          ],
        },
      });

      const result = await service.hasOpenPrdSpecHilApproval("proj-prd-hil");
      expect(result).toBe(true);
    });

    it("returns false when project has no open notifications", async () => {
      const result = await service.hasOpenPrdSpecHilApproval("proj-empty");
      expect(result).toBe(false);
    });

    it("returns false when project has open HIL approval without scope_change_metadata", async () => {
      await service.createHilApproval({
        projectId: "proj-hil-no-scope",
        source: "eval",
        sourceId: "arch-1",
        description: "Approve architecture change?",
        category: "architectureDecisions",
      });

      const result = await service.hasOpenPrdSpecHilApproval("proj-hil-no-scope");
      expect(result).toBe(false);
    });

    it("returns false when PRD/SPEC HIL was resolved", async () => {
      const notif = await service.createHilApproval({
        projectId: "proj-resolved",
        source: "eval",
        sourceId: "fb-2",
        description: "Approve scope?",
        category: "scopeChanges",
        scopeChangeMetadata: {
          scopeChangeSummary: "Summary",
          scopeChangeProposedUpdates: [],
        },
      });
      await service.resolve("proj-resolved", notif.id);

      const result = await service.hasOpenPrdSpecHilApproval("proj-resolved");
      expect(result).toBe(false);
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

    it("dedupes unresolved api-blocked notifications by project, source, sourceId, and error code", async () => {
      const first = await service.createApiBlocked({
        projectId: "proj-dedupe",
        source: "prd",
        sourceId: "global",
        message: "Google Gemini hit a rate limit",
        errorCode: "rate_limit",
      });
      const second = await service.createApiBlocked({
        projectId: "proj-dedupe",
        source: "prd",
        sourceId: "global",
        message: "Google Gemini hit a rate limit again",
        errorCode: "rate_limit",
      });

      expect(second.id).toBe(first.id);
      const list = await service.listByProject("proj-dedupe");
      expect(list).toHaveLength(1);
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

  describe("resolveRateLimitNotifications", () => {
    it("resolves all open rate_limit api_blocked notifications for project", async () => {
      await service.createApiBlocked({
        projectId: "proj-rl",
        source: "execute",
        sourceId: "task-1",
        message: "Rate limit hit",
        errorCode: "rate_limit",
      });
      await service.createApiBlocked({
        projectId: "proj-rl",
        source: "execute",
        sourceId: "api-keys-ANTHROPIC_API_KEY",
        message: "All keys exhausted",
        errorCode: "rate_limit",
      });
      await service.createApiBlocked({
        projectId: "proj-rl",
        source: "execute",
        sourceId: "task-2",
        message: "Invalid key",
        errorCode: "auth",
      });

      const resolved = await service.resolveRateLimitNotifications("proj-rl");

      expect(resolved).toHaveLength(2);
      expect(resolved.map((r) => r.id)).toHaveLength(2);
      const list = await service.listByProject("proj-rl");
      expect(list).toHaveLength(1);
      expect(list[0]!.errorCode).toBe("auth");
    });

    it("returns empty array when no rate limit notifications exist", async () => {
      const resolved = await service.resolveRateLimitNotifications("proj-empty");
      expect(resolved).toEqual([]);
    });

    it("does not resolve notifications from other projects", async () => {
      await service.createApiBlocked({
        projectId: "proj-a",
        source: "execute",
        sourceId: "task-1",
        message: "Rate limit",
        errorCode: "rate_limit",
      });
      await service.createApiBlocked({
        projectId: "proj-b",
        source: "execute",
        sourceId: "task-2",
        message: "Rate limit",
        errorCode: "rate_limit",
      });

      const resolved = await service.resolveRateLimitNotifications("proj-a");

      expect(resolved).toHaveLength(1);
      const listA = await service.listByProject("proj-a");
      expect(listA).toHaveLength(0);
      const listB = await service.listByProject("proj-b");
      expect(listB).toHaveLength(1);
    });
  });

  describe("getById", () => {
    it("returns the notification when it exists", async () => {
      const created = await service.createHilApproval({
        projectId: "proj-get",
        source: "eval",
        sourceId: "fb-1",
        description: "Approve SPEC changes?",
        category: "scopeChanges",
        scopeChangeMetadata: {
          scopeChangeSummary: "Update feature_list",
          scopeChangeProposedUpdates: [
            { section: "feature_list", changeLogEntry: "Add item", content: "1. A\n2. B" },
          ],
        },
      });

      const found = await service.getById("proj-get", created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.projectId).toBe("proj-get");
      expect(found!.kind).toBe("hil_approval");
      expect(found!.scopeChangeMetadata).toEqual(created.scopeChangeMetadata);
    });

    it("returns null when not found", async () => {
      const found = await service.getById("proj-get", "oq-nonexistent");
      expect(found).toBeNull();
    });

    it("returns null when project ID does not match", async () => {
      const created = await service.create({
        projectId: "proj-owner",
        source: "plan",
        sourceId: "p1",
        questions: [{ id: "q1", text: "Q1" }],
      });

      const found = await service.getById("proj-other", created.id);
      expect(found).toBeNull();
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

    it("persists and returns responses when resolving with answers", async () => {
      const created = await service.create({
        projectId: "proj-resp",
        source: "execute",
        sourceId: "task-1",
        questions: [
          { id: "q1", text: "Which option?" },
          { id: "q2", text: "Deadline?" },
        ],
      });

      const responses = [
        { questionId: "q1", answer: "Option A" },
        { questionId: "q2", answer: "End of sprint" },
      ];
      const resolved = await service.resolve("proj-resp", created.id, { responses });

      expect(resolved.status).toBe("resolved");
      expect(resolved.resolvedAt).toBeTruthy();
      expect(resolved.responses).toEqual(responses);

      const found = await service.getById("proj-resp", created.id);
      expect(found?.status).toBe("resolved");
      expect(found?.responses).toEqual(responses);
    });
  });

  describe("getResolvedResponsesForTask", () => {
    it("returns null when no resolved notification with responses exists", async () => {
      const result = await service.getResolvedResponsesForTask("proj-g", "execute", "task-99");
      expect(result).toBeNull();
    });

    it("returns persisted responses for the task", async () => {
      const created = await service.create({
        projectId: "proj-g",
        source: "execute",
        sourceId: "task-1",
        questions: [{ id: "q1", text: "Clarify?" }],
      });
      await service.resolve("proj-g", created.id, {
        responses: [{ questionId: "q1", answer: "Use REST API" }],
      });

      const result = await service.getResolvedResponsesForTask("proj-g", "execute", "task-1");
      expect(result).toEqual([{ questionId: "q1", answer: "Use REST API" }]);
    });

    it("returns most recent when multiple resolved notifications exist", async () => {
      const first = await service.create({
        projectId: "proj-g",
        source: "execute",
        sourceId: "task-2",
        questions: [{ id: "q1", text: "Q?" }],
      });
      await service.resolve("proj-g", first.id, {
        responses: [{ questionId: "q1", answer: "First answer" }],
      });

      const second = await service.create({
        projectId: "proj-g",
        source: "execute",
        sourceId: "task-2",
        questions: [{ id: "q1", text: "Q again?" }],
      });
      await service.resolve("proj-g", second.id, {
        responses: [{ questionId: "q1", answer: "Second answer" }],
      });

      const result = await service.getResolvedResponsesForTask("proj-g", "execute", "task-2");
      expect(result).toEqual([{ questionId: "q1", answer: "Second answer" }]);
    });
  });

  describe("deleteByProject", () => {
    it("deletes all notifications for the project and returns count", async () => {
      await service.create({
        projectId: "proj-a",
        source: "plan",
        sourceId: "p1",
        questions: [{ id: "q1", text: "Q1" }],
      });
      await service.create({
        projectId: "proj-a",
        source: "execute",
        sourceId: "t1",
        questions: [{ id: "q2", text: "Q2" }],
      });
      await service.create({
        projectId: "proj-b",
        source: "plan",
        sourceId: "p2",
        questions: [{ id: "q3", text: "Q3" }],
      });

      const deleted = await service.deleteByProject("proj-a");

      expect(deleted).toBe(2);
      expect(await service.listByProject("proj-a")).toHaveLength(0);
      expect(await service.listByProject("proj-b")).toHaveLength(1);
    });

    it("returns 0 when project has no notifications", async () => {
      const deleted = await service.deleteByProject("proj-empty");
      expect(deleted).toBe(0);
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
