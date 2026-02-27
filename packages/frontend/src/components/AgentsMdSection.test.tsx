import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "../contexts/ThemeContext";
import { AgentsMdSection } from "./AgentsMdSection";

const mockGetAgentsInstructions = vi.fn();
const mockUpdateAgentsInstructions = vi.fn();

vi.mock("../api/client", () => ({
  api: {
    projects: {
      getAgentsInstructions: (...args: unknown[]) => mockGetAgentsInstructions(...args),
      updateAgentsInstructions: (...args: unknown[]) => mockUpdateAgentsInstructions(...args),
    },
  },
}));

describe("AgentsMdSection", () => {
  const projectId = "proj-1";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
    );
    mockGetAgentsInstructions.mockResolvedValue({ content: "# Agent Instructions\n\nUse bd for tasks." });
    mockUpdateAgentsInstructions.mockResolvedValue({ saved: true });
  });

  function renderSection() {
    return render(
      <ThemeProvider>
        <AgentsMdSection projectId={projectId} />
      </ThemeProvider>
    );
  }

  it("fetches content on mount and displays markdown in view mode", async () => {
    renderSection();

    expect(mockGetAgentsInstructions).toHaveBeenCalledWith(projectId);

    await screen.findByTestId("agents-md-view");
    expect(screen.getByText("Agent Instructions (AGENTS.md)")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Agent Instructions");
    expect(screen.getByText("Use bd for tasks.")).toBeInTheDocument();
    expect(screen.getByTestId("agents-md-edit")).toBeInTheDocument();
  });

  it("shows placeholder when content is empty", async () => {
    mockGetAgentsInstructions.mockResolvedValue({ content: "" });
    renderSection();

    await screen.findByTestId("agents-md-view");
    expect(screen.getByText(/No agent instructions yet. Click Edit to add./)).toBeInTheDocument();
  });

  it("shows loading state initially", () => {
    mockGetAgentsInstructions.mockImplementation(() => new Promise(() => {}));
    renderSection();

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows error when fetch fails", async () => {
    mockGetAgentsInstructions.mockRejectedValue(new Error("Network error"));
    renderSection();

    await screen.findByText(/Network error|Failed to load/);
    expect(screen.getByText("Agent Instructions (AGENTS.md)")).toBeInTheDocument();
  });

  it("switches to edit mode when Edit is clicked", async () => {
    const user = userEvent.setup();
    renderSection();

    await screen.findByTestId("agents-md-view");
    await user.click(screen.getByTestId("agents-md-edit"));

    const textarea = screen.getByTestId("agents-md-textarea");
    expect(textarea).toBeInTheDocument();
    expect(textarea).toHaveValue("# Agent Instructions\n\nUse bd for tasks.");
    expect(screen.getByTestId("agents-md-save")).toBeInTheDocument();
    expect(screen.getByTestId("agents-md-cancel")).toBeInTheDocument();
  });

  it("calls PUT and returns to view mode on Save", async () => {
    const user = userEvent.setup();
    renderSection();

    await screen.findByTestId("agents-md-view");
    await user.click(screen.getByTestId("agents-md-edit"));

    const textarea = screen.getByTestId("agents-md-textarea");
    await user.clear(textarea);
    await user.type(textarea, "# Updated\n\nNew content.");

    await user.click(screen.getByTestId("agents-md-save"));

    expect(mockUpdateAgentsInstructions).toHaveBeenCalledWith(projectId, "# Updated\n\nNew content.");

    expect(screen.getByTestId("agents-md-saved")).toHaveTextContent("Saved");
    await screen.findByTestId("agents-md-view");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Updated");
    expect(screen.getByText("New content.")).toBeInTheDocument();
  });

  it("discards changes and returns to view mode on Cancel", async () => {
    const user = userEvent.setup();
    renderSection();

    await screen.findByTestId("agents-md-view");
    await user.click(screen.getByTestId("agents-md-edit"));

    const textarea = screen.getByTestId("agents-md-textarea");
    await user.clear(textarea);
    await user.type(textarea, "Discarded content");

    await user.click(screen.getByTestId("agents-md-cancel"));

    expect(mockUpdateAgentsInstructions).not.toHaveBeenCalled();
    await screen.findByTestId("agents-md-view");
    expect(screen.getByText("Use bd for tasks.")).toBeInTheDocument();
  });

  it("shows error feedback when save fails", async () => {
    mockUpdateAgentsInstructions.mockRejectedValue(new Error("Save failed"));
    const user = userEvent.setup();
    renderSection();

    await screen.findByTestId("agents-md-view");
    await user.click(screen.getByTestId("agents-md-edit"));
    await user.click(screen.getByTestId("agents-md-save"));

    expect(screen.getByText("Save failed")).toBeInTheDocument();
  });
});
