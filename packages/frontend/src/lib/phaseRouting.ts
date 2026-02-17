import type { ProjectPhase } from "@opensprint/shared";

export const VALID_PHASES: ProjectPhase[] = ["dream", "plan", "build", "verify"];

/**
 * Parses a URL slug into a valid ProjectPhase. Returns "dream" for invalid or missing slugs.
 */
export function phaseFromSlug(slug: string | undefined): ProjectPhase {
  if (slug && VALID_PHASES.includes(slug as ProjectPhase)) return slug as ProjectPhase;
  return "dream";
}

/**
 * Returns true if the slug is a valid phase.
 */
export function isValidPhaseSlug(slug: string | undefined): slug is ProjectPhase {
  return !!slug && VALID_PHASES.includes(slug as ProjectPhase);
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
  const base = `/projects/${projectId}/${phase}`;
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
