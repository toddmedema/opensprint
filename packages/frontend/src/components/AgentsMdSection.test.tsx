import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "../contexts/ThemeContext";
import { AgentsMdSection } from "./AgentsMdSection";

const mockGetAgentsInstructions = vi.fn();
const mockUpdateAgentsInstructions = vi.fn();
const mockGetAgentsInstructionsForRole = vi.fn();
const mockUpdateAgentsInstructionsForRole = vi.fn();

vi.mock("../api/client", () => ({
  api: {
    projects: {
      getAgentsInstructions: (...args: unknown[]) => mockGetAgentsInstructions(...args),
      updateAgentsInstructions: (...args: unknown[]) => mockUpdateAgentsInstructions(...args),
      getAgentsInstructionsForRole: (...args: unknown[]) =>
        mockGetAgentsInstructionsForRole(...args),
      updateAgentsInstructionsForRole: (...args: unknown[]) =>
        mockUpdateAgentsInstructionsForRole(...args),
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
    mockGetAgentsInstructionsForRole.mockResolvedValue({ content: "" });
    mockUpdateAgentsInstructionsForRole.mockResolvedValue({ saved: true });
  });

  function renderSection(opts?: { testMode?: boolean }) {
    return render(
      <ThemeProvider>
        <AgentsMdSection projectId={projectId} testMode={opts?.testMode} />
      </ThemeProvider>
    );
  }

  it.each([true, false])(
    "leaves no feedback timer when unmounted (save completed: %s)",
    async (completeBeforeUnmount) => {
      let finishSave!: () => void;
      mockUpdateAgentsInstructions.mockReturnValue(
        new Promise<void>((resolve) => {
          finishSave = resolve;
        })
      );
      const { unmount } = renderSection({ testMode: true });
      await screen.findByTestId("agents-md-view");
      fireEvent.click(screen.getByTestId("agents-md-edit"));
      const textarea = screen.getByTestId("agents-md-textarea");
      fireEvent.change(textarea, { target: { value: "Updated instructions" } });
      vi.useFakeTimers();
      try {
        await act(async () => {
          fireEvent.blur(textarea);
        });
        expect(mockUpdateAgentsInstructions).toHaveBeenCalledWith(
          projectId,
          "Updated instructions"
        );
        if (completeBeforeUnmount) {
          await act(async () => {
            finishSave();
          });
          expect(screen.getByTestId("agents-md-saved")).toHaveTextContent("Saved");
          expect(vi.getTimerCount()).toBe(1);
        }
        unmount();
        await act(async () => {
          finishSave();
        });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        unmount();
        vi.useRealTimers();
      }
    }
  );

  it("fetches content on mount and displays markdown in view mode", async () => {
    renderSection();

    expect(mockGetAgentsInstructions).toHaveBeenCalledWith(projectId);

    await screen.findByTestId("agents-md-view");
    await screen.findByText("Use bd for tasks.");
    expect(
      screen.getByRole("heading", { level: 3, name: "Agent Instructions" })
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Agent Instructions");
    expect(screen.getByTestId("agents-md-edit")).toBeInTheDocument();
  });

  it("keeps title, subtext, and Edit action in one row", async () => {
    renderSection();

    await screen.findByTestId("agents-md-view");
    const title = screen.getByRole("heading", { level: 3, name: "Agent Instructions" });
    const subtext = screen.getByText(
      /Project-specific overrides for all agents\. Open Sprint defaults are always applied\./
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
    expect(
      screen.getByText(/No project-specific overrides yet. Open Sprint defaults still apply\./)
    ).toBeInTheDocument();
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
    expect(
      screen.getByRole("heading", { level: 3, name: "Agent Instructions" })
    ).toBeInTheDocument();
  });

  it("switches to edit mode when Edit is clicked", async () => {
    const user = userEvent.setup();
    renderSection({ testMode: true });

    await screen.findByTestId("agents-md-view");
    await user.click(screen.getByTestId("agents-md-edit"));

    const textarea = screen.getByTestId("agents-md-textarea");
    expect(textarea).toBeInTheDocument();
    expect(textarea).toHaveValue("# Agent Instructions\n\nUse bd for tasks.");
    expect(screen.getByTestId("agents-md-save")).toBeInTheDocument();
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

  it("shows Save button and saves on click in edit mode", async () => {
    const user = userEvent.setup();
    renderSection({ testMode: true });

    await screen.findByTestId("agents-md-view");
    await user.click(screen.getByTestId("agents-md-edit"));

    expect(screen.getByTestId("agents-md-save")).toBeInTheDocument();
    const textarea = screen.getByTestId("agents-md-textarea");
    await user.clear(textarea);
    await user.type(textarea, "# Updated\n\nNew content.");
    await user.click(screen.getByTestId("agents-md-save"));

    await waitFor(() =>
      expect(mockUpdateAgentsInstructions).toHaveBeenCalledWith(
        projectId,
        "# Updated\n\nNew content."
      )
    );
    expect(screen.getByTestId("agents-md-saved")).toHaveTextContent("Saved");
    await screen.findByTestId("agents-md-view");
  });

  it("loads role-specific content when switching to role tab", async () => {
    mockGetAgentsInstructionsForRole.mockResolvedValue({
      content: "# Coder instructions\n\nPrefer TypeScript.",
    });
    const user = userEvent.setup();
    renderSection({ testMode: true });

    await screen.findByTestId("agents-md-view");
    await user.click(screen.getByTestId("agents-tab-coder"));

    await waitFor(() =>
      expect(mockGetAgentsInstructionsForRole).toHaveBeenCalledWith(projectId, "coder")
    );
    expect(screen.getByText("Prefer TypeScript.")).toBeInTheDocument();
  });

  it("switches tabs and loads correct content per tab (General, Coder, Reviewer)", async () => {
    mockGetAgentsInstructionsForRole
      .mockResolvedValueOnce({ content: "# Coder\n\nPrefer TypeScript." })
      .mockResolvedValueOnce({ content: "# Reviewer\n\nCheck for security issues." });
    const user = userEvent.setup();
    renderSection({ testMode: true });

    await screen.findByTestId("agents-md-view");
    expect(mockGetAgentsInstructions).toHaveBeenCalledWith(projectId);
    expect(mockGetAgentsInstructionsForRole).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("agents-tab-coder"));
    await waitFor(() =>
      expect(mockGetAgentsInstructionsForRole).toHaveBeenCalledWith(projectId, "coder")
    );
    expect(screen.getByText("Prefer TypeScript.")).toBeInTheDocument();

    await user.click(screen.getByTestId("agents-tab-reviewer"));
    await waitFor(() =>
      expect(mockGetAgentsInstructionsForRole).toHaveBeenCalledWith(projectId, "reviewer")
    );
    expect(screen.getByText("Check for security issues.")).toBeInTheDocument();

    await user.click(screen.getByTestId("agents-tab-general"));
    await waitFor(() => expect(screen.getByText("Use bd for tasks.")).toBeInTheDocument());
  });

  it("saves role content via API when on Coder tab (testMode, on blur)", async () => {
    mockGetAgentsInstructionsForRole.mockResolvedValue({ content: "" });
    const user = userEvent.setup();
    renderSection({ testMode: true });

    await screen.findByTestId("agents-md-view");
    await user.click(screen.getByTestId("agents-tab-coder"));
    await waitFor(() =>
      expect(mockGetAgentsInstructionsForRole).toHaveBeenCalledWith(projectId, "coder")
    );

    await user.click(screen.getByTestId("agents-md-edit"));
    const textarea = screen.getByTestId("agents-md-textarea");
    await user.clear(textarea);
    await user.type(textarea, "# Coder rules\n\nUse strict mode.");
    fireEvent.blur(textarea);

    await waitFor(() =>
      expect(mockUpdateAgentsInstructionsForRole).toHaveBeenCalledWith(
        projectId,
        "coder",
        "# Coder rules\n\nUse strict mode."
      )
    );
    expect(mockUpdateAgentsInstructions).not.toHaveBeenCalled();
    expect(screen.getByTestId("agents-md-saved")).toHaveTextContent("Saved");
  });

  it("saves role content via API when on Reviewer tab (testMode, Save button)", async () => {
    mockGetAgentsInstructionsForRole.mockResolvedValue({ content: "" });
    const user = userEvent.setup();
    renderSection({ testMode: true });

    await screen.findByTestId("agents-md-view");
    await user.click(screen.getByTestId("agents-tab-reviewer"));
    await waitFor(() =>
      expect(mockGetAgentsInstructionsForRole).toHaveBeenCalledWith(projectId, "reviewer")
    );

    await user.click(screen.getByTestId("agents-md-edit"));
    const textarea = screen.getByTestId("agents-md-textarea");
    await user.clear(textarea);
    await user.type(textarea, "# Reviewer rules\n\nCheck tests.");
    await user.click(screen.getByTestId("agents-md-save"));

    await waitFor(() =>
      expect(mockUpdateAgentsInstructionsForRole).toHaveBeenCalledWith(
        projectId,
        "reviewer",
        "# Reviewer rules\n\nCheck tests."
      )
    );
    expect(mockUpdateAgentsInstructions).not.toHaveBeenCalled();
    expect(screen.getByTestId("agents-md-saved")).toHaveTextContent("Saved");
  });

  it("General tab uses updateAgentsInstructions, role tab uses updateAgentsInstructionsForRole", async () => {
    const user = userEvent.setup();
    renderSection({ testMode: true });

    await screen.findByTestId("agents-md-view");
    await user.click(screen.getByTestId("agents-md-edit"));
    const textarea = screen.getByTestId("agents-md-textarea");
    await user.clear(textarea);
    await user.type(textarea, "General content");
    await user.click(screen.getByTestId("agents-md-save"));

    await waitFor(() =>
      expect(mockUpdateAgentsInstructions).toHaveBeenCalledWith(projectId, "General content")
    );
    expect(mockUpdateAgentsInstructionsForRole).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockGetAgentsInstructionsForRole.mockResolvedValue({ content: "" });
    mockUpdateAgentsInstructionsForRole.mockResolvedValue({ saved: true });
    await user.click(screen.getByTestId("agents-tab-coder"));
    await waitFor(() =>
      expect(mockGetAgentsInstructionsForRole).toHaveBeenCalledWith(projectId, "coder")
    );

    await user.click(screen.getByTestId("agents-md-edit"));
    const coderTextarea = screen.getByTestId("agents-md-textarea");
    await user.clear(coderTextarea);
    await user.type(coderTextarea, "Coder content");
    await user.click(screen.getByTestId("agents-md-save"));

    await waitFor(() =>
      expect(mockUpdateAgentsInstructionsForRole).toHaveBeenCalledWith(
        projectId,
        "coder",
        "Coder content"
      )
    );
    expect(mockUpdateAgentsInstructions).not.toHaveBeenCalled();
  });

  it("shows role placeholder when role tab content is empty", async () => {
    mockGetAgentsInstructionsForRole.mockResolvedValue({ content: "" });
    const user = userEvent.setup();
    renderSection({ testMode: true });

    await screen.findByTestId("agents-md-view");
    await user.click(screen.getByTestId("agents-tab-coder"));

    await waitFor(() =>
      expect(mockGetAgentsInstructionsForRole).toHaveBeenCalledWith(projectId, "coder")
    );
    expect(
      screen.getByText(/No role-specific override yet. Open Sprint defaults still apply\./)
    ).toBeInTheDocument();
  });

  it("describes role tabs as project-specific overrides layered on defaults", async () => {
    mockGetAgentsInstructionsForRole.mockResolvedValue({ content: "" });
    const user = userEvent.setup();
    renderSection({ testMode: true });

    await screen.findByTestId("agents-md-view");
    await user.click(screen.getByTestId("agents-tab-coder"));

    expect(
      await screen.findByText(
        /Project-specific overrides for Coder\. Combined with Open Sprint defaults and General/
      )
    ).toBeInTheDocument();
  });

  it("tab list is keyboard-navigable", async () => {
    mockGetAgentsInstructionsForRole.mockResolvedValue({ content: "" });
    const user = userEvent.setup();
    renderSection({ testMode: true });

    await screen.findByTestId("agents-md-view");
    const generalTab = screen.getByTestId("agents-tab-general");
    generalTab.focus();

    await user.keyboard("{ArrowRight}");
    await waitFor(() =>
      expect(mockGetAgentsInstructionsForRole).toHaveBeenCalledWith(projectId, "dreamer")
    );
  });

  it("shows markdown editor toolbar when not in test mode (lazy-loaded)", async () => {
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
