import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PrdViewer } from "./PrdViewer";

vi.mock("./PrdSectionEditor", () => ({
  PrdSectionEditor: ({
    sectionKey,
    markdown,
    onSave,
  }: {
    sectionKey: string;
    markdown: string;
    onSave: (s: string, m: string) => void;
  }) => (
    <div data-testid={`editor-${sectionKey}`}>
      <input
        data-testid={`input-${sectionKey}`}
        defaultValue={markdown}
        onChange={(e) => onSave(sectionKey, e.target.value)}
      />
    </div>
  ),
}));

vi.mock("./PrdSectionInlineDiff", () => ({
  PrdSectionInlineDiff: ({
    proposedUpdate,
  }: {
    currentContent: string;
    proposedUpdate: { section: string; changeLogEntry?: string; content: string };
  }) => (
    <div data-testid={`prd-inline-diff-${proposedUpdate.section}`}>
      <span>Proposed: {proposedUpdate.changeLogEntry ?? proposedUpdate.section}</span>
    </div>
  ),
}));

describe("PrdViewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders PRD sections with formatted headers", () => {
    const prdContent = {
      executive_summary: "Summary text",
      goals_and_metrics: "Goals text",
    };
    render(<PrdViewer prdContent={prdContent} savingSections={[]} onSectionChange={vi.fn()} />);

    expect(screen.getByText("Executive Summary")).toBeInTheDocument();
    expect(screen.getByText("Goals and Success Metrics")).toBeInTheDocument();
    expect(screen.getByTestId("input-executive_summary")).toHaveValue("Summary text");
  });

  it("shows Saving... when section is being saved", () => {
    render(
      <PrdViewer
        prdContent={{ overview: "Content" }}
        savingSections={["overview"]}
        onSectionChange={vi.fn()}
      />
    );

    expect(screen.getByText("Saving...")).toBeInTheDocument();
  });

  it("calls onSectionChange when user edits section content", async () => {
    const user = userEvent.setup();
    const onSectionChange = vi.fn();
    render(
      <PrdViewer
        prdContent={{ overview: "Original" }}
        savingSections={[]}
        onSectionChange={onSectionChange}
      />
    );

    const input = screen.getByTestId("input-overview");
    await user.clear(input);
    await user.type(input, "Updated content");

    expect(onSectionChange).toHaveBeenCalledWith("overview", "Updated content");
  });

  it("shows inline diff for sections with proposed changes when scopeChangeMetadata is present", () => {
    const prdContent = {
      executive_summary: "Current summary",
      feature_list: "1. Web dashboard",
    };
    const scopeChangeMetadata = {
      scopeChangeSummary: "Add mobile app",
      scopeChangeProposedUpdates: [
        {
          section: "feature_list",
          changeLogEntry: "Add mobile app",
          content: "1. Web dashboard\n2. Mobile app",
        },
      ],
    };

    render(
      <PrdViewer
        prdContent={prdContent}
        savingSections={[]}
        onSectionChange={vi.fn()}
        scopeChangeMetadata={scopeChangeMetadata}
      />
    );

    expect(screen.getByText("Executive Summary")).toBeInTheDocument();
    expect(screen.getByText("Feature List")).toBeInTheDocument();
    expect(screen.getByText("Proposed changes")).toBeInTheDocument();
    expect(screen.getByTestId("prd-inline-diff-feature_list")).toBeInTheDocument();
    expect(screen.getByText("Proposed: Add mobile app")).toBeInTheDocument();
    expect(screen.getByTestId("editor-executive_summary")).toBeInTheDocument();
  });
});
