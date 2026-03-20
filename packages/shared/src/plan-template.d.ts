/**
 * Plan markdown template and validation per PRD §7.2.3.
 * Each Plan markdown file follows a standardized template with required sections.
 */
/** Required section headings per PRD §7.2.3 (in order) */
export declare const PLAN_MARKDOWN_SECTIONS: readonly [
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
];
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
export declare function getPlanTemplate(featureTitle: string): string;
/**
 * Validates plan markdown content against the PRD §7.2.3 template structure.
 * Returns missing sections and warnings. Does NOT block — warn only.
 */
export declare function validatePlanContent(content: string): PlanValidationResult;
//# sourceMappingURL=plan-template.d.ts.map
