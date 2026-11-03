import type { ActiveAgent } from "@opensprint/shared";
import type { ProjectPhase } from "@opensprint/shared";
import { AGENT_ROLE_LABELS, getSlotForRole } from "@opensprint/shared";
import { ASSET_BASE } from "./constants";

/** AGENT_ROLE_PHASES uses display labels; map to URL phase slugs for navigation. */
const ROLE_TO_PHASE: Record<string, ProjectPhase> = {
  dreamer: "sketch",
  planner: "plan",
  harmonizer: "plan",
  analyst: "eval",
  summarizer: "execute",
  auditor: "execute",
  coder: "execute",
  reviewer: "execute",
  judge: "execute",
  merger: "execute",
};

/**
 * Returns the phase to navigate to when the user clicks an agent (e.g. in active agents list).
 * Dreamer → Sketch; Planner → Plan; Analyst → Evaluate; Coder/Reviewer/etc → Execute.
 */
export function getPhaseForAgentNavigation(agent: ActiveAgent): ProjectPhase {
  if (agent.role && agent.role in ROLE_TO_PHASE) {
    return ROLE_TO_PHASE[agent.role];
  }
  if (agent.phase === "review") return "execute";
  if (agent.phase === "coding") return "execute";
  if (agent.phase === "plan") return "plan";
  if (agent.phase === "eval") return "eval";
  if (agent.phase === "spec") return "sketch";
  return "execute";
}

/**
 * Task id for deep-linking to Execute. Merger uses a per-run `id`; use `taskId` when present and never treat the merger run id as a task.
 */
export function getExecuteTaskIdForNavigation(agent: ActiveAgent): string | undefined {
  if (agent.taskId && agent.taskId.trim() !== "") return agent.taskId.trim();
  if (agent.role === "merger") return undefined;
  return agent.id;
}

export function getAgentIconSrc(agent: ActiveAgent): string {
  const role = agent.role;
  if (role && role in AGENT_ROLE_LABELS) {
    const iconName = role.replace(/_/g, "-");
    return `${ASSET_BASE}agent-icons/${iconName}.svg`;
  }
  if (agent.phase === "review") return `${ASSET_BASE}agent-icons/reviewer.svg`;
  return `${ASSET_BASE}agent-icons/coder.svg`;
}

export function isPlanningAgent(agent: ActiveAgent): boolean {
  return (
    agent.phase === "plan" ||
    (!!agent.role &&
      getSlotForRole(agent.role as Parameters<typeof getSlotForRole>[0]) === "planning")
  );
}
