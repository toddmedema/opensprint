import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseSettings, TASK_SIZES, type Plan } from "@opensprint/shared";
import {
  generateAndCreateTasks,
  type PlanTaskGenerationDeps,
} from "../services/plan/plan-task-generation.js";
import { evaluatePlanComplexity } from "../services/plan/plan-complexity-gate.js";
import { agentService } from "../services/agent.service.js";
import { parseSubPlanDecompositionResponse } from "../services/plan/planner-normalize.js";

vi.mock("../services/agent.service.js", () => ({ agentService: { invokePlanningAgent: vi.fn() } }));
vi.mock("../services/agent-instructions.service.js", () => ({
  getCombinedInstructions: vi.fn().mockResolvedValue("Planner instructions"),
}));
vi.mock("../services/plan/plan-repo-guard.js", () => ({
  runPlannerWithRepoGuard: vi.fn(async ({ run }) => run()),
}));
vi.mock("../websocket/index.js", () => ({ broadcastToProject: vi.fn() }));

const task = {
  title: "Implement all scenario pages",
  description: "Build the shared template and complete content with focused tests",
  priority: 1,
  dependsOn: [],
  files: { create: ["scripts/scenarios.js"], test: ["scripts/scenarios.test.js"] },
};
function deps(): PlanTaskGenerationDeps {
  return {
    projectId: "task-policy-project",
    repoPath: "/tmp/task-policy",
    prdContext: "Static scenario landing pages",
    plan: {
      metadata: { planId: "scenarios", epicId: "os-scenarios", complexity: "medium" },
      content: "# Scenario pages",
      currentVersionNumber: 2,
    } as Plan,
    settings: parseSettings({}),
    taskStore: {
      createMany: vi.fn(async (_projectId, tasks) =>
        tasks.map((_, i) => ({ id: `os-scenarios.${i + 1}` }))
      ),
      addDependencies: vi.fn().mockResolvedValue(undefined),
      addLabel: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("project task-size planning contract", () => {
  beforeEach(() => vi.mocked(agentService.invokePlanningAgent).mockReset());

  it.each(TASK_SIZES)("uses %s policy and accepts one task without padding", async (taskSize) => {
    const input = deps();
    input.settings.taskSize = taskSize;
    vi.mocked(agentService.invokePlanningAgent).mockResolvedValue({
      content: JSON.stringify({ tasks: [task] }),
    });
    expect((await generateAndCreateTasks(input)).count).toBe(1);
    expect(input.taskStore.createMany).toHaveBeenCalledWith(input.projectId, [
      expect.objectContaining({ title: task.title, extra: { sourcePlanVersionNumber: 2 } }),
    ]);
    const request = vi.mocked(agentService.invokePlanningAgent).mock.calls[0]![0];
    expect(request.systemPrompt).toContain(`Project task size: ${taskSize}`);
    expect(request.systemPrompt).toContain("There is no minimum task count");
  });

  it("passes coding models, effort, time limits, and sibling task titles to the split decision", async () => {
    vi.mocked(agentService.invokePlanningAgent).mockResolvedValue({
      content: JSON.stringify({ strategy: "tasks", tasks: [task] }),
    });
    const settings = parseSettings({
      taskSize: "larger",
      simpleComplexityAgent: {
        type: "codex",
        model: "coding-model",
        effort: "high",
        timeoutMs: 300000,
        cliCommand: "private-command",
      },
      complexComplexityAgent: {
        type: "claude-cli",
        model: "other-coding-model",
        timeoutMs: null,
        cliCommand: null,
      },
    });
    const result = await evaluatePlanComplexity({
      projectId: "task-policy-project",
      repoPath: "/tmp/task-policy",
      planContent: "# Scenario pages",
      prdContext: "Static pages",
      currentDepth: 1,
      agentConfig: { type: "cursor", model: "planning-model", cliCommand: null },
      settings,
      hierarchyContext: {
        ancestors: [],
        siblings: [
          {
            title: "Generator",
            taskSummary: "- **Build shared generator**: completed output contract",
          },
        ],
      },
    });
    expect(result.strategy).toBe("tasks");
    const request = vi.mocked(agentService.invokePlanningAgent).mock.calls[0]![0];
    expect(request.config.model).toBe("planning-model");
    expect(request.systemPrompt).toContain("Project task size: larger");
    expect(request.systemPrompt).toContain('"model":"coding-model"');
    expect(request.systemPrompt).toContain('"effort":"high"');
    expect(request.systemPrompt).toContain('"timeoutMs":300000');
    expect(request.systemPrompt).toContain('"timeoutMs":"unlimited"');
    expect(request.systemPrompt).not.toContain("private-command");
    expect(request.messages[0]!.content).toContain("Build shared generator");
  });

  it("prefers the dedicated Coding configuration over legacy tiers", async () => {
    const input = deps();
    input.settings = {
      ...parseSettings({}),
      codingAgent: {
        type: "codex",
        model: "dedicated-coding-model",
        effort: "high",
        timeoutMs: 300000,
        cliCommand: null,
      },
    };
    vi.mocked(agentService.invokePlanningAgent).mockResolvedValue({
      content: JSON.stringify({ tasks: [task] }),
    });
    await generateAndCreateTasks(input);
    const request = vi.mocked(agentService.invokePlanningAgent).mock.calls[0]![0];
    expect(request.systemPrompt).toContain(
      'Coding: {"provider":"codex","model":"dedicated-coding-model","effort":"high","timeoutMs":300000}'
    );
    expect(request.systemPrompt).not.toContain("Simple tier:");
  });

  it("retains the selected policy through a repair turn", async () => {
    const input = deps();
    input.settings.taskSize = "smaller";
    vi.mocked(agentService.invokePlanningAgent)
      .mockResolvedValueOnce({ content: "not JSON" })
      .mockResolvedValueOnce({ content: JSON.stringify({ tasks: [task] }) });
    expect((await generateAndCreateTasks(input)).count).toBe(1);
    const requests = vi.mocked(agentService.invokePlanningAgent).mock.calls;
    expect(requests).toHaveLength(2);
    for (const [request] of requests)
      expect(request.systemPrompt).toContain("Project task size: smaller");
  });

  it("fails without persisting partial scope when both attempts exceed the cap", async () => {
    const input = deps();
    const tasks = Array.from({ length: 16 }, (_, i) => ({ ...task, title: `Outcome ${i}` }));
    vi.mocked(agentService.invokePlanningAgent).mockResolvedValue({
      content: JSON.stringify({ tasks }),
    });
    const result = await generateAndCreateTasks(input);
    expect(result.count).toBe(0);
    expect(result.parseFailureReason).toContain("task-count-exceeded");
    expect(input.taskStore.createMany).not.toHaveBeenCalled();
    expect(agentService.invokePlanningAgent).toHaveBeenCalledTimes(2);
    const repair = vi.mocked(agentService.invokePlanningAgent).mock.calls[1]![0];
    expect(repair.messages.some((m) => m.content.includes("Never drop scope"))).toBe(true);
  });

  it("preserves cross-epic dependencies when reusing a decomposition task list", async () => {
    const input = deps();
    input.preGeneratedTasks = [{ ...task, dependsOn: ["Build shared generator"] }];
    input.crossEpicDependsTitleToId = { "Build shared generator": "os-generator.1" };
    expect((await generateAndCreateTasks(input)).count).toBe(1);
    expect(input.taskStore.addDependencies).toHaveBeenCalledWith(input.projectId, [
      { childId: "os-scenarios.1", parentId: "os-generator.1", type: "blocks" },
    ]);
    expect(input.taskStore.addLabel).toHaveBeenCalledWith(
      input.projectId,
      "os-scenarios.1",
      `files:${JSON.stringify(task.files)}`
    );
    expect(agentService.invokePlanningAgent).not.toHaveBeenCalled();
  });
  it("rejects duplicate normalized task titles in a decomposition", () => {
    expect(
      parseSubPlanDecompositionResponse(
        JSON.stringify({
          strategy: "tasks",
          tasks: [task, { task_title: task.title, depends_on: [0] }],
        })
      )
    ).toBeNull();
  });

  it("repairs duplicate decomposition titles before returning tasks for reuse", async () => {
    vi.mocked(agentService.invokePlanningAgent)
      .mockResolvedValueOnce({
        content: JSON.stringify({ strategy: "tasks", tasks: [task, task] }),
      })
      .mockResolvedValueOnce({ content: JSON.stringify({ strategy: "tasks", tasks: [task] }) });
    const result = await evaluatePlanComplexity({
      projectId: "task-policy-project",
      repoPath: "/tmp/task-policy",
      planContent: "# Scenario pages",
      prdContext: "Static pages",
      currentDepth: 1,
      agentConfig: { type: "cursor", model: null, cliCommand: null },
    });
    expect(result.strategy).toBe("tasks");
    if (result.strategy === "tasks") expect(result.tasks).toHaveLength(1);
    expect(agentService.invokePlanningAgent).toHaveBeenCalledTimes(2);
    const repair = vi.mocked(agentService.invokePlanningAgent).mock.calls[1]![0];
    expect(repair.messages.some((m) => m.content.includes("unique"))).toBe(true);
  });

  it("repairs duplicate generated titles and preserves distinct task IDs and dependencies", async () => {
    const input = deps();
    const publish = { ...task, title: "Publish scenario pages", dependsOn: [task.title] };
    vi.mocked(agentService.invokePlanningAgent)
      .mockResolvedValueOnce({ content: JSON.stringify({ tasks: [task, task] }) })
      .mockResolvedValueOnce({ content: JSON.stringify({ tasks: [task, publish] }) });
    const result = await generateAndCreateTasks(input);
    expect(agentService.invokePlanningAgent).toHaveBeenCalledTimes(2);
    expect(result.taskRefs).toEqual([
      { id: "os-scenarios.1", title: task.title },
      { id: "os-scenarios.2", title: publish.title },
    ]);
    expect(input.taskStore.addDependencies).toHaveBeenCalledWith(input.projectId, [
      { childId: "os-scenarios.2", parentId: "os-scenarios.1", type: "blocks" },
    ]);
  });

  it("never persists an ambiguous pre-generated task list", async () => {
    const input = deps();
    input.preGeneratedTasks = [task, task];
    const result = await generateAndCreateTasks(input);
    expect(result.count).toBe(0);
    expect(result.parseFailureReason).toContain("duplicate-task-title");
    expect(input.taskStore.createMany).not.toHaveBeenCalled();
    expect(input.taskStore.addDependencies).not.toHaveBeenCalled();
    expect(agentService.invokePlanningAgent).not.toHaveBeenCalled();
  });
});
