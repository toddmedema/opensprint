import { sendSocketData } from "./send.js";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "http";
import type {
  ServerEvent,
  ClientEvent,
  AgentOutputBackfillEvent,
  PlanAgentOutputBackfillEvent,
  AgentChatReceivedEvent,
  AgentChatResponseEvent,
  AgentChatUnsupportedEvent,
  ProjectIdentity,
} from "@opensprint/shared";
import { identityService, localIdentity } from "../services/identity.service.js";
import { CollaborationService } from "../services/collaboration.service.js";
import { runWithRequestContext } from "../services/request-context.js";
import { eventRelay } from "../services/event-relay.service.js";
import { getPlanAgentOutput } from "../services/plan-agent-output-buffer.service.js";
import { createLogger } from "../utils/logger.js";
import {
  AgentChatService,
  agentChatService as defaultAgentChatService,
  type SendMessageResult,
} from "../services/agent-chat.service.js";
import { requestHasValidBearerToken } from "../services/local-session-auth.service.js";
import {
  consumeWebSocketUpgradeTicket,
  consumeScopedWebSocketTicket,
} from "../services/websocket-upgrade-ticket.service.js";
const upgradePrincipals = new WeakMap<IncomingMessage, ProjectIdentity>();
const socketPrincipals = new WeakMap<WebSocket, ProjectIdentity>();

const log = createLogger("websocket");

/**
 * WebSocket upgrade auth: `Authorization: Bearer <session>` (Node `ws` clients) or a one-time
 * `ticket` query param from `POST /api/v1/ws-upgrade-ticket` (browser). Session tokens MUST NOT
 * appear in query strings — they are often logged by proxies.
 */
function webSocketUpgradeAuthenticated(req: IncomingMessage, url: URL): boolean {
  if (requestHasValidBearerToken(req.headers.authorization)) return true;
  const ticket = url.searchParams.get("ticket");
  if (ticket != null && ticket.length > 0) {
    return consumeWebSocketUpgradeTicket(ticket);
  }
  return false;
}

async function authenticateWebSocketUpgrade(info: { req: IncomingMessage }): Promise<boolean> {
  const req = info.req;
  let url: URL;
  try {
    url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
  } catch {
    return false;
  }
  const pathname = url.pathname;
  const match = pathname.match(/^\/ws\/projects\/([^/]+)$/);
  if (pathname !== "/ws" && !match) {
    return false;
  }
  if (webSocketUpgradeAuthenticated(req, url)) {
    upgradePrincipals.set(req, localIdentity());
    return true;
  }
  if (!match) return false;
  try {
    const projectId = decodeURIComponent(match[1]!);
    const ticket = url.searchParams.get("ticket");
    const claims = ticket ? await consumeScopedWebSocketTicket(ticket) : null;
    if (ticket && (!claims || claims.projectId !== projectId)) return false;
    const principal = claims
      ? await identityService.resolveHash(claims.credentialHash, projectId)
      : await identityService.resolve(req.headers.authorization, projectId);
    identityService.require(principal, "read");
    upgradePrincipals.set(req, principal);
    return true;
  } catch {
    return false;
  }
}

/** Map of projectId → Set of connected clients */
const projectClients = new Map<string, Set<WebSocket>>();

/** Map of WebSocket → subscribed task IDs */
const agentSubscriptions = new Map<WebSocket, Set<string>>();

/** Map of WebSocket → subscribed plan IDs (for Auditor output) */
const planAgentSubscriptions = new Map<WebSocket, Set<string>>();

/** Map of WebSocket → projectId (only set when client connected to /ws/projects/:id) */
const wsToProjectId = new Map<WebSocket, string>();

let getLiveOutput: ((projectId: string, taskId: string) => Promise<string>) | null = null;
let chatService: AgentChatService = defaultAgentChatService;
let executeAgentGuidance: WebSocketOptions["executeAgentGuidance"];

let wss: WebSocketServer;
let clientHasConnected = false;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_PENDING_GUIDANCE_EVENTS = 32;
const wsAlive = new WeakMap<WebSocket, boolean>();

/** Whether any WebSocket client has connected since this server booted. */
export function hasClientConnected(): boolean {
  return clientHasConnected;
}

export interface WebSocketOptions {
  getLiveOutput?: (projectId: string, taskId: string) => Promise<string>;
  agentChatService?: AgentChatService;
  executeAgentGuidance?: (
    projectId: string,
    taskId: string,
    attemptId: string,
    send: () => Promise<SendMessageResult>
  ) => Promise<SendMessageResult>;
}

