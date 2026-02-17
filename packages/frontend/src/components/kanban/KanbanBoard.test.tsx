import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KanbanBoard } from "./KanbanBoard";

const createMockTask = (overrides: Partial<{
  id: string;
  title: string;
  kanbanColumn: "planning" | "backlog" | "ready" | "in_progress" | "in_review" | "done" | "blocked";
}> = {}) => ({
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

describe("KanbanBoard", () => {
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

  it("renders swimlane epic title and task counts", () => {
    const onTaskSelect = vi.fn();
    render(<KanbanBoard swimlanes={mockSwimlanes} onTaskSelect={onTaskSelect} />);

    expect(screen.getByText("Authentication")).toBeInTheDocument();
    expect(screen.getByText("1/3 done")).toBeInTheDocument();
  });

  it("renders all kanban columns", () => {
    const onTaskSelect = vi.fn();
    render(<KanbanBoard swimlanes={mockSwimlanes} onTaskSelect={onTaskSelect} />);

    expect(screen.getByText("Planning")).toBeInTheDocument();
    expect(screen.getByText("Backlog")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(screen.getByText("In Review")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("renders tasks in correct columns", () => {
    const onTaskSelect = vi.fn();
    render(<KanbanBoard swimlanes={mockSwimlanes} onTaskSelect={onTaskSelect} />);

    expect(screen.getByText("Task A")).toBeInTheDocument();
    expect(screen.getByText("Task B")).toBeInTheDocument();
    expect(screen.getByText("Task C")).toBeInTheDocument();
  });

  it("calls onTaskSelect when a task card is clicked", async () => {
    const user = userEvent.setup();
    const onTaskSelect = vi.fn();
    render(<KanbanBoard swimlanes={mockSwimlanes} onTaskSelect={onTaskSelect} />);

    await user.click(screen.getByText("Task A"));

    expect(onTaskSelect).toHaveBeenCalledWith("epic-1.1");
  });

  it("has horizontal scroll container with overflow-x-auto for narrow screens", () => {
    const onTaskSelect = vi.fn();
    render(<KanbanBoard swimlanes={mockSwimlanes} onTaskSelect={onTaskSelect} />);

    const scrollContainer = screen.getByTestId("kanban-columns-scroll");
    expect(scrollContainer).toBeInTheDocument();
    expect(scrollContainer).toHaveClass("overflow-x-auto");
    expect(scrollContainer).toHaveClass("min-w-0");
  });

  it("renders multiple swimlanes", () => {
    const swimlanes = [
      ...mockSwimlanes,
      {
        epicId: "epic-2",
        epicTitle: "Dashboard",
        tasks: [createMockTask({ id: "epic-2.1", title: "Dashboard Task", kanbanColumn: "ready" })],
      },
    ];
    const onTaskSelect = vi.fn();
    render(<KanbanBoard swimlanes={swimlanes} onTaskSelect={onTaskSelect} />);

    expect(screen.getByText("Authentication")).toBeInTheDocument();
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Dashboard Task")).toBeInTheDocument();
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
    render(<KanbanBoard swimlanes={swimlanes} onTaskSelect={onTaskSelect} />);

    expect(screen.getByText("Empty Epic")).toBeInTheDocument();
    expect(screen.getByText("0/0 done")).toBeInTheDocument();
  });
});
