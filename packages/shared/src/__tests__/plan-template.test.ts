import { describe, it, expect } from "vitest";
import { PLAN_MARKDOWN_SECTIONS, getPlanTemplate, validatePlanContent } from "../plan-template.js";

describe("plan-template", () => {
  describe("PLAN_MARKDOWN_SECTIONS", () => {
    it("includes all PRD §7.2.3 required sections", () => {
      expect(PLAN_MARKDOWN_SECTIONS).toEqual([
        "Overview",
        "Assumptions",
        "Acceptance Criteria",
        "Technical Approach",
        "Dependencies",
        "Data Model Changes",
        "API Specification",
        "UI/UX Requirements",
        "Edge Cases and Error Handling",
        "Testing Strategy",
        "Estimated Complexity",
      ]);
    });
  });

  describe("getPlanTemplate", () => {
    it("returns template with feature title as H1", () => {
      const result = getPlanTemplate("User Authentication");
      expect(result).toContain("# User Authentication");
      expect(result).not.toContain("# Feature");
    });

    it("includes all required sections", () => {
      const result = getPlanTemplate("My Feature");
      for (const section of PLAN_MARKDOWN_SECTIONS) {
        expect(result).toContain(`## ${section}`);
      }
    });

    it("handles empty title by using 'Feature'", () => {
      const result = getPlanTemplate("");
      expect(result).toContain("# Feature");
    });

    it("trims whitespace from title", () => {
      const result = getPlanTemplate("  Auth  ");
      expect(result).toContain("# Auth");
    });
  });

  describe("validatePlanContent", () => {
    it("returns no missing sections when all are present", () => {
      const content = getPlanTemplate("Test Feature");
      const result = validatePlanContent(content);
      expect(result.missing).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("identifies missing sections", () => {
      const content = `# My Plan

## Overview

Some text.

## Assumptions

None stated.

## Acceptance Criteria

- Criterion 1
`;
      const result = validatePlanContent(content);
      expect(result.missing).not.toContain("Assumptions");
      expect(result.missing).toContain("Technical Approach");
    });

    it("flags missing Assumptions when section is absent", () => {
      const content = `# My Plan

## Overview

Some text.

## Acceptance Criteria

- Criterion 1
`;
      const result = validatePlanContent(content);
      expect(result.missing).toContain("Assumptions");
      expect(result.missing).toContain("Dependencies");
      expect(result.missing).toContain("Data Model Changes");
      expect(result.missing).toContain("API Specification");
      expect(result.missing).toContain("UI/UX Requirements");
      expect(result.missing).toContain("Edge Cases and Error Handling");
      expect(result.missing).toContain("Testing Strategy");
      expect(result.missing).toContain("Estimated Complexity");
      expect(result.missing).not.toContain("Overview");
      expect(result.missing).not.toContain("Acceptance Criteria");
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("missing required sections");
    });

    it("handles empty content", () => {
      const result = validatePlanContent("");
      expect(result.missing).toHaveLength(PLAN_MARKDOWN_SECTIONS.length);
      expect(result.warnings).toContain("Plan content is empty");
    });

    it("handles content with only whitespace", () => {
      const result = validatePlanContent("   \n\n  ");
      expect(result.missing.length).toBeGreaterThan(0);
    });

    it("matches section with parenthetical (e.g. Acceptance Criteria (with testable conditions))", () => {
      const content = `# Plan

## Overview

Text.

## Assumptions

Inherited from PRD.

## Acceptance Criteria (with testable conditions)

- Criterion

## Technical Approach

Approach.

## Dependencies

None.

## Data Model Changes

None.

## API Specification

REST.

## UI/UX Requirements

UI.

## Edge Cases and Error Handling

Errors.

## Testing Strategy

Tests.

## Estimated Complexity

medium
`;
      const result = validatePlanContent(content);
      expect(result.missing).toHaveLength(0);
    });

    it("is case-insensitive for section matching", () => {
      const content = `# Plan

## overview

Text.

## assumptions

None beyond PRD.

## ACCEPTANCE CRITERIA

- Criterion

## technical approach

Approach.

## dependencies

None.

## data model changes

None.

## api specification

REST.

## ui/ux requirements

UI.

## edge cases and error handling

Errors.

## testing strategy

Tests.

## estimated complexity

medium
`;
      const result = validatePlanContent(content);
      expect(result.missing).toHaveLength(0);
    });
  });
});
