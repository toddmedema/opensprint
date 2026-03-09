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
  let tempDir: string;
  let originalHome: string | undefined;
  let projectId: string;
  let projectService: ProjectService;
  let taskStore: TaskStoreService;

  afterAll(async () => {
    const mod = (await import("../services/task-store.service.js")) as { _testPool?: { end: () => Promise<void> } };
    if (mod._testPool) await mod._testPool.end();
  });

  beforeEach(async () => {
    const mod = (await import("../services/task-store.service.js")) as unknown as {
      _resetSharedDb?: () => void | Promise<void>;
    };
    await mod._resetSharedDb?.();

    const { wireTaskStoreEvents } = await import("../task-store-events.js");
    wireTaskStoreEvents(mockBroadcastToProject);

    app = createApp();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-plan-route-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    projectService = new ProjectService();
    taskStore = new TaskStoreService();
    await taskStore.init();
    const repoPath = path.join(tempDir, "test-project");
    const project = await projectService.createProject({
      name: "Plan Test Project",
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
    // maxRetries/retryDelay help when git-commit-queue or task store hold files during cleanup
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
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
  });

  it("PUT /projects/:id/plans/:planId updates plan title and markdown content", async () => {
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
    const _repoPath = path.join(tempDir, "test-project");

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
  });

  it("POST /projects/:id/plans/:planId/plan-tasks invokes Planner and creates tasks", async () => {
    mockBroadcastToProject.mockClear();
    mockPlanningAgentInvoke.mockClear();
    const app = createApp();
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
    const app = createApp();
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
      expect(res.body.error?.message).toContain("description is required");
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
              { task_title: "Setup", task_description: "Setup step", task_priority: 0, depends_on: [] },
              { task_title: "Implement", task_description: "Implement step", task_priority: 1, depends_on: ["Setup"] },
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

  describe("POST /projects/:id/plans/:planId/mark-complete", () => {
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

    it(
      "returns 200 idempotent when reviewedAt already set",
      { timeout: 15000 },
      async () => {
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

        await request(app).post(
          `${API_PREFIX}/projects/${projectId}/plans/${planId}/execute`
        );
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
      }
    );

    it(
      "returns 400 when not all epic tasks are closed",
      { timeout: 15000 },
      async () => {
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

        await request(app).post(
          `${API_PREFIX}/projects/${projectId}/plans/${planId}/execute`
        );
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
      }
    );

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
