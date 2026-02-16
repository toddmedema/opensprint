import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createApp } from "../app.js";
import { ProjectService } from "../services/project.service.js";
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
      description: "For agents API tests",
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

  describe("GET /projects/:projectId/agents/active", () => {
    it("should return empty array when no agent is running", async () => {
      const res = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/agents/active`,
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it("should return 404 for non-existent project", async () => {
      const res = await request(app).get(
        `${API_PREFIX}/projects/nonexistent-id/agents/active`,
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
    });
  });
});
