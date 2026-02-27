import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HelpModal } from "./HelpModal";
import { api } from "../api/client";

const queryClient = new QueryClient();

function renderWithProviders(ui: React.ReactElement) {
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}

vi.mock("../api/client", () => ({
  api: {
    help: {
      chat: vi.fn(),
      history: vi.fn(),
    },
  },
}));

describe("HelpModal", () => {
  beforeEach(() => {
    vi.mocked(api.help.chat).mockReset();
    vi.mocked(api.help.history).mockResolvedValue({ messages: [] });
  });
  it("renders Help modal with two tabs, Ask a Question default", () => {
    renderWithProviders(<HelpModal onClose={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: /help/i })).toBeInTheDocument();
    expect(screen.getByText("Help")).toBeInTheDocument();
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
    renderWithProviders(<HelpModal onClose={vi.fn()} />);

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

  it("Meet your Team tab shows agent roles and phases", async () => {
    const user = userEvent.setup();
    renderWithProviders(<HelpModal onClose={vi.fn()} />);

    await user.click(screen.getByRole("tab", { name: "Meet your Team" }));

    expect(screen.getByText("Dreamer")).toBeInTheDocument();
    expect(screen.getByText("Harmonizer")).toBeInTheDocument();
    expect(screen.getByText("Analyst")).toBeInTheDocument();
    expect(screen.getByText("Sketch")).toBeInTheDocument();
    expect(screen.getAllByText("Plan").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Execute").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Evaluate").length).toBeGreaterThan(0);
  });

  it("shows project context in Ask a Question when project provided", () => {
    renderWithProviders(
      <HelpModal
        onClose={vi.fn()}
        project={{ id: "proj-1", name: "My Project" }}
      />
    );

    expect(screen.getByText(/Ask about My Project/)).toBeInTheDocument();
  });

  it("calls onClose when close button is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<HelpModal onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: /close help/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when backdrop is clicked", () => {
    const onClose = vi.fn();
    renderWithProviders(<HelpModal onClose={onClose} />);

    const backdrop = screen.getByTestId("help-modal-backdrop");
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape key is pressed", () => {
    const onClose = vi.fn();
    renderWithProviders(<HelpModal onClose={onClose} />);

    const dialog = screen.getByRole("dialog", { name: /help/i });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is accessible with aria attributes", () => {
    renderWithProviders(<HelpModal onClose={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: /help/i });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "help-modal-title");
  });

  it("has max-height 90vh for viewport-relative sizing on large screens", () => {
    render(<HelpModal onClose={vi.fn()} />);

    const modalContent = screen.getByTestId("help-modal-content");
    expect(modalContent).toHaveClass("max-h-[90vh]");
  });

  it("Ask a Question tab shows chat input and sends messages", async () => {
    vi.mocked(api.help.chat).mockResolvedValue({ message: "Here is my response." });
    const user = userEvent.setup();
    renderWithProviders(<HelpModal onClose={vi.fn()} />);

    expect(screen.getByTestId("help-chat-messages")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Ask a question...")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Ask a question..."), "What is OpenSprint?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(api.help.chat).toHaveBeenCalledWith({
      message: "What is OpenSprint?",
      projectId: null,
      messages: [],
    });
    expect(await screen.findByText("What is OpenSprint?")).toBeInTheDocument();
    expect(await screen.findByText("Here is my response.")).toBeInTheDocument();
  });

  it("Ask a Question tab passes projectId when in project view", async () => {
    vi.mocked(api.help.chat).mockResolvedValue({ message: "Project context." });
    const user = userEvent.setup();
    renderWithProviders(
      <HelpModal
        onClose={vi.fn()}
        project={{ id: "proj-1", name: "My Project" }}
      />
    );

    await user.type(screen.getByPlaceholderText("Ask a question..."), "What plans exist?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(api.help.chat).toHaveBeenCalledWith({
      message: "What plans exist?",
      projectId: "proj-1",
      messages: [],
    });
  });

  it("Ask a Question tab loads persisted chat history on mount", async () => {
    vi.mocked(api.help.history).mockResolvedValue({
      messages: [
        { role: "user", content: "What is OpenSprint?" },
        { role: "assistant", content: "OpenSprint is an AI-powered workflow tool." },
      ],
    });
    renderWithProviders(<HelpModal onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("What is OpenSprint?")).toBeInTheDocument();
    });
    expect(screen.getByText("OpenSprint is an AI-powered workflow tool.")).toBeInTheDocument();
    expect(api.help.history).toHaveBeenCalledWith(null);
  });

  it("Ask a Question tab loads per-project history when project provided", async () => {
    vi.mocked(api.help.history).mockResolvedValue({
      messages: [{ role: "user", content: "Project question" }, { role: "assistant", content: "Answer" }],
    });
    renderWithProviders(
      <HelpModal
        onClose={vi.fn()}
        project={{ id: "proj-1", name: "My Project" }}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Project question")).toBeInTheDocument();
    });
    expect(api.help.history).toHaveBeenCalledWith("proj-1");
  });

  it("focuses chat input when Help modal opens", async () => {
    renderWithProviders(<HelpModal onClose={vi.fn()} />);

    await waitFor(() => {
      const input = screen.getByPlaceholderText("Ask a question...");
      expect(document.activeElement).toBe(input);
    });
  });

  it("focuses chat input when switching back to Ask a Question tab", async () => {
    const user = userEvent.setup();
    renderWithProviders(<HelpModal onClose={vi.fn()} />);

    await user.click(screen.getByRole("tab", { name: "Meet your Team" }));
    await user.click(screen.getByRole("tab", { name: "Ask a Question" }));

    await waitFor(() => {
      const input = screen.getByPlaceholderText("Ask a question...");
      expect(document.activeElement).toBe(input);
    });
  });

  it("Ask a Question tab shows loading state during agent response", async () => {
    let resolvePromise: (value: { message: string }) => void;
    const chatPromise = new Promise<{ message: string }>((resolve) => {
      resolvePromise = resolve;
    });
    vi.mocked(api.help.chat).mockReturnValue(chatPromise);

    const user = userEvent.setup();
    renderWithProviders(<HelpModal onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText("Ask a question..."), "Hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(screen.getByTestId("help-chat-loading")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    resolvePromise!({ message: "Hi there!" });

    await waitFor(() => {
      expect(screen.queryByTestId("help-chat-loading")).not.toBeInTheDocument();
    });
    expect(await screen.findByText("Hi there!")).toBeInTheDocument();
  });
});
