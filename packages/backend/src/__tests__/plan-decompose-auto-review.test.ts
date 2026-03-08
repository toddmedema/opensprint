import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { PlanService } from "../services/plan.service.js";
import { ProjectService } from "../services/project.service.js";
import { TaskStoreService } from "../services/task-store.service.js";
import * as projectIndex from "../services/project-index.js";
import { DEFAULT_HIL_CONFIG } from "@opensprint/shared";

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

const mockInvoke = vi.fn();
const mockRegister = vi.fn();
const mockUnregister = vi.fn();

vi.mock("../services/agent-client.js", () => ({
  AgentClient: vi.fn().mockImplementation(() => ({
    invoke: (opts: unknown) => mockInvoke(opts),
  })),
}));

vi.mock("../services/active-agents.service.js", () => ({
  activeAgentsService: {
    register: (...args: unknown[]) => mockRegister(...args),
    unregister: (...args: unknown[]) => mockUnregister(...args),
    list: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../services/chat.service.js", () => ({
  ChatService: vi.fn().mockImplementation(() => ({
    syncPrdFromPlanShip: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../websocket/index.js", () => ({
  broadcastToProject: vi.fn(),
}));

const planDecomposeTaskStoreMod = await import("../services/task-store.service.js");
const planDecomposePostgresOk =
  (planDecomposeTaskStoreMod as { _postgresAvailable?: boolean })._postgresAvailable ?? false;

describe.skipIf(!planDecomposePostgresOk)("Plan decompose with auto-review", () => {
  let planService: PlanService;
  let projectService: ProjectService;
  let taskStore: TaskStoreService;
  let tempDir: string;
  let projectId: string;
  let repoPath: string;
  let originalHome: string | undefined;

  afterAll(async () => {
    const mod = (await import("../services/task-store.service.js")) as { _testPool?: { end: () => Promise<void> } };
    if (mod._testPool) await mod._testPool.end();
  });

  beforeEach(async () => {
    const mod = (await import("../services/task-store.service.js")) as unknown as {
      _resetSharedDb?: () => void | Promise<void>;
    };
    await mod._resetSharedDb?.();

    vi.clearAllMocks();
    mockInvoke.mockReset();
    planService = new PlanService();
    projectService = new ProjectService();
    taskStore = new TaskStoreService();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-plan-decompose-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    repoPath = path.join(tempDir, "test-project");
    await fs.mkdir(repoPath, { recursive: true });
    execSync("git init", { cwd: repoPath });

    const project = await projectService.createProject({
      name: "Auto-Review Test",
      repoPath,
      simpleComplexityAgent: { type: "cursor", model: "claude-sonnet-4", cliCommand: null },
      complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });
    projectId = project.id;

    // Initialize task store
    await taskStore.init();

    // Create SPEC.md (Sketch phase output)
    const prd = {
      version: 1,
      sections: {
        executive_summary: {
          content: "Test app",
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
    // Do not write legacy spec-metadata.json; PrdService.loadPrd reads SPEC.md and expects
    // either DB prd_metadata or no legacy file (migration guard would throw if legacy file existed).
  });

  afterEach(async () => {
    // Remove project from index while still in tempDir (cleans test index)
    try {
      await projectIndex.removeProject(projectId);
    } catch {
      // ignore if already missing
    }
    process.env.HOME = originalHome;
    // Defensive: remove from real index in case of any leakage (e.g. HOME not isolated)
    try {
      await projectIndex.removeProject(projectId);
    } catch {
      // ignore
    }
    // Remove any leftover "Auto-Review Test" from real index (contamination from earlier runs)
    try {
      const projects = await projectIndex.getProjects();
      for (const p of projects) {
        if (p.name === "Auto-Review Test") await projectIndex.removeProject(p.id);
      }
    } catch {
      // ignore
    }
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore ENOTEMPTY and similar on some systems when removing .git
    }
  });

  it(
    "decompose creates plans with markdown and mockups only; auto-review skipped when no tasks",
    { timeout: 15000 },
    async () => {
      mockInvoke.mockResolvedValueOnce({
        content: JSON.stringify({
          plans: [
            {
              title: "Backend API",
              content:
                "# Backend API\n\n## Overview\n\nREST API.\n\n## Acceptance Criteria\n\n- Endpoints work",
              complexity: "medium",
              mockups: [{ title: "API", content: "GET /api" }],
            },
          ],
        }),
      });

      const result = await planService.decomposeFromPrd(projectId);

      expect(result.created).toBe(1);
      expect(result.plans).toHaveLength(1);
      expect(result.plans[0].taskCount).toBe(0);

      // Only decompose is invoked; auto-review is skipped when no tasks were created
      expect(mockInvoke).toHaveBeenCalledTimes(1);

      const allIssues = await taskStore.listAll(projectId);
      const implTasks = allIssues.filter(
        (i: { id: string; issue_type?: string; type?: string }) => (i.issue_type ?? i.type) !== "epic"
      );
      expect(implTasks.length).toBe(0);
    }
  );

  it("continues when auto-review agent fails (best-effort)", { timeout: 15000 }, async () => {
    mockInvoke.mockResolvedValueOnce({
      content: JSON.stringify({
        plans: [
          {
            title: "Simple Feature",
            content: "# Simple\n\nOverview.",
            complexity: "low",
            mockups: [{ title: "UI", content: "Box" }],
          },
        ],
      }),
    });

    const result = await planService.decomposeFromPrd(projectId);

    expect(result.created).toBe(1);
    expect(result.plans).toHaveLength(1);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("skips auto-review when no implementation tasks exist", { timeout: 15000 }, async () => {
    mockInvoke.mockResolvedValueOnce({
      content: JSON.stringify({
        plans: [
          {
            title: "Empty Plan",
            content: "# Empty\n\nNo tasks.",
            complexity: "low",
            mockups: [{ title: "UI", content: "Box" }],
            tasks: [],
          },
        ],
      }),
    });

    const result = await planService.decomposeFromPrd(projectId);

    expect(result.created).toBe(1);
    // Auto-review is skipped when validTaskIds.size === 0, so invoke is only called once
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  describe("Plan phase agent registry", () => {
    it("should register and unregister for Feature decomposition", { timeout: 15000 }, async () => {
      mockInvoke.mockResolvedValueOnce({
        content: JSON.stringify({
          plans: [
            {
              title: "Registry Test",
              content: "# Registry\n\nTest.",
              complexity: "low",
              mockups: [{ title: "UI", content: "Box" }],
              tasks: [],
            },
          ],
        }),
      });

      const result = await planService.decomposeFromPrd(projectId);

      expect(result.created).toBe(1);
      // Decompose: register before invoke, unregister in finally
      expect(mockRegister).toHaveBeenCalledWith(
        expect.stringMatching(/^plan-decompose-.*-/),
        projectId,
        "plan",
        "planner",
        "Feature decomposition",
        expect.any(String),
        undefined,
        undefined,
        undefined,
        undefined
      );
      expect(mockUnregister).toHaveBeenCalledWith(mockRegister.mock.calls[0][0]);
    });

    it(
      "should register and unregister for Feature decomposition only (auto-review skipped when no tasks)",
      { timeout: 15000 },
      async () => {
        mockInvoke.mockResolvedValueOnce({
          content: JSON.stringify({
            plans: [
              {
                title: "Auto-Review Registry Test",
                content: "# Test\n\nContent.",
                complexity: "low",
                mockups: [{ title: "UI", content: "Box" }],
              },
            ],
          }),
        });

        await planService.decomposeFromPrd(projectId);

        // Only decompose is invoked; auto-review is skipped when no tasks created
        expect(mockRegister).toHaveBeenCalledTimes(1);
        expect(mockUnregister).toHaveBeenCalledTimes(1);

        const decomposeCall = mockRegister.mock.calls.find((c) =>
          c[0].startsWith("plan-decompose-")
        );
        expect(decomposeCall).toBeDefined();
        expect(decomposeCall).toEqual([
          expect.stringMatching(/^plan-decompose-.*-/),
          projectId,
          "plan",
          "planner",
          "Feature decomposition",
          expect.any(String),
          undefined,
          undefined,
          undefined,
          undefined,
        ]);
      }
    );

    it("should unregister even when decompose agent throws", { timeout: 15000 }, async () => {
      mockInvoke.mockRejectedValueOnce(new Error("Agent failed"));

      await expect(planService.decomposeFromPrd(projectId)).rejects.toThrow();

      expect(mockRegister).toHaveBeenCalledTimes(1);
      expect(mockUnregister).toHaveBeenCalledTimes(1);
      expect(mockUnregister).toHaveBeenCalledWith(mockRegister.mock.calls[0][0]);
    });
  });

  it(
    "does not create tasks at decompose (markdown and mockups only)",
    { timeout: 15000 },
    async () => {
      mockInvoke.mockResolvedValueOnce({
        content: JSON.stringify({
          plans: [
            {
              title: "New Feature",
              content: "# New\n\nOverview.",
              complexity: "medium",
              mockups: [{ title: "UI", content: "Box" }],
            },
          ],
        }),
      });

      const result = await planService.decomposeFromPrd(projectId);

      expect(result.created).toBe(1);
      expect(result.plans[0].taskCount).toBe(0);
      expect(mockInvoke).toHaveBeenCalledTimes(1);

      const allIssues = await taskStore.listAll(projectId);
      const implTasks = allIssues.filter(
        (i: { id: string; issue_type?: string }) =>
          (i.issue_type ?? i.type) !== "epic" && !i.id.endsWith(".0")
      );
      // All implementation tasks should remain open (none closed by auto-review)
      expect(implTasks.every((t: { status: string }) => t.status === "open")).toBe(true);
    }
  );

  it(
    "persists dependsOnPlans as ## Dependencies section and dependency graph has edges",
    {
      timeout: 15000,
    },
    async () => {
      mockInvoke
        .mockResolvedValueOnce({
          content: JSON.stringify({
            plans: [
              {
                title: "Backend API",
                content:
                  "# Backend API\n\n## Overview\n\nREST API.\n\n## Acceptance Criteria\n\n- Endpoints work.\n\n## Dependencies\n\nNone.",
                complexity: "medium",
                mockups: [{ title: "API", content: "GET /api" }],
                tasks: [
                  {
                    title: "Create health endpoint",
                    description: "GET /health",
                    priority: 0,
                    dependsOn: [],
                  },
                ],
              },
              {
                title: "Dashboard",
                content:
                  "# Dashboard\n\n## Overview\n\nUI dashboard.\n\n## Acceptance Criteria\n\n- Shows data.",
                complexity: "medium",
                dependsOnPlans: ["backend-api"],
                mockups: [{ title: "Dashboard", content: "Layout" }],
                tasks: [
                  {
                    title: "Build dashboard page",
                    description: "React page",
                    priority: 0,
                    dependsOn: [],
                  },
                ],
              },
            ],
          }),
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({ taskIdsToClose: [], reason: "Nothing implemented" }),
        });

      const result = await planService.decomposeFromPrd(projectId);

      expect(result.created).toBe(2);
      expect(result.plans).toHaveLength(2);

      const dashboardRow = await taskStore.planGet(projectId, "dashboard");
      expect(dashboardRow).not.toBeNull();
      expect(dashboardRow!.content).toContain("## Dependencies");
      expect(dashboardRow!.content).toContain("backend-api");

      const graph = await planService.listPlansWithDependencyGraph(projectId);
      expect(graph.edges.some((e) => e.from === "backend-api" && e.to === "dashboard")).toBe(true);
    }
  );
});
