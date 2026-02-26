import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BuildEpicCard } from "./BuildEpicCard";

const createMockTask = (
  overrides: Partial<{
    id: string;
    title: string;
    kanbanColumn:
      | "planning"
      | "backlog"
      | "ready"
      | "in_progress"
      | "in_review"
      | "done"
      | "blocked";
    priority: number;
    assignee: string | null;
    complexity: "low" | "high";
  }> = {}
) => ({
  id: "epic-1.1",
  title: "Implement login",
  description: "Add login flow",
  type: "task" as const,
  status: "open" as const,
  priority: 1,
  assignee: null,
  labels: [],
  dependencies: [],
  epicId: "epic-1",
  kanbanColumn: "in_progress" as const,
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

describe("BuildEpicCard", () => {
  it("renders epic title and progress bar", () => {
    const onTaskSelect = vi.fn();
    const tasks = [
      createMockTask({ id: "epic-1.1", title: "Task A", kanbanColumn: "done" }),
      createMockTask({ id: "epic-1.2", title: "Task B", kanbanColumn: "in_progress" }),
    ];
    render(
      <BuildEpicCard
        epicId="epic-1"
        epicTitle="Authentication"
        tasks={tasks}
        onTaskSelect={onTaskSelect}
      />
    );

    expect(screen.getByText("Authentication")).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "1 of 2 tasks done" })).toBeInTheDocument();
  });

  it("renders nested subtasks with names and statuses", () => {
    const onTaskSelect = vi.fn();
    const tasks = [
      createMockTask({ id: "epic-1.1", title: "Task A", kanbanColumn: "done" }),
      createMockTask({ id: "epic-1.2", title: "Task B", kanbanColumn: "in_progress" }),
      createMockTask({ id: "epic-1.3", title: "Task C", kanbanColumn: "backlog" }),
    ];
    render(
      <BuildEpicCard epicId="epic-1" epicTitle="Auth" tasks={tasks} onTaskSelect={onTaskSelect} />
    );

    expect(screen.getByText("Task A")).toBeInTheDocument();
    expect(screen.getByText("Task B")).toBeInTheDocument();
    expect(screen.getByText("Task C")).toBeInTheDocument();
    expect(screen.getByTitle("Done")).toBeInTheDocument();
    expect(screen.getByTitle("In Progress")).toBeInTheDocument();
    expect(screen.getByTitle("Backlog")).toBeInTheDocument();
  });

  it("calls onTaskSelect when a task is clicked", async () => {
    const user = userEvent.setup();
    const onTaskSelect = vi.fn();
    const tasks = [createMockTask({ id: "epic-1.1", title: "Task A", kanbanColumn: "done" })];
    render(
      <BuildEpicCard epicId="epic-1" epicTitle="Auth" tasks={tasks} onTaskSelect={onTaskSelect} />
    );

    await user.click(screen.getByText("Task A"));

    expect(onTaskSelect).toHaveBeenCalledWith("epic-1.1");
  });

  it("shows +X more when there are more than 3 subtasks", () => {
    const onTaskSelect = vi.fn();
    const tasks = [
      createMockTask({ id: "epic-1.1", title: "Task 1", kanbanColumn: "done" }),
      createMockTask({ id: "epic-1.2", title: "Task 2", kanbanColumn: "ready" }),
      createMockTask({ id: "epic-1.3", title: "Task 3", kanbanColumn: "backlog" }),
      createMockTask({ id: "epic-1.4", title: "Task 4", kanbanColumn: "backlog" }),
      createMockTask({ id: "epic-1.5", title: "Task 5", kanbanColumn: "backlog" }),
    ];
    render(
      <BuildEpicCard
        epicId="epic-1"
        epicTitle="Large Epic"
        tasks={tasks}
        onTaskSelect={onTaskSelect}
      />
    );

    expect(screen.getByText("Task 1")).toBeInTheDocument();
    expect(screen.getByText("Task 2")).toBeInTheDocument();
    expect(screen.getByText("Task 3")).toBeInTheDocument();
    expect(screen.queryByText("Task 4")).not.toBeInTheDocument();
    expect(screen.queryByText("Task 5")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+2 more" })).toBeInTheDocument();
  });

  it("expands to show all subtasks when +X more is clicked", async () => {
    const user = userEvent.setup();
    const onTaskSelect = vi.fn();
    const tasks = [
      createMockTask({ id: "epic-1.1", title: "Task 1", kanbanColumn: "done" }),
      createMockTask({ id: "epic-1.2", title: "Task 2", kanbanColumn: "ready" }),
      createMockTask({ id: "epic-1.3", title: "Task 3", kanbanColumn: "backlog" }),
      createMockTask({ id: "epic-1.4", title: "Task 4", kanbanColumn: "backlog" }),
    ];
    render(
      <BuildEpicCard
        epicId="epic-1"
        epicTitle="Large Epic"
        tasks={tasks}
        onTaskSelect={onTaskSelect}
      />
    );

    expect(screen.queryByText("Task 4")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+1 more" }));

    expect(screen.getByText("Task 4")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /more/ })).not.toBeInTheDocument();
  });

  it("shows Unblock button for blocked tasks when onUnblock is provided", async () => {
    const user = userEvent.setup();
    const onTaskSelect = vi.fn();
    const onUnblock = vi.fn();
    const tasks = [
      createMockTask({ id: "epic-1.1", title: "Blocked Task", kanbanColumn: "blocked" }),
    ];
    render(
      <BuildEpicCard
        epicId="epic-1"
        epicTitle="Auth"
        tasks={tasks}
        onTaskSelect={onTaskSelect}
        onUnblock={onUnblock}
      />
    );

    expect(screen.getByTitle("Blocked")).toBeInTheDocument();
    expect(screen.getByTestId("task-blocked")).toBeInTheDocument();
    const unblockBtn = screen.getByRole("button", { name: "Unblock" });
    expect(unblockBtn).toBeInTheDocument();

    await user.click(unblockBtn);
    expect(onUnblock).toHaveBeenCalledWith("epic-1.1");
  });

  it("does not show Unblock button for blocked tasks when onUnblock is not provided", () => {
    const tasks = [
      createMockTask({ id: "epic-1.1", title: "Blocked Task", kanbanColumn: "blocked" }),
    ];
    render(<BuildEpicCard epicId="epic-1" epicTitle="Auth" tasks={tasks} onTaskSelect={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Unblock" })).not.toBeInTheDocument();
  });

  it("shows assignee when task has assignee", () => {
    const tasks = [
      createMockTask({
        id: "epic-1.1",
        title: "Task A",
        assignee: "Frodo",
        kanbanColumn: "in_progress",
      }),
    ];
    render(<BuildEpicCard epicId="epic-1" epicTitle="Auth" tasks={tasks} onTaskSelect={vi.fn()} />);

    expect(screen.getByText("Frodo")).toBeInTheDocument();
  });

  it("shows elapsed time when taskIdToStartedAt is provided for active task", () => {
    const mockNow = new Date("2026-02-17T12:02:35.000Z");
    vi.setSystemTime(mockNow);
    const tasks = [
      createMockTask({ id: "epic-1.1", title: "Task A", kanbanColumn: "in_progress" }),
    ];
    render(
      <BuildEpicCard
        epicId="epic-1"
        epicTitle="Auth"
        tasks={tasks}
        onTaskSelect={vi.fn()}
        taskIdToStartedAt={{ "epic-1.1": "2026-02-17T12:02:20.000Z" }}
      />
    );

    expect(screen.getByText(/15s/)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("handles epic with no tasks", () => {
    const onTaskSelect = vi.fn();
    render(
      <BuildEpicCard
        epicId="epic-empty"
        epicTitle="Empty Epic"
        tasks={[]}
        onTaskSelect={onTaskSelect}
      />
    );

    expect(screen.getByText("Empty Epic")).toBeInTheDocument();
    expect(screen.getByText("0/0")).toBeInTheDocument();
  });

  it("renders exactly one status indicator on the left of task title", () => {
    const tasks = [
      createMockTask({ id: "epic-1.1", title: "Task A", kanbanColumn: "in_progress" }),
    ];
    const { container } = render(
      <BuildEpicCard epicId="epic-1" epicTitle="Auth" tasks={tasks} onTaskSelect={vi.fn()} />
    );
    const row = container.querySelector("li");
    expect(row).toBeTruthy();
    const button = row!.querySelector("button");
    expect(button).toBeTruthy();
    const children = Array.from(button!.children);
    const titleIdx = children.findIndex((el) => el.textContent?.includes("Task A"));
    const statusIndicators = children.filter((el) => el.getAttribute("title") === "In Progress");
    expect(statusIndicators).toHaveLength(1);
    const statusIdx = children.findIndex((el) => el.getAttribute("title") === "In Progress");
    expect(statusIdx).toBeGreaterThanOrEqual(0);
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    expect(statusIdx).toBeLessThan(titleIdx);
  });

  it("renders assignee exclusively on the right of task title", () => {
    const tasks = [
      createMockTask({
        id: "epic-1.1",
        title: "Task A",
        assignee: "Frodo",
        kanbanColumn: "in_progress",
      }),
    ];
    const { container } = render(
      <BuildEpicCard epicId="epic-1" epicTitle="Auth" tasks={tasks} onTaskSelect={vi.fn()} />
    );
    const row = container.querySelector("li");
    const button = row!.querySelector("button");
    const children = Array.from(button!.children);
    const titleIdx = children.findIndex((el) => el.textContent?.includes("Task A"));
    const assigneeIdx = children.findIndex((el) => el.textContent?.includes("Frodo"));
    expect(assigneeIdx).toBeGreaterThanOrEqual(0);
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    expect(assigneeIdx).toBeGreaterThan(titleIdx);
    expect(screen.getByTestId("task-row-right")).toHaveTextContent("Frodo");
  });

  it("shows no assignee element on the right when task is unassigned", () => {
    const tasks = [
      createMockTask({
        id: "epic-1.1",
        title: "Unassigned Task",
        assignee: null,
        kanbanColumn: "ready",
      }),
    ];
    render(<BuildEpicCard epicId="epic-1" epicTitle="Auth" tasks={tasks} onTaskSelect={vi.fn()} />);
    expect(screen.getByText("Unassigned Task")).toBeInTheDocument();
    expect(screen.getByTitle("Ready")).toBeInTheDocument();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
    expect(screen.queryByTestId("task-row-right")).not.toBeInTheDocument();
  });

  it("shows green checkmark when all child tasks are Done", () => {
    const tasks = [
      createMockTask({ id: "epic-1.1", title: "Task A", kanbanColumn: "done" }),
      createMockTask({ id: "epic-1.2", title: "Task B", kanbanColumn: "done" }),
    ];
    render(<BuildEpicCard epicId="epic-1" epicTitle="Auth" tasks={tasks} onTaskSelect={vi.fn()} />);

    const checkmark = screen.getByTestId("epic-completed-checkmark");
    expect(checkmark).toBeInTheDocument();
    expect(checkmark).toHaveAttribute("aria-label", "All tasks completed");
    expect(checkmark).toHaveClass("text-theme-success-muted");
  });

  it("does not show checkmark when any child task is not Done", () => {
    const tasks = [
      createMockTask({ id: "epic-1.1", title: "Task A", kanbanColumn: "done" }),
      createMockTask({ id: "epic-1.2", title: "Task B", kanbanColumn: "in_progress" }),
    ];
    render(<BuildEpicCard epicId="epic-1" epicTitle="Auth" tasks={tasks} onTaskSelect={vi.fn()} />);

    expect(screen.queryByTestId("epic-completed-checkmark")).not.toBeInTheDocument();
  });

  it("does not show checkmark for non-Done states: planning, backlog, ready, in_review, blocked", () => {
    const states: Array<"planning" | "backlog" | "ready" | "in_review" | "blocked"> = [
      "planning",
      "backlog",
      "ready",
      "in_review",
      "blocked",
    ];
    for (const col of states) {
      const tasks = [createMockTask({ id: "epic-1.1", title: "Task", kanbanColumn: col })];
      const { unmount } = render(
        <BuildEpicCard epicId="epic-1" epicTitle="Auth" tasks={tasks} onTaskSelect={vi.fn()} />
      );
      expect(screen.queryByTestId("epic-completed-checkmark")).not.toBeInTheDocument();
      unmount();
    }
  });

  it("does not show checkmark when epic has no tasks", () => {
    render(
      <BuildEpicCard epicId="epic-empty" epicTitle="Empty Epic" tasks={[]} onTaskSelect={vi.fn()} />
    );
    expect(screen.queryByTestId("epic-completed-checkmark")).not.toBeInTheDocument();
  });

  it("renders priority icon with correct priority in each task row", () => {
    const tasks = [
      createMockTask({
        id: "epic-1.1",
        title: "Critical task",
        priority: 0,
        kanbanColumn: "in_progress",
      }),
      createMockTask({
        id: "epic-1.2",
        title: "High task",
        priority: 1,
        kanbanColumn: "in_progress",
      }),
      createMockTask({
        id: "epic-1.3",
        title: "Medium task",
        priority: 2,
        kanbanColumn: "in_progress",
      }),
    ];
    render(
      <BuildEpicCard epicId="epic-1" epicTitle="Priorities" tasks={tasks} onTaskSelect={vi.fn()} />
    );

    expect(screen.getByRole("img", { name: "Critical" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "High" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Medium" })).toBeInTheDocument();
  });

  it("renders complexity icon when task has complexity", () => {
    const tasks = [
      createMockTask({
        id: "epic-1.1",
        title: "Complex task",
        kanbanColumn: "in_progress",
        complexity: "low",
      }),
    ];
    render(
      <BuildEpicCard epicId="epic-1" epicTitle="Auth" tasks={tasks} onTaskSelect={vi.fn()} />
    );

    expect(screen.getByRole("img", { name: "Low complexity" })).toBeInTheDocument();
  });

  it("makes epic title clickable when onViewPlan is provided", async () => {
    const user = userEvent.setup();
    const onViewPlan = vi.fn();
    const tasks = [
      createMockTask({ id: "epic-1.1", title: "Task A", kanbanColumn: "in_progress" }),
    ];
    render(
      <BuildEpicCard
        epicId="epic-1"
        epicTitle="Auth Feature"
        tasks={tasks}
        onTaskSelect={vi.fn()}
        onViewPlan={onViewPlan}
      />
    );

    const titleButton = screen.getByRole("button", { name: "Auth Feature" });
    expect(titleButton).toBeInTheDocument();
    expect(titleButton).toHaveAttribute("title", "View plan: Auth Feature");
    await user.click(titleButton);
    expect(onViewPlan).toHaveBeenCalledTimes(1);
  });

  it("renders epic title as plain text when onViewPlan is not provided", () => {
    const tasks = [
      createMockTask({ id: "epic-1.1", title: "Task A", kanbanColumn: "in_progress" }),
    ];
    render(
      <BuildEpicCard
        epicId="epic-1"
        epicTitle="Auth Feature"
        tasks={tasks}
        onTaskSelect={vi.fn()}
      />
    );

    expect(screen.getByText("Auth Feature")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Auth Feature" })).not.toBeInTheDocument();
  });

  it("renders all task states correctly in left-side position", async () => {
    const user = userEvent.setup();
    const states: Array<
      "planning" | "backlog" | "ready" | "in_progress" | "in_review" | "done" | "blocked"
    > = ["planning", "backlog", "ready", "in_progress", "in_review", "done", "blocked"];
    const tasks = states.map((col, i) =>
      createMockTask({ id: `epic-1.${i}`, title: `Task ${i}`, kanbanColumn: col })
    );
    render(
      <BuildEpicCard epicId="epic-1" epicTitle="All States" tasks={tasks} onTaskSelect={vi.fn()} />
    );
    await user.click(screen.getByRole("button", { name: "+4 more" }));
    expect(screen.getByTitle("Planning")).toBeInTheDocument();
    expect(screen.getByTitle("Backlog")).toBeInTheDocument();
    expect(screen.getByTitle("Ready")).toBeInTheDocument();
    expect(screen.getByTitle("In Progress")).toBeInTheDocument();
    expect(screen.getByTitle("In Review")).toBeInTheDocument();
    expect(screen.getByTitle("Done")).toBeInTheDocument();
    expect(screen.getByTitle("Blocked")).toBeInTheDocument();
  });
});
