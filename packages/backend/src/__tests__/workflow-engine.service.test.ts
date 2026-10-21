import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import type { WorkflowDefinition } from "@opensprint/shared";
import {
  WorkflowEngineService,
  WorkflowValidationError,
  DEFAULT_WORKFLOW,
} from "../services/workflow-engine.service.js";

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (a: unknown, b: unknown) => [a, b],
}));
vi.mock("../db/drizzle-schema-pg.js", () => ({ plansTable: {} }));

// These temporary repository fixtures are intentionally outside the registered SQL catalog.
vi.mock("../services/project-index.js", () => ({
  getProjects: vi.fn().mockResolvedValue([]),
}));

describe("WorkflowEngineService", () => {
  let service: WorkflowEngineService;
  let tmpDir: string;

  beforeEach(async () => {
    service = new WorkflowEngineService();
    tmpDir = path.join(os.tmpdir(), `workflow-test-${Date.now()}`);
    await fs.mkdir(path.join(tmpDir, ".opensprint"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("validate", () => {
    it("should accept the default workflow", () => {
      expect(() => service.validate(DEFAULT_WORKFLOW)).not.toThrow();
    });

    it("should reject empty steps", () => {
      const workflow: WorkflowDefinition = {
        id: "empty",
        name: "Empty",
        version: 1,
        steps: [],
      };

      expect(() => service.validate(workflow)).toThrow(WorkflowValidationError);
    });

    it("should reject duplicate step IDs", () => {
      const workflow: WorkflowDefinition = {
        id: "dups",
        name: "Duplicates",
        version: 1,
        steps: [
          {
            id: "code",
            name: "Code",
            agentRole: "coder",
            dependsOn: [],
            successCondition: "tests_pass",
            retryPolicy: { maxAttempts: 3, escalateModel: false },
          },
          {
            id: "code",
            name: "Code Again",
            agentRole: "coder",
            dependsOn: [],
            successCondition: "tests_pass",
            retryPolicy: { maxAttempts: 3, escalateModel: false },
          },
        ],
      };

      expect(() => service.validate(workflow)).toThrow("Duplicate step ID");
    });

    it("should reject references to non-existent steps", () => {
      const workflow: WorkflowDefinition = {
        id: "bad-ref",
        name: "Bad ref",
        version: 1,
        steps: [
          {
            id: "review",
            name: "Review",
            agentRole: "reviewer",
            dependsOn: ["code"],
            successCondition: "review_approved",
            retryPolicy: { maxAttempts: 3, escalateModel: false },
          },
        ],
      };

      expect(() => service.validate(workflow)).toThrow('depends on non-existent step "code"');
    });

    it("should detect simple cycles (A → B → A)", () => {
      const workflow: WorkflowDefinition = {
        id: "cycle",
        name: "Cycle",
        version: 1,
        steps: [
          {
            id: "a",
            name: "A",
            agentRole: "coder",
            dependsOn: ["b"],
            successCondition: "always",
            retryPolicy: { maxAttempts: 1, escalateModel: false },
          },
          {
            id: "b",
            name: "B",
            agentRole: "reviewer",
            dependsOn: ["a"],
            successCondition: "always",
            retryPolicy: { maxAttempts: 1, escalateModel: false },
          },
        ],
      };

      expect(() => service.validate(workflow)).toThrow("cycle");
    });

    it("should detect transitive cycles (A → B → C → A)", () => {
      const workflow: WorkflowDefinition = {
        id: "long-cycle",
        name: "Long Cycle",
        version: 1,
        steps: [
          {
            id: "a",
            name: "A",
            agentRole: "coder",
            dependsOn: ["c"],
            successCondition: "always",
            retryPolicy: { maxAttempts: 1, escalateModel: false },
          },
          {
            id: "b",
            name: "B",
            agentRole: "reviewer",
            dependsOn: ["a"],
            successCondition: "always",
            retryPolicy: { maxAttempts: 1, escalateModel: false },
          },
          {
            id: "c",
            name: "C",
            agentRole: "merger",
            dependsOn: ["b"],
            successCondition: "always",
            retryPolicy: { maxAttempts: 1, escalateModel: false },
          },
        ],
      };

      expect(() => service.validate(workflow)).toThrow("cycle");
    });

    it("should accept acyclic multi-step workflows", () => {
      const workflow: WorkflowDefinition = {
        id: "diamond",
        name: "Diamond",
        version: 1,
        steps: [
          {
            id: "code",
            name: "Code",
            agentRole: "coder",
            dependsOn: [],
            successCondition: "tests_pass",
            retryPolicy: { maxAttempts: 3, escalateModel: true },
          },
          {
            id: "security",
            name: "Security Review",
            agentRole: "reviewer",
            dependsOn: ["code"],
            successCondition: "review_approved",
            retryPolicy: { maxAttempts: 2, escalateModel: false },
          },
          {
            id: "quality",
            name: "Quality Review",
            agentRole: "reviewer",
            dependsOn: ["code"],
            successCondition: "review_approved",
            retryPolicy: { maxAttempts: 2, escalateModel: false },
          },
          {
            id: "merge",
            name: "Merge",
            agentRole: "merger",
            dependsOn: ["security", "quality"],
            successCondition: "merge_clean",
            retryPolicy: { maxAttempts: 2, escalateModel: false },
          },
        ],
      };

      expect(() => service.validate(workflow)).not.toThrow();
    });
  });

  describe("topologicalSort", () => {
    it("should sort the default workflow correctly", () => {
      const sorted = service.topologicalSort(DEFAULT_WORKFLOW);
      const ids = sorted.map((s) => s.id);
      expect(ids.indexOf("code")).toBeLessThan(ids.indexOf("review"));
      expect(ids.indexOf("review")).toBeLessThan(ids.indexOf("merge"));
    });

    it("should sort a diamond dependency graph", () => {
      const workflow: WorkflowDefinition = {
        id: "diamond",
        name: "Diamond",
        version: 1,
        steps: [
          {
            id: "merge",
            name: "Merge",
            agentRole: "merger",
            dependsOn: ["security", "quality"],
            successCondition: "merge_clean",
            retryPolicy: { maxAttempts: 2, escalateModel: false },
          },
          {
            id: "quality",
            name: "Quality",
            agentRole: "reviewer",
            dependsOn: ["code"],
            successCondition: "review_approved",
            retryPolicy: { maxAttempts: 2, escalateModel: false },
          },
          {
            id: "code",
            name: "Code",
            agentRole: "coder",
            dependsOn: [],
            successCondition: "tests_pass",
            retryPolicy: { maxAttempts: 3, escalateModel: true },
          },
          {
            id: "security",
            name: "Security",
            agentRole: "reviewer",
            dependsOn: ["code"],
            successCondition: "review_approved",
            retryPolicy: { maxAttempts: 2, escalateModel: false },
          },
        ],
      };

      const sorted = service.topologicalSort(workflow);
      const ids = sorted.map((s) => s.id);

      // "code" must come before both reviews, both reviews must come before merge
      expect(ids.indexOf("code")).toBeLessThan(ids.indexOf("security"));
      expect(ids.indexOf("code")).toBeLessThan(ids.indexOf("quality"));
      expect(ids.indexOf("security")).toBeLessThan(ids.indexOf("merge"));
      expect(ids.indexOf("quality")).toBeLessThan(ids.indexOf("merge"));
    });
  });

  describe("initExecutionState", () => {
    it("should set all steps to pending", () => {
      const state = service.initExecutionState(DEFAULT_WORKFLOW, "task-1");
      expect(state.workflowId).toBe("default");
      expect(state.taskId).toBe("task-1");
      expect(state.currentStepId).toBeNull();
      expect(Object.values(state.stepStates)).toEqual(["pending", "pending", "pending"]);
    });
  });

  describe("getNextStep", () => {
    it("should return the first step when all are pending", () => {
      const state = service.initExecutionState(DEFAULT_WORKFLOW, "task-1");
      const next = service.getNextStep(DEFAULT_WORKFLOW, state);
      expect(next?.id).toBe("code");
    });

    it("should return review after coding is complete", () => {
      const state = service.initExecutionState(DEFAULT_WORKFLOW, "task-1");
      state.stepStates.code = "completed";
      const next = service.getNextStep(DEFAULT_WORKFLOW, state);
      expect(next?.id).toBe("review");
    });

    it("should return merge after review is complete", () => {
      const state = service.initExecutionState(DEFAULT_WORKFLOW, "task-1");
      state.stepStates.code = "completed";
      state.stepStates.review = "completed";
      const next = service.getNextStep(DEFAULT_WORKFLOW, state);
      expect(next?.id).toBe("merge");
    });

    it("should return null when all steps are complete", () => {
      const state = service.initExecutionState(DEFAULT_WORKFLOW, "task-1");
      state.stepStates.code = "completed";
      state.stepStates.review = "completed";
      state.stepStates.merge = "completed";
      const next = service.getNextStep(DEFAULT_WORKFLOW, state);
      expect(next).toBeNull();
    });

    it("should not skip past failed dependencies", () => {
      const state = service.initExecutionState(DEFAULT_WORKFLOW, "task-1");
      state.stepStates.code = "failed";
      const next = service.getNextStep(DEFAULT_WORKFLOW, state);
      // review depends on code; code is failed, so review can't run
      expect(next).toBeNull();
    });

    it("should handle parallel steps in a diamond correctly", () => {
      const workflow: WorkflowDefinition = {
        id: "diamond",
        name: "Diamond",
        version: 1,
        steps: [
          {
            id: "code",
            name: "Code",
            agentRole: "coder",
            dependsOn: [],
            successCondition: "tests_pass",
            retryPolicy: { maxAttempts: 3, escalateModel: true },
          },
          {
            id: "security",
            name: "Security",
            agentRole: "reviewer",
            dependsOn: ["code"],
            successCondition: "review_approved",
            retryPolicy: { maxAttempts: 2, escalateModel: false },
          },
          {
            id: "quality",
            name: "Quality",
            agentRole: "reviewer",
            dependsOn: ["code"],
            successCondition: "review_approved",
            retryPolicy: { maxAttempts: 2, escalateModel: false },
          },
          {
            id: "merge",
            name: "Merge",
            agentRole: "merger",
            dependsOn: ["security", "quality"],
            successCondition: "merge_clean",
            retryPolicy: { maxAttempts: 2, escalateModel: false },
          },
        ],
      };

      const state = service.initExecutionState(workflow, "task-1");
      state.stepStates.code = "completed";

      // Both security and quality are ready — returns the first in topological order
      const next = service.getNextStep(workflow, state);
      expect(next?.id === "security" || next?.id === "quality").toBe(true);

      // Complete one, the other should be next
      state.stepStates[next!.id] = "completed";
      const next2 = service.getNextStep(workflow, state);
      expect(next2?.id === "security" || next2?.id === "quality").toBe(true);
      expect(next2?.id).not.toBe(next?.id);

      // Merge only available after both done
      state.stepStates[next2!.id] = "completed";
      const next3 = service.getNextStep(workflow, state);
      expect(next3?.id).toBe("merge");
    });
  });

  describe("isComplete / isStuck", () => {
    it("should report complete when all steps are done", () => {
      const state = service.initExecutionState(DEFAULT_WORKFLOW, "task-1");
      state.stepStates.code = "completed";
      state.stepStates.review = "completed";
      state.stepStates.merge = "completed";
      expect(service.isComplete(state)).toBe(true);
      expect(service.isStuck(DEFAULT_WORKFLOW, state)).toBe(false);
    });

    it("should report complete when steps are completed or skipped", () => {
      const state = service.initExecutionState(DEFAULT_WORKFLOW, "task-1");
      state.stepStates.code = "completed";
      state.stepStates.review = "skipped";
      state.stepStates.merge = "completed";
      expect(service.isComplete(state)).toBe(true);
    });

    it("should report stuck when a dependency failed", () => {
      const state = service.initExecutionState(DEFAULT_WORKFLOW, "task-1");
      state.stepStates.code = "failed";
      expect(service.isComplete(state)).toBe(false);
      expect(service.isStuck(DEFAULT_WORKFLOW, state)).toBe(true);
    });

    it("should not report stuck when a step is in_progress", () => {
      const state = service.initExecutionState(DEFAULT_WORKFLOW, "task-1");
      state.stepStates.code = "in_progress";
      state.currentStepId = "code";
      expect(service.isStuck(DEFAULT_WORKFLOW, state)).toBe(false);
    });
  });

  describe("loadWorkflow", () => {
    it("should return default workflow when no file exists", async () => {
      const workflow = await service.loadWorkflow(tmpDir);
      expect(workflow.id).toBe("default");
      expect(workflow.steps).toHaveLength(3);
    });

    it("should load custom workflow from disk", async () => {
      const custom: WorkflowDefinition = {
        id: "custom",
        name: "Custom Flow",
        version: 1,
        steps: [
          {
            id: "code",
            name: "Code",
            agentRole: "coder",
            dependsOn: [],
            successCondition: "tests_pass",
            retryPolicy: { maxAttempts: 3, escalateModel: true },
          },
        ],
      };

      await fs.writeFile(path.join(tmpDir, ".opensprint", "workflow.json"), JSON.stringify(custom));

      const workflow = await service.loadWorkflow(tmpDir);
      expect(workflow.id).toBe("custom");
      expect(workflow.steps).toHaveLength(1);
    });

    it("should fall back to default on invalid custom workflow", async () => {
      await fs.writeFile(path.join(tmpDir, ".opensprint", "workflow.json"), "not valid json");

      const workflow = await service.loadWorkflow(tmpDir);
      expect(workflow.id).toBe("default");
    });

    it("should throw on structurally invalid custom workflow", async () => {
      const invalid: WorkflowDefinition = {
        id: "invalid",
        name: "Invalid",
        version: 1,
        steps: [],
      };

      await fs.writeFile(
        path.join(tmpDir, ".opensprint", "workflow.json"),
        JSON.stringify(invalid)
      );

      await expect(service.loadWorkflow(tmpDir)).rejects.toThrow(WorkflowValidationError);
    });
  });
});
