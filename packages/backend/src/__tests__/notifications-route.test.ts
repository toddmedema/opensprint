import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createApp } from "../app.js";
import { ProjectService } from "../services/project.service.js";
import { notificationService } from "../services/notification.service.js";
import { taskStore } from "../services/task-store.service.js";
import { setGlobalSettings } from "../services/global-settings.service.js";
import { API_PREFIX, DEFAULT_HIL_CONFIG } from "@opensprint/shared";

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (a: unknown, b: unknown) => [a, b],
}));
vi.mock("../db/drizzle-schema-pg.js", () => ({ plansTable: {} }));

vi.mock("../services/task-store.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/task-store.service.js")>();
  const { createTestPostgresClient } = await import("./test-db-helper.js");
  const dbResult = await createTestPostgresClient();
  if (!dbResult) {
    return {
      ...actual,
      TaskStoreService: class {
        constructor() {
          throw new Error("Postgres required");
        }
      },
      taskStore: null,
      _postgresAvailable: false,
    };
  }
  const store = new actual.TaskStoreService(dbResult.client);
  await store.init();
  return {
    ...actual,
    TaskStoreService: class extends actual.TaskStoreService {
      constructor() {
        super(dbResult.client);
      }
    },
    taskStore: store,
    _postgresAvailable: true,
  };
});

const notificationsTaskStoreMod = await import("../services/task-store.service.js");
const notificationsPostgresOk =
  (notificationsTaskStoreMod as { _postgresAvailable?: boolean })._postgresAvailable ?? false;

