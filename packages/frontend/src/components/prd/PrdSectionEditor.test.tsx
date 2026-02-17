import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { PrdSectionEditor } from "./PrdSectionEditor";

vi.mock("../../lib/markdownUtils", () => ({
  markdownToHtml: vi.fn((md: string) =>
    Promise.resolve(md ? `<p>${md}</p>` : "<p><br></p>"),
  ),
  htmlToMarkdown: vi.fn((html: string) => {
    const div = document.createElement("div");
    div.innerHTML = html;
    return div.textContent ?? "";
  }),
}));

describe("PrdSectionEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders section content from markdown", async () => {
    render(
      <PrdSectionEditor
        sectionKey="overview"
        markdown="Hello world"
        onSave={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Hello world")).toBeInTheDocument();
    });
  });

  it("calls onSave with markdown when content changes (debounced)", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    const { container } = render(
      <PrdSectionEditor
        sectionKey="overview"
        markdown="Initial"
        onSave={onSave}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Initial")).toBeInTheDocument();
    });

    const editor = container.querySelector("[contenteditable]");
    expect(editor).toBeTruthy();
    if (editor) {
      (editor as HTMLElement).innerHTML = "<p>Initial and more</p>";
      (editor as HTMLElement).dispatchEvent(new Event("input", { bubbles: true }));
    }

    expect(onSave).not.toHaveBeenCalled();
    vi.advanceTimersByTime(850);
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith("overview", "Initial and more");
    });
    vi.useRealTimers();
  });

  it("is not editable when disabled", async () => {
    render(
      <PrdSectionEditor
        sectionKey="overview"
        markdown="Content"
        onSave={vi.fn()}
        disabled
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Content")).toBeInTheDocument();
    });

    const editable = document.querySelector("[contenteditable=true]");
    expect(editable).toBeNull();
  });

  it("syncs content from markdown prop when it changes (e.g. after API save)", async () => {
    const { rerender } = render(
      <PrdSectionEditor
        sectionKey="overview"
        markdown="Original"
        onSave={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Original")).toBeInTheDocument();
    });

    rerender(
      <PrdSectionEditor
        sectionKey="overview"
        markdown="Updated from API"
        onSave={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Updated from API")).toBeInTheDocument();
    });
  });
});
