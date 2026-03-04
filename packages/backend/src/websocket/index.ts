import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import type {
  ServerEvent,
  ClientEvent,
  AgentOutputBackfillEvent,
  PlanAgentOutputBackfillEvent,
} from "@opensprint/shared";
import { eventRelay } from "../services/event-relay.service.js";
import { getPlanAgentOutput } from "../services/plan-agent-output-buffer.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("websocket");

/** Map of projectId → Set of connected clients */
const projectClients = new Map<string, Set<WebSocket>>();

/** Map of WebSocket → subscribed task IDs */
const agentSubscriptions = new Map<WebSocket, Set<string>>();

/** Map of WebSocket → subscribed plan IDs (for Auditor output) */
const planAgentSubscriptions = new Map<WebSocket, Set<string>>();

/** Map of WebSocket → projectId (only set when client connected to /ws/projects/:id) */
const wsToProjectId = new Map<WebSocket, string>();

let getLiveOutput: ((projectId: string, taskId: string) => Promise<string>) | null = null;

let wss: WebSocketServer;
let clientHasConnected = false;

/** Whether any WebSocket client has connected since this server booted. */
export function hasClientConnected(): boolean {
  return clientHasConnected;
}

export interface WebSocketOptions {
  getLiveOutput?: (projectId: string, taskId: string) => Promise<string>;
}

export function setupWebSocket(server: Server, options?: WebSocketOptions): void {
  getLiveOutput = options?.getLiveOutput ?? null;
  eventRelay.init(projectClients, agentSubscriptions, planAgentSubscriptions);

  // No path filter — we accept /ws and /ws/projects/:id; path matching is done in the handler
  wss = new WebSocketServer({ server });

  wss.on("connection", (ws, req) => {
    // Extract projectId from URL: /ws/projects/:id (PRD §11.2)
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);
    const path = url.pathname;
    const match = path.match(/^\/ws\/projects\/([^/]+)$/);
    const projectId = match?.[1];

    // Reject connections that don't match expected paths
    if (path !== "/ws" && !match) {
      ws.close(1008, "Invalid path: use /ws or /ws/projects/:id");
      return;
    }

    clientHasConnected = true;

    if (!projectId) {
      log.info("Client connected (no project scope)");
    } else {
      log.info("Client connected to project", { projectId });
      wsToProjectId.set(ws, projectId);
      if (!projectClients.has(projectId)) {
        projectClients.set(projectId, new Set());
      }
      projectClients.get(projectId)!.add(ws);
    }

    agentSubscriptions.set(ws, new Set());
    planAgentSubscriptions.set(ws, new Set());

    ws.on("message", (data) => {
      try {
        const event = JSON.parse(data.toString()) as ClientEvent;
        handleClientEvent(ws, event);
      } catch (err) {
        log.error("Invalid message", { err });
      }
    });

    ws.on("close", () => {
      wsToProjectId.delete(ws);
      agentSubscriptions.delete(ws);
      planAgentSubscriptions.delete(ws);

      // Clean up project client tracking
      if (projectId) {
        projectClients.get(projectId)?.delete(ws);
        if (projectClients.get(projectId)?.size === 0) {
          projectClients.delete(projectId);
        }
      }
      log.info("Client disconnected");
    });
  });
}

function handleClientEvent(ws: WebSocket, event: ClientEvent): void {
  if (!event || typeof event !== "object" || !event.type) {
    log.warn("Ignoring malformed client event");
    return;
  }
  switch (event.type) {
    case "agent.subscribe": {
      if ("taskId" in event && event.taskId) {
        const taskId = event.taskId;
        agentSubscriptions.get(ws)?.add(taskId);
        log.info("Client subscribed to agent output", { taskId });
        // Push existing live output to this client only (backfill)
        const projectId = wsToProjectId.get(ws);
        if (projectId && getLiveOutput && ws.readyState === 1 /* WebSocket.OPEN */) {
          getLiveOutput(projectId, taskId)
            .then((output) => {
              if (output.length > 0 && ws.readyState === 1) {
                const backfill: AgentOutputBackfillEvent = {
                  type: "agent.outputBackfill",
                  taskId,
                  output,
                };
                ws.send(JSON.stringify(backfill));
              }
            })
            .catch((err) => log.warn("getLiveOutput failed on subscribe", { taskId, err }));
        }
      }
      break;
    }
    case "agent.unsubscribe": {
      if ("taskId" in event && event.taskId) {
        agentSubscriptions.get(ws)?.delete(event.taskId);
        log.info("Client unsubscribed from agent output", { taskId: event.taskId });
      }
      break;
    }
    case "plan.agent.subscribe": {
      if ("planId" in event && event.planId) {
        const planId = event.planId;
        planAgentSubscriptions.get(ws)?.add(planId);
        log.info("Client subscribed to plan agent output", { planId });
        const projectId = wsToProjectId.get(ws);
        if (projectId && ws.readyState === 1 /* WebSocket.OPEN */) {
          const output = getPlanAgentOutput(projectId, planId);
          if (output.length > 0) {
            const backfill: PlanAgentOutputBackfillEvent = {
              type: "plan.agent.outputBackfill",
              planId,
              output,
            };
            ws.send(JSON.stringify(backfill));
          }
        }
      }
      break;
    }
    case "plan.agent.unsubscribe": {
      if ("planId" in event && event.planId) {
        planAgentSubscriptions.get(ws)?.delete(event.planId);
        log.info("Client unsubscribed from plan agent output", { planId: event.planId });
      }
      break;
    }
    default:
      log.warn("Unknown client event type", { type: (event as { type?: string }).type });
  }
}

/** Broadcast an event to all clients connected to a project */
export function broadcastToProject(projectId: string, event: ServerEvent): void {
  eventRelay.broadcast(projectId, event);
}

/** Close all WebSocket connections and the server (for graceful shutdown) */
export function closeWebSocket(): void {
  if (!wss) return;
  for (const ws of agentSubscriptions.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  }
  projectClients.clear();
  agentSubscriptions.clear();
  planAgentSubscriptions.clear();
  wss.close();
}

/** Send agent output to clients in a project who have subscribed to the task via agent.subscribe */
export function sendAgentOutputToProject(projectId: string, taskId: string, chunk: string): void {
  eventRelay.sendAgentOutputToProject(projectId, taskId, chunk);
}

/** Send plan agent output (Auditor) to clients subscribed via plan.agent.subscribe */
export function sendPlanAgentOutputToProject(
  projectId: string,
  planId: string,
  chunk: string
): void {
  eventRelay.sendPlanAgentOutputToProject(projectId, planId, chunk);
}