describe.skipIf(!notificationsPostgresOk)("Notifications REST API", () => {
  let app: ReturnType<typeof createApp>;
  let tempDir: string;
  let projectId: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    app = createApp();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-notifications-route-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    const projectService = new ProjectService();
    const project = await projectService.createProject({
      name: "Test Project",
      repoPath: path.join(tempDir, "my-project"),
      simpleComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });
    projectId = project.id;
    await taskStore.init();
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("GET /projects/:id/notifications returns empty list when no notifications", async () => {
    const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/notifications`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("GET /projects/:id/notifications returns open notifications", async () => {
    const created = await notificationService.create({
      projectId,
      source: "plan",
      sourceId: "plan-abc",
      questions: [{ id: "q1", text: "What is the scope?" }],
    });

    const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/notifications`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(created.id);
    expect(res.body.data[0].source).toBe("plan");
    expect(res.body.data[0].sourceId).toBe("plan-abc");
    expect(res.body.data[0].questions[0].text).toBe("What is the scope?");
    expect(res.body.data[0].status).toBe("open");
  });

  it("GET /notifications returns global open notifications", async () => {
    const created = await notificationService.create({
      projectId,
      source: "execute",
      sourceId: "task-1",
      questions: [{ id: "q1", text: "Clarify requirements?" }],
    });

    const res = await request(app).get(`${API_PREFIX}/notifications`);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeInstanceOf(Array);
    const ours = res.body.data.find((n: { id: string }) => n.id === created.id);
    expect(ours).toBeDefined();
    expect(ours.projectId).toBe(projectId);
    expect(ours.source).toBe("execute");
  });

  it("DELETE /projects/:id/notifications clears all project notifications", async () => {
    await notificationService.create({
      projectId,
      source: "plan",
      sourceId: "plan-1",
      questions: [{ id: "q1", text: "Q1" }],
    });
    await notificationService.create({
      projectId,
      source: "execute",
      sourceId: "task-1",
      questions: [{ id: "q2", text: "Q2" }],
    });

    const res = await request(app).delete(`${API_PREFIX}/projects/${projectId}/notifications`);

    expect(res.status).toBe(200);
    expect(res.body.data.deletedCount).toBe(2);

    const listRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/notifications`);
    expect(listRes.body.data).toHaveLength(0);
  });

  it("DELETE /notifications clears all global notifications", async () => {
    await notificationService.create({
      projectId,
      source: "plan",
      sourceId: "plan-1",
      questions: [{ id: "q1", text: "Q1" }],
    });

    const res = await request(app).delete(`${API_PREFIX}/notifications`);

    expect(res.status).toBe(200);
    expect(res.body.data.deletedCount).toBeGreaterThanOrEqual(1);

    const listRes = await request(app).get(`${API_PREFIX}/notifications`);
    expect(listRes.body.data).toHaveLength(0);
  });

  it("PATCH /projects/:id/notifications/:nid resolves notification", async () => {
    const created = await notificationService.create({
      projectId,
      source: "plan",
      sourceId: "plan-xyz",
      questions: [{ id: "q1", text: "Confirm deadline?" }],
    });

    const res = await request(app).patch(
      `${API_PREFIX}/projects/${projectId}/notifications/${created.id}`
    );

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("resolved");
    expect(res.body.data.resolvedAt).toBeDefined();

    const listRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/notifications`);
    expect(listRes.body.data).toHaveLength(0);
  });

  it("PATCH resolve execute notification unblocks the task", async () => {
    const task = await taskStore.create(projectId, "Test task", { type: "task" });
    await taskStore.update(projectId, task.id, {
      status: "blocked",
      block_reason: "Open Question",
    });

    const created = await notificationService.create({
      projectId,
      source: "execute",
      sourceId: task.id,
      questions: [{ id: "q1", text: "Clarify scope?" }],
    });

    const res = await request(app).patch(
      `${API_PREFIX}/projects/${projectId}/notifications/${created.id}`
    );

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("resolved");

    const updated = await taskStore.show(projectId, task.id);
    expect(updated.status).toBe("open");
    expect((updated as { block_reason?: string | null }).block_reason ?? null).toBeFalsy();
  });

  it("PATCH with body.responses persists and returns responses", async () => {
    const created = await notificationService.create({
      projectId,
      source: "execute",
      sourceId: "task-answer",
      questions: [
        { id: "q1", text: "Which approach?" },
        { id: "q2", text: "Timeline?" },
      ],
    });

    const responses = [
      { questionId: "q1", answer: "Use the existing API" },
      { questionId: "q2", answer: "This sprint" },
    ];
    const res = await request(app)
      .patch(`${API_PREFIX}/projects/${projectId}/notifications/${created.id}`)
      .send({ responses });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("resolved");
    expect(res.body.data.responses).toEqual(responses);

    const found = await notificationService.getById(projectId, created.id);
    expect(found?.responses).toEqual(responses);
  });

  describe("POST /projects/:id/notifications/:nid/retry-rate-limit", () => {
    it("resolves rate-limit notifications when keys are available", async () => {
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-available" }],
        },
      });

      const created = await notificationService.createApiBlocked({
        projectId,
        source: "execute",
        sourceId: "task-1",
        message: "Rate limit exceeded",
        errorCode: "rate_limit",
      });

      const res = await request(app).post(
        `${API_PREFIX}/projects/${projectId}/notifications/${created.id}/retry-rate-limit`
      );

      expect(res.status).toBe(200);
      expect(res.body.data.ok).toBe(true);
      expect(res.body.data.resolvedCount).toBeGreaterThanOrEqual(1);

      const listRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/notifications`);
      const rateLimitNotifications = listRes.body.data.filter(
        (n: { kind?: string; errorCode?: string }) =>
          n.kind === "api_blocked" && n.errorCode === "rate_limit"
      );
      expect(rateLimitNotifications).toHaveLength(0);
    });

    it("returns 400 when no API keys available", async () => {
      const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-limited", limitHitAt: recent }],
        },
      });

      const created = await notificationService.createApiBlocked({
        projectId,
        source: "execute",
        sourceId: "task-1",
        message: "Rate limit exceeded",
        errorCode: "rate_limit",
      });

      const res = await request(app).post(
        `${API_PREFIX}/projects/${projectId}/notifications/${created.id}/retry-rate-limit`
      );

      expect(res.status).toBe(400);
      expect(res.body.error?.message).toContain("No API keys available");
    });

    it("returns 404 when notification not found", async () => {
      const res = await request(app).post(
        `${API_PREFIX}/projects/${projectId}/notifications/nonexistent-id/retry-rate-limit`
      );

      expect(res.status).toBe(404);
    });

    it("returns 400 when notification is not rate_limit", async () => {
      const created = await notificationService.createApiBlocked({
        projectId,
        source: "execute",
        sourceId: "task-1",
        message: "Invalid API key",
        errorCode: "auth",
      });

      const res = await request(app).post(
        `${API_PREFIX}/projects/${projectId}/notifications/${created.id}/retry-rate-limit`
      );

      expect(res.status).toBe(400);
      expect(res.body.error?.message).toContain("only available for rate limit");
    });
  });
});
