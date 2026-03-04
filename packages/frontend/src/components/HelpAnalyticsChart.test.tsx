import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { HelpAnalyticsChart } from "./HelpAnalyticsChart";

// D3 uses ResizeObserver; jsdom may not have it
beforeEach(() => {
  if (typeof ResizeObserver === "undefined") {
    vi.stubGlobal(
      "ResizeObserver",
      vi.fn().mockImplementation((_cb: ResizeObserverCallback) => ({
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      }))
    );
  }
});

describe("HelpAnalyticsChart", () => {
  it("renders empty state when totalTasks is 0", () => {
    const emptyData = Array.from({ length: 10 }, (_, i) => ({
      complexity: i + 1,
      taskCount: 0,
      avgCompletionTimeMs: 0,
    }));
    render(<HelpAnalyticsChart data={emptyData} totalTasks={0} />);

    expect(screen.getByText(/No completed tasks with complexity data yet/)).toBeInTheDocument();
  });

  it("renders empty state when data array is empty", () => {
    render(<HelpAnalyticsChart data={[]} totalTasks={0} />);

    expect(screen.getByText(/No completed tasks with complexity data yet/)).toBeInTheDocument();
  });

  it("renders chart when data has buckets with tasks", () => {
    const data = Array.from({ length: 10 }, (_, i) => ({
      complexity: i + 1,
      taskCount: i === 2 ? 2 : i === 4 ? 1 : 0,
      avgCompletionTimeMs: i === 2 ? 90000 : i === 4 ? 180000 : 0,
    }));
    render(<HelpAnalyticsChart data={data} totalTasks={3} />);

    expect(screen.getByTestId("help-analytics-chart")).toBeInTheDocument();
    expect(screen.getByLabelText("Task analytics by complexity")).toBeInTheDocument();
    expect(screen.getByText(/Based on 3 most recent completed tasks/)).toBeInTheDocument();
  });

  it("chart container has fixed height of 400px", () => {
    const data = Array.from({ length: 10 }, (_, i) => ({
      complexity: i + 1,
      taskCount: i === 2 ? 2 : 0,
      avgCompletionTimeMs: i === 2 ? 90000 : 0,
    }));
    const { container } = render(<HelpAnalyticsChart data={data} totalTasks={2} />);
    const chartContainer = container.querySelector('[data-testid="help-analytics-chart"] > div');
    expect(chartContainer).toHaveClass("h-[400px]");
  });
});
