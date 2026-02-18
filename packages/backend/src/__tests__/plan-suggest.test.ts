import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { PlanService } from "../services/plan.service.js";
import { ProjectService } from "../services/project.service.js";
import { BeadsService } from "../services/beads.service.js";
import { OPENSPRINT_PATHS, PLAN_MARKDOWN_SECTIONS } from "@opensprint/shared";
import { DEFAULT_HIL_CONFIG } from "@opensprint/shared";

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

describe("Plan suggestPlans (POST /plans/suggest)", () => {
  let planService: PlanService;
  let projectService: ProjectService;
  let beads: BeadsService;
  let tempDir: string;
  let projectId: string;
  let repoPath: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    planService = new PlanService();
    projectService = new ProjectService();
    beads = new BeadsService();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-plan-suggest-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    repoPath = path.join(tempDir, "test-project");
    await fs.mkdir(repoPath, { recursive: true });
    execSync("git init", { cwd: repoPath });

    const project = await projectService.createProject({
      name: "Suggest Test",
      description: "Test project for plan suggest",
      repoPath,
      planningAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      codingAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });
    projectId = project.id;

    await beads.init(repoPath);

    const prdPath = path.join(repoPath, OPENSPRINT_PATHS.prd);
    await fs.mkdir(path.dirname(prdPath), { recursive: true });
    await fs.writeFile(
      prdPath,
      JSON.stringify({
        version: 1,
        sections: {
          executive_summary: {
            content: "A todo app",
            version: 1,
            updated_at: new Date().toISOString(),
          },
          feature_list: {
            content: "Tasks, filters, sharing",
            version: 1,
            updated_at: new Date().toISOString(),
          },
        },
      }),
      "utf-8"
    );
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it(
    "returns suggested plans from agent without creating plans or beads",
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
        expect.any(String)
      );
      expect(mockUnregister).toHaveBeenCalledTimes(1);

      const plansDir = path.join(repoPath, ".opensprint", "plans");
      const files = await fs.readdir(plansDir).catch(() => []);
      expect(files).toHaveLength(0);

      const allIssues = await beads.listAll(repoPath);
      const epics = allIssues.filter(
        (i: { issue_type?: string; type?: string }) => (i.issue_type ?? i.type) === "epic"
      );
      expect(epics).toHaveLength(0);
    }
  );

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

  it("throws DECOMPOSE_JSON_INVALID when JSON is malformed", { timeout: 10000 }, async () => {
    mockInvoke.mockResolvedValueOnce({
      content: '{"plans": [invalid json}',
    });

    await expect(planService.suggestPlans(projectId)).rejects.toMatchObject({
      statusCode: 400,
      code: "DECOMPOSE_JSON_INVALID",
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
