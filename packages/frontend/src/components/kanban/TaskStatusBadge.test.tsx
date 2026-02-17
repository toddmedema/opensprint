import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TaskStatusBadge, COLUMN_LABELS } from "./TaskStatusBadge";

describe("TaskStatusBadge", () => {
  it("renders check icon for done column", () => {
    const { container } = render(<TaskStatusBadge column="done" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("renders colored dot for non-done columns", () => {
    const { container } = render(<TaskStatusBadge column="in_progress" />);
    const span = container.querySelector("span.rounded-full");
    expect(span).toBeInTheDocument();
    expect(span).toHaveClass("bg-purple-400");
  });

  it("renders warning icon for blocked column", () => {
    const { container } = render(<TaskStatusBadge column="blocked" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveClass("text-red-500");
  });

  it("exports COLUMN_LABELS for all columns", () => {
    expect(COLUMN_LABELS.planning).toBe("Planning");
    expect(COLUMN_LABELS.done).toBe("Done");
    expect(COLUMN_LABELS.blocked).toBe("Blocked");
  });
});
