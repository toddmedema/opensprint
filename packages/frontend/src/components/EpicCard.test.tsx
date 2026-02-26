import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { EpicCard } from "./EpicCard";
import executeReducer from "../store/slices/executeSlice";
import type { Plan, Task } from "@opensprint/shared";

function renderWithStore(ui: React.ReactElement, preloadedState?: { execute?: { tasks: Task[] } }) {
  const store = configureStore({
    reducer: { execute: executeReducer },
    preloadedState: preloadedState as never,
  });
  return render(<Provider store={store}>{ui}</Provider>);
}

const basePlan: Plan = {
  metadata: {
    planId: "auth-feature",
    epicId: "epic-1",
    shippedAt: null,
    complexity: "medium",
  },
  content: "# Auth Feature\n\nContent.",
  status: "building",
  taskCount: 3,
  doneTaskCount: 1,
  dependencyCount: 0,
};

const tasks: Task[] = [
  {
    id: "epic-1.1",
    title: "Implement login",
    description: "",
    type: "task",
    status: "closed",
    priority: 0,
    assignee: null,
    labels: [],
    dependencies: [],
    epicId: "epic-1",
    kanbanColumn: "done",
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "epic-1.2",
    title: "Implement logout",
    description: "",
    type: "task",
    status: "open",
    priority: 1,
    assignee: null,
    labels: [],
    dependencies: [],
    epicId: "epic-1",
    kanbanColumn: "ready",
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "epic-1.3",
    title: "Add session timeout",
    description: "",
    type: "task",
    status: "open",
    priority: 2,
    assignee: null,
    labels: [],
    dependencies: [],
    epicId: "epic-1",
    kanbanColumn: "backlog",
    createdAt: "",
    updatedAt: "",
  },
];

