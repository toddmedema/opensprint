import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HelpContent } from "./HelpContent";
import { api } from "../api/client";

vi.mock("../api/client", () => ({
  api: {
    help: {
      history: vi.fn(),
      chat: vi.fn(),
    },
  },
}));

describe("HelpContent", () => {
  beforeEach(() => {
    vi.mocked(api.help.history).mockResolvedValue({ messages: [] });
  });

  it("renders two tabs: Ask a Question (default) and Meet your Team", () => {
    render(<HelpContent />);

    expect(screen.getByRole("tab", { name: "Ask a Question" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Meet your Team" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Ask a Question" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByText(/Ask about your projects/)).toBeInTheDocument();
  });

  it("switches to Meet your Team tab and shows agent grid", async () => {
    const user = userEvent.setup();
    render(<HelpContent />);

    await user.click(screen.getByRole("tab", { name: "Meet your Team" }));

    expect(screen.getByRole("tab", { name: "Meet your Team" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByText("Dreamer")).toBeInTheDocument();
    expect(screen.getByText("Planner")).toBeInTheDocument();
    expect(screen.getByText("Sketch")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(9);
  });

  it("shows project context in Ask a Question when project provided", () => {
    render(<HelpContent project={{ id: "proj-1", name: "My Project" }} />);

    expect(screen.getByText(/Ask about My Project/)).toBeInTheDocument();
  });

  it("keeps chat input pinned at bottom with scrollable messages above", async () => {
    vi.mocked(api.help.history).mockResolvedValue({
      messages: Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `Message ${i + 1}`,
      })),
    });
    render(<HelpContent />);

    const messagesEl = await screen.findByTestId("help-chat-messages");
    expect(messagesEl).toHaveClass("overflow-y-auto");
    expect(messagesEl).toHaveClass("flex-1");

    const input = screen.getByRole("textbox", { name: "Help chat message" });
    expect(input).toBeInTheDocument();
    expect(input.closest("form") ?? input.parentElement).toBeInTheDocument();
  });
});
