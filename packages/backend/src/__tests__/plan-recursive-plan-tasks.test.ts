import { describe, it, expect, beforeEach, vi } from "vitest";
import { DEFAULT_HIL_CONFIG } from "@opensprint/shared";
import { broadcastToProject } from "../websocket/index.js";
import { PlanCrudService, type PlanCrudStore } from "../services/plan-crud.service.js";
import { PlanDecomposeGenerateService } from "../services/plan-decompose-generate.service.js";
import { ProjectService } from "../services/project.service.js";
import { PrdService } from "../services/prd.service.js";

const { mockEvaluatePlanComplexity } = vi.hoisted(() => ({
  mockEvaluatePlanComplexity: vi.fn(),
}));

vi.mock("../services/plan/plan-complexity-gate.js", () => ({
  evaluatePlanComplexity: (...args: unknown[]) => mockEvaluatePlanComplexity(...args),
}));

const mockInvokePlanningAgent = vi.fn();
vi.mock("../services/agent.service.js", () => ({
  agentService: {
    invokePlanningAgent: (...args: unknown[]) => mockInvokePlanningAgent(...args),
  },
}));

vi.mock("../services/plan/plan-repo-guard.js", () => ({
  runPlannerWithRepoGuard: vi.fn(async (opts: { run: () => Promise<unknown> }) => opts.run()),
}));

vi.mock("../services/agent-instructions.service.js", () => ({
  getCombinedInstructions: vi.fn().mockResolvedValue("## Planner instructions\n"),
}));

vi.mock("../websocket/index.js", () => ({
  broadcastToProject: vi.fn(),
}));

const PROJECT_ID = "proj-rec-plan-tasks";

interface IssueRow {
  id: string;
  title: string;
  type?: string;
  issue_type?: string;
  status: string;
  sourcePlanVersionNumber?: number;
}

interface MockPlanRow {
  content: string;
  metadata: Record<string, unknown>;
  shipped_content: string | null;
  updated_at: string;
  current_version_number: number;
  last_executed_version_number: number | null;
  parent_plan_id: string | null;
  epic_id: string;
}

