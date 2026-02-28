import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createApp } from "../app.js";
import { ProjectService } from "../services/project.service.js";
import { notificationService } from "../services/notification.service.js";
import { taskStore } from "../services/task-store.service.js";
import { API_PREFIX, DEFAULT_HIL_CONFIG } from "@opensprint/shared";

describe("Notifications REST API", () => {
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
});
