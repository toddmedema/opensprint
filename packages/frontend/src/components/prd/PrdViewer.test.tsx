import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

describe("PrdViewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders PRD sections with formatted headers", () => {
    const prdContent = {
      executive_summary: "Summary text",
      goals_and_metrics: "Goals text",
    };
    render(
      <PrdViewer
        prdContent={prdContent}
        savingSections={[]}
        onSectionChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Executive Summary")).toBeInTheDocument();
    expect(screen.getByText("Goals And Metrics")).toBeInTheDocument();
    expect(screen.getByTestId("input-executive_summary")).toHaveValue("Summary text");
  });

  it("shows Saving... when section is being saved", () => {
    render(
      <PrdViewer
        prdContent={{ overview: "Content" }}
        savingSections={["overview"]}
        onSectionChange={vi.fn()}
      />,
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
      />,
    );

    const input = screen.getByTestId("input-overview");
    await user.clear(input);
    await user.type(input, "Updated content");

    expect(onSectionChange).toHaveBeenCalledWith("overview", "Updated content");
  });
});
