import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { PlanService } from "../services/plan.service.js";
import { ProjectService } from "../services/project.service.js";
import { DEFAULT_HIL_CONFIG } from "@opensprint/shared";

/** Hoisted so vi.mock() can reference it without duplicate declaration */
const { mockPlanVersionInsert } = vi.hoisted(() => ({
  mockPlanVersionInsert: vi.fn(),
}));

const mockTaskStoreCreate = vi.fn();
const mockTaskStoreCreateWithRetry = vi.fn();
const mockTaskStoreCreateMany = vi.fn();
const mockTaskStoreUpdate = vi.fn();
const mockTaskStoreAddDependency = vi.fn();
const mockTaskStoreAddDependencies = vi.fn();
const mockTaskStoreAddLabel = vi.fn();
const mockTaskStoreListAll = vi.fn();
const mockTaskStoreShow = vi.fn();

/** In-memory plan store for tests: projectId -> planId -> row with version fields */
const mockPlanStore = new Map<
  string,
  Map<
    string,
    {
      content: string;
      metadata: Record<string, unknown>;
      shipped_content: string | null;
      updated_at: string;
      current_version_number: number;
      last_executed_version_number: number | null;
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
        current_version_number: 1,
        last_executed_version_number: null,
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
const mockPlanVersionsStore = new Map<
  string,
  Map<string, Array<{ version_number: number; content: string; title: string | null }>>
>();
const mockListPlanVersions = vi
  .fn()
  .mockImplementation(
    async (projectId: string, planId: string): Promise<Array<{ version_number: number }>> => {
      const proj = mockPlanVersionsStore.get(projectId);
      const versions = proj?.get(planId) ?? [];
      return versions
        .slice()
        .sort((a, b) => b.version_number - a.version_number)
        .map((v) => ({ version_number: v.version_number }));
    }
  );
const mockPlanVersionInsertForStore = vi
  .fn()
  .mockImplementation(
    async (data: {
      project_id: string;
      plan_id: string;
      version_number: number;
      title?: string | null;
      content: string;
      metadata?: string | null;
      is_executed_version?: boolean;
    }) => {
      let proj = mockPlanVersionsStore.get(data.project_id);
      if (!proj) {
        proj = new Map();
        mockPlanVersionsStore.set(data.project_id, proj);
      }
      const list = proj.get(data.plan_id) ?? [];
      list.push({
        version_number: data.version_number,
        content: data.content,
        title: data.title ?? null,
      });
      proj.set(data.plan_id, list);
      return {
        id: list.length,
        project_id: data.project_id,
        plan_id: data.plan_id,
        version_number: data.version_number,
        title: data.title ?? null,
        content: data.content,
        metadata: data.metadata ?? null,
        created_at: new Date().toISOString(),
        is_executed_version: Boolean(data.is_executed_version),
      };
    }
  );
const mockPlanUpdateContent = vi
  .fn()
  .mockImplementation(
    async (
      projectId: string,
      planId: string,
      content: string,
      currentVersionNumber?: number
    ) => {
      const proj = mockPlanStore.get(projectId);
      const row = proj?.get(planId);
      if (row) {
        row.content = content;
        row.updated_at = new Date().toISOString();
        if (currentVersionNumber != null) {
          row.current_version_number = currentVersionNumber;
        }
      }
    }
  );
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

/** In-memory plan versions for shipPlan versioning tests. Key = `${projectId}:${planId}` */
const mockPlanVersionsByKey = new Map<
  string,
  Array<{
    version_number: number;
    title: string | null;
    content: string;
    metadata: string | null;
    is_executed_version: boolean;
  }>
>();

const mockPlanVersionList = vi.fn().mockImplementation(async (projectId: string, planId: string) => {
  const key = `${projectId}:${planId}`;
  const list = mockPlanVersionsByKey.get(key) ?? [];
  return list
    .slice()
    .sort((a, b) => b.version_number - a.version_number)
    .map((v) => ({
      id: v.version_number,
      project_id: projectId,
      plan_id: planId,
      version_number: v.version_number,
      title: v.title,
      created_at: new Date().toISOString(),
      is_executed_version: v.is_executed_version,
    }));
});

const mockPlanVersionGetByVersionNumber = vi
  .fn()
  .mockImplementation(
    async (
      projectId: string,
      planId: string,
      versionNumber: number
    ): Promise<{
      id: number;
      project_id: string;
      plan_id: string;
      version_number: number;
      title: string | null;
      content: string;
      metadata: string | null;
      created_at: string;
      is_executed_version: boolean;
    }> => {
      const key = `${projectId}:${planId}`;
      const list = mockPlanVersionsByKey.get(key) ?? [];
      const v = list.find((x) => x.version_number === versionNumber);
      if (!v) throw new Error(`Plan version ${versionNumber} not found`);
      return {
        id: versionNumber,
        project_id: projectId,
        plan_id: planId,
        version_number: v.version_number,
        title: v.title,
        content: v.content,
        metadata: v.metadata,
        created_at: new Date().toISOString(),
        is_executed_version: v.is_executed_version,
      };
    }
  );

mockPlanVersionInsert.mockImplementation(async (data: {
  project_id: string;
  plan_id: string;
  version_number: number;
  title?: string | null;
  content: string;
  metadata?: string | null;
  is_executed_version?: boolean;
}) => {
  const key = `${data.project_id}:${data.plan_id}`;
  let list = mockPlanVersionsByKey.get(key);
  if (!list) {
    list = [];
    mockPlanVersionsByKey.set(key, list);
  }
  list.push({
    version_number: data.version_number,
    title: data.title ?? null,
    content: data.content,
    metadata: data.metadata ?? null,
    is_executed_version: data.is_executed_version ?? false,
  });
  // Also write to mockPlanVersionsStore so mockListPlanVersions (updatePlan flow) sees versions
  let proj = mockPlanVersionsStore.get(data.project_id);
  if (!proj) {
    proj = new Map();
    mockPlanVersionsStore.set(data.project_id, proj);
  }
  const storeList = proj.get(data.plan_id) ?? [];
  storeList.push({
    version_number: data.version_number,
    content: data.content,
    title: data.title ?? null,
  });
  proj.set(data.plan_id, storeList);
  return {
    id: data.version_number,
    project_id: data.project_id,
    plan_id: data.plan_id,
    version_number: data.version_number,
    title: data.title ?? null,
    content: data.content,
    metadata: data.metadata ?? null,
    created_at: new Date().toISOString(),
    is_executed_version: data.is_executed_version ?? false,
  };
});

const mockPlanVersionSetExecutedVersion = vi.fn().mockResolvedValue(undefined);

const mockPlanUpdateVersionNumbers = vi
  .fn()
  .mockImplementation(
    async (
      projectId: string,
      planId: string,
      updates: { current_version_number?: number; last_executed_version_number?: number | null }
    ) => {
      const proj = mockPlanStore.get(projectId);
      const row = proj?.get(planId);
      if (row) {
        if (updates.current_version_number !== undefined)
          row.current_version_number = updates.current_version_number;
        if (updates.last_executed_version_number !== undefined)
          row.last_executed_version_number = updates.last_executed_version_number;
      }
    }
  );

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
          current_version_number: row.current_version_number,
          last_executed_version_number: row.last_executed_version_number,
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
    listPlanVersions: (...args: unknown[]) => mockListPlanVersions(...args),
    planVersionInsert: (...args: unknown[]) => mockPlanVersionInsert(...args),
    planUpdateMetadata: (...args: unknown[]) => mockPlanUpdateMetadata(...args),
    planSetShippedContent: (...args: unknown[]) => mockPlanSetShippedContent(...args),
    planGetShippedContent: (...args: unknown[]) => mockPlanGetShippedContent(...args),
    planVersionList: (...args: unknown[]) => mockPlanVersionList(...args),
    planVersionGetByVersionNumber: (...args: unknown[]) => mockPlanVersionGetByVersionNumber(...args),
    planVersionSetExecutedVersion: (...args: unknown[]) => mockPlanVersionSetExecutedVersion(...args),
    planUpdateVersionNumbers: (...args: unknown[]) => mockPlanUpdateVersionNumbers(...args),
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
    mockPlanVersionsStore.clear();
    mockPlanVersionsByKey.clear();
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

  it("shipPlan first Execute creates v1 and sets last_executed_version_number", async () => {
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
      title: "Versioned Plan",
      content: "# Versioned Plan\n\n## Overview\n\nFirst version.",
      complexity: "low",
      tasks: [
        { title: "Task A", description: "First", priority: 0, dependsOn: [] },
        { title: "Task B", description: "Second", priority: 1, dependsOn: ["Task A"] },
      ],
    });
    const planId = plan.metadata.planId;

    await planService.shipPlan(projectId, planId);

    expect(mockPlanVersionInsert).toHaveBeenCalledTimes(1);
    expect(mockPlanVersionInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: projectId,
        plan_id: planId,
        version_number: 1,
        content: "# Versioned Plan\n\n## Overview\n\nFirst version.",
      })
    );
    expect(mockPlanUpdateVersionNumbers).toHaveBeenCalledWith(
      projectId,
      planId,
      expect.objectContaining({ current_version_number: 1 })
    );
    expect(mockPlanUpdateVersionNumbers).toHaveBeenCalledWith(
      projectId,
      planId,
      expect.objectContaining({ last_executed_version_number: 1 })
    );
    expect(mockPlanVersionSetExecutedVersion).toHaveBeenCalledWith(projectId, planId, 1);
    expect(mockPlanSetShippedContent).toHaveBeenCalledWith(
      projectId,
      planId,
      "# Versioned Plan\n\n## Overview\n\nFirst version."
    );
  });

  it("shipPlan after edit creates new version (v2)", async () => {
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
      title: "Edit Then Execute",
      content: "# Edit Then Execute\n\n## Overview\n\nOriginal.",
      complexity: "low",
      tasks: [
        { title: "Task A", description: "First", priority: 0, dependsOn: [] },
        { title: "Task B", description: "Second", priority: 1, dependsOn: ["Task A"] },
      ],
    });
    const planId = plan.metadata.planId;

    await planService.shipPlan(projectId, planId);
    expect(mockPlanVersionInsert).toHaveBeenCalledTimes(1);
    expect(mockPlanVersionInsert).toHaveBeenCalledWith(
      expect.objectContaining({ version_number: 1, content: "# Edit Then Execute\n\n## Overview\n\nOriginal." })
    );

    mockPlanVersionInsert.mockClear();
    mockPlanUpdateVersionNumbers.mockClear();

    // Simulate user editing plan content
    const proj = mockPlanStore.get(projectId);
    const row = proj?.get(planId);
    expect(row).toBeDefined();
    row!.content = "# Edit Then Execute\n\n## Overview\n\nEdited content.";

    await planService.shipPlan(projectId, planId);

    expect(mockPlanVersionInsert).toHaveBeenCalledTimes(1);
    expect(mockPlanVersionInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: projectId,
        plan_id: planId,
        version_number: 2,
        content: "# Edit Then Execute\n\n## Overview\n\nEdited content.",
      })
    );
    expect(mockPlanUpdateVersionNumbers).toHaveBeenCalledWith(
      projectId,
      planId,
      expect.objectContaining({ current_version_number: 2 })
    );
    expect(mockPlanUpdateVersionNumbers).toHaveBeenCalledWith(
      projectId,
      planId,
      expect.objectContaining({ last_executed_version_number: 2 })
    );
    expect(mockPlanVersionSetExecutedVersion).toHaveBeenCalledWith(projectId, planId, 2);
    expect(mockPlanSetShippedContent).toHaveBeenCalledWith(
      projectId,
      planId,
      "# Edit Then Execute\n\n## Overview\n\nEdited content."
    );
  });

  it("shipPlan with version_number loads that version, sets last_executed, ships that content (no new version)", async () => {
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
      title: "Execute Version Plan",
      content: "# Execute Version\n\n## Overview\n\nCurrent.",
      complexity: "low",
      tasks: [
        { title: "Task A", description: "First", priority: 0, dependsOn: [] },
        { title: "Task B", description: "Second", priority: 1, dependsOn: ["Task A"] },
      ],
    });
    const planId = plan.metadata.planId;
    const key = `${projectId}:${planId}`;
    mockPlanVersionsByKey.set(key, [
      { version_number: 1, title: "V1", content: "# V1\n\nContent one.", metadata: null, is_executed_version: false },
      { version_number: 2, title: "V2", content: "# V2\n\nContent two.", metadata: null, is_executed_version: false },
    ]);

    mockPlanVersionInsert.mockClear();
    await planService.shipPlan(projectId, planId, { version_number: 2 });

    expect(mockPlanVersionInsert).not.toHaveBeenCalled();
    expect(mockPlanVersionSetExecutedVersion).toHaveBeenCalledWith(projectId, planId, 2);
    expect(mockPlanUpdateVersionNumbers).toHaveBeenCalledWith(
      projectId,
      planId,
      expect.objectContaining({ last_executed_version_number: 2 })
    );
    expect(mockPlanSetShippedContent).toHaveBeenCalledWith(
      projectId,
      planId,
      "# V2\n\nContent two."
    );
  });

  it("shipPlan when content unchanged does not create new version (reuses current)", async () => {
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
      title: "Same Content Plan",
      content: "# Same Content\n\n## Overview\n\nUnchanged.",
      complexity: "low",
      tasks: [
        { title: "Task A", description: "First", priority: 0, dependsOn: [] },
        { title: "Task B", description: "Second", priority: 1, dependsOn: ["Task A"] },
      ],
    });
    const planId = plan.metadata.planId;

    await planService.shipPlan(projectId, planId);
    expect(mockPlanVersionInsert).toHaveBeenCalledTimes(1);
    mockPlanVersionInsert.mockClear();
    mockPlanUpdateVersionNumbers.mockClear();

    // Second ship without editing content: should NOT insert a new version
    await planService.shipPlan(projectId, planId);

    expect(mockPlanVersionInsert).not.toHaveBeenCalled();
    expect(mockPlanVersionSetExecutedVersion).toHaveBeenCalledWith(projectId, planId, 1);
    expect(mockPlanUpdateVersionNumbers).toHaveBeenCalledWith(
      projectId,
      planId,
      expect.objectContaining({ last_executed_version_number: 1 })
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

  it("generateAndCreateTasks accepts taskList (camelCase) from Planner", async () => {
    mockInvokePlanningAgent.mockImplementation((opts: { tracking?: { label?: string } }) => {
      if (opts.tracking?.label === "Task generation") {
        return Promise.resolve({
          content: JSON.stringify({
            taskList: [
              { title: "Task One", description: "First", priority: 1, dependsOn: [] },
              { title: "Task Two", description: "Second", priority: 2, dependsOn: ["Task One"] },
            ],
          }),
        });
      }
      return Promise.resolve({ content: JSON.stringify({ complexity: "medium" }) });
    });
    mockTaskStoreCreateMany.mockResolvedValue([
      { id: "epic-123.1", title: "Task One", type: "task" },
      { id: "epic-123.2", title: "Task Two", type: "task" },
    ]);
    mockTaskStoreAddDependencies.mockResolvedValue(undefined);

    const plan = await planService.createPlan(projectId, {
      title: "TaskList Plan",
      content: "# TaskList Plan\n\n## Overview\n\nContent.",
      complexity: "low",
    });

    const result = await planService.planTasks(projectId, plan.metadata.planId);

    expect(result.metadata.epicId).toBeTruthy();
    expect(mockTaskStoreCreateMany).toHaveBeenCalledWith(
      projectId,
      expect.arrayContaining([
        expect.objectContaining({ title: "Task One", description: "First" }),
        expect.objectContaining({ title: "Task Two", description: "Second" }),
      ])
    );
  });

  it("planTasks retries task generation once in same conversation context", async () => {
    const firstReply = "I drafted tasks, but not as JSON.";
    mockInvokePlanningAgent.mockImplementation((opts: {
      tracking?: { label?: string };
      messages?: Array<{ role: string; content: string }>;
    }) => {
      if (opts.tracking?.label === "Task generation") {
        const userMessages = opts.messages?.filter((m) => m.role === "user") ?? [];
        if (userMessages.length > 1) {
          return Promise.resolve({
            content: JSON.stringify({
              tasks: [
                { title: "Retry Task A", description: "First", priority: 1, dependsOn: [] },
                {
                  title: "Retry Task B",
                  description: "Second",
                  priority: 2,
                  dependsOn: ["Retry Task A"],
                },
              ],
            }),
          });
        }
        return Promise.resolve({ content: firstReply });
      }
      return Promise.resolve({ content: JSON.stringify({ taskIdsToClose: [] }) });
    });
    mockTaskStoreCreateMany.mockResolvedValue([
      { id: "epic-123.1", title: "Retry Task A", type: "task" },
      { id: "epic-123.2", title: "Retry Task B", type: "task" },
    ]);
    mockTaskStoreAddDependencies.mockResolvedValue(undefined);

    const plan = await planService.createPlan(projectId, {
      title: "Retry Plan",
      content: "# Retry Plan\n\n## Overview\n\nContent.",
      complexity: "low",
    });

    const result = await planService.planTasks(projectId, plan.metadata.planId);

    expect(result.metadata.epicId).toBeTruthy();
    expect(mockTaskStoreCreateMany).toHaveBeenCalled();
    const taskGenCalls = mockInvokePlanningAgent.mock.calls
      .map((call) => call[0] as { tracking?: { label?: string }; messages?: unknown[] })
      .filter((opts) => opts.tracking?.label === "Task generation");
    expect(taskGenCalls.length).toBe(2);
    const retryMessages = taskGenCalls[1]?.messages as Array<{ role: string; content: string }>;
    expect(retryMessages).toHaveLength(3);
    expect(retryMessages[1]?.role).toBe("assistant");
    expect(retryMessages[1]?.content).toBe(firstReply);
    expect(retryMessages[2]?.role).toBe("user");
    expect(retryMessages[2]?.content).toContain("Return ONLY a single valid JSON object");
    expect(retryMessages[2]?.content).toContain("Previous parse failure");
  });

  it("generateAndCreateTasks accepts nested planner tasks arrays", async () => {
    mockInvokePlanningAgent.mockImplementation((opts: { tracking?: { label?: string } }) => {
      if (opts.tracking?.label === "Task generation") {
        return Promise.resolve({
          content: JSON.stringify({
            result: {
              planner_output: {
                tasks: [
                  { title: "Nested Task A", description: "First", priority: 1, dependsOn: [] },
                  {
                    title: "Nested Task B",
                    description: "Second",
                    priority: 2,
                    dependsOn: ["Nested Task A"],
                  },
                ],
              },
            },
          }),
        });
      }
      return Promise.resolve({ content: JSON.stringify({ complexity: "medium" }) });
    });
    mockTaskStoreCreateMany.mockResolvedValue([
      { id: "epic-123.1", title: "Nested Task A", type: "task" },
      { id: "epic-123.2", title: "Nested Task B", type: "task" },
    ]);
    mockTaskStoreAddDependencies.mockResolvedValue(undefined);

    const plan = await planService.createPlan(projectId, {
      title: "Nested Tasks Plan",
      content: "# Nested Tasks Plan\n\n## Overview\n\nContent.",
      complexity: "low",
    });

    const result = await planService.planTasks(projectId, plan.metadata.planId);

    expect(result.metadata.epicId).toBeTruthy();
    expect(mockTaskStoreCreateMany).toHaveBeenCalledWith(
      projectId,
      expect.arrayContaining([
        expect.objectContaining({ title: "Nested Task A", description: "First" }),
        expect.objectContaining({ title: "Nested Task B", description: "Second" }),
      ])
    );
    expect(mockTaskStoreAddDependencies).toHaveBeenCalled();
  });

  it("planTasks includes parse failure reason when planner tasks are invalid", async () => {
    mockInvokePlanningAgent.mockImplementation((opts: { tracking?: { label?: string } }) => {
      if (opts.tracking?.label === "Task generation") {
        return Promise.resolve({
          content: JSON.stringify({
            result: {
              tasks: ["not-an-object", null, 42],
            },
          }),
        });
      }
      return Promise.resolve({ content: JSON.stringify({ complexity: "medium" }) });
    });

    const plan = await planService.createPlan(projectId, {
      title: "Invalid Planner Tasks Plan",
      content: "# Invalid Planner Tasks Plan\n\n## Overview\n\nContent.",
      complexity: "low",
    });

    await expect(planService.planTasks(projectId, plan.metadata.planId)).rejects.toMatchObject({
      statusCode: 400,
      code: "DECOMPOSE_PARSE_FAILED",
      message: expect.stringContaining("contained no task objects"),
      details: expect.objectContaining({
        parseFailureReason: expect.stringContaining("contained no task objects"),
      }),
    });
    const taskGenCalls = mockInvokePlanningAgent.mock.calls
      .map((call) => call[0] as { tracking?: { label?: string } })
      .filter((opts) => opts.tracking?.label === "Task generation");
    expect(taskGenCalls.length).toBe(2);
    expect(mockTaskStoreCreateMany).not.toHaveBeenCalled();
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

    // Re-execute only allowed for complete plans; set reviewedAt so getPlan returns status "complete"
    const row = mockPlanStore.get(projectId)?.get(planId);
    if (row) (row.metadata as Record<string, unknown>).reviewedAt = new Date().toISOString();

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

    // Re-execute only allowed for complete plans; set reviewedAt so getPlan returns status "complete"
    const rowNoDelta = mockPlanStore.get(projectId)?.get(planId);
    if (rowNoDelta) (rowNoDelta.metadata as Record<string, unknown>).reviewedAt = new Date().toISOString();

    mockTaskStoreUpdate.mockClear();
    await planService.reshipPlan(projectId, planId);

    // Epic status must not be changed to blocked when no delta tasks
    const blockedCalls = mockTaskStoreUpdate.mock.calls.filter(
      (c) => c[1] === "epic-123" && (c[2] as { status?: string })?.status === "blocked"
    );
    expect(blockedCalls).toHaveLength(0);
  });

  it("reshipPlan throws 400 when plan status is not complete (e.g. in_review)", async () => {
    mockTaskStoreCreateMany.mockResolvedValue([{ id: "epic-123.1", title: "Task A", type: "task" }]);
    const plan = await planService.createPlan(projectId, {
      title: "In Review Plan",
      content: "# In Review\n\nContent.",
      complexity: "low",
      tasks: [{ title: "Task A", description: "Only", priority: 0, dependsOn: [] }],
    });
    const planId = plan.metadata.planId;
    mockTaskStoreListAll.mockResolvedValue([
      { id: "epic-123", status: "open", type: "epic" },
      { id: "epic-123.1", status: "closed", type: "task" },
    ]);
    await planService.shipPlan(projectId, planId);
    // Plan has all tasks closed but no reviewedAt → status in_review; do not set reviewedAt
    await expect(planService.reshipPlan(projectId, planId)).rejects.toMatchObject({
      statusCode: 400,
      message: "Re-execute is only available for plans that have been marked complete.",
    });
  });

  it("reshipPlan with version_number uses that version content for plan_old", async () => {
    mockInvokePlanningAgent.mockImplementation((opts: { tracking?: { label?: string } }) => {
      if (opts.tracking?.label === "Re-execute: audit & delta tasks") {
        return Promise.resolve({
          content: JSON.stringify({
            status: "no_changes_needed",
            capability_summary: "Done",
            tasks: [],
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
      title: "Reship Version Plan",
      content: "# Reship Version\n\n## Overview\n\nCurrent.",
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

    const key = `${projectId}:${planId}`;
    mockPlanVersionsByKey.set(key, [
      { version_number: 1, title: "V1", content: "# V1\n\nOld content.", metadata: null, is_executed_version: true },
      { version_number: 2, title: "V2", content: "# V2\n\nNew content.", metadata: null, is_executed_version: false },
    ]);
    mockTaskStoreListAll.mockResolvedValue([
      { id: "epic-123", status: "open", type: "epic" },
      { id: "epic-123.1", status: "closed", type: "task" },
      { id: "epic-123.2", status: "closed", type: "task" },
    ]);
    await mockPlanSetShippedContent(projectId, planId, "# V1\n\nOld content.");
    const row = mockPlanStore.get(projectId)?.get(planId);
    if (row) (row.metadata as Record<string, unknown>).reviewedAt = new Date().toISOString();

    mockPlanVersionGetByVersionNumber.mockClear();
    await planService.reshipPlan(projectId, planId, { version_number: 1 });

    expect(mockPlanVersionGetByVersionNumber).toHaveBeenCalledWith(projectId, planId, 1);
    expect(mockInvokePlanningAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            content: expect.stringContaining("# V1\n\nOld content."),
          }),
        ]),
      })
    );
  });

  it("reshipPlan without version_number uses last_executed_version_number for plan_old", async () => {
    mockInvokePlanningAgent.mockImplementation((opts: { tracking?: { label?: string } }) => {
      if (opts.tracking?.label === "Re-execute: audit & delta tasks") {
        return Promise.resolve({
          content: JSON.stringify({
            status: "no_changes_needed",
            capability_summary: "Done",
            tasks: [],
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
      title: "Reship Last Exec Plan",
      content: "# Reship Last Exec\n\n## Overview\n\nCurrent (v2).",
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

    const key = `${projectId}:${planId}`;
    mockPlanVersionsByKey.set(key, [
      { version_number: 1, title: "V1", content: "# V1\n\nLast executed content.", metadata: null, is_executed_version: true },
      { version_number: 2, title: "V2", content: "# V2\n\nCurrent (v2).", metadata: null, is_executed_version: false },
    ]);
    const proj = mockPlanStore.get(projectId);
    const planRow = proj?.get(planId);
    if (planRow) {
      planRow.last_executed_version_number = 1;
      (planRow.metadata as Record<string, unknown>).reviewedAt = new Date().toISOString();
    }
    mockTaskStoreListAll.mockResolvedValue([
      { id: "epic-123", status: "open", type: "epic" },
      { id: "epic-123.1", status: "closed", type: "task" },
      { id: "epic-123.2", status: "closed", type: "task" },
    ]);
    await mockPlanSetShippedContent(projectId, planId, "# V1\n\nLast executed content.");

    mockPlanVersionGetByVersionNumber.mockClear();
    await planService.reshipPlan(projectId, planId);

    expect(mockPlanVersionGetByVersionNumber).toHaveBeenCalledWith(projectId, planId, 1);
    expect(mockInvokePlanningAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            content: expect.stringContaining("# V1\n\nLast executed content."),
          }),
        ]),
      })
    );
  });

  it("reshipPlan throws 400 when plan status is building (epic open, tasks not all closed)", async () => {
    mockTaskStoreCreateMany.mockResolvedValue([{ id: "epic-123.1", title: "Task A", type: "task" }]);
    const plan = await planService.createPlan(projectId, {
      title: "Building Plan",
      content: "# Building\n\nContent.",
      complexity: "low",
      tasks: [{ title: "Task A", description: "Only", priority: 0, dependsOn: [] }],
    });
    const planId = plan.metadata.planId;
    // Epic open, one task still open → status building
    mockTaskStoreListAll.mockResolvedValue([
      { id: "epic-123", status: "open", type: "epic" },
      { id: "epic-123.1", status: "open", type: "task" },
    ]);
    await planService.shipPlan(projectId, planId);
    await expect(planService.reshipPlan(projectId, planId)).rejects.toMatchObject({
      statusCode: 400,
      message: "Re-execute is only available for plans that have been marked complete.",
    });
  });

  it("reshipPlan without options calls shipPlan with lastExecutedVersionNumber when none started", async () => {
    mockTaskStoreCreateMany.mockResolvedValue([
      { id: "epic-123.1", title: "Task A", type: "task" },
      { id: "epic-123.2", title: "Task B", type: "task" },
    ]);
    const plan = await planService.createPlan(projectId, {
      title: "Re-execute Last Version Plan",
      content: "# Plan\n\nContent.",
      complexity: "low",
      tasks: [
        { title: "Task A", description: "First", priority: 0, dependsOn: [] },
        { title: "Task B", description: "Second", priority: 1, dependsOn: [] },
      ],
    });
    const planId = plan.metadata.planId;
    // Set last_executed_version_number without running full ship (avoids task generation in test)
    const proj = mockPlanStore.get(projectId);
    const row = proj?.get(planId);
    expect(row).toBeDefined();
    row!.last_executed_version_number = 1;
    if (row!.metadata) (row!.metadata as Record<string, unknown>).reviewedAt = new Date().toISOString();

    // None started: all children open; reshipPlan uses crudService.getPlan internally, so mock that
    mockTaskStoreListAll.mockResolvedValue([
      { id: "epic-123", status: "open", type: "epic" },
      { id: "epic-123.1", status: "open", type: "task" },
      { id: "epic-123.2", status: "open", type: "task" },
    ]);
    const planWithComplete = await planService.getPlan(projectId, planId);
    const completePlan = {
      ...planWithComplete,
      status: "complete" as const,
      lastExecutedVersionNumber: 1,
    };
    const crudService = (planService as { planCrudService: { getPlan: PlanService["getPlan"] } })
      .planCrudService;
    const getPlanSpy = vi.spyOn(crudService, "getPlan").mockResolvedValue(completePlan);
    const shipPlanSpy = vi
      .spyOn(planService, "shipPlan")
      .mockResolvedValue(completePlan as Awaited<ReturnType<PlanService["shipPlan"]>>);

    await planService.reshipPlan(projectId, planId);

    expect(shipPlanSpy).toHaveBeenCalledWith(projectId, planId, { version_number: 1 });
    getPlanSpy.mockRestore();
    shipPlanSpy.mockRestore();
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

    // AC4: Task generation results reflected in UI via WebSocket updates.
    // task.created events are emitted from TaskStoreService (tested in plan-route.test).
    // Plan service broadcasts plan.updated.
    const broadcastCalls = mockBroadcastToProject.mock.calls;
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

  it("listPlansWithDependencyGraph derives in_review and complete from reviewedAt", async () => {
    const planA = "plan-in-review";
    const planB = "plan-complete";
    const epicA = "epic-a";
    const epicB = "epic-b";
    await mockPlanInsert(projectId, planA, {
      content: "# Plan A\n\n## Overview\n\nContent.",
      metadata: JSON.stringify({
        planId: planA,
        epicId: epicA,
        shippedAt: new Date().toISOString(),
        complexity: "medium",
      }),
    });
    await mockPlanInsert(projectId, planB, {
      content: "# Plan B\n\n## Overview\n\nContent.",
      metadata: JSON.stringify({
        planId: planB,
        epicId: epicB,
        shippedAt: new Date().toISOString(),
        reviewedAt: "2025-03-09T12:00:00.000Z",
        complexity: "medium",
      }),
    });
    mockTaskStoreListAll.mockResolvedValue([
      { id: epicA, status: "open", type: "epic" },
      { id: `${epicA}.1`, status: "closed", type: "task" },
      { id: epicB, status: "open", type: "epic" },
      { id: `${epicB}.1`, status: "closed", type: "task" },
    ]);

    const { plans } = await planService.listPlansWithDependencyGraph(projectId);
    const a = plans.find((p) => p.metadata.planId === planA);
    const b = plans.find((p) => p.metadata.planId === planB);
    expect(a?.status).toBe("in_review");
    expect(b?.status).toBe("complete");
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

  it("getPlan status: in_review when epic is open and all tasks done and no reviewedAt", async () => {
    const planId = "status-in-review";
    const epicId = "epic-in-review";
    const metadata = {
      planId,
      epicId: epicId,
      shippedAt: new Date().toISOString(),
      complexity: "medium",
    };
    await mockPlanInsert(projectId, planId, {
      content: "# Status In Review\n\n## Overview\n\nContent.",
      metadata: JSON.stringify(metadata),
    });
    mockTaskStoreListAll.mockResolvedValue([
      { id: epicId, status: "open", type: "epic" },
      { id: `${epicId}.1`, status: "closed", type: "task" },
      { id: `${epicId}.2`, status: "closed", type: "task" },
    ]);

    const plan = await planService.getPlan(projectId, planId);
    expect(plan.status).toBe("in_review");
  });

  it("getPlan status: complete when epic is open and all tasks done and reviewedAt set", async () => {
    const planId = "status-complete";
    const epicId = "epic-complete";
    const reviewedAt = "2025-03-09T12:00:00.000Z";
    const metadata = {
      planId,
      epicId: epicId,
      shippedAt: new Date().toISOString(),
      reviewedAt,
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

  it("getPlan returns metadata.reviewedAt when set in store", async () => {
    const planId = "reviewed-at-plan";
    const epicId = "epic-reviewed";
    const reviewedAt = "2025-03-09T12:00:00.000Z";
    const metadata = {
      planId,
      epicId,
      shippedAt: null,
      reviewedAt,
      complexity: "medium",
    };
    await mockPlanInsert(projectId, planId, {
      content: "# Reviewed Plan\n\n## Overview\n\nContent.",
      metadata: JSON.stringify(metadata),
    });
    mockTaskStoreListAll.mockResolvedValue([
      { id: epicId, status: "open", type: "epic" },
      { id: `${epicId}.1`, status: "closed", type: "task" },
    ]);

    const plan = await planService.getPlan(projectId, planId);
    expect(plan.metadata.reviewedAt).toBe(reviewedAt);
  });

  it("getPlan returns metadata.reviewedAt null when stored as null", async () => {
    const planId = "reviewed-null-plan";
    const epicId = "epic-null";
    const metadata = {
      planId,
      epicId,
      shippedAt: null,
      reviewedAt: null,
      complexity: "medium",
    };
    await mockPlanInsert(projectId, planId, {
      content: "# Null Reviewed\n\n## Overview\n\nContent.",
      metadata: JSON.stringify(metadata),
    });
    mockTaskStoreListAll.mockResolvedValue([{ id: epicId, status: "open", type: "epic" }]);

    const plan = await planService.getPlan(projectId, planId);
    expect(plan.metadata.reviewedAt).toBeNull();
  });

  it("getPlan returns currentVersionNumber and lastExecutedVersionNumber from store", async () => {
    const planId = "versioned-plan";
    const epicId = "epic-versioned";
    const metadata = {
      planId,
      epicId,
      shippedAt: null,
      complexity: "medium",
    };
    await mockPlanInsert(projectId, planId, {
      content: "# Versioned Plan\n\n## Overview\n\nContent.",
      metadata: JSON.stringify(metadata),
    });
    const proj = mockPlanStore.get(projectId);
    const row = proj?.get(planId);
    if (row) {
      row.current_version_number = 3;
      row.last_executed_version_number = 2;
    }
    mockTaskStoreListAll.mockResolvedValue([{ id: epicId, status: "open", type: "epic" }]);

    const plan = await planService.getPlan(projectId, planId);
    expect(plan.currentVersionNumber).toBe(3);
    expect(plan.lastExecutedVersionNumber).toBe(2);
  });

  it("updatePlan creates new plan version on each save; two saves yield three versions", async () => {
    const plan = await planService.createPlan(projectId, {
      title: "V Plan",
      content: "# V Plan\n\nInitial.",
      complexity: "low",
    });
    const planId = plan.metadata.planId as string;
    await planService.updatePlan(projectId, planId, { content: "# V Plan\n\nFirst save." });
    await planService.updatePlan(projectId, planId, { content: "# V Plan\n\nSecond save." });
    const versions = await mockListPlanVersions(projectId, planId);
    expect(versions).toHaveLength(3);
    const numbers = versions.map((v) => v.version_number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3]);
    const after = await planService.getPlan(projectId, planId);
    expect(after.currentVersionNumber).toBe(3);
    expect(after.content).toBe("# V Plan\n\nSecond save.");
    expect(after.lastExecutedVersionNumber).toBeUndefined();
  });

  it("updatePlan leaves last_executed_version_number unchanged", async () => {
    const plan = await planService.createPlan(projectId, {
      title: "Executed Plan",
      content: "# Executed Plan\n\nInitial.",
      complexity: "low",
    });
    const planId = plan.metadata.planId as string;
    const proj = mockPlanStore.get(projectId);
    const row = proj?.get(planId);
    expect(row).toBeDefined();
    row!.last_executed_version_number = 2;

    await planService.updatePlan(projectId, planId, { content: "# Executed Plan\n\nEdited." });
    const after = await planService.getPlan(projectId, planId);
    expect(after.currentVersionNumber).toBe(2);
    expect(after.lastExecutedVersionNumber).toBe(2);
  });

  it("updatePlan throws 404 PLAN_NOT_FOUND when plan does not exist", async () => {
    await expect(
      planService.updatePlan(projectId, "nonexistent-plan-id", { content: "# X\n\nBody." })
    ).rejects.toMatchObject({ statusCode: 404, code: "PLAN_NOT_FOUND" });
  });

  it("createPlan writes metadata with reviewedAt null", async () => {
    await planService.createPlan(projectId, {
      title: "Reviewed At Plan",
      content: "# Reviewed At\n\n## Overview\n\nContent.",
      complexity: "low",
    });

    expect(mockPlanInsert).toHaveBeenCalledWith(
      projectId,
      "reviewed-at-plan",
      expect.objectContaining({
        epic_id: "epic-123",
        content: expect.any(String),
        metadata: expect.any(String),
      })
    );
    const metadataArg = mockPlanInsert.mock.calls[0][2].metadata as string;
    const parsed = JSON.parse(metadataArg) as Record<string, unknown>;
    expect(parsed.reviewedAt).toBeNull();
  });

  it("clearReviewedAtIfNewTasksAdded clears reviewedAt when plan had it set", async () => {
    const plan = await planService.createPlan(projectId, {
      title: "Complete Plan",
      content: "# Complete\n\n## Overview\n\nContent.",
      complexity: "low",
    });
    const planId = plan.metadata.planId;
    const epicId = plan.metadata.epicId;
    expect(epicId).toBe("epic-123");

    const proj = mockPlanStore.get(projectId);
    const row = proj?.get(planId);
    expect(row).toBeDefined();
    (row!.metadata as Record<string, unknown>).reviewedAt = "2025-03-09T12:00:00.000Z";

    mockPlanUpdateMetadata.mockClear();
    await planService.clearReviewedAtIfNewTasksAdded(projectId, epicId!);

    expect(mockPlanGetByEpicId).toHaveBeenCalledWith(projectId, epicId);
    expect(mockPlanUpdateMetadata).toHaveBeenCalledWith(
      projectId,
      planId,
      expect.objectContaining({ reviewedAt: null })
    );
  });

  it("clearReviewedAtIfNewTasksAdded does nothing when plan has no reviewedAt", async () => {
    const plan = await planService.createPlan(projectId, {
      title: "In Review Plan",
      content: "# In Review\n\n## Overview\n\nContent.",
      complexity: "low",
    });
    const epicId = plan.metadata.epicId;
    expect((mockPlanStore.get(projectId)?.get(plan.metadata.planId)?.metadata as Record<string, unknown>).reviewedAt).toBeNull();

    mockPlanUpdateMetadata.mockClear();
    await planService.clearReviewedAtIfNewTasksAdded(projectId, epicId!);

    expect(mockPlanGetByEpicId).toHaveBeenCalledWith(projectId, epicId);
    expect(mockPlanUpdateMetadata).not.toHaveBeenCalled();
  });

  it("clearReviewedAtIfNewTasksAdded does nothing when no plan for epic", async () => {
    mockPlanGetByEpicId.mockResolvedValueOnce(null);
    await planService.clearReviewedAtIfNewTasksAdded(projectId, "nonexistent-epic");
    expect(mockPlanUpdateMetadata).not.toHaveBeenCalled();
  });

  describe("markPlanComplete", () => {
    it("sets reviewedAt and returns plan with status complete when all epic tasks are closed", async () => {
      const planId = "mark-complete-plan";
      const epicId = "epic-mark-complete";
      await mockPlanInsert(projectId, planId, {
        content: "# Mark Complete Plan\n\n## Overview\n\nContent.",
        metadata: JSON.stringify({
          planId,
          epicId,
          shippedAt: null,
          complexity: "medium",
        }),
      });
      mockTaskStoreListAll.mockResolvedValue([
        { id: epicId, status: "open", type: "epic" },
        { id: `${epicId}.1`, status: "closed", type: "task" },
        { id: `${epicId}.2`, status: "closed", type: "task" },
      ]);

      const plan = await planService.markPlanComplete(projectId, planId);

      expect(plan.status).toBe("complete");
      expect(plan.metadata.reviewedAt).toBeDefined();
      expect(typeof plan.metadata.reviewedAt).toBe("string");
      expect(mockPlanUpdateMetadata).toHaveBeenCalledWith(
        projectId,
        planId,
        expect.objectContaining({
          reviewedAt: expect.any(String),
        })
      );
    });

    it("returns 400 when plan has open tasks", async () => {
      const planId = "open-tasks-plan";
      const epicId = "epic-open";
      await mockPlanInsert(projectId, planId, {
        content: "# Open Tasks Plan\n\n## Overview\n\nContent.",
        metadata: JSON.stringify({
          planId,
          epicId,
          shippedAt: null,
          complexity: "medium",
        }),
      });
      mockTaskStoreListAll.mockResolvedValue([
        { id: epicId, status: "open", type: "epic" },
        { id: `${epicId}.1`, status: "closed", type: "task" },
        { id: `${epicId}.2`, status: "open", type: "task" },
      ]);

      await expect(planService.markPlanComplete(projectId, planId)).rejects.toMatchObject({
        statusCode: 400,
        code: "INVALID_INPUT",
        message: expect.stringContaining("open tasks"),
      });
      expect(mockPlanUpdateMetadata).not.toHaveBeenCalled();
    });

    it("is idempotent when reviewedAt already set (returns current plan)", async () => {
      const planId = "already-complete-plan";
      const epicId = "epic-already";
      const reviewedAt = "2025-03-09T12:00:00.000Z";
      await mockPlanInsert(projectId, planId, {
        content: "# Already Complete\n\n## Overview\n\nContent.",
        metadata: JSON.stringify({
          planId,
          epicId,
          shippedAt: null,
          reviewedAt,
          complexity: "medium",
        }),
      });
      mockTaskStoreListAll.mockResolvedValue([
        { id: epicId, status: "open", type: "epic" },
        { id: `${epicId}.1`, status: "closed", type: "task" },
      ]);

      const plan = await planService.markPlanComplete(projectId, planId);

      expect(plan.status).toBe("complete");
      expect(plan.metadata.reviewedAt).toBe(reviewedAt);
      expect(mockPlanUpdateMetadata).not.toHaveBeenCalled();
    });
  });
});
