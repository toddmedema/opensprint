import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TimelineList } from "./TimelineList";
import type { Task } from "@opensprint/shared";
import type { Plan } from "@opensprint/shared";

vi.mock("../../lib/formatting", () => ({
  formatUptime: vi.fn((startedAt: string) => `uptime:${startedAt}`),
  formatTimestamp: vi.fn((ts: string) => `relative:${ts}`),
}));

const createMockTask = (
  overrides: Partial<{
    id: string;
    title: string;
    kanbanColumn: Task["kanbanColumn"];
    priority: number;
    assignee: string | null;
    epicId: string | null;
    updatedAt: string;
    createdAt: string;
    complexity: Task["complexity"];
  }> = {}
): Task =>
  ({
    id: "task-1",
    title: "Task",
    description: "",
    type: "task",
    status: "open",
    priority: 1,
    assignee: null,
    labels: [],
    dependencies: [],
    epicId: "epic-1",
    kanbanColumn: "in_progress",
    createdAt: "2024-01-01T12:00:00Z",
    updatedAt: "2024-01-02T12:00:00Z",
    ...overrides,
  }) as Task;

const createMockPlan = (epicId: string, title: string): Plan =>
  ({
    metadata: {
      planId: `plan-${epicId}`,
      epicId: epicId,
      shippedAt: null,
      complexity: "medium",
    },
    content: `# ${title}\n\nOverview`,
    status: "building",
    taskCount: 1,
    doneTaskCount: 0,
    dependencyCount: 0,
  }) as Plan;

