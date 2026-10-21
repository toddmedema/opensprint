import type { WebSocket } from "ws";
import type { ServerEvent } from "@opensprint/shared";
import { createLogger } from "../utils/logger.js";
import { sendSocketData } from "../websocket/send.js";

const log = createLogger("event-relay");

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

  private safeSend(client: WebSocket, data: string): boolean {
    try {
      if (client.readyState === 1 /* WebSocket.OPEN */) {
        return sendSocketData(client, data);
      }
    } catch (err) {
      log.debug("ws send failed, removing dead client", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    return false;
  }

  /**
   * Broadcast an event to all clients connected to a project.
   */
  broadcast(projectId: string, event: ServerEvent): void {
    const clients = this.projectClients?.get(projectId);
    if (!clients) return;

    const data = JSON.stringify(event);
    const dead: WebSocket[] = [];
    for (const client of clients) {
      if (!this.safeSend(client, data)) {
        dead.push(client);
      }
    }
    for (const ws of dead) clients.delete(ws);
  }

  /**
   * Send agent output to clients subscribed to a specific task.
   */
  sendAgentOutput(taskId: string, chunk: string): void {
    const event: ServerEvent = { type: "agent.output", taskId, chunk };
    const data = JSON.stringify(event);

    if (!this.agentSubscriptions) return;

    for (const [ws, subscriptions] of this.agentSubscriptions) {
      if (subscriptions.has(taskId)) {
        this.safeSend(ws, data);
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

    const dead: WebSocket[] = [];
    for (const ws of clients) {
      if (this.agentSubscriptions?.get(ws)?.has(taskId)) {
        if (!this.safeSend(ws, data)) {
          dead.push(ws);
        }
      }
    }
    for (const ws of dead) clients.delete(ws);
  }

  /**
   * Send plan agent output (e.g. Auditor) to clients subscribed via plan.agent.subscribe.
   */
  sendPlanAgentOutputToProject(projectId: string, planId: string, chunk: string): void {
    const clients = this.projectClients?.get(projectId);
    if (!clients) return;

    const event: ServerEvent = { type: "plan.agent.output", planId, chunk };
    const data = JSON.stringify(event);

    const dead: WebSocket[] = [];
    for (const ws of clients) {
      if (this.planAgentSubscriptions?.get(ws)?.has(planId)) {
        if (!this.safeSend(ws, data)) {
          dead.push(ws);
        }
      }
    }
    for (const ws of dead) clients.delete(ws);
  }
}

export const eventRelay = new EventRelayService();
