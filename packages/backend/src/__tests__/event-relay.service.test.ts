import { describe, it, expect, beforeEach, vi } from "vitest";
import { eventRelay } from "../services/event-relay.service.js";

describe("EventRelayService", () => {
  const projectClients = new Map<string, Set<unknown>>();
  const agentSubscriptions = new Map<unknown, Set<string>>();
  const planAgentSubscriptions = new Map<unknown, Set<string>>();

  beforeEach(() => {
    projectClients.clear();
    agentSubscriptions.clear();
    planAgentSubscriptions.clear();
    eventRelay.init(
      projectClients as Parameters<typeof eventRelay.init>[0],
      agentSubscriptions as Parameters<typeof eventRelay.init>[1],
      planAgentSubscriptions as Parameters<typeof eventRelay.init>[2]
    );
  });

  describe("broadcast", () => {
    it("sends event to all clients in project", () => {
      const mockClient1 = { readyState: 1, send: vi.fn() };
      const mockClient2 = { readyState: 1, send: vi.fn() };
      projectClients.set("proj-1", new Set([mockClient1, mockClient2]));

      eventRelay.broadcast("proj-1", {
        type: "task.updated",
        taskId: "t1",
        status: "in_progress",
        assignee: "Frodo",
      });

      expect(mockClient1.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: "task.updated",
          taskId: "t1",
          status: "in_progress",
          assignee: "Frodo",
        })
      );
      expect(mockClient2.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: "task.updated",
          taskId: "t1",
          status: "in_progress",
          assignee: "Frodo",
        })
      );
    });

    it("does nothing when project has no clients", () => {
      expect(() => {
        eventRelay.broadcast("nonexistent", {
          type: "execute.status",
          activeTasks: [],
          queueDepth: 0,
        });
      }).not.toThrow();
    });

    it("skips clients that are not OPEN", () => {
      const mockOpen = { readyState: 1, send: vi.fn() };
      const mockClosed = { readyState: 3, send: vi.fn() };
      projectClients.set("proj-1", new Set([mockOpen, mockClosed]));

      eventRelay.broadcast("proj-1", {
        type: "prd.updated",
        section: "executive_summary",
        version: 2,
      });

      expect(mockOpen.send).toHaveBeenCalled();
      expect(mockClosed.send).not.toHaveBeenCalled();
    });
  });

  describe("sendAgentOutput", () => {
    it("sends agent.output to subscribed clients only", () => {
      const mockSubscribed = { readyState: 1, send: vi.fn() };
      const mockUnsubscribed = { readyState: 1, send: vi.fn() };
      agentSubscriptions.set(mockSubscribed, new Set(["task-1"]));
      agentSubscriptions.set(mockUnsubscribed, new Set(["task-2"]));

      eventRelay.sendAgentOutput("task-1", "chunk of output");

      expect(mockSubscribed.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: "agent.output",
          taskId: "task-1",
          chunk: "chunk of output",
        })
      );
      expect(mockUnsubscribed.send).not.toHaveBeenCalled();
    });

    it("does nothing when no clients subscribed to task", () => {
      expect(() => {
        eventRelay.sendAgentOutput("task-99", "output");
      }).not.toThrow();
    });

    it("skips subscribed clients that are not OPEN", () => {
      const mockOpen = { readyState: 1, send: vi.fn() };
      const mockClosed = { readyState: 2, send: vi.fn() };
      agentSubscriptions.set(mockOpen, new Set(["task-1"]));
      agentSubscriptions.set(mockClosed, new Set(["task-1"]));

      eventRelay.sendAgentOutput("task-1", "chunk");

      expect(mockOpen.send).toHaveBeenCalled();
      expect(mockClosed.send).not.toHaveBeenCalled();
    });
  });
});
