import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useConversationScroll } from "./useConversationScroll";

interface Row {
  id: number;
  height: number;
}

function rows(first: number, last: number): Row[] {
  return Array.from({ length: last - first + 1 }, (_, index) => ({
    id: first + index,
    height: 24 + ((first + index) % 3) * 7,
  }));
}

/** Render the real scroll hook with configurable rows, task scope, and tab visibility. */
function Conversation({
  entries,
  scope = "task-a",
  visible = true,
}: {
  entries: Row[];
  scope?: string;
  visible?: boolean;
}) {
  const scroll = useConversationScroll({
    scope,
    visible,
    ready: true,
    contentKey: entries.map((entry) => entry.id).join(","),
  });
  return (
    <>
      <div
        data-testid="conversation"
        ref={scroll.containerRef}
        onScroll={scroll.handleScroll}
        hidden={!visible}
      >
        {entries.map((entry) => (
          <div key={entry.id} data-conversation-entry={String(entry.id)} data-height={entry.height}>
            Message {entry.id}
          </div>
        ))}
      </div>
      <button type="button" onClick={scroll.beforeHistoryChange}>
        Earlier messages
      </button>
      {scroll.showJumpToLatest && (
        <button type="button" onClick={scroll.jumpToLatest}>
          Jump to latest
        </button>
      )}
    </>
  );
}

let frames: Map<number, FrameRequestCallback>;

beforeEach(() => {
  frames = new Map();
  let frameId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  const nativeHeight = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")?.get;
  const nativeClientHeight = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "clientHeight"
  )?.get;
  const nativeRect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
    this: HTMLElement
  ) {
    return this.dataset.testid === "conversation"
      ? [...this.children].reduce(
          (sum, child) => sum + Number((child as HTMLElement).dataset.height),
          0
        )
      : (nativeHeight?.call(this) ?? 0);
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
    this: HTMLElement
  ) {
    return this.dataset.testid === "conversation"
      ? this.hidden
        ? 0
        : 180
      : (nativeClientHeight?.call(this) ?? 0);
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement
  ) {
    const container = this.closest<HTMLElement>('[data-testid="conversation"]');
    if (!container) return nativeRect.call(this);
    const entries = [...container.children] as HTMLElement[];
    const preceding = this === container ? [] : entries.slice(0, entries.indexOf(this));
    const top =
      20 +
      (this === container
        ? 0
        : preceding.reduce((sum, entry) => sum + Number(entry.dataset.height), 0) -
          container.scrollTop);
    const height = this === container ? container.clientHeight : Number(this.dataset.height);
    return {
      top,
      bottom: top + height,
      left: 0,
      right: 400,
      width: 400,
      height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    };
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Position an older row at a known viewport offset before testing retention and history changes. */
function readAt(id: number, clipped = 11) {
  const container = screen.getByTestId("conversation");
  const row = screen.getByText("Message " + id);
  container.scrollTop += row.getBoundingClientRect().top - 20 + clipped;
  fireEvent.scroll(container);
  return { container, row, offset: row.getBoundingClientRect().top - 20 };
}

function flushFrames() {
  act(() => {
    const queued = [...frames.values()];
    frames.clear();
    queued.forEach((callback) => callback(0));
  });
}

describe("useConversationScroll", () => {
  it("keeps the same visible row and offset when live messages trim the 200-message window", () => {
    const view = render(<Conversation entries={rows(1, 200)} />);
    const { container, row, offset } = readAt(70);
    const previousTop = container.scrollTop;

    view.rerender(<Conversation entries={rows(2, 201)} />);
    expect(row.getBoundingClientRect().top - 20).toBe(offset);
    expect(container.scrollTop).toBe(previousTop - rows(1, 1)[0].height);
    view.rerender(<Conversation entries={rows(4, 203)} />);
    expect(row.getBoundingClientRect().top - 20).toBe(offset);
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeInTheDocument();
  });

  it("retains the history reading anchor through a live update before the earlier page arrives", () => {
    const view = render(<Conversation entries={rows(40, 79)} />);
    const { row, offset } = readAt(60, 5);
    fireEvent.click(screen.getByRole("button", { name: "Earlier messages" }));

    view.rerender(<Conversation entries={rows(40, 80)} />);
    expect(row.getBoundingClientRect().top - 20).toBe(offset);
    view.rerender(<Conversation entries={rows(1, 80)} />);
    expect(row.getBoundingClientRect().top - 20).toBe(offset);
  });

  it("restores the visible row after live retention changes while Work hides the discussion", () => {
    const view = render(<Conversation entries={rows(1, 200)} />);
    const { container, row, offset } = readAt(70);
    view.rerender(<Conversation entries={rows(1, 200)} visible={false} />);
    container.scrollTop = 0;
    fireEvent.scroll(container);
    view.rerender(<Conversation entries={rows(6, 205)} visible={false} />);
    view.rerender(<Conversation entries={rows(6, 205)} />);

    expect(row.getBoundingClientRect().top - 20).toBe(offset);
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeInTheDocument();
  });

  it("follows new messages for a pinned reader and returns to following after an explicit jump", () => {
    const view = render(<Conversation entries={rows(1, 20)} />);
    const container = screen.getByTestId("conversation");
    expect(container.scrollTop).toBe(container.scrollHeight - container.clientHeight);
    view.rerender(<Conversation entries={rows(1, 21)} />);
    expect(container.scrollTop).toBe(container.scrollHeight - container.clientHeight);

    readAt(5);
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    flushFrames();
    expect(container.scrollTop).toBe(container.scrollHeight - container.clientHeight);
    view.rerender(<Conversation entries={rows(1, 22)} />);
    expect(container.scrollTop).toBe(container.scrollHeight - container.clientHeight);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).not.toBeInTheDocument();
  });

  it("resets each task to latest and ignores an earlier task's queued jump", () => {
    const view = render(<Conversation entries={rows(1, 20)} />);
    readAt(5);
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    view.rerender(<Conversation entries={rows(101, 120)} scope="task-b" />);
    const container = screen.getByTestId("conversation");
    expect(container.scrollTop).toBe(container.scrollHeight - container.clientHeight);
    const { row, offset } = readAt(105);
    flushFrames();

    expect(row.getBoundingClientRect().top - 20).toBe(offset);
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeInTheDocument();
  });
});
