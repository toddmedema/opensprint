import { describe, it, expect } from "vitest";
import { prdToSpecMarkdown, specMarkdownToPrd } from "../spec-serializer.js";
import type { Prd } from "../types/prd.js";

describe("spec-serializer", () => {
  it("round-trips Prd to markdown and back", () => {
    const prd: Prd = {
      version: 2,
      sections: {
        executive_summary: {
          content: "A todo app.",
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        problem_statement: {
          content: "Users need task management.",
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      changeLog: [],
    };
    const markdown = prdToSpecMarkdown(prd);
    expect(markdown).toContain("# Product Specification");
    expect(markdown).toContain("## Executive Summary");
    expect(markdown).toContain("A todo app.");
    expect(markdown).toContain("## Problem Statement");
    expect(markdown).toContain("Users need task management.");

    const parsed = specMarkdownToPrd(markdown, { version: 2, changeLog: [] });
    expect(parsed.sections.executive_summary?.content).toBe("A todo app.");
    expect(parsed.sections.problem_statement?.content).toBe("Users need task management.");
    expect(parsed.version).toBe(2);
  });

  it("handles dynamic sections (e.g. competitive_landscape)", () => {
    const prd: Prd = {
      version: 0,
      sections: {
        competitive_landscape: {
          content: "Main competitors: X, Y, Z.",
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      changeLog: [],
    };
    const markdown = prdToSpecMarkdown(prd);
    expect(markdown).toContain("## Competitive Landscape");
    expect(markdown).toContain("Main competitors: X, Y, Z.");

    const parsed = specMarkdownToPrd(markdown);
    expect(parsed.sections.competitive_landscape?.content).toBe("Main competitors: X, Y, Z.");
  });

  it("handles empty sections", () => {
    const prd: Prd = {
      version: 0,
      sections: {
        executive_summary: {
          content: "",
          version: 0,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      changeLog: [],
    };
    const markdown = prdToSpecMarkdown(prd);
    expect(markdown).toContain("_No content yet_");

    const parsed = specMarkdownToPrd(markdown);
    expect(parsed.sections.executive_summary?.content).toBe("");
  });
});
