import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PrdChatPanel } from "./PrdChatPanel";

const defaultProps = {
  open: true,
  onOpenChange: vi.fn(),
  messages: [],
  sending: false,
  error: null,
  onDismissError: vi.fn(),
  selectionContext: null,
  onClearSelectionContext: vi.fn(),
  onSend: vi.fn(),
};

describe("PrdChatPanel", () => {
  it("renders Close button (X icon) in header when open", () => {
    render(<PrdChatPanel {...defaultProps} />);

    const closeBtn = screen.getByRole("button", { name: "Close chat panel" });
    expect(closeBtn).toBeInTheDocument();
  });

  it("calls onOpenChange and onClearSelectionContext when close button is clicked", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onClearSelectionContext = vi.fn();
    render(
      <PrdChatPanel
        {...defaultProps}
        onOpenChange={onOpenChange}
        onClearSelectionContext={onClearSelectionContext}
      />
    );

    await user.click(screen.getByRole("button", { name: "Close chat panel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onClearSelectionContext).toHaveBeenCalled();
  });

  it("renders Clear selection button when selectionContext is set", () => {
    render(
      <PrdChatPanel
        {...defaultProps}
        selectionContext={{ text: "Some text", section: "executive_summary" }}
      />
    );

    const clearBtn = screen.getByRole("button", { name: "Clear selection" });
    expect(clearBtn).toBeInTheDocument();
  });

  it("renders as inline sidebar with Discuss title when variant is inline", () => {
    render(<PrdChatPanel {...defaultProps} variant="inline" />);

    expect(screen.getByTestId("prd-chat-sidebar")).toBeInTheDocument();
    expect(screen.getByText("Discuss")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close chat panel" })).not.toBeInTheDocument();
  });

  it("shows collapse button when inline and onCollapsedChange is provided", () => {
    const onCollapsedChange = vi.fn();
    render(
      <PrdChatPanel
        {...defaultProps}
        variant="inline"
        collapsed={false}
        onCollapsedChange={onCollapsedChange}
      />,
    );

    const collapseBtn = screen.getByRole("button", { name: "Collapse Discuss sidebar" });
    expect(collapseBtn).toBeInTheDocument();
  });

  it("calls onCollapsedChange(true) when collapse button is clicked", async () => {
    const user = userEvent.setup();
    const onCollapsedChange = vi.fn();
    render(
      <PrdChatPanel
        {...defaultProps}
        variant="inline"
        collapsed={false}
        onCollapsedChange={onCollapsedChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Collapse Discuss sidebar" }));

    expect(onCollapsedChange).toHaveBeenCalledWith(true);
  });

  it("renders collapsed bar with expand button when inline and collapsed", () => {
    render(
      <PrdChatPanel
        {...defaultProps}
        variant="inline"
        collapsed={true}
        onCollapsedChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId("prd-chat-sidebar")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand Discuss sidebar" })).toBeInTheDocument();
    expect(screen.queryByText("Discuss")).not.toBeInTheDocument();
  });

  it("pins expand toggle to top when collapsed (justify-start pt-3)", () => {
    const { container } = render(
      <PrdChatPanel
        {...defaultProps}
        variant="inline"
        collapsed={true}
        onCollapsedChange={vi.fn()}
      />,
    );

    const sidebar = container.querySelector('[data-testid="prd-chat-sidebar"]');
    expect(sidebar).toHaveClass("justify-start");
    expect(sidebar).toHaveClass("pt-3");
  });

  it("keeps expand toggle pinned with min-h-0 and shrink-0 when collapsed", () => {
    const { container } = render(
      <PrdChatPanel
        {...defaultProps}
        variant="inline"
        collapsed={true}
        onCollapsedChange={vi.fn()}
      />,
    );

    const sidebar = container.querySelector('[data-testid="prd-chat-sidebar"]');
    expect(sidebar).toHaveClass("min-h-0");
    const expandBtn = screen.getByRole("button", { name: "Expand Discuss sidebar" });
    expect(expandBtn).toHaveClass("shrink-0");
  });

  it("pins header with collapse toggle to top when expanded (sticky top-0)", () => {
    render(
      <PrdChatPanel
        {...defaultProps}
        variant="inline"
        collapsed={false}
        onCollapsedChange={vi.fn()}
      />,
    );

    const header = screen.getByTestId("prd-chat-header");
    expect(header).toHaveClass("sticky");
    expect(header).toHaveClass("top-0");
    expect(screen.getByRole("button", { name: "Collapse Discuss sidebar" })).toBeInTheDocument();
  });

  it("expanded inline sidebar has min-h-0 for proper flex containment", () => {
    const { container } = render(
      <PrdChatPanel
        {...defaultProps}
        variant="inline"
        collapsed={false}
        onCollapsedChange={vi.fn()}
      />,
    );

    const sidebar = container.querySelector('[data-testid="prd-chat-sidebar"]');
    expect(sidebar).toHaveClass("min-h-0");
  });

  it("calls onCollapsedChange(false) when expand button is clicked in collapsed state", async () => {
    const user = userEvent.setup();
    const onCollapsedChange = vi.fn();
    render(
      <PrdChatPanel
        {...defaultProps}
        variant="inline"
        collapsed={true}
        onCollapsedChange={onCollapsedChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Expand Discuss sidebar" }));

    expect(onCollapsedChange).toHaveBeenCalledWith(false);
  });

  it("applies dark mode classes when html has data-theme=dark", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    render(
      <PrdChatPanel
        {...defaultProps}
        variant="inline"
        messages={[{ role: "assistant", content: "Hello", timestamp: "" }]}
      />,
    );

    const sidebar = screen.getByTestId("prd-chat-sidebar");
    expect(sidebar).toHaveClass("dark:bg-gray-800");
    expect(sidebar).toHaveClass("dark:border-gray-700");

    const assistantBubble = screen.getByText("Hello").closest("div");
    expect(assistantBubble).toHaveClass("dark:bg-gray-700");
    expect(assistantBubble).toHaveClass("dark:text-gray-200");

    document.documentElement.removeAttribute("data-theme");
  });
});
