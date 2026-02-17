import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createApp } from "../app.js";
import { ProjectService } from "../services/project.service.js";
import { API_PREFIX, DEFAULT_HIL_CONFIG } from "@opensprint/shared";

describe("Deploy API", () => {
  let app: ReturnType<typeof createApp>;
  let projectService: ProjectService;
  let tempDir: string;
  let projectId: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    app = createApp();
    projectService = new ProjectService();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-deploy-route-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    const repoPath = path.join(tempDir, "my-project");
    await fs.mkdir(repoPath, { recursive: true });
    await fs.writeFile(
      path.join(repoPath, "package.json"),
      JSON.stringify({ name: "test", scripts: { test: "echo ok" } }),
    );
    const project = await projectService.createProject({
      name: "Deploy Test Project",
      description: "For deploy API tests",
      repoPath,
      planningAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      codingAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      deployment: {
        mode: "custom",
        customCommand: "echo deployed",
        rollbackCommand: "echo rolled-back",
        target: "staging",
      },
      hilConfig: DEFAULT_HIL_CONFIG,
    });
    projectId = project.id;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("GET /projects/:projectId/deploy/status", () => {
    it("should return deploy status for existing project", async () => {
      const res = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/deploy/status`,
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data).toMatchObject({
        activeDeployId: null,
      });
      expect(res.body.data.currentDeploy).toBeNull();
    });

    it("should return 404 for non-existent project", async () => {
      const res = await request(app).get(
        `${API_PREFIX}/projects/nonexistent-id/deploy/status`,
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
    });
  });

  describe("GET /projects/:projectId/deploy/history", () => {
    it("should return empty history for new project", async () => {
      const res = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/deploy/history`,
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it("should return 404 for non-existent project", async () => {
      const res = await request(app).get(
        `${API_PREFIX}/projects/nonexistent-id/deploy/history`,
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
    });
  });

  describe("POST /projects/:projectId/deploy", () => {
    it("should accept deploy and return deployId", async () => {
      const res = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/deploy`);

      expect(res.status).toBe(202);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.deployId).toBeDefined();
      expect(typeof res.body.data.deployId).toBe("string");
    });

    it("should return 404 for non-existent project", async () => {
      const res = await request(app)
        .post(`${API_PREFIX}/projects/nonexistent-id/deploy`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
    });
  });

  describe("PUT /projects/:projectId/deploy/settings", () => {
    it("should update deployment settings", async () => {
      const res = await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/deploy/settings`)
        .send({ mode: "custom", customCommand: "npm run deploy" });

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.deployment).toMatchObject({
        mode: "custom",
        customCommand: "npm run deploy",
      });
    });

    it("should accept and persist autoDeployOnEpicCompletion and autoDeployOnEvalResolution (PRD §7.5.3)", async () => {
      const res = await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/deploy/settings`)
        .send({
          mode: "custom",
          autoDeployOnEpicCompletion: true,
          autoDeployOnEvalResolution: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.data.deployment.autoDeployOnEpicCompletion).toBe(true);
      expect(res.body.data.deployment.autoDeployOnEvalResolution).toBe(true);

      const getRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
      expect(getRes.body.data.deployment.autoDeployOnEpicCompletion).toBe(true);
      expect(getRes.body.data.deployment.autoDeployOnEvalResolution).toBe(true);
    });
  });

  describe("POST /projects/:projectId/deploy - record fields", () => {
    it("should create deploy record with commitHash, target, mode from settings", async () => {
      await request(app).post(`${API_PREFIX}/projects/${projectId}/deploy`);

      // Wait for deploy to complete (echo is fast)
      await new Promise((r) => setTimeout(r, 500));

      const historyRes = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/deploy/history?limit=1`,
      );
      expect(historyRes.status).toBe(200);
      expect(historyRes.body.data.length).toBeGreaterThan(0);

      const record = historyRes.body.data[0];
      expect(record.target).toBe("staging");
      expect(record.mode).toBe("custom");
      // commitHash may be a SHA or null if git fails
      expect(typeof record.commitHash === "string" || record.commitHash === null).toBe(true);
    });
  });

  describe("POST /projects/:projectId/deploy/:deployId/rollback", () => {
    it("should mark original deploy as rolled_back on success", async () => {
      await request(app).post(`${API_PREFIX}/projects/${projectId}/deploy`);
      await new Promise((r) => setTimeout(r, 500));

      await request(app).post(`${API_PREFIX}/projects/${projectId}/deploy`);
      await new Promise((r) => setTimeout(r, 500));

      const historyBefore = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/deploy/history?limit=5`,
      );
      const deployToRestore = historyBefore.body.data[1];
      const currentDeploy = historyBefore.body.data[0];

      const rollbackRes = await request(app).post(
        `${API_PREFIX}/projects/${projectId}/deploy/${deployToRestore.id}/rollback`,
      );
      expect(rollbackRes.status).toBe(202);
      const rollbackDeployId = rollbackRes.body.data.deployId;

      await new Promise((r) => setTimeout(r, 500));

      const historyRes = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/deploy/history?limit=5`,
      );
      const records = historyRes.body.data;

      const rollbackRecord = records.find((r: { id: string }) => r.id === rollbackDeployId);
      expect(rollbackRecord).toBeDefined();
      expect(rollbackRecord.status).toBe("success");

      const rolledBackRecord = records.find(
        (r: { id: string; rolledBackBy?: string }) => r.id === currentDeploy.id,
      );
      expect(rolledBackRecord).toBeDefined();
      expect(rolledBackRecord.status).toBe("rolled_back");
      expect(rolledBackRecord.rolledBackBy).toBe(rollbackDeployId);
    });
  });
});