function createMockTaskStore() {
  const plans = new Map<string, MockPlanRow>();
  const issuesByProject = new Map<string, IssueRow[]>();
  let epicCounter = 0;
  let taskCounter = 0;

  const getIssues = (projectId: string) => {
    let list = issuesByProject.get(projectId);
    if (!list) {
      list = [];
      issuesByProject.set(projectId, list);
    }
    return list;
  };

  const store: PlanCrudStore = {
    planGet: vi.fn(async (_projectId: string, planId: string) => {
      const row = plans.get(planId);
      if (!row) return null;
      return {
        content: row.content,
        metadata: row.metadata,
        shipped_content: row.shipped_content,
        updated_at: row.updated_at,
        current_version_number: row.current_version_number,
        last_executed_version_number: row.last_executed_version_number,
        parent_plan_id: row.parent_plan_id,
      };
    }),
    planListIds: vi.fn(async () => Array.from(plans.keys())),
    planListAllForProject: vi.fn(async () =>
      Array.from(plans.entries()).map(([planId, row]) => ({
        plan_id: planId,
        content: row.content,
        metadata: row.metadata,
        shipped_content: row.shipped_content,
        updated_at: row.updated_at,
        current_version_number: row.current_version_number,
        last_executed_version_number: row.last_executed_version_number,
        parent_plan_id: row.parent_plan_id,
      }))
    ),
    planListByParent: vi.fn(async (_projectId: string, parentPlanId: string) =>
      Array.from(plans.entries())
        .filter(([, row]) => row.parent_plan_id === parentPlanId)
        .map(([id]) => id)
    ),
    listAll: vi.fn(async (projectId: string) => getIssues(projectId)),
    show: vi.fn(
      async () => ({ id: "", title: "", status: "open", issue_type: "epic", type: "epic" }) as never
    ),
    create: vi.fn(async (_projectId: string, title: string, opts?: Record<string, unknown>) => {
      epicCounter++;
      const id = `os-epic-${epicCounter}`;
      getIssues(_projectId).push({
        id,
        title,
        type: (opts?.type as string) ?? "epic",
        issue_type: (opts?.type as string) ?? "epic",
        status: "blocked",
      });
      return { id };
    }),
    createMany: vi.fn(
      async (
        projectId: string,
        inputs: Array<
          Record<string, unknown> & {
            title: string;
            parentId?: string;
            extra?: { sourcePlanVersionNumber?: number };
          }
        >
      ) => {
        const list = getIssues(projectId);
        return inputs.map((input) => {
          taskCounter++;
          const parentId = String(input.parentId ?? "");
          const id = `${parentId}.${taskCounter}`;
          const ver = input.extra?.sourcePlanVersionNumber;
          list.push({
            id,
            title: input.title,
            type: "task",
            issue_type: "task",
            status: "open",
            ...(typeof ver === "number" ? { sourcePlanVersionNumber: ver } : {}),
          });
          return { id };
        });
      }
    ),
    update: vi.fn(async () => {}),
    addDependencies: vi.fn(async () => {}),
    addLabel: vi.fn(async () => {}),
    planInsert: vi.fn(
      async (
        _projectId: string,
        planId: string,
        data: { epic_id: string; content: string; metadata: string; parent_plan_id?: string | null }
      ) => {
        const metadata = JSON.parse(data.metadata) as Record<string, unknown>;
        plans.set(planId, {
          content: data.content,
          metadata,
          shipped_content: null,
          updated_at: new Date().toISOString(),
          current_version_number: 1,
          last_executed_version_number: null,
          parent_plan_id: data.parent_plan_id ?? null,
          epic_id: data.epic_id,
        });
      }
    ),
    planUpdateContent: vi.fn(async () => {}),
    planUpdateMetadata: vi.fn(
      async (_projectId: string, planId: string, metadata: Record<string, unknown>) => {
        const row = plans.get(planId);
        if (row) row.metadata = metadata;
      }
    ),
    planGetByEpicId: vi.fn(async () => null),
    delete: vi.fn(async () => {}),
    closeMany: vi.fn(async () => {}),
    planDelete: vi.fn(async (_projectId: string, planId: string) => plans.delete(planId)),
    listPlanVersions: vi.fn(async () => []),
    planVersionInsert: vi.fn(async (data: Record<string, unknown>) => ({
      id: 1,
      project_id: data.project_id as string,
      plan_id: data.plan_id as string,
      version_number: data.version_number as number,
      title: (data.title as string) ?? null,
      content: data.content as string,
      metadata: (data.metadata as string) ?? null,
      created_at: new Date().toISOString(),
      is_executed_version: false,
    })),
    planVersionList: vi.fn(async () => []),
    planVersionGetByVersionNumber: vi.fn(async () => {
      throw new Error("Not implemented");
    }),
    planVersionUpdateContent: vi.fn(async () => {}),
    planVersionSetExecutedVersion: vi.fn(async () => {}),
    planUpdateVersionNumbers: vi.fn(async () => {}),
  };

  return { store, plans };
}

function createProjectService(): ProjectService {
  return {
    getProject: vi.fn(async () => ({ repoPath: "/tmp/rec-plan-repo" })),
    getSettings: vi.fn(async () => ({
      aiAutonomyLevel: "full",
      hilConfig: DEFAULT_HIL_CONFIG,
      simpleComplexityAgent: { type: "cursor" as const, model: "test", cliCommand: null },
      complexComplexityAgent: { type: "cursor" as const, model: "test", cliCommand: null },
    })),
  } as unknown as ProjectService;
}

function createPrdService(): PrdService {
  return {
    getPrd: vi.fn(async () => ({ sections: [] })),
  } as unknown as PrdService;
}

