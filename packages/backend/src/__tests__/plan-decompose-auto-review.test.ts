import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { PlanService } from "../services/plan.service.js";
import { ProjectService } from "../services/project.service.js";
import { TaskStoreService } from "../services/task-store.service.js";
import * as projectIndex from "../services/project-index.js";
import { DEFAULT_HIL_CONFIG, OPENSPRINT_PATHS } from "@opensprint/shared";

// Mock TaskStoreService with in-memory sql.js database (shared across all instances)
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
      sharedDb.run("DELETE FROM plans");
    },
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

describe("Plan decompose with auto-review", () => {
  let planService: PlanService;
  let projectService: ProjectService;
  let taskStore: TaskStoreService;
  let tempDir: string;
  let projectId: string;
  let repoPath: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    const mod = (await import("../services/task-store.service.js")) as unknown as {
      _resetSharedDb?: () => void;
    };
    mod._resetSharedDb?.();

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

    // Create PRD
    const prdPath = path.join(repoPath, OPENSPRINT_PATHS.prd);
    await fs.mkdir(path.dirname(prdPath), { recursive: true });
    await fs.writeFile(
      prdPath,
      JSON.stringify({
        version: 1,
        sections: {
          executive_summary: {
            content: "Test app",
            version: 1,
            updated_at: new Date().toISOString(),
          },
        },
      }),
      "utf-8"
    );
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
    "invokes auto-review agent after decompose and closes identified tasks",
    { timeout: 15000 },
    async () => {
      // First invoke: decompose response
      const decomposeResponse = {
        content: JSON.stringify({
          plans: [
            {
              title: "Backend API",
              content:
                "# Backend API\n\n## Overview\n\nREST API.\n\n## Acceptance Criteria\n\n- Endpoints work",
              complexity: "medium",
              mockups: [{ title: "API", content: "GET /api" }],
              tasks: [
                {
                  title: "Create health endpoint",
                  description: "GET /health",
                  priority: 0,
                  dependsOn: [],
                },
                {
                  title: "Create users endpoint",
                  description: "GET /users",
                  priority: 1,
                  dependsOn: [],
                },
              ],
            },
          ],
        }),
      };

      // Second invoke: auto-review response (mark first task as already implemented)
      let taskIdToClose = "";
      mockInvoke
        .mockResolvedValueOnce(decomposeResponse)
        .mockImplementation(async (_opts: { prompt?: string }) => {
          // When auto-review runs, we need to return task IDs from the created plans
          // We don't know them until after decompose - so we get them from task store
          const allIssues = await taskStore.listAll(projectId);
          const implTasks = allIssues.filter(
            (i: { id: string; title?: string; issue_type?: string }) =>
              (i.issue_type ?? i.type) !== "epic" &&
              i.title !== "Plan approval gate" &&
              !i.id.endsWith(".0")
          );
          taskIdToClose = implTasks[0]?.id ?? "";
          return {
            content: JSON.stringify({
              taskIdsToClose: taskIdToClose ? [taskIdToClose] : [],
              reason: "Health endpoint already exists in src/server.ts",
            }),
          };
        });

      const result = await planService.decomposeFromPrd(projectId);

      expect(result.created).toBe(1);
      expect(result.plans).toHaveLength(1);

      // Verify agent was invoked twice (decompose + auto-review)
      expect(mockInvoke).toHaveBeenCalledTimes(2);

      // Verify auto-review closed the identified task
      const allIssues = await taskStore.listAll(projectId);
      const closedTasks = allIssues.filter((i: { status: string }) => i.status === "closed");
      // Gate task + one auto-reviewed task = at least 2 closed
      expect(closedTasks.length).toBeGreaterThanOrEqual(1);

      const implTasks = allIssues.filter(
        (i: { id: string; title?: string; issue_type?: string }) =>
          (i.issue_type ?? i.type) !== "epic" &&
          i.title !== "Plan approval gate" &&
          !i.id.endsWith(".0")
      );
      // At least one implementation task should be closed by auto-review
      const autoReviewed = implTasks.filter((i: { status: string }) => i.status === "closed");
      expect(autoReviewed.length).toBeGreaterThanOrEqual(1);
    }
  );

  it("continues when auto-review agent fails (best-effort)", { timeout: 15000 }, async () => {
    mockInvoke
      .mockResolvedValueOnce({
        content: JSON.stringify({
          plans: [
            {
              title: "Simple Feature",
              content: "# Simple\n\nOverview.",
              complexity: "low",
              mockups: [{ title: "UI", content: "Box" }],
              tasks: [{ title: "Task 1", description: "Do something", priority: 0, dependsOn: [] }],
            },
          ],
        }),
      })
      .mockRejectedValueOnce(new Error("Agent timeout"));

    const result = await planService.decomposeFromPrd(projectId);

    expect(result.created).toBe(1);
    expect(result.plans).toHaveLength(1);
    // Decompose succeeded despite auto-review failure
    expect(mockInvoke).toHaveBeenCalledTimes(2);
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
        undefined
      );
      expect(mockUnregister).toHaveBeenCalledWith(mockRegister.mock.calls[0][0]);
    });

    it(
      "should register and unregister for Plan auto-review when tasks exist",
      { timeout: 15000 },
      async () => {
        mockInvoke
          .mockResolvedValueOnce({
            content: JSON.stringify({
              plans: [
                {
                  title: "Auto-Review Registry Test",
                  content: "# Test\n\nContent.",
                  complexity: "low",
                  mockups: [{ title: "UI", content: "Box" }],
                  tasks: [{ title: "Task 1", description: "Do it", priority: 0, dependsOn: [] }],
                },
              ],
            }),
          })
          .mockResolvedValueOnce({
            content: JSON.stringify({ taskIdsToClose: [], reason: "Nothing implemented" }),
          });

        await planService.decomposeFromPrd(projectId);

        // First call: decompose (register plan-decompose, unregister)
        // Second call: auto-review (register plan-auto-review, unregister)
        expect(mockRegister).toHaveBeenCalledTimes(2);
        expect(mockUnregister).toHaveBeenCalledTimes(2);

        const decomposeCall = mockRegister.mock.calls.find((c) =>
          c[0].startsWith("plan-decompose-")
        );
        const autoReviewCall = mockRegister.mock.calls.find((c) =>
          c[0].startsWith("plan-auto-review-")
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
        ]);
        expect(autoReviewCall).toBeDefined();
        expect(autoReviewCall).toEqual([
          expect.stringMatching(/^plan-auto-review-.*-/),
          projectId,
          "plan",
          "planner",
          "Plan auto-review",
          expect.any(String),
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
    "does not close tasks when auto-review returns empty taskIdsToClose",
    { timeout: 15000 },
    async () => {
      mockInvoke
        .mockResolvedValueOnce({
          content: JSON.stringify({
            plans: [
              {
                title: "New Feature",
                content: "# New\n\nOverview.",
                complexity: "medium",
                mockups: [{ title: "UI", content: "Box" }],
                tasks: [
                  { title: "Implement X", description: "Build X", priority: 0, dependsOn: [] },
                ],
              },
            ],
          }),
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({
            taskIdsToClose: [],
            reason: "No existing implementation found",
          }),
        });

      const result = await planService.decomposeFromPrd(projectId);

      expect(result.created).toBe(1);
      expect(mockInvoke).toHaveBeenCalledTimes(2);

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
