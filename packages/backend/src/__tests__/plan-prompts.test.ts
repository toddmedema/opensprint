import { describe, it, expect } from "vitest";
import {
  DECOMPOSE_SYSTEM_PROMPT,
  TASK_GENERATION_SYSTEM_PROMPT,
  SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT,
  SUB_PLAN_DECOMPOSITION_REPAIR_PROMPT,
  MAX_SUB_PLAN_DEPTH,
  buildSubPlanCountRepairPrompt,
  buildDepthExceededTaskRepairPrompt,
} from "../services/plan/plan-prompts.js";

describe("TASK_GENERATION_SYSTEM_PROMPT", () => {
  it("states the 15-task cap explicitly", () => {
    expect(TASK_GENERATION_SYSTEM_PROMPT).toContain(
      "Generate only as many tasks as the scope needs, from 1 to 15. Never exceed 15."
    );
  });

  it("instructs consolidation when more than 15 tasks seem needed", () => {
    expect(TASK_GENERATION_SYSTEM_PROMPT).toContain(
      "Consolidate related concerns while preserving all requirements and acceptance criteria"
    );
  });

  it("requires cohesive outcomes with implementation and tests", () => {
    expect(TASK_GENERATION_SYSTEM_PROMPT).toContain(
      "Each task must have one coherent, independently verifiable outcome"
    );
    expect(TASK_GENERATION_SYSTEM_PROMPT).toContain(
      "Include the related implementation, files, and tests together"
    );
  });

  it("requires explicit acceptance criteria in descriptions", () => {
    expect(TASK_GENERATION_SYSTEM_PROMPT).toContain(
      "**Acceptance criteria:** A numbered list of concrete, verifiable conditions"
    );
    expect(TASK_GENERATION_SYSTEM_PROMPT).toContain(
      "Each task description must contain explicit acceptance criteria (numbered list)"
    );
  });

  it("requires stable dependency references using exact titles", () => {
    expect(TASK_GENERATION_SYSTEM_PROMPT).toContain(
      "Use exact task titles from your output for dependsOn entries within this plan"
    );
    expect(TASK_GENERATION_SYSTEM_PROMPT).toContain("copy them character-for-character");
    expect(TASK_GENERATION_SYSTEM_PROMPT).toContain("Do not paraphrase or abbreviate");
  });

  it("preserves the JSON output schema", () => {
    expect(TASK_GENERATION_SYSTEM_PROMPT).toContain('"tasks"');
    expect(TASK_GENERATION_SYSTEM_PROMPT).toContain('"title"');
    expect(TASK_GENERATION_SYSTEM_PROMPT).toContain('"description"');
    expect(TASK_GENERATION_SYSTEM_PROMPT).toContain('"priority"');
    expect(TASK_GENERATION_SYSTEM_PROMPT).toContain('"dependsOn"');
    expect(TASK_GENERATION_SYSTEM_PROMPT).toContain('"complexity"');
    expect(TASK_GENERATION_SYSTEM_PROMPT).toContain('"files"');
  });

  it("retains task-level complexity range 1-10", () => {
    expect(TASK_GENERATION_SYSTEM_PROMPT).toContain("Task-level complexity: integer 1-10 only");
  });
});

describe("DECOMPOSE_SYSTEM_PROMPT", () => {
  it("contains the scale/speed/cost instruction paragraph", () => {
    expect(DECOMPOSE_SYSTEM_PROMPT).toContain("**Scale, speed, and cost:**");
  });

  it("references all three constraint categories", () => {
    expect(DECOMPOSE_SYSTEM_PROMPT).toContain("scale (users, data volume, growth)");
    expect(DECOMPOSE_SYSTEM_PROMPT).toContain("speed (latency, throughput)");
    expect(DECOMPOSE_SYSTEM_PROMPT).toContain("cost (budget, infrastructure)");
  });

  it("instructs Technical Approach handling when constraints are present", () => {
    expect(DECOMPOSE_SYSTEM_PROMPT).toContain(
      "ensure each relevant plan's Technical Approach reflects them"
    );
  });

  it("instructs Assumptions note when constraints are absent for affected plans", () => {
    expect(DECOMPOSE_SYSTEM_PROMPT).toContain(
      "add a brief note in the Assumptions section of plans likely affected by scale/speed/cost"
    );
  });

  it("does not alter the JSON output shape", () => {
    expect(DECOMPOSE_SYSTEM_PROMPT).toContain('"plans"');
    expect(DECOMPOSE_SYSTEM_PROMPT).toContain('"title"');
    expect(DECOMPOSE_SYSTEM_PROMPT).toContain('"content"');
    expect(DECOMPOSE_SYSTEM_PROMPT).toContain('"complexity"');
    expect(DECOMPOSE_SYSTEM_PROMPT).toContain('"dependsOnPlans"');
    expect(DECOMPOSE_SYSTEM_PROMPT).toContain('"mockups"');
  });
});

