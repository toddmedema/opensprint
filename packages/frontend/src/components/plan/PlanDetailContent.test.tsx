import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanDetailContent } from "./PlanDetailContent";
import type { Plan } from "@opensprint/shared";
import { usePlanVersions, usePlanVersion } from "../../api/hooks";

vi.mock("../../api/hooks", () => ({
  usePlanVersions: vi.fn(() => ({ data: [] })),
  usePlanVersion: vi.fn(() => ({ data: undefined, isLoading: false })),
}));

vi.mock("../prd/PrdSectionEditor", () => ({
  PrdSectionEditor: ({
    sectionKey,
    markdown,
    onSave,
    disabled,
  }: {
    sectionKey: string;
    markdown: string;
    onSave: (key: string, md: string) => void;
    disabled?: boolean;
  }) => (
    <div data-testid="plan-body-editor">
      <span data-testid="body-markdown">{markdown}</span>
      <button
        type="button"
        onClick={() => onSave(sectionKey, "Updated body content")}
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
    epicId: "epic-1",
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

  it("renders plan body editor as collapsible sections", () => {
    render(<PlanDetailContent plan={mockPlan} onContentSave={onContentSave} />);
    expect(screen.getByRole("button", { name: /overview/i })).toBeInTheDocument();
    expect(screen.getByTestId("plan-body-editor")).toBeInTheDocument();
    // Body is split by ##; Overview section content is the text under ## Overview
    expect(screen.getByTestId("body-markdown")).toHaveTextContent("Implement the Plan phase.");
  });

  it("calls onContentSave when title is changed and blurred", async () => {
    const user = userEvent.setup();
    render(<PlanDetailContent plan={mockPlan} onContentSave={onContentSave} />);
    const titleInput = screen.getByRole("textbox", { name: /title/i });
    await user.clear(titleInput);
    await user.type(titleInput, "New Title");
    titleInput.blur();

    await waitFor(() => {
      expect(onContentSave).toHaveBeenCalledWith(
        "# New Title\n\n## Overview\n\nImplement the Plan phase."
      );
    });
  });

  it("calls onContentSave when body is saved via editor", async () => {
    const user = userEvent.setup();
    render(<PlanDetailContent plan={mockPlan} onContentSave={onContentSave} />);
    const saveButton = screen.getByRole("button", { name: /save body/i });
    await user.click(saveButton);

    expect(onContentSave).toHaveBeenCalledWith(
      "# Plan Phase - Feature Decomposition\n\n## Overview\n\nUpdated body content"
    );
  });

  it("shows Saving... when saving prop is true", () => {
    render(<PlanDetailContent plan={mockPlan} onContentSave={onContentSave} saving />);
    expect(screen.getByText("Saving...")).toBeInTheDocument();
  });

  it("shows Saved briefly when save completes (editor stays editable during save)", () => {
    const { rerender } = render(
      <PlanDetailContent plan={mockPlan} onContentSave={onContentSave} saving />
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
        "# Plan Phase Feature Decomposition\n\n## Overview\n\nImplement the Plan phase."
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
      />
    );
    expect(screen.getByRole("button", { name: /archive/i })).toBeInTheDocument();
  });

  it("renders plan markdown editor with theme-aware styles (Execute sidebar style)", () => {
    render(<PlanDetailContent plan={mockPlan} onContentSave={onContentSave} />);
    const editorContainer = screen.getByTestId("plan-markdown-editor");
    expect(editorContainer).toBeInTheDocument();
    expect(editorContainer.className).toMatch(/text-theme-text/);
  });

  it("trims body markdown before passing to editor (no spurious blank space at top)", () => {
    const planWithLeadingNewlines: Plan = {
      ...mockPlan,
      content: "# My Plan\n\n\n\n## Overview\n\nContent with leading newlines in body.",
    };
    render(<PlanDetailContent plan={planWithLeadingNewlines} onContentSave={onContentSave} />);
    const bodyMarkdown = screen.getByTestId("body-markdown").textContent ?? "";
    expect(bodyMarkdown).not.toMatch(/^\s/);
    expect(bodyMarkdown).toContain("Content with leading newlines in body.");
  });

  it("uses collapsible section content padding (Execute sidebar style)", () => {
    render(<PlanDetailContent plan={mockPlan} onContentSave={onContentSave} />);
    const editorContainer = screen.getByTestId("plan-markdown-editor");
    expect(editorContainer.className).toContain("first-child");
    const contentWrapper = editorContainer.closest('[id="plan-section-0-content"]');
    expect(contentWrapper).toBeInTheDocument();
    expect(contentWrapper?.className).toMatch(/pt-0/);
    expect(contentWrapper?.className).toMatch(/p-4|px-4/);
  });

  it("renders header with title aligned to top and no HR (border-b)", () => {
    const { container } = render(
      <PlanDetailContent plan={mockPlan} onContentSave={onContentSave} />
    );
    const headerRow = container.querySelector(".flex.items-start");
    expect(headerRow).toBeInTheDocument();
    expect(headerRow).not.toHaveClass("border-b");
  });

  it("children render prop receives header and body slots for sticky layout", () => {
    const renderSlots = vi.fn(
      ({ header, body }: { header: React.ReactNode; body: React.ReactNode }) => (
        <div data-testid="custom-layout">
          <div data-testid="header-slot">{header}</div>
          <div data-testid="body-slot">{body}</div>
        </div>
      )
    );
    render(
      <PlanDetailContent
        plan={mockPlan}
        onContentSave={onContentSave}
        headerActions={<button type="button">Close</button>}
      >
        {renderSlots}
      </PlanDetailContent>
    );
    expect(renderSlots).toHaveBeenCalledWith(
      expect.objectContaining({
        header: expect.any(Object),
        body: expect.any(Object),
      })
    );
    expect(screen.getByTestId("custom-layout")).toBeInTheDocument();
    expect(screen.getByTestId("header-slot")).toContainElement(
      screen.getByRole("textbox", { name: /title/i })
    );
    expect(screen.getByTestId("body-slot")).toContainElement(
      screen.getByTestId("plan-markdown-editor")
    );
  });

  describe("version selector", () => {
    it("does not show version selector when projectId and planId are not provided", () => {
      render(<PlanDetailContent plan={mockPlan} onContentSave={onContentSave} />);
      expect(screen.queryByTestId("plan-version-selector")).not.toBeInTheDocument();
    });

    it("shows version row with Version label and dropdown when projectId and planId are provided", () => {
      vi.mocked(usePlanVersions).mockReturnValue({
        data: [
          {
            id: "v3",
            version_number: 3,
            created_at: "2025-01-03T00:00:00Z",
            is_executed_version: false,
          },
          {
            id: "v2",
            version_number: 2,
            created_at: "2025-01-02T00:00:00Z",
            is_executed_version: true,
          },
        ],
      } as ReturnType<typeof usePlanVersions>);
      const planWithVersion: Plan = {
        ...mockPlan,
        currentVersionNumber: 3,
        lastExecutedVersionNumber: 2,
      };
      render(
        <PlanDetailContent
          plan={planWithVersion}
          onContentSave={onContentSave}
          projectId="proj-1"
          planId="plan-1"
        />
      );
      expect(screen.getByTestId("plan-version-selector")).toBeInTheDocument();
      expect(screen.getByText("Version:")).toBeInTheDocument();
      const dropdown = screen.getByTestId("plan-version-dropdown");
      expect(dropdown).toHaveValue("3");
    });

    it("shows version dropdown with versions newest first and executed indicator", async () => {
      vi.mocked(usePlanVersions).mockReturnValue({
        data: [
          {
            id: "v1",
            version_number: 1,
            created_at: "2025-01-01T00:00:00Z",
            is_executed_version: false,
          },
          {
            id: "v2",
            version_number: 2,
            created_at: "2025-01-02T00:00:00Z",
            is_executed_version: true,
          },
          {
            id: "v3",
            version_number: 3,
            created_at: "2025-01-03T00:00:00Z",
            is_executed_version: false,
          },
        ],
      } as ReturnType<typeof usePlanVersions>);
      const planWithVersion: Plan = {
        ...mockPlan,
        currentVersionNumber: 3,
        lastExecutedVersionNumber: 2,
      };
      render(
        <PlanDetailContent
          plan={planWithVersion}
          onContentSave={onContentSave}
          projectId="proj-1"
          planId="plan-1"
          onVersionSelect={vi.fn()}
        />
      );
      const dropdown = screen.getByTestId("plan-version-dropdown");
      expect(dropdown).toBeInTheDocument();
      const options = Array.from(dropdown.querySelectorAll("option")).map((o) => ({
        value: o.value,
        text: o.textContent,
      }));
      expect(options.map((o) => o.value)).toEqual(["3", "2", "1"]);
      expect(options.find((o) => o.value === "2")?.text).toContain("Executed");
    });

    it("calls onVersionSelect when user selects a version", async () => {
      const user = userEvent.setup();
      const onVersionSelect = vi.fn();
      vi.mocked(usePlanVersions).mockReturnValue({
        data: [
          {
            id: "v1",
            version_number: 1,
            created_at: "2025-01-01T00:00:00Z",
            is_executed_version: false,
          },
          {
            id: "v2",
            version_number: 2,
            created_at: "2025-01-02T00:00:00Z",
            is_executed_version: true,
          },
        ],
      } as ReturnType<typeof usePlanVersions>);
      const planWithVersion: Plan = {
        ...mockPlan,
        currentVersionNumber: 2,
        lastExecutedVersionNumber: 2,
      };
      render(
        <PlanDetailContent
          plan={planWithVersion}
          onContentSave={onContentSave}
          projectId="proj-1"
          planId="plan-1"
          onVersionSelect={onVersionSelect}
        />
      );
      const dropdown = screen.getByTestId("plan-version-dropdown");
      await user.selectOptions(dropdown, "1");
      expect(onVersionSelect).toHaveBeenCalledWith(1);
    });

    it("shows read-only view with version in dropdown and Back to current when viewing a past version", async () => {
      vi.mocked(usePlanVersions).mockReturnValue({
        data: [
          {
            id: "v1",
            version_number: 1,
            created_at: "2025-01-01T00:00:00Z",
            is_executed_version: false,
          },
          {
            id: "v2",
            version_number: 2,
            created_at: "2025-01-02T00:00:00Z",
            is_executed_version: true,
          },
        ],
      } as ReturnType<typeof usePlanVersions>);
      vi.mocked(usePlanVersion).mockReturnValue({
        data: {
          version_number: 1,
          title: "Past version title",
          content: "# Past version title\n\nOld body content.",
          created_at: "2025-01-01T00:00:00Z",
        },
        isLoading: false,
      } as ReturnType<typeof usePlanVersion>);
      const planWithVersion: Plan = {
        ...mockPlan,
        currentVersionNumber: 2,
        lastExecutedVersionNumber: 2,
      };
      render(
        <PlanDetailContent
          plan={planWithVersion}
          onContentSave={onContentSave}
          projectId="proj-1"
          planId="plan-1"
          selectedVersionNumber={1}
          onVersionSelect={vi.fn()}
        />
      );
      expect(screen.getByTestId("plan-version-dropdown")).toHaveValue("1");
      expect(screen.getByTestId("plan-viewing-title")).toHaveTextContent("Past version title");
      expect(screen.getByTestId("plan-back-to-current")).toHaveTextContent("Back to current");
      expect(screen.queryByRole("textbox", { name: /title/i })).not.toBeInTheDocument();
      const editor = screen.getByTestId("plan-body-editor");
      expect(editor).toBeInTheDocument();
      const saveButton = screen.getByRole("button", { name: /save body/i });
      expect(saveButton).toBeDisabled();
    });

    it("calls onVersionSelect(null) when Back to current is clicked", async () => {
      const user = userEvent.setup();
      const onVersionSelect = vi.fn();
      vi.mocked(usePlanVersions).mockReturnValue({
        data: [
          {
            id: "v1",
            version_number: 1,
            created_at: "2025-01-01T00:00:00Z",
            is_executed_version: false,
          },
          {
            id: "v2",
            version_number: 2,
            created_at: "2025-01-02T00:00:00Z",
            is_executed_version: true,
          },
        ],
      } as ReturnType<typeof usePlanVersions>);
      vi.mocked(usePlanVersion).mockReturnValue({
        data: {
          version_number: 1,
          title: "Past",
          content: "# Past\n\nBody.",
          created_at: "2025-01-01T00:00:00Z",
        },
        isLoading: false,
      } as ReturnType<typeof usePlanVersion>);
      const planWithVersion: Plan = {
        ...mockPlan,
        currentVersionNumber: 2,
        lastExecutedVersionNumber: 2,
      };
      render(
        <PlanDetailContent
          plan={planWithVersion}
          onContentSave={onContentSave}
          projectId="proj-1"
          planId="plan-1"
          selectedVersionNumber={1}
          onVersionSelect={onVersionSelect}
        />
      );
      await user.click(screen.getByTestId("plan-back-to-current"));
      expect(onVersionSelect).toHaveBeenCalledWith(null);
    });

    it("shows Loading version when viewing past version and version is loading", () => {
      vi.mocked(usePlanVersions).mockReturnValue({
        data: [
          {
            id: "v1",
            version_number: 1,
            created_at: "2025-01-01T00:00:00Z",
            is_executed_version: false,
          },
          {
            id: "v2",
            version_number: 2,
            created_at: "2025-01-02T00:00:00Z",
            is_executed_version: true,
          },
        ],
      } as ReturnType<typeof usePlanVersions>);
      vi.mocked(usePlanVersion).mockReturnValue({
        data: undefined,
        isLoading: true,
      } as ReturnType<typeof usePlanVersion>);
      const planWithVersion: Plan = {
        ...mockPlan,
        currentVersionNumber: 2,
        lastExecutedVersionNumber: 2,
      };
      render(
        <PlanDetailContent
          plan={planWithVersion}
          onContentSave={onContentSave}
          projectId="proj-1"
          planId="plan-1"
          selectedVersionNumber={1}
        />
      );
      expect(screen.getByTestId("plan-version-loading")).toHaveTextContent("Loading version…");
    });

    it("keeps current version editable when selectedVersionNumber is null or current", () => {
      vi.mocked(usePlanVersions).mockReturnValue({
        data: [
          {
            id: "v1",
            version_number: 1,
            created_at: "2025-01-01T00:00:00Z",
            is_executed_version: false,
          },
          {
            id: "v2",
            version_number: 2,
            created_at: "2025-01-02T00:00:00Z",
            is_executed_version: true,
          },
        ],
      } as ReturnType<typeof usePlanVersions>);
      const planWithVersion: Plan = {
        ...mockPlan,
        currentVersionNumber: 2,
        lastExecutedVersionNumber: 2,
      };
      render(
        <PlanDetailContent
          plan={planWithVersion}
          onContentSave={onContentSave}
          projectId="proj-1"
          planId="plan-1"
          onVersionSelect={vi.fn()}
        />
      );
      expect(screen.getByRole("textbox", { name: /title/i })).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: /title/i })).not.toBeDisabled();
      const saveButton = screen.getByRole("button", { name: /save body/i });
      expect(saveButton).not.toBeDisabled();
      expect(screen.queryByTestId("plan-back-to-current")).not.toBeInTheDocument();
    });

    it("shows version not found and falls back to current content when GET version returns 404", () => {
      vi.mocked(usePlanVersions).mockReturnValue({
        data: [
          {
            id: "v1",
            version_number: 1,
            created_at: "2025-01-01T00:00:00Z",
            is_executed_version: false,
          },
          {
            id: "v2",
            version_number: 2,
            created_at: "2025-01-02T00:00:00Z",
            is_executed_version: true,
          },
        ],
      } as ReturnType<typeof usePlanVersions>);
      vi.mocked(usePlanVersion).mockReturnValue({
        data: undefined,
        isLoading: false,
        isError: true,
      } as ReturnType<typeof usePlanVersion>);
      const planWithVersion: Plan = {
        ...mockPlan,
        content: "# Current\n\nCurrent body.",
        currentVersionNumber: 2,
        lastExecutedVersionNumber: 2,
      };
      render(
        <PlanDetailContent
          plan={planWithVersion}
          onContentSave={onContentSave}
          projectId="proj-1"
          planId="plan-1"
          selectedVersionNumber={99}
          onVersionSelect={vi.fn()}
        />
      );
      expect(screen.getByTestId("plan-version-not-found")).toHaveTextContent("Version not found");
      expect(screen.getByText("Version not found. Showing current version.")).toBeInTheDocument();
    });
  });
});
