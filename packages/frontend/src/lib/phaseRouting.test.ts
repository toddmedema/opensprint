import { describe, it, expect } from "vitest";
import {
  phaseFromSlug,
  isValidPhaseSlug,
  getProjectPhasePath,
  parseDetailParams,
  VALID_PHASES,
  VALID_PHASE_SLUGS,
  PLAN_PARAM,
  TASK_PARAM,
} from "./phaseRouting";

describe("phaseRouting", () => {
  describe("phaseFromSlug", () => {
    it("returns sketch for undefined slug", () => {
      expect(phaseFromSlug(undefined)).toBe("sketch");
    });

    it("returns sketch for empty string", () => {
      expect(phaseFromSlug("")).toBe("sketch");
    });

    it("returns phase for valid slugs (sketch maps to sketch)", () => {
      expect(phaseFromSlug("sketch")).toBe("sketch");
      expect(phaseFromSlug("plan")).toBe("plan");
      expect(phaseFromSlug("execute")).toBe("execute");
      expect(phaseFromSlug("eval")).toBe("eval");
      expect(phaseFromSlug("deliver")).toBe("deliver");
    });

    it("returns sketch for spec slug (legacy alias)", () => {
      expect(phaseFromSlug("spec")).toBe("sketch");
    });

    it("returns sketch for invalid slugs", () => {
      expect(phaseFromSlug("invalid")).toBe("sketch");
      expect(phaseFromSlug("design")).toBe("sketch");
      expect(phaseFromSlug("validate")).toBe("sketch");
    });
  });

  describe("isValidPhaseSlug", () => {
    it("returns false for undefined", () => {
      expect(isValidPhaseSlug(undefined)).toBe(false);
    });

    it("returns false for invalid slugs and legacy spec", () => {
      expect(isValidPhaseSlug("")).toBe(false);
      expect(isValidPhaseSlug("invalid")).toBe(false);
      expect(isValidPhaseSlug("spec")).toBe(false); // spec redirects to sketch
    });

    it("returns true for valid slugs", () => {
      expect(isValidPhaseSlug("sketch")).toBe(true);
      expect(isValidPhaseSlug("plan")).toBe(true);
      expect(isValidPhaseSlug("execute")).toBe(true);
      expect(isValidPhaseSlug("eval")).toBe(true);
      expect(isValidPhaseSlug("deliver")).toBe(true);
    });
  });

  describe("getProjectPhasePath", () => {
    it("builds path with sketch for sketch phase, others unchanged", () => {
      expect(getProjectPhasePath("proj-123", "sketch")).toBe("/projects/proj-123/sketch");
      expect(getProjectPhasePath("proj-123", "plan")).toBe("/projects/proj-123/plan");
      expect(getProjectPhasePath("proj-123", "execute")).toBe("/projects/proj-123/execute");
      expect(getProjectPhasePath("proj-123", "eval")).toBe("/projects/proj-123/eval");
      expect(getProjectPhasePath("proj-123", "deliver")).toBe("/projects/proj-123/deliver");
    });

    it("handles different project IDs", () => {
      expect(getProjectPhasePath("abc", "sketch")).toBe("/projects/abc/sketch");
      expect(getProjectPhasePath("uuid-xyz-789", "execute")).toBe("/projects/uuid-xyz-789/execute");
    });

    it("appends plan param for Plan phase deep linking", () => {
      expect(getProjectPhasePath("proj-1", "plan", { plan: "opensprint.dev-abc" })).toBe(
        "/projects/proj-1/plan?plan=opensprint.dev-abc",
      );
    });

    it("appends task param for Execute phase deep linking", () => {
      expect(getProjectPhasePath("proj-1", "execute", { task: "opensprint.dev-abc.1" })).toBe(
        "/projects/proj-1/execute?task=opensprint.dev-abc.1",
      );
    });

    it("appends both plan and task when provided", () => {
      const path = getProjectPhasePath("proj-1", "execute", {
        plan: "opensprint.dev-abc",
        task: "opensprint.dev-abc.1",
      });
      expect(path).toContain("/projects/proj-1/execute?");
      expect(path).toContain("plan=opensprint.dev-abc");
      expect(path).toContain("task=opensprint.dev-abc.1");
    });

    it("ignores null/empty options", () => {
      expect(getProjectPhasePath("proj-1", "plan", { plan: null })).toBe("/projects/proj-1/plan");
      expect(getProjectPhasePath("proj-1", "plan", { plan: "" })).toBe("/projects/proj-1/plan");
    });
  });

  describe("parseDetailParams", () => {
    it("returns null for both when search is empty", () => {
      expect(parseDetailParams("")).toEqual({ plan: null, task: null });
      expect(parseDetailParams("?")).toEqual({ plan: null, task: null });
    });

    it("parses plan param", () => {
      expect(parseDetailParams("?plan=opensprint.dev-xyz")).toEqual({
        plan: "opensprint.dev-xyz",
        task: null,
      });
    });

    it("parses task param", () => {
      expect(parseDetailParams("?task=opensprint.dev-xyz.1")).toEqual({
        plan: null,
        task: "opensprint.dev-xyz.1",
      });
    });

    it("parses both params", () => {
      expect(parseDetailParams("?plan=opensprint.dev-abc&task=opensprint.dev-abc.1")).toEqual({
        plan: "opensprint.dev-abc",
        task: "opensprint.dev-abc.1",
      });
    });
  });

  describe("PLAN_PARAM and TASK_PARAM", () => {
    it("exports correct param names", () => {
      expect(PLAN_PARAM).toBe("plan");
      expect(TASK_PARAM).toBe("task");
    });
  });

  describe("VALID_PHASES", () => {
    it("contains all five phases in order", () => {
      expect(VALID_PHASES).toEqual(["sketch", "plan", "execute", "eval", "deliver"]);
    });
  });

  describe("VALID_PHASE_SLUGS", () => {
    it("uses sketch not spec for URL slugs", () => {
      expect(VALID_PHASE_SLUGS).toEqual(["sketch", "plan", "execute", "eval", "deliver"]);
    });
  });
});
