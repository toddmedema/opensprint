import type { ActiveAgent } from "@opensprint/shared";
import { AGENT_ROLE_LABELS, getSlotForRole } from "@opensprint/shared";
import { ASSET_BASE } from "./constants";

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
