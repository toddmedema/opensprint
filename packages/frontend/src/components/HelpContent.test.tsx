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
      analytics: vi.fn(),
      agentLog: vi.fn(),
      sessionLog: vi.fn(),
    },
  },
}));

describe("HelpContent", () => {
  beforeEach(() => {
    vi.mocked(api.help.history).mockResolvedValue({ messages: [] });
    vi.mocked(api.help.analytics).mockResolvedValue({
      byComplexity: Array.from({ length: 10 }, (_, i) => ({
        complexity: i + 1,
        taskCount: i === 2 ? 2 : i === 4 ? 1 : 0,
        avgCompletionTimeMs: i === 2 ? 90000 : i === 4 ? 180000 : 0,
      })),
      totalTasks: 3,
    });
    vi.mocked(api.help.agentLog).mockResolvedValue([]);
  });

  it("renders four tabs: Ask a Question (default), Meet your Team, Analytics, and Agent log", () => {
    render(<HelpContent />);

    expect(screen.getByRole("tab", { name: "Ask a Question" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Meet your Team" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Analytics" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Agent log" })).toBeInTheDocument();
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

  it("Meet your Team view shows only agent icons — no chat input or chat UI", async () => {
    const user = userEvent.setup();
    render(<HelpContent />);

    await user.click(screen.getByRole("tab", { name: "Meet your Team" }));

    expect(screen.queryByRole("textbox", { name: "Help chat message" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("help-chat-messages")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Ask a question...")).not.toBeInTheDocument();
    expect(screen.getByText("Dreamer")).toBeInTheDocument();
  });

  it("shows project context in Ask a Question when project provided", () => {
    render(<HelpContent project={{ id: "proj-1", name: "My Project" }} />);

    expect(screen.getByText(/Ask about My Project/)).toBeInTheDocument();
  });

  it("switches to Analytics tab and shows chart", async () => {
    const user = userEvent.setup();
    render(<HelpContent />);

    await user.click(screen.getByRole("tab", { name: "Analytics" }));

    expect(screen.getByRole("tab", { name: "Analytics" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(api.help.analytics).toHaveBeenCalledWith(null);
    expect(screen.getByTestId("help-analytics-chart")).toBeInTheDocument();
  });

  it("Analytics tab scopes to project when project provided", async () => {
    const user = userEvent.setup();
    render(<HelpContent project={{ id: "proj-1", name: "My Project" }} />);

    await user.click(screen.getByRole("tab", { name: "Analytics" }));

    expect(api.help.analytics).toHaveBeenCalledWith("proj-1");
  });

  it("Agent log tab shows table and calls agentLog API", async () => {
    const user = userEvent.setup();
    vi.mocked(api.help.agentLog).mockResolvedValue([
      { model: "claude-sonnet-4", role: "Coder", durationMs: 45000, endTime: "2025-03-01T12:00:00Z" },
      {
        model: "claude-sonnet-4",
        role: "claude-sonnet",
        durationMs: 120000,
        endTime: "2025-03-01T11:00:00Z",
      },
    ]);
    render(<HelpContent />);

    await user.click(screen.getByRole("tab", { name: "Agent log" }));

    expect(screen.getByRole("tab", { name: "Agent log" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(api.help.agentLog).toHaveBeenCalledWith(null);
    expect(screen.getByText("Coder")).toBeInTheDocument();
    expect(screen.getByText("claude-sonnet")).toBeInTheDocument();
    expect(screen.getByText("45.0s")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh agent log" })).toBeInTheDocument();
  });

  it("Agent log tab scopes to project when project provided", async () => {
    const user = userEvent.setup();
    render(<HelpContent project={{ id: "proj-1", name: "My Project" }} />);

    await user.click(screen.getByRole("tab", { name: "Agent log" }));

    expect(api.help.agentLog).toHaveBeenCalledWith("proj-1");
  });

  it("Agent log shows Unknown when model is empty or missing", async () => {
    const user = userEvent.setup();
    vi.mocked(api.help.agentLog).mockResolvedValue([
      { model: "", role: "Coder", durationMs: 10000, endTime: "2025-03-01T12:00:00Z" },
      { model: "Cursor Composer 1.5", role: "Reviewer", durationMs: 20000, endTime: "2025-03-01T11:00:00Z" },
    ]);
    render(<HelpContent />);

    await user.click(screen.getByRole("tab", { name: "Agent log" }));

    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.getByText("Cursor Composer 1.5")).toBeInTheDocument();
  });

  it("Agent log shows Log column and magnifying glass only for rows with sessionId", async () => {
    const user = userEvent.setup();
    vi.mocked(api.help.agentLog).mockResolvedValue([
      { model: "claude-sonnet-4", role: "Coder", durationMs: 45000, endTime: "2025-03-01T12:00:00Z", sessionId: 1 },
      { model: "claude-sonnet-4", role: "Reviewer", durationMs: 120000, endTime: "2025-03-01T11:00:00Z" },
    ]);
    render(<HelpContent />);

    await user.click(screen.getByRole("tab", { name: "Agent log" }));

    expect(screen.getByText("Log")).toBeInTheDocument();
    const viewButtons = screen.getAllByRole("button", { name: "View session log" });
    expect(viewButtons).toHaveLength(1);
  });

  it("Agent log opens modal with session content when magnifying glass clicked", async () => {
    const user = userEvent.setup();
    vi.mocked(api.help.agentLog).mockResolvedValue([
      { model: "claude-sonnet-4", role: "Coder", durationMs: 45000, endTime: "2025-03-01T12:00:00Z", sessionId: 1 },
    ]);
    vi.mocked(api.help.sessionLog).mockResolvedValue({ content: "Raw session output line 1\nLine 2" });
    render(<HelpContent />);

    await user.click(screen.getByRole("tab", { name: "Agent log" }));
    await user.click(screen.getByRole("button", { name: "View session log" }));

    expect(api.help.sessionLog).toHaveBeenCalledWith(1);
    expect(await screen.findByText(/Raw session output line 1/)).toBeInTheDocument();
    expect(screen.getByText(/Line 2/)).toBeInTheDocument();
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