describe("SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT", () => {
  it("describes the tasks vs sub_plans strategy decision", () => {
    expect(SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT).toContain('"tasks"');
    expect(SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT).toContain('"sub_plans"');
  });

  it("enforces the 15-task threshold for strategy selection", () => {
    expect(SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT).toContain("15 or fewer");
    expect(SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT).toContain("substantial independent workstreams");
  });

  it("specifies max depth constraint", () => {
    expect(SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT).toContain(`${MAX_SUB_PLAN_DEPTH} levels deep`);
    expect(SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT).toContain(`already **${MAX_SUB_PLAN_DEPTH}**`);
  });

  it("includes both JSON output shapes", () => {
    expect(SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT).toContain('"strategy": "tasks"');
    expect(SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT).toContain('"strategy": "sub_plans"');
  });

  it("requires sub-plan content to follow plan template structure", () => {
    expect(SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT).toContain("plan template structure");
    expect(SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT).toContain("Overview");
    expect(SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT).toContain("Acceptance Criteria");
    expect(SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT).toContain("Technical Approach");
  });

  it("defines sub-plan JSON schema fields", () => {
    expect(SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT).toContain('"title"');
    expect(SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT).toContain('"overview"');
    expect(SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT).toContain('"content"');
    expect(SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT).toContain('"depends_on_plans"');
  });

  it("bounds sub-plan count to 2–8", () => {
    expect(SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT).toContain("2–8 sub-plans");
  });

  it("requires task-level fields in tasks strategy", () => {
    expect(SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT).toContain('"dependsOn"');
    expect(SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT).toContain('"complexity"');
    expect(SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT).toContain('"files"');
    expect(SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT).toContain('"priority"');
  });

  it("requires acceptance criteria in task descriptions", () => {
    expect(SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT).toContain("**Acceptance criteria:**");
  });

  it("requires stable dependency references for tasks", () => {
    expect(SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT).toContain("character-for-character");
  });

  it("instructs no file modifications", () => {
    expect(SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT).toContain(
      "Do NOT create, modify, stage, or commit repository files"
    );
  });
});

describe("SUB_PLAN_DECOMPOSITION_REPAIR_PROMPT", () => {
  it("mentions both strategy shapes", () => {
    expect(SUB_PLAN_DECOMPOSITION_REPAIR_PROMPT).toContain('"tasks"');
    expect(SUB_PLAN_DECOMPOSITION_REPAIR_PROMPT).toContain('"sub_plans"');
  });

  it("includes the task and sub-plan JSON shapes", () => {
    expect(SUB_PLAN_DECOMPOSITION_REPAIR_PROMPT).toContain('"strategy": "tasks"');
    expect(SUB_PLAN_DECOMPOSITION_REPAIR_PROMPT).toContain('"strategy": "sub_plans"');
  });

  it("enforces task and sub-plan count limits", () => {
    expect(SUB_PLAN_DECOMPOSITION_REPAIR_PROMPT).toContain(
      "1–15 tasks as needed; no padding; preserve all scope"
    );
    expect(SUB_PLAN_DECOMPOSITION_REPAIR_PROMPT).toContain("2–8 sub-plans");
  });
});

describe("buildSubPlanCountRepairPrompt", () => {
  it("includes the actual count in the message", () => {
    const prompt = buildSubPlanCountRepairPrompt(12);
    expect(prompt).toContain("12 sub-plans");
  });

  it("states the allowed range", () => {
    const prompt = buildSubPlanCountRepairPrompt(1);
    expect(prompt).toContain("2–8");
  });

  it("instructs merge or split to fit range", () => {
    const prompt = buildSubPlanCountRepairPrompt(10);
    expect(prompt).toContain("Merge");
    expect(prompt).toContain("split");
  });
});

describe("buildDepthExceededTaskRepairPrompt", () => {
  it("includes the current depth", () => {
    const prompt = buildDepthExceededTaskRepairPrompt(4);
    expect(prompt).toContain("depth is 4");
  });

  it("references the max depth constant", () => {
    const prompt = buildDepthExceededTaskRepairPrompt(MAX_SUB_PLAN_DEPTH);
    expect(prompt).toContain(`maximum (${MAX_SUB_PLAN_DEPTH})`);
  });

  it("forces tasks-only strategy", () => {
    const prompt = buildDepthExceededTaskRepairPrompt(4);
    expect(prompt).toContain("must NOT create sub-plans");
    expect(prompt).toContain('strategy "tasks"');
  });

  it("enforces the 15-task cap", () => {
    const prompt = buildDepthExceededTaskRepairPrompt(4);
    expect(prompt).toContain("at most 15");
  });
});

describe("MAX_SUB_PLAN_DEPTH", () => {
  it("is 4", () => {
    expect(MAX_SUB_PLAN_DEPTH).toBe(4);
  });
});
