import { randomUUID } from "node:crypto";
import type { ActiveAgent, AgentRole } from "@opensprint/shared";
import { getAgentNameForRole } from "@opensprint/shared";
import type { PendingMessageQueue } from "./agentic-loop.js";

/** Per-task channel reference for live chat message injection. */
export interface AgentChannelEntry {
  pendingMessages: PendingMessageQueue;
  backendType: string;
  projectId?: string;
  attempt: number;
  attemptId: string;
}

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
  /** Feedback ID when Analyst is categorizing a specific feedback item; use for deep link to Evaluate page */
  feedbackId?: string;
  /** Task ID for Execute deep links when `id` is a per-run token (e.g. merger). */
  taskId?: string;
  attemptId?: string;
}

/**
 * Central registry for in-flight agent invocations.
 * Used by all phases (Sketch, Plan, Execute, Evaluate, Deliver) to track active agents.
 */
export class ActiveAgentsService {
  private agents = new Map<string, ActiveAgentEntry>();
  /** Per-role monotonic index for assigning stable names (never decremented when agents unregister). */
  private nextIndexByRole = new Map<string, number>();
  /** Per-task pending-messages channel for live chat injection. */
  private channels = new Map<string, AgentChannelEntry>();

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
   * @param feedbackId - Optional feedback ID when Analyst is categorizing a specific feedback item
   * @param taskId - Optional task ID for Execute navigation when `id` is not the task (e.g. merger run id)
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
    name?: string,
    feedbackId?: string,
    taskId?: string,
    attemptId?: string
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
      feedbackId,
      taskId,
      attemptId,
    });
  }

  /**
   * Unregister an active agent by id.
   * Also removes any associated pending-messages channel.
   * Safe to call if the agent was never registered.
   */
  unregister(id: string, expectedAttemptId?: string): void {
    if (expectedAttemptId) {
      const current = this.agents.get(id)?.attemptId ?? this.channels.get(id)?.attemptId;
      if (current !== expectedAttemptId) return;
    }
    this.agents.delete(id);
    this.unregisterChannel(id);
  }

  /**
   * Register a pending-messages channel for a task so other services
   * (e.g. AgentChatService) can push live user messages into the agentic loop.
   */
  registerChannel(
    id: string,
    pendingMessages: PendingMessageQueue,
    backendType: string,
    context?: { projectId?: string; attempt?: number; attemptId?: string }
  ): void {
    this.unregisterChannel(id);
    this.channels.set(id, {
      pendingMessages,
      backendType,
      projectId: context?.projectId ?? this.agents.get(id)?.projectId,
      attempt: context?.attempt ?? 1,
      attemptId: context?.attemptId ?? randomUUID(),
    });
  }

  unregisterChannel(id: string): void {
    const channel = this.channels.get(id);
    if (!channel) return;
    try {
      channel.pendingMessages.close();
    } finally {
      this.channels.delete(id);
    }
  }

  /**
   * Get the channel entry for a task, if one is registered.
   */
  getChannel(id: string): AgentChannelEntry | undefined {
    return this.channels.get(id);
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
      ...(e.feedbackId != null && { feedbackId: e.feedbackId }),
      ...(e.taskId != null && e.taskId.trim() !== "" && { taskId: e.taskId.trim() }),
    }));
  }
}

export const activeAgentsService = new ActiveAgentsService();
