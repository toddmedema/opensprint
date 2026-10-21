import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExecuteAgentChatPanel, type ExecuteChatMessage } from "./ExecuteAgentChatPanel";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const defaultProps = {
  messages: [] as ExecuteChatMessage[],
  sending: false,
  onSend: vi.fn(),
  agentRunning: true,
  chatSupported: true,
};

beforeEach(() => {
  localStorage.clear();
});

describe("ExecuteAgentChatPanel", () => {
  it("renders the panel", () => {
    render(<ExecuteAgentChatPanel {...defaultProps} />);

    expect(screen.getByTestId("execute-agent-chat-panel")).toBeInTheDocument();
  });

  it("does not render a redundant in-tab title row (Execute tabs already label Chat)", () => {
    render(<ExecuteAgentChatPanel {...defaultProps} />);

    expect(screen.queryByText(/Chatting with/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Chat with Coder/i)).not.toBeInTheDocument();
  });

  it("shows empty state when no messages", () => {
    render(<ExecuteAgentChatPanel {...defaultProps} />);

    expect(screen.getByText("Send a message to the agent while it works")).toBeInTheDocument();
  });

  it("renders user messages as right-aligned bubbles", () => {
    const messages: ExecuteChatMessage[] = [
      { role: "user", content: "Hello agent", timestamp: "2025-01-01T00:00:00Z" },
    ];
    render(<ExecuteAgentChatPanel {...defaultProps} messages={messages} />);

    const bubble = screen.getByText("Hello agent");
    expect(bubble).toBeInTheDocument();
    const flexContainer = bubble.closest(".flex");
    expect(flexContainer).toHaveClass("justify-end");
  });

  it("renders assistant messages as left-aligned bubbles", () => {
    const messages: ExecuteChatMessage[] = [
      { role: "assistant", content: "I am working on it", timestamp: "2025-01-01T00:00:00Z" },
    ];
    render(<ExecuteAgentChatPanel {...defaultProps} messages={messages} />);

    const bubble = screen.getByText("I am working on it");
    expect(bubble).toBeInTheDocument();
    const flexContainer = bubble.closest(".flex");
    expect(flexContainer).toHaveClass("justify-start");
  });

  it("shows delivery checkmark on delivered user messages", () => {
    const messages: ExecuteChatMessage[] = [
      {
        role: "user",
        content: "Hello",
        timestamp: "2025-01-01T00:00:00Z",
        delivered: true,
      },
    ];
    render(<ExecuteAgentChatPanel {...defaultProps} messages={messages} />);

    expect(screen.getByTestId("delivery-checkmark")).toBeInTheDocument();
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("does not show delivery checkmark on undelivered user messages", () => {
    const messages: ExecuteChatMessage[] = [
      { role: "user", content: "Hello", timestamp: "2025-01-01T00:00:00Z" },
    ];
    render(<ExecuteAgentChatPanel {...defaultProps} messages={messages} />);

    expect(screen.queryByTestId("delivery-checkmark")).not.toBeInTheDocument();
  });

  it("shows typing indicator when sending", () => {
    render(<ExecuteAgentChatPanel {...defaultProps} sending={true} />);

    expect(screen.getByTestId("chat-typing-indicator")).toBeInTheDocument();
  });

  it("does not show typing indicator when not sending", () => {
    render(<ExecuteAgentChatPanel {...defaultProps} sending={false} />);

    expect(screen.queryByTestId("chat-typing-indicator")).not.toBeInTheDocument();
  });

  describe("chat unsupported (CLI backend)", () => {
    it("shows unsupported notice when chatSupported is false", () => {
      render(<ExecuteAgentChatPanel {...defaultProps} chatSupported={false} />);

      expect(screen.getByTestId("chat-unsupported-notice")).toBeInTheDocument();
      expect(screen.getByText(/Live chat is only available with API-based/)).toBeInTheDocument();
    });

    it("shows custom unsupported reason when provided", () => {
      render(
        <ExecuteAgentChatPanel
          {...defaultProps}
          chatSupported={false}
          chatUnsupportedReason="Claude CLI does not support live chat"
        />
      );

      expect(screen.getByText("Claude CLI does not support live chat")).toBeInTheDocument();
    });

    it("disables send button when chatSupported is false", () => {
      render(<ExecuteAgentChatPanel {...defaultProps} chatSupported={false} />);

      const sendButton = screen.getByRole("button", { name: "Send" });
      expect(sendButton).toBeDisabled();
    });

    it("shows tooltip on send when chatSupported is false", () => {
      render(<ExecuteAgentChatPanel {...defaultProps} chatSupported={false} />);

      const sendButton = screen.getByRole("button", { name: "Send" });
      expect(sendButton).toHaveAttribute("title", "Chat is not available with CLI backends");
    });

    it("shows disabled placeholder when chatSupported is false", () => {
      render(<ExecuteAgentChatPanel {...defaultProps} chatSupported={false} />);

      expect(screen.getByPlaceholderText("Chat unavailable with CLI backend")).toBeInTheDocument();
    });

    it("disables the text input when chatSupported is false", () => {
      render(<ExecuteAgentChatPanel {...defaultProps} chatSupported={false} />);

      expect(screen.getByRole("textbox", { name: "Execute chat message" })).toBeDisabled();
    });

    it("shows CLI empty state when chatSupported is false", () => {
      render(<ExecuteAgentChatPanel {...defaultProps} chatSupported={false} />);

      expect(
        screen.getByText("Live chat is not available for this agent backend.")
      ).toBeInTheDocument();
    });
  });

  describe("agent not running", () => {
    it("shows not-running notice when agent is not running", () => {
      render(<ExecuteAgentChatPanel {...defaultProps} agentRunning={false} />);

      expect(screen.getByTestId("chat-not-running-notice")).toBeInTheDocument();
      expect(screen.getByText(/The agent is not currently running/)).toBeInTheDocument();
    });

    it("does not show not-running notice when chatSupported is false", () => {
      render(
        <ExecuteAgentChatPanel {...defaultProps} agentRunning={false} chatSupported={false} />
      );

      expect(screen.queryByTestId("chat-not-running-notice")).not.toBeInTheDocument();
      expect(screen.getByTestId("chat-unsupported-notice")).toBeInTheDocument();
    });

    it("disables send button when agent is not running", () => {
      render(<ExecuteAgentChatPanel {...defaultProps} agentRunning={false} />);

      const sendButton = screen.getByRole("button", { name: "Send" });
      expect(sendButton).toBeDisabled();
    });

    it("shows tooltip on send when agent is not running", () => {
      render(<ExecuteAgentChatPanel {...defaultProps} agentRunning={false} />);

      const sendButton = screen.getByRole("button", { name: "Send" });
      expect(sendButton).toHaveAttribute("title", "Agent is not running");
    });

    it("shows disabled placeholder when agent is not running", () => {
      render(<ExecuteAgentChatPanel {...defaultProps} agentRunning={false} />);

      expect(screen.getByPlaceholderText("Agent not running")).toBeInTheDocument();
    });

    it("disables the text input when agent is not running", () => {
      render(<ExecuteAgentChatPanel {...defaultProps} agentRunning={false} />);

      expect(screen.getByRole("textbox", { name: "Execute chat message" })).toBeDisabled();
    });

    it("shows not-running empty state when agent is not running", () => {
      render(<ExecuteAgentChatPanel {...defaultProps} agentRunning={false} />);

      expect(
        screen.getByText("Chat will be available when an agent is actively working on this task.")
      ).toBeInTheDocument();
    });
  });

  describe("when agent is sending (sending=true)", () => {
    it("keeps input enabled so user can compose next message", () => {
      render(<ExecuteAgentChatPanel {...defaultProps} sending={true} />);

      const input = screen.getByRole("textbox", { name: "Execute chat message" });
      expect(input).not.toBeDisabled();
    });

    it("keeps Send button disabled while waiting for response", () => {
      render(<ExecuteAgentChatPanel {...defaultProps} sending={true} />);

      const sendButton = screen.getByRole("button", { name: "Send" });
      expect(sendButton).toBeDisabled();
    });

    it("shows tooltip on disabled Send when waiting for response", () => {
      render(<ExecuteAgentChatPanel {...defaultProps} sending={true} />);

      const sendButton = screen.getByRole("button", { name: "Send" });
      expect(sendButton).toHaveAttribute("title", "Saving guidance…");
    });

    it("allows typing in input while sending", async () => {
      const user = userEvent.setup();
      render(<ExecuteAgentChatPanel {...defaultProps} sending={true} />);

      const input = screen.getByRole("textbox", { name: "Execute chat message" });
      expect(input).not.toBeDisabled();
      await user.type(input, "Next message");
      expect(input).toHaveValue("Next message");
    });
  });

  describe("multi-line input", () => {
    it("Enter submits message", async () => {
      const user = userEvent.setup();
      const onSend = vi.fn();
      render(<ExecuteAgentChatPanel {...defaultProps} onSend={onSend} />);

      const input = screen.getByPlaceholderText(/Message the agent/);
      await user.type(input, "Hello{Enter}");

      await waitFor(() => {
        expect(onSend).toHaveBeenCalledWith("Hello");
      });
    });

    it("Shift+Enter inserts newline and does not submit", async () => {
      const user = userEvent.setup();
      const onSend = vi.fn();
      render(<ExecuteAgentChatPanel {...defaultProps} onSend={onSend} />);

      const input = screen.getByPlaceholderText(/Message the agent/);
      await user.type(input, "Line one{Shift>}{Enter}{/Shift}Line two");

      expect(onSend).not.toHaveBeenCalled();
      expect(input).toHaveValue("Line one\nLine two");
    });

    it("textarea has resize-none and overflow-y-auto for auto-expand up to 5 lines", () => {
      render(<ExecuteAgentChatPanel {...defaultProps} />);

      const input = screen.getByPlaceholderText(/Message the agent/);
      expect(input).toHaveClass("resize-none");
      expect(input).toHaveClass("overflow-y-auto");
    });

    it("renders as textarea for multi-line input", () => {
      render(<ExecuteAgentChatPanel {...defaultProps} />);

      const input = screen.getByPlaceholderText(/Message the agent/);
      expect(input.tagName).toBe("TEXTAREA");
    });

    it("Send button has fixed height and does not stretch with input", () => {
      render(<ExecuteAgentChatPanel {...defaultProps} />);

      const sendButton = screen.getByRole("button", { name: "Send" });
      expect(sendButton).toHaveClass("h-[2.5rem]");
    });
  });

  describe("draft persistence", () => {
    it("restores draft from localStorage on mount", () => {
      localStorage.setItem("test-draft-key", JSON.stringify("Saved draft"));
      render(<ExecuteAgentChatPanel {...defaultProps} draftStorageKey="test-draft-key" />);

      const input = screen.getByRole("textbox", { name: "Execute chat message" });
      expect(input).toHaveValue("Saved draft");
    });

    it("clears draft after successful send", async () => {
      const user = userEvent.setup();
      const onSend = vi.fn().mockReturnValue(undefined);
      localStorage.setItem("test-draft-key", JSON.stringify("Draft"));
      render(
        <ExecuteAgentChatPanel {...defaultProps} onSend={onSend} draftStorageKey="test-draft-key" />
      );

      const input = screen.getByRole("textbox", { name: "Execute chat message" });
      await user.clear(input);
      await user.type(input, "Hello{Enter}");

      await waitFor(() => {
        expect(onSend).toHaveBeenCalledWith("Hello");
      });
      expect(localStorage.getItem("test-draft-key")).toBeNull();
    });

    it("restores draft on failed send", async () => {
      const user = userEvent.setup();
      const onSend = vi.fn().mockReturnValue(false);
      render(
        <ExecuteAgentChatPanel {...defaultProps} onSend={onSend} draftStorageKey="test-draft-key" />
      );

      const input = screen.getByRole("textbox", { name: "Execute chat message" });
      await user.type(input, "Important message{Enter}");

      await waitFor(() => {
        expect(onSend).toHaveBeenCalledWith("Important message");
      });
      expect(input).toHaveValue("Important message");
    });
  });

  describe("scroll behavior", () => {
    it("scrolls to bottom on initial render with messages", async () => {
      const messages: ExecuteChatMessage[] = [
        { role: "user", content: "Hello", timestamp: "" },
        { role: "assistant", content: "Hi there!", timestamp: "" },
      ];
      render(
        <ExecuteAgentChatPanel {...defaultProps} messages={messages} scrollResetKey="task-1" />
      );

      const scrollEl = screen.getByTestId("execute-chat-messages");
      Object.defineProperty(scrollEl, "scrollHeight", { value: 200, configurable: true });
      Object.defineProperty(scrollEl, "clientHeight", { value: 100, configurable: true });

      await new Promise((r) => requestAnimationFrame(r));

      expect(scrollEl.scrollTop).toBe(100);
    });

    it("scrolls to bottom when new message is added", async () => {
      const messages: ExecuteChatMessage[] = [
        { role: "user", content: "Hello", timestamp: "" },
        { role: "assistant", content: "Hi!", timestamp: "" },
      ];
      const { rerender } = render(
        <ExecuteAgentChatPanel {...defaultProps} messages={messages} scrollResetKey="task-1" />
      );

      const scrollEl = screen.getByTestId("execute-chat-messages");
      Object.defineProperty(scrollEl, "scrollHeight", { value: 200, configurable: true });
      Object.defineProperty(scrollEl, "clientHeight", { value: 100, configurable: true });

      await new Promise((r) => requestAnimationFrame(r));
      expect(scrollEl.scrollTop).toBe(100);

      const withNewMessage = [
        ...messages,
        { role: "assistant" as const, content: "Another reply!", timestamp: "" },
      ];
      rerender(
        <ExecuteAgentChatPanel
          {...defaultProps}
          messages={withNewMessage}
          scrollResetKey="task-1"
        />
      );

      await new Promise((r) => requestAnimationFrame(r));

      expect(scrollEl.scrollTop).toBe(100);
    });

    it("shows Jump to latest button when user scrolls up in chat", () => {
      const messages: ExecuteChatMessage[] = [
        { role: "user", content: "Hello", timestamp: "" },
        { role: "assistant", content: "Hi!", timestamp: "" },
      ];
      render(
        <ExecuteAgentChatPanel {...defaultProps} messages={messages} scrollResetKey="task-1" />
      );

      const scrollEl = screen.getByTestId("execute-chat-messages");
      Object.defineProperty(scrollEl, "scrollHeight", { value: 500, configurable: true });
      Object.defineProperty(scrollEl, "clientHeight", { value: 200, configurable: true });
      Object.defineProperty(scrollEl, "scrollTop", { value: 0, configurable: true });

      fireEvent.scroll(scrollEl);

      expect(screen.getByTestId("chat-jump-to-bottom")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Jump to latest messages" })).toBeInTheDocument();
    });

    it("scrolls to bottom on task switch (scrollResetKey change)", async () => {
      const messages: ExecuteChatMessage[] = [{ role: "user", content: "Hello", timestamp: "" }];
      const { rerender } = render(
        <ExecuteAgentChatPanel {...defaultProps} messages={messages} scrollResetKey="task-1" />
      );

      const scrollEl = screen.getByTestId("execute-chat-messages");
      Object.defineProperty(scrollEl, "scrollHeight", { value: 200, configurable: true });
      Object.defineProperty(scrollEl, "clientHeight", { value: 100, configurable: true });

      await new Promise((r) => requestAnimationFrame(r));
      expect(scrollEl.scrollTop).toBe(100);

      // Switch task
      rerender(
        <ExecuteAgentChatPanel {...defaultProps} messages={messages} scrollResetKey="task-2" />
      );
      await new Promise((r) => requestAnimationFrame(r));

      expect(scrollEl.scrollTop).toBe(100);
    });

    it("scrolls to bottom when scrollTriggerKey changes", async () => {
      const messages: ExecuteChatMessage[] = [{ role: "user", content: "Hello", timestamp: "" }];
      const { rerender } = render(
        <ExecuteAgentChatPanel
          {...defaultProps}
          messages={messages}
          scrollResetKey="task-1"
          scrollTriggerKey={0}
        />
      );

      const scrollEl = screen.getByTestId("execute-chat-messages");
      Object.defineProperty(scrollEl, "scrollHeight", { value: 200, configurable: true });
      Object.defineProperty(scrollEl, "clientHeight", { value: 100, configurable: true });

      await new Promise((r) => requestAnimationFrame(r));

      scrollEl.scrollTop = 0;

      // Change triggerKey — simulates tab becoming active
      rerender(
        <ExecuteAgentChatPanel
          {...defaultProps}
          messages={messages}
          scrollResetKey="task-1"
          scrollTriggerKey={1}
        />
      );
      await new Promise((r) => requestAnimationFrame(r));

      expect(scrollEl.scrollTop).toBe(100);
    });
  });

  it("shows placeholder when agent is running and chat supported", () => {
    render(<ExecuteAgentChatPanel {...defaultProps} />);

    expect(screen.getByPlaceholderText("Message the agent…")).toBeInTheDocument();
  });

  it("does not render a border-t divider above the chat input", () => {
    render(<ExecuteAgentChatPanel {...defaultProps} />);

    const input = screen.getByPlaceholderText("Message the agent…");
    const composerBlock = input.parentElement?.parentElement;
    expect(composerBlock?.className).not.toMatch(/\bborder-t\b/);
  });

  it("applies dark mode classes when html has data-theme=dark", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    const messages: ExecuteChatMessage[] = [{ role: "assistant", content: "Hello", timestamp: "" }];
    render(<ExecuteAgentChatPanel {...defaultProps} messages={messages} />);

    const panel = screen.getByTestId("execute-agent-chat-panel");
    expect(panel).toBeInTheDocument();

    const assistantText = screen.getByText("Hello");
    const bubbleContainer = assistantText.closest(".bg-theme-border-subtle");
    expect(bubbleContainer).toBeInTheDocument();
    expect(bubbleContainer).toHaveClass("text-theme-text");

    document.documentElement.removeAttribute("data-theme");
  });
});
