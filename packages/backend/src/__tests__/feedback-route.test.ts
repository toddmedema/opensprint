import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createApp } from "../app.js";
import { ProjectService } from "../services/project.service.js";
import { API_PREFIX, DEFAULT_HIL_CONFIG, OPENSPRINT_PATHS } from "@opensprint/shared";

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
      description: "A test project",
      repoPath: path.join(tempDir, "my-project"),
      planningAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      codingAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });
    projectId = project.id;
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
    const feedbackDir = path.join(tempDir, "my-project", OPENSPRINT_PATHS.feedback);
    await fs.mkdir(feedbackDir, { recursive: true });
    const item = {
      id: "fb-test-1",
      text: "Login button broken",
      category: "bug",
      mappedPlanId: null,
      createdTaskIds: [],
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(feedbackDir, "fb-test-1.json"), JSON.stringify(item), "utf-8");

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
    const res = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/feedback`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("INVALID_INPUT");
  });

  it("POST /projects/:id/feedback should accept and store image attachments", async () => {
    const base64Image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
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
    const feedbackDir = path.join(tempDir, "my-project", OPENSPRINT_PATHS.feedback);
    await fs.mkdir(feedbackDir, { recursive: true });
    const item = {
      id: "fb-get-1",
      text: "Fix navigation",
      category: "ux",
      mappedPlanId: "nav-plan",
      createdTaskIds: ["bd-xyz.1"],
      status: "mapped",
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(feedbackDir, "fb-get-1.json"), JSON.stringify(item), "utf-8");

    const res = await request(app).get(
      `${API_PREFIX}/projects/${projectId}/feedback/fb-get-1`
    );

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("fb-get-1");
    expect(res.body.data.text).toBe("Fix navigation");
    expect(res.body.data.createdTaskIds).toEqual(["bd-xyz.1"]);
  });

  it("POST /projects/:id/feedback should create reply with parent_id and depth", async () => {
    const feedbackDir = path.join(tempDir, "my-project", OPENSPRINT_PATHS.feedback);
    await fs.mkdir(feedbackDir, { recursive: true });
    const parentItem = {
      id: "parent1",
      text: "Original feedback",
      category: "bug",
      mappedPlanId: null,
      createdTaskIds: [],
      status: "mapped",
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(feedbackDir, "parent1.json"), JSON.stringify(parentItem), "utf-8");

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
    const feedbackDir = path.join(tempDir, "my-project", OPENSPRINT_PATHS.feedback);
    await fs.mkdir(feedbackDir, { recursive: true });
    const item = {
      id: "fb-resolve-1",
      text: "Bug in login",
      category: "bug",
      mappedPlanId: null,
      createdTaskIds: [],
      status: "mapped",
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(feedbackDir, "fb-resolve-1.json"), JSON.stringify(item), "utf-8");

    const res = await request(app).post(
      `${API_PREFIX}/projects/${projectId}/feedback/fb-resolve-1/resolve`
    );

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("fb-resolve-1");
    expect(res.body.data.status).toBe("resolved");

    const fileContent = await fs.readFile(path.join(feedbackDir, "fb-resolve-1.json"), "utf-8");
    const saved = JSON.parse(fileContent);
    expect(saved.status).toBe("resolved");
  });

  it("POST /projects/:id/feedback/:feedbackId/resolve should return 404 when not found", async () => {
    const res = await request(app).post(
      `${API_PREFIX}/projects/${projectId}/feedback/nonexistent-id/resolve`
    );

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("FEEDBACK_NOT_FOUND");
  });
});
