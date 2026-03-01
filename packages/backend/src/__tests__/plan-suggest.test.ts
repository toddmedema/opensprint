import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { PlanService } from "../services/plan.service.js";
import { ProjectService } from "../services/project.service.js";
import { type TaskStoreService } from "../services/task-store.service.js";
import {
  OPENSPRINT_PATHS,
  PLAN_MARKDOWN_SECTIONS,
  SPEC_MD,
  SPEC_METADATA_PATH,
  prdToSpecMarkdown,
} from "@opensprint/shared";
import { DEFAULT_HIL_CONFIG } from "@opensprint/shared";

const mockInvoke = vi.fn();
const mockRegister = vi.fn();
const mockUnregister = vi.fn();

vi.mock("../services/task-store.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/task-store.service.js")>();
  const { createTestPostgresClient } = await import("./test-db-helper.js");
  const dbResult = await createTestPostgresClient();
  if (!dbResult) {
    return { ...actual, TaskStoreService: class { constructor() { throw new Error("Postgres required"); } }, taskStore: null, _postgresAvailable: false, _resetSharedDb: () => {} };
  }
  const store = new actual.TaskStoreService(dbResult.client);
  await store.init();
  const resetSharedDb = async () => {
    await dbResult.client.execute("DELETE FROM task_dependencies");
    await dbResult.client.execute("DELETE FROM tasks");
  };
  return {
    ...actual,
    TaskStoreService: class extends actual.TaskStoreService { constructor() { super(dbResult.client); } },
    taskStore: store,
    _resetSharedDb: resetSharedDb,
    _postgresAvailable: true,
  };
});

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

const planSuggestTaskStoreMod = await import("../services/task-store.service.js");
const planSuggestPostgresOk = (planSuggestTaskStoreMod as { _postgresAvailable?: boolean })._postgresAvailable ?? false;

