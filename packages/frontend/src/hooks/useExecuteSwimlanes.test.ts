import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useExecuteSwimlanes, showReadyInLineSections } from "./useExecuteSwimlanes";
import type { Task, Plan } from "@opensprint/shared";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Implement feature",
    description: "",
    type: "task",
    status: "open",
    priority: 1,
    assignee: null,
    labels: [],
    dependencies: [],
    epicId: "epic-a",
    kanbanColumn: "ready",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    content: "# Epic A Plan\n\nOverview.",
    status: "building",
    taskCount: 1,
    doneTaskCount: 0,
    dependencyCount: 0,
    metadata: {
      planId: "plan-1",
      epicId: "epic-a",
      shippedAt: null,
      complexity: "medium",
    },
    ...overrides,
  };
}

describe("useExecuteSwimlanes", () => {
  it("filters out epics from implTasks (no gate exclusion in epic-blocked model)", () => {
    const tasks: Task[] = [
      task({ id: "epic-a", type: "epic", epicId: null }),
      task({ id: "epic-a.1", title: "Task 1", epicId: "epic-a" }),
      task({ id: "epic-a.2", title: "Task 2", epicId: "epic-a" }),
    ];
    const plans: Plan[] = [plan()];
    const { result } = renderHook(() => useExecuteSwimlanes(tasks, plans, "all", ""));
    expect(result.current.implTasks).toHaveLength(2);
    expect(result.current.implTasks.map((t) => t.id)).toEqual(["epic-a.1", "epic-a.2"]);
  });

  it("groups tasks by epic into swimlanes", () => {
    const tasks: Task[] = [
      task({ id: "epic-a.1", epicId: "epic-a", title: "A1" }),
      task({ id: "epic-a.2", epicId: "epic-a", title: "A2" }),
      task({ id: "epic-b.1", epicId: "epic-b", title: "B1" }),
    ];
    const plans: Plan[] = [
      plan({
        content: "# Epic A\n",
        metadata: {
          planId: "p1",
          epicId: "epic-a",
          shippedAt: null,
          complexity: "medium",
        },
      }),
      plan({
        content: "# Epic B\n",
        metadata: {
          planId: "p2",
          epicId: "epic-b",
          shippedAt: null,
          complexity: "medium",
        },
      }),
    ];
    const { result } = renderHook(() => useExecuteSwimlanes(tasks, plans, "all", ""));
    expect(result.current.swimlanes.length).toBeGreaterThanOrEqual(2);
    const laneA = result.current.swimlanes.find((s) => s.epicId === "epic-a");
    expect(laneA).toBeDefined();
    expect(laneA!.tasks).toHaveLength(2);
    expect(laneA!.epicTitle).toBe("Epic A");
  });

  it("returns chipConfig with counts", () => {
    const tasks: Task[] = [
      task({ id: "epic-a.1", kanbanColumn: "ready" }),
      task({ id: "epic-a.2", kanbanColumn: "done" }),
    ];
    const plans: Plan[] = [plan()];
    const { result } = renderHook(() => useExecuteSwimlanes(tasks, plans, "all", ""));
    expect(result.current.chipConfig).toBeDefined();
    expect(result.current.chipConfig.some((c) => c.filter === "all" && c.count === 2)).toBe(true);
    expect(result.current.chipConfig.some((c) => c.filter === "in_line" && c.count === 0)).toBe(
      true
    );
    expect(result.current.chipConfig.some((c) => c.filter === "ready" && c.count === 1)).toBe(true);
    expect(result.current.chipConfig.some((c) => c.filter === "done" && c.count === 1)).toBe(true);
  });

  it("In Progress chip combines in_progress and in_review counts (no separate In Review chip)", () => {
    const tasks: Task[] = [
      task({ id: "epic-a.1", kanbanColumn: "in_progress" }),
      task({ id: "epic-a.2", kanbanColumn: "in_review" }),
      task({ id: "epic-a.3", kanbanColumn: "done" }),
    ];
    const plans: Plan[] = [plan()];
    const { result } = renderHook(() => useExecuteSwimlanes(tasks, plans, "all", ""));
    const chips = result.current.chipConfig;
    const inProgressChip = chips.find((c) => c.filter === "in_progress");
    expect(inProgressChip).toBeDefined();
    expect(inProgressChip!.label).toBe("In Progress");
    expect(inProgressChip!.count).toBe(2);
    expect(chips.some((c) => c.filter === "in_review")).toBe(false);
  });

  it("in_progress filter shows both in_progress and in_review tasks", () => {
    const tasks: Task[] = [
      task({ id: "epic-a.1", kanbanColumn: "in_progress", epicId: "epic-a" }),
      task({ id: "epic-a.2", kanbanColumn: "in_review", epicId: "epic-a" }),
      task({ id: "epic-a.3", kanbanColumn: "ready", epicId: "epic-a" }),
    ];
    const plans: Plan[] = [plan()];
    const { result } = renderHook(() => useExecuteSwimlanes(tasks, plans, "in_progress", ""));
    expect(result.current.filteredTasks).toHaveLength(2);
    expect(result.current.filteredTasks.map((t) => t.id)).toEqual(["epic-a.1", "epic-a.2"]);
  });

  it("In Line chip is between All and Ready and counts backlog, planning (excludes blocked)", () => {
    const tasks: Task[] = [
      task({ id: "epic-a.1", kanbanColumn: "backlog" }),
      task({ id: "epic-a.2", kanbanColumn: "blocked" }),
      task({ id: "epic-a.3", kanbanColumn: "planning" }),
      task({ id: "epic-a.4", kanbanColumn: "ready" }),
    ];
    const plans: Plan[] = [plan()];
    const { result } = renderHook(() => useExecuteSwimlanes(tasks, plans, "all", ""));
    const chips = result.current.chipConfig;
    const allIdx = chips.findIndex((c) => c.filter === "all");
    const inLineIdx = chips.findIndex((c) => c.filter === "in_line");
    const readyIdx = chips.findIndex((c) => c.filter === "ready");
    expect(allIdx).toBeLessThan(inLineIdx);
    expect(inLineIdx).toBeLessThan(readyIdx);
    expect(chips[inLineIdx].label).toBe("In Line");
    expect(chips[inLineIdx].count).toBe(2);
  });

  it("filters by search query", () => {
    const tasks: Task[] = [
      task({ id: "epic-a.1", title: "Login form", epicId: "epic-a" }),
      task({ id: "epic-a.2", title: "Logout button", epicId: "epic-a" }),
    ];
    const plans: Plan[] = [plan()];
    const { result } = renderHook(() => useExecuteSwimlanes(tasks, plans, "all", "Login"));
    expect(result.current.implTasks).toHaveLength(2);
    expect(result.current.filteredTasks).toHaveLength(1);
    expect(result.current.filteredTasks[0].title).toBe("Login form");
    expect(result.current.swimlanes[0].tasks).toHaveLength(1);
    expect(result.current.swimlanes[0].tasks[0].title).toBe("Login form");
  });

  describe("Ready vs In Line sections", () => {
    it("showReadyInLineSections returns true for all, ready, in_line filters", () => {
      expect(showReadyInLineSections("all")).toBe(true);
      expect(showReadyInLineSections("ready")).toBe(true);
      expect(showReadyInLineSections("in_line")).toBe(true);
      expect(showReadyInLineSections("in_progress")).toBe(false);
      expect(showReadyInLineSections("done")).toBe(false);
      expect(showReadyInLineSections("blocked")).toBe(false);
    });

    it("readySwimlanes contains only Ready tasks when statusFilter is all", () => {
      const tasks: Task[] = [
        task({ id: "epic-a.1", kanbanColumn: "ready", epicId: "epic-a" }),
        task({ id: "epic-a.2", kanbanColumn: "backlog", epicId: "epic-a" }),
        task({ id: "epic-b.1", kanbanColumn: "ready", epicId: "epic-b" }),
      ];
      const plans: Plan[] = [
        plan({
          metadata: { planId: "p1", epicId: "epic-a", shippedAt: null, complexity: "medium" },
        }),
        plan({
          metadata: { planId: "p2", epicId: "epic-b", shippedAt: null, complexity: "medium" },
        }),
      ];
      const { result } = renderHook(() => useExecuteSwimlanes(tasks, plans, "all", ""));
      expect(result.current.readySwimlanes).toHaveLength(2);
      expect(
        result.current.readySwimlanes.every((s) => s.tasks.every((t) => t.kanbanColumn === "ready"))
      ).toBe(true);
      expect(result.current.readySwimlanes.flatMap((s) => s.tasks)).toHaveLength(2);
    });

    it("inLineSwimlanes contains only backlog/planning tasks when statusFilter is all", () => {
      const tasks: Task[] = [
        task({ id: "epic-a.1", kanbanColumn: "ready", epicId: "epic-a" }),
        task({ id: "epic-a.2", kanbanColumn: "backlog", epicId: "epic-a" }),
        task({ id: "epic-a.3", kanbanColumn: "planning", epicId: "epic-a" }),
      ];
      const plans: Plan[] = [plan()];
      const { result } = renderHook(() => useExecuteSwimlanes(tasks, plans, "all", ""));
      expect(result.current.inLineSwimlanes).toHaveLength(1);
      expect(result.current.inLineSwimlanes[0].tasks).toHaveLength(2);
      expect(
        result.current.inLineSwimlanes[0].tasks.every(
          (t) => t.kanbanColumn === "backlog" || t.kanbanColumn === "planning"
        )
      ).toBe(true);
    });

    it("readySwimlanes empty when statusFilter is in_line; inLineSwimlanes empty when statusFilter is ready", () => {
      const tasks: Task[] = [
        task({ id: "epic-a.1", kanbanColumn: "ready", epicId: "epic-a" }),
        task({ id: "epic-a.2", kanbanColumn: "backlog", epicId: "epic-a" }),
      ];
      const plans: Plan[] = [plan()];
      const { result: resultReady } = renderHook(() =>
        useExecuteSwimlanes(tasks, plans, "ready", "")
      );
      expect(resultReady.current.readySwimlanes).toHaveLength(1);
      expect(resultReady.current.inLineSwimlanes).toHaveLength(0);

      const { result: resultInLine } = renderHook(() =>
        useExecuteSwimlanes(tasks, plans, "in_line", "")
      );
      expect(resultInLine.current.readySwimlanes).toHaveLength(0);
      expect(resultInLine.current.inLineSwimlanes).toHaveLength(1);
    });

    it("search query applies to both readySwimlanes and inLineSwimlanes", () => {
      const tasks: Task[] = [
        task({ id: "epic-a.1", title: "Auth flow", kanbanColumn: "ready", epicId: "epic-a" }),
        task({
          id: "epic-a.2",
          title: "Database schema",
          kanbanColumn: "backlog",
          epicId: "epic-a",
        }),
      ];
      const plans: Plan[] = [plan()];
      const { result } = renderHook(() => useExecuteSwimlanes(tasks, plans, "all", "Auth"));
      expect(result.current.readySwimlanes[0].tasks).toHaveLength(1);
      expect(result.current.readySwimlanes[0].tasks[0].title).toBe("Auth flow");
      expect(result.current.inLineSwimlanes).toHaveLength(0);
    });

    it("blockedSwimlanes contains only blocked tasks when statusFilter is all", () => {
      const tasks: Task[] = [
        task({ id: "epic-a.1", kanbanColumn: "ready", epicId: "epic-a" }),
        task({ id: "epic-a.2", kanbanColumn: "blocked", epicId: "epic-a" }),
        task({ id: "epic-b.1", kanbanColumn: "blocked", epicId: "epic-b" }),
      ];
      const plans: Plan[] = [
        plan({
          metadata: { planId: "p1", epicId: "epic-a", shippedAt: null, complexity: "medium" },
        }),
        plan({
          metadata: { planId: "p2", epicId: "epic-b", shippedAt: null, complexity: "medium" },
        }),
      ];
      const { result } = renderHook(() => useExecuteSwimlanes(tasks, plans, "all", ""));
      expect(result.current.blockedSwimlanes).toHaveLength(2);
      expect(
        result.current.blockedSwimlanes.every((s) => s.tasks.every((t) => t.kanbanColumn === "blocked"))
      ).toBe(true);
      expect(result.current.blockedSwimlanes.flatMap((s) => s.tasks)).toHaveLength(2);
    });

    it("blockedSwimlanes is empty when statusFilter is not all", () => {
      const tasks: Task[] = [
        task({ id: "epic-a.1", kanbanColumn: "blocked", epicId: "epic-a" }),
      ];
      const plans: Plan[] = [plan()];
      const { result } = renderHook(() => useExecuteSwimlanes(tasks, plans, "blocked", ""));
      expect(result.current.blockedSwimlanes).toHaveLength(0);
    });
  });
});
