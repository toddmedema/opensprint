import { describe, it, expect } from "vitest";
import type {
  ServerEvent,
  ClientEvent,
  WebSocketEventType,
  AgentChatSendEvent,
  AgentChatReceivedEvent,
  AgentChatResponseEvent,
  AgentChatUnsupportedEvent,
  IntegrationSyncStartedEvent,
  IntegrationSyncCompletedEvent,
  IntegrationSyncErrorEvent,
  IntegrationConnectionUpdatedEvent,
} from "../types/websocket.js";

describe("WebSocket agent chat event types", () => {
  it("narrows client send event by type", () => {
    const ev: AgentChatSendEvent = {
      type: "agent.chat.send",
      taskId: "os-abc",
      message: "hello",
      clientMessageId: "client-1",
    };
    expect(ev.type).toBe("agent.chat.send");
  });

  it("includes chat events in ServerEvent and ClientEvent unions", () => {
    const received: AgentChatReceivedEvent = {
      type: "agent.chat.received",
      taskId: "os-abc",
      messageId: "m1",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    const response: AgentChatResponseEvent = {
      type: "agent.chat.response",
      taskId: "os-abc",
      messageId: "m1",
      content: "hi",
    };
    const unsupported: AgentChatUnsupportedEvent = {
      type: "agent.chat.unsupported",
      taskId: "os-abc",
      reason: "CLI backend",
    };
    const serverUnion: ServerEvent = received;
    expect(serverUnion.type).toBe("agent.chat.received");
    const clientUnion: ClientEvent = {
      type: "agent.chat.send",
      taskId: "t",
      message: "x",
    };
    expect(clientUnion.type).toBe("agent.chat.send");

    const allTypes = new Set<WebSocketEventType>([
      received.type,
      response.type,
      unsupported.type,
      clientUnion.type,
    ]);
    expect(allTypes.size).toBe(4);
  });
});

describe("WebSocket integration sync event types", () => {
  it("includes integration events in ServerEvent union", () => {
    const started: IntegrationSyncStartedEvent = {
      type: "integration.sync.started",
      provider: "todoist",
      projectId: "proj-1",
    };
    const completed: IntegrationSyncCompletedEvent = {
      type: "integration.sync.completed",
      provider: "todoist",
      projectId: "proj-1",
      imported: 5,
      errors: 0,
    };
    const error: IntegrationSyncErrorEvent = {
      type: "integration.sync.error",
      provider: "todoist",
      projectId: "proj-1",
      error: "Token expired",
      status: "needs_reconnect",
    };
    const connUpdated: IntegrationConnectionUpdatedEvent = {
      type: "integration.connection.updated",
      provider: "todoist",
      projectId: "proj-1",
      status: "needs_reconnect",
    };

    const events: ServerEvent[] = [started, completed, error, connUpdated];
    const types = new Set<WebSocketEventType>(events.map((e) => e.type));

    expect(types.size).toBe(4);
    expect(types.has("integration.sync.started")).toBe(true);
    expect(types.has("integration.sync.completed")).toBe(true);
    expect(types.has("integration.sync.error")).toBe(true);
    expect(types.has("integration.connection.updated")).toBe(true);
  });

  it("allows optional status field in sync error event", () => {
    const errorNoStatus: IntegrationSyncErrorEvent = {
      type: "integration.sync.error",
      provider: "todoist",
      projectId: "proj-1",
      error: "Connection reset",
    };
    expect(errorNoStatus.status).toBeUndefined();
  });
});