describe.skipIf(!planSuggestPostgresOk)("Plan suggestPlans (POST /plans/suggest)", () => {
  let planService: PlanService;
  let projectService: ProjectService;
  let taskStore: TaskStoreService;
  let tempDir: string;
  let projectId: string;
  let repoPath: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    const mod = (await import("../services/task-store.service.js")) as unknown as {
      taskStore: TaskStoreService;
      _resetSharedDb?: () => void | Promise<void>;
    };
    await mod._resetSharedDb?.();
    taskStore = mod.taskStore;

    vi.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-plan-suggest-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
    planService = new PlanService();
    projectService = new ProjectService();

    repoPath = path.join(tempDir, "test-project");
    await fs.mkdir(repoPath, { recursive: true });
    execSync("git init", { cwd: repoPath });

    const project = await projectService.createProject({
      name: "Suggest Test",
      repoPath,
      simpleComplexityAgent: { type: "cursor", model: "claude-sonnet-4", cliCommand: null },
      complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });
    projectId = project.id;

    await taskStore.init();

    const prd = {
      version: 1,
      sections: {
        executive_summary: {
          content: "A todo app",
          version: 1,
          updatedAt: new Date().toISOString(),
        },
        feature_list: {
          content: "Tasks, filters, sharing",
          version: 1,
          updatedAt: new Date().toISOString(),
        },
        problem_statement: { content: "", version: 0, updatedAt: new Date().toISOString() },
        user_personas: { content: "", version: 0, updatedAt: new Date().toISOString() },
        goals_and_metrics: { content: "", version: 0, updatedAt: new Date().toISOString() },
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
    await fs.writeFile(path.join(repoPath, SPEC_MD), prdToSpecMarkdown(prd as never), "utf-8");
    await fs.mkdir(path.join(repoPath, path.dirname(SPEC_METADATA_PATH)), { recursive: true });
    await fs.writeFile(
      path.join(repoPath, SPEC_METADATA_PATH),
      JSON.stringify({ version: 1, changeLog: [] }, null, 2),
      "utf-8"
    );
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it(
    "returns suggested plans from agent without creating plans or tasks",
    { timeout: 10000 },
    async () => {
      const suggestedPlans = [
        {
          title: "Task Management",
          content:
            "# Task Management\n\n## Overview\n\nCore task CRUD.\n\n## Acceptance Criteria\n\n- Create, read, update, delete tasks",
          complexity: "medium",
          dependsOnPlans: [] as string[],
          mockups: [{ title: "Task List", content: "+----------+\n| Tasks    |\n+----------+" }],
          tasks: [
            {
              title: "Create task model",
              description: "Define task schema",
              priority: 0,
              dependsOn: [] as string[],
            },
            {
              title: "Implement task API",
              description: "REST endpoints",
              priority: 1,
              dependsOn: ["Create task model"],
            },
          ],
        },
      ];

      mockInvoke.mockResolvedValueOnce({
        content: JSON.stringify({ plans: suggestedPlans }),
      });

      const result = await planService.suggestPlans(projectId);

      expect(result.plans).toHaveLength(1);
      expect(result.plans[0].title).toBe("Task Management");
      expect(result.plans[0].content).toContain("# Task Management");
      expect(result.plans[0].complexity).toBe("medium");
      expect(result.plans[0].tasks).toHaveLength(2);
      expect(result.plans[0].tasks![0].title).toBe("Create task model");
      expect(result.plans[0].tasks![1].dependsOn).toEqual(["Create task model"]);

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockRegister).toHaveBeenCalledWith(
        expect.stringMatching(/^plan-suggest-.*-/),
        projectId,
        "plan",
        "planner",
        "Feature decomposition (suggest)",
        expect.any(String),
        undefined,
        undefined,
        undefined,
        undefined
      );
      expect(mockUnregister).toHaveBeenCalledTimes(1);

      const plansDir = path.join(repoPath, ".opensprint", "plans");
      const files = await fs.readdir(plansDir).catch(() => []);
      expect(files).toHaveLength(0);
    }
  );

  it("normalizes snake_case depends_on to camelCase dependsOn in response", async () => {
    mockInvoke.mockResolvedValueOnce({
      content: JSON.stringify({
        plans: [
          {
            title: "Auth Feature",
            content: "# Auth\n\n## Overview\n\nAuth.",
            complexity: "low",
            depends_on_plans: [] as string[],
            tasks: [
              { title: "Setup auth", description: "Setup", priority: 0, depends_on: [] },
              { title: "Add login", description: "Login", priority: 1, depends_on: ["Setup auth"] },
            ],
          },
        ],
      }),
    });

    const result = await planService.suggestPlans(projectId);

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].dependsOnPlans).toEqual([]);
    expect(result.plans[0].tasks![0].dependsOn).toEqual([]);
    expect(result.plans[0].tasks![1].dependsOn).toEqual(["Setup auth"]);
  });

  it("accepts plan_list and plan-level snake_case (plan_title, plan_content, task_list, mock_ups)", async () => {
    mockInvoke.mockResolvedValueOnce({
      content: JSON.stringify({
        plan_list: [
          {
            plan_title: "Snake Plan",
            plan_content: "# Snake Plan\n\n## Overview\n\nSnake.",
            complexity: "high",
            mock_ups: [{ title: "UI", content: "Wireframe" }],
            task_list: [
              { task_title: "T1", task_description: "First", task_priority: 0, depends_on: [] },
              {
                task_title: "T2",
                task_description: "Second",
                task_priority: 1,
                depends_on: ["T1"],
              },
            ],
          },
        ],
      }),
    });

    const result = await planService.suggestPlans(projectId);

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].title).toBe("Snake Plan");
    expect(result.plans[0].content).toContain("Snake Plan");
    expect(result.plans[0].complexity).toBe("high");
    expect(result.plans[0].mockups).toHaveLength(1);
    expect(result.plans[0].mockups![0].title).toBe("UI");
    expect(result.plans[0].tasks).toHaveLength(2);
    expect(result.plans[0].tasks![0].title).toBe("T1");
    expect(result.plans[0].tasks![1].title).toBe("T2");
    expect(result.plans[0].tasks![1].dependsOn).toEqual(["T1"]);
  });

  it("parses JSON from markdown code block", { timeout: 10000 }, async () => {
    mockInvoke.mockResolvedValueOnce({
      content: `Here are my suggested plans:

\`\`\`json
{
  "plans": [
    {
      "title": "Auth Feature",
      "content": "# Auth\\n\\nOverview.",
      "complexity": "high",
      "mockups": [{"title": "Login", "content": "Form"}],
      "tasks": []
    }
  ]
}
\`\`\`
`,
    });

    const result = await planService.suggestPlans(projectId);

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].title).toBe("Auth Feature");
    expect(result.plans[0].complexity).toBe("high");
  });

  it("throws DECOMPOSE_PARSE_FAILED when agent returns no JSON", { timeout: 10000 }, async () => {
    mockInvoke.mockResolvedValueOnce({
      content: "I cannot produce JSON right now. Here are some ideas: ...",
    });

    await expect(planService.suggestPlans(projectId)).rejects.toMatchObject({
      statusCode: 400,
      code: "DECOMPOSE_PARSE_FAILED",
    });
  });

  it("throws DECOMPOSE_PARSE_FAILED when JSON is malformed", { timeout: 10000 }, async () => {
    mockInvoke.mockResolvedValueOnce({
      content: '{"plans": [invalid json}',
    });

    await expect(planService.suggestPlans(projectId)).rejects.toMatchObject({
      statusCode: 400,
      code: "DECOMPOSE_PARSE_FAILED",
    });
  });

  it("throws DECOMPOSE_EMPTY when plans array is empty", { timeout: 10000 }, async () => {
    mockInvoke.mockResolvedValueOnce({
      content: JSON.stringify({ plans: [] }),
    });

    await expect(planService.suggestPlans(projectId)).rejects.toMatchObject({
      statusCode: 400,
      code: "DECOMPOSE_EMPTY",
    });
  });

  it("unregisters agent even when invoke throws", { timeout: 10000 }, async () => {
    mockInvoke.mockRejectedValueOnce(new Error("Agent timeout"));

    await expect(planService.suggestPlans(projectId)).rejects.toThrow("Agent timeout");

    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(mockUnregister).toHaveBeenCalledTimes(1);
  });

  it(
    "passes Plan template structure (PRD §7.2.3) in system prompt to agent",
    { timeout: 10000 },
    async () => {
      mockInvoke.mockResolvedValueOnce({
        content: JSON.stringify({
          plans: [
            {
              title: "Test",
              content: "# Test\n\n## Overview\n\nText.",
              complexity: "low",
              mockups: [{ title: "M", content: "x" }],
              tasks: [],
            },
          ],
        }),
      });

      await planService.suggestPlans(projectId);

      const invokeCall = mockInvoke.mock.calls[0][0];
      const systemPrompt = invokeCall.systemPrompt as string;
      for (const section of PLAN_MARKDOWN_SECTIONS) {
        expect(systemPrompt).toContain(`## ${section}`);
      }
      expect(systemPrompt).toContain("PRD §7.2.3");
    }
  );
});