describe("PlanDecomposeGenerateService.planTasks recursive sub-plans", () => {
  let crud: PlanCrudService;
  let decompose: PlanDecomposeGenerateService;
  let store: PlanCrudStore;

  beforeEach(() => {
    vi.clearAllMocks();
    const created = createMockTaskStore();
    store = created.store;
    const projectService = createProjectService();
    crud = new PlanCrudService(store, projectService);
    decompose = new PlanDecomposeGenerateService(
      {
        taskStore: store as never,
        projectService,
        prdService: createPrdService(),
        createPlan: (projectId, body) =>
          crud.createPlan(projectId, body as Parameters<PlanCrudService["createPlan"]>[1]),
        getPlan: (projectId, planId, opts) => crud.getPlan(projectId, planId, opts),
        ensurePlanHasAtLeastOneVersion: (projectId, planId) =>
          crud.ensurePlanHasAtLeastOneVersion(projectId, planId),
      },
      {}
    );

    mockInvokePlanningAgent.mockImplementation(
      (opts: { tracking?: { label?: string; planId?: string } }) => {
        if (opts.tracking?.label === "Task generation") {
          const pid = opts.tracking?.planId ?? "plan";
          return Promise.resolve({
            content: JSON.stringify({
              tasks: [
                {
                  title: `Implement ${pid}`,
                  description: "Scoped work",
                  priority: 1,
                  dependsOn: [],
                },
              ],
            }),
          });
        }
        return Promise.resolve({ content: JSON.stringify({ complexity: "medium" }) });
      }
    );
  });

  it("persists a complete three-task decomposition without invoking task generation again", async () => {
    const parent = await crud.createPlan(PROJECT_ID, {
      title: "Scenario landing pages",
      content:
        "# Scenario landing pages\n\n## Overview\nStatic pages and content for all built-in scenarios, with sitemap discovery.",
      complexity: "medium",
    });
    const tasks = [
      {
        title: "Build generator and templates",
        description: "Implement static output and its focused tests",
        priority: 1,
        dependsOn: [],
        files: { create: ["scripts/scenarios.js"] },
      },
      {
        title: "Author all scenario content",
        description: "Write and validate the complete scenario catalog",
        priority: 1,
        dependsOn: ["Build generator and templates"],
      },
      {
        title: "Integrate production discovery",
        description: "Wire builds, sitemap, and navigation; verify the complete journey",
        priority: 1,
        dependsOn: ["Author all scenario content"],
      },
    ];
    mockEvaluatePlanComplexity.mockResolvedValue({ strategy: "tasks", tasks });
    mockInvokePlanningAgent.mockClear();

    const result = await decompose.planTasks(PROJECT_ID, parent.metadata.planId);

    expect(result.totalTasksCreated).toBe(3);
    expect(result.hasGeneratedPlanTasksForCurrentVersion).toBe(true);
    expect(await store.planListByParent(PROJECT_ID, parent.metadata.planId)).toEqual([]);
    expect(store.createMany).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.arrayContaining(
        tasks.map((task) =>
          expect.objectContaining({ title: task.title, extra: { sourcePlanVersionNumber: 1 } })
        )
      )
    );
    expect(store.addDependencies).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.arrayContaining([expect.objectContaining({ type: "blocks" })])
    );
    expect(store.addLabel).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.any(String),
      'files:{"create":["scripts/scenarios.js"]}'
    );
    expect(
      mockInvokePlanningAgent.mock.calls.some(
        ([opts]) => opts.tracking?.label === "Task generation"
      )
    ).toBe(false);
  });

  it("splits into sub-plans, recurses, and marks the parent when all children have tasks", async () => {
    const parent = await crud.createPlan(PROJECT_ID, {
      title: "Split Root",
      content: "# Split Root\n\n## Overview\n\nLarge feature.",
      complexity: "high",
    });
    const rootId = parent.metadata.planId;

    mockEvaluatePlanComplexity.mockImplementation(
      async (opts: { planId?: string; planContent?: string }) => {
        if (opts.planId === rootId) {
          return {
            strategy: "sub_plans" as const,
            subPlans: [
              {
                title: "First Stream",
                overview: "First",
                content: "## Technical\n\nFirst stream body.",
                dependsOnPlans: [],
              },
              {
                title: "Second Stream",
                overview: "Second",
                content: "## Technical\n\nSecond stream body.",
                dependsOnPlans: ["first-stream"],
              },
            ],
          };
        }
        return { strategy: "tasks" as const, tasks: [] };
      }
    );

    const result = await decompose.planTasks(PROJECT_ID, rootId);

    expect(mockEvaluatePlanComplexity).toHaveBeenCalled();
    expect(mockEvaluatePlanComplexity.mock.calls.length).toBeGreaterThanOrEqual(3);

    const childIds = await store.planListByParent(PROJECT_ID, rootId);
    expect(childIds).toHaveLength(2);

    const first = await crud.getPlan(PROJECT_ID, "first-stream");
    const second = await crud.getPlan(PROJECT_ID, "second-stream");
    expect(first.taskCount).toBe(1);
    expect(second.taskCount).toBe(1);
    expect(first.hasGeneratedPlanTasksForCurrentVersion).toBe(true);
    expect(second.hasGeneratedPlanTasksForCurrentVersion).toBe(true);

    expect(result.hasGeneratedPlanTasksForCurrentVersion).toBe(true);
    expect(result.lastTaskGenerationVersionNumber).toBe(1);
    expect(result.totalTasksCreated).toBe(2);
    expect(result.failedPlanIds).toEqual([]);
    expect(result.successPlanIds).toEqual(
      expect.arrayContaining(["first-stream", "second-stream"])
    );
    expect(result.successPlanIds).toHaveLength(2);

    const childGateCalls = mockEvaluatePlanComplexity.mock.calls.filter(
      (c) => (c[0] as { planId?: string }).planId === "first-stream"
    );
    expect(childGateCalls.length).toBeGreaterThanOrEqual(1);
    const firstChildOpts = childGateCalls[0]![0] as {
      siblingPlanSummaries?: string;
      ancestorChainSummary?: string;
    };
    expect(firstChildOpts.siblingPlanSummaries).toBeDefined();
    expect(firstChildOpts.siblingPlanSummaries).toContain("second-stream");
    expect(firstChildOpts.ancestorChainSummary).toContain("Split Root");

    const firstStreamTaskCall = mockInvokePlanningAgent.mock.calls.find(
      (c) =>
        (c[0] as { tracking?: { label?: string; planId?: string } }).tracking?.label ===
          "Task generation" &&
        (c[0] as { tracking?: { planId?: string } }).tracking?.planId === "first-stream"
    );
    const firstStreamContent = (
      firstStreamTaskCall?.[0] as { messages?: Array<{ content?: string }> } | undefined
    )?.messages?.[0]?.content;
    expect(firstStreamContent).toContain("## Hierarchy: Ancestor chain");
    expect(firstStreamContent).toContain("Split Root");
    expect(firstStreamContent).toContain("Large feature");
    expect(firstStreamContent).toContain("## Feature Plan");

    const secondStreamTaskCall = mockInvokePlanningAgent.mock.calls.find(
      (c) =>
        (c[0] as { tracking?: { label?: string; planId?: string } }).tracking?.label ===
          "Task generation" &&
        (c[0] as { tracking?: { planId?: string } }).tracking?.planId === "second-stream"
    );
    const secondStreamContent = (
      secondStreamTaskCall?.[0] as { messages?: Array<{ content?: string }> } | undefined
    )?.messages?.[0]?.content;
    expect(secondStreamContent).toContain("## Hierarchy: Sibling sub-plans");
    expect(secondStreamContent).toContain("**1** implementation task");
    expect(secondStreamContent).toContain("first-stream");
    expect(secondStreamContent).toContain("Implement first-stream");
  });

  it("continues when a middle child fails: siblings succeed, parent incomplete, failed child retryable", async () => {
    const parent = await crud.createPlan(PROJECT_ID, {
      title: "Partial Root",
      content: "# Partial Root\n\n## Overview\n\nThree streams.",
      complexity: "high",
    });
    const rootId = parent.metadata.planId;

    mockEvaluatePlanComplexity.mockImplementation(
      async (opts: { planId?: string; planContent?: string }) => {
        if (opts.planId === rootId) {
          return {
            strategy: "sub_plans" as const,
            subPlans: [
              {
                title: "Alpha Stream",
                overview: "A",
                content: "## Technical\n\nAlpha.",
                dependsOnPlans: [],
              },
              {
                title: "Beta Stream",
                overview: "B",
                content: "## Technical\n\nBeta.",
                dependsOnPlans: [],
              },
              {
                title: "Gamma Stream",
                overview: "C",
                content: "## Technical\n\nGamma.",
                dependsOnPlans: [],
              },
            ],
          };
        }
        return { strategy: "tasks" as const, tasks: [] };
      }
    );

    mockInvokePlanningAgent.mockImplementation(
      (opts: { tracking?: { label?: string; planId?: string } }) => {
        if (opts.tracking?.label === "Task generation" && opts.tracking?.planId === "beta-stream") {
          return Promise.reject(new Error("Simulated planner failure for middle child"));
        }
        if (opts.tracking?.label === "Task generation") {
          const pid = opts.tracking?.planId ?? "plan";
          return Promise.resolve({
            content: JSON.stringify({
              tasks: [
                {
                  title: `Implement ${pid}`,
                  description: "Scoped work",
                  priority: 1,
                  dependsOn: [],
                },
              ],
            }),
          });
        }
        return Promise.resolve({ content: JSON.stringify({ complexity: "medium" }) });
      }
    );

    const result = await decompose.planTasks(PROJECT_ID, rootId);

    expect(result.totalTasksCreated).toBe(2);
    expect(result.failedPlanIds).toEqual(["beta-stream"]);
    expect(result.successPlanIds).toEqual(["alpha-stream", "gamma-stream"]);
    expect(result.hasGeneratedPlanTasksForCurrentVersion).toBe(false);
    expect(result.lastTaskGenerationVersionNumber).toBeUndefined();

    const alpha = await crud.getPlan(PROJECT_ID, "alpha-stream");
    const beta = await crud.getPlan(PROJECT_ID, "beta-stream");
    const gamma = await crud.getPlan(PROJECT_ID, "gamma-stream");
    expect(alpha.hasGeneratedPlanTasksForCurrentVersion).toBe(true);
    expect(alpha.lastTaskGenerationVersionNumber).toBe(1);
    expect(beta.hasGeneratedPlanTasksForCurrentVersion).toBe(false);
    expect(beta.lastTaskGenerationVersionNumber).toBeUndefined();
    expect(gamma.hasGeneratedPlanTasksForCurrentVersion).toBe(true);

    const failureBroadcasts = vi
      .mocked(broadcastToProject)
      .mock.calls.filter(
        (c) =>
          (c[1] as { type?: string; planTasksGenerationFailed?: boolean })?.type ===
            "plan.updated" &&
          (c[1] as { planTasksGenerationFailed?: boolean }).planTasksGenerationFailed === true
      );
    expect(
      failureBroadcasts.some((c) => (c[1] as { planId?: string }).planId === "beta-stream")
    ).toBe(true);
  });

  it("rejects cyclic depends_on_plans between sibling sub-plans", async () => {
    const parent = await crud.createPlan(PROJECT_ID, {
      title: "Cycle Root",
      content: "# Cycle Root\n\n## Overview\n\nBad deps.",
      complexity: "high",
    });
    const rootId = parent.metadata.planId;

    mockEvaluatePlanComplexity.mockResolvedValue({
      strategy: "sub_plans" as const,
      subPlans: [
        {
          title: "Plan A",
          overview: "A",
          content: "## Technical\n\nA.",
          dependsOnPlans: ["plan-b"],
        },
        {
          title: "Plan B",
          overview: "B",
          content: "## Technical\n\nB.",
          dependsOnPlans: ["plan-a"],
        },
      ],
    });

    await expect(decompose.planTasks(PROJECT_ID, rootId)).rejects.toMatchObject({
      statusCode: 400,
      code: "PLAN_CIRCULAR_DEPENDENCY",
      message: expect.stringMatching(/cycle/i),
    });
  });

  it("single-node tasks path still runs task generation when gate returns leaf strategy", async () => {
    const plan = await crud.createPlan(PROJECT_ID, {
      title: "Leaf Only",
      content: "# Leaf Only\n\n## Overview\n\nSingle scope.",
      complexity: "low",
    });
    const planId = plan.metadata.planId;

    mockEvaluatePlanComplexity.mockResolvedValue({ strategy: "tasks", tasks: [] });

    const result = await decompose.planTasks(PROJECT_ID, planId);

    expect(result.taskCount).toBe(1);
    expect(result.hasGeneratedPlanTasksForCurrentVersion).toBe(true);
    expect(result.totalTasksCreated).toBe(1);
    expect(result.failedPlanIds).toEqual([]);
    expect(result.successPlanIds).toEqual([planId]);
    const taskCalls = mockInvokePlanningAgent.mock.calls.filter(
      (c) => (c[0] as { tracking?: { label?: string } }).tracking?.label === "Task generation"
    );
    expect(taskCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("at max plan depth (4) skips complexity gate and adds consolidation text to task generation", async () => {
    const d1 = await crud.createPlan(PROJECT_ID, {
      title: "L1 MaxDepth",
      content: "# L1\n\n.",
      complexity: "low",
    });
    const d2 = await crud.createPlan(PROJECT_ID, {
      title: "L2 MaxDepth",
      content: "# L2\n\n.",
      parentPlanId: d1.metadata.planId,
    });
    const d3 = await crud.createPlan(PROJECT_ID, {
      title: "L3 MaxDepth",
      content: "# L3\n\n.",
      parentPlanId: d2.metadata.planId,
    });
    const d4 = await crud.createPlan(PROJECT_ID, {
      title: "L4 MaxDepth",
      content: "# L4\n\nLeaf at max depth.",
      parentPlanId: d3.metadata.planId,
    });
    expect(d4.metadata.depth).toBe(4);

    mockEvaluatePlanComplexity.mockResolvedValue({
      strategy: "sub_plans" as const,
      subPlans: [
        {
          title: "Should Never Create",
          overview: "x",
          content: "## Technical\n\n.",
          dependsOnPlans: [],
        },
      ],
    });

    const leafId = d4.metadata.planId;
    const result = await decompose.planTasks(PROJECT_ID, leafId);

    expect(mockEvaluatePlanComplexity).not.toHaveBeenCalled();
    const taskCalls = mockInvokePlanningAgent.mock.calls.filter(
      (c) =>
        (c[0] as { tracking?: { label?: string; planId?: string } }).tracking?.label ===
        "Task generation"
    );
    expect(taskCalls.length).toBeGreaterThanOrEqual(1);
    const userContent = (taskCalls[0]![0] as { messages?: Array<{ content?: string }> } | undefined)
      ?.messages?.[0]?.content;
    expect(userContent).toContain("Maximum plan depth");
    expect(result.hasGeneratedPlanTasksForCurrentVersion).toBe(true);
    expect(result.totalTasksCreated).toBe(1);
    expect(result.successPlanIds).toEqual([leafId]);
  });
});
