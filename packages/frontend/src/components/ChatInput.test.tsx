import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatInput } from "./ChatInput";

function ControlledChatInput({
  onSend,
  placeholder = "Type...",
}: {
  onSend: () => void;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");
  return (
    <ChatInput
      value={value}
      onChange={setValue}
      onSend={onSend}
      placeholder={placeholder}
    />
  );
}

describe("ChatInput", () => {
  it("renders textarea and send button", () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSend={vi.fn()}
        placeholder="Type a message..."
      />
    );
    expect(screen.getByPlaceholderText("Type a message...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("calls onChange when typing", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ControlledChatInput onSend={onSend} />);
    const input = screen.getByPlaceholderText("Type...");
    await user.type(input, "Hello");
    expect(input).toHaveValue("Hello");
  });

  it("calls onSend when Send button clicked", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(
      <ChatInput value="Hello" onChange={vi.fn()} onSend={onSend} placeholder="Type..." />
    );
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("Enter submits when multiline (Shift+Enter inserts newline)", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(
      <ChatInput value="Hello" onChange={vi.fn()} onSend={onSend} placeholder="Type..." />
    );
    const input = screen.getByPlaceholderText("Type...");
    await user.type(input, "{Enter}");
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("Shift+Enter inserts newline and does not submit", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ControlledChatInput onSend={onSend} />);
    const input = screen.getByPlaceholderText("Type...");
    await user.type(input, "Line 1");
    await user.keyboard("{Shift>}{Enter}{/Shift}Line 2");
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue("Line 1\nLine 2");
  });

  it("disables send button when sendDisabled", () => {
    render(
      <ChatInput
        value="Hello"
        onChange={vi.fn()}
        onSend={vi.fn()}
        sendDisabled={true}
        placeholder="Type..."
      />
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("keeps input enabled when sendDisabled (user can compose next message)", () => {
    render(
      <ChatInput
        value="Hello"
        onChange={vi.fn()}
        onSend={vi.fn()}
        sendDisabled={true}
        placeholder="Type..."
      />
    );
    const input = screen.getByPlaceholderText("Type...");
    expect(input).not.toBeDisabled();
  });

  it("shows tooltip on disabled Send when sendDisabledTooltip is provided", () => {
    render(
      <ChatInput
        value="Hello"
        onChange={vi.fn()}
        onSend={vi.fn()}
        sendDisabled={true}
        sendDisabledTooltip="Waiting on Dreamer to finish current response"
        placeholder="Type..."
      />
    );
    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(sendButton).toHaveAttribute(
      "title",
      "Waiting on Dreamer to finish current response"
    );
  });

  it("does not show sendDisabledTooltip when sendDisabled is false", () => {
    render(
      <ChatInput
        value="Hello"
        onChange={vi.fn()}
        onSend={vi.fn()}
        sendDisabledTooltip="Waiting on Dreamer to finish current response"
        placeholder="Type..."
      />
    );
    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(sendButton).not.toHaveAttribute("title");
  });

  it("disables send button when value is empty", () => {
    render(
      <ChatInput value="" onChange={vi.fn()} onSend={vi.fn()} placeholder="Type..." />
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("has resize-none and overflow-y-auto for auto-expand up to 5 lines", () => {
    render(
      <ChatInput value="" onChange={vi.fn()} onSend={vi.fn()} placeholder="Type..." />
    );
    const input = screen.getByPlaceholderText("Type...");
    expect(input).toHaveClass("resize-none");
    expect(input).toHaveClass("overflow-y-auto");
  });
});
