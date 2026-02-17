import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createApp } from "../app.js";
import { ProjectService } from "../services/project.service.js";
import { BeadsService } from "../services/beads.service.js";
import { API_PREFIX, OPENSPRINT_PATHS } from "@opensprint/shared";
import { DEFAULT_HIL_CONFIG } from "@opensprint/shared";

const mockSuggestInvoke = vi.fn();

vi.mock("../services/agent-client.js", () => ({
  AgentClient: vi.fn().mockImplementation(() => ({
    invoke: (opts: unknown) => mockSuggestInvoke(opts),
  })),
}));

// Mock orchestrator so Ship it! doesn't trigger the real loop (which would claim Task A before archive)
vi.mock("../services/orchestrator.service.js", () => ({
  orchestratorService: {
    nudge: vi.fn(),
    ensureRunning: vi.fn(),
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

describe("Plan REST endpoints - task decomposition", () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let projectId: string;
  let projectService: ProjectService;
  let beads: BeadsService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-plan-route-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    projectService = new ProjectService();
    beads = new BeadsService();
    const repoPath = path.join(tempDir, "test-project");
    const project = await projectService.createProject({
      name: "Plan Test Project",
      description: "For plan route and task decomposition tests",
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

  it("POST /projects/:id/plans with tasks should create beads tasks via bd create", { timeout: 15000 }, async () => {
    const app = createApp();
    const planBody = {
      title: "User Authentication",
      content: "# User Authentication\n\n## Overview\n\nAuth feature.\n\n## Acceptance Criteria\n\n- Login works",
      complexity: "medium",
      tasks: [
        { title: "Implement login endpoint", description: "POST /auth/login", priority: 0, dependsOn: [] },
        {
          title: "Implement JWT validation",
          description: "Validate tokens",
          priority: 1,
          dependsOn: ["Implement login endpoint"],
        },
      ],
    };

    const res = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans`).send(planBody);

    expect(res.status).toBe(201);
    expect(res.body.data).toBeDefined();
    const plan = res.body.data;
    expect(plan.taskCount).toBe(2);
    expect(plan.metadata.beadEpicId).toBeDefined();
    expect(plan.metadata.gateTaskId).toBeDefined();

    // Verify beads has the child tasks (bd create was called for each)
    const project = await projectService.getProject(projectId);
    const allIssues = await beads.listAll(project.repoPath);
    const epicId = plan.metadata.beadEpicId;
    const childTasks = allIssues.filter((i) => i.id.startsWith(epicId + ".") && i.id !== plan.metadata.gateTaskId);
    expect(childTasks.length).toBe(2);
    expect(childTasks.map((t) => t.title)).toContain("Implement login endpoint");
    expect(childTasks.map((t) => t.title)).toContain("Implement JWT validation");

    // Verify bd dep add was called: each task blocks on the gate (plan.service adds this)
    // and JWT task blocks on login task (inter-task deps)
    const readyBeforeShip = await beads.ready(project.repoPath);
    const implementationTaskIds = childTasks.map((t) => t.id);
    // Before shipping, no implementation tasks should be ready (they block on gate)
    const readyIds = readyBeforeShip.map((r) => r.id);
    for (const tid of implementationTaskIds) {
      expect(readyIds).not.toContain(tid);
    }
  });

  it("POST /projects/:id/plans without tasks should create epic and gate only", async () => {
    const app = createApp();
    const planBody = {
      title: "Standalone Feature",
      content: "# Standalone\n\nNo tasks yet.",
      complexity: "low",
    };

    const res = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans`).send(planBody);

    expect(res.status).toBe(201);
    expect(res.body.data.taskCount).toBe(0);
    expect(res.body.data.metadata.beadEpicId).toBeDefined();
    expect(res.body.data.metadata.gateTaskId).toBeDefined();
  });

  it("POST /projects/:id/plans without complexity should agent-evaluate and use result", {
    timeout: 10000,
  }, async () => {
    mockSuggestInvoke.mockResolvedValueOnce({
      content: JSON.stringify({ complexity: "high" }),
    });

    const app = createApp();
    const planBody = {
      title: "Complex Feature",
      content: "# Complex Feature\n\n## Overview\n\nMulti-system integration with auth, API, and UI.",
    };
    // Intentionally omit complexity - backend should agent-evaluate

    const res = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans`).send(planBody);

    expect(res.status).toBe(201);
    expect(res.body.data.metadata.complexity).toBe("high");
    expect(mockSuggestInvoke).toHaveBeenCalledTimes(1);
  });

  it("POST /projects/:id/plans without complexity falls back to medium when agent returns invalid JSON", {
    timeout: 10000,
  }, async () => {
    mockSuggestInvoke.mockResolvedValueOnce({
      content: "I cannot produce valid JSON.",
    });

    const app = createApp();
    const planBody = {
      title: "Simple Feature",
      content: "# Simple\n\nOverview.",
    };

    const res = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans`).send(planBody);

    expect(res.status).toBe(201);
    expect(res.body.data.metadata.complexity).toBe("medium");
  });

  it("GET /projects/:id/plans/:planId returns lastModified (plan markdown file mtime)", async () => {
    const app = createApp();
    const planBody = {
      title: "Feature With LastModified",
      content: "# Feature\n\nContent.",
      complexity: "low",
    };

    const createRes = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans`).send(planBody);
    expect(createRes.status).toBe(201);
    const planId = createRes.body.data.metadata.planId;

    const getRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/plans/${planId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.lastModified).toBeDefined();
    expect(typeof getRes.body.data.lastModified).toBe("string");
    // Should be valid ISO date
    expect(new Date(getRes.body.data.lastModified).getTime()).not.toBeNaN();
  });

  it("GET /projects/:id/plans list returns lastModified for each plan", async () => {
    const app = createApp();
    const planBody = {
      title: "List Test Feature",
      content: "# List Test\n\nContent.",
      complexity: "low",
    };

    await request(app).post(`${API_PREFIX}/projects/${projectId}/plans`).send(planBody);

    const listRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/plans`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.plans).toBeDefined();
    expect(listRes.body.data.edges).toBeDefined();
    expect(listRes.body.data.plans.length).toBeGreaterThan(0);
    const plan = listRes.body.data.plans.find((p: { metadata: { planId: string } }) =>
      p.metadata.planId.includes("list-test-feature"),
    );
    expect(plan).toBeDefined();
    expect(plan.lastModified).toBeDefined();
    expect(typeof plan.lastModified).toBe("string");
  });

  it(
    "POST /projects/:id/plans/:planId/archive closes all ready/open tasks, leaves in_progress unchanged",
    {
      timeout: 15000,
    },
    async () => {
      const app = createApp();
      const planBody = {
        title: "Archive Test Feature",
        content: "# Archive Test\n\nContent.",
        complexity: "medium",
        tasks: [
          { title: "Task A", description: "First task", priority: 0, dependsOn: [] },
          { title: "Task B", description: "Second task", priority: 1, dependsOn: [] },
          { title: "Task C", description: "Third task", priority: 2, dependsOn: [] },
        ],
      };

      const createRes = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans`).send(planBody);
      expect(createRes.status).toBe(201);
      const createdPlanId = createRes.body.data.metadata.planId;
      const epicId = createRes.body.data.metadata.beadEpicId;
      const gateTaskId = createRes.body.data.metadata.gateTaskId;

      // Ship the plan so tasks become ready
      const shipRes = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans/${createdPlanId}/ship`);
      expect(shipRes.status).toBe(200);

      const project = await projectService.getProject(projectId);
      const allIssues = await beads.listAll(project.repoPath);
      const planTasks = allIssues.filter(
        (i: { id: string; issue_type?: string; type?: string }) =>
          i.id.startsWith(epicId + ".") && i.id !== gateTaskId && (i.issue_type ?? i.type) !== "epic",
      );

      const taskA = planTasks.find((t: { title: string }) => t.title === "Task A");
      const taskB = planTasks.find((t: { title: string }) => t.title === "Task B");
      const taskC = planTasks.find((t: { title: string }) => t.title === "Task C");
      expect(taskA).toBeDefined();
      expect(taskB).toBeDefined();
      expect(taskC).toBeDefined();

      // Claim Task B to put it in_progress
      await beads.update(project.repoPath, (taskB as { id: string }).id, {
        status: "in_progress",
        assignee: "test-user",
        claim: true,
      });
      await beads.sync(project.repoPath);

      // Archive the plan
      const archiveRes = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans/${createdPlanId}/archive`);
      expect(archiveRes.status).toBe(200);

      // Verify: Task A and Task C should be closed; Task B (in_progress) should remain in_progress
      const afterArchive = await beads.listAll(project.repoPath);
      const taskAAfter = afterArchive.find((i: { id: string }) => i.id === (taskA as { id: string }).id);
      const taskBAfter = afterArchive.find((i: { id: string }) => i.id === (taskB as { id: string }).id);
      const taskCAfter = afterArchive.find((i: { id: string }) => i.id === (taskC as { id: string }).id);

      expect((taskAAfter as { status: string }).status).toBe("closed");
      expect((taskBAfter as { status: string }).status).toBe("in_progress");
      expect((taskCAfter as { status: string }).status).toBe("closed");
    },
  );

  describe("POST /projects/:id/plans/:planId/reship", () => {
    it("reship succeeds when all tasks are done (closed)", { timeout: 15000 }, async () => {
      const app = createApp();
      const planBody = {
        title: "Reship All Done Feature",
        content: "# Reship All Done\n\nContent.",
        complexity: "medium",
        tasks: [
          { title: "Task X", description: "First", priority: 0, dependsOn: [] },
          { title: "Task Y", description: "Second", priority: 1, dependsOn: [] },
        ],
      };

      const createRes = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans`).send(planBody);
      expect(createRes.status).toBe(201);
      const planId = createRes.body.data.metadata.planId;
      const epicId = createRes.body.data.metadata.beadEpicId;
      const gateTaskId = createRes.body.data.metadata.gateTaskId;

      // Ship the plan
      const shipRes = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans/${planId}/ship`);
      expect(shipRes.status).toBe(200);

      const project = await projectService.getProject(projectId);
      const allIssues = await beads.listAll(project.repoPath);
      const planTasks = allIssues.filter(
        (i: { id: string; issue_type?: string; type?: string }) =>
          i.id.startsWith(epicId + ".") && i.id !== gateTaskId && (i.issue_type ?? i.type) !== "epic",
      );

      // Close all implementation tasks
      for (const task of planTasks) {
        await beads.close(project.repoPath, (task as { id: string }).id, "Done");
      }
      await beads.sync(project.repoPath);

      // Reship should succeed (all tasks done)
      const reshipRes = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans/${planId}/reship`);
      expect(reshipRes.status).toBe(200);
      expect(reshipRes.body.data).toBeDefined();
    });

    it("reship returns 400 TASKS_IN_PROGRESS when any task is in_progress", { timeout: 15000 }, async () => {
      const app = createApp();
      const planBody = {
        title: "Reship In Progress Feature",
        content: "# Reship In Progress\n\nContent.",
        complexity: "medium",
        tasks: [
          { title: "Task P", description: "First", priority: 0, dependsOn: [] },
          { title: "Task Q", description: "Second", priority: 1, dependsOn: [] },
        ],
      };

      const createRes = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans`).send(planBody);
      expect(createRes.status).toBe(201);
      const planId = createRes.body.data.metadata.planId;
      const epicId = createRes.body.data.metadata.beadEpicId;
      const gateTaskId = createRes.body.data.metadata.gateTaskId;

      const shipRes = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans/${planId}/ship`);
      expect(shipRes.status).toBe(200);

      const project = await projectService.getProject(projectId);
      const allIssues = await beads.listAll(project.repoPath);
      const taskP = allIssues.find(
        (i: { id: string; title: string; issue_type?: string; type?: string }) =>
          i.id.startsWith(epicId + ".") && i.id !== gateTaskId && (i.issue_type ?? i.type) !== "epic" && i.title === "Task P",
      );
      expect(taskP).toBeDefined();

      await beads.update(project.repoPath, (taskP as { id: string }).id, {
        status: "in_progress",
        assignee: "test-user",
        claim: true,
      });
      await beads.sync(project.repoPath);

      const reshipRes = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans/${planId}/reship`);
      expect(reshipRes.status).toBe(400);
      expect(reshipRes.body.error?.code).toBe("TASKS_IN_PROGRESS");
    });

    it("reship returns 400 TASKS_NOT_COMPLETE when some tasks open and some closed", { timeout: 15000 }, async () => {
      const app = createApp();
      const planBody = {
        title: "Reship Mixed Feature",
        content: "# Reship Mixed\n\nContent.",
        complexity: "medium",
        tasks: [
          { title: "Task M", description: "First", priority: 0, dependsOn: [] },
          { title: "Task N", description: "Second", priority: 1, dependsOn: [] },
        ],
      };

      const createRes = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans`).send(planBody);
      expect(createRes.status).toBe(201);
      const planId = createRes.body.data.metadata.planId;
      const epicId = createRes.body.data.metadata.beadEpicId;
      const gateTaskId = createRes.body.data.metadata.gateTaskId;

      const shipRes = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans/${planId}/ship`);
      expect(shipRes.status).toBe(200);

      const project = await projectService.getProject(projectId);
      const allIssues = await beads.listAll(project.repoPath);
      const planTasks = allIssues.filter(
        (i: { id: string; issue_type?: string; type?: string }) =>
          i.id.startsWith(epicId + ".") && i.id !== gateTaskId && (i.issue_type ?? i.type) !== "epic",
      );
      expect(planTasks.length).toBe(2);

      // Close only the first task
      await beads.close(project.repoPath, (planTasks[0] as { id: string }).id, "Done");
      await beads.sync(project.repoPath);

      const reshipRes = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans/${planId}/reship`);
      expect(reshipRes.status).toBe(400);
      expect(reshipRes.body.error?.code).toBe("TASKS_NOT_COMPLETE");
    });

    it("reship succeeds when none started (all open) — deletes tasks then ships", { timeout: 15000 }, async () => {
      const app = createApp();
      const planBody = {
        title: "Reship None Started Feature",
        content: "# Reship None Started\n\nContent.",
        complexity: "medium",
        tasks: [
          { title: "Task S", description: "First", priority: 0, dependsOn: [] },
          { title: "Task T", description: "Second", priority: 1, dependsOn: [] },
        ],
      };

      const createRes = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans`).send(planBody);
      expect(createRes.status).toBe(201);
      const planId = createRes.body.data.metadata.planId;
      const epicId = createRes.body.data.metadata.beadEpicId;
      const gateTaskId = createRes.body.data.metadata.gateTaskId;

      // Ship the plan (tasks become ready but stay open)
      const shipRes = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans/${planId}/ship`);
      expect(shipRes.status).toBe(200);

      const project = await projectService.getProject(projectId);
      const beforeReship = await beads.listAll(project.repoPath);
      const tasksBefore = beforeReship.filter(
        (i: { id: string; issue_type?: string; type?: string }) =>
          i.id.startsWith(epicId + ".") && i.id !== gateTaskId && (i.issue_type ?? i.type) !== "epic",
      );
      expect(tasksBefore.length).toBe(2);

      // Reship when none started (all open) — should delete tasks and re-ship
      const reshipRes = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans/${planId}/reship`);
      expect(reshipRes.status).toBe(200);

      // Implementation tasks should have been deleted (none-started case deletes them)
      const afterReship = await beads.listAll(project.repoPath);
      const tasksAfter = afterReship.filter(
        (i: { id: string; issue_type?: string; type?: string }) =>
          i.id.startsWith(epicId + ".") && i.id !== gateTaskId && (i.issue_type ?? i.type) !== "epic",
      );
      expect(tasksAfter.length).toBe(0);
    });
  });

  describe("POST /projects/:id/plans/suggest", () => {
    beforeEach(async () => {
      mockSuggestInvoke.mockClear();
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
        }),
        "utf-8",
      );
    });

    it("returns suggested plans from AI without creating plans or beads", { timeout: 10000 }, async () => {
      mockSuggestInvoke.mockResolvedValueOnce({
        content: JSON.stringify({
          plans: [
            {
              title: "Task CRUD",
              content: "# Task CRUD\n\n## Overview\n\nCreate and manage tasks.",
              complexity: "medium",
              mockups: [{ title: "List", content: "Tasks" }],
              tasks: [
                { title: "Create model", description: "Task schema", priority: 0, dependsOn: [] },
                { title: "Create API", description: "REST", priority: 1, dependsOn: ["Create model"] },
              ],
            },
          ],
        }),
      });

      const app = createApp();
      const res = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans/suggest`);

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.plans).toHaveLength(1);
      expect(res.body.data.plans[0].title).toBe("Task CRUD");
      expect(res.body.data.plans[0].tasks).toHaveLength(2);

      const project = await projectService.getProject(projectId);
      const plansDir = path.join(project.repoPath, ".opensprint", "plans");
      const files = await fs.readdir(plansDir).catch(() => []);
      expect(files).toHaveLength(0);

      const allIssues = await beads.listAll(project.repoPath);
      const epics = allIssues.filter((i: { issue_type?: string; type?: string }) => (i.issue_type ?? i.type) === "epic");
      expect(epics).toHaveLength(0);
    });

    it("returns 400 when agent returns invalid JSON", { timeout: 10000 }, async () => {
      mockSuggestInvoke.mockResolvedValueOnce({
        content: "I cannot produce JSON.",
      });

      const app = createApp();
      const res = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans/suggest`);

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("DECOMPOSE_PARSE_FAILED");
    });
  });

  it("POST /projects/:id/plans/:planId/archive returns 400 when plan has no epic", async () => {
    const app = createApp();
    const planBody = {
      title: "No Epic Plan",
      content: "# No Epic\n\nManually created without beads.",
      complexity: "low",
    };
    const createRes = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans`).send(planBody);
    expect(createRes.status).toBe(201);
    const planId = createRes.body.data.metadata.planId;

    // Remove beadEpicId from metadata to simulate plan without epic
    const plansDir = path.join((await projectService.getProject(projectId)).repoPath, ".opensprint", "plans");
    const metaPath = path.join(plansDir, `${planId}.meta.json`);
    const meta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
    meta.beadEpicId = "";
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));

    const archiveRes = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans/${planId}/archive`);
    expect(archiveRes.status).toBe(400);
    expect(archiveRes.body.error?.code).toBe("NO_EPIC");
  });
});
