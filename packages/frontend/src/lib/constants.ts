/**
 * Shared constants for the frontend.
 */

/** Base URL for public assets (Vite BASE_URL); use for agent icons, etc. when app is served from a subpath. */
export const ASSET_BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/*$/, "/");

/** Navbar height in px — used for fixed positioning (e.g. NotificationBar) and layout consistency. */
export const NAVBAR_HEIGHT = 56;

/** OpenSprint GitHub repository URL. */
export const GITHUB_REPO_URL = "https://github.com/toddmedema/opensprint.dev";

/**
 * Tailwind classes for content containers that must share the same width.
 * Used by: evaluate feedback input.
 * Ensures consistent layout across viewport sizes regardless of content.
 */
export const CONTENT_CONTAINER_CLASS = "max-w-3xl mx-auto px-6" as const;

/**
 * Wider container for homepage (header + project cards).
 * ~50% wider than CONTENT_CONTAINER_CLASS, plus ~20% extra for create button spacing,
 * plus another ~20% for adequate spacing from header text.
 */
export const HOMEPAGE_CONTAINER_CLASS = "max-w-[104rem] mx-auto px-6" as const;

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
  plan: "Plan",
  execute: "Execute",
  eval: "Evaluate",
  deliver: "Deliver",
};

/** Tailwind class pairs for PRD change log source badges (bg-* text-*). Theme-aware. */
export const PRD_SOURCE_COLORS: Record<string, string> = {
  sketch: "bg-theme-info-bg text-theme-info-text",
  plan: "bg-theme-warning-bg text-theme-warning-text",
  execute: "bg-theme-success-bg text-theme-success-text",
  eval: "bg-theme-feedback-feature-bg text-theme-feedback-feature-text",
  deliver: "bg-theme-surface-muted text-theme-text",
};

/** Poll interval (ms) for active agents dropdown. */
export const ACTIVE_AGENTS_POLL_INTERVAL_MS = 5000;

/** z-index for agents/notifications dropdown portal — above sidebar and Navbar. */
export const DROPDOWN_PORTAL_Z_INDEX = 9999;

/** Icon size matching two lines of text-sm in agent dropdown rows. */
export const AGENT_DROPDOWN_ICON_SIZE = "3.01875rem";

/** Default color for unknown PRD sources. */
const PRD_SOURCE_DEFAULT = "bg-theme-feedback-feature-bg text-theme-feedback-feature-text";

/** Returns Tailwind classes for a PRD change log source. */
export function getPrdSourceColor(source: string): string {
  return PRD_SOURCE_COLORS[source] ?? PRD_SOURCE_DEFAULT;
}
