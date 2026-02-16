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

/**
 * Builds the project phase path. Always includes the phase in the URL for shareable links.
 */
export function getProjectPhasePath(projectId: string, phase: ProjectPhase): string {
  return `/projects/${projectId}/${phase}`;
}
