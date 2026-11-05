// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanListView } from "./PlanListView";
import type { Plan, PlanDependencyEdge } from "@opensprint/shared";
import { MAX_PLAN_DEPTH } from "@opensprint/shared";

function makePlan(
  planId: string,
  status: Plan["status"],
  taskCount = 0,
  hasGeneratedPlanTasksForCurrentVersion = taskCount > 0,
  opts?: { parentPlanId?: string; depth?: number; childPlanIds?: string[] }
): Plan {
  return {
    metadata: {
      planId,
      epicId: `epic-${planId}`,
      shippedAt: null,
      complexity: "medium",
      ...(opts?.parentPlanId != null ? { parentPlanId: opts.parentPlanId } : {}),
    },
    content: "",
    status,
    taskCount,
    doneTaskCount: 0,
    dependencyCount: 0,
    hasGeneratedPlanTasksForCurrentVersion,
    ...(opts?.depth != null ? { depth: opts.depth } : {}),
    ...(opts?.childPlanIds != null ? { childPlanIds: opts.childPlanIds } : {}),
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
  });

  it("shows an imported issue title and source without selecting the row when opening GitHub", async () => {
    const plan = makePlan("github-issue-123", "planning");
    plan.content = "# Preserve original issue title\n\nDetails";
    plan.metadata.githubIssue = {
      id: "123",
      number: 42,
      repository: "octocat/hello-world",
      url: "https://github.com/octocat/hello-world/issues/42",
    };
    const onSelectPlan = vi.fn();
    render(
      <PlanListView
        plans={[plan]}
        selectedPlanId={null}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={[]}
        executeError={null}
        onSelectPlan={onSelectPlan}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
        onClearError={vi.fn()}
      />
    );
    expect(screen.getByText("Preserve original issue title")).toBeInTheDocument();
    const source = screen.getByRole("link", { name: /GitHub octocat\/hello-world #42/ });
    await userEvent.setup().click(source);
    expect(onSelectPlan).not.toHaveBeenCalled();
  });

  it("marks the selected plan row for sidebar/detail context", () => {
    const plans: Plan[] = [makePlan("plan-a", "planning", 0), makePlan("plan-b", "planning", 0)];
    render(
      <PlanListView
        plans={plans}
        selectedPlanId="plan-b"
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

    const rowA = screen.getByTestId("plan-list-row-plan-a");
    const rowB = screen.getByTestId("plan-list-row-plan-b");
    expect(rowA).toHaveAttribute("data-queue-row-selected", "false");
    expect(rowB).toHaveAttribute("data-queue-row-selected", "true");
    expect(rowB).toHaveAttribute("aria-current", "true");
    expect(rowA).not.toHaveAttribute("aria-current");
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
    expect(screen.queryByTestId("plan-epic-task-cap-planning-feature")).not.toBeInTheDocument();
  });

  it("shows Generate tasks for planning plan with feedback-only tasks", () => {
    const plans = [makePlan("planning-feature", "planning", 1, false)];
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
    expect(screen.queryByTestId("plan-list-execute")).not.toBeInTheDocument();
  });

  it("shows Generating tasks while plan tasks are in flight", () => {
    const plans = [makePlan("planning-feature", "planning", 0)];
    render(
      <PlanListView
        plans={plans}
        selectedPlanId={null}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={["planning-feature"]}
        executeError={null}
        onSelectPlan={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
        onClearError={vi.fn()}
      />
    );
    expect(screen.getByText("Generating tasks...")).toBeInTheDocument();
    expect(screen.queryByTestId("plan-list-generate-tasks")).not.toBeInTheDocument();
  });

  it("exposes task-generation status to assistive tech without hiding the live region", () => {
    const plans = [makePlan("planning-feature", "planning", 0)];
    render(
      <PlanListView
        plans={plans}
        selectedPlanId={null}
        executingPlanId={null}
        reExecutingPlanId={null}
        planTasksPlanIds={["planning-feature"]}
        executeError={null}
        onSelectPlan={vi.fn()}
        onShip={vi.fn()}
        onPlanTasks={vi.fn()}
        onReship={vi.fn()}
        onClearError={vi.fn()}
      />
    );
    const liveRegion = screen.getByTestId("plan-tasks-loading");
    expect(liveRegion).toHaveAttribute("role", "status");
    expect(liveRegion).toHaveAttribute("aria-live", "polite");
    expect(liveRegion).not.toHaveAttribute("aria-hidden", "true");

    const row = screen.getByTestId("plan-list-row-planning-feature");
    const visualStatus = within(row).getByText("Generating tasks...");
    expect(visualStatus).toHaveAttribute("aria-hidden", "true");
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

  it("shows batch cap indicator for planning and non-planning rows", () => {
    const plans = [
      makePlan("planning-feature", "planning", 2, false),
      makePlan("building-feature", "building", 2),
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

    const planningRow = screen.getByTestId("plan-list-row-planning-feature");
    const buildingRow = screen.getByTestId("plan-list-row-building-feature");

    expect(
      within(planningRow).getByTestId("plan-epic-task-cap-planning-feature")
    ).toHaveTextContent("2/15");
    expect(
      within(buildingRow).getByTestId("plan-epic-task-cap-building-feature")
    ).toHaveTextContent("2/15");
  });

  it("shows Planning indicator instead of Generate tasks when planner is in-flight", () => {
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
        getPlanGenState={() => "planning"}
      />
    );
    expect(screen.getByTestId("plan-list-planning-indicator")).toBeInTheDocument();
    expect(screen.queryByTestId("plan-list-generate-tasks")).not.toBeInTheDocument();
  });

  it("shows Retry button instead of Generate tasks when planner is stale", () => {
    const plans = [makePlan("planning-feature", "planning", 0)];
    const onRetryPlan = vi.fn();
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
        getPlanGenState={() => "stale"}
        onRetryPlan={onRetryPlan}
      />
    );
    expect(screen.getByTestId("plan-list-retry")).toBeInTheDocument();
    expect(screen.queryByTestId("plan-list-generate-tasks")).not.toBeInTheDocument();
    expect(screen.queryByTestId("plan-list-planning-indicator")).not.toBeInTheDocument();
  });

  it("hides Execute button when planner is in-flight", () => {
    const plans = [makePlan("planning-feature", "planning", 0, true)];
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
        getPlanGenState={() => "planning"}
      />
    );
    expect(screen.queryByTestId("plan-list-execute")).not.toBeInTheDocument();
    expect(screen.getByTestId("plan-list-planning-indicator")).toBeInTheDocument();
  });

  it("shows Generate tasks when getPlanGenState returns ready", () => {
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
        getPlanGenState={() => "ready"}
      />
    );
    expect(screen.getByTestId("plan-list-generate-tasks")).toBeInTheDocument();
    expect(screen.queryByTestId("plan-list-planning-indicator")).not.toBeInTheDocument();
    expect(screen.queryByTestId("plan-list-retry")).not.toBeInTheDocument();
  });

  it("calls onRetryPlan with plan ID when Retry is clicked", async () => {
    const plans = [makePlan("stale-plan", "planning", 0)];
    const onRetryPlan = vi.fn();
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
        getPlanGenState={() => "stale"}
        onRetryPlan={onRetryPlan}
      />
    );
    screen.getByTestId("plan-list-retry").click();
    expect(onRetryPlan).toHaveBeenCalledWith("stale-plan");
  });

  it("shows 'May be stuck' status text for stale plans", () => {
    const plans = [makePlan("stale-plan", "planning", 0)];
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
        getPlanGenState={() => "stale"}
        onRetryPlan={vi.fn()}
      />
    );
    expect(screen.getByText("May be stuck")).toBeInTheDocument();
  });

  it("shows 'Planning…' status text for in-flight plans", () => {
    const plans = [makePlan("active-plan", "planning", 0)];
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
        getPlanGenState={() => "planning"}
      />
    );
    const row = screen.getByTestId("plan-list-row-active-plan");
    expect(within(row).getByText(/Planning…/)).toBeInTheDocument();
  });

  it("renders parent/child hierarchy in the same status section with tree roles", () => {
    const plans: Plan[] = [
      makePlan("root-plan", "planning", 0, false, { childPlanIds: ["child-plan"] }),
      makePlan("child-plan", "planning", 0, false, { parentPlanId: "root-plan" }),
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

    const section = screen.getByTestId("plan-list-section-planning");
    const tree = within(section).getByRole("tree", { name: /Planning plans/i });
    expect(tree).toBeInTheDocument();

    expect(screen.getByTestId("plan-tree-toggle-root-plan")).toBeInTheDocument();
    const rootRow = screen.getByTestId("plan-list-row-root-plan");
    const childRow = screen.getByTestId("plan-list-row-child-plan");
    expect(within(rootRow).getByText("Root Plan")).toBeInTheDocument();
    const subGroup = within(rootRow).getByRole("group", { name: /Sub-plans under Root Plan/i });
    expect(subGroup).toBeInTheDocument();
    expect(within(subGroup).getByTestId("plan-list-row-child-plan")).toBeInTheDocument();
    expect(within(childRow).getByText("Child Plan")).toBeInTheDocument();
  });

  it("collapses nested sub-plans when the toggle is activated", async () => {
    const user = userEvent.setup();
    const plans: Plan[] = [
      makePlan("root-plan", "planning", 0, false, { childPlanIds: ["child-plan"] }),
      makePlan("child-plan", "planning", 0, false, { parentPlanId: "root-plan" }),
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

    expect(screen.getByTestId("plan-list-row-child-plan")).toBeVisible();
    await user.click(screen.getByTestId("plan-tree-toggle-root-plan"));
    await waitFor(() => {
      expect(screen.queryByTestId("plan-list-row-child-plan")).not.toBeInTheDocument();
    });
    await user.click(screen.getByTestId("plan-tree-toggle-root-plan"));
    await waitFor(() => {
      expect(screen.getByTestId("plan-list-row-child-plan")).toBeVisible();
    });
  });

  it("shows waiting-on hint when blocks edges reference incomplete plans", () => {
    const plans: Plan[] = [
      makePlan("blocker", "planning", 0, false),
      makePlan("blocked", "planning", 0, false),
    ];
    const edges: PlanDependencyEdge[] = [{ from: "blocker", to: "blocked", type: "blocks" }];
    render(
      <PlanListView
        plans={plans}
        planDependencyEdges={edges}
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

    const hint = screen.getByTestId("plan-list-blocked-hint-blocked");
    expect(hint).toHaveAttribute("role", "status");
    expect(hint).toHaveTextContent(/Waiting on Blocker/);
    expect(hint).toHaveTextContent(/before this plan can run/);
  });

  it("does not show waiting-on hint when the blocking plan is complete", () => {
    const plans: Plan[] = [
      makePlan("blocker", "complete", 1, true),
      makePlan("blocked", "planning", 0, false),
    ];
    const edges: PlanDependencyEdge[] = [{ from: "blocker", to: "blocked", type: "blocks" }];
    render(
      <PlanListView
        plans={plans}
        planDependencyEdges={edges}
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

    expect(screen.queryByTestId("plan-list-blocked-hint-blocked")).not.toBeInTheDocument();
  });

  it("shows max depth hint when plan depth reaches the hierarchy cap", () => {
    const plans: Plan[] = [makePlan("deep-plan", "planning", 0, false, { depth: MAX_PLAN_DEPTH })];
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

    expect(screen.getByTestId("plan-list-max-depth-hint")).toHaveTextContent("Max depth");
  });

  describe("keyboard accessibility", () => {
    it("toggle button has aria-expanded reflecting collapse state", async () => {
      const user = userEvent.setup();
      const plans: Plan[] = [
        makePlan("root-plan", "planning", 0, false, { childPlanIds: ["child-plan"] }),
        makePlan("child-plan", "planning", 0, false, { parentPlanId: "root-plan" }),
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

      const toggle = screen.getByTestId("plan-tree-toggle-root-plan");
      expect(toggle).toHaveAttribute("aria-expanded", "true");

      await user.click(toggle);
      await waitFor(() => {
        expect(toggle).toHaveAttribute("aria-expanded", "false");
      });

      await user.click(toggle);
      await waitFor(() => {
        expect(toggle).toHaveAttribute("aria-expanded", "true");
      });
    });

    it("toggle button can be activated via keyboard (Enter)", async () => {
      const user = userEvent.setup();
      const plans: Plan[] = [
        makePlan("root-plan", "planning", 0, false, { childPlanIds: ["child-plan"] }),
        makePlan("child-plan", "planning", 0, false, { parentPlanId: "root-plan" }),
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

      const toggle = screen.getByTestId("plan-tree-toggle-root-plan");
      toggle.focus();
      await user.keyboard("{Enter}");
      await waitFor(() => {
        expect(screen.queryByTestId("plan-list-row-child-plan")).not.toBeInTheDocument();
      });
    });

    it("tree items have treeitem role and aria-selected", () => {
      const plans: Plan[] = [makePlan("plan-a", "planning", 0), makePlan("plan-b", "planning", 0)];
      render(
        <PlanListView
          plans={plans}
          selectedPlanId="plan-a"
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

      const rowA = screen.getByTestId("plan-list-row-plan-a");
      const rowB = screen.getByTestId("plan-list-row-plan-b");
      expect(rowA).toHaveAttribute("role", "treeitem");
      expect(rowA).toHaveAttribute("aria-selected", "true");
      expect(rowB).toHaveAttribute("role", "treeitem");
      expect(rowB).toHaveAttribute("aria-selected", "false");
    });

    it("section lists have tree role with accessible label", () => {
      const plans: Plan[] = [makePlan("plan-x", "planning", 0)];
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

      const section = screen.getByTestId("plan-list-section-planning");
      const tree = within(section).getByRole("tree", { name: /Planning plans/i });
      expect(tree).toBeInTheDocument();
    });

    it("sub-plan group has accessible label referencing parent", () => {
      const plans: Plan[] = [
        makePlan("root-plan", "planning", 0, false, { childPlanIds: ["child-plan"] }),
        makePlan("child-plan", "planning", 0, false, { parentPlanId: "root-plan" }),
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

      const rootRow = screen.getByTestId("plan-list-row-root-plan");
      const subGroup = within(rootRow).getByRole("group", {
        name: /Sub-plans under Root Plan/i,
      });
      expect(subGroup).toBeInTheDocument();
    });

    it("toggle button has accessible label describing its action", () => {
      const plans: Plan[] = [
        makePlan("root-plan", "planning", 0, false, { childPlanIds: ["child-plan"] }),
        makePlan("child-plan", "planning", 0, false, { parentPlanId: "root-plan" }),
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

      const toggle = screen.getByTestId("plan-tree-toggle-root-plan");
      expect(toggle).toHaveAttribute(
        "aria-label",
        expect.stringContaining("sub-plans under Root Plan")
      );
    });
  });

  describe("task count display and cap", () => {
    it("hides the count and bar when task count is zero", () => {
      const plan = makePlan("building-empty", "building", 0, true);
      render(
        <PlanListView
          plans={[plan]}
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

      const row = screen.getByTestId("plan-list-row-building-empty");
      expect(
        within(row).queryByTestId("plan-epic-task-cap-building-empty")
      ).not.toBeInTheDocument();
    });

    it("shows 8/15 for eight tasks", () => {
      const plan = makePlan("building-eight", "building", 8, true);
      render(
        <PlanListView
          plans={[plan]}
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

      const row = screen.getByTestId("plan-list-row-building-eight");
      expect(within(row).getByTestId("plan-epic-task-cap-building-eight")).toHaveTextContent(
        "8/15"
      );
    });

    it("shows cap styling at 15 tasks", () => {
      const plan = makePlan("building-full", "building", 15, true);
      render(
        <PlanListView
          plans={[plan]}
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

      const cap = within(screen.getByTestId("plan-list-row-building-full")).getByTestId(
        "plan-epic-task-cap-building-full"
      );
      expect(cap).toHaveTextContent("15/15");
      expect(cap.querySelector(".text-theme-warning-text")).toBeTruthy();
    });

    it("shows aggregate totals for parent plans with children", () => {
      const plans: Plan[] = [
        makePlan("root-plan", "planning", 2, true, { childPlanIds: ["child-a", "child-b"] }),
        makePlan("child-a", "planning", 3, true, { parentPlanId: "root-plan" }),
        makePlan("child-b", "planning", 4, true, { parentPlanId: "root-plan" }),
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

      const rootRow = screen.getByTestId("plan-list-row-root-plan");
      expect(
        within(rootRow).getByTestId("plan-list-subtree-aggregate-root-plan")
      ).toHaveTextContent("Total tasks: 9 across 2 sub-plans");
    });

    it("max-depth hint tooltip explains the depth restriction", () => {
      const plans: Plan[] = [
        makePlan("deep-plan", "planning", 0, false, { depth: MAX_PLAN_DEPTH }),
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

      const hint = screen.getByTestId("plan-list-max-depth-hint");
      expect(hint).toHaveTextContent("Max depth");
      expect(hint).toHaveAttribute("title", expect.stringContaining("maximum sub-plan depth"));
    });

    it("does not show max-depth hint when plan is below max depth", () => {
      const plans: Plan[] = [makePlan("shallow-plan", "planning", 0, false, { depth: 2 })];
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

      expect(screen.queryByTestId("plan-list-max-depth-hint")).not.toBeInTheDocument();
    });
  });

  it("treats a plan as a section root when its parent is absent from the list", () => {
    const plans: Plan[] = [
      makePlan("orphan-child", "building", 1, true, { parentPlanId: "missing-parent" }),
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

    const row = screen.getByTestId("plan-list-row-orphan-child");
    expect(within(row).getByText("Orphan Child")).toBeInTheDocument();
    expect(within(row).queryByTestId("plan-tree-toggle-orphan-child")).not.toBeInTheDocument();
  });
});