describe("EpicCard", () => {
  it("shows full-card loading overlay when isOptimistic", () => {
    renderWithStore(
      <EpicCard
        plan={basePlan}
        tasks={[]}
        isOptimistic
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
      />
    );

    const overlay = document.querySelector('[aria-busy="true"][aria-label="Generating plan"]');
    expect(overlay).toBeInTheDocument();
  });

  it("hides Plan Tasks button when isOptimistic (planning, zero tasks)", () => {
    const planningPlan = { ...basePlan, status: "planning" as const, taskCount: 0, doneTaskCount: 0 };
    renderWithStore(
      <EpicCard
        plan={planningPlan}
        tasks={[]}
        isOptimistic
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
      />
    );

    expect(screen.queryByText("Plan Tasks")).not.toBeInTheDocument();
    expect(screen.getByTestId("plan-tasks-loading")).toBeInTheDocument();
  });

  it("renders plan title and status", () => {
    const onSelect = vi.fn();
    renderWithStore(
      <EpicCard
        plan={basePlan}
        tasks={[]}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        onSelect={onSelect}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
      />
    );

    expect(screen.getByText("Auth Feature")).toBeInTheDocument();
    expect(screen.getByText("building")).toBeInTheDocument();
  });

  it("renders progress bar with correct completion", () => {
    renderWithStore(
      <EpicCard
        plan={basePlan}
        tasks={[]}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
      />
    );

    const progressbar = screen.getByRole("progressbar", {
      name: "1 of 3 tasks done",
    });
    expect(progressbar).toBeInTheDocument();
    expect(progressbar).toHaveAttribute("aria-valuenow", "1");
    expect(progressbar).toHaveAttribute("aria-valuemax", "3");
  });

  it("renders done count text", () => {
    renderWithStore(
      <EpicCard
        plan={basePlan}
        tasks={[]}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
      />
    );

    expect(screen.getByText(/1\/3/)).toBeInTheDocument();
  });

  it("renders nested subtasks with status indicators", () => {
    renderWithStore(
      <EpicCard
        plan={basePlan}
        tasks={tasks}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
      />
    );

    expect(screen.getByText("Implement login")).toBeInTheDocument();
    expect(screen.getByText("Implement logout")).toBeInTheDocument();
    expect(screen.getByText("Add session timeout")).toBeInTheDocument();
  });

  it("calls onSelect when card is clicked", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    renderWithStore(
      <EpicCard
        plan={basePlan}
        tasks={[]}
        executingPlanId={null}
        reExecutingPlanId={null}
        onSelect={onSelect}
        onShip={vi.fn()}
        onReship={vi.fn()}
      />
    );

    await user.click(screen.getByText("Auth Feature"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("shows Plan Tasks button when plan has zero tasks", () => {
    const plan: Plan = { ...basePlan, status: "planning", taskCount: 0, doneTaskCount: 0 };
    renderWithStore(
      <EpicCard
        plan={plan}
        tasks={[]}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
      />
    );

    expect(screen.getByTestId("plan-tasks-button")).toBeInTheDocument();
    expect(screen.getByText("Plan Tasks")).toBeInTheDocument();
    expect(screen.queryByTestId("execute-button")).not.toBeInTheDocument();
  });

  it("shows Plan Tasks when plan has zero implementation tasks", () => {
    const plan: Plan = {
      ...basePlan,
      status: "planning",
      taskCount: 0,
      doneTaskCount: 0,
    };
    renderWithStore(
      <EpicCard
        plan={plan}
        tasks={[]}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
      />
    );

    expect(screen.getByTestId("plan-tasks-button")).toBeInTheDocument();
    expect(screen.getByText("Plan Tasks")).toBeInTheDocument();
    expect(screen.queryByTestId("execute-button")).not.toBeInTheDocument();
  });

  it("calls onPlanTasks when Plan Tasks is clicked", async () => {
    const onPlanTasks = vi.fn();
    const user = userEvent.setup();
    const plan: Plan = { ...basePlan, status: "planning", taskCount: 0, doneTaskCount: 0 };
    renderWithStore(
      <EpicCard
        plan={plan}
        tasks={[]}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={onPlanTasks}
        onReship={vi.fn()}
      />
    );

    await user.click(screen.getByText("Plan Tasks"));
    expect(onPlanTasks).toHaveBeenCalledTimes(1);
  });

  it("hides Plan Tasks button and shows only loading spinner during plan generation", () => {
    const plan: Plan = { ...basePlan, status: "planning", taskCount: 0, doneTaskCount: 0 };
    renderWithStore(
      <EpicCard
        plan={plan}
        tasks={[]}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[plan.metadata.planId]}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
      />
    );

    expect(screen.queryByTestId("plan-tasks-button")).not.toBeInTheDocument();
    expect(screen.queryByText("Plan Tasks")).not.toBeInTheDocument();
    expect(screen.getByTestId("plan-tasks-loading")).toBeInTheDocument();
  });

  it("hides Plan Tasks and Execute when plan status is building", () => {
    const plan: Plan = { ...basePlan, status: "building", taskCount: 2, doneTaskCount: 0 };
    renderWithStore(
      <EpicCard
        plan={plan}
        tasks={tasks}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
      />
    );

    expect(screen.queryByTestId("plan-tasks-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("execute-button")).not.toBeInTheDocument();
  });

  it("shows Execute button when plan status is planning and has child tasks", () => {
    const plan: Plan = { ...basePlan, status: "planning", taskCount: 2 };
    renderWithStore(
      <EpicCard
        plan={plan}
        tasks={tasks}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
      />
    );

    const executeButtons = screen.getAllByRole("button", { name: /^execute$/i });
    expect(executeButtons.find((b) => b.tagName === "BUTTON")).toBeInTheDocument();
  });

  it("calls onShip when Execute is clicked", async () => {
    const onShip = vi.fn();
    const user = userEvent.setup();
    const plan: Plan = { ...basePlan, status: "planning", taskCount: 2 };
    renderWithStore(
      <EpicCard
        plan={plan}
        tasks={tasks}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        onSelect={vi.fn()}
        onShip={onShip}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
      />
    );

    const shipButtons = screen.getAllByRole("button", { name: /^execute$/i });
    await user.click(shipButtons.find((b) => b.tagName === "BUTTON")!);
    expect(onShip).toHaveBeenCalledTimes(1);
  });

  it("shows Re-execute button when plan is complete and modified after ship", () => {
    const plan: Plan = {
      ...basePlan,
      status: "complete",
      doneTaskCount: 3,
      metadata: {
        ...basePlan.metadata,
        shippedAt: "2026-02-16T08:00:00.000Z",
      },
      lastModified: "2026-02-16T10:00:00.000Z",
    };
    renderWithStore(
      <EpicCard
        plan={plan}
        tasks={[]}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
      />
    );

    const reexecButtons = screen.getAllByRole("button", { name: /re-execute/i });
    expect(reexecButtons.find((b) => b.tagName === "BUTTON")).toBeInTheDocument();
  });

  it("calls onReship when Re-execute is clicked", async () => {
    const onReship = vi.fn();
    const user = userEvent.setup();
    const plan: Plan = {
      ...basePlan,
      status: "complete",
      doneTaskCount: 3,
      metadata: {
        ...basePlan.metadata,
        shippedAt: "2026-02-16T08:00:00.000Z",
      },
      lastModified: "2026-02-16T10:00:00.000Z",
    };
    renderWithStore(
      <EpicCard
        plan={plan}
        tasks={[]}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={onReship}
      />
    );

    const reshipButtons = screen.getAllByRole("button", { name: /re-execute/i });
    await user.click(reshipButtons.find((b) => b.tagName === "BUTTON")!);
    expect(onReship).toHaveBeenCalledTimes(1);
  });

  it("renders Progress label and percentage when tasks exist", () => {
    renderWithStore(
      <EpicCard
        plan={basePlan}
        tasks={[]}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
      />
    );

    expect(screen.getByText("Progress")).toBeInTheDocument();
    expect(screen.getByText(/33%/)).toBeInTheDocument();
    expect(screen.getByText("medium complexity")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "medium complexity" })).toBeInTheDocument();
  });

  it("formats plan title with capitalized words", () => {
    const plan: Plan = {
      ...basePlan,
      metadata: { ...basePlan.metadata, planId: "my-cool-feature" },
    };
    renderWithStore(
      <EpicCard
        plan={plan}
        tasks={[]}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
      />
    );

    expect(screen.getByText("My Cool Feature")).toBeInTheDocument();
  });

  it("handles zero task count without error and hides progress", () => {
    const plan: Plan = { ...basePlan, taskCount: 0, doneTaskCount: 0 };
    renderWithStore(
      <EpicCard
        plan={plan}
        tasks={[]}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
      />
    );

    expect(screen.getByText("Auth Feature")).toBeInTheDocument();
    expect(screen.queryByText("Progress")).not.toBeInTheDocument();
    expect(screen.queryByText(/0\/0/)).not.toBeInTheDocument();
  });

  it("shows spinner inside Execute button when plan is executing", () => {
    const plan: Plan = { ...basePlan, status: "planning", taskCount: 2 };
    renderWithStore(
      <EpicCard
        plan={plan}
        tasks={tasks}
        executingPlanId="auth-feature"
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
      />
    );

    expect(screen.getByTestId("execute-spinner")).toBeInTheDocument();
    expect(screen.getByText("Executing…")).toBeInTheDocument();
  });

  it("does not show spinner when a different plan is executing", () => {
    const plan: Plan = { ...basePlan, status: "planning", taskCount: 2 };
    renderWithStore(
      <EpicCard
        plan={plan}
        tasks={tasks}
        executingPlanId="other-plan"
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
      />
    );

    expect(screen.queryByTestId("execute-spinner")).not.toBeInTheDocument();
    expect(screen.getByText("Execute")).toBeInTheDocument();
  });

  it("disables Execute button when any plan is executing", () => {
    const plan: Plan = { ...basePlan, status: "planning", taskCount: 2 };
    renderWithStore(
      <EpicCard
        plan={plan}
        tasks={tasks}
        executingPlanId="other-plan"
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
      />
    );

    const btn = screen.getByTestId("execute-button");
    expect(btn).toBeDisabled();
  });

  it("shows inline error when executeError matches this plan", () => {
    const plan: Plan = { ...basePlan, status: "planning", taskCount: 2 };
    renderWithStore(
      <EpicCard
        plan={plan}
        tasks={tasks}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        executeError={{ planId: "auth-feature", message: "Network timeout" }}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
        onClearError={vi.fn()}
      />
    );

    expect(screen.getByTestId("execute-error-inline")).toBeInTheDocument();
    expect(screen.getByText("Network timeout")).toBeInTheDocument();
  });

  it("does not show inline error when executeError is for a different plan", () => {
    const plan: Plan = { ...basePlan, status: "planning", taskCount: 2 };
    renderWithStore(
      <EpicCard
        plan={plan}
        tasks={tasks}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        executeError={{ planId: "other-plan", message: "Network timeout" }}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
        onClearError={vi.fn()}
      />
    );

    expect(screen.queryByTestId("execute-error-inline")).not.toBeInTheDocument();
  });

  it("calls onClearError when inline error dismiss button is clicked", async () => {
    const onClearError = vi.fn();
    const user = userEvent.setup();
    const plan: Plan = { ...basePlan, status: "planning", taskCount: 2 };
    renderWithStore(
      <EpicCard
        plan={plan}
        tasks={tasks}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        executeError={{ planId: "auth-feature", message: "Network timeout" }}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
        onClearError={onClearError}
      />
    );

    const dismissBtn = screen.getByRole("button", { name: /dismiss execute error/i });
    await user.click(dismissBtn);
    expect(onClearError).toHaveBeenCalledTimes(1);
  });

  it("does not show inline error when executeError is null", () => {
    const plan: Plan = { ...basePlan, status: "planning", taskCount: 2 };
    renderWithStore(
      <EpicCard
        plan={plan}
        tasks={tasks}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        executeError={null}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
      />
    );

    expect(screen.queryByTestId("execute-error-inline")).not.toBeInTheDocument();
  });

  it("Execute button is enabled when no plan is executing and no error", () => {
    const plan: Plan = { ...basePlan, status: "planning", taskCount: 2 };
    renderWithStore(
      <EpicCard
        plan={plan}
        tasks={tasks}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
      />
    );

    const btn = screen.getByTestId("execute-button");
    expect(btn).not.toBeDisabled();
  });

  it("shows Plan Tasks button when plan has no tasks", () => {
    const plan: Plan = {
      ...basePlan,
      status: "planning",
      taskCount: 0,
      doneTaskCount: 0,
      metadata: { ...basePlan.metadata, epicId: "" },
    };
    const onGenerateTasks = vi.fn();
    renderWithStore(
      <EpicCard
        plan={plan}
        tasks={[]}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={onGenerateTasks}
        onReship={vi.fn()}
      />
    );

    expect(screen.getByTestId("plan-tasks-button")).toBeInTheDocument();
    expect(screen.getByText(/No tasks yet. Generate tasks from this plan/)).toBeInTheDocument();
    expect(screen.queryByTestId("execute-button")).not.toBeInTheDocument();
  });

  it("does not call onShip when plan has no tasks (Plan Tasks button only)", () => {
    const plan: Plan = {
      ...basePlan,
      status: "planning",
      taskCount: 0,
      doneTaskCount: 0,
    };
    const onShip = vi.fn();
    const onGenerateTasks = vi.fn();
    renderWithStore(
      <EpicCard
        plan={plan}
        tasks={[]}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        onSelect={vi.fn()}
        onShip={onShip}
        onPlanTasks={onGenerateTasks}
        onReship={vi.fn()}
      />
    );

    expect(onShip).not.toHaveBeenCalled();
    expect(screen.queryByTestId("execute-button")).not.toBeInTheDocument();
    expect(screen.getByTestId("plan-tasks-button")).toBeInTheDocument();
  });

  it("shows all tasks for epic from Redux (epic-blocked: filter by epicId only)", () => {
    const plan: Plan = { ...basePlan, status: "planning", taskCount: 2 };
    const tasksFromStore: Task[] = tasks.slice(0, 2).map((t) => ({
      ...t,
      kanbanColumn: "planning" as const,
    }));
    renderWithStore(
      <EpicCard
        plan={plan}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
      />,
      { execute: { tasks: tasksFromStore } }
    );
    expect(screen.getByText("Implement login")).toBeInTheDocument();
    expect(screen.getByText("Implement logout")).toBeInTheDocument();
    expect(screen.getByTestId("execute-button")).toBeInTheDocument();
  });

  it("shows friendly message when executeError contains no epic", () => {
    const plan: Plan = { ...basePlan, status: "planning", taskCount: 2 };
    renderWithStore(
      <EpicCard
        plan={plan}
        tasks={[]}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        executeError={{
          planId: "auth-feature",
          message: "Plan has no epic",
        }}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
        onClearError={vi.fn()}
      />
    );

    expect(screen.getByTestId("execute-error-inline")).toBeInTheDocument();
    expect(
      screen.getByText(/Generate tasks first. Click .Plan Tasks. to create tasks from this plan/)
    ).toBeInTheDocument();
  });
});
