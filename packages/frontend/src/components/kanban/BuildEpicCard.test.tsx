import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BuildEpicCard } from "./BuildEpicCard";

const createMockTask = (
  overrides: Partial<{
    id: string;
    title: string;
    kanbanColumn: "planning" | "backlog" | "ready" | "in_progress" | "in_review" | "done" | "blocked";
    priority: number;
    assignee: string | null;
  }> = {},
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
      />,
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
      <BuildEpicCard
        epicId="epic-1"
        epicTitle="Auth"
        tasks={tasks}
        onTaskSelect={onTaskSelect}
      />,
    );

    expect(screen.getByText("Task A")).toBeInTheDocument();
    expect(screen.getByText("Task B")).toBeInTheDocument();
    expect(screen.getByText("Task C")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(screen.getByText("Backlog")).toBeInTheDocument();
  });

  it("calls onTaskSelect when a task is clicked", async () => {
    const user = userEvent.setup();
    const onTaskSelect = vi.fn();
    const tasks = [
      createMockTask({ id: "epic-1.1", title: "Task A", kanbanColumn: "done" }),
    ];
    render(
      <BuildEpicCard
        epicId="epic-1"
        epicTitle="Auth"
        tasks={tasks}
        onTaskSelect={onTaskSelect}
      />,
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
      />,
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
      />,
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
      />,
    );

    expect(screen.getByText("Blocked")).toBeInTheDocument();
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
    render(
      <BuildEpicCard
        epicId="epic-1"
        epicTitle="Auth"
        tasks={tasks}
        onTaskSelect={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Unblock" })).not.toBeInTheDocument();
  });

  it("handles epic with no tasks", () => {
    const onTaskSelect = vi.fn();
    render(
      <BuildEpicCard
        epicId="epic-empty"
        epicTitle="Empty Epic"
        tasks={[]}
        onTaskSelect={onTaskSelect}
      />,
    );

    expect(screen.getByText("Empty Epic")).toBeInTheDocument();
    expect(screen.getByText("0/0")).toBeInTheDocument();
  });
});
