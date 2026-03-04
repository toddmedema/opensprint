import type { WebSocket } from "ws";
import type { ServerEvent } from "@opensprint/shared";

/** Map of projectId → Set of connected clients */
type ProjectClientsMap = Map<string, Set<WebSocket>>;
/** Map of WebSocket → subscribed task IDs */
type AgentSubscriptionsMap = Map<WebSocket, Set<string>>;
/** Map of WebSocket → subscribed plan IDs (for Auditor output) */
type PlanAgentSubscriptionsMap = Map<WebSocket, Set<string>>;

/**
 * EventRelay service: relays server events to WebSocket clients.
 * Supports project-scoped broadcast, task-scoped agent output streaming,
 * and plan-scoped agent output streaming (Auditor).
 * Initialized by the WebSocket module with connection state.
 */
class EventRelayService {
  private projectClients: ProjectClientsMap | null = null;
  private agentSubscriptions: AgentSubscriptionsMap | null = null;
  private planAgentSubscriptions: PlanAgentSubscriptionsMap | null = null;

  /**
   * Initialize the relay with connection state. Called by the WebSocket module
   * during setup.
   */
  init(
    projectClients: ProjectClientsMap,
    agentSubscriptions: AgentSubscriptionsMap,
    planAgentSubscriptions: PlanAgentSubscriptionsMap
  ): void {
    this.projectClients = projectClients;
    this.agentSubscriptions = agentSubscriptions;
    this.planAgentSubscriptions = planAgentSubscriptions;
  }

  /**
   * Broadcast an event to all clients connected to a project.
   */
  broadcast(projectId: string, event: ServerEvent): void {
    const clients = this.projectClients?.get(projectId);
    if (!clients) return;

    const data = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState === 1 /* WebSocket.OPEN */) {
        client.send(data);
      }
    }
  }

  /**
   * Send agent output to clients subscribed to a specific task.
   */
  sendAgentOutput(taskId: string, chunk: string): void {
    const event: ServerEvent = { type: "agent.output", taskId, chunk };
    const data = JSON.stringify(event);

    if (!this.agentSubscriptions) return;

    for (const [ws, subscriptions] of this.agentSubscriptions) {
      if (subscriptions.has(taskId) && ws.readyState === 1 /* WebSocket.OPEN */) {
        ws.send(data);
      }
    }
  }

  /**
   * Send agent output to clients in a project who have subscribed to the task via agent.subscribe.
   */
  sendAgentOutputToProject(projectId: string, taskId: string, chunk: string): void {
    const clients = this.projectClients?.get(projectId);
    if (!clients) return;

    const event: ServerEvent = { type: "agent.output", taskId, chunk };
    const data = JSON.stringify(event);

    for (const ws of clients) {
      if (
        this.agentSubscriptions?.get(ws)?.has(taskId) &&
        ws.readyState === 1 /* WebSocket.OPEN */
      ) {
        ws.send(data);
      }
    }
  }

  /**
   * Send plan agent output (e.g. Auditor) to clients subscribed via plan.agent.subscribe.
   */
  sendPlanAgentOutputToProject(projectId: string, planId: string, chunk: string): void {
    const clients = this.projectClients?.get(projectId);
    if (!clients) return;

    const event: ServerEvent = { type: "plan.agent.output", planId, chunk };
    const data = JSON.stringify(event);

    for (const ws of clients) {
      if (
        this.planAgentSubscriptions?.get(ws)?.has(planId) &&
        ws.readyState === 1 /* WebSocket.OPEN */
      ) {
        ws.send(data);
      }
    }
  }
}

export const eventRelay = new EventRelayService();