export function setupWebSocket(server: Server, options?: WebSocketOptions): void {
  getLiveOutput = options?.getLiveOutput ?? null;
  chatService = options?.agentChatService ?? defaultAgentChatService;
  executeAgentGuidance = options?.executeAgentGuidance;
  chatService.setStatusListener((message) => {
    if (
      !message.projectId ||
      !message.taskId ||
      !message.clientMessageId ||
      (message.status !== "included" && message.status !== "run-ended")
    )
      return;
    broadcastToProject(message.projectId, {
      type: "agent.chat.received",
      taskId: message.taskId,
      messageId: message.id,
      timestamp: message.timestamp,
      clientMessageId: message.clientMessageId,
      attemptId: message.attemptId,
      status: message.status,
      error: message.error,
    });
  });
  eventRelay.init(projectClients, agentSubscriptions, planAgentSubscriptions);
  eventRelay.setAuthorizationCheck((ws) =>
    socketPrincipals.get(ws)?.local !== false
      ? true
      : reauthorizeSocket(ws)
          .then(() => true)
          .catch(() => false)
  );

  wss = new WebSocketServer({
    server,
    maxPayload: 64 * 1024,
    verifyClient: (info, done) => {
      void authenticateWebSocketUpgrade(info)
        .then((ok) => done(ok, ok ? undefined : 401))
        .catch(() => done(false, 401));
    },
  });

  wss.on("connection", (ws, req) => {
    socketPrincipals.set(ws, upgradePrincipals.get(req) ?? localIdentity());
    // Extract projectId from URL: /ws/projects/:id (PRD §11.2)
    const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const match = path.match(/^\/ws\/projects\/([^/]+)$/);
    const projectId = match?.[1];

    clientHasConnected = true;
    wsAlive.set(ws, true);

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

    ws.on("pong", () => {
      wsAlive.set(ws, true);
      void reauthorizeSocket(ws).catch(() => ws.close(1008, "Project access revoked"));
    });

    // Keep receive order before asynchronous authorization and durable acceptance.
    // The bound includes the active request, so a blocked store cannot grow an unbounded queue.
    let guidanceTail = Promise.resolve();
    let pendingGuidance = 0;
    ws.on("message", (data) => {
      try {
        const parsed: unknown = JSON.parse(data.toString());
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof (parsed as Record<string, unknown>).type === "string"
        ) {
          const event = parsed as ClientEvent;
          if (event.type === "agent.chat.send") {
            if (pendingGuidance >= MAX_PENDING_GUIDANCE_EVENTS) {
              sendSocketData(
                ws,
                JSON.stringify({
                  type: "agent.chat.unsupported",
                  taskId: event.taskId,
                  clientMessageId: event.clientMessageId,
                  reason:
                    "Too many pending guidance requests — wait for acceptance before sending more.",
                })
              );
              return;
            }
            pendingGuidance++;
            guidanceTail = guidanceTail
              .then(async () => {
                if (ws.readyState === WebSocket.OPEN) await handleClientEvent(ws, event);
              })
              .catch((err) => {
                log.error("WebSocket event failed", { err });
              })
              .finally(() => {
                pendingGuidance--;
              });
          } else {
            void handleClientEvent(ws, event).catch((err) => {
              log.error("WebSocket event failed", { err });
            });
          }
        } else {
          log.warn("Ignoring non-object or type-less WebSocket message");
        }
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

  heartbeatInterval = setInterval(() => {
    for (const ws of agentSubscriptions.keys()) {
      if (wsAlive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      wsAlive.set(ws, false);
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
}

async function reauthorizeSocket(ws: WebSocket): Promise<ProjectIdentity> {
  const principal = socketPrincipals.get(ws) ?? localIdentity();
  if (principal.local) return principal;
  const current = await identityService.resolveHash(
    principal.credentialHash!,
    wsToProjectId.get(ws)
  );
  identityService.require(current, "read");
  socketPrincipals.set(ws, current);
  return current;
}
async function handleClientEvent(ws: WebSocket, event: ClientEvent): Promise<void> {
  const principal = await reauthorizeSocket(ws);
  if (!event || typeof event !== "object" || !event.type) {
    log.warn("Ignoring malformed client event");
    return;
  }
  switch (event.type) {
    case "agent.subscribe": {
      if ("taskId" in event && event.taskId) {
        const taskId = event.taskId;
        log.info("Client subscribed to agent output", { taskId });
        const projectId = wsToProjectId.get(ws);
        if (projectId && getLiveOutput && ws.readyState === 1 /* WebSocket.OPEN */) {
          // Send backfill BEFORE registering the subscription so that no
          // live agent.output events are delivered to this client until the
          // backfill (which already contains all prior output) has been sent.
          // This eliminates the window where the same tail text appears in
          // both the backfill and a live chunk, preventing duplicate output.
          getLiveOutput(projectId, taskId)
            .then(async (output) => {
              await reauthorizeSocket(ws);
              if (ws.readyState === 1) {
                if (output.length > 0) {
                  const backfill: AgentOutputBackfillEvent = {
                    type: "agent.outputBackfill",
                    taskId,
                    output,
                  };
                  try {
                    sendSocketData(ws, JSON.stringify(backfill));
                  } catch (sendErr) {
                    log.debug("backfill send failed", {
                      taskId,
                      err: sendErr instanceof Error ? sendErr.message : String(sendErr),
                    });
                  }
                }
                agentSubscriptions.get(ws)?.add(taskId);
              }
            })
            .catch(async (err) => {
              log.warn("getLiveOutput failed on subscribe", { taskId, err });
              try {
                await reauthorizeSocket(ws);
              } catch {
                ws.close(1008, "Project access revoked");
                return;
              }
              agentSubscriptions.get(ws)?.add(taskId);
            });
        } else {
          agentSubscriptions.get(ws)?.add(taskId);
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
            try {
              sendSocketData(ws, JSON.stringify(backfill));
            } catch (sendErr) {
              log.debug("plan backfill send failed", {
                planId,
                err: sendErr instanceof Error ? sendErr.message : String(sendErr),
              });
            }
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
    case "agent.chat.send": {
      if (!("taskId" in event) || !event.taskId || !("message" in event) || !event.message) {
        log.warn("agent.chat.send missing taskId or message");
        break;
      }
      const projectId = wsToProjectId.get(ws);
      if (!projectId) {
        log.warn("agent.chat.send from client without project scope");
        break;
      }
      const { taskId, message, clientMessageId } = event;
      if (
        typeof message !== "string" ||
        !message.trim() ||
        message.length > 32_000 ||
        typeof clientMessageId !== "string" ||
        !clientMessageId ||
        clientMessageId.length > 200
      ) {
        sendSocketData(
          ws,
          JSON.stringify({
            type: "agent.chat.unsupported",
            taskId,
            clientMessageId,
            reason: "A message and clientMessageId are required (maximum 32000 characters).",
          })
        );
        break;
      }

      const support = chatService.supportsChat(taskId, projectId);
      if (!support.supported) {
        const unsupported: AgentChatUnsupportedEvent = {
          type: "agent.chat.unsupported",
          taskId,
          reason: support.reason ?? "Chat not supported",
          clientMessageId,
        };
        sendSocketData(ws, JSON.stringify(unsupported));
        break;
      }

      let result;
      try {
        const attemptId = chatService.getAttemptId(taskId);
        if (!attemptId) throw new Error("Agent run ended");
        const send = () => {
          // The control callback may yield while a run ends or is replaced.
          if (chatService.getAttemptId(taskId) !== attemptId)
            throw new Error("Agent run changed; retry guidance");
          return chatService.sendMessage(projectId, taskId, message, undefined, {
            clientMessageId,
            actorId: principal.actorId,
          });
        };
        identityService.require(principal, "control");
        result = await runWithRequestContext(
          { principal, projectId, requestId: clientMessageId },
          () =>
            principal.local && executeAgentGuidance
              ? executeAgentGuidance(projectId, taskId, attemptId, send)
              : new CollaborationService().withControl(projectId, principal, attemptId, async () =>
                  send()
                )
        );
      } catch (error) {
        log.error("Could not persist agent guidance", { taskId, error });
        sendSocketData(
          ws,
          JSON.stringify({
            type: "agent.chat.unsupported",
            taskId,
            clientMessageId,
            reason: "Guidance was not accepted. Check run control and retry.",
          })
        );
        break;
      }
      if (result.delivered) {
        const received: AgentChatReceivedEvent = {
          type: "agent.chat.received",
          taskId,
          messageId: result.messageId,
          timestamp: result.timestamp,
          clientMessageId,
          attemptId: result.attemptId,
          status: result.status,
        };
        sendSocketData(ws, JSON.stringify(received));
      } else {
        const unsupported: AgentChatUnsupportedEvent = {
          type: "agent.chat.unsupported",
          taskId,
          reason: result.error ?? "Failed to deliver message",
          clientMessageId,
        };
        sendSocketData(ws, JSON.stringify(unsupported));
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
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
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

/** Broadcast an agent chat response to all project clients */
export function sendAgentChatResponse(
  projectId: string,
  taskId: string,
  messageId: string,
  content: string
): void {
  const event: AgentChatResponseEvent = {
    type: "agent.chat.response",
    taskId,
    messageId,
    content,
  };
  broadcastToProject(projectId, event);
}
