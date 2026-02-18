import { describe, it, expect, beforeEach } from "vitest";
import { activeAgentsService } from "../services/active-agents.service.js";

describe("ActiveAgentsService", () => {
  beforeEach(() => {
    // Clear the registry before each test (service is a singleton with shared state)
    const list = activeAgentsService.list();
    for (const agent of list) {
      activeAgentsService.unregister(agent.id);
    }
  });

  describe("register", () => {
    it("adds an agent to the registry", () => {
      activeAgentsService.register(
        "task-1",
        "proj-1",
        "coding",
        "coder",
        "Implement login",
        "2026-02-16T10:00:00.000Z",
      );

      const agents = activeAgentsService.list();
      expect(agents).toHaveLength(1);
      expect(agents[0]).toEqual({
        id: "task-1",
        phase: "coding",
        role: "coder",
        label: "Implement login",
        startedAt: "2026-02-16T10:00:00.000Z",
      });
    });

    it("includes branchName when provided", () => {
      activeAgentsService.register(
        "task-2",
        "proj-1",
        "coding",
        "coder",
        "Add tests",
        "2026-02-16T10:05:00.000Z",
        "opensprint/task-2",
      );

      const agents = activeAgentsService.list();
      expect(agents[0]).toMatchObject({
        id: "task-2",
        role: "coder",
        branchName: "opensprint/task-2",
      });
    });

    it("overwrites existing agent with same id", () => {
      activeAgentsService.register("task-1", "proj-1", "coding", "coder", "Old", "2026-02-16T10:00:00.000Z");
      activeAgentsService.register("task-1", "proj-1", "review", "reviewer", "New", "2026-02-16T10:10:00.000Z");

      const agents = activeAgentsService.list();
      expect(agents).toHaveLength(1);
      expect(agents[0]).toEqual({
        id: "task-1",
        phase: "review",
        role: "reviewer",
        label: "New",
        startedAt: "2026-02-16T10:10:00.000Z",
      });
    });
  });

  describe("unregister", () => {
    it("removes an agent by id", () => {
      activeAgentsService.register("task-1", "proj-1", "coding", "coder", "Task", "2026-02-16T10:00:00.000Z");

      activeAgentsService.unregister("task-1");

      expect(activeAgentsService.list()).toHaveLength(0);
    });

    it("is safe to call when agent was never registered", () => {
      expect(() => activeAgentsService.unregister("nonexistent")).not.toThrow();
    });

    it("does not affect other agents", () => {
      activeAgentsService.register("task-1", "proj-1", "coding", "coder", "Task 1", "2026-02-16T10:00:00.000Z");
      activeAgentsService.register("task-2", "proj-1", "coding", "coder", "Task 2", "2026-02-16T10:01:00.000Z");

      activeAgentsService.unregister("task-1");

      const agents = activeAgentsService.list();
      expect(agents).toHaveLength(1);
      expect(agents[0].id).toBe("task-2");
    });
  });

  describe("list", () => {
    it("returns empty array when no agents registered", () => {
      expect(activeAgentsService.list()).toEqual([]);
    });

    it("returns all agents when no projectId filter", () => {
      activeAgentsService.register("task-1", "proj-1", "coding", "coder", "Task 1", "2026-02-16T10:00:00.000Z");
      activeAgentsService.register("task-2", "proj-2", "review", "reviewer", "Task 2", "2026-02-16T10:01:00.000Z");

      const agents = activeAgentsService.list();
      expect(agents).toHaveLength(2);
    });

    it("filters by projectId when provided", () => {
      activeAgentsService.register("task-1", "proj-1", "coding", "coder", "Task 1", "2026-02-16T10:00:00.000Z");
      activeAgentsService.register("task-2", "proj-2", "review", "reviewer", "Task 2", "2026-02-16T10:01:00.000Z");
      activeAgentsService.register("task-3", "proj-1", "coding", "coder", "Task 3", "2026-02-16T10:02:00.000Z");

      const agents = activeAgentsService.list("proj-1");
      expect(agents).toHaveLength(2);
      expect(agents.map((a) => a.id)).toContain("task-1");
      expect(agents.map((a) => a.id)).toContain("task-3");
    });

    it("returns empty array for non-existent projectId", () => {
      activeAgentsService.register("task-1", "proj-1", "coding", "coder", "Task 1", "2026-02-16T10:00:00.000Z");

      expect(activeAgentsService.list("proj-999")).toEqual([]);
    });

    it("omits projectId from response (API compatibility)", () => {
      activeAgentsService.register("task-1", "proj-1", "sketch", "dreamer", "PRD draft", "2026-02-16T10:00:00.000Z");

      const agents = activeAgentsService.list("proj-1");
      expect(agents[0]).not.toHaveProperty("projectId");
      expect(agents[0]).toMatchObject({
        id: "task-1",
        phase: "sketch",
        role: "dreamer",
        label: "PRD draft",
        startedAt: "2026-02-16T10:00:00.000Z",
      });
    });
  });
});
