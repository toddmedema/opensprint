import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { orchestratorService } from "../services/orchestrator.service.js";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { createApp } from "../app.js";
import { createAppServices } from "../composition.js";
import { ProjectService } from "../services/project.service.js";
import { API_PREFIX, DEFAULT_HIL_CONFIG } from "@opensprint/shared";

// Avoid loading drizzle-orm/pg-core when task-store mock uses importOriginal (vitest resolution can fail)
vi.mock("drizzle-orm", () => ({ and: (...args: unknown[]) => args, eq: (a: unknown, b: unknown) => [a, b] }));
vi.mock("../db/drizzle-schema-pg.js", () => ({ plansTable: {} }));

vi.mock("../services/task-store.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/task-store.service.js")>();
  const { createTestPostgresClient, truncateTestDbTables } = await import("./test-db-helper.js");
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
    await truncateTestDbTables(dbResult.client);
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
    _testPool: dbResult.pool,
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

  afterAll(async () => {
    const mod = (await import("../services/task-store.service.js")) as { _testPool?: { end: () => Promise<void> } };
    if (mod._testPool) await mod._testPool.end();
  });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-deploy-route-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    const services = createAppServices();
    app = createApp(services);
    projectService = services.projectService;

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
        customCommand: "true",
        rollbackCommand: "true",
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

    it("should accept and persist targets with per-target envVars (PRD §7.5.2/7.5.4)", async () => {
      const res = await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/deliver/settings`)
        .send({
          mode: "custom",
          targets: [
            {
              name: "staging",
              command: "echo deploy-staging",
              isDefault: true,
              envVars: { NODE_ENV: "staging", API_URL: "https://staging.example.com" },
            },
            {
              name: "production",
              webhookUrl: "https://api.example.com/deploy",
              envVars: { NODE_ENV: "production", API_URL: "https://api.example.com" },
            },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.data.deployment.targets).toHaveLength(2);
      expect(res.body.data.deployment.targets[0]).toMatchObject({
        name: "staging",
        command: "echo deploy-staging",
        isDefault: true,
        envVars: { NODE_ENV: "staging", API_URL: "https://staging.example.com" },
      });
      expect(res.body.data.deployment.targets[1]).toMatchObject({
        name: "production",
        webhookUrl: "https://api.example.com/deploy",
        envVars: { NODE_ENV: "production", API_URL: "https://api.example.com" },
      });

      const getRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
      expect(getRes.body.data.deployment.targets).toHaveLength(2);
      expect(getRes.body.data.deployment.targets[0].envVars).toEqual({
        NODE_ENV: "staging",
        API_URL: "https://staging.example.com",
      });
      expect(getRes.body.data.deployment.targets[1].envVars).toEqual({
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

    it("should accept and persist easProjectId when mode is expo", async () => {
      const res = await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/deliver/settings`)
        .send({
          mode: "expo",
          easProjectId: "abc123-eas-project-id",
        });

      expect(res.status).toBe(200);
      expect(res.body.data.deployment.mode).toBe("expo");
      expect(res.body.data.deployment.easProjectId).toBe("abc123-eas-project-id");

      const getRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
      expect(getRes.body.data.deployment.easProjectId).toBe("abc123-eas-project-id");
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
    const originalExpoToken = process.env.EXPO_TOKEN;

    beforeEach(() => {
      process.env.EXPO_TOKEN = "test-expo-token-for-deploy-route-tests";
    });

    afterEach(() => {
      process.env.EXPO_TOKEN = originalExpoToken;
    });

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

    it("should return 400 with explicit prompt when Expo auth is missing", async () => {
      const saved = process.env.EXPO_TOKEN;
      delete process.env.EXPO_TOKEN;

      await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/deliver/settings`)
        .send({ mode: "expo" });

      const res = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/deliver/expo-deploy`)
        .send({ variant: "beta" });

      process.env.EXPO_TOKEN = saved;

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("EXPO_TOKEN_REQUIRED");
      expect(res.body.error?.message).toContain("authentication");
      expect(res.body.error?.prompt).toBeDefined();
      expect(res.body.error?.prompt).toContain("expo.dev/settings/access-tokens");
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

  describe("GET /projects/:projectId/deliver/expo-readiness", () => {
    it("should return 200 with correct shape when all checks pass", async () => {
      const saved = process.env.EXPO_TOKEN;
      process.env.EXPO_TOKEN = "test-expo-token-readiness";

      await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/deliver/settings`)
        .send({ mode: "expo" });

      await fs.writeFile(
        path.join(tempDir, "my-project", "app.json"),
        JSON.stringify({
          expo: {
            name: "TestApp",
            slug: "test-app",
            extra: { eas: { projectId: "test-eas-project-id" } },
          },
        })
      );

      const res = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/deliver/expo-readiness`
      );

      process.env.EXPO_TOKEN = saved;

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        expoInstalled: true,
        expoConfigured: true,
        authOk: true,
        easProjectLinked: true,
        missing: [],
      });
      expect(Array.isArray(res.body.data.missing)).toBe(true);
      expect(res.body.data.prompt).toBeUndefined();
    });

    it("should return 200 with missing and prompt when authOk is false", async () => {
      const saved = process.env.EXPO_TOKEN;
      delete process.env.EXPO_TOKEN;

      await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/deliver/settings`)
        .send({ mode: "expo" });

      await fs.writeFile(
        path.join(tempDir, "my-project", "app.json"),
        JSON.stringify({
          expo: {
            name: "TestApp",
            slug: "test-app",
            extra: { eas: { projectId: "test-eas-project-id" } },
          },
        })
      );

      const res = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/deliver/expo-readiness`
      );

      process.env.EXPO_TOKEN = saved;

      expect(res.status).toBe(200);
      expect(res.body.data.authOk).toBe(false);
      expect(res.body.data.missing).toContain("auth");
      expect(res.body.data.prompt).toBeDefined();
      expect(typeof res.body.data.prompt).toBe("string");
      expect(res.body.data.prompt).toContain("expo.dev");
    });

    it("should return 400 when deployment mode is not expo", async () => {
      const res = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/deliver/expo-readiness`
      );

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("EXPO_REQUIRED");
      expect(res.body.error?.message).toContain("expo");
    });

    it("should return 404 when project not found", async () => {
      const res = await request(app).get(
        `${API_PREFIX}/projects/nonexistent-id/deliver/expo-readiness`
      );

      expect(res.status).toBe(404);
      expect(res.body.error?.code).toBe("PROJECT_NOT_FOUND");
    });

    it("should populate missing array from false checks", async () => {
      const saved = process.env.EXPO_TOKEN;
      process.env.EXPO_TOKEN = "test-token-for-missing-array";

      await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/deliver/settings`)
        .send({ mode: "expo" });
      // No app.json: expoConfigured and easProjectLinked false; expo in package.json so expoInstalled true
      const res = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/deliver/expo-readiness`
      );

      process.env.EXPO_TOKEN = saved;

      expect(res.status).toBe(200);
      expect(res.body.data.expoInstalled).toBe(true);
      expect(res.body.data.expoConfigured).toBe(false);
      expect(res.body.data.easProjectLinked).toBe(false);
      expect(res.body.data.authOk).toBe(true);
      expect(res.body.data.missing).toContain("expo_configured");
      expect(res.body.data.missing).toContain("eas_project_linked");
      expect(res.body.data.missing).not.toContain("auth");
      expect(res.body.data.missing).not.toContain("expo_installed");
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

      // Poll until rollback record reaches a terminal state (server may or may not await in-process)
      let records: { id: string; status?: string; rolledBackBy?: string }[] = [];
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        historyRes = await request(app).get(
          `${API_PREFIX}/projects/${projectId}/deliver/history?limit=5`
        );
        expect(historyRes.status).toBe(200);
        records = historyRes.body?.data ?? [];
        const rollbackRecord = records.find((r) => r.id === rollbackDeployId);
        if (rollbackRecord?.status === "success" || rollbackRecord?.status === "failed") break;
      }

      const rollbackRecord = records.find((r) => r.id === rollbackDeployId);
      expect(rollbackRecord).toBeDefined();
      expect(rollbackRecord!.status).toBe("success");

      const rolledBackRecord = records.find((r) => r.id === currentDeploy.id);
      expect(rolledBackRecord).toBeDefined();
      expect(rolledBackRecord!.status).toBe("rolled_back");
      expect(rolledBackRecord!.rolledBackBy).toBe(rollbackDeployId);
    });
  });
});
