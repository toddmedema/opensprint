import type { ActiveAgent, AgentRole } from "@opensprint/shared";
import { getAgentNameForRole } from "@opensprint/shared";

/** Internal entry stored in the registry (includes projectId for filtering) */
export interface ActiveAgentEntry {
  id: string;
  projectId: string;
  phase: string;
  role: AgentRole;
  label: string;
  startedAt: string;
  /** Branch name (Execute phase only) */
  branchName?: string;
  /** Plan ID when agent is working in plan context (e.g. task generation for a plan); omitted from response when absent */
  planId?: string;
  /** Optional agent instance name (e.g. "Frodo"); shown in dropdown as "Coder (Frodo)" when present */
  name?: string;
}

/**
 * Central registry for in-flight agent invocations.
 * Used by all phases (Sketch, Plan, Execute, Evaluate, Deliver) to track active agents.
 */
export class ActiveAgentsService {
  private agents = new Map<string, ActiveAgentEntry>();
  /** Per-role monotonic index for assigning stable names (never decremented when agents unregister). */
  private nextIndexByRole = new Map<string, number>();

  /**
   * Register an active agent.
   * @param id - Unique agent/task identifier
   * @param projectId - Project the agent is running for
   * @param phase - Phase (e.g. "sketch", "plan", "execute", "evaluate", "deliver" or "coding", "review")
   * @param role - Named agent role (e.g. coder, reviewer)
   * @param label - Human-readable label (e.g. task title)
   * @param startedAt - ISO timestamp when the agent started
   * @param branchName - Optional branch name (Execute phase)
   * @param planId - Optional plan ID when agent is working in plan context (e.g. Planner for a specific plan)
   * @param name - Optional agent instance name (e.g. "Frodo"); shown in dropdown as "Coder (Frodo)" when present
   */
  register(
    id: string,
    projectId: string,
    phase: string,
    role: AgentRole,
    label: string,
    startedAt: string,
    branchName?: string,
    planId?: string,
    name?: string
  ): void {
    const index = this.nextIndexByRole.get(role) ?? 0;
    this.nextIndexByRole.set(role, index + 1);
    const assignedName = name?.trim() ?? getAgentNameForRole(role, index);
    this.agents.set(id, {
      id,
      projectId,
      phase,
      role,
      label,
      startedAt,
      branchName,
      planId,
      name: assignedName,
    });
  }

  /**
   * Unregister an active agent by id.
   * Safe to call if the agent was never registered.
   */
  unregister(id: string): void {
    this.agents.delete(id);
  }

  /**
   * List active agent entries with projectId (for internal use, e.g. help context).
   * @param projectId - If provided, returns only agents for that project
   */
  listEntries(projectId?: string): ActiveAgentEntry[] {
    const entries = projectId
      ? [...this.agents.values()].filter((e) => e.projectId === projectId)
      : [...this.agents.values()];
    return entries;
  }

  /**
   * List active agents, optionally filtered by projectId.
   * @param projectId - If provided, returns only agents for that project
   * @returns Array of ActiveAgent (projectId omitted from response for project-scoped API)
   */
  list(projectId?: string): ActiveAgent[] {
    return this.listEntries(projectId).map((e) => ({
      id: e.id,
      phase: e.phase,
      role: e.role,
      label: e.label,
      startedAt: e.startedAt,
      ...(e.branchName != null && { branchName: e.branchName }),
      ...(e.planId != null && { planId: e.planId }),
      ...(e.name != null && e.name.trim() !== "" && { name: e.name.trim() }),
    }));
  }
}

export const activeAgentsService = new ActiveAgentsService();
