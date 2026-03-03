import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { orchestratorService } from "../services/orchestrator.service.js";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { createApp } from "../app.js";
import { ProjectService } from "../services/project.service.js";
import { API_PREFIX, DEFAULT_HIL_CONFIG } from "@opensprint/shared";

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
      _resetSharedDb: () => {},
    };
  }
  const store = new actual.TaskStoreService(dbResult.client);
  await store.init();
  const resetSharedDb = async () => {
    await dbResult.client.execute("DELETE FROM task_dependencies");
    await dbResult.client.execute("DELETE FROM tasks");
  };
  return {
    ...actual,
    TaskStoreService: class extends actual.TaskStoreService {
      constructor() {
        super(dbResult.client);
      }
    },
    taskStore: store,
    _resetSharedDb: resetSharedDb,
    _postgresAvailable: true,
  };
});

const execAsync = promisify(exec);

const deployRouteTaskStoreMod = await import("../services/task-store.service.js");
const deployRoutePostgresOk =
  (deployRouteTaskStoreMod as { _postgresAvailable?: boolean })._postgresAvailable ?? false;

describe.skipIf(!deployRoutePostgresOk)("Deliver API (phase routes for deployment records)", () => {
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
      JSON.stringify({
        name: "test",
        scripts: { test: "echo ok" },
        dependencies: { expo: "^52.0.0" },
      })
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

    it("should trigger orchestrator refreshMaxSlotsAndNudge so changes take effect immediately", async () => {
      const refreshSpy = vi
        .spyOn(orchestratorService, "refreshMaxSlotsAndNudge")
        .mockResolvedValue(undefined);

      await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/deliver/settings`)
        .send({ mode: "custom", customCommand: "npm run deploy" });

      expect(refreshSpy).toHaveBeenCalledWith(projectId);
      refreshSpy.mockRestore();
    });

    it("should accept and persist autoDeployTrigger per target and autoResolveFeedbackOnTaskCompletion (PRD §7.5.3, §10.2)", async () => {
      const res = await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/deliver/settings`)
        .send({
          mode: "custom",
          targets: [
            { name: "staging", autoDeployTrigger: "each_task", isDefault: true },
            { name: "production", autoDeployTrigger: "eval_resolution" },
          ],
          autoResolveFeedbackOnTaskCompletion: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.data.deployment.targets).toHaveLength(2);
      expect(res.body.data.deployment.targets[0]).toMatchObject({
        name: "staging",
        autoDeployTrigger: "each_task",
        isDefault: true,
      });
      expect(res.body.data.deployment.targets[1]).toMatchObject({
        name: "production",
        autoDeployTrigger: "eval_resolution",
      });
      expect(res.body.data.deployment.autoResolveFeedbackOnTaskCompletion).toBe(true);

      const getRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
      expect(getRes.body.data.deployment.targets).toHaveLength(2);
      expect(getRes.body.data.deployment.targets[0]).toMatchObject({
        name: "staging",
        autoDeployTrigger: "each_task",
      });
      expect(getRes.body.data.deployment.targets[1]).toMatchObject({
        name: "production",
        autoDeployTrigger: "eval_resolution",
      });
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

    it("should accept and persist nightlyDeployTime", async () => {
      const res = await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/deliver/settings`)
        .send({
          mode: "custom",
          targets: [{ name: "staging", autoDeployTrigger: "nightly", isDefault: true }],
          nightlyDeployTime: "03:30",
        });

      expect(res.status).toBe(200);
      expect(res.body.data.deployment.nightlyDeployTime).toBe("03:30");
      expect(res.body.data.deployment.targets[0]).toMatchObject({
        name: "staging",
        autoDeployTrigger: "nightly",
      });

      const getRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
      expect(getRes.body.data.deployment.nightlyDeployTime).toBe("03:30");
      expect(getRes.body.data.deployment.targets[0].autoDeployTrigger).toBe("nightly");
    });

    it("should migrate legacy autoDeployOnEpicCompletion to per-target autoDeployTrigger", async () => {
      const res = await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/deliver/settings`)
        .send({
          mode: "custom",
          targets: [{ name: "staging", isDefault: true }],
          autoDeployOnEpicCompletion: true,
        });

      expect(res.status).toBe(200);
      // Response should have migrated format: per-target autoDeployTrigger, no legacy flag
      expect(res.body.data.deployment.autoDeployOnEpicCompletion).toBeUndefined();
      expect(res.body.data.deployment.targets).toBeDefined();
      const stagingTarget = res.body.data.deployment.targets?.find(
        (t: { name: string }) => t.name === "staging"
      );
      expect(stagingTarget?.autoDeployTrigger).toBe("each_epic");

      const getRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
      expect(getRes.body.data.deployment.autoDeployOnEpicCompletion).toBeUndefined();
      expect(
        getRes.body.data.deployment.targets?.find((t: { name: string }) => t.name === "staging")
          ?.autoDeployTrigger
      ).toBe("each_epic");
    });

    it("should migrate legacy autoDeployOnEvalResolution to per-target autoDeployTrigger", async () => {
      const res = await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/deliver/settings`)
        .send({
          mode: "custom",
          targets: [{ name: "production", isDefault: true }],
          autoDeployOnEvalResolution: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.data.deployment.autoDeployOnEvalResolution).toBeUndefined();
      const prodTarget = res.body.data.deployment.targets?.find(
        (t: { name: string }) => t.name === "production"
      );
      expect(prodTarget?.autoDeployTrigger).toBe("eval_resolution");

      const getRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
      expect(getRes.body.data.deployment.autoDeployOnEvalResolution).toBeUndefined();
      expect(
        getRes.body.data.deployment.targets?.find((t: { name: string }) => t.name === "production")
          ?.autoDeployTrigger
      ).toBe("eval_resolution");
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
