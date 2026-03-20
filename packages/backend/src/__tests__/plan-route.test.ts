import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createApp } from "../app.js";
import { ProjectService } from "../services/project.service.js";
import { TaskStoreService } from "../services/task-store.service.js";
import { API_PREFIX } from "@opensprint/shared";
import { DEFAULT_HIL_CONFIG } from "@opensprint/shared";
import { cleanupTestProject } from "./test-project-cleanup.js";

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (a: unknown, b: unknown) => [a, b],
}));
vi.mock("../db/drizzle-schema-pg.js", () => ({ plansTable: {} }));

const mockSuggestInvoke = vi.fn();
const mockPlanningAgentInvoke = vi.fn();

vi.mock("../services/agent-client.js", () => ({
  AgentClient: vi.fn().mockImplementation(() => ({
    invoke: (opts: unknown) => mockSuggestInvoke(opts),
  })),
}));

vi.mock("../services/agent.service.js", () => ({
  agentService: {
    invokePlanningAgent: (opts: unknown) => mockPlanningAgentInvoke(opts),
  },
}));

const mockBroadcastToProject = vi.fn();
vi.mock("../websocket/index.js", () => ({
  broadcastToProject: (...args: unknown[]) => mockBroadcastToProject(...args),
}));

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

// Mock orchestrator so Ship it! doesn't trigger the real loop (which would claim Task A before archive)
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

const planRouteTaskStoreMod = await import("../services/task-store.service.js");
const planRoutePostgresOk =
  (planRouteTaskStoreMod as { _postgresAvailable?: boolean })._postgresAvailable ?? false;

