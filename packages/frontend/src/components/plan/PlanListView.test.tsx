// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { PlanListView } from "./PlanListView";
import type { Plan } from "@opensprint/shared";

function makePlan(planId: string, status: Plan["status"], taskCount = 0): Plan {
  return {
    metadata: {
      planId,
      epicId: `epic-${planId}`,
      shippedAt: null,
      complexity: "medium",
    },
    content: "",
    status,
    taskCount,
    doneTaskCount: 0,
    dependencyCount: 0,
  };
}

describe("PlanListView", () => {
  it("groups plans by status with section headers and renders row actions on the right", () => {
    const plans: Plan[] = [
      makePlan("done-feature", "complete"),
      makePlan("planning-feature", "planning", 0),
      makePlan("in-review-feature", "in_review", 2),
      makePlan("building-feature", "building", 1),
    ];
    render(
      <PlanListView
        plans={plans}
        selectedPlanId={null}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        executeError={null}
        onSelectPlan={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
        onClearError={vi.fn()}
      />
    );

    expect(screen.getByTestId("plan-list-view")).toBeInTheDocument();
    expect(screen.getByTestId("plan-list-section-planning")).toBeInTheDocument();
    expect(screen.getByTestId("plan-list-section-building")).toBeInTheDocument();
    expect(screen.getByTestId("plan-list-section-in_review")).toBeInTheDocument();
    expect(screen.getByTestId("plan-list-section-complete")).toBeInTheDocument();

    expect(screen.getByText("Planning")).toBeInTheDocument();
    expect(screen.getByText("Building")).toBeInTheDocument();
    expect(screen.getByText("In review")).toBeInTheDocument();
    expect(screen.getByText("Complete")).toBeInTheDocument();

    expect(screen.getByText("Planning Feature")).toBeInTheDocument();
    expect(screen.getByText("Building Feature")).toBeInTheDocument();
    expect(screen.getByText("In Review Feature")).toBeInTheDocument();
    expect(screen.getByText("Done Feature")).toBeInTheDocument();

    const listView = screen.getByTestId("plan-list-view");
    expect(within(listView).getAllByTestId(/^plan-list-row-/)).toHaveLength(4);
    expect(within(listView).getAllByTestId("plan-list-edit")).toHaveLength(4);
  });

  it("shows Generate tasks for planning plan with zero tasks", () => {
    const plans = [makePlan("planning-feature", "planning", 0)];
    render(
      <PlanListView
        plans={plans}
        selectedPlanId={null}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        executeError={null}
        onSelectPlan={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
        onClearError={vi.fn()}
      />
    );
    expect(screen.getByTestId("plan-list-generate-tasks")).toBeInTheDocument();
  });

  it("shows Approve and Review for in_review plan when onMarkComplete and onGoToEvaluate provided", () => {
    const plans = [makePlan("in-review-feature", "in_review", 2)];
    render(
      <PlanListView
        plans={plans}
        selectedPlanId={null}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        executeError={null}
        onSelectPlan={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
        onClearError={vi.fn()}
        onMarkComplete={vi.fn()}
        onGoToEvaluate={vi.fn()}
      />
    );
    expect(screen.getByTestId("plan-list-mark-complete")).toHaveTextContent(/Approve/);
    expect(screen.getByTestId("plan-list-go-to-evaluate")).toHaveTextContent(/Review/);
  });
});
