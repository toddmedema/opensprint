/**
 * Shared constants for the frontend.
 */

/** Canonical order of PRD sections for display. */
export const PRD_SECTION_ORDER = [
  "executive_summary",
  "problem_statement",
  "goals_and_metrics",
  "user_personas",
  "technical_architecture",
  "feature_list",
  "non_functional_requirements",
  "data_model",
  "api_contracts",
  "open_questions",
] as const;

export type PrdSectionKey = (typeof PRD_SECTION_ORDER)[number];

/** Display labels for PRD change log source badges (user-facing phase names). */
export const PRD_SOURCE_LABELS: Record<string, string> = {
  sketch: "Sketch",
  spec: "Sketch", // legacy alias
  plan: "Plan",
  execute: "Execute",
  eval: "Evaluate",
  deliver: "Deliver",
};

/** Tailwind class pairs for PRD change log source badges (bg-* text-*). Theme-aware. */
export const PRD_SOURCE_COLORS: Record<string, string> = {
  sketch: "bg-theme-info-bg text-theme-info-text",
  spec: "bg-theme-info-bg text-theme-info-text", // legacy alias
  plan: "bg-theme-warning-bg text-theme-warning-text",
  execute: "bg-theme-success-bg text-theme-success-text",
  eval: "bg-theme-feedback-feature-bg text-theme-feedback-feature-text",
  deliver: "bg-theme-surface-muted text-theme-text",
};

/** Default color for unknown PRD sources. */
const PRD_SOURCE_DEFAULT = "bg-theme-feedback-feature-bg text-theme-feedback-feature-text";

/** Returns Tailwind classes for a PRD change log source. */
export function getPrdSourceColor(source: string): string {
  return PRD_SOURCE_COLORS[source] ?? PRD_SOURCE_DEFAULT;
}
