import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EpicTaskTable } from "./EpicTaskTable";

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

describe("EpicTaskTable", () => {
  const mockSwimlanes = [
    {
      epicId: "epic-1",
      epicTitle: "Authentication",
      tasks: [
        createMockTask({ id: "epic-1.1", title: "Task A", kanbanColumn: "done" }),
        createMockTask({ id: "epic-1.2", title: "Task B", kanbanColumn: "in_progress" }),
        createMockTask({ id: "epic-1.3", title: "Task C", kanbanColumn: "backlog" }),
      ],
    },
  ];

  it("renders single header row with Task, Status, Priority, Assignee", () => {
    const onTaskSelect = vi.fn();
    render(<EpicTaskTable swimlanes={mockSwimlanes} onTaskSelect={onTaskSelect} />);

    expect(screen.getByRole("columnheader", { name: "Task" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Priority" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Assignee" })).toBeInTheDocument();
  });

  it("renders epic header row with title and progress", () => {
    const onTaskSelect = vi.fn();
    render(<EpicTaskTable swimlanes={mockSwimlanes} onTaskSelect={onTaskSelect} />);

    expect(screen.getByText("Authentication")).toBeInTheDocument();
    expect(screen.getByText("(1/3 done)")).toBeInTheDocument();
  });

  it("renders sub-task rows under epic header", () => {
    const onTaskSelect = vi.fn();
    render(<EpicTaskTable swimlanes={mockSwimlanes} onTaskSelect={onTaskSelect} />);

    expect(screen.getByText("Task A")).toBeInTheDocument();
    expect(screen.getByText("Task B")).toBeInTheDocument();
    expect(screen.getByText("Task C")).toBeInTheDocument();
  });

  it("calls onTaskSelect when a task row is clicked", async () => {
    const user = userEvent.setup();
    const onTaskSelect = vi.fn();
    render(<EpicTaskTable swimlanes={mockSwimlanes} onTaskSelect={onTaskSelect} />);

    await user.click(screen.getByText("Task A"));

    expect(onTaskSelect).toHaveBeenCalledWith("epic-1.1");
  });

  it("renders multiple swimlanes with epic headers and sub-tasks", () => {
    const swimlanes = [
      ...mockSwimlanes,
      {
        epicId: "epic-2",
        epicTitle: "Dashboard",
        tasks: [createMockTask({ id: "epic-2.1", title: "Dashboard Task", kanbanColumn: "ready" })],
      },
    ];
    const onTaskSelect = vi.fn();
    render(<EpicTaskTable swimlanes={swimlanes} onTaskSelect={onTaskSelect} />);

    expect(screen.getByText("Authentication")).toBeInTheDocument();
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Dashboard Task")).toBeInTheDocument();
    expect(screen.getByText("(0/1 done)")).toBeInTheDocument();
  });

  it("handles swimlane with no tasks", () => {
    const swimlanes = [
      {
        epicId: "epic-empty",
        epicTitle: "Empty Epic",
        tasks: [] as ReturnType<typeof createMockTask>[],
      },
    ];
    const onTaskSelect = vi.fn();
    render(<EpicTaskTable swimlanes={swimlanes} onTaskSelect={onTaskSelect} />);

    expect(screen.getByText("Empty Epic")).toBeInTheDocument();
    expect(screen.getByText("(0/0 done)")).toBeInTheDocument();
  });

  it("shows Unblock button for blocked tasks when onUnblock is provided", async () => {
    const user = userEvent.setup();
    const onTaskSelect = vi.fn();
    const onUnblock = vi.fn();
    const swimlanes = [
      {
        epicId: "epic-1",
        epicTitle: "Auth",
        tasks: [createMockTask({ id: "epic-1.1", title: "Blocked Task", kanbanColumn: "blocked" })],
      },
    ];
    render(
      <EpicTaskTable swimlanes={swimlanes} onTaskSelect={onTaskSelect} onUnblock={onUnblock} />,
    );

    expect(screen.getByText("Blocked")).toBeInTheDocument();
    expect(screen.getByTestId("task-blocked")).toBeInTheDocument();
    const unblockBtn = screen.getByRole("button", { name: "Unblock" });
    expect(unblockBtn).toBeInTheDocument();

    await user.click(unblockBtn);
    expect(onUnblock).toHaveBeenCalledWith("epic-1.1");
  });

  it("shows assignee when present", () => {
    const swimlanes = [
      {
        epicId: "epic-1",
        epicTitle: "Auth",
        tasks: [createMockTask({ id: "t1", title: "Task 1", assignee: "agent-1" })],
      },
    ];
    const onTaskSelect = vi.fn();
    render(<EpicTaskTable swimlanes={swimlanes} onTaskSelect={onTaskSelect} />);

    expect(screen.getByText("agent-1")).toBeInTheDocument();
  });
});
