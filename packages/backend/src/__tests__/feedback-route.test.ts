import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createApp } from "../app.js";
import { ProjectService } from "../services/project.service.js";
import { feedbackStore } from "../services/feedback-store.service.js";
import { taskStore } from "../services/task-store.service.js";
import { API_PREFIX, DEFAULT_HIL_CONFIG } from "@opensprint/shared";

vi.mock("../services/agent-client.js", () => ({
  AgentClient: vi.fn().mockImplementation(() => ({
    invoke: vi.fn().mockResolvedValue({
      content: JSON.stringify({
        category: "feature",
        mappedPlanId: null,
        task_titles: ["Add requested feature"],
      }),
    }),
  })),
}));

vi.mock("../services/hil-service.js", () => ({
  hilService: { evaluateDecision: vi.fn().mockResolvedValue({ approved: false }) },
}));

vi.mock("../websocket/index.js", () => ({
  broadcastToProject: vi.fn(),
}));

vi.mock("../services/deploy-trigger.service.js", () => ({
  triggerDeploy: vi.fn().mockResolvedValue("deploy-123"),
}));

describe("Feedback REST API", () => {
  let app: ReturnType<typeof createApp>;
  let projectService: ProjectService;
  let tempDir: string;
  let projectId: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    app = createApp();
    projectService = new ProjectService();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-feedback-route-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    const project = await projectService.createProject({
      name: "Test Project",
      repoPath: path.join(tempDir, "my-project"),
      lowComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      highComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
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

  it("GET /projects/:id/feedback should return empty list when no feedback", async () => {
    const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/feedback`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("GET /projects/:id/feedback should list feedback items", async () => {
    await feedbackStore.insertFeedback(
      projectId,
      {
        id: "fb-test-1",
        text: "Login button broken",
        category: "bug",
        mappedPlanId: null,
        createdTaskIds: [],
        status: "pending",
        createdAt: new Date().toISOString(),
      },
      null
    );

    const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/feedback`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe("fb-test-1");
    expect(res.body.data[0].text).toBe("Login button broken");
  });

  it("POST /projects/:id/feedback should create feedback and return 201", async () => {
    const res = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/feedback`)
      .send({ text: "Add dark mode toggle" });

    expect(res.status).toBe(201);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.id).toBeDefined();
    expect(res.body.data.id).toMatch(/^[a-z0-9]{6}$/);
    expect(res.body.data.text).toBe("Add dark mode toggle");
    expect(res.body.data.category).toBe("bug");
    expect(res.body.data.status).toBe("pending");
    expect(res.body.data.createdAt).toBeDefined();
  });

  it("POST /projects/:id/feedback should return 400 when text is empty", async () => {
    const res = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/feedback`)
      .send({ text: "" });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("INVALID_INPUT");
  });

  it("POST /projects/:id/feedback should return 400 when text is missing", async () => {
    const res = await request(app).post(`${API_PREFIX}/projects/${projectId}/feedback`).send({});

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("INVALID_INPUT");
  });

  it("POST /projects/:id/feedback should accept and store image attachments", async () => {
    const base64Image =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const res = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/feedback`)
      .send({
        text: "Bug with screenshot",
        images: [`data:image/png;base64,${base64Image}`],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.images).toBeDefined();
    expect(res.body.data.images).toHaveLength(1);
    expect(res.body.data.images[0]).toContain("data:image/png;base64,");
  });

  it("GET /projects/:id/feedback/:feedbackId should return feedback item", async () => {
    await feedbackStore.insertFeedback(
      projectId,
      {
        id: "fb-get-1",
        text: "Fix navigation",
        category: "ux",
        mappedPlanId: "nav-plan",
        createdTaskIds: ["bd-xyz.1"],
        status: "pending",
        createdAt: new Date().toISOString(),
      },
      null
    );

    const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/feedback/fb-get-1`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("fb-get-1");
    expect(res.body.data.text).toBe("Fix navigation");
    expect(res.body.data.createdTaskIds).toEqual(["bd-xyz.1"]);
  });

  it("POST /projects/:id/feedback should create reply with parent_id and depth", async () => {
    await feedbackStore.insertFeedback(
      projectId,
      {
        id: "parent1",
        text: "Original feedback",
        category: "bug",
        mappedPlanId: null,
        createdTaskIds: [],
        status: "pending",
        createdAt: new Date().toISOString(),
      },
      null
    );

    const res = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/feedback`)
      .send({ text: "Reply to original", parent_id: "parent1" });

    expect(res.status).toBe(201);
    expect(res.body.data.parent_id).toBe("parent1");
    expect(res.body.data.depth).toBe(1);
  });

  it("POST /projects/:id/feedback should return 404 when parent_id not found", async () => {
    const res = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/feedback`)
      .send({ text: "Reply to missing", parent_id: "nonexistent" });

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("FEEDBACK_NOT_FOUND");
  });

  it("GET /projects/:id/feedback/:feedbackId should return 404 when not found", async () => {
    const res = await request(app).get(
      `${API_PREFIX}/projects/${projectId}/feedback/nonexistent-id`
    );

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("FEEDBACK_NOT_FOUND");
  });

  it("POST /projects/:id/feedback/:feedbackId/resolve should set status to resolved", async () => {
    await feedbackStore.insertFeedback(
      projectId,
      {
        id: "fb-resolve-1",
        text: "Bug in login",
        category: "bug",
        mappedPlanId: null,
        createdTaskIds: [],
        status: "pending",
        createdAt: new Date().toISOString(),
      },
      null
    );

    const res = await request(app).post(
      `${API_PREFIX}/projects/${projectId}/feedback/fb-resolve-1/resolve`
    );

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("fb-resolve-1");
    expect(res.body.data.status).toBe("resolved");

    const saved = await feedbackStore.getFeedback(projectId, "fb-resolve-1");
    expect(saved.status).toBe("resolved");
  });

  it("POST /projects/:id/feedback/:feedbackId/resolve should return 404 when not found", async () => {
    const res = await request(app).post(
      `${API_PREFIX}/projects/${projectId}/feedback/nonexistent-id/resolve`
    );

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("FEEDBACK_NOT_FOUND");
  });

  it("POST /projects/:id/feedback/:feedbackId/resolve should cascade to children", async () => {
    await feedbackStore.insertFeedback(
      projectId,
      {
        id: "fb-cascade-parent",
        text: "Parent feedback",
        category: "bug",
        mappedPlanId: null,
        createdTaskIds: [],
        status: "pending",
        createdAt: new Date().toISOString(),
      },
      null
    );
    await feedbackStore.insertFeedback(
      projectId,
      {
        id: "fb-cascade-child",
        text: "Child reply",
        category: "bug",
        mappedPlanId: null,
        createdTaskIds: [],
        status: "pending",
        createdAt: new Date().toISOString(),
        parent_id: "fb-cascade-parent",
        depth: 1,
      },
      null
    );

    const res = await request(app).post(
      `${API_PREFIX}/projects/${projectId}/feedback/fb-cascade-parent/resolve`
    );

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("resolved");

    const savedChild = await feedbackStore.getFeedback(projectId, "fb-cascade-child");
    expect(savedChild.status).toBe("resolved");
  });

  it("POST /projects/:id/feedback/:feedbackId/cancel should set status to cancelled", async () => {
    await feedbackStore.insertFeedback(
      projectId,
      {
        id: "fb-cancel-1",
        text: "Cancel this feedback",
        category: "bug",
        mappedPlanId: null,
        createdTaskIds: [],
        status: "pending",
        createdAt: new Date().toISOString(),
      },
      null
    );

    const res = await request(app).post(
      `${API_PREFIX}/projects/${projectId}/feedback/fb-cancel-1/cancel`
    );

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("fb-cancel-1");
    expect(res.body.data.status).toBe("cancelled");

    const saved = await feedbackStore.getFeedback(projectId, "fb-cancel-1");
    expect(saved.status).toBe("cancelled");
  });

  it("POST /projects/:id/feedback/:feedbackId/cancel should return 404 when not found", async () => {
    const res = await request(app).post(
      `${API_PREFIX}/projects/${projectId}/feedback/nonexistent-id/cancel`
    );

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("FEEDBACK_NOT_FOUND");
  });
});
