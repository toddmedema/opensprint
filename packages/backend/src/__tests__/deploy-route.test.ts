import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { createApp } from "../app.js";
import { ProjectService } from "../services/project.service.js";
import { API_PREFIX, DEFAULT_HIL_CONFIG } from "@opensprint/shared";

// Mock TaskStoreService so tests don't require bd CLI or shell
import { vi } from "vitest";
vi.mock("../services/task-store.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/task-store.service.js")>();
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs();
  const sharedDb = new SQL.Database();
  sharedDb.run(actual.SCHEMA_SQL);

  class MockTaskStoreService extends actual.TaskStoreService {
    async init(): Promise<void> {
      (this as unknown as { db: unknown }).db = sharedDb;
      (this as unknown as { injectedDb: unknown }).injectedDb = sharedDb;
    }
    protected ensureDb() {
      if (!(this as unknown as { db: unknown }).db) {
        (this as unknown as { db: unknown }).db = sharedDb;
        (this as unknown as { injectedDb: unknown }).injectedDb = sharedDb;
      }
      return super.ensureDb();
    }
  }

  const singletonInstance = new MockTaskStoreService();
  await singletonInstance.init();

  return {
    ...actual,
    TaskStoreService: MockTaskStoreService,
    taskStore: singletonInstance,
    _resetSharedDb: () => {
      sharedDb.run("DELETE FROM task_dependencies");
      sharedDb.run("DELETE FROM tasks");
    },
  };
});

const execAsync = promisify(exec);

