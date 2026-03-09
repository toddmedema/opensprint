import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanFilterToolbar } from "./PlanFilterToolbar";

function renderToolbar(overrides: Partial<React.ComponentProps<typeof PlanFilterToolbar>> = {}) {
  const props: React.ComponentProps<typeof PlanFilterToolbar> = {
    statusFilter: "planning",
    setStatusFilter: vi.fn(),
    planCountByStatus: { all: 4, planning: 2, building: 1, in_review: 0, complete: 1 },
    viewMode: "card",
    onViewModeChange: vi.fn(),
    plansWithNoTasksCount: 0,
    plansReadyToExecuteCount: 0,
    planAllInProgress: false,
    executeAllInProgress: false,
    executingPlanId: null,
    planTasksPlanIds: [],
    onPlanAllTasks: vi.fn(),
    onExecuteAll: vi.fn(),
    onAddPlan: vi.fn(),
    searchExpanded: false,
    searchInputValue: "",
    setSearchInputValue: vi.fn(),
    searchInputRef: createRef<HTMLInputElement>(),
    handleSearchExpand: vi.fn(),
    handleSearchClose: vi.fn(),
    handleSearchKeyDown: vi.fn(),
    ...overrides,
  };

  render(<PlanFilterToolbar {...props} />);
  return props;
}

describe("PlanFilterToolbar", () => {
  it("hides filter chips when count is 0", () => {
    render(
      <PlanFilterToolbar
        statusFilter="all"
        setStatusFilter={vi.fn()}
        planCountByStatus={{ all: 2, planning: 1, building: 0, in_review: 0, complete: 1 }}
        viewMode="card"
        onViewModeChange={vi.fn()}
        plansWithNoTasksCount={0}
        plansReadyToExecuteCount={0}
        planAllInProgress={false}
        executeAllInProgress={false}
        executingPlanId={null}
        planTasksPlanIds={[]}
        onPlanAllTasks={vi.fn()}
        onExecuteAll={vi.fn()}
        onAddPlan={vi.fn()}
      />
    );
    expect(screen.getByTestId("plan-filter-chip-all")).toBeInTheDocument();
    expect(screen.getByTestId("plan-filter-chip-planning")).toBeInTheDocument();
    expect(screen.queryByTestId("plan-filter-chip-building")).not.toBeInTheDocument();
    expect(screen.getByTestId("plan-filter-chip-complete")).toBeInTheDocument();
  });

  it("toggles status filters back to all when the active non-all chip is clicked", async () => {
    const user = userEvent.setup();
    const props = renderToolbar();

    await user.click(screen.getByTestId("plan-filter-chip-planning"));
    expect(props.setStatusFilter).toHaveBeenCalledWith("all");

    await user.click(screen.getByTestId("plan-filter-chip-complete"));
    expect(props.setStatusFilter).toHaveBeenCalledWith("complete");
  });

  it("shows Generate All Tasks and Execute All only when their thresholds are met", () => {
    const { rerender } = render(
      <PlanFilterToolbar
        statusFilter="all"
        setStatusFilter={vi.fn()}
        planCountByStatus={{ all: 2, planning: 1, building: 1, in_review: 0, complete: 0 }}
        viewMode="card"
        onViewModeChange={vi.fn()}
        plansWithNoTasksCount={2}
        plansReadyToExecuteCount={2}
        planAllInProgress={false}
        executeAllInProgress={false}
        executingPlanId={null}
        planTasksPlanIds={[]}
        onPlanAllTasks={vi.fn()}
        onExecuteAll={vi.fn()}
        onAddPlan={vi.fn()}
      />
    );

    expect(screen.getByTestId("plan-all-tasks-button")).toBeInTheDocument();
    expect(screen.getByTestId("execute-all-button")).toBeInTheDocument();

    rerender(
      <PlanFilterToolbar
        statusFilter="all"
        setStatusFilter={vi.fn()}
        planCountByStatus={{ all: 1, planning: 1, building: 0, in_review: 0, complete: 0 }}
        viewMode="card"
        onViewModeChange={vi.fn()}
        plansWithNoTasksCount={1}
        plansReadyToExecuteCount={1}
        planAllInProgress={false}
        executeAllInProgress={false}
        executingPlanId={null}
        planTasksPlanIds={[]}
        onPlanAllTasks={vi.fn()}
        onExecuteAll={vi.fn()}
        onAddPlan={vi.fn()}
      />
    );

    expect(screen.queryByTestId("plan-all-tasks-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("execute-all-button")).not.toBeInTheDocument();
  });

  it("expands and closes the search UI and updates the input value", async () => {
    const user = userEvent.setup();
    const props = renderToolbar();

    await user.click(screen.getByTestId("plan-search-expand"));
    expect(props.handleSearchExpand).toHaveBeenCalled();

    const expandedProps = renderToolbar({ searchExpanded: true });
    await user.type(screen.getByLabelText("Search plans"), "auth");
    expect(expandedProps.setSearchInputValue).toHaveBeenCalled();

    await user.click(screen.getByTestId("plan-search-close"));
    expect(expandedProps.handleSearchClose).toHaveBeenCalled();
  });

  it("switches view modes through the toggle", async () => {
    const user = userEvent.setup();
    const props = renderToolbar();

    await user.click(screen.getByTestId("view-toggle-graph"));
    expect(props.onViewModeChange).toHaveBeenCalledWith("graph");
  });

  it("uses responsive padding and flex-wrap for mobile layout", () => {
    const { container } = render(
      <PlanFilterToolbar
        statusFilter="all"
        setStatusFilter={vi.fn()}
        planCountByStatus={{ all: 2, planning: 1, building: 1, in_review: 0, complete: 0 }}
        viewMode="card"
        onViewModeChange={vi.fn()}
        plansWithNoTasksCount={0}
        plansReadyToExecuteCount={0}
        planAllInProgress={false}
        executeAllInProgress={false}
        executingPlanId={null}
        planTasksPlanIds={[]}
        onPlanAllTasks={vi.fn()}
        onExecuteAll={vi.fn()}
        onAddPlan={vi.fn()}
      />
    );
    const toolbar = container.firstElementChild;
    expect(toolbar).toHaveClass("px-4");
    expect(toolbar).toHaveClass("md:px-6");
    const inner = toolbar?.querySelector(".flex-wrap");
    expect(inner).toBeInTheDocument();
  });
});