describe.skipIf(!planRoutePostgresOk)("Plan REST endpoints - task decomposition", () => {
  let app: ReturnType<typeof createApp>;
  let suiteTempDir: string;
  let currentRepoPath: string;
  let originalHome: string | undefined;
  let caseCounter = 0;
  let projectId: string;
  let projectService: ProjectService;
  let taskStore: TaskStoreService;

  beforeAll(async () => {
    app = createApp();
    suiteTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-plan-route-suite-"));
    originalHome = process.env.HOME;
    process.env.HOME = suiteTempDir;

    projectService = new ProjectService();
    taskStore = new TaskStoreService();
    await taskStore.init();
  });

  beforeEach(async () => {
    const mod = (await import("../services/task-store.service.js")) as unknown as {
      _resetSharedDb?: () => void | Promise<void>;
    };
    await mod._resetSharedDb?.();
    currentRepoPath = path.join(suiteTempDir, `test-project-${++caseCounter}`);

    const { wireTaskStoreEvents } = await import("../task-store-events.js");
    wireTaskStoreEvents(mockBroadcastToProject);

    const project = await projectService.createProject({
      name: "Plan Test Project",
      repoPath: currentRepoPath,
      simpleComplexityAgent: { type: "cursor", model: "claude-sonnet-4", cliCommand: null },
      complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });
    projectId = project.id;
  });

  afterEach(async () => {
    await cleanupTestProject({ projectService, projectId });
    // maxRetries/retryDelay help when git-commit-queue or task store hold files during cleanup
    await fs.rm(currentRepoPath, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  });

  afterAll(async () => {
    process.env.HOME = originalHome;
    await fs.rm(suiteTempDir, { recursive: true, force: true });
    const mod = (await import("../services/task-store.service.js")) as {
      _testPool?: { end: () => Promise<void> };
    };
    if (mod._testPool) await mod._testPool.end();
  });

  it(
    "POST /projects/:id/plans with tasks should create tasks via task store",
    { timeout: 15000 },
    async () => {
      const planBody = {
        title: "User Authentication",
        content:
          "# User Authentication\n\n## Overview\n\nAuth feature.\n\n## Acceptance Criteria\n\n- Login works",
        complexity: "medium",
        tasks: [
          {
            title: "Implement login endpoint",
            description: "POST /auth/login",
            priority: 0,
            dependsOn: [],
          },
          {
            title: "Implement JWT validation",
            description: "Validate tokens",
            priority: 1,
            dependsOn: ["Implement login endpoint"],
          },
        ],
      };

      const res = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send(planBody);

      expect(res.status).toBe(201);
      expect(res.body.data).toBeDefined();
      const plan = res.body.data;
      expect(plan.taskCount).toBe(2);
      expect(plan.metadata.epicId).toBeDefined();

      // Epic starts blocked (epic-blocked model)
      const epic = await taskStore.show(projectId, plan.metadata.epicId);
      expect(epic).toBeDefined();
      expect((epic as { status?: string }).status).toBe("blocked");

      // Verify task store has the child tasks (createMany was called)
      const _project = await projectService.getProject(projectId);
      const allIssues = await taskStore.listAll(projectId);
      const epicId = plan.metadata.epicId;
      const childTasks = allIssues.filter(
        (i) => i.id.startsWith(epicId + ".") && (i.issue_type ?? i.type) !== "epic"
      );
      expect(childTasks.length).toBe(2);
      expect(childTasks.map((t) => t.title)).toContain("Implement login endpoint");
      expect(childTasks.map((t) => t.title)).toContain("Implement JWT validation");

      // Epic starts blocked; before Execute!, no implementation tasks should be ready
      const readyBeforeShip = await taskStore.ready(projectId);
      const implementationTaskIds = childTasks.map((t) => t.id);
      const readyIds = readyBeforeShip.map((r) => r.id);
      for (const tid of implementationTaskIds) {
        expect(readyIds).not.toContain(tid);
      }
    }
  );

  it("POST /projects/:id/plans with task complexity creates tasks with integer complexity", async () => {
    const planBody = {
      title: "Feature With Complexity",
      content: "# Feature\n\n## Overview\n\nTest.",
      complexity: "medium",
      tasks: [
        { title: "Simple task", description: "Easy", priority: 0, dependsOn: [], complexity: 2 },
        {
          title: "Complex task",
          description: "Hard",
          priority: 1,
          dependsOn: ["Simple task"],
          complexity: 8,
        },
      ],
    };

    const res = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans`).send(planBody);

    expect(res.status).toBe(201);
    const plan = res.body.data;
    expect(plan.taskCount).toBe(2);
    const allIssues = await taskStore.listAll(projectId);
    const epicId = plan.metadata.epicId;
    const epic = await taskStore.show(projectId, epicId);
    expect((epic as { complexity?: number }).complexity).toBe(3); // medium -> 3

    const childTasks = allIssues.filter(
      (i: { id: string; issue_type?: string; type?: string }) =>
        i.id.startsWith(epicId + ".") && (i.issue_type ?? i.type) !== "epic"
    );
    const simpleTask = childTasks.find((t: { title: string }) => t.title === "Simple task");
    const complexTask = childTasks.find((t: { title: string }) => t.title === "Complex task");
    expect((simpleTask as { complexity?: number }).complexity).toBe(2);
    expect((complexTask as { complexity?: number }).complexity).toBe(8);
  });

  it("POST /projects/:id/plans accepts snake_case depends_on and creates inter-task deps", async () => {
    const planBody = {
      title: "Snake Case Plan",
      content: "# Snake Case\n\n## Overview\n\nTest.",
      complexity: "medium",
      tasks: [
        { title: "Task One", description: "First", priority: 0, depends_on: [] },
        { title: "Task Two", description: "Second", priority: 1, depends_on: ["Task One"] },
      ],
    };

    const res = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans`).send(planBody);

    expect(res.status).toBe(201);
    const plan = res.body.data;
    expect(plan.taskCount).toBe(2);
    const allIssues = await taskStore.listAll(projectId);
    const epicId = plan.metadata.epicId;
    const childTasks = allIssues.filter(
      (i: { id: string; issue_type?: string; type?: string }) =>
        i.id.startsWith(epicId + ".") && (i.issue_type ?? i.type) !== "epic"
    );
    expect(childTasks.length).toBe(2);
    const t1 = childTasks.find((t: { title: string }) => t.title === "Task One");
    const t2 = childTasks.find((t: { title: string }) => t.title === "Task Two");
    expect(t1).toBeDefined();
    expect(t2).toBeDefined();
    const task2 = await taskStore.show(projectId, t2!.id);
    const blockers = (task2?.dependencies ?? []).filter(
      (d: { type: string }) => d.type === "blocks"
    );
    expect(blockers.some((d: { depends_on_id: string }) => d.depends_on_id === t1!.id)).toBe(true);
  });

  it("POST /projects/:id/plans without tasks should create epic only (no gate)", async () => {
    const planBody = {
      title: "Standalone Feature",
      content: "# Standalone\n\nNo tasks yet.",
      complexity: "low",
    };

    const res = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans`).send(planBody);

    expect(res.status).toBe(201);
    expect(res.body.data.taskCount).toBe(0);
    expect(res.body.data.metadata.epicId).toBeDefined();
  });

  it("POST /projects/:id/plans with incomplete template (missing sections) still creates plan (warn only, don't block)", async () => {
    const planBody = {
      title: "Minimal Feature",
      content: "# Minimal Feature\n\n## Overview\n\nOnly overview.",
      complexity: "low",
    };

    const res = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans`).send(planBody);

    expect(res.status).toBe(201);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.metadata.planId).toBe("minimal-feature");
    // Validation warns but does not block — plan is created successfully
  });

  it(
    "POST /projects/:id/plans without complexity should agent-evaluate and use result",
    {
      timeout: 10000,
    },
    async () => {
      mockPlanningAgentInvoke.mockResolvedValueOnce({
        content: JSON.stringify({ complexity: "high" }),
      });

      const planBody = {
        title: "Complex Feature",
        content:
          "# Complex Feature\n\n## Overview\n\nMulti-system integration with auth, API, and UI.",
      };
      // Intentionally omit complexity - backend should agent-evaluate

      const res = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send(planBody);

      expect(res.status).toBe(201);
      expect(res.body.data.metadata.complexity).toBe("high");
      expect(mockPlanningAgentInvoke).toHaveBeenCalledTimes(1);
    }
  );

  it(
    "POST /projects/:id/plans without complexity falls back to medium when agent returns invalid JSON",
    {
      timeout: 10000,
    },
    async () => {
      mockPlanningAgentInvoke.mockResolvedValueOnce({
        content: "I cannot produce valid JSON.",
      });

      const planBody = {
        title: "Simple Feature",
        content: "# Simple\n\nOverview.",
      };

      const res = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send(planBody);

      expect(res.status).toBe(201);
      expect(res.body.data.metadata.complexity).toBe("medium");
    }
  );

  it("GET /projects/:id/plans/:planId returns lastModified (plan markdown file mtime)", async () => {
    const planBody = {
      title: "Feature With LastModified",
      content: "# Feature\n\nContent.",
      complexity: "low",
    };

    const createRes = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/plans`)
      .send(planBody);
    expect(createRes.status).toBe(201);
    const planId = createRes.body.data.metadata.planId;

    const getRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/plans/${planId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.lastModified).toBeDefined();
    expect(typeof getRes.body.data.lastModified).toBe("string");
    // Should be valid ISO date
    expect(new Date(getRes.body.data.lastModified).getTime()).not.toBeNaN();
    // Version fields from store
    expect(getRes.body.data.currentVersionNumber).toBe(1);
    expect(getRes.body.data.lastExecutedVersionNumber).toBeUndefined();
  });

  it(
    "PUT /projects/:id/plans/:planId updates plan title and markdown content",
    { timeout: 60_000 },
    async () => {
      const planBody = {
        title: "Original Feature",
        content: "# Original Feature\n\n## Overview\n\nOriginal content.",
        complexity: "low",
      };

      const createRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send(planBody);
      expect(createRes.status).toBe(201);
      const planId = createRes.body.data.metadata.planId;

      const updatedContent =
        "# Updated Feature Title\n\n## Overview\n\nUpdated markdown body with new content.";
      const putRes = await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/plans/${planId}`)
        .send({ content: updatedContent });

      expect(putRes.status).toBe(200);
      expect(putRes.body.data.content).toBe(updatedContent);

      const getRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/plans/${planId}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.content).toBe(updatedContent);
    }
  );

  it("PUT /projects/:id/plans/:planId with no tasks updates in place; list versions returns one version", async () => {
    const planBody = {
      title: "Versioned Feature",
      content: "# Versioned Feature\n\n## Overview\n\nInitial content.",
      complexity: "low",
    };
    const createRes = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/plans`)
      .send(planBody);
    expect(createRes.status).toBe(201);
    const planId = createRes.body.data.metadata.planId;

    await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/plans/${planId}`)
      .send({ content: "# Versioned Feature\n\n## Overview\n\nFirst save." });
    await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/plans/${planId}`)
      .send({ content: "# Versioned Feature\n\n## Overview\n\nSecond save." });

    const versionsRes = await request(app).get(
      `${API_PREFIX}/projects/${projectId}/plans/${planId}/versions`
    );
    expect(versionsRes.status).toBe(200);
    expect(versionsRes.body.data.versions).toHaveLength(1);
    expect(versionsRes.body.data.versions[0].version_number).toBe(1);
  });

  it("PUT /projects/:id/plans/:planId with tasks creates new version on first save; second save updates current version in place (version-aware)", async () => {
    const planBody = {
      title: "Versioned Feature",
      content: "# Versioned Feature\n\n## Overview\n\nInitial content.",
      complexity: "low",
    };
    const createRes = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/plans`)
      .send(planBody);
    expect(createRes.status).toBe(201);
    const planId = createRes.body.data.metadata.planId;
    const epicId = createRes.body.data.metadata.epicId as string;
    await taskStore.create(projectId, "A task under the plan", {
      type: "task",
      parentId: epicId,
    });

    await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/plans/${planId}`)
      .send({ content: "# Versioned Feature\n\n## Overview\n\nFirst save." });
    await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/plans/${planId}`)
      .send({ content: "# Versioned Feature\n\n## Overview\n\nSecond save." });

    const versionsRes = await request(app).get(
      `${API_PREFIX}/projects/${projectId}/plans/${planId}/versions`
    );
    expect(versionsRes.status).toBe(200);
    expect(versionsRes.body.data.versions).toHaveLength(2);
    const versions = versionsRes.body.data.versions as Array<{ version_number: number }>;
    const numbers = versions.map((v) => v.version_number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2]);
  });

  it("PUT /projects/:id/plans/:planId returns 404 when plan does not exist", async () => {
    const putRes = await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/plans/nonexistent-plan-xyz`)
      .send({ content: "# Nonexistent\n\nBody." });
    expect(putRes.status).toBe(404);
    expect(putRes.body.error?.code).toBe("PLAN_NOT_FOUND");
  });

  it("PUT /projects/:id/plans/:planId syncs ## Tasks section to task store task titles and descriptions", async () => {
    const planBody = {
      title: "Sync Test Feature",
      content:
        "# Sync Test\n\n## Overview\n\nTest sync.\n\n## Tasks\n\n### Original task 1\nOriginal desc 1.\n\n### Original task 2\nOriginal desc 2.",
      complexity: "low",
      tasks: [
        { title: "Original task 1", description: "Original desc 1.", priority: 0, dependsOn: [] },
        { title: "Original task 2", description: "Original desc 2.", priority: 1, dependsOn: [] },
      ],
    };

    const createRes = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/plans`)
      .send(planBody);
    expect(createRes.status).toBe(201);
    const planId = createRes.body.data.metadata.planId;
    const epicId = createRes.body.data.metadata.epicId;

    // Update plan with modified task titles and descriptions in ## Tasks section
    const updatedContent = `# Sync Test

## Overview

Test sync.

## Tasks

### Renamed task one
Updated description for task one.

### Renamed task two
Updated description for task two.`;

    const putRes = await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/plans/${planId}`)
      .send({ content: updatedContent });
    expect(putRes.status).toBe(200);

    // Verify task store tasks were updated (task store holds plan tasks)
    const allIssues = await taskStore.listAll(projectId);
    // syncPlanTasksToStore uses epic prefix + non-epic only (no gate filter)
    const childTasks = allIssues.filter(
      (i: { id: string; issue_type?: string; type?: string }) =>
        i.id.startsWith(epicId + ".") && (i.issue_type ?? i.type) !== "epic"
    );
    childTasks.sort((a: { id: string }, b: { id: string }) => {
      const idxA = parseInt(a.id.split(".").pop() ?? "0", 10);
      const idxB = parseInt(b.id.split(".").pop() ?? "0", 10);
      return idxA - idxB;
    });
    expect(childTasks).toHaveLength(2);
    expect(childTasks[0].title).toBe("Renamed task one");
    expect(childTasks[0].description).toBe("Updated description for task one.");
    expect(childTasks[1].title).toBe("Renamed task two");
    expect(childTasks[1].description).toBe("Updated description for task two.");
  });

  it("GET /projects/:id/plans list returns lastModified for each plan", async () => {
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
      p.metadata.planId.includes("list-test-feature")
    );
    expect(plan).toBeDefined();
    expect(plan.lastModified).toBeDefined();
    expect(typeof plan.lastModified).toBe("string");
    expect(plan.currentVersionNumber).toBe(1);
    expect(
      plan.lastExecutedVersionNumber === undefined || plan.lastExecutedVersionNumber === null
    ).toBe(true);
  });

  it("POST /projects/:id/plans/:planId/plan-tasks invokes Planner and creates tasks", async () => {
    mockBroadcastToProject.mockClear();
    mockPlanningAgentInvoke.mockClear();
    const planBody = {
      title: "Plan Tasks Test Feature",
      content:
        "# Plan Tasks Test\n\n## Overview\n\nFeature to test plan-tasks.\n\n## Acceptance Criteria\n\n- Tasks generated",
      complexity: "medium",
    };

    const createRes = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/plans`)
      .send(planBody);
    expect(createRes.status).toBe(201);
    const createdPlanId = createRes.body.data.metadata.planId;
    expect(createRes.body.data.taskCount).toBe(0);

    mockPlanningAgentInvoke.mockResolvedValueOnce({
      content: JSON.stringify({
        tasks: [
          { title: "Setup schema", description: "Create DB schema", priority: 0, dependsOn: [] },
          {
            title: "Implement API",
            description: "Build endpoints",
            priority: 1,
            dependsOn: ["Setup schema"],
          },
        ],
      }),
    });

    const planTasksRes = await request(app).post(
      `${API_PREFIX}/projects/${projectId}/plans/${createdPlanId}/plan-tasks`
    );
    expect(planTasksRes.status).toBe(200);
    expect(planTasksRes.body.data.taskCount).toBe(2);

    const _project = await projectService.getProject(projectId);
    const allIssues = await taskStore.listAll(projectId);
    const epicId = createRes.body.data.metadata.epicId;
    const childTasks = allIssues.filter(
      (i: { id: string; issue_type?: string; type?: string }) =>
        i.id.startsWith(epicId + ".") && (i.issue_type ?? i.type) !== "epic"
    );
    expect(childTasks.length).toBe(2);
    expect(childTasks.map((t: { title: string }) => t.title)).toContain("Setup schema");
    expect(childTasks.map((t: { title: string }) => t.title)).toContain("Implement API");

    // Epic blocked; tasks not ready until Execute!
    const readyBeforeShip = await taskStore.ready(projectId);
    const readyIds = readyBeforeShip.map((r: { id: string }) => r.id);
    for (const t of childTasks) {
      expect(readyIds).not.toContain(t.id);
    }

    // Planner was invoked with plan markdown as context
    expect(mockPlanningAgentInvoke).toHaveBeenCalledTimes(1);
    const invokeArgs = mockPlanningAgentInvoke.mock.calls[0][0];
    expect(invokeArgs.messages[0].content).toContain("Plan Tasks Test");
    expect(invokeArgs.messages[0].content).toContain("Feature to test plan-tasks");
    expect(invokeArgs.tracking.role).toBe("planner");

    // WebSocket real-time updates: task.created per task (from TaskStoreService), plan.updated at end.
    // plan-tasks creates epic (if missing) + 2 child tasks = 3 task.created events
    const taskCreatedCalls = mockBroadcastToProject.mock.calls.filter(
      (c: unknown[]) => (c[1] as { type?: string })?.type === "task.created"
    );
    const planUpdatedCalls = mockBroadcastToProject.mock.calls.filter(
      (c: unknown[]) => (c[1] as { type?: string })?.type === "plan.updated"
    );
    expect(taskCreatedCalls.length).toBeGreaterThanOrEqual(2);
    expect(planUpdatedCalls.length).toBeGreaterThanOrEqual(1);
    expect(
      planUpdatedCalls.every((c) => (c[1] as { planId?: string }).planId === createdPlanId)
    ).toBe(true);
  });

  it("POST /projects/:id/plans/:planId/plan-tasks returns 400 when plan already has tasks", async () => {
    const planBody = {
      title: "Has Tasks Feature",
      content: "# Has Tasks\n\nContent.",
      complexity: "low",
      tasks: [
        { title: "Existing task", description: "Already exists", priority: 0, dependsOn: [] },
      ],
    };

    const createRes = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/plans`)
      .send(planBody);
    expect(createRes.status).toBe(201);
    const createdPlanId = createRes.body.data.metadata.planId;
    expect(createRes.body.data.taskCount).toBe(1);

    const planTasksRes = await request(app).post(
      `${API_PREFIX}/projects/${projectId}/plans/${createdPlanId}/plan-tasks`
    );
    expect(planTasksRes.status).toBe(400);
    expect(planTasksRes.body.error?.message).toContain("already has implementation tasks");
  });

  it("POST /projects/:id/plans/:planId/execute returns 400 when plan has no epic", async () => {
    const planBody = {
      title: "No Epic Feature",
      content: "# No Epic\n\nContent.",
      complexity: "low",
    };

    const createRes = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/plans`)
      .send(planBody);
    expect(createRes.status).toBe(201);
    const createdPlanId = createRes.body.data.metadata.planId;

    const row = await taskStore.planGet(projectId, createdPlanId);
    expect(row).not.toBeNull();
    await taskStore.planUpdateMetadata(projectId, createdPlanId, {
      ...row!.metadata,
      epicId: "",
    });

    const executeRes = await request(app).post(
      `${API_PREFIX}/projects/${projectId}/plans/${createdPlanId}/execute`
    );
    expect(executeRes.status).toBe(400);
    expect(executeRes.body.error?.code).toBe("NO_EPIC");
  });

  it(
    "POST /projects/:id/plans/:planId/plan-tasks generates tasks when plan has none (no gate)",
    { timeout: 15000 },
    async () => {
      const planBody = {
        title: "Generate Tasks Feature",
        content: "# Generate Tasks\n\nOverview.",
        complexity: "low",
      };
      const createRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send(planBody);
      expect(createRes.status).toBe(201);
      const createdPlanId = createRes.body.data.metadata.planId;

      mockPlanningAgentInvoke.mockResolvedValueOnce({
        content: `\n\`\`\`json\n${JSON.stringify({
          tasks: [
            { title: "Task One", description: "First", priority: 0, dependsOn: [] },
            { title: "Task Two", description: "Second", priority: 1, dependsOn: [] },
          ],
        })}\n\`\`\``,
      });

      const genRes = await request(app).post(
        `${API_PREFIX}/projects/${projectId}/plans/${createdPlanId}/plan-tasks`
      );
      expect(genRes.status).toBe(200);
      const plan = genRes.body.data;
      expect(plan.metadata.epicId).toBeTruthy();
      expect(plan.taskCount).toBe(2);
    }
  );

  it(
    "POST /projects/:id/plans/:planId/plan-tasks returns detailed parse reason when tasks are invalid",
    { timeout: 15000 },
    async () => {
      const planBody = {
        title: "Generate Tasks Parse Failure Feature",
        content: "# Generate Tasks Parse Failure\n\nOverview.",
        complexity: "low",
      };
      const createRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send(planBody);
      expect(createRes.status).toBe(201);
      const createdPlanId = createRes.body.data.metadata.planId;

      mockPlanningAgentInvoke.mockResolvedValueOnce({
        content: JSON.stringify({
          result: {
            tasks: ["bad-entry", null],
          },
        }),
      });

      const genRes = await request(app).post(
        `${API_PREFIX}/projects/${projectId}/plans/${createdPlanId}/plan-tasks`
      );
      expect(genRes.status).toBe(400);
      expect(genRes.body.error?.code).toBe("DECOMPOSE_PARSE_FAILED");
      expect(genRes.body.error?.message).toContain("contained no task objects");
      expect(genRes.body.error?.details?.parseFailureReason).toContain("contained no task objects");
    }
  );

  it(
    "POST /projects/:id/plans/:planId/plan-tasks creates epic when missing then generates tasks",
    { timeout: 15000 },
    async () => {
      const planBody = {
        title: "simplified-two-tier-agent-configuration",
        content: "# Simplified Two Tier Agent Configuration\n\nOverview.",
        complexity: "low",
      };
      const createRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send(planBody);
      expect(createRes.status).toBe(201);
      const createdPlanId = createRes.body.data.metadata.planId;
      const row = await taskStore.planGet(projectId, createdPlanId);
      expect(row).not.toBeNull();
      await taskStore.planUpdateMetadata(projectId, createdPlanId, {
        ...row!.metadata,
        epicId: "",
      });

      mockPlanningAgentInvoke.mockResolvedValueOnce({
        content: `\n\`\`\`json\n${JSON.stringify({
          tasks: [
            { title: "Task One", description: "First", priority: 0, dependsOn: [] },
            { title: "Task Two", description: "Second", priority: 1, dependsOn: [] },
          ],
        })}\n\`\`\``,
      });

      const genRes = await request(app).post(
        `${API_PREFIX}/projects/${projectId}/plans/${createdPlanId}/plan-tasks`
      );
      expect(genRes.status).toBe(200);
      const plan = genRes.body.data;
      expect(plan.metadata.epicId).toBeTruthy();
      expect(plan.taskCount).toBe(2);
    }
  );

  it(
    "POST /projects/:id/plans/:planId/archive closes all ready/open tasks, leaves in_progress unchanged",
    {
      timeout: 15000,
    },
    async () => {
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

      const createRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send(planBody);
      expect(createRes.status).toBe(201);
      const createdPlanId = createRes.body.data.metadata.planId;
      const epicId = createRes.body.data.metadata.epicId;

      // Execute! to unblock epic so tasks become ready
      const shipRes = await request(app).post(
        `${API_PREFIX}/projects/${projectId}/plans/${createdPlanId}/execute`
      );
      expect(shipRes.status).toBe(200);

      // Epic status set to open by Execute!
      const epicAfterShip = await taskStore.show(projectId, epicId);
      expect((epicAfterShip as { status?: string }).status).toBe("open");

      const _project = await projectService.getProject(projectId);
      const allIssues = await taskStore.listAll(projectId);
      const planTasks = allIssues.filter(
        (i: { id: string; issue_type?: string; type?: string }) =>
          i.id.startsWith(epicId + ".") && (i.issue_type ?? i.type) !== "epic"
      );

      const taskA = planTasks.find((t: { title: string }) => t.title === "Task A");
      const taskB = planTasks.find((t: { title: string }) => t.title === "Task B");
      const taskC = planTasks.find((t: { title: string }) => t.title === "Task C");
      expect(taskA).toBeDefined();
      expect(taskB).toBeDefined();
      expect(taskC).toBeDefined();

      // Claim Task B to put it in_progress
      await taskStore.update(projectId, (taskB as { id: string }).id, {
        status: "in_progress",
        assignee: "test-user",
        claim: true,
      });

      // Archive the plan
      const archiveRes = await request(app).post(
        `${API_PREFIX}/projects/${projectId}/plans/${createdPlanId}/archive`
      );
      expect(archiveRes.status).toBe(200);

      // Verify: Task A and Task C should be closed; Task B (in_progress) should remain in_progress
      const afterArchive = await taskStore.listAll(projectId);
      const taskAAfter = afterArchive.find(
        (i: { id: string }) => i.id === (taskA as { id: string }).id
      );
      const taskBAfter = afterArchive.find(
        (i: { id: string }) => i.id === (taskB as { id: string }).id
      );
      const taskCAfter = afterArchive.find(
        (i: { id: string }) => i.id === (taskC as { id: string }).id
      );

      expect((taskAAfter as { status: string }).status).toBe("closed");
      expect((taskBAfter as { status: string }).status).toBe("in_progress");
      expect((taskCAfter as { status: string }).status).toBe("closed");
    }
  );

  describe("POST /projects/:id/plans/:planId/re-execute", () => {
    it(
      "reship succeeds when all tasks are done (closed) — Auditor audit & delta flow",
      {
        timeout: 15000,
      },
      async () => {
        // Harmonizer (ship) + Auditor (re-execute: audit + delta tasks) + Harmonizer (second ship)
        mockPlanningAgentInvoke
          .mockResolvedValueOnce({ content: '{"status":"no_changes_needed"}' }) // Harmonizer on ship
          .mockResolvedValueOnce({
            content:
              '{"status":"success","capability_summary":"## Features\\n- Auth implemented","tasks":[{"index":0,"title":"Delta Task","description":"Add delta","priority":1,"depends_on":[]}]}',
          })
          .mockResolvedValueOnce({ content: '{"status":"no_changes_needed"}' }); // Harmonizer on second ship

        const planBody = {
          title: "Reship All Done Feature",
          content: "# Reship All Done\n\nContent.",
          complexity: "medium",
          tasks: [
            { title: "Task X", description: "First", priority: 0, dependsOn: [] },
            { title: "Task Y", description: "Second", priority: 1, dependsOn: [] },
          ],
        };

        const createRes = await request(app)
          .post(`${API_PREFIX}/projects/${projectId}/plans`)
          .send(planBody);
        expect(createRes.status).toBe(201);
        const planId = createRes.body.data.metadata.planId;
        const epicId = createRes.body.data.metadata.epicId;

        // Execute! (saves .shipped.md for plan_old)
        const shipRes = await request(app).post(
          `${API_PREFIX}/projects/${projectId}/plans/${planId}/execute`
        );
        expect(shipRes.status).toBe(200);

        const _project = await projectService.getProject(projectId);
        const allIssues = await taskStore.listAll(projectId);
        const planTasks = allIssues.filter(
          (i: { id: string; issue_type?: string; type?: string }) =>
            i.id.startsWith(epicId + ".") && (i.issue_type ?? i.type) !== "epic"
        );

        // Close all implementation tasks
        for (const task of planTasks) {
          await taskStore.close(projectId, (task as { id: string }).id, "Done");
        }

        // Re-execute only allowed for complete plans; mark plan complete first
        const markRes = await request(app).post(
          `${API_PREFIX}/projects/${projectId}/plans/${planId}/mark-complete`
        );
        expect(markRes.status).toBe(200);

        // Re-execute: Auditor creates delta tasks (no gate); epic set back to blocked
        const reshipRes = await request(app).post(
          `${API_PREFIX}/projects/${projectId}/plans/${planId}/re-execute`
        );
        expect(reshipRes.status).toBe(200);
        expect(reshipRes.body.data).toBeDefined();

        // Epic blocked after re-execute (delta tasks added); second Execute! would unblock
        const epicAfterReship = await taskStore.show(projectId, epicId);
        expect((epicAfterReship as { status?: string }).status).toBe("blocked");

        const afterReship = await taskStore.listAll(projectId);
        const deltaTasks = afterReship.filter(
          (i: { id: string; title: string; issue_type?: string; type?: string }) =>
            i.id.startsWith(epicId + ".") &&
            (i.issue_type ?? i.type) !== "epic" &&
            i.title === "Delta Task"
        );
        expect(deltaTasks.length).toBe(1);

        // Second Execute! unblocks epic; delta tasks become ready
        const secondShipRes = await request(app).post(
          `${API_PREFIX}/projects/${projectId}/plans/${planId}/execute`
        );
        expect(secondShipRes.status).toBe(200);
        const epicAfterSecondShip = await taskStore.show(projectId, epicId);
        expect((epicAfterSecondShip as { status?: string }).status).toBe("open");
        const readyAfterSecondShip = await taskStore.ready(projectId);
        const deltaTaskIds = deltaTasks.map((t: { id: string }) => t.id);
        expect(readyAfterSecondShip.some((r) => deltaTaskIds.includes(r.id))).toBe(true);
      }
    );

    it(
      "reship returns plan unchanged when Auditor returns no_changes_needed",
      {
        timeout: 15000,
      },
      async () => {
        mockPlanningAgentInvoke
          .mockResolvedValueOnce({ content: '{"status":"no_changes_needed"}' }) // Harmonizer on ship
          .mockResolvedValueOnce({
            content:
              '{"status":"no_changes_needed","capability_summary":"## Features\\n- All done"}',
          });

        const planBody = {
          title: "No Changes Feature",
          content: "# No Changes\n\nContent.",
          complexity: "medium",
          tasks: [{ title: "Task A", description: "First", priority: 0, dependsOn: [] }],
        };

        const createRes = await request(app)
          .post(`${API_PREFIX}/projects/${projectId}/plans`)
          .send(planBody);
        expect(createRes.status).toBe(201);
        const planId = createRes.body.data.metadata.planId;
        const epicId = createRes.body.data.metadata.epicId;

        const shipRes = await request(app).post(
          `${API_PREFIX}/projects/${projectId}/plans/${planId}/execute`
        );
        expect(shipRes.status).toBe(200);

        const _project = await projectService.getProject(projectId);
        const allIssues = await taskStore.listAll(projectId);
        const planTasks = allIssues.filter(
          (i: { id: string; issue_type?: string; type?: string }) =>
            i.id.startsWith(epicId + ".") && (i.issue_type ?? i.type) !== "epic"
        );
        for (const task of planTasks) {
          await taskStore.close(projectId, (task as { id: string }).id, "Done");
        }

        // Re-execute only allowed for complete plans; mark plan complete first
        const markRes = await request(app).post(
          `${API_PREFIX}/projects/${projectId}/plans/${planId}/mark-complete`
        );
        expect(markRes.status).toBe(200);

        const beforeCount = (await taskStore.listAll(projectId)).filter(
          (i: { id: string; issue_type?: string; type?: string }) =>
            i.id.startsWith(epicId + ".") && (i.issue_type ?? i.type) !== "epic"
        ).length;

        const reshipRes = await request(app).post(
          `${API_PREFIX}/projects/${projectId}/plans/${planId}/re-execute`
        );
        expect(reshipRes.status).toBe(200);

        const afterCount = (await taskStore.listAll(projectId)).filter(
          (i: { id: string; issue_type?: string; type?: string }) =>
            i.id.startsWith(epicId + ".") && (i.issue_type ?? i.type) !== "epic"
        ).length;
        expect(afterCount).toBe(beforeCount);
      }
    );

    it(
      "reship returns 400 when plan status is in_review (not marked complete)",
      { timeout: 15000 },
      async () => {
        const planBody = {
          title: "In Review Feature",
          content: "# In Review\n\nContent.",
          complexity: "medium",
          tasks: [
            { title: "Task A", description: "First", priority: 0, dependsOn: [] },
            { title: "Task B", description: "Second", priority: 1, dependsOn: [] },
          ],
        };

        const createRes = await request(app)
          .post(`${API_PREFIX}/projects/${projectId}/plans`)
          .send(planBody);
        expect(createRes.status).toBe(201);
        const planId = createRes.body.data.metadata.planId;
        const epicId = createRes.body.data.metadata.epicId;

        const shipRes = await request(app).post(
          `${API_PREFIX}/projects/${projectId}/plans/${planId}/execute`
        );
        expect(shipRes.status).toBe(200);

        const _project = await projectService.getProject(projectId);
        const allIssues = await taskStore.listAll(projectId);
        const planTasks = allIssues.filter(
          (i: { id: string; issue_type?: string; type?: string }) =>
            i.id.startsWith(epicId + ".") && (i.issue_type ?? i.type) !== "epic"
        );
        for (const task of planTasks) {
          await taskStore.close(projectId, (task as { id: string }).id, "Done");
        }
        // Plan is now in_review (all tasks closed, not marked complete). Do not call mark-complete.

        const reshipRes = await request(app).post(
          `${API_PREFIX}/projects/${projectId}/plans/${planId}/re-execute`
        );
        expect(reshipRes.status).toBe(400);
        expect(reshipRes.body.error?.message).toContain(
          "Re-execute is only available for plans that have been marked complete"
        );
      }
    );

    it(
      "reship returns 400 TASKS_IN_PROGRESS when any task is in_progress",
      { timeout: 15000 },
      async () => {
        const planBody = {
          title: "Reship In Progress Feature",
          content: "# Reship In Progress\n\nContent.",
          complexity: "medium",
          tasks: [
            { title: "Task P", description: "First", priority: 0, dependsOn: [] },
            { title: "Task Q", description: "Second", priority: 1, dependsOn: [] },
          ],
        };

        const createRes = await request(app)
          .post(`${API_PREFIX}/projects/${projectId}/plans`)
          .send(planBody);
        expect(createRes.status).toBe(201);
        const planId = createRes.body.data.metadata.planId;
        const epicId = createRes.body.data.metadata.epicId;

        const shipRes = await request(app).post(
          `${API_PREFIX}/projects/${projectId}/plans/${planId}/execute`
        );
        expect(shipRes.status).toBe(200);

        const _project = await projectService.getProject(projectId);
        const allIssues = await taskStore.listAll(projectId);
        const taskP = allIssues.find(
          (i: { id: string; title: string; issue_type?: string; type?: string }) =>
            i.id.startsWith(epicId + ".") &&
            (i.issue_type ?? i.type) !== "epic" &&
            i.title === "Task P"
        );
        expect(taskP).toBeDefined();

        await taskStore.update(projectId, (taskP as { id: string }).id, {
          status: "in_progress",
          assignee: "test-user",
          claim: true,
        });

        const reshipRes = await request(app).post(
          `${API_PREFIX}/projects/${projectId}/plans/${planId}/re-execute`
        );
        expect(reshipRes.status).toBe(400);
        expect(reshipRes.body.error?.code).toBe("TASKS_IN_PROGRESS");
      }
    );

    it(
      "reship returns 400 TASKS_NOT_COMPLETE when some tasks open and some closed",
      { timeout: 15000 },
      async () => {
        const planBody = {
          title: "Reship Mixed Feature",
          content: "# Reship Mixed\n\nContent.",
          complexity: "medium",
          tasks: [
            { title: "Task M", description: "First", priority: 0, dependsOn: [] },
            { title: "Task N", description: "Second", priority: 1, dependsOn: [] },
          ],
        };

        const createRes = await request(app)
          .post(`${API_PREFIX}/projects/${projectId}/plans`)
          .send(planBody);
        expect(createRes.status).toBe(201);
        const planId = createRes.body.data.metadata.planId;
        const epicId = createRes.body.data.metadata.epicId;

        const shipRes = await request(app).post(
          `${API_PREFIX}/projects/${projectId}/plans/${planId}/execute`
        );
        expect(shipRes.status).toBe(200);

        const _project = await projectService.getProject(projectId);
        const allIssues = await taskStore.listAll(projectId);
        const planTasks = allIssues.filter(
          (i: { id: string; issue_type?: string; type?: string }) =>
            i.id.startsWith(epicId + ".") && (i.issue_type ?? i.type) !== "epic"
        );
        expect(planTasks.length).toBe(2);

        // Close only the first task
        await taskStore.close(projectId, (planTasks[0] as { id: string }).id, "Done");

        const reshipRes = await request(app).post(
          `${API_PREFIX}/projects/${projectId}/plans/${planId}/re-execute`
        );
        expect(reshipRes.status).toBe(400);
        expect(reshipRes.body.error?.code).toBe("TASKS_NOT_COMPLETE");
      }
    );

    it(
      "reship returns 400 when plan not complete (e.g. building — none started)",
      { timeout: 15000 },
      async () => {
        const planBody = {
          title: "Reship None Started Feature",
          content: "# Reship None Started\n\nContent.",
          complexity: "medium",
          tasks: [
            { title: "Task S", description: "First", priority: 0, dependsOn: [] },
            { title: "Task T", description: "Second", priority: 1, dependsOn: [] },
          ],
        };

        const createRes = await request(app)
          .post(`${API_PREFIX}/projects/${projectId}/plans`)
          .send(planBody);
        expect(createRes.status).toBe(201);
        const planId = createRes.body.data.metadata.planId;
        const epicId = createRes.body.data.metadata.epicId;

        // Execute! (tasks become ready but stay open); plan status is "building"
        const shipRes = await request(app).post(
          `${API_PREFIX}/projects/${projectId}/plans/${planId}/execute`
        );
        expect(shipRes.status).toBe(200);

        const _project = await projectService.getProject(projectId);
        const beforeReship = await taskStore.listAll(projectId);
        const tasksBefore = beforeReship.filter(
          (i: { id: string; issue_type?: string; type?: string }) =>
            i.id.startsWith(epicId + ".") && (i.issue_type ?? i.type) !== "epic"
        );
        expect(tasksBefore.length).toBe(2);

        // Re-execute only allowed for complete plans; building plan must return 400
        const reshipRes = await request(app).post(
          `${API_PREFIX}/projects/${projectId}/plans/${planId}/re-execute`
        );
        expect(reshipRes.status).toBe(400);
        expect(reshipRes.body.error?.message).toContain(
          "Re-execute is only available for plans that have been marked complete"
        );
      }
    );

    it("re-execute with version_number uses that version content for Auditor (plan_old)", async () => {
      mockPlanningAgentInvoke.mockReset();
      mockPlanningAgentInvoke.mockImplementation(
        (opts: { messages?: Array<{ content: string }> }) => {
          const content = opts.messages?.[0]?.content ?? "";
          if (content.includes("plan_old.md") && content.includes("plan_new.md")) {
            return Promise.resolve({
              content: JSON.stringify({
                status: "no_changes_needed",
                capability_summary: "All done",
                tasks: [],
              }),
            });
          }
          return Promise.resolve({ content: '{"status":"no_changes_needed"}' });
        }
      );

      const planBody = {
        title: "Re-execute Version Plan",
        content: "# Re-execute Version\n\n## Overview\n\nInitial (v1).",
        complexity: "medium",
        tasks: [
          { title: "Task A", description: "First", priority: 0, dependsOn: [] },
          { title: "Task B", description: "Second", priority: 1, dependsOn: [] },
        ],
      };
      const createRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send(planBody);
      expect(createRes.status).toBe(201);
      const planId = createRes.body.data.metadata.planId;
      const epicId = createRes.body.data.metadata.epicId;

      await request(app).post(`${API_PREFIX}/projects/${projectId}/plans/${planId}/execute`);
      await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/plans/${planId}`)
        .send({ content: "# Re-execute Version\n\n## Overview\n\nEdited to v2." });

      const _project = await projectService.getProject(projectId);
      const allIssues = await taskStore.listAll(projectId);
      const planTasks = allIssues.filter(
        (i: { id: string; issue_type?: string; type?: string }) =>
          i.id.startsWith(epicId + ".") && (i.issue_type ?? i.type) !== "epic"
      );
      for (const task of planTasks) {
        await taskStore.close(projectId, (task as { id: string }).id, "Done");
      }
      await request(app).post(`${API_PREFIX}/projects/${projectId}/plans/${planId}/mark-complete`);

      const reshipRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans/${planId}/re-execute`)
        .send({ version_number: 1 });
      expect(reshipRes.status).toBe(200);

      const auditorCall = mockPlanningAgentInvoke.mock.calls.find(
        (c) =>
          (c[0] as { tracking?: { label?: string } })?.tracking?.label ===
          "Re-execute: audit & delta tasks"
      );
      expect(auditorCall).toBeDefined();
      const prompt =
        (auditorCall![0] as { messages?: Array<{ content: string }> }).messages?.[0]?.content ?? "";
      expect(prompt).toContain("Initial (v1)"); // plan_old = v1 content
      expect(prompt).toContain("Edited to v2"); // plan_new = current content
    });

    it("re-execute without version_number uses last_executed_version_number for Auditor (plan_old)", async () => {
      mockPlanningAgentInvoke.mockReset();
      mockPlanningAgentInvoke.mockImplementation(
        (opts: { messages?: Array<{ content: string }> }) => {
          const content = opts.messages?.[0]?.content ?? "";
          if (content.includes("plan_old.md") && content.includes("plan_new.md")) {
            return Promise.resolve({
              content: JSON.stringify({
                status: "no_changes_needed",
                capability_summary: "All done",
                tasks: [],
              }),
            });
          }
          return Promise.resolve({ content: '{"status":"no_changes_needed"}' });
        }
      );

      const planBody = {
        title: "Re-execute No Version Plan",
        content: "# Re-execute No Version\n\n## Overview\n\nShipped (v1).",
        complexity: "medium",
        tasks: [
          { title: "Task A", description: "First", priority: 0, dependsOn: [] },
          { title: "Task B", description: "Second", priority: 1, dependsOn: [] },
        ],
      };
      const createRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send(planBody);
      expect(createRes.status).toBe(201);
      const planId = createRes.body.data.metadata.planId;
      const epicId = createRes.body.data.metadata.epicId;

      await request(app).post(`${API_PREFIX}/projects/${projectId}/plans/${planId}/execute`);
      await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/plans/${planId}`)
        .send({ content: "# Re-execute No Version\n\n## Overview\n\nEdited to v2." });

      const _project = await projectService.getProject(projectId);
      const allIssues = await taskStore.listAll(projectId);
      const planTasks = allIssues.filter(
        (i: { id: string; issue_type?: string; type?: string }) =>
          i.id.startsWith(epicId + ".") && (i.issue_type ?? i.type) !== "epic"
      );
      for (const task of planTasks) {
        await taskStore.close(projectId, (task as { id: string }).id, "Done");
      }
      await request(app).post(`${API_PREFIX}/projects/${projectId}/plans/${planId}/mark-complete`);

      // No body: backend must use last_executed_version_number for plan_old
      const reshipRes = await request(app).post(
        `${API_PREFIX}/projects/${projectId}/plans/${planId}/re-execute`
      );
      expect(reshipRes.status).toBe(200);

      const auditorCall = mockPlanningAgentInvoke.mock.calls.find(
        (c) =>
          (c[0] as { tracking?: { label?: string } })?.tracking?.label ===
          "Re-execute: audit & delta tasks"
      );
      expect(auditorCall).toBeDefined();
      const prompt =
        (auditorCall![0] as { messages?: Array<{ content: string }> }).messages?.[0]?.content ?? "";
      expect(prompt).toContain("Shipped (v1)"); // plan_old = last executed (v1) content
      expect(prompt).toContain("Edited to v2"); // plan_new = current content
    });
  });

  describe("POST /projects/:id/plans/generate", () => {
    beforeEach(async () => {
      mockPlanningAgentInvoke.mockClear();
      const project = await projectService.getProject(projectId);
      const prd = {
        version: 1,
        sections: {
          executive_summary: {
            content: "A todo app with user auth",
            version: 1,
            updatedAt: new Date().toISOString(),
          },
          problem_statement: { content: "", version: 0, updatedAt: new Date().toISOString() },
          user_personas: { content: "", version: 0, updatedAt: new Date().toISOString() },
          goals_and_metrics: { content: "", version: 0, updatedAt: new Date().toISOString() },
          assumptions_and_constraints: { content: "", version: 0, updatedAt: new Date().toISOString() },
          feature_list: { content: "", version: 0, updatedAt: new Date().toISOString() },
          technical_architecture: { content: "", version: 0, updatedAt: new Date().toISOString() },
          data_model: { content: "", version: 0, updatedAt: new Date().toISOString() },
          api_contracts: { content: "", version: 0, updatedAt: new Date().toISOString() },
          non_functional_requirements: {
            content: "",
            version: 0,
            updatedAt: new Date().toISOString(),
          },
          open_questions: { content: "", version: 0, updatedAt: new Date().toISOString() },
        },
        changeLog: [],
      };
      const { SPEC_MD, SPEC_METADATA_PATH, prdToSpecMarkdown } = await import("@opensprint/shared");
      await fs.writeFile(
        path.join(project.repoPath, SPEC_MD),
        prdToSpecMarkdown(prd as never),
        "utf-8"
      );
      await fs.mkdir(path.join(project.repoPath, path.dirname(SPEC_METADATA_PATH)), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(project.repoPath, SPEC_METADATA_PATH),
        JSON.stringify({ version: 1, changeLog: [] }, null, 2),
        "utf-8"
      );
    });

    it(
      "generates a plan from a freeform description, creating epic only (markdown and mockups, no tasks)",
      { timeout: 15000 },
      async () => {
        // Single call: generate plan (auto-review skipped when no tasks created)
        mockPlanningAgentInvoke.mockResolvedValueOnce({
          content: JSON.stringify({
            title: "Dark Mode Support",
            content:
              "# Dark Mode Support\n\n## Overview\n\nAdd dark/light theme toggle.\n\n## Acceptance Criteria\n\n- Toggle works",
            complexity: "medium",
            mockups: [{ title: "Toggle UI", content: "[Dark] [Light]" }],
          }),
        });

        const res = await request(app)
          .post(`${API_PREFIX}/projects/${projectId}/plans/generate`)
          .send({ description: "Add dark mode support with a toggle" });

        expect(res.status).toBe(201);
        expect(res.body.data).toBeDefined();
        expect(res.body.data.status).toBe("created");
        const plan = res.body.data.plan;
        expect(plan.metadata.planId).toBe("dark-mode-support");
        expect(plan.metadata.epicId).toBeDefined();
        expect(plan.metadata.complexity).toBe("medium");
        expect(plan.taskCount).toBe(0);
        expect(plan.content).toContain("Dark Mode Support");

        const _project = await projectService.getProject(projectId);
        const allIssues = await taskStore.listAll(projectId);
        const epicId = plan.metadata.epicId;
        const childTasks = allIssues.filter(
          (i: { id: string; issue_type?: string; type?: string }) =>
            i.id.startsWith(epicId + ".") && (i.issue_type ?? i.type) !== "epic"
        );
        expect(childTasks.length).toBe(0);

        // First invocation is the plan generation itself
        const invokeArgs = mockPlanningAgentInvoke.mock.calls[0][0];
        expect(invokeArgs.messages[0].content).toContain("Add dark mode support with a toggle");
        expect(invokeArgs.tracking.role).toBe("planner");
      }
    );

    it("returns 400 when description is empty", async () => {
      const res = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans/generate`)
        .send({ description: "" });

      expect(res.status).toBe(400);
      expect(res.body.error?.message).toContain("description is required");
      expect(mockPlanningAgentInvoke).not.toHaveBeenCalled();
    });

    it("returns 400 when description is missing", async () => {
      const res = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans/generate`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("VALIDATION_ERROR");
      expect(res.body.error?.message).toMatch(/description|string|required/i);
      expect(mockPlanningAgentInvoke).not.toHaveBeenCalled();
    });

    it("returns 400 when description is whitespace only", async () => {
      const res = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans/generate`)
        .send({ description: "   \n\t  " });

      expect(res.status).toBe(400);
      expect(res.body.error?.message).toContain("description is required");
      expect(mockPlanningAgentInvoke).not.toHaveBeenCalled();
    });

    it("returns 400 when agent returns invalid JSON", { timeout: 10000 }, async () => {
      mockPlanningAgentInvoke.mockResolvedValueOnce({
        content: "I cannot produce valid JSON for this request.",
      });

      const res = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans/generate`)
        .send({ description: "Build a chat feature" });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("DECOMPOSE_PARSE_FAILED");
    });

    it("generates plan even without tasks in agent response", { timeout: 15000 }, async () => {
      mockPlanningAgentInvoke.mockResolvedValueOnce({
        content: JSON.stringify({
          title: "Simple Feature",
          content: "# Simple Feature\n\n## Overview\n\nA simple feature.",
          complexity: "low",
          mockups: [{ title: "UI", content: "Simple UI" }],
        }),
      });

      const res = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans/generate`)
        .send({ description: "A simple feature with no tasks" });

      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe("created");
      expect(res.body.data.plan.taskCount).toBe(0);
      expect(res.body.data.plan.metadata.epicId).toBeDefined();
    });

    it(
      "accepts snake_case Planner output (plan_title, plan_content, mock_ups; task_list ignored)",
      {
        timeout: 15000,
      },
      async () => {
        mockPlanningAgentInvoke.mockResolvedValueOnce({
          content: JSON.stringify({
            plan_title: "Snake Case Feature",
            plan_content: "# Snake Case Feature\n\n## Overview\n\nSnake case plan.",
            complexity: "medium",
            mock_ups: [{ title: "Screen", content: "+---+\n| X |\n+---+" }],
            task_list: [
              {
                task_title: "Setup",
                task_description: "Setup step",
                task_priority: 0,
                depends_on: [],
              },
              {
                task_title: "Implement",
                task_description: "Implement step",
                task_priority: 1,
                depends_on: ["Setup"],
              },
            ],
          }),
        });

        const res = await request(app)
          .post(`${API_PREFIX}/projects/${projectId}/plans/generate`)
          .send({ description: "Feature with snake_case fields" });

        expect(res.status).toBe(201);
        expect(res.body.data.status).toBe("created");
        const plan = res.body.data.plan;
        expect(plan.metadata.planId).toBe("snake-case-feature");
        expect(plan.taskCount).toBe(0);
        expect(plan.metadata.mockups).toHaveLength(1);
        expect(plan.metadata.mockups[0].title).toBe("Screen");
        const allIssues = await taskStore.listAll(projectId);
        const epicId = plan.metadata.epicId;
        const childTasks = allIssues.filter(
          (i: { id: string; issue_type?: string; type?: string }) =>
            i.id.startsWith(epicId + ".") && (i.issue_type ?? i.type) !== "epic"
        );
        expect(childTasks.length).toBe(0);
      }
    );

    it("returns 202 with draft notification when planner asks open questions", async () => {
      mockPlanningAgentInvoke.mockResolvedValueOnce({
        content: JSON.stringify({
          open_questions: [{ id: "q1", text: "Which volunteer roles should this support?" }],
        }),
      });

      const res = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans/generate`)
        .send({ description: "Create a volunteer signup form" });

      expect(res.status).toBe(202);
      expect(res.body.data.status).toBe("needs_clarification");
      expect(res.body.data.resumeContext).toMatch(/^plan-draft:/);
      expect(res.body.data.notification.source).toBe("plan");
      expect(res.body.data.notification.sourceId).toMatch(/^draft:/);
      expect(res.body.data.notification.questions[0].text).toContain("volunteer roles");
      expect(mockBroadcastToProject).toHaveBeenCalledWith(
        projectId,
        expect.objectContaining({
          type: "notification.added",
          notification: expect.objectContaining({
            source: "plan",
            sourceId: expect.stringMatching(/^draft:/),
          }),
        })
      );
    });

    it("prefers clarification over plan creation when both open_questions and title are present", async () => {
      mockPlanningAgentInvoke.mockResolvedValueOnce({
        content: JSON.stringify({
          title: "Volunteer Signup Form",
          content: "# Volunteer Signup Form\n\n## Overview\n\nDraft content.",
          complexity: "medium",
          mockups: [{ title: "Form", content: "[form]" }],
          open_questions: [{ text: "Should availability be weekly or one-time?" }],
        }),
      });

      const res = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans/generate`)
        .send({ description: "Create a volunteer signup form" });

      expect(res.status).toBe(202);
      expect(res.body.data.status).toBe("needs_clarification");
      const allIssues = await taskStore.listAll(projectId);
      const matchingEpic = allIssues.find(
        (i: { title?: string; issue_type?: string; type?: string }) =>
          i.title === "Volunteer Signup Form" && (i.issue_type ?? i.type) === "epic"
      );
      expect(matchingEpic).toBeUndefined();
    });
  });

  describe("POST /projects/:id/plans/suggest", () => {
    beforeEach(async () => {
      mockPlanningAgentInvoke.mockClear();
      const project = await projectService.getProject(projectId);
      const prd = {
        version: 1,
        sections: {
          executive_summary: {
            content: "A todo app",
            version: 1,
            updatedAt: new Date().toISOString(),
          },
          problem_statement: { content: "", version: 0, updatedAt: new Date().toISOString() },
          user_personas: { content: "", version: 0, updatedAt: new Date().toISOString() },
          goals_and_metrics: { content: "", version: 0, updatedAt: new Date().toISOString() },
          assumptions_and_constraints: { content: "", version: 0, updatedAt: new Date().toISOString() },
          feature_list: { content: "", version: 0, updatedAt: new Date().toISOString() },
          technical_architecture: { content: "", version: 0, updatedAt: new Date().toISOString() },
          data_model: { content: "", version: 0, updatedAt: new Date().toISOString() },
          api_contracts: { content: "", version: 0, updatedAt: new Date().toISOString() },
          non_functional_requirements: {
            content: "",
            version: 0,
            updatedAt: new Date().toISOString(),
          },
          open_questions: { content: "", version: 0, updatedAt: new Date().toISOString() },
        },
        changeLog: [],
      };
      const { SPEC_MD, SPEC_METADATA_PATH, prdToSpecMarkdown } = await import("@opensprint/shared");
      await fs.writeFile(
        path.join(project.repoPath, SPEC_MD),
        prdToSpecMarkdown(prd as never),
        "utf-8"
      );
      await fs.mkdir(path.join(project.repoPath, path.dirname(SPEC_METADATA_PATH)), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(project.repoPath, SPEC_METADATA_PATH),
        JSON.stringify({ version: 1, changeLog: [] }, null, 2),
        "utf-8"
      );
    });

    it(
      "returns suggested plans from AI without creating plans or tasks",
      { timeout: 10000 },
      async () => {
        mockPlanningAgentInvoke.mockResolvedValueOnce({
          content: JSON.stringify({
            plans: [
              {
                title: "Task CRUD",
                content: "# Task CRUD\n\n## Overview\n\nCreate and manage tasks.",
                complexity: "medium",
                mockups: [{ title: "List", content: "Tasks" }],
                tasks: [
                  { title: "Create model", description: "Task schema", priority: 0, dependsOn: [] },
                  {
                    title: "Create API",
                    description: "REST",
                    priority: 1,
                    dependsOn: ["Create model"],
                  },
                ],
              },
            ],
          }),
        });

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

        const allIssues = await taskStore.listAll(projectId);
        const epics = allIssues.filter(
          (i: { issue_type?: string; type?: string }) => (i.issue_type ?? i.type) === "epic"
        );
        expect(epics).toHaveLength(0);
      }
    );

    it("returns 400 when agent returns invalid JSON", { timeout: 10000 }, async () => {
      mockPlanningAgentInvoke.mockResolvedValueOnce({
        content: "I cannot produce JSON.",
      });

      const res = await request(app).post(`${API_PREFIX}/projects/${projectId}/plans/suggest`);

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("DECOMPOSE_PARSE_FAILED");
    });
  });

  describe("GET /projects/:id/plans/:planId/cross-epic-dependencies", () => {
    it(
      "returns prerequisite plan IDs when plan depends on others still in planning",
      { timeout: 15000 },
      async () => {
        // Create plan A (user-auth) - prerequisite
        const planABody = {
          title: "User Auth",
          content: "# User Auth\n\n## Overview\n\nAuth.\n\n## Dependencies\n\nNone.",
          complexity: "low",
          tasks: [
            { title: "Auth task", description: "Implement auth", priority: 0, dependsOn: [] },
          ],
        };
        const createARes = await request(app)
          .post(`${API_PREFIX}/projects/${projectId}/plans`)
          .send(planABody);
        expect(createARes.status).toBe(201);
        const planAId = createARes.body.data.metadata.planId;
        expect(planAId).toBe("user-auth");

        // Create plan B (feature-x) that depends on user-auth via markdown
        const planBBody = {
          title: "Feature X",
          content: `# Feature X

## Overview

Feature that depends on auth.

## Dependencies

- user-auth
`,
          complexity: "medium",
          tasks: [
            { title: "Feature task", description: "Implement feature", priority: 0, dependsOn: [] },
          ],
        };
        const createBRes = await request(app)
          .post(`${API_PREFIX}/projects/${projectId}/plans`)
          .send(planBBody);
        expect(createBRes.status).toBe(201);
        const planBId = createBRes.body.data.metadata.planId;
        expect(planBId).toBe("feature-x");

        // Both plans in planning state (neither shipped)
        const depsRes = await request(app).get(
          `${API_PREFIX}/projects/${projectId}/plans/${planBId}/cross-epic-dependencies`
        );
        expect(depsRes.status).toBe(200);
        expect(depsRes.body.data.prerequisitePlanIds).toEqual(["user-auth"]);
      }
    );

    it("returns empty array when plan has no cross-epic dependencies", async () => {
      const planBody = {
        title: "Standalone Plan",
        content: "# Standalone\n\n## Dependencies\n\nNone.",
        complexity: "low",
      };
      const createRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send(planBody);
      expect(createRes.status).toBe(201);
      const planId = createRes.body.data.metadata.planId;

      const depsRes = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/plans/${planId}/cross-epic-dependencies`
      );
      expect(depsRes.status).toBe(200);
      expect(depsRes.body.data.prerequisitePlanIds).toEqual([]);
    });
  });

  describe("GET /projects/:id/plans/:planId/auditor-runs", () => {
    it("returns empty array when plan has no auditor runs", async () => {
      const planBody = {
        title: "Auditor Runs Test Plan",
        content: "# Auditor Runs Test\n\n## Dependencies\n\nNone.",
        complexity: "low",
      };
      const createRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send(planBody);
      expect(createRes.status).toBe(201);
      const planId = createRes.body.data.metadata.planId;

      const runsRes = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/plans/${planId}/auditor-runs`
      );
      expect(runsRes.status).toBe(200);
      expect(runsRes.body.data).toEqual([]);
    });

    it("returns auditor runs for plan when runs exist", async () => {
      const planBody = {
        title: "Plan With Auditor Runs",
        content: "# Plan With Auditor Runs\n\n## Dependencies\n\nNone.",
        complexity: "low",
      };
      const createRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send(planBody);
      expect(createRes.status).toBe(201);
      const planId = createRes.body.data.metadata.planId;
      const epicId = createRes.body.data.metadata.epicId;

      const inserted = await taskStore.auditorRunInsert({
        projectId,
        planId,
        epicId,
        startedAt: "2025-01-01T00:00:00.000Z",
        completedAt: "2025-01-01T00:01:00.000Z",
        status: "pass",
        assessment: "Implementation meets plan scope.",
      });

      const runsRes = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/plans/${planId}/auditor-runs`
      );
      expect(runsRes.status).toBe(200);
      expect(runsRes.body.data).toHaveLength(1);
      expect(runsRes.body.data[0]).toMatchObject({
        id: inserted.id,
        projectId,
        planId,
        epicId,
        status: "pass",
        assessment: "Implementation meets plan scope.",
      });
    });
  });

  describe("GET /projects/:id/plans/:planId/versions", () => {
    it("list versions after create, execute, and update: execute creates v1; updates add v2,v3", async () => {
      const planBody = {
        title: "List After Execute Plan",
        content: "# List After Execute\n\n## Overview\n\nInitial.",
        complexity: "low",
        tasks: [
          { title: "Task A", description: "First", priority: 0, dependsOn: [] },
          { title: "Task B", description: "Second", priority: 1, dependsOn: [] },
        ],
      };
      const createRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send(planBody);
      expect(createRes.status).toBe(201);
      const planId = createRes.body.data.metadata.planId;

      const listAfterCreate = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/plans/${planId}/versions`
      );
      expect(listAfterCreate.status).toBe(200);
      expect(listAfterCreate.body.data.versions).toHaveLength(1);

      const executeRes = await request(app).post(
        `${API_PREFIX}/projects/${projectId}/plans/${planId}/execute`
      );
      expect(executeRes.status).toBe(200);

      const listAfterExecute = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/plans/${planId}/versions`
      );
      expect(listAfterExecute.status).toBe(200);
      expect(listAfterExecute.body.data.versions).toHaveLength(1);
      expect(listAfterExecute.body.data.versions[0].version_number).toBe(1);
      expect(listAfterExecute.body.data.versions[0].is_executed_version).toBe(true);

      await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/plans/${planId}`)
        .send({ content: "# List After Execute\n\n## Overview\n\nFirst update." });
      await request(app)
        .put(`${API_PREFIX}/projects/${projectId}/plans/${planId}`)
        .send({ content: "# List After Execute\n\n## Overview\n\nSecond update." });

      const listAfterUpdates = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/plans/${planId}/versions`
      );
      expect(listAfterUpdates.status).toBe(200);
      // Version-aware: execute created v1; first update creates v2; second update edits v2 in place (v2 has no tasks).
      expect(listAfterUpdates.body.data.versions).toHaveLength(2);
      const executed = listAfterUpdates.body.data.versions.find(
        (v: { is_executed_version: boolean }) => v.is_executed_version
      );
      expect(executed).toBeDefined();
      expect(executed.version_number).toBe(1);
    });

    it("creates version 1 from current content when plan has no versions (first load)", async () => {
      const planBody = {
        title: "Versions List Test",
        content: "# Versions List Test\n\n## Overview\n\nContent.",
        complexity: "low",
      };
      const createRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send(planBody);
      expect(createRes.status).toBe(201);
      const planId = createRes.body.data.metadata.planId;

      const listRes = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/plans/${planId}/versions`
      );
      expect(listRes.status).toBe(200);
      expect(listRes.body.data.versions).toHaveLength(1);
      expect(listRes.body.data.versions[0].version_number).toBe(1);
      expect(listRes.body.data.versions[0].is_executed_version).toBe(false);
    });

    it("returns 200 with versions newest first when versions exist", async () => {
      const planBody = {
        title: "Versions Order Test",
        content: "# Versions Order Test\n\n## Overview\n\nContent.",
        complexity: "low",
      };
      const createRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send(planBody);
      expect(createRes.status).toBe(201);
      const planId = createRes.body.data.metadata.planId;

      await taskStore.planVersionInsert({
        project_id: projectId,
        plan_id: planId,
        version_number: 1,
        title: "V1",
        content: "# V1\n\nContent.",
        metadata: JSON.stringify({}),
        is_executed_version: false,
      });
      await taskStore.planVersionInsert({
        project_id: projectId,
        plan_id: planId,
        version_number: 2,
        title: "V2",
        content: "# V2\n\nContent.",
        metadata: JSON.stringify({}),
        is_executed_version: true,
      });

      const listRes = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/plans/${planId}/versions`
      );
      expect(listRes.status).toBe(200);
      expect(listRes.body.data.versions).toHaveLength(2);
      expect(listRes.body.data.versions[0].version_number).toBe(2);
      expect(listRes.body.data.versions[0].is_executed_version).toBe(true);
      expect(listRes.body.data.versions[1].version_number).toBe(1);
      expect(listRes.body.data.versions[1].is_executed_version).toBe(false);
      expect(listRes.body.data.versions[0]).toMatchObject({
        id: expect.any(Number),
        version_number: 2,
        created_at: expect.any(String),
        is_executed_version: true,
      });
    });

    it("returns 404 when plan does not exist", async () => {
      const listRes = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/plans/nonexistent-plan-xyz/versions`
      );
      expect(listRes.status).toBe(404);
      expect(listRes.body.error?.code).toBe("PLAN_NOT_FOUND");
    });
  });

  describe("GET /projects/:id/plans/:planId/versions/:versionNumber", () => {
    it("returns 200 with version content (title, content, metadata) when version exists", async () => {
      const planBody = {
        title: "Get Version Test",
        content: "# Get Version Test\n\n## Overview\n\nContent.",
        complexity: "low",
      };
      const createRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send(planBody);
      expect(createRes.status).toBe(201);
      const planId = createRes.body.data.metadata.planId;

      await taskStore.planVersionInsert({
        project_id: projectId,
        plan_id: planId,
        version_number: 1,
        title: "My Title",
        content: "# My Title\n\nBody content.",
        metadata: JSON.stringify({ key: "value" }),
        is_executed_version: true,
      });

      const getRes = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/plans/${planId}/versions/1`
      );
      expect(getRes.status).toBe(200);
      expect(getRes.body.data).toMatchObject({
        version_number: 1,
        title: "My Title",
        content: "# My Title\n\nBody content.",
        created_at: expect.any(String),
        is_executed_version: true,
      });
      expect(getRes.body.data.metadata).toEqual({ key: "value" });
    });

    it("returns 404 when version does not exist", async () => {
      const planBody = {
        title: "Missing Version Test",
        content: "# Missing Version\n\nContent.",
        complexity: "low",
      };
      const createRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send(planBody);
      expect(createRes.status).toBe(201);
      const planId = createRes.body.data.metadata.planId;

      const getRes = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/plans/${planId}/versions/999`
      );
      expect(getRes.status).toBe(404);
      expect(getRes.body.error?.code).toBe("PLAN_VERSION_NOT_FOUND");
    });

    it("returns 404 when plan does not exist", async () => {
      const getRes = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/plans/nonexistent-plan-xyz/versions/1`
      );
      expect(getRes.status).toBe(404);
      expect(getRes.body.error?.code).toBe("PLAN_NOT_FOUND");
    });

    it("returns 404 for invalid version number (e.g. 0 or non-numeric)", async () => {
      const planBody = {
        title: "Invalid Version Test",
        content: "# Invalid Version\n\nContent.",
        complexity: "low",
      };
      const createRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send(planBody);
      expect(createRes.status).toBe(201);
      const planId = createRes.body.data.metadata.planId;

      const res0 = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/plans/${planId}/versions/0`
      );
      expect(res0.status).toBe(404);
      expect(res0.body.error?.code).toBe("PLAN_VERSION_NOT_FOUND");

      const resAbc = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/plans/${planId}/versions/abc`
      );
      expect(resAbc.status).toBe(404);
      expect(resAbc.body.error?.code).toBe("PLAN_VERSION_NOT_FOUND");
    });
  });

  describe("POST /projects/:id/plans/:planId/execute with prerequisitePlanIds", () => {
    it("executes prerequisites first then requested plan", { timeout: 20000 }, async () => {
      // Create plan A (user-auth)
      const planABody = {
        title: "User Auth",
        content: "# User Auth\n\n## Dependencies\n\nNone.",
        complexity: "low",
        tasks: [{ title: "Auth task", description: "Auth", priority: 0, dependsOn: [] }],
      };
      const createARes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send(planABody);
      expect(createARes.status).toBe(201);
      const planAId = createARes.body.data.metadata.planId;

      // Create plan B that depends on user-auth
      const planBBody = {
        title: "Feature X",
        content: "# Feature X\n\n## Dependencies\n\n- user-auth",
        complexity: "medium",
        tasks: [{ title: "Feature task", description: "Feature", priority: 0, dependsOn: [] }],
      };
      const createBRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send(planBBody);
      expect(createBRes.status).toBe(201);
      const planBId = createBRes.body.data.metadata.planId;

      // Execute B with A as prerequisite
      const executeRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans/${planBId}/execute`)
        .send({ prerequisitePlanIds: [planAId] });
      expect(executeRes.status).toBe(200);

      const planARow = await taskStore.planGet(projectId, planAId);
      const planBRow = await taskStore.planGet(projectId, planBId);
      expect(planARow?.metadata.shippedAt).toBeTruthy();
      expect(planBRow?.metadata.shippedAt).toBeTruthy();
    });
  });

  describe("POST /projects/:id/plans/:planId/execute first execution", () => {
    it("creates version 1 and sets last_executed when plan has no versions", async () => {
      const planBody = {
        title: "First Execute Plan",
        content: "# First Execute\n\n## Overview\n\nContent.",
        complexity: "low",
        tasks: [{ title: "Task A", description: "First", priority: 0, dependsOn: [] }],
      };
      const createRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send(planBody);
      expect(createRes.status).toBe(201);
      const planId = createRes.body.data.metadata.planId;

      const versionsBefore = await taskStore.listPlanVersions(projectId, planId);
      expect(versionsBefore).toHaveLength(0);

      const executeRes = await request(app).post(
        `${API_PREFIX}/projects/${projectId}/plans/${planId}/execute`
      );
      expect(executeRes.status).toBe(200);

      const planRow = await taskStore.planGet(projectId, planId);
      expect(planRow?.last_executed_version_number).toBe(1);

      const versionsAfter = await taskStore.listPlanVersions(projectId, planId);
      expect(versionsAfter).toHaveLength(1);
      expect(versionsAfter[0].version_number).toBe(1);
      expect(versionsAfter[0].is_executed_version).toBe(true);
    });
  });

  describe("POST /projects/:id/plans/:planId/execute with version_number", () => {
    it("executes specified version: sets last_executed and ships that version content", async () => {
      const planBody = {
        title: "Version Execute Plan",
        content: "# Version Execute\n\n## Overview\n\nInitial (v1).",
        complexity: "low",
        tasks: [
          { title: "Task A", description: "First", priority: 0, dependsOn: [] },
          { title: "Task B", description: "Second", priority: 1, dependsOn: [] },
        ],
      };
      const createRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send(planBody);
      expect(createRes.status).toBe(201);
      const planId = createRes.body.data.metadata.planId;

      // Ensure v1 exists in plan_versions (list versions triggers ensurePlanHasAtLeastOneVersion).
      const listRes = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/plans/${planId}/versions`
      );
      expect(listRes.status).toBe(200);
      expect(listRes.body.data.versions).toHaveLength(1);

      const executeRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans/${planId}/execute`)
        .send({ version_number: 1 });
      expect(executeRes.status).toBe(200);

      const planRow = await taskStore.planGet(projectId, planId);
      expect(planRow?.last_executed_version_number).toBe(1);
      const shipped = await taskStore.planGetShippedContent(projectId, planId);
      expect(shipped).toContain("Initial (v1)");
    });

    it("returns 404 when version_number does not exist", async () => {
      const planBody = {
        title: "No Version Plan",
        content: "# No Version\n\nContent.",
        complexity: "low",
        tasks: [{ title: "Task A", description: "First", priority: 0, dependsOn: [] }],
      };
      const createRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send(planBody);
      expect(createRes.status).toBe(201);
      const planId = createRes.body.data.metadata.planId;

      const executeRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans/${planId}/execute`)
        .send({ version_number: 99 });
      expect(executeRes.status).toBe(404);
      expect(executeRes.body.error?.code).toBe("PLAN_VERSION_NOT_FOUND");
    });
  });

  describe("POST /projects/:id/plans/:planId/mark-complete", () => {
    it(
      "integration: create plan, Execute!, close all tasks, plan is in_review then mark-complete yields complete",
      { timeout: 15000 },
      async () => {
        const planBody = {
          title: "In Review Flow Plan",
          content: "# In Review Flow\n\nContent.",
          complexity: "medium",
          tasks: [
            { title: "Task One", description: "First", priority: 0, dependsOn: [] },
            { title: "Task Two", description: "Second", priority: 1, dependsOn: [] },
          ],
        };

        const createRes = await request(app)
          .post(`${API_PREFIX}/projects/${projectId}/plans`)
          .send(planBody);
        expect(createRes.status).toBe(201);
        const planId = createRes.body.data.metadata.planId;
        const epicId = createRes.body.data.metadata.epicId;

        const shipRes = await request(app).post(
          `${API_PREFIX}/projects/${projectId}/plans/${planId}/execute`
        );
        expect(shipRes.status).toBe(200);

        const _project = await projectService.getProject(projectId);
        const allIssues = await taskStore.listAll(projectId);
        const planTasks = allIssues.filter(
          (i: { id: string; issue_type?: string; type?: string }) =>
            i.id.startsWith(epicId + ".") && (i.issue_type ?? i.type) !== "epic"
        );
        for (const task of planTasks) {
          await taskStore.close(projectId, (task as { id: string }).id, "Done");
        }

        // Plan must be in_review (all tasks closed, not yet marked complete)
        const getBeforeRes = await request(app).get(
          `${API_PREFIX}/projects/${projectId}/plans/${planId}`
        );
        expect(getBeforeRes.status).toBe(200);
        expect(getBeforeRes.body.data).toBeDefined();
        expect(getBeforeRes.body.data.status).toBe("in_review");
        expect(getBeforeRes.body.data.metadata.reviewedAt).toBeFalsy();

        // List plans: plan appears with in_review (Evaluate Pending)
        const listBeforeRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/plans`);
        expect(listBeforeRes.status).toBe(200);
        const planInListBefore = listBeforeRes.body.data?.plans?.find(
          (p: { metadata?: { planId?: string } }) => p.metadata?.planId === planId
        );
        expect(planInListBefore).toBeDefined();
        expect(planInListBefore.status).toBe("in_review");

        const markRes = await request(app).post(
          `${API_PREFIX}/projects/${projectId}/plans/${planId}/mark-complete`
        );
        expect(markRes.status).toBe(200);
        expect(markRes.body.data.status).toBe("complete");
        expect(markRes.body.data.metadata.reviewedAt).toBeDefined();

        // Plan must be complete after mark-complete
        const getAfterRes = await request(app).get(
          `${API_PREFIX}/projects/${projectId}/plans/${planId}`
        );
        expect(getAfterRes.status).toBe(200);
        expect(getAfterRes.body.data.status).toBe("complete");

        // List plans: plan appears complete (Evaluate Resolved/Done)
        const listAfterRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/plans`);
        expect(listAfterRes.status).toBe(200);
        const planInListAfter = listAfterRes.body.data?.plans?.find(
          (p: { metadata?: { planId?: string } }) => p.metadata?.planId === planId
        );
        expect(planInListAfter).toBeDefined();
        expect(planInListAfter.status).toBe("complete");
      }
    );

    it(
      "returns 200 and plan status complete when all epic tasks are closed",
      { timeout: 15000 },
      async () => {
        const planBody = {
          title: "Mark Complete Feature",
          content: "# Mark Complete\n\nContent.",
          complexity: "medium",
          tasks: [
            { title: "Task A", description: "First", priority: 0, dependsOn: [] },
            { title: "Task B", description: "Second", priority: 1, dependsOn: [] },
          ],
        };

        const createRes = await request(app)
          .post(`${API_PREFIX}/projects/${projectId}/plans`)
          .send(planBody);
        expect(createRes.status).toBe(201);
        const planId = createRes.body.data.metadata.planId;
        const epicId = createRes.body.data.metadata.epicId;

        const shipRes = await request(app).post(
          `${API_PREFIX}/projects/${projectId}/plans/${planId}/execute`
        );
        expect(shipRes.status).toBe(200);

        const _project = await projectService.getProject(projectId);
        const allIssues = await taskStore.listAll(projectId);
        const planTasks = allIssues.filter(
          (i: { id: string; issue_type?: string; type?: string }) =>
            i.id.startsWith(epicId + ".") && (i.issue_type ?? i.type) !== "epic"
        );
        for (const task of planTasks) {
          await taskStore.close(projectId, (task as { id: string }).id, "Done");
        }

        const markRes = await request(app).post(
          `${API_PREFIX}/projects/${projectId}/plans/${planId}/mark-complete`
        );
        expect(markRes.status).toBe(200);
        expect(markRes.body.data).toBeDefined();
        expect(markRes.body.data.status).toBe("complete");
        expect(markRes.body.data.metadata.reviewedAt).toBeDefined();
        expect(typeof markRes.body.data.metadata.reviewedAt).toBe("string");
        expect(mockBroadcastToProject).toHaveBeenCalledWith(projectId, {
          type: "plan.updated",
          planId,
        });
      }
    );

    it("returns 200 idempotent when reviewedAt already set", { timeout: 15000 }, async () => {
      const planBody = {
        title: "Idempotent Mark Complete",
        content: "# Idempotent\n\nContent.",
        complexity: "low",
        tasks: [{ title: "Only task", description: "Only", priority: 0, dependsOn: [] }],
      };

      const createRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send(planBody);
      expect(createRes.status).toBe(201);
      const planId = createRes.body.data.metadata.planId;
      const epicId = createRes.body.data.metadata.epicId;

      await request(app).post(`${API_PREFIX}/projects/${projectId}/plans/${planId}/execute`);
      const allIssues = await taskStore.listAll(projectId);
      const planTasks = allIssues.filter(
        (i: { id: string; issue_type?: string; type?: string }) =>
          i.id.startsWith(epicId + ".") && (i.issue_type ?? i.type) !== "epic"
      );
      for (const task of planTasks) {
        await taskStore.close(projectId, (task as { id: string }).id, "Done");
      }

      const first = await request(app).post(
        `${API_PREFIX}/projects/${projectId}/plans/${planId}/mark-complete`
      );
      expect(first.status).toBe(200);
      const reviewedAt = first.body.data.metadata.reviewedAt;
      expect(reviewedAt).toBeDefined();

      const second = await request(app).post(
        `${API_PREFIX}/projects/${projectId}/plans/${planId}/mark-complete`
      );
      expect(second.status).toBe(200);
      expect(second.body.data.metadata.reviewedAt).toBe(reviewedAt);
      expect(second.body.data.status).toBe("complete");
    });

    it("returns 400 when not all epic tasks are closed", { timeout: 15000 }, async () => {
      const planBody = {
        title: "Open Tasks Feature",
        content: "# Open Tasks\n\nContent.",
        complexity: "medium",
        tasks: [
          { title: "Task X", description: "First", priority: 0, dependsOn: [] },
          { title: "Task Y", description: "Second", priority: 1, dependsOn: [] },
        ],
      };

      const createRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send(planBody);
      expect(createRes.status).toBe(201);
      const planId = createRes.body.data.metadata.planId;
      const epicId = createRes.body.data.metadata.epicId;

      await request(app).post(`${API_PREFIX}/projects/${projectId}/plans/${planId}/execute`);
      const allIssues = await taskStore.listAll(projectId);
      const planTasks = allIssues.filter(
        (i: { id: string; issue_type?: string; type?: string }) =>
          i.id.startsWith(epicId + ".") && (i.issue_type ?? i.type) !== "epic"
      );
      await taskStore.close(projectId, (planTasks[0] as { id: string }).id, "Done");
      // Leave planTasks[1] open

      const markRes = await request(app).post(
        `${API_PREFIX}/projects/${projectId}/plans/${planId}/mark-complete`
      );
      expect(markRes.status).toBe(400);
      expect(markRes.body.error?.message).toBe("Plan has open tasks; cannot mark complete");
      expect(markRes.body.error?.code).toBe("INVALID_INPUT");
    });

    it("returns 404 when plan not found", async () => {
      const markRes = await request(app).post(
        `${API_PREFIX}/projects/${projectId}/plans/nonexistent-plan-id-xyz/mark-complete`
      );
      expect(markRes.status).toBe(404);
      expect(markRes.body.error?.code).toBe("PLAN_NOT_FOUND");
    });
  });

  it("POST /projects/:id/plans/:planId/archive returns 400 when plan has no epic", async () => {
    const planBody = {
      title: "No Epic Plan",
      content: "# No Epic\n\nManually created without epic.",
      complexity: "low",
    };
    const createRes = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/plans`)
      .send(planBody);
    expect(createRes.status).toBe(201);
    const planId = createRes.body.data.metadata.planId;

    const row = await taskStore.planGet(projectId, planId);
    expect(row).not.toBeNull();
    await taskStore.planUpdateMetadata(projectId, planId, { ...row!.metadata, epicId: "" });

    const archiveRes = await request(app).post(
      `${API_PREFIX}/projects/${projectId}/plans/${planId}/archive`
    );
    expect(archiveRes.status).toBe(400);
    expect(archiveRes.body.error?.code).toBe("NO_EPIC");
  });
});
