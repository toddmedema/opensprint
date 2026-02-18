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

  it("does not render redundant Plan heading (context is already Plan phase)", () => {
    render(<PlanDetailContent plan={mockPlan} onContentSave={onContentSave} />);
    expect(screen.queryByRole("heading", { name: /^plan$/i })).not.toBeInTheDocument();
  });

  it("does not show redundant Plan in title input placeholder or aria-label (context is Plan phase)", () => {
    render(<PlanDetailContent plan={mockPlan} onContentSave={onContentSave} />);
    const titleInput = screen.getByRole("textbox", { name: /title/i });
    expect(titleInput).toHaveAttribute("placeholder", "Title");
    expect(titleInput).toHaveAttribute("aria-label", "Title");
  });

  it("renders inline editable title derived from first line", () => {
    render(<PlanDetailContent plan={mockPlan} onContentSave={onContentSave} />);
    const titleInput = screen.getByRole("textbox", { name: /title/i });
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
    const titleInput = screen.getByRole("textbox", { name: /title/i });
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

  it("shows Saved briefly when save completes (editor stays editable during save)", () => {
    const { rerender } = render(
      <PlanDetailContent plan={mockPlan} onContentSave={onContentSave} saving />,
    );
    expect(screen.getByText("Saving...")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /title/i })).not.toBeDisabled();

    rerender(<PlanDetailContent plan={mockPlan} onContentSave={onContentSave} saving={false} />);
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("uses first line as title when content has no # heading", () => {
    const planNoHeading: Plan = {
      ...mockPlan,
      content: "Plain content without heading",
    };
    render(<PlanDetailContent plan={planNoHeading} onContentSave={onContentSave} />);
    const titleInput = screen.getByRole("textbox", { name: /title/i });
    expect(titleInput).toHaveValue("Plain content without heading");
  });

  it("uses formatted planId as fallback when content is empty", () => {
    const planEmptyContent: Plan = {
      ...mockPlan,
      content: "",
    };
    render(<PlanDetailContent plan={planEmptyContent} onContentSave={onContentSave} />);
    const titleInput = screen.getByRole("textbox", { name: /title/i });
    expect(titleInput).toHaveValue("Plan Phase Feature Decomposition");
  });

  it("uses formatted planId as fallback when content starts with ## (section header, not plan title)", () => {
    const planSectionFirst: Plan = {
      ...mockPlan,
      content: "## Overview\n\nBody content without # plan title.",
    };
    render(<PlanDetailContent plan={planSectionFirst} onContentSave={onContentSave} />);
    const titleInput = screen.getByRole("textbox", { name: /title/i });
    expect(titleInput).toHaveValue("Plan Phase Feature Decomposition");
  });

  it("saves with formatted planId when user clears title and blurs", async () => {
    const user = userEvent.setup();
    render(<PlanDetailContent plan={mockPlan} onContentSave={onContentSave} />);
    const titleInput = screen.getByRole("textbox", { name: /title/i });
    await user.clear(titleInput);
    titleInput.blur();

    await waitFor(() => {
      expect(onContentSave).toHaveBeenCalledWith(
        "# Plan Phase Feature Decomposition\n\n## Overview\n\nImplement the Plan phase.",
      );
    });
  });

  it("renders title input with theme-aware font for readability", () => {
    render(<PlanDetailContent plan={mockPlan} onContentSave={onContentSave} />);
    const titleInput = screen.getByRole("textbox", { name: /title/i });
    expect(titleInput.className).toMatch(/text-theme-text/);
  });

  it("renders headerActions in header row when provided", () => {
    render(
      <PlanDetailContent
        plan={mockPlan}
        onContentSave={onContentSave}
        headerActions={<button type="button">Archive</button>}
      />,
    );
    expect(screen.getByRole("button", { name: /archive/i })).toBeInTheDocument();
  });

  it("renders plan markdown editor with theme-aware styles", () => {
    render(<PlanDetailContent plan={mockPlan} onContentSave={onContentSave} />);
    const editorContainer = screen.getByTestId("plan-markdown-editor");
    expect(editorContainer).toBeInTheDocument();
    expect(editorContainer.className).toMatch(/text-theme-text/);
    expect(editorContainer.className).toMatch(/bg-theme-surface/);
    expect(editorContainer.className).toMatch(/border-theme-border/);
  });

  it("renders header with title aligned to top and no HR (border-b)", () => {
    const { container } = render(<PlanDetailContent plan={mockPlan} onContentSave={onContentSave} />);
    const headerRow = container.querySelector(".flex.items-start");
    expect(headerRow).toBeInTheDocument();
    expect(headerRow).not.toHaveClass("border-b");
  });
});
