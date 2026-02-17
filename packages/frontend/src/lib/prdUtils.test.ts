import { describe, it, expect } from "vitest";
import { parsePrdSections, getOrderedSections } from "./prdUtils";

describe("prdUtils", () => {
  describe("parsePrdSections", () => {
    it("extracts content from sections object", () => {
      const prd = {
        sections: {
          executive_summary: { content: "# Summary\nHello world" },
          problem_statement: { content: "The problem is..." },
        },
      };
      expect(parsePrdSections(prd)).toEqual({
        executive_summary: "# Summary\nHello world",
        problem_statement: "The problem is...",
      });
    });

    it("returns empty object for null/undefined", () => {
      expect(parsePrdSections(null)).toEqual({});
      expect(parsePrdSections(undefined)).toEqual({});
    });

    it("returns empty object when sections is missing", () => {
      expect(parsePrdSections({})).toEqual({});
      expect(parsePrdSections({ foo: "bar" })).toEqual({});
    });

    it("returns empty object for empty sections", () => {
      expect(parsePrdSections({ sections: {} })).toEqual({});
    });
  });

  describe("getOrderedSections", () => {
    it("returns sections in canonical order", () => {
      const content = {
        problem_statement: "x",
        executive_summary: "y",
        open_questions: "z",
      };
      const ordered = getOrderedSections(content);
      expect(ordered[0]).toBe("executive_summary");
      expect(ordered[1]).toBe("problem_statement");
      expect(ordered[2]).toBe("open_questions");
    });

    it("appends unknown sections at the end", () => {
      const content = {
        custom_section: "a",
        executive_summary: "b",
      };
      const ordered = getOrderedSections(content);
      expect(ordered[0]).toBe("executive_summary");
      expect(ordered[1]).toBe("custom_section");
    });

    it("only includes sections that exist in content", () => {
      const content = {
        open_questions: "only this",
      };
      const ordered = getOrderedSections(content);
      expect(ordered).toEqual(["open_questions"]);
    });

    it("returns empty array for empty content", () => {
      expect(getOrderedSections({})).toEqual([]);
    });
  });
});
