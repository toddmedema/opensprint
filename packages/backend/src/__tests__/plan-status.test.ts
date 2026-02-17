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
      currentTask: null,
      currentPhase: null,
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
      description: "For plan-status and planning run tests",
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

  it("GET /projects/:id/plan-status returns action plan when no planning run exists", async () => {
    const project = await projectService.getProject(projectId);
    const prdPath = path.join(project.repoPath, OPENSPRINT_PATHS.prd);
    await fs.mkdir(path.dirname(prdPath), { recursive: true });
    await fs.writeFile(
      prdPath,
      JSON.stringify({
        version: 1,
        sections: {
          executive_summary: { content: "A todo app", version: 1, updated_at: new Date().toISOString() },
        },
        changeLog: [],
      }),
      "utf-8",
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

  it("POST decompose creates planning run; plan-status returns none when PRD unchanged", {
    timeout: 15000,
  }, async () => {
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
          executive_summary: { content: "A todo app", version: 1, updated_at: new Date().toISOString() },
        },
        changeLog: [],
      }),
      "utf-8",
    );

    const app = createApp();

    const decomposeRes = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans/decompose`);
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
  });

  it("plan-status returns replan when PRD changed since last run", { timeout: 15000 }, async () => {
    mockDecomposeInvoke.mockResolvedValueOnce({
      content: JSON.stringify({
        plans: [
          {
            title: "Task CRUD",
            content: "# Task CRUD\n\n## Overview\n\nCreate tasks.",
            complexity: "medium",
            mockups: [{ title: "List", content: "Tasks" }],
            tasks: [{ title: "Create model", description: "Task schema", priority: 0, dependsOn: [] }],
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
          executive_summary: { content: "A todo app", version: 1, updated_at: new Date().toISOString() },
        },
        changeLog: [],
      }),
      "utf-8",
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
      "utf-8",
    );

    const statusRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/plan-status`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.data).toEqual({
      hasPlanningRun: true,
      prdChangedSinceLastRun: true,
      action: "replan",
    });
  });
});
