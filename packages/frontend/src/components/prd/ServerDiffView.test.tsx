import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ServerDiffView, INITIAL_DIFF_LINE_CAP } from "./ServerDiffView";

const mockDiff = {
  lines: [
    { type: "context" as const, text: "First line", oldLineNumber: 1, newLineNumber: 1 },
    { type: "remove" as const, text: "Removed line", oldLineNumber: 2, newLineNumber: undefined },
    { type: "add" as const, text: "Added line", oldLineNumber: undefined, newLineNumber: 2 },
    { type: "context" as const, text: "Last line", oldLineNumber: 3, newLineNumber: 3 },
  ],
  summary: { additions: 1, deletions: 1 },
};

describe("ServerDiffView", () => {
  it("renders with mock diff lines", () => {
    render(<ServerDiffView diff={mockDiff} />);
    expect(screen.getByTestId("server-diff-view")).toBeInTheDocument();
    expect(screen.getByText("First line")).toBeInTheDocument();
    expect(screen.getByText(/Removed line/)).toBeInTheDocument();
    expect(screen.getByText(/Added line/)).toBeInTheDocument();
    expect(screen.getByText("Last line")).toBeInTheDocument();
  });

  it("renders title when fromVersion and toVersion are provided", () => {
    render(
      <ServerDiffView
        diff={mockDiff}
        fromVersion="v1"
        toVersion="current"
      />
    );
    expect(screen.getByText("v1 → current")).toBeInTheDocument();
  });

  it("renders summary in title when version props and summary present", () => {
    render(
      <ServerDiffView
        diff={mockDiff}
        fromVersion="v1"
        toVersion="current"
      />
    );
    expect(screen.getByText(/\+1 −1/)).toBeInTheDocument();
  });

  it("renders summary only (no title) when no version props", () => {
    render(<ServerDiffView diff={mockDiff} />);
    expect(screen.getByText(/\+1 −1/)).toBeInTheDocument();
  });

  it("renders No changes when lines are empty", () => {
    render(<ServerDiffView diff={{ lines: [] }} />);
    expect(screen.getByTestId("server-diff-no-changes")).toHaveTextContent("No changes");
  });

  it("uses aria labels for added/removed/context lines", () => {
    render(<ServerDiffView diff={mockDiff} />);
    const list = screen.getByRole("list", { name: "Diff lines" });
    expect(list).toBeInTheDocument();
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveAttribute("aria-label", expect.stringContaining("Context line"));
    expect(items[1]).toHaveAttribute("aria-label", expect.stringContaining("Removed line"));
    expect(items[2]).toHaveAttribute("aria-label", expect.stringContaining("Added line"));
    expect(items[3]).toHaveAttribute("aria-label", expect.stringContaining("Context line"));
  });

  it("applies data-line-type for add, remove, context", () => {
    render(<ServerDiffView diff={mockDiff} />);
    expect(screen.getByText("First line").closest("[data-line-type]")).toHaveAttribute("data-line-type", "context");
    expect(screen.getByText(/Removed line/).closest("[data-line-type]")).toHaveAttribute("data-line-type", "remove");
    expect(screen.getByText(/Added line/).closest("[data-line-type]")).toHaveAttribute("data-line-type", "add");
  });

  it("supports keyboard navigation (ArrowDown, ArrowUp)", async () => {
    const user = userEvent.setup();
    render(<ServerDiffView diff={mockDiff} />);
    const container = screen.getByRole("list", { name: "Diff lines" });
    container.focus();
    expect(container).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    const items = within(container).getAllByRole("listitem");
    expect(items[0]).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(items[1]).toHaveFocus();

    await user.keyboard("{ArrowUp}");
    expect(items[0]).toHaveFocus();
  });

  it("supports Home and End keys", async () => {
    const user = userEvent.setup();
    render(<ServerDiffView diff={mockDiff} />);
    const container = screen.getByRole("list", { name: "Diff lines" });
    container.focus();
    await user.keyboard("{End}");
    const items = within(container).getAllByRole("listitem");
    expect(items[items.length - 1]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(items[0]).toHaveFocus();
  });

  it("renders line numbers for old and new", () => {
    render(<ServerDiffView diff={mockDiff} />);
    const view = screen.getByTestId("server-diff-view");
    // Line number columns render 1, 2, 3 for old/new
    expect(view.textContent).toContain("1");
    expect(view.textContent).toContain("2");
    expect(view.textContent).toContain("3");
  });

  it("renders diff without summary", () => {
    const diffNoSummary = { lines: mockDiff.lines };
    render(<ServerDiffView diff={diffNoSummary} />);
    expect(screen.getByTestId("server-diff-view")).toBeInTheDocument();
    expect(screen.queryByText(/\+1 −1/)).not.toBeInTheDocument();
  });

  it("does not show Show more for normal-sized diff (under cap)", () => {
    render(<ServerDiffView diff={mockDiff} />);
    expect(screen.queryByTestId("server-diff-show-more")).not.toBeInTheDocument();
    expect(screen.getByText("Last line")).toBeInTheDocument();
  });

  it("caps very large diff initially and shows Show more button", () => {
    const manyLines = Array.from({ length: INITIAL_DIFF_LINE_CAP + 10 }, (_, i) => ({
      type: "context" as const,
      text: `Line ${i + 1}`,
      oldLineNumber: i + 1,
      newLineNumber: i + 1,
    }));
    const largeDiff = { lines: manyLines };
    render(<ServerDiffView diff={largeDiff} />);
    expect(screen.getByTestId("server-diff-show-more")).toBeInTheDocument();
    expect(screen.getByText(/Show more \(10 more lines\)/)).toBeInTheDocument();
    expect(screen.getByText("Line 1")).toBeInTheDocument();
    expect(screen.getByText(`Line ${INITIAL_DIFF_LINE_CAP}`)).toBeInTheDocument();
    expect(screen.queryByText(`Line ${INITIAL_DIFF_LINE_CAP + 1}`)).not.toBeInTheDocument();
  });

  it("expands to show all lines when Show more is clicked", async () => {
    const user = userEvent.setup();
    const manyLines = Array.from({ length: INITIAL_DIFF_LINE_CAP + 5 }, (_, i) => ({
      type: "context" as const,
      text: `Row ${i + 1}`,
      oldLineNumber: i + 1,
      newLineNumber: i + 1,
    }));
    render(<ServerDiffView diff={{ lines: manyLines }} />);
    const showMore = screen.getByTestId("server-diff-show-more");
    expect(showMore).toBeInTheDocument();
    await user.click(showMore);
    expect(screen.queryByTestId("server-diff-show-more")).not.toBeInTheDocument();
    expect(screen.getByText(`Row ${INITIAL_DIFF_LINE_CAP + 5}`)).toBeInTheDocument();
  });
});
