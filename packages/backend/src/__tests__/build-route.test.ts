import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createApp } from "../app.js";
import { ProjectService } from "../services/project.service.js";
import { setSelfImprovementRunInProgressForTest } from "../services/self-improvement-runner.service.js";
import { API_PREFIX, DEFAULT_HIL_CONFIG } from "@opensprint/shared";
import { cleanupTestProject } from "./test-project-cleanup.js";

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (a: unknown, b: unknown) => [a, b],
}));
vi.mock("../db/drizzle-schema-pg.js", () => ({ plansTable: {} }));

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
    };
  }
  const store = new actual.TaskStoreService(dbResult.client);
  await store.init();
  return {
    ...actual,
    TaskStoreService: class extends actual.TaskStoreService {
      constructor() {
        super(dbResult.client);
      }
    },
    taskStore: store,
    _postgresAvailable: true,
  };
});

const buildRouteTaskStoreMod = await import("../services/task-store.service.js");
const buildRoutePostgresOk =
  (buildRouteTaskStoreMod as { _postgresAvailable?: boolean })._postgresAvailable ?? false;

describe.skipIf(!buildRoutePostgresOk)("Execute API", () => {
  let app: ReturnType<typeof createApp>;
  let projectService: ProjectService;
  let tempDir: string;
  let projectId: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    app = createApp();
    projectService = new ProjectService();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-execute-route-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    const repoPath = path.join(tempDir, "my-project");
    const project = await projectService.createProject({
      name: "Build Test Project",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });
    projectId = project.id;
  });

  afterEach(async () => {
    await cleanupTestProject({ projectService, projectId });
    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("GET /projects/:projectId/execute/status", () => {
    it("should return orchestrator status for existing project", async () => {
      const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/execute/status`);

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data).toMatchObject({
        activeTasks: [],
        queueDepth: 0,
        totalDone: 0,
        totalFailed: 0,
      });
      // Always-on orchestrator: no `running` field (PRDv2 §5.7)
      expect(res.body.data.running).toBeUndefined();
      // Execute status includes self-improvement run state
      expect(res.body.data).toHaveProperty("selfImprovementRunInProgress");
      expect(typeof res.body.data.selfImprovementRunInProgress).toBe("boolean");
    });

    it("should return 404 for non-existent project", async () => {
      const res = await request(app).get(`${API_PREFIX}/projects/nonexistent-id/execute/status`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
    });

    it("returns selfImprovementRunInProgress true only while a self-improvement run is active", async () => {
      const resInactive = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/execute/status`
      );
      expect(resInactive.status).toBe(200);
      expect(resInactive.body.data.selfImprovementRunInProgress).toBe(false);

      setSelfImprovementRunInProgressForTest(projectId, true);
      try {
        const resActive = await request(app).get(
          `${API_PREFIX}/projects/${projectId}/execute/status`
        );
        expect(resActive.status).toBe(200);
        expect(resActive.body.data.selfImprovementRunInProgress).toBe(true);
      } finally {
        setSelfImprovementRunInProgressForTest(projectId, false);
      }

      const resAfter = await request(app).get(`${API_PREFIX}/projects/${projectId}/execute/status`);
      expect(resAfter.status).toBe(200);
      expect(resAfter.body.data.selfImprovementRunInProgress).toBe(false);
    });
  });

  describe("GET /projects/:projectId/execute/tasks/:taskId/output", () => {
    it("returns empty output when no task is running", async () => {
      const res = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/execute/tasks/task-123/output`
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ output: "" });
    });

    it("returns 404 for non-existent project", async () => {
      const res = await request(app).get(
        `${API_PREFIX}/projects/nonexistent-id/execute/tasks/task-123/output`
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
    });
  });

  describe("POST /projects/:projectId/execute/nudge", () => {
    it("should accept nudge and return status", async () => {
      const res = await request(app).post(`${API_PREFIX}/projects/${projectId}/execute/nudge`);

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.activeTasks).toBeDefined();
      expect(res.body.data.queueDepth).toBeGreaterThanOrEqual(0);
    });

    it("should return 404 for non-existent project", async () => {
      const res = await request(app).post(`${API_PREFIX}/projects/nonexistent-id/execute/nudge`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
    });
  });
});
