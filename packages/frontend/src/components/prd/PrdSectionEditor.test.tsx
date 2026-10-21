import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { PrdSectionEditor } from "./PrdSectionEditor";

vi.mock("../../lib/mermaidDiagram", () => ({
  renderMermaidDiagrams: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../lib/markdownUtils", () => ({
  markdownToHtml: vi.fn((md: string) => Promise.resolve(md ? `<p>${md}</p>` : "<p><br></p>")),
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders section content from markdown", async () => {
    render(<PrdSectionEditor sectionKey="overview" markdown="Hello world" onSave={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Hello world")).toBeInTheDocument();
    });
  });

  it("retains the revision captured at the first edit when refreshed props arrive", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <PrdSectionEditor sectionKey="overview" markdown="Original" revision={1} onSave={onSave} />
    );
    await waitFor(() => expect(screen.getByText("Original")).toBeInTheDocument());
    vi.useFakeTimers();
    const editor = screen.getByRole("textbox");
    editor.focus();
    editor.innerHTML = "<p>My pending edit</p>";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    view.rerender(
      <PrdSectionEditor
        sectionKey="overview"
        markdown="Other participant edit"
        revision={2}
        onSave={onSave}
      />
    );
    vi.advanceTimersByTime(900);
    expect(onSave).toHaveBeenCalledWith("overview", "My pending edit", 1);
    expect(editor).toHaveTextContent("My pending edit");
    view.unmount();
  });

  it("calls onSave with markdown when content changes (debounced)", async () => {
    const onSave = vi.fn();
    const { container } = render(
      <PrdSectionEditor sectionKey="overview" markdown="Initial" onSave={onSave} />
    );

    await waitFor(() => {
      expect(screen.getByText("Initial")).toBeInTheDocument();
    });

    vi.useFakeTimers();

    const editor = container.querySelector("[contenteditable]");
    expect(editor).toBeTruthy();
    if (editor) {
      (editor as HTMLElement).innerHTML = "<p>Initial and more</p>";
      (editor as HTMLElement).dispatchEvent(new Event("input", { bubbles: true }));
    }

    expect(onSave).not.toHaveBeenCalled();
    vi.advanceTimersByTime(850);
    expect(onSave).toHaveBeenCalledWith("overview", "Initial and more");
  });

  it("debounces multiple rapid keystrokes to a single save (no per-keystroke saves)", async () => {
    const onSave = vi.fn();
    const { container } = render(
      <PrdSectionEditor sectionKey="overview" markdown="A" onSave={onSave} />
    );

    await waitFor(() => {
      expect(screen.getByText("A")).toBeInTheDocument();
    });

    vi.useFakeTimers();

    const editor = container.querySelector("[contenteditable]") as HTMLElement;
    expect(editor).toBeTruthy();

    // Simulate rapid typing: A -> AB -> ABC -> ABCD
    (editor as HTMLElement).innerHTML = "<p>AB</p>";
    (editor as HTMLElement).dispatchEvent(new Event("input", { bubbles: true }));
    (editor as HTMLElement).innerHTML = "<p>ABC</p>";
    (editor as HTMLElement).dispatchEvent(new Event("input", { bubbles: true }));
    (editor as HTMLElement).innerHTML = "<p>ABCD</p>";
    (editor as HTMLElement).dispatchEvent(new Event("input", { bubbles: true }));

    expect(onSave).not.toHaveBeenCalled();

    vi.advanceTimersByTime(850);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("overview", "ABCD");
  });

  it("is not editable when disabled", async () => {
    render(<PrdSectionEditor sectionKey="overview" markdown="Content" onSave={vi.fn()} disabled />);

    await waitFor(() => {
      expect(screen.getByText("Content")).toBeInTheDocument();
    });

    const editable = document.querySelector("[contenteditable=true]");
    expect(editable).toBeNull();
  });

  it("syncs content from markdown prop when it changes (e.g. after API save)", async () => {
    const { rerender } = render(
      <PrdSectionEditor sectionKey="overview" markdown="Original" onSave={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText("Original")).toBeInTheDocument();
    });

    rerender(
      <PrdSectionEditor sectionKey="overview" markdown="Updated from API" onSave={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText("Updated from API")).toBeInTheDocument();
    });
  });

  it("does not overwrite content when section has focus (WebSocket conflict avoidance)", async () => {
    const { rerender, container } = render(
      <PrdSectionEditor sectionKey="overview" markdown="Original" onSave={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText("Original")).toBeInTheDocument();
    });

    const editor = container.querySelector("[contenteditable]") as HTMLElement;
    editor.focus();
    expect(document.activeElement).toBe(editor);

    rerender(
      <PrdSectionEditor
        sectionKey="overview"
        markdown="Overwritten by WebSocket"
        onSave={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(editor.textContent).toContain("Original");
      expect(editor.textContent).not.toContain("Overwritten by WebSocket");
    });
  });

  it("flushes pending save when markdown prop changes with unsaved edits", async () => {
    const onSave = vi.fn();
    const { rerender, container } = render(
      <PrdSectionEditor sectionKey="overview" markdown="Original" onSave={onSave} />
    );

    await waitFor(() => {
      expect(screen.getByText("Original")).toBeInTheDocument();
    });

    vi.useFakeTimers();

    const editor = container.querySelector("[contenteditable]") as HTMLElement;
    (editor as HTMLElement).innerHTML = "<p>User editing in progress</p>";
    (editor as HTMLElement).dispatchEvent(new Event("input", { bubbles: true }));

    expect(onSave).not.toHaveBeenCalled();

    rerender(
      <PrdSectionEditor sectionKey="overview" markdown="Updated from WebSocket" onSave={onSave} />
    );

    expect(onSave).toHaveBeenCalledWith("overview", "User editing in progress");
  });

  it("has theme-aware prose styling for readable text in light and dark mode", async () => {
    const { container } = render(
      <PrdSectionEditor sectionKey="overview" markdown="Content" onSave={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText("Content")).toBeInTheDocument();
    });

    const editor = container.querySelector("[contenteditable]");
    expect(editor).toBeTruthy();
    expect(editor?.className).toMatch(/text-theme-text/);
    expect(editor?.className).toMatch(/prose-code:text-theme-text/);
  });

  it("uses lightMode prose (no dark:prose-invert) but dark selection highlight for plan embed", async () => {
    const { container } = render(
      <PrdSectionEditor sectionKey="overview" markdown="Content" onSave={vi.fn()} lightMode />
    );

    await waitFor(() => {
      expect(screen.getByText("Content")).toBeInTheDocument();
    });

    const editor = container.querySelector("[contenteditable]");
    expect(editor).toBeTruthy();
    expect(editor?.className).toMatch(/text-theme-text/);
    expect(editor?.className).not.toMatch(/dark:prose-invert/);
    expect(editor?.className).toMatch(/dark:selection:bg-brand-900\/40/);
  });

  it("flushes pending save on unmount so edits persist when navigating away", async () => {
    const onSave = vi.fn();
    const { unmount, container } = render(
      <PrdSectionEditor sectionKey="overview" markdown="Initial" onSave={onSave} />
    );

    await waitFor(() => {
      expect(screen.getByText("Initial")).toBeInTheDocument();
    });

    vi.useFakeTimers();

    const editor = container.querySelector("[contenteditable]") as HTMLElement;
    (editor as HTMLElement).innerHTML = "<p>Edited but not yet saved</p>";
    (editor as HTMLElement).dispatchEvent(new Event("input", { bubbles: true }));

    expect(onSave).not.toHaveBeenCalled();

    unmount();

    expect(onSave).toHaveBeenCalledWith("overview", "Edited but not yet saved");
  });
});
