import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createApp } from "../app.js";
import { ProjectService } from "../services/project.service.js";
import { API_PREFIX, DEFAULT_HIL_CONFIG } from "@opensprint/shared";

describe("Projects REST API — spec/sketch phase routes", () => {
  let app: ReturnType<typeof createApp>;
  let projectService: ProjectService;
  let tempDir: string;
  let projectId: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    app = createApp();
    projectService = new ProjectService();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-projects-route-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    const repoPath = path.join(tempDir, "my-project");
    await fs.mkdir(repoPath, { recursive: true });
    const project = await projectService.createProject({
      name: "Sketch Test Project",
      description: "For spec/sketch route tests",
      repoPath,
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

  it("GET /projects/:id/spec should 301 redirect to /projects/:id/sketch (backwards compatibility)", async () => {
    const res = await request(app)
      .get(`${API_PREFIX}/projects/${projectId}/spec`)
      .redirects(0);

    expect(res.status).toBe(301);
    expect(res.headers.location).toMatch(new RegExp(`/projects/${projectId}/sketch$`));
  });

  it("GET /projects/:id/sketch should return project (Sketch phase canonical endpoint)", async () => {
    const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/sketch`);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.id).toBe(projectId);
    expect(res.body.data.name).toBe("Sketch Test Project");
    expect(res.body.data.currentPhase).toBe("sketch");
  });
});
