import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createApp } from "../app.js";
import { ProjectService } from "../services/project.service.js";
import { API_PREFIX, OPENSPRINT_PATHS } from "@opensprint/shared";
import { DEFAULT_HIL_CONFIG } from "@opensprint/shared";

const mockDecomposeInvoke = vi.fn();

// Mock TaskStoreService with in-memory sql.js database
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

vi.mock("../services/agent-client.js", () => ({
  AgentClient: vi.fn().mockImplementation(() => ({
    invoke: (opts: unknown) => mockDecomposeInvoke(opts),
  })),
}));

vi.mock("../services/orchestrator.service.js", () => ({
  orchestratorService: {
    nudge: vi.fn(),
    ensureRunning: vi.fn(),
    stopProject: vi.fn(),
    getStatus: vi.fn().mockResolvedValue({
      activeTasks: [],
      queueDepth: 0,
      totalDone: 0,
      totalFailed: 0,
    }),
    getActiveAgents: vi.fn().mockResolvedValue([]),
  },
}));

describe("Plan status endpoint and planning run creation", () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let projectId: string;
  let projectService: ProjectService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-plan-status-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    projectService = new ProjectService();
    const repoPath = path.join(tempDir, "test-project");
    const project = await projectService.createProject({
      name: "Plan Status Test",
      repoPath,
      simpleComplexityAgent: { type: "cursor", model: "claude-sonnet-4", cliCommand: null },
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

  it("GET /projects/:id/plan-status returns action plan when no planning run exists", async () => {
    const project = await projectService.getProject(projectId);
    const prdPath = path.join(project.repoPath, OPENSPRINT_PATHS.prd);
    await fs.mkdir(path.dirname(prdPath), { recursive: true });
    await fs.writeFile(
      prdPath,
      JSON.stringify({
        version: 1,
        sections: {
          executive_summary: {
            content: "A todo app",
            version: 1,
            updated_at: new Date().toISOString(),
          },
        },
        changeLog: [],
      }),
      "utf-8"
    );

    const app = createApp();
    const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/plan-status`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      hasPlanningRun: false,
      prdChangedSinceLastRun: false,
      action: "plan",
    });
  });

  it(
    "POST decompose creates planning run; plan-status returns none when PRD unchanged",
    {
      timeout: 15000,
    },
    async () => {
      mockDecomposeInvoke.mockResolvedValueOnce({
        content: JSON.stringify({
          plans: [
            {
              title: "Task CRUD",
              content: "# Task CRUD\n\n## Overview\n\nCreate tasks.",
              complexity: "medium",
              mockups: [{ title: "List", content: "Tasks" }],
              tasks: [
                { title: "Create model", description: "Task schema", priority: 0, dependsOn: [] },
              ],
            },
          ],
        }),
      });

      const project = await projectService.getProject(projectId);
      const prdPath = path.join(project.repoPath, OPENSPRINT_PATHS.prd);
      await fs.mkdir(path.dirname(prdPath), { recursive: true });
      await fs.writeFile(
        prdPath,
        JSON.stringify({
          version: 1,
          sections: {
            executive_summary: {
              content: "A todo app",
              version: 1,
              updated_at: new Date().toISOString(),
            },
          },
          changeLog: [],
        }),
        "utf-8"
      );

      const app = createApp();

      const decomposeRes = await request(app).post(
        `${API_PREFIX}/projects/${projectId}/plans/decompose`
      );
      expect(decomposeRes.status).toBe(201);

      const runsDir = path.join(project.repoPath, OPENSPRINT_PATHS.planningRuns);
      const runFiles = await fs.readdir(runsDir);
      expect(runFiles.length).toBe(1);
      expect(runFiles[0]).toMatch(/\.json$/);

      const statusRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/plan-status`);
      expect(statusRes.status).toBe(200);
      expect(statusRes.body.data).toEqual({
        hasPlanningRun: true,
        prdChangedSinceLastRun: false,
        action: "none",
      });
    }
  );

  it("plan-status returns replan when PRD changed since last run", { timeout: 15000 }, async () => {
    mockDecomposeInvoke.mockResolvedValueOnce({
      content: JSON.stringify({
        plans: [
          {
            title: "Task CRUD",
            content: "# Task CRUD\n\n## Overview\n\nCreate tasks.",
            complexity: "medium",
            mockups: [{ title: "List", content: "Tasks" }],
            tasks: [
              { title: "Create model", description: "Task schema", priority: 0, dependsOn: [] },
            ],
          },
        ],
      }),
    });

    const project = await projectService.getProject(projectId);
    const prdPath = path.join(project.repoPath, OPENSPRINT_PATHS.prd);
    await fs.mkdir(path.dirname(prdPath), { recursive: true });
    await fs.writeFile(
      prdPath,
      JSON.stringify({
        version: 1,
        sections: {
          executive_summary: {
            content: "A todo app",
            version: 1,
            updated_at: new Date().toISOString(),
          },
        },
        changeLog: [],
      }),
      "utf-8"
    );

    const app = createApp();
    await request(app).post(`${API_PREFIX}/projects/${projectId}/plans/decompose`);

    await fs.writeFile(
      prdPath,
      JSON.stringify({
        version: 1,
        sections: {
          executive_summary: {
            content: "A todo app with new features",
            version: 2,
            updated_at: new Date().toISOString(),
          },
        },
        changeLog: [],
      }),
      "utf-8"
    );

    const statusRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/plan-status`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.data).toEqual({
      hasPlanningRun: true,
      prdChangedSinceLastRun: true,
      action: "replan",
    });
  });

  it(
    "planning run stores prd_snapshot and plans_created for replan diff",
    {
      timeout: 15000,
    },
    async () => {
      mockDecomposeInvoke.mockResolvedValueOnce({
        content: JSON.stringify({
          plans: [
            {
              title: "Feature A",
              content: "# Feature A",
              complexity: "low",
              mockups: [],
              tasks: [{ title: "Task 1", description: "d1", priority: 0, dependsOn: [] }],
            },
          ],
        }),
      });

      const project = await projectService.getProject(projectId);
      const prdPath = path.join(project.repoPath, OPENSPRINT_PATHS.prd);
      await fs.mkdir(path.dirname(prdPath), { recursive: true });
      const prdContent = {
        version: 1,
        sections: {
          executive_summary: {
            content: "Original PRD",
            version: 1,
            updated_at: new Date().toISOString(),
          },
        },
        changeLog: [],
      };
      await fs.writeFile(prdPath, JSON.stringify(prdContent), "utf-8");

      const app = createApp();
      const decomposeRes = await request(app).post(
        `${API_PREFIX}/projects/${projectId}/plans/decompose`
      );
      expect(decomposeRes.status).toBe(201);

      const runsDir = path.join(project.repoPath, OPENSPRINT_PATHS.planningRuns);
      const runFiles = await fs.readdir(runsDir);
      expect(runFiles.length).toBe(1);

      const runData = JSON.parse(await fs.readFile(path.join(runsDir, runFiles[0]), "utf-8"));
      expect(runData).toMatchObject({
        id: expect.any(String),
        created_at: expect.any(String),
        prd_snapshot: expect.objectContaining({
          sections: expect.objectContaining({
            executive_summary: expect.objectContaining({ content: "Original PRD" }),
          }),
        }),
        plans_created: expect.any(Array),
      });
      expect(runData.plans_created.length).toBe(1);
    }
  );

  it(
    "replan diff: plan-status returns replan when only one section changes",
    {
      timeout: 15000,
    },
    async () => {
      mockDecomposeInvoke.mockResolvedValueOnce({
        content: JSON.stringify({
          plans: [
            {
              title: "Feature",
              content: "# Feature",
              complexity: "medium",
              mockups: [],
              tasks: [{ title: "T1", description: "d", priority: 0, dependsOn: [] }],
            },
          ],
        }),
      });

      const project = await projectService.getProject(projectId);
      const prdPath = path.join(project.repoPath, OPENSPRINT_PATHS.prd);
      await fs.mkdir(path.dirname(prdPath), { recursive: true });
      await fs.writeFile(
        prdPath,
        JSON.stringify({
          version: 1,
          sections: {
            executive_summary: {
              content: "Section A",
              version: 1,
              updated_at: new Date().toISOString(),
            },
            goals_and_metrics: {
              content: "Section B",
              version: 1,
              updated_at: new Date().toISOString(),
            },
          },
          changeLog: [],
        }),
        "utf-8"
      );

      const app = createApp();
      await request(app).post(`${API_PREFIX}/projects/${projectId}/plans/decompose`);

      await fs.writeFile(
        prdPath,
        JSON.stringify({
          version: 1,
          sections: {
            executive_summary: {
              content: "Section A modified",
              version: 2,
              updated_at: new Date().toISOString(),
            },
            goals_and_metrics: {
              content: "Section B",
              version: 1,
              updated_at: new Date().toISOString(),
            },
          },
          changeLog: [],
        }),
        "utf-8"
      );

      const statusRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/plan-status`);
      expect(statusRes.status).toBe(200);
      expect(statusRes.body.data.action).toBe("replan");
      expect(statusRes.body.data.prdChangedSinceLastRun).toBe(true);
    }
  );

  it("plan-status uses latest run when multiple runs exist", async () => {
    const project = await projectService.getProject(projectId);
    const prdPath = path.join(project.repoPath, OPENSPRINT_PATHS.prd);
    const runsDir = path.join(project.repoPath, OPENSPRINT_PATHS.planningRuns);
    await fs.mkdir(path.dirname(prdPath), { recursive: true });
    await fs.mkdir(runsDir, { recursive: true });

    const prdContent = {
      version: 1,
      sections: {
        executive_summary: { content: "v1", version: 1, updated_at: new Date().toISOString() },
      },
      changeLog: [],
    };
    await fs.writeFile(prdPath, JSON.stringify(prdContent), "utf-8");

    const olderRun = {
      id: "run-older",
      created_at: "2025-01-01T00:00:00Z",
      prd_snapshot: prdContent,
      plans_created: ["plan-1"],
    };
    const newerRun = {
      id: "run-newer",
      created_at: "2025-01-02T00:00:00Z",
      prd_snapshot: prdContent,
      plans_created: ["plan-2"],
    };
    await fs.writeFile(path.join(runsDir, "run-older.json"), JSON.stringify(olderRun), "utf-8");
    await fs.writeFile(path.join(runsDir, "run-newer.json"), JSON.stringify(newerRun), "utf-8");

    const app = createApp();
    const statusRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/plan-status`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.data.hasPlanningRun).toBe(true);
    expect(statusRes.body.data.action).toBe("none");
  });
});
