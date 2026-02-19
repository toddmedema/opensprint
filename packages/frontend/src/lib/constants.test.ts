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
      expect(PRD_SOURCE_LABELS.eval).toBe("Evaluate");
      expect(PRD_SOURCE_LABELS.deliver).toBe("Deliver");
    });
  });

  describe("PRD_SOURCE_COLORS", () => {
    it("has theme-aware colors for sketch, plan, execute, eval, deliver", () => {
      expect(PRD_SOURCE_COLORS.sketch).toContain("bg-theme-info-bg");
      expect(PRD_SOURCE_COLORS.plan).toContain("bg-theme-warning-bg");
      expect(PRD_SOURCE_COLORS.execute).toContain("bg-theme-success-bg");
      expect(PRD_SOURCE_COLORS.eval).toContain("bg-theme-feedback-feature-bg");
      expect(PRD_SOURCE_COLORS.deliver).toContain("bg-theme-surface-muted");
    });
  });

  describe("getPrdSourceColor", () => {
    it("returns known source colors", () => {
      expect(getPrdSourceColor("sketch")).toContain("bg-theme-info-bg");
      expect(getPrdSourceColor("plan")).toContain("bg-theme-warning-bg");
      expect(getPrdSourceColor("execute")).toContain("bg-theme-success-bg");
      expect(getPrdSourceColor("eval")).toContain("bg-theme-feedback-feature-bg");
      expect(getPrdSourceColor("deliver")).toContain("bg-theme-surface-muted");
    });

    it("returns default purple for unknown sources", () => {
      expect(getPrdSourceColor("unknown")).toContain("bg-theme-feedback-feature-bg");
      expect(getPrdSourceColor("")).toContain("bg-theme-feedback-feature-bg");
    });
  });
});
