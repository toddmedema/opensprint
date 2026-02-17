import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EpicCard } from "./EpicCard";
import type { Plan, Task } from "@opensprint/shared";

const basePlan: Plan = {
  metadata: {
    planId: "auth-feature",
    beadEpicId: "epic-1",
    gateTaskId: "epic-1.0",
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
  it("renders plan title and status", () => {
    const onSelect = vi.fn();
    render(
      <EpicCard
        plan={basePlan}
        tasks={[]}
        shippingPlanId={null}
        reshippingPlanId={null}
        onSelect={onSelect}
        onShip={vi.fn()}
        onReship={vi.fn()}
      />,
    );

    expect(screen.getByText("auth feature")).toBeInTheDocument();
    expect(screen.getByText("building")).toBeInTheDocument();
  });

  it("renders progress bar with correct completion", () => {
    render(
      <EpicCard
        plan={basePlan}
        tasks={[]}
        shippingPlanId={null}
        reshippingPlanId={null}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onReship={vi.fn()}
      />,
    );

    const progressbar = screen.getByRole("progressbar", {
      name: "1 of 3 tasks done",
    });
    expect(progressbar).toBeInTheDocument();
    expect(progressbar).toHaveAttribute("aria-valuenow", "1");
    expect(progressbar).toHaveAttribute("aria-valuemax", "3");
  });

  it("renders done count text", () => {
    render(
      <EpicCard
        plan={basePlan}
        tasks={[]}
        shippingPlanId={null}
        reshippingPlanId={null}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onReship={vi.fn()}
      />,
    );

    expect(screen.getByText("1/3 done")).toBeInTheDocument();
  });

  it("renders nested subtasks with status indicators", () => {
    render(
      <EpicCard
        plan={basePlan}
        tasks={tasks}
        shippingPlanId={null}
        reshippingPlanId={null}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onReship={vi.fn()}
      />,
    );

    expect(screen.getByText("Implement login")).toBeInTheDocument();
    expect(screen.getByText("Implement logout")).toBeInTheDocument();
    expect(screen.getByText("Add session timeout")).toBeInTheDocument();
  });

  it("calls onSelect when card is clicked", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <EpicCard
        plan={basePlan}
        tasks={[]}
        shippingPlanId={null}
        reshippingPlanId={null}
        onSelect={onSelect}
        onShip={vi.fn()}
        onReship={vi.fn()}
      />,
    );

    await user.click(screen.getByText("auth feature"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("shows Build It! button when plan status is planning", () => {
    const plan: Plan = { ...basePlan, status: "planning" };
    render(
      <EpicCard
        plan={plan}
        tasks={[]}
        shippingPlanId={null}
        reshippingPlanId={null}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onReship={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /build it!/i })).toBeInTheDocument();
  });

  it("calls onShip when Build It! is clicked", async () => {
    const onShip = vi.fn();
    const user = userEvent.setup();
    const plan: Plan = { ...basePlan, status: "planning" };
    render(
      <EpicCard
        plan={plan}
        tasks={[]}
        shippingPlanId={null}
        reshippingPlanId={null}
        onSelect={vi.fn()}
        onShip={onShip}
        onReship={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /build it!/i }));
    expect(onShip).toHaveBeenCalledTimes(1);
  });

  it("shows Rebuild button when plan is complete and modified after ship", () => {
    const plan: Plan = {
      ...basePlan,
      status: "done",
      doneTaskCount: 3,
      metadata: {
        ...basePlan.metadata,
        shippedAt: "2026-02-16T08:00:00.000Z",
      },
      lastModified: "2026-02-16T10:00:00.000Z",
    };
    render(
      <EpicCard
        plan={plan}
        tasks={[]}
        shippingPlanId={null}
        reshippingPlanId={null}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onReship={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /rebuild/i })).toBeInTheDocument();
  });

  it("calls onReship when Rebuild is clicked", async () => {
    const onReship = vi.fn();
    const user = userEvent.setup();
    const plan: Plan = {
      ...basePlan,
      status: "done",
      doneTaskCount: 3,
      metadata: {
        ...basePlan.metadata,
        shippedAt: "2026-02-16T08:00:00.000Z",
      },
      lastModified: "2026-02-16T10:00:00.000Z",
    };
    render(
      <EpicCard
        plan={plan}
        tasks={[]}
        shippingPlanId={null}
        reshippingPlanId={null}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onReship={onReship}
      />,
    );

    await user.click(screen.getByRole("button", { name: /rebuild/i }));
    expect(onReship).toHaveBeenCalledTimes(1);
  });

  it("handles zero task count without error", () => {
    const plan: Plan = { ...basePlan, taskCount: 0, doneTaskCount: 0 };
    render(
      <EpicCard
        plan={plan}
        tasks={[]}
        shippingPlanId={null}
        reshippingPlanId={null}
        onSelect={vi.fn()}
        onShip={vi.fn()}
        onReship={vi.fn()}
      />,
    );

    expect(screen.getByText("auth feature")).toBeInTheDocument();
    expect(screen.getByText("0/0 done")).toBeInTheDocument();
  });
});
