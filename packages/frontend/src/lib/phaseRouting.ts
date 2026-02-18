import type { ProjectPhase } from "@opensprint/shared";

export const VALID_PHASES: ProjectPhase[] = ["sketch", "plan", "execute", "eval", "deliver"];

/** URL slugs for each phase. Sketch phase uses "sketch" in URL. */
const PHASE_TO_SLUG: Record<ProjectPhase, string> = {
  sketch: "sketch",
  plan: "plan",
  execute: "execute",
  eval: "eval",
  deliver: "deliver",
};

const SLUG_TO_PHASE: Record<string, ProjectPhase> = {
  sketch: "sketch",
  spec: "sketch", // legacy; /spec redirects to /sketch
  plan: "plan",
  execute: "execute",
  eval: "eval",
  deliver: "deliver",
};

/** Valid URL slugs. */
export const VALID_PHASE_SLUGS = ["sketch", "plan", "execute", "eval", "deliver"] as const;

/**
 * Parses a URL slug into a valid ProjectPhase. Returns "sketch" for invalid or missing slugs.
 * Accepts "spec" as legacy alias for "sketch".
 */
export function phaseFromSlug(slug: string | undefined): ProjectPhase {
  if (slug && slug in SLUG_TO_PHASE) return SLUG_TO_PHASE[slug];
  return "sketch";
}

/**
 * Returns true if the slug is a valid phase URL slug.
 * "sketch" is valid; "spec" is not (triggers redirect to /sketch).
 */
export function isValidPhaseSlug(slug: string | undefined): slug is (typeof VALID_PHASE_SLUGS)[number] {
  return !!slug && VALID_PHASE_SLUGS.includes(slug as (typeof VALID_PHASE_SLUGS)[number]);
}

/** Query param keys for deep linking to Plan/Build detail panes */
export const PLAN_PARAM = "plan";
export const TASK_PARAM = "task";

export interface PhasePathOptions {
  /** Plan ID to deep link to (Plan phase detail pane) */
  plan?: string | null;
  /** Task ID to deep link to (Build phase detail pane) */
  task?: string | null;
}

/**
 * Builds the project phase path. Always includes the phase in the URL for shareable links.
 * Optionally appends plan or task query params for deep linking to detail panes.
 */
export function getProjectPhasePath(
  projectId: string,
  phase: ProjectPhase,
  options?: PhasePathOptions,
): string {
  const slug = PHASE_TO_SLUG[phase];
  const base = `/projects/${projectId}/${slug}`;
  const params = new URLSearchParams();
  if (options?.plan) params.set(PLAN_PARAM, options.plan);
  if (options?.task) params.set(TASK_PARAM, options.task);
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

/**
 * Parses plan and task IDs from URL search params.
 */
export function parseDetailParams(search: string): { plan: string | null; task: string | null } {
  const params = new URLSearchParams(search);
  return {
    plan: params.get(PLAN_PARAM),
    task: params.get(TASK_PARAM),
  };
}
