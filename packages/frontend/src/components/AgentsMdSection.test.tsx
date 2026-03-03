import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "../contexts/ThemeContext";
import { AgentsMdSection } from "./AgentsMdSection";

const mockGetAgentsInstructions = vi.fn();
const mockUpdateAgentsInstructions = vi.fn();

vi.mock("prettier", () => ({
  format: (content: string) => Promise.resolve(content),
}));
vi.mock("prettier/plugins/markdown", () => ({ default: {} }));

vi.mock("@uiw/react-md-editor", () => ({
  default: function MockMDEditor({
    value,
    onChange,
  }: {
    value: string;
    onChange: (v: string | undefined) => void;
  }) {
    return (
      <div data-testid="mock-md-editor">
        <button type="button" aria-label="Bold" onClick={() => onChange(value)}>
          Bold
        </button>
        <button type="button" aria-label="Italic" onClick={() => onChange(value)}>
          Italic
        </button>
        <textarea
          data-testid="mock-md-editor-textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  },
}));

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
    mockGetAgentsInstructions.mockResolvedValue({
      content: "# Agent Instructions\n\nUse bd for tasks.",
    });
    mockUpdateAgentsInstructions.mockResolvedValue({ saved: true });
  });

  function renderSection(opts?: { testMode?: boolean }) {
    return render(
      <ThemeProvider>
        <AgentsMdSection projectId={projectId} testMode={opts?.testMode} />
      </ThemeProvider>
    );
  }

  it("fetches content on mount and displays markdown in view mode", async () => {
    renderSection();

    expect(mockGetAgentsInstructions).toHaveBeenCalledWith(projectId);

    await screen.findByTestId("agents-md-view");
    await screen.findByText("Use bd for tasks.");
    expect(screen.getByText("Agent Instructions (AGENTS.md)")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Agent Instructions");
    expect(screen.getByTestId("agents-md-edit")).toBeInTheDocument();
  });

  it("keeps title, subtext, and Edit action in one row", async () => {
    renderSection();

    await screen.findByTestId("agents-md-view");
    const title = screen.getByText("Agent Instructions (AGENTS.md)");
    const subtext = screen.getByText(
      /Agent-specific instructions read by coding agents\. Edit to customize behavior/
    );
    const editBtn = screen.getByTestId("agents-md-edit");
    const headerBlock = title.closest("div");
    expect(headerBlock).toContainElement(subtext);
    expect(headerBlock?.parentElement).toContainElement(editBtn);
    expect(title.className).toContain("leading-tight");
    expect(headerBlock?.parentElement?.className).toContain("items-center");
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
    renderSection({ testMode: true });

    await screen.findByTestId("agents-md-view");
    await user.click(screen.getByTestId("agents-md-edit"));

    const textarea = screen.getByTestId("agents-md-textarea");
    expect(textarea).toBeInTheDocument();
    expect(textarea).toHaveValue("# Agent Instructions\n\nUse bd for tasks.");
    expect(screen.getByTestId("agents-md-prettify")).toBeInTheDocument();
  });

  it("calls PUT and returns to view mode on blur", async () => {
    const user = userEvent.setup();
    renderSection({ testMode: true });

    await screen.findByTestId("agents-md-view");
    await user.click(screen.getByTestId("agents-md-edit"));

    const textarea = screen.getByTestId("agents-md-textarea");
    await user.clear(textarea);
    await user.type(textarea, "# Updated\n\nNew content.");
    fireEvent.blur(textarea);

    await waitFor(() =>
      expect(mockUpdateAgentsInstructions).toHaveBeenCalledWith(
        projectId,
        "# Updated\n\nNew content."
      )
    );

    expect(screen.getByTestId("agents-md-saved")).toHaveTextContent("Saved");
    await screen.findByTestId("agents-md-view");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Updated");
    expect(screen.getByText("New content.")).toBeInTheDocument();
  });

  it("saves changes on blur (no cancel - changes persist)", async () => {
    const user = userEvent.setup();
    renderSection({ testMode: true });

    await screen.findByTestId("agents-md-view");
    await user.click(screen.getByTestId("agents-md-edit"));

    const textarea = screen.getByTestId("agents-md-textarea");
    await user.clear(textarea);
    await user.type(textarea, "Discarded content");
    fireEvent.blur(textarea);

    await waitFor(() =>
      expect(mockUpdateAgentsInstructions).toHaveBeenCalledWith(projectId, "Discarded content")
    );
    await screen.findByTestId("agents-md-view");
    expect(screen.getByText("Discarded content")).toBeInTheDocument();
  });

  it("shows error feedback when save fails on blur", async () => {
    mockUpdateAgentsInstructions.mockRejectedValue(new Error("Save failed"));
    const user = userEvent.setup();
    renderSection({ testMode: true });

    await screen.findByTestId("agents-md-view");
    await user.click(screen.getByTestId("agents-md-edit"));
    const textarea = screen.getByTestId("agents-md-textarea");
    fireEvent.blur(textarea);

    expect(await screen.findByText(/Save failed/)).toBeInTheDocument();
  });

  it("shows Prettify button and formats on demand in edit mode", async () => {
    const user = userEvent.setup();
    renderSection({ testMode: true });

    await screen.findByTestId("agents-md-view");
    await user.click(screen.getByTestId("agents-md-edit"));

    expect(screen.getByTestId("agents-md-prettify")).toBeInTheDocument();
    const textarea = screen.getByTestId("agents-md-textarea");
    await user.clear(textarea);
    await user.type(textarea, "#  Title\n\n- item1\n- item2");
    await user.click(screen.getByTestId("agents-md-prettify"));

    expect(textarea).toHaveValue("#  Title\n\n- item1\n- item2");
  });

  it("shows MDEditor with toolbar when not in test mode (lazy-loaded)", async () => {
    const user = userEvent.setup();
    renderSection();

    await screen.findByTestId("agents-md-view");
    await user.click(screen.getByTestId("agents-md-edit"));

    const editor = await screen.findByTestId("agents-md-editor");
    expect(editor).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /bold/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /italic/i })).toBeInTheDocument();
  });
});
