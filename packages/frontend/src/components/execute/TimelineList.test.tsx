import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TimelineList } from "./TimelineList";
import { renderWithProviders } from "../../test/test-utils";
import type { Task } from "@opensprint/shared";
import type { Plan } from "@opensprint/shared";

vi.mock("../../lib/formatting", () => ({
  formatUptime: vi.fn((startedAt: string) => `uptime:${startedAt}`),
  formatTimestamp: vi.fn((ts: string) => `relative:${ts}`),
}));

const mockUpdateTask = vi.fn();
vi.mock("../../api/client", () => ({
  api: {
    tasks: {
      updateTask: (...args: unknown[]) => mockUpdateTask(...args),
    },
  },
}));

const defaultListProps = {
  projectId: "proj-1",
  teamMembers: [
    { id: "alice", name: "Alice" },
    { id: "bob", name: "Bob" },
  ],
};

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
    source: string;
    mergeWaitingOnMain: boolean;
    mergePausedUntil: string | null;
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

const createMockPlan = (epicId: string, title: string, status: Plan["status"] = "building"): Plan =>
  ({
    metadata: {
      planId: `plan-${epicId}`,
      epicId: epicId,
      shippedAt: null,
      complexity: "medium",
    },
    content: `# ${title}\n\nOverview`,
    status,
    taskCount: 1,
    doneTaskCount: 0,
    dependencyCount: 0,
  }) as Plan;

