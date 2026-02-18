import { describe, it, expect } from "vitest";
import {
  PRD_SECTION_ORDER,
  PRD_SOURCE_COLORS,
  PRD_SOURCE_LABELS,
  getPrdSourceColor,
} from "./constants";

describe("constants", () => {
  describe("PRD_SECTION_ORDER", () => {
    it("contains expected section keys in order", () => {
      expect(PRD_SECTION_ORDER[0]).toBe("executive_summary");
      expect(PRD_SECTION_ORDER).toContain("problem_statement");
      expect(PRD_SECTION_ORDER).toContain("open_questions");
      expect(PRD_SECTION_ORDER.length).toBe(10);
    });
  });

  describe("PRD_SOURCE_LABELS", () => {
    it("maps sketch to Sketch for user-facing display", () => {
      expect(PRD_SOURCE_LABELS.sketch).toBe("Sketch");
      expect(PRD_SOURCE_LABELS.plan).toBe("Plan");
      expect(PRD_SOURCE_LABELS.execute).toBe("Execute");
      expect(PRD_SOURCE_LABELS.eval).toBe("Eval");
      expect(PRD_SOURCE_LABELS.deliver).toBe("Deliver");
    });
  });

  describe("PRD_SOURCE_COLORS", () => {
    it("has colors for sketch, plan, execute, eval, deliver", () => {
      expect(PRD_SOURCE_COLORS.sketch).toBe("bg-blue-100 text-blue-800");
      expect(PRD_SOURCE_COLORS.plan).toBe("bg-amber-100 text-amber-800");
      expect(PRD_SOURCE_COLORS.execute).toBe("bg-green-100 text-green-800");
      expect(PRD_SOURCE_COLORS.eval).toBe("bg-purple-100 text-purple-800");
      expect(PRD_SOURCE_COLORS.deliver).toBe("bg-slate-100 text-slate-800");
    });
  });

  describe("getPrdSourceColor", () => {
    it("returns known source colors", () => {
      expect(getPrdSourceColor("sketch")).toBe("bg-blue-100 text-blue-800");
      expect(getPrdSourceColor("plan")).toBe("bg-amber-100 text-amber-800");
      expect(getPrdSourceColor("execute")).toBe("bg-green-100 text-green-800");
      expect(getPrdSourceColor("eval")).toBe("bg-purple-100 text-purple-800");
      expect(getPrdSourceColor("deliver")).toBe("bg-slate-100 text-slate-800");
    });

    it("returns default purple for unknown sources", () => {
      expect(getPrdSourceColor("unknown")).toBe("bg-purple-100 text-purple-800");
      expect(getPrdSourceColor("")).toBe("bg-purple-100 text-purple-800");
    });
  });
});
