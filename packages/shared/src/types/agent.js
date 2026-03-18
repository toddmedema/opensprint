/** Map role to slot */
export function getSlotForRole(role) {
  return role === "coder" || role === "reviewer" || role === "merger" ? "coding" : "planning";
}
/**
 * Canonical display order for agent roles (README/PRD §6.3 Named Agent Roles table).
 * Used to sort agent icons in the 'Agents Running' indicator and dropdown.
 */
export const AGENT_ROLE_CANONICAL_ORDER = [
  "dreamer",
  "planner",
  "harmonizer",
  "analyst",
  "summarizer",
  "auditor",
  "coder",
  "reviewer",
  "merger",
];
/** Index of role in canonical order; unknown roles sort last. */
function getRoleSortIndex(roleOrPhase) {
  const idx = AGENT_ROLE_CANONICAL_ORDER.indexOf(roleOrPhase);
  return idx >= 0 ? idx : AGENT_ROLE_CANONICAL_ORDER.length;
}
/** Resolve agent to a role string for sorting (role or phase-derived). */
function getSortRole(agent) {
  if (agent.role && AGENT_ROLE_CANONICAL_ORDER.includes(agent.role)) return agent.role;
  if (agent.phase === "review") return "reviewer";
  if (agent.phase === "coding") return "coder";
  return agent.phase ?? "";
}
/** Sort agents by canonical role order (README/PRD table). */
export function sortAgentsByCanonicalOrder(list, getAgent) {
  const toRole = (item) => getSortRole(getAgent ? getAgent(item) : item);
  return [...list].sort((a, b) => {
    const ra = toRole(a);
    const rb = toRole(b);
    const ia = getRoleSortIndex(ra);
    const ib = getRoleSortIndex(rb);
    if (ia !== ib) return ia - ib;
    return ra.localeCompare(rb);
  });
}
/** Phase string to display label (for agents without a known role) */
const PHASE_LABELS = {
  spec: "Sketch",
  plan: "Plan",
  execute: "Execute",
  eval: "Evaluate",
  deliver: "Deliver",
  coding: "Coding",
  review: "Review",
};
/**
 * Role display label for dropdown: "Coder (Frodo)" when name present, else "Coder".
 * Uses AGENT_ROLE_LABELS when role is known; otherwise phase label.
 */
export function getRoleDisplayLabel(agent) {
  const roleLabel =
    agent.role && agent.role in AGENT_ROLE_LABELS
      ? AGENT_ROLE_LABELS[agent.role]
      : ((agent.phase && PHASE_LABELS[agent.phase]) ?? agent.phase ?? "");
  return agent.name?.trim() ? `${roleLabel} (${agent.name.trim()})` : roleLabel;
}
/** Human-readable display label for each role */
export const AGENT_ROLE_LABELS = {
  dreamer: "Dreamer",
  planner: "Planner",
  harmonizer: "Harmonizer",
  analyst: "Analyst",
  summarizer: "Summarizer",
  auditor: "Auditor",
  coder: "Coder",
  reviewer: "Reviewer",
  merger: "Merger",
};
/**
 * Primary phase(s) for each agent role (README/PRD §6.3).
 * Used in Agent reference modal and phase badges.
 */
export const AGENT_ROLE_PHASES = {
  dreamer: ["Sketch"],
  planner: ["Plan"],
  harmonizer: ["All"],
  analyst: ["Evaluate"],
  summarizer: ["Execute"],
  auditor: ["Execute"],
  coder: ["Execute"],
  reviewer: ["Execute"],
  merger: ["Execute"],
};
/**
 * Short description for each agent role (~1 sentence for modal).
 * Matches README table (docs/assets or README.md); single source of truth for Agent reference.
 */
export const AGENT_ROLE_DESCRIPTIONS = {
  dreamer: "Refines your idea into a PRD; asks the hard questions before the journey begins.",
  planner: "Decomposes the PRD into epics, tasks, and dependency graph.",
  harmonizer: "Keeps the PRD true as implementation forces compromises.",
  analyst: "Categorizes feedback and maps it to the right epic.",
  summarizer: "Distills context to exactly what the Coder needs.",
  auditor: "Surveys what's actually built and what still needs doing.",
  coder: "Implements tasks and ships working code with tests.",
  reviewer: "Validates implementation against acceptance criteria.",
  merger: "Resolves rebase conflicts and keeps the journey moving.",
};
//# sourceMappingURL=agent.js.map
