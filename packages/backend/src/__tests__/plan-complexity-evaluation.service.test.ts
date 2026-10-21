import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { PlanComplexityEvaluationService } from "../services/plan-complexity-evaluation.service.js";

const { mockInvokeStructuredPlanningAgent } = vi.hoisted(() => ({
  mockInvokeStructuredPlanningAgent: vi.fn(),
}));

vi.mock("../services/structured-agent-output.service.js", () => ({
  invokeStructuredPlanningAgent: (...args: unknown[]) => mockInvokeStructuredPlanningAgent(...args),
}));

// These temporary repository fixtures are intentionally outside the registered SQL catalog.
vi.mock("../services/project-index.js", () => ({
  getProjects: vi.fn().mockResolvedValue([]),
}));

describe("PlanComplexityEvaluationService", () => {
  let repoPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-plan-complexity-eval-"));
  });

  afterEach(async () => {
    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it("prepends Open Sprint planner defaults to the planning system prompt", async () => {
    mockInvokeStructuredPlanningAgent.mockResolvedValue({
      parsed: { complexity: "high" },
    });

    const projectService = {
      getProject: vi.fn().mockResolvedValue({ repoPath }),
      getSettings: vi.fn().mockResolvedValue({
        simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
        complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      }),
    } as never;

    const service = new PlanComplexityEvaluationService({ projectService });

    const complexity = await service.evaluateComplexity(
      "proj-1",
      "Auth",
      "# Auth\n\n## Overview\n\nAdd sign-in."
    );

    expect(complexity).toBe("high");
    expect(mockInvokeStructuredPlanningAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        role: "planner",
        cwd: repoPath,
      })
    );

    const systemPrompt = mockInvokeStructuredPlanningAgent.mock.calls[0]?.[0]?.systemPrompt as
      | string
      | undefined;
    expect(systemPrompt).toContain("## Open Sprint Defaults");
    expect(systemPrompt).toContain("### Planner Defaults");
    expect(systemPrompt).toContain(
      "Produce structured planning output that matches the requested schema exactly."
    );
    expect(systemPrompt).toContain('{"complexity":"<value>"}');
  });
});
