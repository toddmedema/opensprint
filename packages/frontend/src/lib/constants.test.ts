import { describe, it, expect } from "vitest";
import { PRD_SECTION_ORDER, PRD_SOURCE_COLORS, getPrdSourceColor } from "./constants";

describe("constants", () => {
  describe("PRD_SECTION_ORDER", () => {
    it("contains expected section keys in order", () => {
      expect(PRD_SECTION_ORDER[0]).toBe("executive_summary");
      expect(PRD_SECTION_ORDER).toContain("problem_statement");
      expect(PRD_SECTION_ORDER).toContain("open_questions");
      expect(PRD_SECTION_ORDER.length).toBe(10);
    });
  });

  describe("PRD_SOURCE_COLORS", () => {
    it("has colors for dream, plan, build, verify", () => {
      expect(PRD_SOURCE_COLORS.dream).toBe("bg-blue-100 text-blue-800");
      expect(PRD_SOURCE_COLORS.plan).toBe("bg-amber-100 text-amber-800");
      expect(PRD_SOURCE_COLORS.build).toBe("bg-green-100 text-green-800");
      expect(PRD_SOURCE_COLORS.verify).toBe("bg-purple-100 text-purple-800");
    });
  });

  describe("getPrdSourceColor", () => {
    it("returns known source colors", () => {
      expect(getPrdSourceColor("dream")).toBe("bg-blue-100 text-blue-800");
      expect(getPrdSourceColor("plan")).toBe("bg-amber-100 text-amber-800");
      expect(getPrdSourceColor("build")).toBe("bg-green-100 text-green-800");
      expect(getPrdSourceColor("verify")).toBe("bg-purple-100 text-purple-800");
    });

    it("returns default purple for unknown sources", () => {
      expect(getPrdSourceColor("unknown")).toBe("bg-purple-100 text-purple-800");
      expect(getPrdSourceColor("")).toBe("bg-purple-100 text-purple-800");
    });
  });
});