describe("TimelineList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders section headers only for non-empty sections", () => {
    const tasks = [
      createMockTask({ id: "a", kanbanColumn: "in_progress", title: "Active Task" }),
      createMockTask({ id: "b", kanbanColumn: "done", title: "Done Task" }),
    ];
    const plans = [createMockPlan("epic-1", "Auth Epic")];

    render(<TimelineList tasks={tasks} plans={plans} onTaskSelect={vi.fn()} />);

    expect(screen.getByTestId("timeline-section-active")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-section-completed")).toBeInTheDocument();
    expect(screen.queryByTestId("timeline-section-ready")).not.toBeInTheDocument();
    expect(screen.queryByTestId("timeline-section-in_line")).not.toBeInTheDocument();

    expect(screen.getByRole("heading", { name: "In Progress" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Completed" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Ready" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "In Line" })).not.toBeInTheDocument();
  });

  it("displays Ready section when ready tasks exist", () => {
    const tasks = [
      createMockTask({ id: "a", kanbanColumn: "in_progress", title: "Active Task" }),
      createMockTask({ id: "b", kanbanColumn: "ready", title: "Queued Task" }),
    ];
    const plans = [createMockPlan("epic-1", "Auth Epic")];

    render(<TimelineList tasks={tasks} plans={plans} onTaskSelect={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "In Progress" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ready" })).toBeInTheDocument();
    expect(screen.getByText("Queued Task")).toBeInTheDocument();
  });

  it("displays In Line section when backlog/planning tasks exist", () => {
    const tasks = [
      createMockTask({ id: "a", kanbanColumn: "in_progress", title: "Active Task" }),
      createMockTask({ id: "b", kanbanColumn: "backlog", title: "Blocked Task" }),
    ];
    const plans = [createMockPlan("epic-1", "Auth Epic")];

    render(<TimelineList tasks={tasks} plans={plans} onTaskSelect={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "In Progress" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "In Line" })).toBeInTheDocument();
    expect(screen.getByText("Blocked Task")).toBeInTheDocument();
  });

  it("rows display correct status badge, priority icon, title, epic name", () => {
    const tasks = [
      createMockTask({
        id: "task-1",
        title: "Implement login",
        kanbanColumn: "in_progress",
        priority: 0,
        epicId: "epic-1",
      }),
    ];
    const plans = [createMockPlan("epic-1", "Authentication")];

    render(<TimelineList tasks={tasks} plans={plans} onTaskSelect={vi.fn()} />);

    expect(screen.getByText("Implement login")).toBeInTheDocument();
    expect(screen.getByTitle("In Progress")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /critical/i })).toBeInTheDocument();
    expect(screen.getByText("Authentication")).toBeInTheDocument();
  });

  it("tasks with epic show epic name in epic column", () => {
    const tasks = [
      createMockTask({
        id: "task-1",
        title: "Task with epic",
        kanbanColumn: "ready",
        epicId: "epic-1",
      }),
    ];
    const plans = [createMockPlan("epic-1", "Auth Epic")];

    render(<TimelineList tasks={tasks} plans={plans} onTaskSelect={vi.fn()} />);

    expect(screen.getByText("Auth Epic")).toBeInTheDocument();
  });

  it("tasks without epic show no placeholder in epic column (blank)", () => {
    const tasks = [
      createMockTask({
        id: "task-1",
        title: "Task without epic",
        kanbanColumn: "ready",
        epicId: null,
        assignee: "dev",
      }),
    ];
    const plans: Plan[] = [];

    render(<TimelineList tasks={tasks} plans={plans} onTaskSelect={vi.fn()} />);

    expect(screen.getByText("Task without epic")).toBeInTheDocument();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  it("displays complexity icon when task has complexity", () => {
    const tasks = [
      createMockTask({
        id: "task-1",
        title: "Complex task",
        kanbanColumn: "in_progress",
        complexity: "complex",
      }),
    ];
    const plans = [createMockPlan("epic-1", "Auth")];

    render(<TimelineList tasks={tasks} plans={plans} onTaskSelect={vi.fn()} />);

    expect(screen.getByRole("img", { name: "Complex complexity" })).toBeInTheDocument();
  });

  it("click calls onTaskSelect with correct ID", async () => {
    const user = userEvent.setup();
    const onTaskSelect = vi.fn();
    const tasks = [createMockTask({ id: "task-xyz", title: "Click me", kanbanColumn: "ready" })];
    const plans: Plan[] = [];

    render(<TimelineList tasks={tasks} plans={plans} onTaskSelect={onTaskSelect} />);

    await user.click(screen.getByText("Click me"));

    expect(onTaskSelect).toHaveBeenCalledWith("task-xyz");
  });

  it("blocked row shows Unblock button", async () => {
    const user = userEvent.setup();
    const onUnblock = vi.fn();
    const tasks = [
      createMockTask({ id: "blocked-1", title: "Blocked task", kanbanColumn: "blocked" }),
    ];
    const plans: Plan[] = [];

    render(
      <TimelineList tasks={tasks} plans={plans} onTaskSelect={vi.fn()} onUnblock={onUnblock} />
    );

    const unblockBtn = screen.getByRole("button", { name: "Unblock" });
    expect(unblockBtn).toBeInTheDocument();

    await user.click(unblockBtn);
    expect(onUnblock).toHaveBeenCalledWith("blocked-1");
  });

  it("shows Blocked section at top when statusFilter is all and blocked tasks exist", () => {
    const tasks = [
      createMockTask({ id: "blocked-1", title: "Blocked task", kanbanColumn: "blocked" }),
      createMockTask({ id: "ready-1", title: "Ready task", kanbanColumn: "ready" }),
    ];
    const plans = [createMockPlan("epic-1", "Auth")];

    render(<TimelineList tasks={tasks} plans={plans} onTaskSelect={vi.fn()} statusFilter="all" />);

    expect(screen.getByTestId("timeline-section-blocked")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Blocked" })).toBeInTheDocument();
    expect(screen.getByText("Blocked task")).toBeInTheDocument();
    const sections = screen.getAllByRole("heading", { level: 3 });
    expect(sections[0]).toHaveTextContent("Blocked");
  });

  it("hides Blocked section when no blocked tasks", () => {
    const tasks = [
      createMockTask({ id: "ready-1", title: "Ready task", kanbanColumn: "ready" }),
      createMockTask({ id: "done-1", title: "Done task", kanbanColumn: "done" }),
    ];
    const plans = [createMockPlan("epic-1", "Auth")];

    render(<TimelineList tasks={tasks} plans={plans} onTaskSelect={vi.fn()} statusFilter="all" />);

    expect(screen.queryByTestId("timeline-section-blocked")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Blocked" })).not.toBeInTheDocument();
  });

  it("blocked tasks appear only in Blocked section, not duplicated in Ready", () => {
    const tasks = [
      createMockTask({ id: "blocked-1", title: "Blocked task", kanbanColumn: "blocked" }),
      createMockTask({ id: "ready-1", title: "Ready task", kanbanColumn: "ready" }),
    ];
    const plans = [createMockPlan("epic-1", "Auth")];

    render(<TimelineList tasks={tasks} plans={plans} onTaskSelect={vi.fn()} statusFilter="all" />);

    expect(screen.getByTestId("timeline-section-blocked")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-section-ready")).toBeInTheDocument();
    expect(screen.getByText("Blocked task")).toBeInTheDocument();
    expect(screen.getByText("Ready task")).toBeInTheDocument();

    const blockedSection = screen.getByTestId("timeline-section-blocked");
    const readySection = screen.getByTestId("timeline-section-ready");
    expect(blockedSection).toContainElement(screen.getByTestId("timeline-row-blocked-1"));
    expect(readySection).not.toContainElement(screen.getByTestId("timeline-row-blocked-1"));
    expect(readySection).toContainElement(screen.getByTestId("timeline-row-ready-1"));
  });

  it("empty tasks array renders nothing", () => {
    const plans = [createMockPlan("epic-1", "Auth")];

    const { container } = render(<TimelineList tasks={[]} plans={plans} onTaskSelect={vi.fn()} />);

    expect(screen.queryByTestId("timeline-list")).not.toBeInTheDocument();
    expect(container.firstChild).toBeNull();
  });

  it("renders timeline-list container with data-testid", () => {
    const tasks = [createMockTask({ id: "t1", kanbanColumn: "ready" })];
    render(<TimelineList tasks={tasks} plans={[]} onTaskSelect={vi.fn()} />);

    expect(screen.getByTestId("timeline-list")).toBeInTheDocument();
  });

  it("renders timeline-row-{taskId} on each row", () => {
    const tasks = [
      createMockTask({ id: "task-a", kanbanColumn: "in_progress" }),
      createMockTask({ id: "task-b", kanbanColumn: "done" }),
    ];
    render(<TimelineList tasks={tasks} plans={[]} onTaskSelect={vi.fn()} />);

    expect(screen.getByTestId("timeline-row-task-a")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-row-task-b")).toBeInTheDocument();
  });
});
