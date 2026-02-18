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
  eval: "Eval",
  deliver: "Deliver",
};

/** Tailwind class pairs for PRD change log source badges (bg-* text-*). */
export const PRD_SOURCE_COLORS: Record<string, string> = {
  sketch: "bg-blue-100 text-blue-800",
  spec: "bg-blue-100 text-blue-800", // legacy alias
  plan: "bg-amber-100 text-amber-800",
  execute: "bg-green-100 text-green-800",
  eval: "bg-purple-100 text-purple-800",
  deliver: "bg-slate-100 text-slate-800",
};

/** Default color for unknown PRD sources. */
const PRD_SOURCE_DEFAULT = "bg-purple-100 text-purple-800";

/** Returns Tailwind classes for a PRD change log source. */
export function getPrdSourceColor(source: string): string {
  return PRD_SOURCE_COLORS[source] ?? PRD_SOURCE_DEFAULT;
}
