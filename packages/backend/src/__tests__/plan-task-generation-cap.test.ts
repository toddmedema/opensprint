import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseTaskGenerationContent,
  extractRawTasks,
} from "../services/plan/plan-task-generation.js";
import { MAX_TASKS_PER_PLAN } from "../services/plan/planner-normalize.js";
import { buildTaskCountRepairPrompt } from "../services/plan/plan-prompts.js";
import { invokeStructuredPlanningAgent } from "../services/structured-agent-output.service.js";
import { agentService } from "../services/agent.service.js";

vi.mock("../services/agent.service.js", () => ({
  agentService: {
    invokePlanningAgent: vi.fn(),
  },
}));

function makeTasks(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    title: `Task ${i + 1}`,
    description: `Description for task ${i + 1}`,
    priority: 2,
    dependsOn: [],
    complexity: 3,
    files: { modify: [], create: [], test: [] },
  }));
}

function makeTasksJson(count: number): string {
  return JSON.stringify({ tasks: makeTasks(count) });
}

describe("plan-task-generation task count cap", () => {
  describe("parseTaskGenerationContent", () => {
    it("accepts exactly MAX_TASKS_PER_PLAN tasks", () => {
      const result = parseTaskGenerationContent(makeTasksJson(MAX_TASKS_PER_PLAN));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.rawTasks).toHaveLength(MAX_TASKS_PER_PLAN);
      }
    });

    it("accepts fewer than MAX_TASKS_PER_PLAN tasks", () => {
      const result = parseTaskGenerationContent(makeTasksJson(5));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.rawTasks).toHaveLength(5);
      }
    });

    it("rejects more than MAX_TASKS_PER_PLAN tasks with task-count-exceeded reason", () => {
      const count = MAX_TASKS_PER_PLAN + 5;
      const result = parseTaskGenerationContent(makeTasksJson(count));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.parseFailureReason).toMatch(/^task-count-exceeded:/);
        expect(result.parseFailureReason).toContain(String(count));
        expect(result.parseFailureReason).toContain(String(MAX_TASKS_PER_PLAN));
      }
    });

    it("rejects 16 tasks (just over the limit)", () => {
      const result = parseTaskGenerationContent(makeTasksJson(16));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.parseFailureReason).toMatch(/^task-count-exceeded:/);
      }
    });

    it("still rejects invalid JSON", () => {
      const result = parseTaskGenerationContent("not json");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.parseFailureReason).toContain("not valid JSON");
      }
    });

    it("still rejects empty content", () => {
      const result = parseTaskGenerationContent("");
      expect(result.ok).toBe(false);
    });
  });

  describe("extractRawTasks (no count cap)", () => {
    it("returns all tasks even when exceeding MAX_TASKS_PER_PLAN", () => {
      const count = MAX_TASKS_PER_PLAN + 10;
      const result = extractRawTasks(makeTasksJson(count));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.rawTasks).toHaveLength(count);
      }
    });
  });

  describe("buildTaskCountRepairPrompt", () => {
    it("includes the task count and the maximum", () => {
      const prompt = buildTaskCountRepairPrompt(20);
      expect(prompt).toContain("20 tasks");
      expect(prompt).toContain("maximum of 15");
      expect(prompt).toContain("Merge related tasks");
    });
  });

  describe("structured output contract integration", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("triggers repair when initial response exceeds task cap", async () => {
      const overLimitJson = makeTasksJson(20);
      const withinLimitJson = makeTasksJson(10);

      vi.mocked(agentService.invokePlanningAgent)
        .mockResolvedValueOnce({ content: overLimitJson })
        .mockResolvedValueOnce({ content: withinLimitJson });

      const result = await invokeStructuredPlanningAgent({
        projectId: "proj-cap",
        role: "planner",
        config: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
        messages: [{ role: "user", content: "Generate tasks" }],
        contract: {
          parse: (content) => {
            const parsed = parseTaskGenerationContent(content);
            return parsed.ok ? parsed.rawTasks : null;
          },
          repairPrompt: (invalidReason) => {
            if (invalidReason?.startsWith("task-count-exceeded:")) {
              const countMatch = invalidReason.match(/returned (\d+) tasks/);
              const count = countMatch ? Number(countMatch[1]) : 0;
              return buildTaskCountRepairPrompt(count);
            }
            return "Return valid JSON.";
          },
          invalidReason: (content) => {
            const parsed = parseTaskGenerationContent(content);
            return parsed.ok ? undefined : parsed.parseFailureReason;
          },
        },
      });

      expect(result.ok).toBe(true);
      expect(result.repaired).toBe(true);
      expect(result.parsed).toHaveLength(10);
      expect(agentService.invokePlanningAgent).toHaveBeenCalledTimes(2);

      const repairCall = vi.mocked(agentService.invokePlanningAgent).mock.calls[1]?.[0];
      const repairUserMsg = repairCall?.messages?.find(
        (m: { role: string; content: string }) =>
          m.role === "user" && m.content.includes("task-count-exceeded")
      );
      expect(repairUserMsg).toBeDefined();
    });

    it("uses the task-count-specific repair prompt (not generic) for count violations", async () => {
      const overLimitJson = makeTasksJson(18);
      const withinLimitJson = makeTasksJson(12);

      vi.mocked(agentService.invokePlanningAgent)
        .mockResolvedValueOnce({ content: overLimitJson })
        .mockResolvedValueOnce({ content: withinLimitJson });

      await invokeStructuredPlanningAgent({
        projectId: "proj-cap2",
        role: "planner",
        config: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
        messages: [{ role: "user", content: "Generate tasks" }],
        contract: {
          parse: (content) => {
            const parsed = parseTaskGenerationContent(content);
            return parsed.ok ? parsed.rawTasks : null;
          },
          repairPrompt: (invalidReason) => {
            if (invalidReason?.startsWith("task-count-exceeded:")) {
              const countMatch = invalidReason.match(/returned (\d+) tasks/);
              const count = countMatch ? Number(countMatch[1]) : 0;
              return buildTaskCountRepairPrompt(count);
            }
            return "Generic retry.";
          },
          invalidReason: (content) => {
            const parsed = parseTaskGenerationContent(content);
            return parsed.ok ? undefined : parsed.parseFailureReason;
          },
        },
      });

      const repairCall = vi.mocked(agentService.invokePlanningAgent).mock.calls[1]?.[0];
      const repairMsg = repairCall?.messages?.find(
        (m: { role: string; content: string }) =>
          m.role === "user" && m.content.includes("18 tasks")
      );
      expect(repairMsg).toBeDefined();
      expect(repairMsg?.content).toContain("Merge related tasks");
    });
  });
});
