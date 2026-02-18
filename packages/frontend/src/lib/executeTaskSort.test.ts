import { describe, it, expect } from "vitest";
import { sortEpicTasksByStatus } from "./executeTaskSort";
import type { Task } from "@opensprint/shared";

function createTask(
  overrides: Partial<{ id: string; title: string; kanbanColumn: Task["kanbanColumn"]; priority: number }>,
): Task {
  return {
    id: overrides.id ?? "task-1",
    title: overrides.title ?? "Task",
    description: "",
    type: "task",
    status: "open",
    priority: (overrides.priority ?? 1) as 0 | 1 | 2 | 3 | 4,
    assignee: null,
    labels: [],
    dependencies: [],
    epicId: "epic-1",
    kanbanColumn: overrides.kanbanColumn ?? "backlog",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("sortEpicTasksByStatus", () => {
  it("groups tasks by status: In Progress → In Review → Ready → Backlog → Done", () => {
    const tasks = [
      createTask({ id: "a", kanbanColumn: "done", priority: 0 }),
      createTask({ id: "b", kanbanColumn: "in_progress", priority: 0 }),
      createTask({ id: "c", kanbanColumn: "ready", priority: 0 }),
      createTask({ id: "d", kanbanColumn: "backlog", priority: 0 }),
      createTask({ id: "e", kanbanColumn: "in_review", priority: 0 }),
    ];
    const sorted = sortEpicTasksByStatus(tasks);
    expect(sorted.map((t) => t.id)).toEqual(["b", "e", "c", "d", "a"]);
    expect(sorted.map((t) => t.kanbanColumn)).toEqual([
      "in_progress",
      "in_review",
      "ready",
      "backlog",
      "done",
    ]);
  });

  it("places planning and blocked after backlog, before done", () => {
    const tasks = [
      createTask({ id: "a", kanbanColumn: "done", priority: 0 }),
      createTask({ id: "b", kanbanColumn: "planning", priority: 0 }),
      createTask({ id: "c", kanbanColumn: "blocked", priority: 0 }),
      createTask({ id: "d", kanbanColumn: "backlog", priority: 0 }),
    ];
    const sorted = sortEpicTasksByStatus(tasks);
    expect(sorted.map((t) => t.kanbanColumn)).toEqual(["backlog", "planning", "blocked", "done"]);
  });

  it("sorts by priority (0 highest) within same status group", () => {
    const tasks = [
      createTask({ id: "a", kanbanColumn: "ready", priority: 2 }),
      createTask({ id: "b", kanbanColumn: "ready", priority: 0 }),
      createTask({ id: "c", kanbanColumn: "ready", priority: 1 }),
    ];
    const sorted = sortEpicTasksByStatus(tasks);
    expect(sorted.map((t) => t.id)).toEqual(["b", "c", "a"]);
    expect(sorted.map((t) => t.priority)).toEqual([0, 1, 2]);
  });

  it("uses ID as tiebreaker when priority is equal", () => {
    const tasks = [
      createTask({ id: "epic-1.3", kanbanColumn: "ready", priority: 0 }),
      createTask({ id: "epic-1.1", kanbanColumn: "ready", priority: 0 }),
      createTask({ id: "epic-1.2", kanbanColumn: "ready", priority: 0 }),
    ];
    const sorted = sortEpicTasksByStatus(tasks);
    expect(sorted.map((t) => t.id)).toEqual(["epic-1.1", "epic-1.2", "epic-1.3"]);
  });

  it("does not mutate the input array", () => {
    const tasks = [
      createTask({ id: "a", kanbanColumn: "done", priority: 0 }),
      createTask({ id: "b", kanbanColumn: "in_progress", priority: 0 }),
    ];
    const originalOrder = tasks.map((t) => t.id);
    sortEpicTasksByStatus(tasks);
    expect(tasks.map((t) => t.id)).toEqual(originalOrder);
  });

  it("returns empty array for empty input", () => {
    expect(sortEpicTasksByStatus([])).toEqual([]);
  });

  it("handles single task", () => {
    const tasks = [createTask({ id: "only", kanbanColumn: "in_review", priority: 1 })];
    expect(sortEpicTasksByStatus(tasks)).toHaveLength(1);
    expect(sortEpicTasksByStatus(tasks)[0].id).toBe("only");
  });
});
