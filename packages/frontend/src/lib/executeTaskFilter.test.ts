import { describe, it, expect } from "vitest";
import {
  matchesStatusFilter,
  matchesSearchQuery,
  filterTasksByStatusAndSearch,
  type StatusFilter,
} from "./executeTaskFilter";
import type { Task } from "@opensprint/shared";

const baseTask: Task = {
  id: "task-1",
  title: "Add login form",
  description: "Implement user authentication flow",
  type: "task",
  status: "open",
  priority: 1,
  assignee: null,
  labels: [],
  dependencies: [],
  epicId: "epic-1",
  kanbanColumn: "ready",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

describe("executeTaskFilter", () => {
  describe("matchesStatusFilter", () => {
    it("returns true for 'all' filter regardless of column", () => {
      expect(matchesStatusFilter("ready", "all")).toBe(true);
      expect(matchesStatusFilter("done", "all")).toBe(true);
      expect(matchesStatusFilter("blocked", "all")).toBe(true);
    });

    it("returns true when column matches filter", () => {
      expect(matchesStatusFilter("ready", "ready")).toBe(true);
      expect(matchesStatusFilter("in_progress", "in_progress")).toBe(true);
      expect(matchesStatusFilter("done", "done")).toBe(true);
    });

    it("returns false when column does not match filter", () => {
      expect(matchesStatusFilter("ready", "done")).toBe(false);
      expect(matchesStatusFilter("done", "ready")).toBe(false);
    });

    it("maps planning/backlog/blocked to blocked filter", () => {
      expect(matchesStatusFilter("blocked", "blocked")).toBe(true);
      expect(matchesStatusFilter("planning", "blocked")).toBe(true);
      expect(matchesStatusFilter("backlog", "blocked")).toBe(true);
    });
  });

  describe("matchesSearchQuery", () => {
    it("returns true for empty query", () => {
      expect(matchesSearchQuery(baseTask, "")).toBe(true);
      expect(matchesSearchQuery(baseTask, "   ")).toBe(true);
    });

    it("matches against title (case-insensitive)", () => {
      expect(matchesSearchQuery(baseTask, "login")).toBe(true);
      expect(matchesSearchQuery(baseTask, "LOGIN")).toBe(true);
      expect(matchesSearchQuery(baseTask, "Add")).toBe(true);
      expect(matchesSearchQuery(baseTask, "form")).toBe(true);
    });

    it("matches against description (case-insensitive)", () => {
      expect(matchesSearchQuery(baseTask, "authentication")).toBe(true);
      expect(matchesSearchQuery(baseTask, "AUTHENTICATION")).toBe(true);
      expect(matchesSearchQuery(baseTask, "Implement")).toBe(true);
      expect(matchesSearchQuery(baseTask, "user")).toBe(true);
    });

    it("returns false when neither title nor description matches", () => {
      expect(matchesSearchQuery(baseTask, "logout")).toBe(false);
      expect(matchesSearchQuery(baseTask, "xyz")).toBe(false);
    });

    it("handles null/undefined title and description", () => {
      const taskNoDesc = { ...baseTask, description: "" };
      expect(matchesSearchQuery(taskNoDesc, "login")).toBe(true);
      expect(matchesSearchQuery(taskNoDesc, "authentication")).toBe(false);
    });
  });

  describe("filterTasksByStatusAndSearch", () => {
    const tasks: Task[] = [
      { ...baseTask, id: "t1", title: "Login task", kanbanColumn: "done" as const },
      { ...baseTask, id: "t2", title: "Logout task", kanbanColumn: "ready" as const },
      { ...baseTask, id: "t3", title: "Fix password reset", description: "Reset flow", kanbanColumn: "ready" as const },
    ];

    it("returns all tasks when status=all and empty search", () => {
      const result = filterTasksByStatusAndSearch(tasks, "all", "");
      expect(result).toHaveLength(3);
    });

    it("filters by status only when search is empty", () => {
      const result = filterTasksByStatusAndSearch(tasks, "done", "");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("t1");
    });

    it("filters by search only when status=all", () => {
      const result = filterTasksByStatusAndSearch(tasks, "all", "login");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("t1");
    });

    it("composes status and search with AND logic", () => {
      // Login is done, Logout is ready - search "Log" matches both but status "done" only matches Login
      const result = filterTasksByStatusAndSearch(tasks, "done", "Log");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("t1");

      // Logout is ready, search "Logout" - one match
      const result2 = filterTasksByStatusAndSearch(tasks, "ready", "Logout");
      expect(result2).toHaveLength(1);
      expect(result2[0].id).toBe("t2");

      // Logout is ready but search "Login" - zero matches
      const result3 = filterTasksByStatusAndSearch(tasks, "ready", "Login");
      expect(result3).toHaveLength(0);
    });

    it("matches description when search does not match title", () => {
      const result = filterTasksByStatusAndSearch(tasks, "all", "Reset");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("t3");
    });

    it("returns empty array when no tasks match", () => {
      const result = filterTasksByStatusAndSearch(tasks, "in_progress", "xyz");
      expect(result).toHaveLength(0);
    });

    it("clearing search restores full view", () => {
      const filtered = filterTasksByStatusAndSearch(tasks, "all", "login");
      expect(filtered).toHaveLength(1);

      const restored = filterTasksByStatusAndSearch(tasks, "all", "");
      expect(restored).toHaveLength(3);
    });
  });
});
