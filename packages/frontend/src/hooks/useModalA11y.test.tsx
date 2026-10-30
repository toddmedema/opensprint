import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useRef, useState } from "react";
import { useModalA11y } from "./useModalA11y";

/** jsdom often reports offsetParent as null; getFocusableElements skips those nodes. */
const offsetParentDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return (this as HTMLElement).parentElement ?? document.body;
    },
  });
});
afterAll(() => {
  if (offsetParentDesc) {
    Object.defineProperty(HTMLElement.prototype, "offsetParent", offsetParentDesc);
  }
});

function TestModal({ onClose }: { onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  useModalA11y({ containerRef, onClose, isOpen: true });

  return (
    <div role="dialog" ref={containerRef} aria-modal="true" aria-label="Test modal">
      <button type="button" onClick={onClose}>
        Close
      </button>
      <button type="button">Action</button>
    </div>
  );
}

function TestModalWithInitialFocus({ onClose }: { onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  useModalA11y({ containerRef, onClose, isOpen: true, initialFocusRef: actionRef });

  return (
    <div role="dialog" ref={containerRef} aria-modal="true" aria-label="Test modal">
      <button type="button" onClick={onClose}>
        Close
      </button>
      <button type="button" ref={actionRef}>
        Action
      </button>
    </div>
  );
}

describe("useModalA11y", () => {
  it("calls onClose when Escape is pressed", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(<TestModal onClose={onClose} />);

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("focuses initialFocusRef instead of the first focusable control", async () => {
    render(<TestModalWithInitialFocus onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Action" })).toHaveFocus();
    });
  });

  it("wraps Tab from last to first focusable inside the modal", () => {
    render(<TestModal onClose={vi.fn()} />);

    const closeBtn = screen.getByRole("button", { name: "Close" });
    const actionBtn = screen.getByRole("button", { name: "Action" });

    actionBtn.focus();
    fireEvent.keyDown(actionBtn, { key: "Tab", bubbles: true, cancelable: true });
    expect(closeBtn).toHaveFocus();
  });

  it("wraps Shift+Tab from first to last focusable inside the modal", () => {
    render(<TestModal onClose={vi.fn()} />);

    const closeBtn = screen.getByRole("button", { name: "Close" });
    const actionBtn = screen.getByRole("button", { name: "Action" });

    closeBtn.focus();
    fireEvent.keyDown(closeBtn, {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    expect(actionBtn).toHaveFocus();
  });
});

function NestedDialogs({
  parentClose,
  childClose,
}: {
  parentClose: () => void;
  childClose: () => void;
}) {
  const [parentOpen, setParentOpen] = useState(false);
  const [childOpen, setChildOpen] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);
  const childRef = useRef<HTMLDivElement>(null);
  useModalA11y({
    containerRef: parentRef,
    isOpen: parentOpen,
    onClose: () => {
      parentClose();
      setParentOpen(false);
    },
  });
  useModalA11y({
    containerRef: childRef,
    isOpen: childOpen,
    onClose: () => {
      childClose();
      setChildOpen(false);
    },
  });
  return (
    <>
      <button onClick={() => setParentOpen(true)}>Open parent</button>
      {parentOpen && (
        <div role="dialog" aria-label="Parent" ref={parentRef} tabIndex={-1}>
          <button onClick={() => setChildOpen(true)}>Open child</button>
          <button>Parent last</button>
          {childOpen && (
            <div role="dialog" aria-label="Child" ref={childRef} tabIndex={-1}>
              <input aria-label="Child first" />
              <input aria-label="Child last" />
            </div>
          )}
        </div>
      )}
    </>
  );
}

describe("modal focus ownership", () => {
  it("keeps focus through callback rerenders and calls the latest close callback", async () => {
    const firstClose = vi.fn();
    const latestClose = vi.fn();
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const view = render(<TestModal onClose={firstClose} />);
    const action = screen.getByRole("button", { name: "Action" });
    action.focus();
    view.rerender(<TestModal onClose={latestClose} />);
    expect(action).toHaveFocus();
    fireEvent.keyDown(action, { key: "Escape" });
    expect(firstClose).not.toHaveBeenCalled();
    expect(latestClose).toHaveBeenCalledTimes(1);
    view.unmount();
    await waitFor(() => expect(trigger).toHaveFocus());
    trigger.remove();
  });

  it("traps only the nested dialog and restores child then parent opening focus in StrictMode", async () => {
    const parentClose = vi.fn();
    const childClose = vi.fn();
    const user = userEvent.setup();
    render(
      <StrictMode>
        <NestedDialogs parentClose={parentClose} childClose={childClose} />
      </StrictMode>
    );
    const externalTrigger = screen.getByRole("button", { name: "Open parent" });
    await user.click(externalTrigger);
    const childTrigger = screen.getByRole("button", { name: "Open child" });
    await user.click(childTrigger);
    const last = screen.getByRole("textbox", { name: "Child last" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab", cancelable: true });
    expect(screen.getByRole("textbox", { name: "Child first" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true, cancelable: true });
    expect(last).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(childClose).toHaveBeenCalledTimes(1);
    expect(parentClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Parent" })).toBeInTheDocument();
    await waitFor(() => expect(childTrigger).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(parentClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(externalTrigger).toHaveFocus());
  });
});

it("restores the original opening trigger after an initially open StrictMode session", async () => {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  const view = render(
    <StrictMode>
      <TestModal onClose={vi.fn()} />
    </StrictMode>
  );
  expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  view.unmount();
  await waitFor(() => expect(trigger).toHaveFocus());
  trigger.remove();
});
