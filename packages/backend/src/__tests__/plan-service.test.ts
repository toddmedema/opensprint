import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { PlanService } from "../services/plan.service.js";
import { ProjectService } from "../services/project.service.js";
import { DEFAULT_HIL_CONFIG } from "@opensprint/shared";

const mockTaskStoreCreate = vi.fn();
const mockTaskStoreCreateWithRetry = vi.fn();
const mockTaskStoreCreateMany = vi.fn();
const mockTaskStoreUpdate = vi.fn();
const mockTaskStoreAddDependency = vi.fn();
const mockTaskStoreAddDependencies = vi.fn();
const mockTaskStoreAddLabel = vi.fn();
const mockTaskStoreListAll = vi.fn();
const mockTaskStoreShow = vi.fn();

/** In-memory plan store for tests: projectId -> planId -> { content, metadata, shipped_content, updated_at } */
const mockPlanStore = new Map<
  string,
  Map<
    string,
    {
      content: string;
      metadata: Record<string, unknown>;
      shipped_content: string | null;
      updated_at: string;
    }
  >
>();

const mockPlanInsert = vi
  .fn()
  .mockImplementation(
    async (projectId: string, planId: string, data: { content: string; metadata: string }) => {
      let proj = mockPlanStore.get(projectId);
      if (!proj) {
        proj = new Map();
        mockPlanStore.set(projectId, proj);
      }
      const metadata = JSON.parse(data.metadata) as Record<string, unknown>;
      proj.set(planId, {
        content: data.content,
        metadata,
        shipped_content: null,
        updated_at: new Date().toISOString(),
      });
    }
  );
const mockPlanGet = vi.fn().mockImplementation(async (projectId: string, planId: string) => {
  const proj = mockPlanStore.get(projectId);
  const row = proj?.get(planId);
  return row ?? null;
});
const mockPlanListIds = vi.fn().mockImplementation(async (projectId: string) => {
  const proj = mockPlanStore.get(projectId);
  return proj ? Array.from(proj.keys()) : [];
});
const mockPlanUpdateContent = vi
  .fn()
  .mockImplementation(async (projectId: string, planId: string, content: string) => {
    const proj = mockPlanStore.get(projectId);
    const row = proj?.get(planId);
    if (row) {
      row.content = content;
      row.updated_at = new Date().toISOString();
    }
  });
const mockPlanUpdateMetadata = vi
  .fn()
  .mockImplementation(
    async (projectId: string, planId: string, metadata: Record<string, unknown>) => {
      const proj = mockPlanStore.get(projectId);
      const row = proj?.get(planId);
      if (row) {
        row.metadata = metadata;
        row.updated_at = new Date().toISOString();
      }
    }
  );
const mockPlanSetShippedContent = vi
  .fn()
  .mockImplementation(async (projectId: string, planId: string, shippedContent: string) => {
    const proj = mockPlanStore.get(projectId);
    const row = proj?.get(planId);
    if (row) row.shipped_content = shippedContent;
  });
const mockPlanGetShippedContent = vi
  .fn()
  .mockImplementation(async (projectId: string, planId: string) => {
    const proj = mockPlanStore.get(projectId);
    const row = proj?.get(planId);
    return row?.shipped_content ?? null;
  });
const mockPlanGetByEpicId = vi
  .fn()
  .mockImplementation(async (projectId: string, epicId: string) => {
    const proj = mockPlanStore.get(projectId);
    if (!proj) return null;
    for (const [planId, row] of proj) {
      if ((row.metadata.epicId as string) === epicId) {
        return {
          plan_id: planId,
          content: row.content,
          metadata: row.metadata,
          shipped_content: row.shipped_content,
          updated_at: row.updated_at,
        };
      }
    }
    return null;
  });

