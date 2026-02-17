import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanDetailContent } from "./PlanDetailContent";
import type { Plan } from "@opensprint/shared";

vi.mock("../prd/PrdSectionEditor", () => ({
  PrdSectionEditor: ({
    markdown,
    onSave,
    disabled,
  }: {
    markdown: string;
    onSave: (key: string, md: string) => void;
    disabled?: boolean;
  }) => (
    <div data-testid="plan-body-editor">
      <span data-testid="body-markdown">{markdown}</span>
      <button
        type="button"
        onClick={() => onSave("plan-body", "Updated body content")}
        disabled={disabled}
      >
        Save body
      </button>
    </div>
  ),
}));

const mockPlan: Plan = {
  metadata: {
    planId: "plan-phase-feature-decomposition",
    beadEpicId: "epic-1",
    gateTaskId: "gate-1",
    shippedAt: null,
    complexity: "medium",
  },
  content: "# Plan Phase - Feature Decomposition\n\n## Overview\n\nImplement the Plan phase.",
  status: "planning",
  taskCount: 0,
  doneTaskCount: 0,
  dependencyCount: 0,
};

describe("PlanDetailContent", () => {
  const onContentSave = vi.fn();

  beforeEach(() => {
    onContentSave.mockReset();
  });

  it("renders inline editable title derived from first line", () => {
    render(<PlanDetailContent plan={mockPlan} onContentSave={onContentSave} />);
    const titleInput = screen.getByRole("textbox", { name: /plan title/i });
    expect(titleInput).toHaveValue("Plan Phase - Feature Decomposition");
  });

  it("renders plan body editor", () => {
    render(<PlanDetailContent plan={mockPlan} onContentSave={onContentSave} />);
    expect(screen.getByTestId("plan-body-editor")).toBeInTheDocument();
    expect(screen.getByTestId("body-markdown")).toHaveTextContent("## Overview");
  });

  it("calls onContentSave when title is changed and blurred", async () => {
    const user = userEvent.setup();
    render(<PlanDetailContent plan={mockPlan} onContentSave={onContentSave} />);
    const titleInput = screen.getByRole("textbox", { name: /plan title/i });
    await user.clear(titleInput);
    await user.type(titleInput, "New Title");
    titleInput.blur();

    await waitFor(() => {
      expect(onContentSave).toHaveBeenCalledWith("# New Title\n\n## Overview\n\nImplement the Plan phase.");
    });
  });

  it("calls onContentSave when body is saved via editor", async () => {
    const user = userEvent.setup();
    render(<PlanDetailContent plan={mockPlan} onContentSave={onContentSave} />);
    const saveButton = screen.getByRole("button", { name: /save body/i });
    await user.click(saveButton);

    expect(onContentSave).toHaveBeenCalledWith(
      "# Plan Phase - Feature Decomposition\n\nUpdated body content",
    );
  });

  it("shows Saving... when saving prop is true", () => {
    render(<PlanDetailContent plan={mockPlan} onContentSave={onContentSave} saving />);
    expect(screen.getByText("Saving...")).toBeInTheDocument();
  });

  it("disables title input when saving", () => {
    render(<PlanDetailContent plan={mockPlan} onContentSave={onContentSave} saving />);
    expect(screen.getByRole("textbox", { name: /plan title/i })).toBeDisabled();
  });

  it("uses planId as fallback when content has no heading", () => {
    const planNoHeading: Plan = {
      ...mockPlan,
      content: "Plain content without heading",
    };
    render(<PlanDetailContent plan={planNoHeading} onContentSave={onContentSave} />);
    const titleInput = screen.getByRole("textbox", { name: /plan title/i });
    expect(titleInput).toHaveValue("Plain content without heading");
  });
});
