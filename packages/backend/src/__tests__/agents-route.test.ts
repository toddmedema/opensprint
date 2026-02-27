import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createApp } from "../app.js";
import { ProjectService } from "../services/project.service.js";
import { activeAgentsService } from "../services/active-agents.service.js";
import { API_PREFIX, DEFAULT_HIL_CONFIG } from "@opensprint/shared";

describe("Agents API", () => {
  let app: ReturnType<typeof createApp>;
  let projectService: ProjectService;
  let tempDir: string;
  let projectId: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    app = createApp();
    projectService = new ProjectService();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-agents-route-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    const repoPath = path.join(tempDir, "my-project");
    const project = await projectService.createProject({
      name: "Agents Test Project",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });
    projectId = project.id;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("GET /projects/:projectId/agents/active", () => {
    it("should return empty array when no agent is running", async () => {
      const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/agents/active`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it("should return 404 for non-existent project", async () => {
      const res = await request(app).get(`${API_PREFIX}/projects/nonexistent-id/agents/active`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
    });

    it("should return active agents from central registry", async () => {
      activeAgentsService.register(
        "task-123",
        projectId,
        "coding",
        "coder",
        "Implement login",
        "2026-02-16T10:00:00.000Z",
        "opensprint/task-123"
      );

      const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/agents/active`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        id: "task-123",
        phase: "coding",
        role: "coder",
        label: "Implement login",
        startedAt: "2026-02-16T10:00:00.000Z",
        branchName: "opensprint/task-123",
        name: "Frodo",
      });
    });
  });

  describe("GET /projects/:projectId/agents/instructions", () => {
    it("should return content when AGENTS.md exists", async () => {
      const repoPath = path.join(tempDir, "my-project");
      await fs.mkdir(repoPath, { recursive: true });
      await fs.writeFile(path.join(repoPath, "AGENTS.md"), "# Agent Instructions\n\nUse bd for tasks.", "utf-8");

      const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/agents/instructions`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ content: "# Agent Instructions\n\nUse bd for tasks." });
    });

    it("should return empty content when AGENTS.md is missing", async () => {
      const repoPath = path.join(tempDir, "my-project");
      await fs.unlink(path.join(repoPath, "AGENTS.md"));

      const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/agents/instructions`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ content: "" });
    });

    it("should return 404 for non-existent project", async () => {
      const res = await request(app).get(`${API_PREFIX}/projects/nonexistent-id/agents/instructions`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
    });
  });

  describe("PUT /projects/:projectId/agents/instructions", () => {
    it("should write content to AGENTS.md", async () => {
      const repoPath = path.join(tempDir, "my-project");
      await fs.mkdir(repoPath, { recursive: true });

      const res = await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/agents/instructions`)
        .send({ content: "# New Instructions\n\nHello world." });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ saved: true });

      const written = await fs.readFile(path.join(repoPath, "AGENTS.md"), "utf-8");
      expect(written).toBe("# New Instructions\n\nHello world.");
    });

    it("should return 400 when content is missing", async () => {
      const res = await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/agents/instructions`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("should return 404 for non-existent project", async () => {
      const res = await request(app)
        .put(`${API_PREFIX}/projects/nonexistent-id/agents/instructions`)
        .send({ content: "test" });

      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
    });
  });

  describe("POST /projects/:projectId/agents/:agentId/kill", () => {
    it("should return 404 when agent is not in slots (e.g. planning agent)", async () => {
      activeAgentsService.register(
        "plan-agent-1",
        projectId,
        "plan",
        "planner",
        "Generate tasks",
        "2026-02-16T10:00:00.000Z"
      );

      const res = await request(app).post(
        `${API_PREFIX}/projects/${projectId}/agents/plan-agent-1/kill`
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");

      activeAgentsService.unregister("plan-agent-1");
    });

    it("should return 404 for non-existent project", async () => {
      const res = await request(app).post(
        `${API_PREFIX}/projects/nonexistent-id/agents/task-123/kill`
      );

      expect(res.status).toBe(404);
    });
  });

  afterEach(() => {
    activeAgentsService.unregister("task-123");
  });
});
