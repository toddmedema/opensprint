// @vitest-environment jsdom
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  PlanEpicTaskCapIndicator,
  formatPlanTasksSidebarSectionTitle,
  PLAN_TASK_BATCH_CAP_TOOLTIP,
  computePlanSubtreeTaskAggregate,
} from "./planTaskBatchCap";

describe("PlanEpicTaskCapIndicator", () => {
  it("hides the count and bar before tasks are generated", () => {
    const { rerender } = render(<PlanEpicTaskCapIndicator taskCount={0} testIdSuffix="t0" />);
    expect(screen.queryByTestId("plan-epic-task-cap-t0")).not.toBeInTheDocument();
    expect(screen.queryByTitle(PLAN_TASK_BATCH_CAP_TOOLTIP)).not.toBeInTheDocument();

    rerender(<PlanEpicTaskCapIndicator taskCount={3} testIdSuffix="t0" />);
    expect(screen.getByTestId("plan-epic-task-cap-t0")).toHaveTextContent("3/15");
  });

  it("shows 8/15 at eight tasks", () => {
    render(<PlanEpicTaskCapIndicator taskCount={8} testIdSuffix="t8" />);
    const el = screen.getByTestId("plan-epic-task-cap-t8");
    expect(el).toHaveTextContent("8/15");
    expect(el).toHaveAttribute("title", PLAN_TASK_BATCH_CAP_TOOLTIP);
  });

  it("uses warning styling at the cap (15 tasks)", () => {
    render(<PlanEpicTaskCapIndicator taskCount={15} testIdSuffix="cap" />);
    const root = screen.getByTestId("plan-epic-task-cap-cap");
    expect(root).toHaveTextContent("15/15");
    const warn = root.querySelector(".text-theme-warning-text");
    expect(warn).toBeTruthy();
  });
});

describe("formatPlanTasksSidebarSectionTitle", () => {
  it("formats sidebar section title with batch max", () => {
    expect(formatPlanTasksSidebarSectionTitle(0)).toBe("Tasks: 0 of 15 max per batch");
    expect(formatPlanTasksSidebarSectionTitle(3)).toBe("Tasks: 3 of 15 max per batch");
  });
});

describe("computePlanSubtreeTaskAggregate", () => {
  it("sums tasks and counts descendant plans", () => {
    const node = {
      plan: { taskCount: 2 },
      children: [
        { plan: { taskCount: 3 }, children: [{ plan: { taskCount: 1 }, children: [] }] },
        { plan: { taskCount: 4 }, children: [] },
      ],
    };
    const agg = computePlanSubtreeTaskAggregate(node);
    expect(agg.totalIncludingSelf).toBe(2 + 3 + 1 + 4);
    expect(agg.descendantPlanCount).toBe(3);
  });
});