describe("TimelineList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateTask.mockImplementation(
      (_projectId: string, taskId: string, updates: { assignee?: string | null }) =>
        Promise.resolve(createMockTask({ id: taskId, assignee: updates.assignee ?? null }) as never)
    );
  });

  it("renders section headers only for non-empty sections", () => {
    const tasks = [
      createMockTask({ id: "a", kanbanColumn: "in_progress", title: "Active Task" }),
      createMockTask({ id: "b", kanbanColumn: "done", title: "Done Task" }),
    ];
    const plans = [createMockPlan("epic-1", "Auth Epic")];

    renderWithProviders(
      <TimelineList tasks={tasks} plans={plans} onTaskSelect={vi.fn()} {...defaultListProps} />
    );

    expect(screen.getByTestId("timeline-section-active")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-section-completed")).toBeInTheDocument();
    expect(screen.queryByTestId("timeline-section-ready")).not.toBeInTheDocument();
    expect(screen.queryByTestId("timeline-section-in_line")).not.toBeInTheDocument();

    expect(screen.getByRole("heading", { name: "In Progress" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Completed" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Ready" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Up Next" })).not.toBeInTheDocument();
  });

  it("displays Ready section when ready tasks exist", () => {
    const tasks = [
      createMockTask({ id: "a", kanbanColumn: "in_progress", title: "Active Task" }),
      createMockTask({ id: "b", kanbanColumn: "ready", title: "Queued Task" }),
    ];
    const plans = [createMockPlan("epic-1", "Auth Epic")];

    renderWithProviders(
      <TimelineList tasks={tasks} plans={plans} onTaskSelect={vi.fn()} {...defaultListProps} />
    );

    expect(screen.getByRole("heading", { name: "In Progress" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ready" })).toBeInTheDocument();
    expect(screen.getByText("Queued Task")).toBeInTheDocument();
  });

  it("displays Waiting to Merge section above In Progress when waiting_to_merge tasks exist", () => {
    const tasks = [
      createMockTask({ id: "a", kanbanColumn: "in_progress", title: "Active Task" }),
      createMockTask({
        id: "w",
        kanbanColumn: "waiting_to_merge",
        title: "Merge me",
      }),
    ];
    const plans = [createMockPlan("epic-1", "Auth Epic")];

    renderWithProviders(
      <TimelineList tasks={tasks} plans={plans} onTaskSelect={vi.fn()} {...defaultListProps} />
    );

    expect(screen.getByTestId("timeline-section-waiting_to_merge")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Waiting to Merge" })).toBeInTheDocument();
    expect(screen.getByText("Merge me")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "In Progress" })).toBeInTheDocument();
    const headings = screen.getAllByRole("heading", { level: 3 });
    const waitingToMergeIdx = headings.findIndex((h) => h.textContent === "Waiting to Merge");
    const inProgressIdx = headings.findIndex((h) => h.textContent === "In Progress");
    expect(waitingToMergeIdx).toBeLessThan(inProgressIdx);

    const row = screen.getByTestId("timeline-row-w");
    const waitingBadge = row.querySelector('[title="Waiting to Merge"]');
    expect(waitingBadge).toBeTruthy();
  });

  it("waiting_to_merge row uses compact status badge treatment", () => {
    const tasks = [
      createMockTask({
        id: "w",
        kanbanColumn: "waiting_to_merge",
        title: "Merge me",
        mergeWaitingOnMain: true,
      }),
    ];
    const plans = [createMockPlan("epic-1", "Auth Epic")];

    renderWithProviders(
      <TimelineList tasks={tasks} plans={plans} onTaskSelect={vi.fn()} {...defaultListProps} />
    );

    const row = screen.getByTestId("timeline-row-w");
    expect(row.querySelector('[title="Waiting to Merge"]')).toBeTruthy();
    expect(screen.queryByText("Blocked on Main")).not.toBeInTheDocument();
    expect(screen.queryByText(/Retry eligible/i)).not.toBeInTheDocument();
  });

  it("displays Up Next section when backlog/planning tasks exist", () => {
    const tasks = [
      createMockTask({ id: "a", kanbanColumn: "in_progress", title: "Active Task" }),
      createMockTask({ id: "b", kanbanColumn: "backlog", title: "Blocked Task" }),
    ];
    const plans = [createMockPlan("epic-1", "Auth Epic")];

    renderWithProviders(
      <TimelineList tasks={tasks} plans={plans} onTaskSelect={vi.fn()} {...defaultListProps} />
    );

    expect(screen.getByRole("heading", { name: "In Progress" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Up Next" })).toBeInTheDocument();
    expect(screen.getByText("Blocked Task")).toBeInTheDocument();
  });

  it("displays Planning section above Completed when tasks belong to plans in planning status", () => {
    const tasks = [
      createMockTask({ id: "a", kanbanColumn: "done", title: "Done Task", epicId: "epic-done" }),
      createMockTask({
        id: "b",
        kanbanColumn: "ready",
        title: "Planning Plan Task",
        epicId: "epic-planning",
      }),
    ];
    const plans = [
      createMockPlan("epic-done", "Done Epic", "complete"),
      createMockPlan("epic-planning", "Planning Epic", "planning"),
    ];

    renderWithProviders(
      <TimelineList tasks={tasks} plans={plans} onTaskSelect={vi.fn()} {...defaultListProps} />
    );

    expect(screen.getByRole("heading", { name: "Planning" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Completed" })).toBeInTheDocument();
    expect(screen.getByText("Planning Plan Task")).toBeInTheDocument();
    expect(screen.getByText("Done Task")).toBeInTheDocument();
    const headings = screen.getAllByRole("heading", { level: 3 });
    const planningIdx = headings.findIndex((h) => h.textContent === "Planning");
    const completedIdx = headings.findIndex((h) => h.textContent === "Completed");
    expect(planningIdx).toBeGreaterThanOrEqual(0);
    expect(completedIdx).toBeGreaterThanOrEqual(0);
    expect(planningIdx).toBeLessThan(completedIdx);
  });

  it("rows display priority icon, title, epic name (no row status icon; section header shows status)", () => {
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

    renderWithProviders(
      <TimelineList tasks={tasks} plans={plans} onTaskSelect={vi.fn()} {...defaultListProps} />
    );

    expect(screen.getByText("Implement login")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "In Progress" })).toBeInTheDocument();
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

    renderWithProviders(
      <TimelineList tasks={tasks} plans={plans} onTaskSelect={vi.fn()} {...defaultListProps} />
    );

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

    renderWithProviders(
      <TimelineList tasks={tasks} plans={plans} onTaskSelect={vi.fn()} {...defaultListProps} />
    );

    expect(screen.getByText("Task without epic")).toBeInTheDocument();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  it("displays complexity icon when task has complexity", () => {
    const tasks = [
      createMockTask({
        id: "task-1",
        title: "Complex task",
        kanbanColumn: "in_progress",
        complexity: 7,
      }),
    ];
    const plans = [createMockPlan("epic-1", "Auth")];

    renderWithProviders(
      <TimelineList tasks={tasks} plans={plans} onTaskSelect={vi.fn()} {...defaultListProps} />
    );

    expect(screen.getByRole("img", { name: "Complex complexity" })).toBeInTheDocument();
  });

  it("shows Self-improvement badge for tasks with source self-improvement", () => {
    const tasks = [
      createMockTask({
        id: "task-1",
        title: "Improve tests",
        kanbanColumn: "ready",
        source: "self-improvement",
      }),
      createMockTask({ id: "task-2", title: "Regular task", kanbanColumn: "ready" }),
    ];
    const plans = [createMockPlan("epic-1", "Auth")];

    renderWithProviders(
      <TimelineList tasks={tasks} plans={plans} onTaskSelect={vi.fn()} {...defaultListProps} />
    );

    const badges = screen.getAllByTestId("task-badge-self-improvement");
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent("Self-improvement");
    expect(badges[0].className).not.toMatch(/\bbg-/);
    expect(screen.getByText("Improve tests")).toBeInTheDocument();
  });

  it("hides Self-improvement badge on small screens (same breakpoint as Epic/Plan name)", () => {
    const tasks = [
      createMockTask({
        id: "task-1",
        title: "Improve tests",
        kanbanColumn: "ready",
        source: "self-improvement",
      }),
    ];
    const plans = [createMockPlan("epic-1", "Auth Epic")];

    renderWithProviders(
      <TimelineList tasks={tasks} plans={plans} onTaskSelect={vi.fn()} {...defaultListProps} />
    );

    const badge = screen.getByTestId("task-badge-self-improvement");
    expect(badge).toHaveClass("hidden");
    expect(badge).toHaveClass("md:inline");
  });

  it("click calls onTaskSelect with correct ID", async () => {
    const user = userEvent.setup();
    const onTaskSelect = vi.fn();
    const tasks = [createMockTask({ id: "task-xyz", title: "Click me", kanbanColumn: "ready" })];
    const plans: Plan[] = [];

    renderWithProviders(
      <TimelineList tasks={tasks} plans={plans} onTaskSelect={onTaskSelect} {...defaultListProps} />
    );

    await user.click(screen.getByText("Click me"));

    expect(onTaskSelect).toHaveBeenCalledWith("task-xyz");
  });

  it("blocked row shows Retry button", async () => {
    const user = userEvent.setup();
    const onUnblock = vi.fn();
    const tasks = [
      createMockTask({ id: "blocked-1", title: "Blocked task", kanbanColumn: "blocked" }),
    ];
    const plans: Plan[] = [];

    renderWithProviders(
      <TimelineList
        tasks={tasks}
        plans={plans}
        onTaskSelect={vi.fn()}
        onUnblock={onUnblock}
        {...defaultListProps}
      />
    );

    const unblockBtn = screen.getByRole("button", { name: "Retry" });
    expect(unblockBtn).toBeInTheDocument();

    await user.click(unblockBtn);
    expect(onUnblock).toHaveBeenCalledWith("blocked-1");
  });

  it("shows Failures section at top when statusFilter is all and blocked tasks exist", () => {
    const tasks = [
      createMockTask({ id: "blocked-1", title: "Blocked task", kanbanColumn: "blocked" }),
      createMockTask({ id: "ready-1", title: "Ready task", kanbanColumn: "ready" }),
    ];
    const plans = [createMockPlan("epic-1", "Auth")];

    renderWithProviders(
      <TimelineList
        tasks={tasks}
        plans={plans}
        onTaskSelect={vi.fn()}
        statusFilter="all"
        {...defaultListProps}
      />
    );

    expect(screen.getByTestId("timeline-section-blocked")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Failures" })).toBeInTheDocument();
    expect(screen.getByText("Blocked task")).toBeInTheDocument();
    const sections = screen.getAllByRole("heading", { level: 3 });
    expect(sections[0]).toHaveTextContent("Failures");
  });

  it("hides Failures section when no blocked tasks", () => {
    const tasks = [
      createMockTask({ id: "ready-1", title: "Ready task", kanbanColumn: "ready" }),
      createMockTask({ id: "done-1", title: "Done task", kanbanColumn: "done" }),
    ];
    const plans = [createMockPlan("epic-1", "Auth")];

    renderWithProviders(
      <TimelineList
        tasks={tasks}
        plans={plans}
        onTaskSelect={vi.fn()}
        statusFilter="all"
        {...defaultListProps}
      />
    );

    expect(screen.queryByTestId("timeline-section-blocked")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Failures" })).not.toBeInTheDocument();
  });

  it("blocked tasks appear only in Failures section, not duplicated in Ready", () => {
    const tasks = [
      createMockTask({ id: "blocked-1", title: "Blocked task", kanbanColumn: "blocked" }),
      createMockTask({ id: "ready-1", title: "Ready task", kanbanColumn: "ready" }),
    ];
    const plans = [createMockPlan("epic-1", "Auth")];

    renderWithProviders(
      <TimelineList
        tasks={tasks}
        plans={plans}
        onTaskSelect={vi.fn()}
        statusFilter="all"
        {...defaultListProps}
      />
    );

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

  it("shows only failed tickets when statusFilter is blocked (Failures filter)", () => {
    const tasks = [
      createMockTask({ id: "blocked-1", title: "Blocked task", kanbanColumn: "blocked" }),
      createMockTask({ id: "blocked-2", title: "Another blocked", kanbanColumn: "blocked" }),
    ];
    const plans = [createMockPlan("epic-1", "Auth")];

    renderWithProviders(
      <TimelineList
        tasks={tasks}
        plans={plans}
        onTaskSelect={vi.fn()}
        statusFilter="blocked"
        {...defaultListProps}
      />
    );

    expect(screen.getByTestId("timeline-section-blocked")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Failures" })).toBeInTheDocument();
    expect(screen.getByText("Blocked task")).toBeInTheDocument();
    expect(screen.getByText("Another blocked")).toBeInTheDocument();
    expect(screen.getAllByTestId(/^timeline-row-/)).toHaveLength(2);
  });

  it("falls back to sectioned rendering when virtualization has no scroll element yet", () => {
    const tasks = Array.from({ length: 30 }, (_, index) =>
      createMockTask({
        id: `task-${index}`,
        title: `Task ${index}`,
        kanbanColumn: index % 2 === 0 ? "in_progress" : "ready",
      })
    );
    const plans = [createMockPlan("epic-1", "Auth")];
    const scrollRef = { current: null };

    renderWithProviders(
      <TimelineList
        tasks={tasks}
        plans={plans}
        onTaskSelect={vi.fn()}
        scrollRef={scrollRef}
        statusFilter="all"
        {...defaultListProps}
      />
    );

    expect(screen.getByTestId("timeline-list")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-row-task-0")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "In Progress" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ready" })).toBeInTheDocument();
  });

  it("empty tasks array renders nothing", () => {
    const plans = [createMockPlan("epic-1", "Auth")];

    const { container } = renderWithProviders(
      <TimelineList tasks={[]} plans={plans} onTaskSelect={vi.fn()} {...defaultListProps} />
    );

    expect(screen.queryByTestId("timeline-list")).not.toBeInTheDocument();
    expect(container.firstChild).toBeNull();
  });

  it("renders timeline-list container with data-testid", () => {
    const tasks = [createMockTask({ id: "t1", kanbanColumn: "ready" })];
    renderWithProviders(
      <TimelineList tasks={tasks} plans={[]} onTaskSelect={vi.fn()} {...defaultListProps} />
    );

    expect(screen.getByTestId("timeline-list")).toBeInTheDocument();
  });

  it("section headers are sticky so they stay visible when scrolling", () => {
    const tasks = [
      createMockTask({ id: "a", kanbanColumn: "in_progress" }),
      createMockTask({ id: "b", kanbanColumn: "done" }),
    ];
    renderWithProviders(
      <TimelineList tasks={tasks} plans={[]} onTaskSelect={vi.fn()} {...defaultListProps} />
    );

    const activeSection = screen.getByTestId("timeline-section-active");
    const completedSection = screen.getByTestId("timeline-section-completed");
    const stickyWrapper = activeSection.querySelector(".sticky");
    expect(stickyWrapper).toBeInTheDocument();
    expect(stickyWrapper).toHaveClass("top-[-0.5rem]", "sm:top-[-0.75rem]", "z-10");
    expect(completedSection.querySelector(".sticky")).toBeInTheDocument();
  });

  it("renders timeline-row-{taskId} on each row", () => {
    const tasks = [
      createMockTask({ id: "task-a", kanbanColumn: "in_progress" }),
      createMockTask({ id: "task-b", kanbanColumn: "done" }),
    ];
    renderWithProviders(
      <TimelineList tasks={tasks} plans={[]} onTaskSelect={vi.fn()} {...defaultListProps} />
    );

    expect(screen.getByTestId("timeline-row-task-a")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-row-task-b")).toBeInTheDocument();
  });

  it("when enableHumanTeammates is false shows assignee as text only (no dropdown)", () => {
    const tasks = [
      createMockTask({
        id: "task-1",
        title: "Ready task",
        kanbanColumn: "ready",
        assignee: "Frodo",
      }),
    ];
    renderWithProviders(
      <TimelineList
        tasks={tasks}
        plans={[]}
        onTaskSelect={vi.fn()}
        {...defaultListProps}
        enableHumanTeammates={false}
      />
    );
    expect(screen.getByTestId("task-row-assignee")).toHaveTextContent("Frodo");
    expect(screen.queryByTestId("assignee-dropdown-trigger")).not.toBeInTheDocument();
  });

  it("task row shows assignee; click opens dropdown; selection updates task", async () => {
    const user = userEvent.setup();
    const tasks = [
      createMockTask({
        id: "task-1",
        title: "Assign me",
        kanbanColumn: "ready",
        assignee: null,
      }),
    ];
    renderWithProviders(
      <TimelineList
        tasks={tasks}
        plans={[]}
        onTaskSelect={vi.fn()}
        {...defaultListProps}
        enableHumanTeammates={true}
      />
    );

    expect(screen.getByTestId("task-row-assignee")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();

    await user.click(screen.getByTestId("assignee-dropdown-trigger"));
    expect(screen.getByTestId("assignee-dropdown")).toBeInTheDocument();

    await user.click(screen.getByTestId("assignee-option-alice"));

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith("proj-1", "task-1", {
        assignee: "Alice",
      });
    });
  });

  it("does not show assignee dropdown trigger for in-progress task (assignee locked)", () => {
    const tasks = [
      createMockTask({
        id: "task-1",
        title: "In progress",
        kanbanColumn: "in_progress",
        assignee: "Frodo",
      }),
    ];
    renderWithProviders(
      <TimelineList
        tasks={tasks}
        plans={[]}
        onTaskSelect={vi.fn()}
        {...defaultListProps}
        enableHumanTeammates={true}
      />
    );

    expect(screen.getByTestId("task-row-assignee")).toBeInTheDocument();
    expect(screen.getByText("Frodo")).toBeInTheDocument();
    expect(screen.queryByTestId("assignee-dropdown-trigger")).not.toBeInTheDocument();
  });
});
