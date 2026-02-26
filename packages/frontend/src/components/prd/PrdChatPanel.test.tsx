import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PrdChatPanel } from "./PrdChatPanel";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const defaultProps = {
  open: true,
  onOpenChange: vi.fn(),
  messages: [],
  sending: false,
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

  it("shows Chatting with Dreamer header in floating variant (no subtext or tooltip)", () => {
    render(<PrdChatPanel {...defaultProps} />);

    expect(screen.getByText("Chatting with Dreamer")).toBeInTheDocument();
    expect(screen.queryByTestId("prd-chat-agent-description")).not.toBeInTheDocument();
  });

  it("chat header has no tooltip on hover", () => {
    render(<PrdChatPanel {...defaultProps} />);

    const agentLabel = screen.getByText("Chatting with Dreamer");
    expect(agentLabel).not.toHaveAttribute("title");
    expect(agentLabel.closest("[title]")).toBeNull();
  });

  it("shows agent-specific header when agentRole prop is provided", () => {
    render(<PrdChatPanel {...defaultProps} agentRole="planner" />);

    expect(screen.getByText("Chatting with Planner")).toBeInTheDocument();
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

  it("renders as inline sidebar with Chatting with Dreamer header when variant is inline", () => {
    render(<PrdChatPanel {...defaultProps} variant="inline" />);

    expect(screen.getByTestId("prd-chat-sidebar")).toBeInTheDocument();
    expect(screen.getByText("Chatting with Dreamer")).toBeInTheDocument();
    expect(screen.queryByTestId("prd-chat-agent-description")).not.toBeInTheDocument();
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
      />
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
      />
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
      />
    );

    expect(screen.getByTestId("prd-chat-sidebar")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand Discuss sidebar" })).toBeInTheDocument();
    expect(screen.queryByText("Chatting with Dreamer")).not.toBeInTheDocument();
  });

  it("pins expand toggle to top when collapsed (justify-start pt-3)", () => {
    const { container } = render(
      <PrdChatPanel
        {...defaultProps}
        variant="inline"
        collapsed={true}
        onCollapsedChange={vi.fn()}
      />
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
      />
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
      />
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
      />
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
      />
    );

    await user.click(screen.getByRole("button", { name: "Expand Discuss sidebar" }));

    expect(onCollapsedChange).toHaveBeenCalledWith(false);
  });

  it("applies smooth width transition when opening/closing inline sidebar", () => {
    const { container } = render(
      <PrdChatPanel
        {...defaultProps}
        variant="inline"
        collapsed={false}
        onCollapsedChange={vi.fn()}
      />
    );

    const sidebar = container.querySelector('[data-testid="prd-chat-sidebar"]');
    expect(sidebar).toHaveClass("transition-[width]");
    expect(sidebar).toHaveClass("duration-200");
    expect(sidebar).toHaveClass("ease-out");
  });

  describe("Discuss sidebar initial scroll", () => {
    it("scrolls to bottom on initial render when inline with messages", async () => {
      const messages = [
        { role: "user", content: "Hello", timestamp: "" },
        { role: "assistant", content: "Hi there!", timestamp: "" },
      ];
      const { rerender } = render(
        <PrdChatPanel {...defaultProps} variant="inline" collapsed={false} messages={messages} />
      );

      const scrollEl = screen.getByTestId("prd-chat-messages");
      Object.defineProperty(scrollEl, "scrollHeight", { value: 200, configurable: true });
      Object.defineProperty(scrollEl, "clientHeight", { value: 100, configurable: true });

      rerender(
        <PrdChatPanel
          {...defaultProps}
          variant="inline"
          collapsed={false}
          messages={[...messages]}
        />
      );

      await new Promise((r) => requestAnimationFrame(r));

      expect(scrollEl.scrollTop).toBe(100);
    });

    it("scrolls to bottom on initial render when inline with empty messages", () => {
      render(<PrdChatPanel {...defaultProps} variant="inline" collapsed={false} messages={[]} />);

      const scrollEl = screen.getByTestId("prd-chat-messages");
      expect(scrollEl).toBeInTheDocument();
      expect(scrollEl.scrollTop).toBe(0);
    });

    it("scrolls to bottom when expanding sidebar from collapsed", async () => {
      const onCollapsedChange = vi.fn();
      const messages = [
        { role: "user", content: "Hello", timestamp: "" },
        { role: "assistant", content: "Hi!", timestamp: "" },
      ];

      const { rerender } = render(
        <PrdChatPanel
          {...defaultProps}
          variant="inline"
          collapsed={true}
          onCollapsedChange={onCollapsedChange}
          messages={messages}
        />
      );

      rerender(
        <PrdChatPanel
          {...defaultProps}
          variant="inline"
          collapsed={false}
          onCollapsedChange={onCollapsedChange}
          messages={messages}
        />
      );

      const scrollEl = screen.getByTestId("prd-chat-messages");
      Object.defineProperty(scrollEl, "scrollHeight", { value: 150, configurable: true });
      Object.defineProperty(scrollEl, "clientHeight", { value: 80, configurable: true });

      rerender(
        <PrdChatPanel
          {...defaultProps}
          variant="inline"
          collapsed={false}
          onCollapsedChange={onCollapsedChange}
          messages={[...messages]}
        />
      );

      await new Promise((r) => requestAnimationFrame(r));

      expect(scrollEl.scrollTop).toBe(70);
    });
  });

  describe("when Dreamer is running (sending=true)", () => {
    it("keeps input enabled so user can compose next message", () => {
      render(
        <PrdChatPanel
          {...defaultProps}
          variant="inline"
          collapsed={false}
          onCollapsedChange={vi.fn()}
          sending={true}
        />
      );

      const input = screen.getByRole("textbox", { name: "Discuss message" });
      expect(input).not.toBeDisabled();
    });

    it("keeps Send button disabled while Dreamer is responding", () => {
      render(
        <PrdChatPanel
          {...defaultProps}
          variant="inline"
          collapsed={false}
          onCollapsedChange={vi.fn()}
          sending={true}
        />
      );

      const sendButton = screen.getByRole("button", { name: "Send" });
      expect(sendButton).toBeDisabled();
    });

    it("shows tooltip on disabled Send when Dreamer is responding", () => {
      render(
        <PrdChatPanel
          {...defaultProps}
          variant="inline"
          collapsed={false}
          onCollapsedChange={vi.fn()}
          sending={true}
        />
      );

      const sendButton = screen.getByRole("button", { name: "Send" });
      expect(sendButton).toHaveAttribute(
        "title",
        "Waiting on Dreamer to finish current response"
      );
    });

    it("allows typing in input while sending (floating variant)", async () => {
      const user = userEvent.setup();
      render(
        <PrdChatPanel
          {...defaultProps}
          open={true}
          sending={true}
        />
      );

      const input = screen.getByRole("textbox", { name: "Chat message" });
      expect(input).not.toBeDisabled();
      await user.type(input, "Next message");
      expect(input).toHaveValue("Next message");
    });
  });

  describe("multi-line Discuss input", () => {
    it("Enter submits message", async () => {
      const user = userEvent.setup();
      const onSend = vi.fn();
      render(
        <PrdChatPanel
          {...defaultProps}
          variant="inline"
          collapsed={false}
          onCollapsedChange={vi.fn()}
          onSend={onSend}
        />
      );

      const input = screen.getByPlaceholderText(/Ask about your PRD/);
      await user.type(input, "Hello{Enter}");

      expect(onSend).toHaveBeenCalledWith("Hello");
    });

    it("Shift+Enter inserts newline and does not submit", async () => {
      const user = userEvent.setup();
      const onSend = vi.fn();
      render(
        <PrdChatPanel
          {...defaultProps}
          variant="inline"
          collapsed={false}
          onCollapsedChange={vi.fn()}
          onSend={onSend}
        />
      );

      const input = screen.getByPlaceholderText(/Ask about your PRD/);
      await user.type(input, "Line one{Shift>}{Enter}{/Shift}Line two");

      expect(onSend).not.toHaveBeenCalled();
      expect(input).toHaveValue("Line one\nLine two");
    });

    it("textarea has resize-none and overflow-y-auto for auto-expand up to 5 lines", () => {
      render(
        <PrdChatPanel
          {...defaultProps}
          variant="inline"
          collapsed={false}
          onCollapsedChange={vi.fn()}
        />
      );

      const input = screen.getByPlaceholderText(/Ask about your PRD/);
      expect(input).toHaveClass("resize-none");
      expect(input).toHaveClass("overflow-y-auto");
    });

    it("renders as textarea for multi-line input", () => {
      render(
        <PrdChatPanel
          {...defaultProps}
          variant="inline"
          collapsed={false}
          onCollapsedChange={vi.fn()}
        />
      );

      const input = screen.getByPlaceholderText(/Ask about your PRD/);
      expect(input.tagName).toBe("TEXTAREA");
    });

    it("Send button and input share the same height when input has one line", () => {
      render(
        <PrdChatPanel
          {...defaultProps}
          variant="inline"
          collapsed={false}
          onCollapsedChange={vi.fn()}
        />
      );

      const input = screen.getByRole("textbox", { name: "Discuss message" });
      const sendButton = screen.getByRole("button", { name: "Send" });

      // Input is empty = single line; layout effect sets height based on min/scrollHeight
      const inputRect = input.getBoundingClientRect();
      const buttonRect = sendButton.getBoundingClientRect();

      expect(buttonRect.height).toBe(inputRect.height);
    });

    it("Send button has fixed height and does not stretch with input", () => {
      render(
        <PrdChatPanel
          {...defaultProps}
          variant="inline"
          collapsed={false}
          onCollapsedChange={vi.fn()}
        />
      );

      const sendButton = screen.getByRole("button", { name: "Send" });
      // Button must have fixed height (h-[2.5rem]) matching single-line input; items-end prevents stretch
      expect(sendButton).toHaveClass("h-[2.5rem]");
    });
  });

  it("applies dark mode classes when html has data-theme=dark", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    render(
      <PrdChatPanel
        {...defaultProps}
        variant="inline"
        messages={[{ role: "assistant", content: "Hello", timestamp: "" }]}
      />
    );

    const sidebar = screen.getByTestId("prd-chat-sidebar");
    expect(sidebar).toBeInTheDocument();

    const assistantText = screen.getByText("Hello");
    const bubbleContainer = assistantText.closest(".bg-theme-border-subtle");
    expect(bubbleContainer).toBeInTheDocument();
    expect(bubbleContainer).toHaveClass("text-theme-text");

    document.documentElement.removeAttribute("data-theme");
  });
});