describe("Deliver API (phase routes for deployment records)", () => {
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
      JSON.stringify({ name: "test", scripts: { test: "echo ok" } })
    );
    await execAsync("git init && git add -A && git commit -m init", { cwd: repoPath });
    const project = await projectService.createProject({
      name: "Deploy Test Project",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
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
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore ENOTEMPTY and similar on some systems when removing .git
    }
  });

  describe("GET /projects/:projectId/deliver/status", () => {
    it("should return deliver status for existing project", async () => {
      const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/deliver/status`);

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data).toMatchObject({
        activeDeployId: null,
      });
      expect(res.body.data.currentDeploy).toBeNull();
    });

    it("should return 404 for non-existent project", async () => {
      const res = await request(app).get(`${API_PREFIX}/projects/nonexistent-id/deliver/status`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
    });
  });

  describe("GET /projects/:projectId/deliver/history", () => {
    it("should return empty history for new project", async () => {
      const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/deliver/history`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it("should return 404 for non-existent project", async () => {
      const res = await request(app).get(`${API_PREFIX}/projects/nonexistent-id/deliver/history`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
    });
  });

  describe("POST /projects/:projectId/deliver", () => {
    it("should accept deploy and return deployId", async () => {
      const res = await request(app).post(`${API_PREFIX}/projects/${projectId}/deliver`);

      expect(res.status).toBe(202);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.deployId).toBeDefined();
      expect(typeof res.body.data.deployId).toBe("string");
    });

    it("should return 404 for non-existent project", async () => {
      const res = await request(app).post(`${API_PREFIX}/projects/nonexistent-id/deliver`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
    });
  });

  describe("PUT /projects/:projectId/deliver/settings", () => {
    it("should update deployment settings", async () => {
      const res = await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/deliver/settings`)
        .send({ mode: "custom", customCommand: "npm run deploy" });

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.deployment).toMatchObject({
        mode: "custom",
        customCommand: "npm run deploy",
      });
    });

    it("should accept and persist autoDeployOnEpicCompletion, autoDeployOnEvalResolution, and autoResolveFeedbackOnTaskCompletion (PRD §7.5.3, §10.2)", async () => {
      const res = await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/deliver/settings`)
        .send({
          mode: "custom",
          autoDeployOnEpicCompletion: true,
          autoDeployOnEvalResolution: true,
          autoResolveFeedbackOnTaskCompletion: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.data.deployment.autoDeployOnEpicCompletion).toBe(true);
      expect(res.body.data.deployment.autoDeployOnEvalResolution).toBe(true);
      expect(res.body.data.deployment.autoResolveFeedbackOnTaskCompletion).toBe(true);

      const getRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
      expect(getRes.body.data.deployment.autoDeployOnEpicCompletion).toBe(true);
      expect(getRes.body.data.deployment.autoDeployOnEvalResolution).toBe(true);
      expect(getRes.body.data.deployment.autoResolveFeedbackOnTaskCompletion).toBe(true);
    });

    it("should accept and persist targets and envVars (PRD §7.5.2/7.5.4)", async () => {
      const res = await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/deliver/settings`)
        .send({
          mode: "custom",
          targets: [
            { name: "staging", command: "echo deploy-staging", isDefault: true },
            { name: "production", webhookUrl: "https://api.example.com/deploy" },
          ],
          envVars: { NODE_ENV: "production", API_URL: "https://api.example.com" },
        });

      expect(res.status).toBe(200);
      expect(res.body.data.deployment.targets).toHaveLength(2);
      expect(res.body.data.deployment.targets[0]).toMatchObject({
        name: "staging",
        command: "echo deploy-staging",
        isDefault: true,
      });
      expect(res.body.data.deployment.targets[1]).toMatchObject({
        name: "production",
        webhookUrl: "https://api.example.com/deploy",
      });
      expect(res.body.data.deployment.envVars).toEqual({
        NODE_ENV: "production",
        API_URL: "https://api.example.com",
      });

      const getRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
      expect(getRes.body.data.deployment.targets).toHaveLength(2);
      expect(getRes.body.data.deployment.envVars).toEqual({
        NODE_ENV: "production",
        API_URL: "https://api.example.com",
      });
    });
  });

  describe("POST /projects/:projectId/deliver - record fields", () => {
    it("should create deploy record with commitHash, target, mode from settings", async () => {
      const res = await request(app).post(`${API_PREFIX}/projects/${projectId}/deliver`);
      expect(res.status).toBe(202);
      // Poll for history (deploy may run async when path check differs on macOS)
      let historyRes = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/deliver/history?limit=1`
      );
      for (let i = 0; i < 20 && (historyRes.body.data?.length ?? 0) === 0; i++) {
        await new Promise((r) => setTimeout(r, 500));
        historyRes = await request(app).get(
          `${API_PREFIX}/projects/${projectId}/deliver/history?limit=1`
        );
      }
      expect(historyRes.status).toBe(200);
      expect(historyRes.body.data.length).toBeGreaterThan(0);

      const record = historyRes.body.data[0];
      expect(record.target).toBe("staging");
      expect(record.mode).toBe("custom");
      // commitHash may be a SHA or null if git fails
      expect(typeof record.commitHash === "string" || record.commitHash === null).toBe(true);
    });

    it("should deploy to specified target when body.target provided (PRD §7.5.4)", async () => {
      await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/deliver/settings`)
        .send({
          mode: "custom",
          targets: [
            { name: "staging", command: "echo deploy-staging", isDefault: true },
            { name: "production", command: "echo deploy-production" },
          ],
        });

      const res = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/deliver`)
        .send({ target: "production" });

      expect(res.status).toBe(202);
      expect(res.body.data.deployId).toBeDefined();

      // Repo in temp dir: deploy is awaited before 202, so record exists immediately
      const historyRes = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/deliver/history?limit=1`
      );
      expect(historyRes.body.data).toBeDefined();
      expect(historyRes.body.data.length).toBeGreaterThan(0);
      const record = historyRes.body.data[0];
      expect(record).toBeDefined();
      expect(record.target).toBe("production");
    });
  });

  describe("POST /projects/:projectId/deliver/expo-deploy", () => {
    it("should return 400 when deployment mode is not expo", async () => {
      const res = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/deliver/expo-deploy`)
        .send({ variant: "beta" });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("EXPO_REQUIRED");
    });

    it("should return 400 when variant is invalid", async () => {
      await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/deliver/settings`)
        .send({ mode: "expo" });

      const res = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/deliver/expo-deploy`)
        .send({ variant: "invalid" });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("INVALID_VARIANT");
    });

    it("should accept beta variant and return deployId when mode is expo", async () => {
      await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/deliver/settings`)
        .send({ mode: "expo" });

      const res = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/deliver/expo-deploy`)
        .send({ variant: "beta" });

      expect(res.status).toBe(202);
      expect(res.body.data?.deployId).toBeDefined();
      expect(typeof res.body.data.deployId).toBe("string");
    });

    it("should accept prod variant and return deployId when mode is expo", async () => {
      await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/deliver/settings`)
        .send({ mode: "expo" });

      const res = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/deliver/expo-deploy`)
        .send({ variant: "prod" });

      expect(res.status).toBe(202);
      expect(res.body.data?.deployId).toBeDefined();
    });

    it("should create deploy record with target staging for beta", async () => {
      await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/deliver/settings`)
        .send({ mode: "expo" });

      await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/deliver/expo-deploy`)
        .send({ variant: "beta" });

      let historyRes = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/deliver/history?limit=1`
      );
      for (let i = 0; i < 20 && (historyRes.body.data?.length ?? 0) === 0; i++) {
        await new Promise((r) => setTimeout(r, 500));
        historyRes = await request(app).get(
          `${API_PREFIX}/projects/${projectId}/deliver/history?limit=1`
        );
      }
      expect(historyRes.body.data?.length).toBeGreaterThan(0);
      expect(historyRes.body.data[0].target).toBe("staging");
      expect(historyRes.body.data[0].mode).toBe("expo");
    });

    it("should create deploy record with target production for prod", async () => {
      await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/deliver/settings`)
        .send({ mode: "expo" });

      await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/deliver/expo-deploy`)
        .send({ variant: "prod" });

      let historyRes = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/deliver/history?limit=1`
      );
      for (let i = 0; i < 20 && (historyRes.body.data?.length ?? 0) === 0; i++) {
        await new Promise((r) => setTimeout(r, 500));
        historyRes = await request(app).get(
          `${API_PREFIX}/projects/${projectId}/deliver/history?limit=1`
        );
      }
      expect(historyRes.body.data?.length).toBeGreaterThan(0);
      expect(historyRes.body.data[0].target).toBe("production");
    });
  });

  describe("POST /projects/:projectId/deliver/:deployId/rollback", () => {
    it("should mark original deploy as rolled_back on success", { timeout: 30000 }, async () => {
      const res1 = await request(app).post(`${API_PREFIX}/projects/${projectId}/deliver`);
      expect(res1.status).toBe(202);

      const res2 = await request(app).post(`${API_PREFIX}/projects/${projectId}/deliver`);
      expect(res2.status).toBe(202);

      // Poll for history until we have at least 2 records (handles timing under load)
      let historyRes = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/deliver/history?limit=5`
      );
      for (let i = 0; i < 20 && (historyRes.body.data?.length ?? 0) < 2; i++) {
        await new Promise((r) => setTimeout(r, 500));
        historyRes = await request(app).get(
          `${API_PREFIX}/projects/${projectId}/deliver/history?limit=5`
        );
      }
      expect(historyRes.body.data).toBeDefined();
      expect(historyRes.body.data.length).toBeGreaterThanOrEqual(
        2,
        "Need at least 2 deploy records for rollback test"
      );
      const deployToRestore = historyRes.body.data[1];
      const currentDeploy = historyRes.body.data[0];

      const rollbackRes = await request(app).post(
        `${API_PREFIX}/projects/${projectId}/deliver/${deployToRestore.id}/rollback`
      );
      expect(rollbackRes.status).toBe(202);
      const rollbackDeployId = rollbackRes.body.data.deployId;

      await new Promise((r) => setTimeout(r, 500));

      historyRes = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/deliver/history?limit=5`
      );
      const records = historyRes.body.data;

      const rollbackRecord = records.find((r: { id: string }) => r.id === rollbackDeployId);
      expect(rollbackRecord).toBeDefined();
      expect(rollbackRecord.status).toBe("success");

      const rolledBackRecord = records.find(
        (r: { id: string; rolledBackBy?: string }) => r.id === currentDeploy.id
      );
      expect(rolledBackRecord).toBeDefined();
      expect(rolledBackRecord.status).toBe("rolled_back");
      expect(rolledBackRecord.rolledBackBy).toBe(rollbackDeployId);
    });
  });
});
