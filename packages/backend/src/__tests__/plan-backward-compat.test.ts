/**
 * Backward compatibility: single-plan (no sub-plans) behavior must stay stable
 * after plan hierarchy / complexity-gate changes.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { authedSupertest } from "./local-auth-test-helpers.js";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createApp } from "../app.js";
import { ProjectService } from "../services/project.service.js";
import { TaskStoreService } from "../services/task-store.service.js";
import { API_PREFIX, DEFAULT_HIL_CONFIG } from "@opensprint/shared";
import { cleanupTestProject } from "./test-project-cleanup.js";
import {
  pinOpenSprintPathsForTesting,
  resetOpenSprintPathsForTesting,
} from "./opensprint-path-test-helper.js";

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

const compatTaskStoreMod = await import("../services/task-store.service.js");
const compatPostgresOk =
  (compatTaskStoreMod as { _postgresAvailable?: boolean })._postgresAvailable ?? false;

function stubPlanTasksPlannerChain(taskGenPayload: unknown) {
  const taskGenContent =
    typeof taskGenPayload === "string" ? taskGenPayload : JSON.stringify(taskGenPayload);
  mockPlanningAgentInvoke.mockImplementation((opts: { tracking?: { label?: string } }) => {
    const label = opts.tracking?.label ?? "";
    if (label === "Complexity gate evaluation") {
      return Promise.resolve({ content: taskGenContent });
    }
    if (label === "Task generation") {
      return Promise.resolve({ content: taskGenContent });
    }
    return Promise.resolve({ content: JSON.stringify({ complexity: "medium" }) });
  });
}

describe.skipIf(!compatPostgresOk)("Plan backward compatibility (flat / single-plan)", () => {
  let app: ReturnType<typeof createApp>;
  let suiteTempDir: string;
  let currentRepoPath: string | undefined;
  let caseCounter = 0;
  let projectId: string;
  let projectService: ProjectService;
  let taskStore: TaskStoreService;

  beforeAll(async () => {
    app = createApp();
    suiteTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-plan-compat-suite-"));
    pinOpenSprintPathsForTesting(suiteTempDir);

    projectService = new ProjectService();
    taskStore = new TaskStoreService();
    await taskStore.init();
  });

  beforeEach(async () => {
    mockPlanningAgentInvoke.mockReset();
    mockSuggestInvoke.mockReset();
    mockBroadcastToProject.mockClear();

    const mod = (await import("../services/task-store.service.js")) as unknown as {
      _resetSharedDb?: () => void | Promise<void>;
    };
    await mod._resetSharedDb?.();
    currentRepoPath = path.join(suiteTempDir, `test-project-${++caseCounter}`);

    const { wireTaskStoreEvents } = await import("../task-store-events.js");
    wireTaskStoreEvents(mockBroadcastToProject);

    const project = await projectService.createProject({
      name: "Plan Compat Project",
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
    projectService.clearListCacheForTesting();
    if (!currentRepoPath) return;
    await fs.rm(currentRepoPath, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  });

  afterAll(async () => {
    resetOpenSprintPathsForTesting();
    await fs.rm(suiteTempDir, { recursive: true, force: true });
    const mod = (await import("../services/task-store.service.js")) as {
      _testPool?: { end: () => Promise<void> };
    };
    if (mod._testPool) await mod._testPool.end();
  });

  it("flat root plan has depth 1, empty children, and no parent in list + detail responses", async () => {
    const createRes = await authedSupertest(app)
      .post(`${API_PREFIX}/projects/${projectId}/plans`)
      .send({ title: "Single Root Feature", content: "# Root\n\nBody.", complexity: "low" });
    expect(createRes.status).toBe(201);
    const planId = createRes.body.data.metadata.planId as string;

    expect(createRes.body.data.depth).toBe(1);
    expect(createRes.body.data.parentPlanId).toBeNull();
    expect(createRes.body.data.childPlanIds ?? []).toEqual([]);

    const listRes = await authedSupertest(app).get(`${API_PREFIX}/projects/${projectId}/plans`);
    expect(listRes.status).toBe(200);
    const p = listRes.body.data.plans.find(
      (x: { metadata: { planId: string } }) => x.metadata.planId === planId
    );
    expect(p).toBeDefined();
    expect(p.depth).toBe(1);
    expect(p.parentPlanId).toBeNull();
    expect(p.childPlanIds ?? []).toEqual([]);
    expect(p.metadata.parentPlanId).toBeUndefined();

    const detailRes = await authedSupertest(app).get(
      `${API_PREFIX}/projects/${projectId}/plans/${planId}`
    );
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.data.depth).toBe(1);
    expect(detailRes.body.data.parentPlanId).toBeNull();
    expect(detailRes.body.data.childPlanIds ?? []).toEqual([]);
  });

  it("plan-tasks on a simple plan keeps a single plan row and attaches tasks to its epic (tasks strategy only)", async () => {
    mockPlanningAgentInvoke.mockClear();
    const createRes = await authedSupertest(app)
      .post(`${API_PREFIX}/projects/${projectId}/plans`)
      .send({
        title: "Compat Plan Tasks",
        content: "# Compat\n\n## Overview\n\nOne epic flow.\n\n## Acceptance Criteria\n\n- Works",
        complexity: "medium",
      });
    expect(createRes.status).toBe(201);
    const planId = createRes.body.data.metadata.planId as string;
    const epicId = createRes.body.data.metadata.epicId as string;

    stubPlanTasksPlannerChain({
      tasks: [
        { title: "Task One", description: "First", priority: 0, dependsOn: [] },
        { title: "Task Two", description: "Second", priority: 1, dependsOn: [] },
      ],
    });

    const planTasksRes = await authedSupertest(app).post(
      `${API_PREFIX}/projects/${projectId}/plans/${planId}/plan-tasks`
    );
    expect(planTasksRes.status).toBe(200);
    expect(planTasksRes.body.data.taskCount).toBe(2);

    const listRes = await authedSupertest(app).get(`${API_PREFIX}/projects/${projectId}/plans`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.plans).toHaveLength(1);

    const allIssues = await taskStore.listAll(projectId);
    const childTasks = allIssues.filter(
      (i: { id: string; issue_type?: string; type?: string }) =>
        i.id.startsWith(epicId + ".") && (i.issue_type ?? i.type) !== "epic"
    );
    expect(childTasks).toHaveLength(2);

    const labels = mockPlanningAgentInvoke.mock.calls.map(
      (c) => (c[0] as { tracking?: { label?: string } }).tracking?.label ?? ""
    );
    expect(labels.filter((l) => l === "Complexity gate evaluation").length).toBeGreaterThanOrEqual(
      1
    );
    expect(labels.filter((l) => l === "Task generation").length).toBe(0);
    expect(labels.some((l) => l === "Feature decomposition")).toBe(false);
  });

  it("POST /plans/decompose still creates flat sibling plans without parentPlanId", async () => {
    const project = await projectService.getProject(projectId);
    const repoPath = project.repoPath;
    const prd = {
      version: 1,
      sections: {
        executive_summary: {
          content: "Compat decompose",
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
    const { SPEC_MD, prdToSpecMarkdown } = await import("@opensprint/shared");
    await fs.writeFile(path.join(repoPath, SPEC_MD), prdToSpecMarkdown(prd as never), "utf-8");

    mockPlanningAgentInvoke.mockResolvedValue({
      content: JSON.stringify({
        plans: [
          {
            title: "Stream North",
            content: "# Stream North\n\n## Overview\n\nNorth work.\n\n## Dependencies\n\n",
            complexity: "low",
            dependsOnPlans: [],
            mockups: [],
          },
          {
            title: "Stream South",
            content:
              "# Stream South\n\n## Overview\n\nSouth work.\n\n## Dependencies\n\nDepends on stream-north.",
            complexity: "low",
            dependsOnPlans: ["stream-north"],
            mockups: [],
          },
        ],
      }),
    });

    const decomposeRes = await authedSupertest(app).post(
      `${API_PREFIX}/projects/${projectId}/plans/decompose`
    );
    expect(decomposeRes.status).toBe(201);
    expect(decomposeRes.body.data.created).toBe(2);

    const listRes = await authedSupertest(app).get(`${API_PREFIX}/projects/${projectId}/plans`);
    expect(listRes.status).toBe(200);
    const plans = listRes.body.data.plans as Array<{
      metadata: { planId: string; parentPlanId?: string };
      depth: number;
      parentPlanId: string | null;
      childPlanIds?: string[];
    }>;
    expect(plans).toHaveLength(2);
    for (const pl of plans) {
      expect(pl.depth).toBe(1);
      expect(pl.parentPlanId).toBeNull();
      expect(pl.metadata.parentPlanId).toBeUndefined();
      expect(pl.childPlanIds ?? []).toEqual([]);
    }

    const edgeTo = listRes.body.data.edges.filter(
      (e: { to: string; type: string }) => e.type === "blocks"
    );
    const south = plans.find((p) => p.metadata.planId === "stream-south");
    expect(south).toBeDefined();
    expect(edgeTo.some((e: { to: string }) => e.to === south!.metadata.planId)).toBe(true);
  });

  it("dependency graph lists cross-plan edges for two flat plans", async () => {
    await authedSupertest(app).post(`${API_PREFIX}/projects/${projectId}/plans`).send({
      title: "Consumer Flat",
      content: "# Consumer\n\n## Dependencies\n\nDepends on provider-flat.",
      complexity: "low",
    });
    await authedSupertest(app).post(`${API_PREFIX}/projects/${projectId}/plans`).send({
      title: "Provider Flat",
      content: "# Provider\n\nStandalone.",
      complexity: "low",
    });

    const listRes = await authedSupertest(app).get(`${API_PREFIX}/projects/${projectId}/plans`);
    expect(listRes.status).toBe(200);
    const edges = listRes.body.data.edges as Array<{ from: string; to: string; type: string }>;
    const blocks = edges.filter((e) => e.type === "blocks");
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(blocks.some((e) => e.from === "provider-flat" && e.to === "consumer-flat")).toBe(true);
  });

  it("execute-batch completes for two flat plans that already have tasks", async () => {
    const body = (title: string) => ({
      title,
      content: `# ${title}\n\nContent.`,
      complexity: "low",
      tasks: [{ title: "Only task", description: "Work", priority: 0, dependsOn: [] }],
    });

    const aRes = await authedSupertest(app)
      .post(`${API_PREFIX}/projects/${projectId}/plans`)
      .send(body("Batch Alpha"));
    const bRes = await authedSupertest(app)
      .post(`${API_PREFIX}/projects/${projectId}/plans`)
      .send(body("Batch Beta"));
    expect(aRes.status).toBe(201);
    expect(bRes.status).toBe(201);
    const idA = aRes.body.data.metadata.planId as string;
    const idB = bRes.body.data.metadata.planId as string;

    const batchRes = await authedSupertest(app)
      .post(`${API_PREFIX}/projects/${projectId}/plans/execute-batch`)
      .send({ items: [{ planId: idA }, { planId: idB }] });
    expect(batchRes.status).toBe(202);
    const batchId = batchRes.body.data.batchId as string;

    let status = "running";
    for (let i = 0; i < 80; i++) {
      const poll = await authedSupertest(app).get(
        `${API_PREFIX}/projects/${projectId}/plans/execute-batch/${batchId}`
      );
      expect(poll.status).toBe(200);
      status = poll.body.data.status as string;
      if (status === "completed" || status === "failed") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(status).toBe("completed");
  }, 20_000);
});