vi.mock("../services/task-store.service.js", () => {
  const mockInstance = {
    create: (...args: unknown[]) => mockTaskStoreCreate(...args),
    createWithRetry: (...args: unknown[]) => mockTaskStoreCreateWithRetry(...args),
    createMany: (...args: unknown[]) => mockTaskStoreCreateMany(...args),
    update: (...args: unknown[]) => mockTaskStoreUpdate(...args),
    addDependency: (...args: unknown[]) => mockTaskStoreAddDependency(...args),
    addDependencies: (...args: unknown[]) => mockTaskStoreAddDependencies(...args),
    addLabel: (...args: unknown[]) => mockTaskStoreAddLabel(...args),
    listAll: (...args: unknown[]) => mockTaskStoreListAll(...args),
    planInsert: (...args: unknown[]) => mockPlanInsert(...args),
    planGet: (...args: unknown[]) => mockPlanGet(...args),
    planGetByEpicId: (...args: unknown[]) => mockPlanGetByEpicId(...args),
    planListIds: (...args: unknown[]) => mockPlanListIds(...args),
    planUpdateContent: (...args: unknown[]) => mockPlanUpdateContent(...args),
    planUpdateMetadata: (...args: unknown[]) => mockPlanUpdateMetadata(...args),
    planSetShippedContent: (...args: unknown[]) => mockPlanSetShippedContent(...args),
    planGetShippedContent: (...args: unknown[]) => mockPlanGetShippedContent(...args),
    show: (...args: unknown[]) => mockTaskStoreShow(...args),
    init: vi.fn().mockResolvedValue(undefined),
    syncForPush: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  return {
    TaskStoreService: vi.fn().mockImplementation(() => mockInstance),
    taskStore: mockInstance,
  };
});

const mockInvokePlanningAgent = vi.fn();
vi.mock("../services/agent.service.js", () => ({
  agentService: {
    invokePlanningAgent: (...args: unknown[]) => mockInvokePlanningAgent(...args),
  },
}));

vi.mock("../services/chat.service.js", () => ({
  ChatService: vi.fn().mockImplementation(() => ({
    syncPrdFromPlanShip: vi.fn().mockResolvedValue(undefined),
  })),
}));

const mockBroadcastToProject = vi.fn();
vi.mock("../websocket/index.js", () => ({
  broadcastToProject: (...args: unknown[]) => mockBroadcastToProject(...args),
}));

describe("PlanService createWithRetry usage", () => {
  let planService: PlanService;
  let projectService: ProjectService;
  let tempDir: string;
  let projectId: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockPlanStore.clear();
    mockInvokePlanningAgent.mockResolvedValue({
      content: JSON.stringify({ complexity: "medium" }),
    });
    planService = new PlanService();
    projectService = new ProjectService();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-plan-service-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    const project = await projectService.createProject({
      name: "Plan Service Test",
      repoPath: path.join(tempDir, "test-project"),
      simpleComplexityAgent: { type: "cursor", model: "claude-sonnet-4", cliCommand: null },
      complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });
    projectId = project.id;

    const repoPath = path.join(tempDir, "test-project");
    await fs.mkdir(path.join(repoPath, ".opensprint", "plans"), { recursive: true });

    // Epic create returns epic (no parentId) - use mockResolvedValue so it works across multiple tests
    mockTaskStoreCreate.mockResolvedValue({ id: "epic-123", title: "Test Plan", type: "epic" });
    // createWithRetry used for delta tasks (re-execute), not gate
    mockTaskStoreCreateWithRetry.mockResolvedValue({
      id: "epic-123.0",
      title: "Delta task",
      type: "task",
    });
    mockTaskStoreListAll.mockResolvedValue([]);
    mockTaskStoreShow.mockResolvedValue({ status: "open" });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("createPlan uses taskStore.create for epic only (no parentId)", async () => {
    const plan = await planService.createPlan(projectId, {
      title: "Test Plan",
      content: "# Test Plan\n\n## Overview\n\nContent.",
      complexity: "low",
    });

    expect(plan.metadata.epicId).toBe("epic-123");
    expect(plan.status).toBe("planning"); // Epic blocked → plan status planning

    // Epic: taskStore.create (no parentId)
    expect(mockTaskStoreCreate).toHaveBeenCalledTimes(1);
    expect(mockTaskStoreCreate).toHaveBeenCalledWith(
      expect.any(String),
      "Test Plan",
      expect.objectContaining({ type: "epic" })
    );
    expect(mockTaskStoreCreate.mock.calls[0][2]).not.toHaveProperty("parentId");
    // Epic blocked (no gate)
    expect(mockTaskStoreUpdate).toHaveBeenCalledWith(
      expect.any(String),
      "epic-123",
      expect.objectContaining({ status: "blocked" })
    );
  });

  it("createPlan does NOT create gate task (epic-blocked model)", async () => {
    await planService.createPlan(projectId, {
      title: "Test Plan",
      content: "# Test Plan\n\n## Overview\n\nContent.",
      complexity: "low",
    });

    expect(mockTaskStoreCreateWithRetry).not.toHaveBeenCalled();
  });

  it("createPlan does not pass gate_task_id in planInsert (no gate)", async () => {
    await planService.createPlan(projectId, {
      title: "No Gate Plan",
      content: "# No Gate\n\n## Overview\n\nContent.",
      complexity: "low",
    });

    expect(mockPlanInsert).toHaveBeenCalledWith(
      projectId,
      "no-gate-plan",
      expect.objectContaining({
        epic_id: "epic-123",
        content: expect.any(String),
        metadata: expect.any(String),
      })
    );
    expect(mockPlanInsert.mock.calls[0][2]).not.toHaveProperty("gate_task_id");
  });

  it("createPlan uses createMany for child tasks (parentId)", async () => {
    mockTaskStoreCreateMany.mockResolvedValue([
      { id: "epic-123.1", title: "Task A", type: "task" },
      { id: "epic-123.2", title: "Task B", type: "task" },
    ]);
    mockTaskStoreAddDependencies.mockResolvedValue(undefined);

    const plan = await planService.createPlan(projectId, {
      title: "Test Plan",
      content: "# Test Plan\n\n## Overview\n\nContent.",
      complexity: "low",
      tasks: [
        { title: "Task A", description: "First", priority: 0, dependsOn: [] },
        { title: "Task B", description: "Second", priority: 1, dependsOn: ["Task A"] },
      ],
    });

    expect(plan.taskCount).toBe(2);
    expect(mockTaskStoreCreateMany).toHaveBeenCalledTimes(1);
    expect(mockTaskStoreCreateMany).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        expect.objectContaining({ title: "Task A", parentId: "epic-123" }),
        expect.objectContaining({ title: "Task B", parentId: "epic-123" }),
      ])
    );
    // Inter-task deps only (no gate dep)
    expect(mockTaskStoreAddDependencies).toHaveBeenCalled();
    const addDepsCalls = mockTaskStoreAddDependencies.mock.calls;
    const allDeps = addDepsCalls.flatMap(
      ([, deps]) => deps as Array<{ childId: string; parentId: string }>
    );
    // No dependency should point to a gate (epic-blocked model has no gate)
    const gateIds = ["epic-123.0"];
    for (const d of allDeps) {
      expect(gateIds).not.toContain(d.parentId);
    }
  });

  it("createPlan accepts depends_on with numeric indices and resolves to task titles", async () => {
    mockTaskStoreCreateMany.mockResolvedValue([
      { id: "epic-123.1", title: "Task A", type: "task" },
      { id: "epic-123.2", title: "Task B", type: "task" },
    ]);
    mockTaskStoreAddDependencies.mockResolvedValue(undefined);

    const plan = await planService.createPlan(projectId, {
      title: "Index Deps Plan",
      content: "# Index\n\n## Overview\n\nTest.",
      complexity: "low",
      tasks: [
        {
          title: "Task A",
          description: "First",
          priority: 0,
          depends_on: [] as unknown as (string | number)[],
        },
        {
          title: "Task B",
          description: "Second",
          priority: 1,
          depends_on: [0] as unknown as (string | number)[],
        },
      ],
    } as Parameters<typeof planService.createPlan>[1]);

    expect(plan.taskCount).toBe(2);
    expect(mockTaskStoreAddDependencies).toHaveBeenCalled();
    const addDepsCalls = mockTaskStoreAddDependencies.mock.calls;
    const blocksDeps = addDepsCalls.flatMap(([, deps]) =>
      (deps as Array<{ childId: string; parentId: string; type?: string }>).filter(
        (d) => d.type === "blocks"
      )
    );
    expect(blocksDeps.some((d) => d.childId === "epic-123.2" && d.parentId === "epic-123.1")).toBe(
      true
    );
  });

  it("createPlan accepts snake_case depends_on and creates inter-task dependencies", async () => {
    mockTaskStoreCreateMany.mockResolvedValue([
      { id: "epic-123.1", title: "Task A", type: "task" },
      { id: "epic-123.2", title: "Task B", type: "task" },
    ]);
    mockTaskStoreAddDependencies.mockResolvedValue(undefined);

    const plan = await planService.createPlan(projectId, {
      title: "Test Plan",
      content: "# Test Plan\n\n## Overview\n\nContent.",
      complexity: "low",
      tasks: [
        {
          title: "Task A",
          description: "First",
          priority: 0,
          depends_on: [] as unknown as string[],
        },
        {
          title: "Task B",
          description: "Second",
          priority: 1,
          depends_on: ["Task A"] as unknown as string[],
        },
      ],
    } as Parameters<typeof planService.createPlan>[1]);

    expect(plan.taskCount).toBe(2);
    expect(mockTaskStoreAddDependencies).toHaveBeenCalled();
    const addDepsCalls = mockTaskStoreAddDependencies.mock.calls;
    const blocksDeps = addDepsCalls.flatMap(([, deps]) =>
      (deps as Array<{ childId: string; parentId: string; type?: string }>).filter(
        (d) => d.type === "blocks"
      )
    );
    expect(blocksDeps.some((d) => d.childId === "epic-123.2" && d.parentId === "epic-123.1")).toBe(
      true
    );
  });

  it("shipPlan with existing tasks sets epic status to open (unblock)", async () => {
    mockTaskStoreCreateMany.mockResolvedValue([
      { id: "epic-123.1", title: "Task A", type: "task" },
      { id: "epic-123.2", title: "Task B", type: "task" },
    ]);
    mockTaskStoreAddDependencies.mockResolvedValue(undefined);
    mockTaskStoreListAll.mockResolvedValue([
      { id: "epic-123", status: "blocked", type: "epic" },
      { id: "epic-123.1", status: "open", type: "task" },
      { id: "epic-123.2", status: "open", type: "task" },
    ]);

    const plan = await planService.createPlan(projectId, {
      title: "Execute Plan",
      content: "# Execute Plan\n\n## Overview\n\nContent.",
      complexity: "low",
      tasks: [
        { title: "Task A", description: "First", priority: 0, dependsOn: [] },
        { title: "Task B", description: "Second", priority: 1, dependsOn: ["Task A"] },
      ],
    });
    const result = await planService.shipPlan(projectId, plan.metadata.planId);

    expect(result.status).toBe("building");
    expect(mockTaskStoreUpdate).toHaveBeenCalledWith(
      projectId,
      "epic-123",
      expect.objectContaining({ status: "open" })
    );
  });

  it("generateAndCreateTasks (via shipPlan) uses createMany for generated tasks under epic", async () => {
    mockInvokePlanningAgent.mockImplementation((opts: { tracking?: { label?: string } }) => {
      if (opts.tracking?.label === "Task generation") {
        return Promise.resolve({
          content: JSON.stringify({
            tasks: [
              { title: "Generated Task A", description: "First", priority: 1, dependsOn: [] },
              {
                title: "Generated Task B",
                description: "Second",
                priority: 2,
                dependsOn: ["Generated Task A"],
              },
            ],
          }),
        });
      }
      return Promise.resolve({ content: JSON.stringify({ complexity: "medium" }) });
    });
    mockTaskStoreCreateMany.mockResolvedValue([
      { id: "epic-123.1", title: "Generated Task A", type: "task" },
      { id: "epic-123.2", title: "Generated Task B", type: "task" },
    ]);
    mockTaskStoreAddDependencies.mockResolvedValue(undefined);

    const plan = await planService.createPlan(projectId, {
      title: "Test Plan",
      content: "# Test Plan\n\n## Overview\n\nContent.",
      complexity: "low",
    });
    const planId = plan.metadata.planId;

    const result = await planService.shipPlan(projectId, planId);

    expect(result.status).toBe("building");
    expect(mockTaskStoreCreateMany).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        expect.objectContaining({ title: "Generated Task A", parentId: "epic-123" }),
        expect.objectContaining({ title: "Generated Task B", parentId: "epic-123" }),
      ])
    );
  });

  it("createPlan accepts task_title and task_description (snake_case) from Planner", async () => {
    mockTaskStoreCreateMany.mockResolvedValue([
      { id: "epic-123.1", title: "Setup DB", type: "task" },
      { id: "epic-123.2", title: "Add API", type: "task" },
    ]);
    mockTaskStoreAddDependencies.mockResolvedValue(undefined);

    const plan = await planService.createPlan(projectId, {
      title: "Snake Case Fields",
      content: "# Snake\n\n## Overview\n\nTest.",
      complexity: "low",
      tasks: [
        {
          task_title: "Setup DB",
          task_description: "Create schema",
          task_priority: 0,
          depends_on: [],
        },
        {
          task_title: "Add API",
          task_description: "REST endpoints",
          task_priority: 1,
          depends_on: ["Setup DB"],
        },
      ],
    } as Parameters<typeof planService.createPlan>[1]);

    expect(plan.taskCount).toBe(2);
    expect(mockTaskStoreCreateMany).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        expect.objectContaining({
          title: "Setup DB",
          description: "Create schema",
          parentId: "epic-123",
        }),
        expect.objectContaining({
          title: "Add API",
          description: "REST endpoints",
          parentId: "epic-123",
        }),
      ])
    );
  });

  it("createPlan accepts plan_title and plan_content (snake_case) from Planner/API", async () => {
    const plan = await planService.createPlan(projectId, {
      plan_title: "Snake Case Plan",
      plan_content: "# Snake Case Plan\n\n## Overview\n\nContent.",
      complexity: "low",
      task_list: [
        { task_title: "Setup", task_description: "Setup step", task_priority: 0, depends_on: [] },
        {
          task_title: "Build",
          task_description: "Build step",
          task_priority: 1,
          depends_on: ["Setup"],
        },
      ],
      mock_ups: [{ title: "Screen", content: "+---+\n| X |\n+---+" }],
    } as Parameters<typeof planService.createPlan>[1]);

    expect(plan.metadata.planId).toBe("snake-case-plan");
    expect(plan.taskCount).toBe(2);
    expect(plan.metadata.mockups).toHaveLength(1);
    expect(plan.metadata.mockups![0].title).toBe("Screen");
    expect(mockTaskStoreCreateMany).toHaveBeenCalledWith(
      projectId,
      expect.arrayContaining([
        expect.objectContaining({
          title: "Setup",
          description: "Setup step",
          parentId: expect.any(String),
        }),
        expect.objectContaining({
          title: "Build",
          description: "Build step",
          parentId: expect.any(String),
        }),
      ])
    );
  });

  it("createPlan filters out null and non-object task entries from Planner output", async () => {
    const plan = await planService.createPlan(projectId, {
      title: "Filter Test",
      content: "# Filter Test\n\n## Overview\n\nContent.",
      complexity: "low",
      tasks: [
        { title: "Valid Task", description: "Good", priority: 0, dependsOn: [] },
        null,
        undefined,
        "not an object",
        {
          title: "Another Valid",
          description: "Also good",
          priority: 1,
          dependsOn: ["Valid Task"],
        },
      ] as unknown[],
    } as Parameters<typeof planService.createPlan>[1]);

    expect(plan.taskCount).toBe(2);
    expect(mockTaskStoreCreateMany).toHaveBeenCalledWith(
      projectId,
      expect.arrayContaining([
        expect.objectContaining({ title: "Valid Task", description: "Good" }),
        expect.objectContaining({ title: "Another Valid", description: "Also good" }),
      ])
    );
  });

  it("createPlan rejects when title and plan_title are both missing", async () => {
    await expect(
      planService.createPlan(projectId, {
        content: "# Plan\n\nContent.",
      } as Parameters<typeof planService.createPlan>[1])
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("title") });
  });

  it("generateAndCreateTasks accepts task_list (snake_case) from Planner", async () => {
    mockInvokePlanningAgent.mockImplementation((opts: { tracking?: { label?: string } }) => {
      if (opts.tracking?.label === "Task generation") {
        return Promise.resolve({
          content: JSON.stringify({
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
      }
      return Promise.resolve({ content: JSON.stringify({ complexity: "medium" }) });
    });
    mockTaskStoreCreateMany.mockResolvedValue([
      { id: "epic-123.1", title: "Setup", type: "task" },
      { id: "epic-123.2", title: "Implement", type: "task" },
    ]);
    mockTaskStoreAddDependencies.mockResolvedValue(undefined);

    const plan = await planService.createPlan(projectId, {
      title: "Test Plan",
      content: "# Test Plan\n\n## Overview\n\nContent.",
      complexity: "low",
    });
    const result = await planService.shipPlan(projectId, plan.metadata.planId);

    expect(result.status).toBe("building");
    expect(mockTaskStoreCreateMany).toHaveBeenCalledWith(
      projectId,
      expect.arrayContaining([
        expect.objectContaining({ title: "Setup", description: "Setup step" }),
        expect.objectContaining({ title: "Implement", description: "Implement step" }),
      ])
    );
  });

  it("generateAndCreateTasks accepts snake_case depends_on from Planner", async () => {
    mockInvokePlanningAgent.mockImplementation((opts: { tracking?: { label?: string } }) => {
      if (opts.tracking?.label === "Task generation") {
        return Promise.resolve({
          content: JSON.stringify({
            tasks: [
              { title: "Task A", description: "First", priority: 1, depends_on: [] },
              { title: "Task B", description: "Second", priority: 2, depends_on: ["Task A"] },
            ],
          }),
        });
      }
      return Promise.resolve({ content: JSON.stringify({ complexity: "medium" }) });
    });
    mockTaskStoreCreateMany.mockResolvedValue([
      { id: "epic-123.1", title: "Task A", type: "task" },
      { id: "epic-123.2", title: "Task B", type: "task" },
    ]);
    mockTaskStoreAddDependencies.mockResolvedValue(undefined);

    const plan = await planService.createPlan(projectId, {
      title: "Test Plan",
      content: "# Test Plan\n\n## Overview\n\nContent.",
      complexity: "low",
    });
    const result = await planService.shipPlan(projectId, plan.metadata.planId);

    expect(result.status).toBe("building");
    expect(mockTaskStoreAddDependencies).toHaveBeenCalled();
    const addDepsCalls = mockTaskStoreAddDependencies.mock.calls;
    const allDeps = addDepsCalls.flatMap(
      ([, deps]) => deps as Array<{ childId: string; parentId: string }>
    );
    expect(allDeps.some((d) => d.childId === "epic-123.2" && d.parentId === "epic-123.1")).toBe(
      true
    );
  });

  it("reshipPlan (re-execute path) uses createWithRetry for delta tasks (no gate)", async () => {
    mockInvokePlanningAgent.mockImplementation((opts: { tracking?: { label?: string } }) => {
      if (opts.tracking?.label === "Re-execute: audit & delta tasks") {
        return Promise.resolve({
          content: JSON.stringify({
            status: "success",
            capability_summary: "Existing features",
            tasks: [
              {
                index: 0,
                title: "Delta Task 1",
                description: "New work",
                priority: 1,
                depends_on: [],
              },
              {
                index: 1,
                title: "Delta Task 2",
                description: "More work",
                priority: 2,
                depends_on: [0],
              },
            ],
          }),
        });
      }
      return Promise.resolve({ content: JSON.stringify({ complexity: "medium" }) });
    });
    mockTaskStoreCreateMany.mockResolvedValue([
      { id: "epic-123.1", title: "Task A", type: "task" },
      { id: "epic-123.2", title: "Task B", type: "task" },
    ]);
    mockTaskStoreAddDependencies.mockResolvedValue(undefined);

    const plan = await planService.createPlan(projectId, {
      title: "Reship Plan",
      content: "# Reship Plan\n\n## Overview\n\nContent.",
      complexity: "low",
      tasks: [
        { title: "Task A", description: "First", priority: 0, dependsOn: [] },
        { title: "Task B", description: "Second", priority: 1, dependsOn: ["Task A"] },
      ],
    });
    const planId = plan.metadata.planId;
    const _repoPath = path.join(tempDir, "test-project");

    mockTaskStoreListAll.mockResolvedValue([
      { id: "epic-123", status: "open", type: "epic" },
      { id: "epic-123.1", status: "closed", type: "task" },
      { id: "epic-123.2", status: "closed", type: "task" },
    ]);
    await planService.shipPlan(projectId, planId);

    mockTaskStoreListAll.mockResolvedValue([
      { id: "epic-123", status: "open", type: "epic" },
      { id: "epic-123.1", status: "closed", type: "task" },
      { id: "epic-123.2", status: "closed", type: "task" },
    ]);
    mockTaskStoreCreateWithRetry
      .mockResolvedValueOnce({ id: "epic-123.3", title: "Delta Task 1", type: "task" })
      .mockResolvedValueOnce({ id: "epic-123.4", title: "Delta Task 2", type: "task" });

    await mockPlanSetShippedContent(projectId, planId, "# Reship Plan\n\n## Overview\n\nContent.");

    const beforeReshipCalls = mockTaskStoreCreateWithRetry.mock.calls.length;
    await planService.reshipPlan(projectId, planId);
    const afterReshipCalls = mockTaskStoreCreateWithRetry.mock.calls;
    const reshipCalls = afterReshipCalls.slice(beforeReshipCalls);
    expect(reshipCalls.length).toBe(2); // 2 delta tasks

    // Epic set blocked before delta tasks (second Execute! will unblock)
    expect(mockTaskStoreUpdate).toHaveBeenCalledWith(
      projectId,
      "epic-123",
      expect.objectContaining({ status: "blocked" })
    );
    // No gate: addDependency only adds task-to-task deps, never blocks dep to gate
    const addDepCalls = mockTaskStoreAddDependency.mock.calls;
    const allDepPairs = addDepCalls.map(([, childId, parentId]) => ({ childId, parentId }));
    expect(
      allDepPairs.every(
        (d) => d.childId.startsWith("epic-123.") && d.parentId.startsWith("epic-123.")
      )
    ).toBe(true);
    // No reExecuteGateTaskId metadata update
    const metaCalls = mockPlanUpdateMetadata.mock.calls.filter(
      (c) => c[2] && typeof c[2] === "object"
    );
    expect(metaCalls.every((c) => !(c[2] as Record<string, unknown>)?.reExecuteGateTaskId)).toBe(
      true
    );
  });

  it("reshipPlan with no_changes_needed does not set epic blocked (Re-execute no delta)", async () => {
    mockInvokePlanningAgent.mockImplementation((opts: { tracking?: { label?: string } }) => {
      if (opts.tracking?.label === "Re-execute: audit & delta tasks") {
        return Promise.resolve({
          content: JSON.stringify({
            status: "no_changes_needed",
            capability_summary: "All features implemented",
            tasks: [],
          }),
        });
      }
      return Promise.resolve({ content: JSON.stringify({ complexity: "medium" }) });
    });

    const plan = await planService.createPlan(projectId, {
      title: "No Delta Plan",
      content: "# No Delta\n\n## Overview\n\nContent.",
      complexity: "low",
      tasks: [
        { title: "Task A", description: "First", priority: 0, dependsOn: [] },
        { title: "Task B", description: "Second", priority: 1, dependsOn: ["Task A"] },
      ],
    });
    const planId = plan.metadata.planId;

    mockTaskStoreListAll.mockResolvedValue([
      { id: "epic-123", status: "open", type: "epic" },
      { id: "epic-123.1", status: "closed", type: "task" },
      { id: "epic-123.2", status: "closed", type: "task" },
    ]);
    await planService.shipPlan(projectId, planId);

    mockTaskStoreListAll.mockResolvedValue([
      { id: "epic-123", status: "open", type: "epic" },
      { id: "epic-123.1", status: "closed", type: "task" },
      { id: "epic-123.2", status: "closed", type: "task" },
    ]);
    await mockPlanSetShippedContent(projectId, planId, "# No Delta\n\n## Overview\n\nContent.");

    mockTaskStoreUpdate.mockClear();
    await planService.reshipPlan(projectId, planId);

    // Epic status must not be changed to blocked when no delta tasks
    const blockedCalls = mockTaskStoreUpdate.mock.calls.filter(
      (c) => c[1] === "epic-123" && (c[2] as { status?: string })?.status === "blocked"
    );
    expect(blockedCalls).toHaveLength(0);
  });

  it("shipPlan routes to planTasks when no tasks (two-phase flow), then unblocks epic", async () => {
    mockInvokePlanningAgent.mockImplementation((opts: { tracking?: { label?: string } }) => {
      if (opts.tracking?.label === "Task generation") {
        return Promise.resolve({
          content: JSON.stringify({
            tasks: [
              { title: "Ship Plan Task A", description: "First", priority: 1, dependsOn: [] },
              {
                title: "Ship Plan Task B",
                description: "Second",
                priority: 2,
                dependsOn: ["Ship Plan Task A"],
              },
            ],
          }),
        });
      }
      return Promise.resolve({ content: JSON.stringify({ complexity: "medium" }) });
    });
    mockTaskStoreCreateMany.mockResolvedValue([
      { id: "epic-123.1", title: "Ship Plan Task A", type: "task" },
      { id: "epic-123.2", title: "Ship Plan Task B", type: "task" },
    ]);
    mockTaskStoreAddDependencies.mockResolvedValue(undefined);

    const plan = await planService.createPlan(projectId, {
      title: "Ship Plan No Gate",
      content: "# Ship Plan No Gate\n\n## Overview\n\nContent.",
      complexity: "low",
    });
    const planId = plan.metadata.planId;

    // listAll: first calls return [] (taskCount=0) so we route to planTasks; final returns tasks
    mockTaskStoreListAll
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { id: "epic-123", status: "open", type: "epic" },
        { id: "epic-123.1", status: "open", type: "task" },
        { id: "epic-123.2", status: "open", type: "task" },
      ]);

    const result = await planService.shipPlan(projectId, planId);

    expect(result.status).toBe("building");
    expect(result.taskCount).toBe(2);
    expect(mockTaskStoreUpdate).toHaveBeenCalledWith(
      projectId,
      "epic-123",
      expect.objectContaining({ status: "open" })
    );
    expect(mockInvokePlanningAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        tracking: expect.objectContaining({ label: "Task generation" }),
      })
    );
  });

  it("planTasks invokes Planner with plan markdown and creates tasks (no gate)", async () => {
    mockInvokePlanningAgent.mockImplementation((opts: { tracking?: { label?: string } }) => {
      if (opts.tracking?.label === "Task generation") {
        return Promise.resolve({
          content: JSON.stringify({
            tasks: [
              { title: "Plan Tasks A", description: "First task", priority: 1, dependsOn: [] },
              {
                title: "Plan Tasks B",
                description: "Second task",
                priority: 2,
                dependsOn: ["Plan Tasks A"],
              },
            ],
          }),
        });
      }
      return Promise.resolve({ content: JSON.stringify({ complexity: "medium" }) });
    });
    mockTaskStoreCreate.mockResolvedValueOnce({
      id: "epic-456",
      title: "Plan Tasks Test",
      type: "epic",
    });
    mockTaskStoreCreateMany.mockResolvedValue([
      { id: "epic-456.1", title: "Plan Tasks A", type: "task" },
      { id: "epic-456.2", title: "Plan Tasks B", type: "task" },
    ]);
    mockTaskStoreAddDependencies.mockResolvedValue(undefined);

    const plan = await planService.createPlan(projectId, {
      title: "Plan Tasks Test",
      content: "# Plan Tasks Test\n\n## Overview\n\nFeature for plan-tasks flow.",
      complexity: "low",
    });
    const planId = plan.metadata.planId;

    mockTaskStoreListAll
      .mockResolvedValueOnce([{ id: "epic-456", status: "blocked", type: "epic" }])
      .mockResolvedValue([
        { id: "epic-456", status: "blocked", type: "epic" },
        { id: "epic-456.1", status: "open", type: "task" },
        { id: "epic-456.2", status: "open", type: "task" },
      ]);

    const result = await planService.planTasks(projectId, planId);

    expect(result.taskCount).toBe(2);
    expect(mockInvokePlanningAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            content: expect.stringContaining("# Plan Tasks Test"),
          }),
        ]),
        tracking: expect.objectContaining({ label: "Task generation" }),
      })
    );
    expect(mockTaskStoreCreateMany).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        expect.objectContaining({ title: "Plan Tasks A", parentId: "epic-456" }),
        expect.objectContaining({ title: "Plan Tasks B", parentId: "epic-456" }),
      ])
    );
    expect(mockTaskStoreAddDependencies).toHaveBeenCalled();

    // AC4: Task generation results reflected in UI via WebSocket updates
    const broadcastCalls = mockBroadcastToProject.mock.calls;
    const taskUpdatedCalls = broadcastCalls.filter((c) => c[1]?.type === "task.updated");
    expect(taskUpdatedCalls.length).toBe(2);
    expect(taskUpdatedCalls).toContainEqual([
      projectId,
      expect.objectContaining({ type: "task.updated", taskId: "epic-456.1", status: "open" }),
    ]);
    expect(taskUpdatedCalls).toContainEqual([
      projectId,
      expect.objectContaining({ type: "task.updated", taskId: "epic-456.2", status: "open" }),
    ]);
    expect(broadcastCalls).toContainEqual([
      projectId,
      expect.objectContaining({ type: "plan.updated", planId }),
    ]);
  });

  it("listPlans returns plans from task store (no file-based plans)", async () => {
    const planId = "why-opensprint-section";
    const metadata = {
      planId,
      epicId: "epic-456",
      shippedAt: null,
      complexity: "medium",
    };
    await mockPlanInsert(projectId, planId, {
      epic_id: "epic-456",
      content: "# Why Opensprint Section\n\n## Overview\n\nContent.",
      metadata: JSON.stringify(metadata),
    });
    mockTaskStoreListAll.mockResolvedValue([]);

    const plans = await planService.listPlans(projectId);
    const planIds = plans.map((p) => p.metadata.planId);

    expect(planIds).toContain(planId);
    expect(plans.length).toBe(1);
  });

  it("getPlan status: planning when epic is blocked", async () => {
    const planId = "status-planning";
    const epicId = "epic-status";
    const metadata = {
      planId,
      epicId: epicId,
      shippedAt: null,
      complexity: "medium",
    };
    await mockPlanInsert(projectId, planId, {
      content: "# Status Planning\n\n## Overview\n\nContent.",
      metadata: JSON.stringify(metadata),
    });
    mockTaskStoreListAll.mockResolvedValue([
      { id: epicId, status: "blocked", type: "epic" },
      { id: `${epicId}.1`, status: "open", type: "task" },
      { id: `${epicId}.2`, status: "open", type: "task" },
    ]);
    mockTaskStoreShow.mockResolvedValue({ status: "blocked" });

    const plan = await planService.getPlan(projectId, planId);
    expect(plan.status).toBe("planning");
  });

  it("getPlan status: building when epic is open and tasks pending", async () => {
    const planId = "status-building";
    const epicId = "epic-building";
    const metadata = {
      planId,
      epicId: epicId,
      shippedAt: new Date().toISOString(),
      complexity: "medium",
    };
    await mockPlanInsert(projectId, planId, {
      content: "# Status Building\n\n## Overview\n\nContent.",
      metadata: JSON.stringify(metadata),
    });
    mockTaskStoreListAll.mockResolvedValue([
      { id: epicId, status: "open", type: "epic" },
      { id: `${epicId}.1`, status: "closed", type: "task" },
      { id: `${epicId}.2`, status: "open", type: "task" },
    ]);

    const plan = await planService.getPlan(projectId, planId);
    expect(plan.status).toBe("building");
  });

  it("getPlan status: complete when epic is open and all tasks done", async () => {
    const planId = "status-complete";
    const epicId = "epic-complete";
    const metadata = {
      planId,
      epicId: epicId,
      shippedAt: new Date().toISOString(),
      complexity: "medium",
    };
    await mockPlanInsert(projectId, planId, {
      content: "# Status Complete\n\n## Overview\n\nContent.",
      metadata: JSON.stringify(metadata),
    });
    mockTaskStoreListAll.mockResolvedValue([
      { id: epicId, status: "open", type: "epic" },
      { id: `${epicId}.1`, status: "closed", type: "task" },
      { id: `${epicId}.2`, status: "closed", type: "task" },
    ]);

    const plan = await planService.getPlan(projectId, planId);
    expect(plan.status).toBe("complete");
  });

  it("getPlan countTasks excludes epic-type children (no isGate filter)", async () => {
    const planId = "count-excludes-epics";
    const epicId = "epic-count";
    const metadata = {
      planId,
      epicId: epicId,
      shippedAt: null,
      complexity: "medium",
    };
    await mockPlanInsert(projectId, planId, {
      content: "# Count Excludes Epics\n\n## Overview\n\nContent.",
      metadata: JSON.stringify(metadata),
    });
    // epic.1 = task, epic.2 = epic (nested), epic.3 = task — countTasks should count only .1 and .3
    mockTaskStoreListAll.mockResolvedValue([
      { id: epicId, status: "open", type: "epic" },
      { id: `${epicId}.1`, status: "closed", type: "task" },
      { id: `${epicId}.2`, status: "open", type: "epic" },
      { id: `${epicId}.3`, status: "open", type: "task" },
    ]);

    const plan = await planService.getPlan(projectId, planId);
    expect(plan.taskCount).toBe(2);
    expect(plan.doneTaskCount).toBe(1);
  });

  it("getPlan status: planning when epic blocked overrides shippedAt", async () => {
    const planId = "blocked-overrides-shipped";
    const epicId = "epic-blocked-shipped";
    const metadata = {
      planId,
      epicId: epicId,
      shippedAt: new Date().toISOString(),
      complexity: "medium",
    };
    await mockPlanInsert(projectId, planId, {
      content: "# Blocked Overrides\n\n## Overview\n\nContent.",
      metadata: JSON.stringify(metadata),
    });
    mockTaskStoreListAll.mockResolvedValue([
      { id: epicId, status: "blocked", type: "epic" },
      { id: `${epicId}.1`, status: "closed", type: "task" },
    ]);
    mockTaskStoreShow.mockResolvedValue({ status: "blocked" });

    const plan = await planService.getPlan(projectId, planId);
    expect(plan.status).toBe("planning");
  });
});
