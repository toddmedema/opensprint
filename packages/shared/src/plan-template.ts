/**
 * Plan markdown template and validation per PRD §7.2.3.
 * Each Plan markdown file follows a standardized template with required sections.
 */

/** Required section headings per PRD §7.2.3 (in order) */
export const PLAN_MARKDOWN_SECTIONS = [
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
] as const;

export type PlanSectionName = (typeof PLAN_MARKDOWN_SECTIONS)[number];

/** Result of validating plan content against the template */
export interface PlanValidationResult {
  /** Section headings that are missing from the content */
  missing: PlanSectionName[];
  /** Warning messages (e.g., missing sections) */
  warnings: string[];
}

/**
 * Returns the Plan markdown template with the given feature title.
 * Per PRD §7.2.3: Feature Title, Overview, Assumptions, Acceptance Criteria, Technical Approach,
 * Dependencies, Data Model Changes, API Specification, UI/UX Requirements,
 * Edge Cases and Error Handling, Testing Strategy, Estimated Complexity.
 */
export function getPlanTemplate(featureTitle: string): string {
  const title = featureTitle.trim() || "Feature";
  return `# ${title}

## Overview

Brief description of the feature and its purpose.

## Assumptions

Explicit beliefs for this plan (what we are treating as true), each with brief rationale and what changes if wrong. Use markdown list bullets (-). If everything is inherited from the PRD, state that and add only plan-specific assumptions.

## Acceptance Criteria

- [ ] Criterion 1 (testable condition)
- [ ] Criterion 2 (testable condition)
- [ ] Criterion 3 (testable condition)

## Technical Approach

Describe the technical implementation approach.

## Dependencies

References to other Plan files this feature depends on (if any).

## Data Model Changes

Schema or data model updates required.

## API Specification

Endpoints and contracts for this feature.

## UI/UX Requirements

User interface and experience requirements.

## Edge Cases and Error Handling

How to handle errors and edge cases.

## Testing Strategy

How this feature will be tested.

## Estimated Complexity

low | medium | high | very_high

## Tasks

### 1. Task title
Description and acceptance criteria for this task.

### 2. Another task
Description for the second task.
`;
}

/**
 * Validates plan markdown content against the PRD §7.2.3 template structure.
 * Returns missing sections and warnings. Does NOT block — warn only.
 */
export function validatePlanContent(content: string): PlanValidationResult {
  const missing: PlanSectionName[] = [];
  const warnings: string[] = [];

  if (!content?.trim()) {
    return {
      missing: [...PLAN_MARKDOWN_SECTIONS],
      warnings: ["Plan content is empty"],
    };
  }

  const normalized = content.replace(/\r\n/g, "\n");
  for (const section of PLAN_MARKDOWN_SECTIONS) {
    // Match ## Section at start of line (section may have parenthetical, e.g. "Acceptance Criteria (with testable conditions)")
    const pattern = new RegExp(`^##\\s+${escapeRegex(section)}(?:\\s|\\(|$)`, "im");
    if (!pattern.test(normalized)) {
      missing.push(section);
    }
  }

  if (missing.length > 0) {
    warnings.push(`Plan is missing required sections (PRD §7.2.3): ${missing.join(", ")}`);
  }

  return { missing, warnings };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
