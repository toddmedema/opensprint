import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "../contexts/ThemeContext";
import { DisplayPreferencesProvider } from "../contexts/DisplayPreferencesContext";
import { ProjectSettingsModal } from "./ProjectSettingsModal";
import type { Project } from "@opensprint/shared";

const storage: Record<string, string> = {};

const mockGetSettings = vi.fn();
const mockUpdate = vi.fn();
const mockUpdateSettings = vi.fn();
const mockGetKeys = vi.fn();
const mockModelsList = vi.fn();

vi.mock("../api/client", () => ({
  api: {
    projects: {
      getSettings: (...args: unknown[]) => mockGetSettings(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      updateSettings: (...args: unknown[]) => mockUpdateSettings(...args),
    },
    env: {
      getKeys: (...args: unknown[]) => mockGetKeys(...args),
    },
    models: {
      list: (...args: unknown[]) => mockModelsList(...args),
    },
  },
}));

const mockProject: Project = {
  id: "proj-1",
  name: "Test Project",
  repoPath: "/path/to/repo",
  currentPhase: "execute",
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

const mockSettings = {
  simpleComplexityAgent: { type: "claude" as const, model: "claude-3-5-sonnet", cliCommand: null },
  complexComplexityAgent: { type: "claude" as const, model: "claude-3-5-sonnet", cliCommand: null },
  deployment: { mode: "custom" as const },
  hilConfig: {
    scopeChanges: "requires_approval" as const,
    architectureDecisions: "requires_approval" as const,
    dependencyModifications: "requires_approval" as const,
  },
  testFramework: null as string | null,
};

describe("ProjectSettingsModal", () => {
  const onClose = vi.fn();
  const onSaved = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockResolvedValue(mockSettings);
    mockGetKeys.mockResolvedValue({ anthropic: true, cursor: true, claudeCli: true });
    mockModelsList.mockResolvedValue([]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => {
        storage[key] = value;
      },
      removeItem: (key: string) => {
        delete storage[key];
      },
      clear: () => {
        Object.keys(storage).forEach((k) => delete storage[k]);
      },
      length: 0,
      key: () => null,
    });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
    );
    Object.keys(storage).forEach((k) => delete storage[k]);
  });

  function renderModal(ui: ReactElement) {
    return render(
      <ThemeProvider>
        <DisplayPreferencesProvider>{ui}</DisplayPreferencesProvider>
      </ThemeProvider>
    );
  }

  it("renders modal with header, tabs, and content", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);

    await screen.findByText("Project Settings");
    expect(screen.getByText("Project Info")).toBeInTheDocument();
    expect(screen.getByText("Agent Config")).toBeInTheDocument();
    expect(screen.getByText("Deliver")).toBeInTheDocument();
    expect(screen.getByText("Autonomy")).toBeInTheDocument();
    expect(screen.getByText("Display")).toBeInTheDocument();
  });

  it("content area has min-h-0 and overflow-y-auto for proper scroll behavior on Agent Config", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);

    await screen.findByText("Project Settings");

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Simple Complexity");

    const contentArea = screen.getByTestId("settings-modal-content");
    expect(contentArea).toHaveClass("min-h-0");
    expect(contentArea).toHaveClass("overflow-y-auto");
    expect(contentArea).toHaveClass("overscroll-contain");
  });

  it("modal has overflow-hidden and tabs have flex-nowrap to prevent navigation bar layout issues on Agent Config", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);

    await screen.findByText("Project Settings");

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Simple Complexity");

    const modal = screen.getByTestId("settings-modal");
    expect(modal).toHaveClass("overflow-hidden");

    const tabsContainer = screen.getByTestId("settings-modal-tabs");
    expect(tabsContainer).toHaveClass("flex-nowrap");
    expect(tabsContainer).toHaveClass("overflow-y-hidden");
  });

  it("header and tabs have flex-shrink-0 to stay visible when content overflows", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);

    await screen.findByText("Project Settings");

    const header = screen.getByTestId("settings-modal-header");
    expect(header).toHaveClass("flex-shrink-0");

    const tabsContainer = screen.getByTestId("settings-modal-tabs");
    expect(tabsContainer).toHaveClass("flex-shrink-0");
  });

  it("hides API key banner when all keys for selected providers are configured", async () => {
    mockGetKeys.mockResolvedValue({ anthropic: true, cursor: true, claudeCli: true });

    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await screen.findByText("Project Settings");

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Simple Complexity");

    expect(screen.queryByText(/API key required/)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("sk-ant-...")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("key_...")).not.toBeInTheDocument();
  });

  it("shows anthropic key input when claude is selected and key is missing", async () => {
    mockGetKeys.mockResolvedValue({ anthropic: false, cursor: true, claudeCli: true });

    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await screen.findByText("Project Settings");

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText(/API key required/);
    expect(screen.getByPlaceholderText("sk-ant-...")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("key_...")).not.toBeInTheDocument();
  });

  it("shows Code Review section with updated helptext and default review mode", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await screen.findByText("Project Settings");

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Code Review");
    expect(
      screen.getByText(/After the coding agent completes a task, a review agent can validate/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Rejected work is sent back to the coding agent with feedback/)
    ).toBeInTheDocument();

    const reviewModeSelect = screen.getByTestId("review-mode-select");
    expect(reviewModeSelect).toHaveValue("always");
  });

  it("uses Always as default when settings have no reviewMode", async () => {
    mockGetSettings.mockResolvedValue({ ...mockSettings, reviewMode: undefined });

    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await screen.findByText("Project Settings");

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Code Review");
    const reviewModeSelect = screen.getByTestId("review-mode-select");
    expect(reviewModeSelect).toHaveValue("always");
  });

  it("saves reviewMode when changed and Save is clicked", async () => {
    mockGetSettings.mockResolvedValue({ ...mockSettings, reviewMode: "always" });

    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} onSaved={onSaved} />);
    await screen.findByText("Project Settings");

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Code Review");
    const reviewModeSelect = screen.getByTestId("review-mode-select");
    await userEvent.selectOptions(reviewModeSelect, "never");

    const saveButton = screen.getByRole("button", { name: "Save Changes" });
    await userEvent.click(saveButton);

    expect(mockUpdateSettings).toHaveBeenCalledWith(
      "proj-1",
      expect.objectContaining({
        reviewMode: "never",
      })
    );
  });

  it("Autonomy tab shows only configurable HIL categories (no testFailuresAndRetries)", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await screen.findByText("Project Settings");

    const autonomyTab = screen.getByRole("button", { name: "Autonomy" });
    await userEvent.click(autonomyTab);

    expect(screen.getByText("Scope Changes")).toBeInTheDocument();
    expect(screen.getByText("Architecture Decisions")).toBeInTheDocument();
    expect(screen.getByText("Dependency Modifications")).toBeInTheDocument();
    expect(screen.queryByText(/Test Failures|testFailuresAndRetries/i)).not.toBeInTheDocument();
  });

  it("Deliver tab shows auto-deploy toggles", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await screen.findByText("Project Settings");

    const deploymentTab = screen.getByRole("button", { name: "Deliver" });
    await userEvent.click(deploymentTab);

    expect(screen.getByText("Auto-deploy on epic completion")).toBeInTheDocument();
    expect(screen.getByText("Auto-deploy on Evaluate resolution")).toBeInTheDocument();
    const epicToggle = screen.getByTestId("auto-deploy-epic-toggle");
    const evalToggle = screen.getByTestId("auto-deploy-eval-toggle");
    expect(epicToggle).not.toBeChecked();
    expect(evalToggle).not.toBeChecked();
  });

  it("saves auto-deploy toggles when changed and Save is clicked", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} onSaved={onSaved} />);
    await screen.findByText("Project Settings");

    const deploymentTab = screen.getByRole("button", { name: "Deliver" });
    await userEvent.click(deploymentTab);

    const epicToggle = screen.getByTestId("auto-deploy-epic-toggle");
    await userEvent.click(epicToggle);

    const saveButton = screen.getByRole("button", { name: "Save Changes" });
    await userEvent.click(saveButton);

    expect(mockUpdateSettings).toHaveBeenCalledWith(
      "proj-1",
      expect.objectContaining({
        deployment: expect.objectContaining({
          autoDeployOnEpicCompletion: true,
          autoDeployOnEvalResolution: false,
        }),
      })
    );
  });

  it("Display tab is last in settings list and shows theme picker", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await screen.findByText("Project Settings");

    const displayTab = screen.getByRole("button", { name: "Display" });
    expect(displayTab).toBeInTheDocument();

    const tabs = screen.getByTestId("settings-modal-tabs");
    const tabButtons = tabs.querySelectorAll("button");
    expect(tabButtons[tabButtons.length - 1]).toHaveTextContent("Display");

    await userEvent.click(displayTab);

    const displaySection = screen.getByTestId("display-section");
    expect(displaySection).toBeInTheDocument();
    expect(screen.getByText("Theme")).toBeInTheDocument();
    expect(screen.getByTestId("theme-option-light")).toBeInTheDocument();
    expect(screen.getByTestId("theme-option-dark")).toBeInTheDocument();
    expect(screen.getByTestId("theme-option-system")).toBeInTheDocument();

    expect(screen.getByText("Running agents display mode")).toBeInTheDocument();
    const runningAgentsSelect = screen.getByTestId("running-agents-display-mode");
    expect(runningAgentsSelect).toBeInTheDocument();
    expect(runningAgentsSelect).toHaveValue("count");
    const options = within(runningAgentsSelect).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Count", "Icons", "Both"]);
  });

  it("Display theme picker persists to localStorage and applies immediately", async () => {
    const user = userEvent.setup();
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await screen.findByText("Project Settings");

    const displayTab = screen.getByRole("button", { name: "Display" });
    await user.click(displayTab);

    await user.click(screen.getByTestId("theme-option-dark"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("opensprint.theme")).toBe("dark");

    await user.click(screen.getByTestId("theme-option-light"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("opensprint.theme")).toBe("light");
  });

  it("Display theme picker defaults to System for new users", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await screen.findByText("Project Settings");

    const displayTab = screen.getByRole("button", { name: "Display" });
    await userEvent.click(displayTab);

    expect(screen.getByTestId("theme-option-system")).toHaveClass("bg-brand-600");
  });

  it("Agent Config tab shows exactly two agent sections: Simple Complexity and Complex Complexity", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await screen.findByText("Project Settings");

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Simple Complexity");
    expect(
      screen.getByText("Used for routine tasks (low and medium complexity plans)")
    ).toBeInTheDocument();
    expect(screen.getByText("Complex Complexity")).toBeInTheDocument();
    expect(
      screen.getByText("Used for challenging tasks (high and very high complexity plans)")
    ).toBeInTheDocument();

    expect(screen.queryByText(/Planning Agent Slot|Coding Agent Slot/i)).not.toBeInTheDocument();
  });

  it("saves simpleComplexityAgent and complexComplexityAgent when Save is clicked", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} onSaved={onSaved} />);
    await screen.findByText("Project Settings");

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Simple Complexity");
    const saveButton = screen.getByRole("button", { name: "Save Changes" });
    await userEvent.click(saveButton);

    expect(mockUpdateSettings).toHaveBeenCalledWith(
      "proj-1",
      expect.objectContaining({
        simpleComplexityAgent: expect.objectContaining({ type: "claude", model: "claude-3-5-sonnet" }),
        complexComplexityAgent: expect.objectContaining({
          type: "claude",
          model: "claude-3-5-sonnet",
        }),
      })
    );
  });

  it("Agent Config tab shows parallelism slider defaulting to 1", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await screen.findByText("Project Settings");

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Parallelism");
    const slider = screen.getByTestId("max-concurrent-coders-slider");
    expect(slider).toBeInTheDocument();
    expect(slider).toHaveValue("1");
    expect(screen.queryByTestId("unknown-scope-strategy-select")).not.toBeInTheDocument();
  });

  it("saves maxConcurrentCoders and unknownScopeStrategy when changed", async () => {
    mockGetSettings.mockResolvedValue({
      ...mockSettings,
      maxConcurrentCoders: 3,
      unknownScopeStrategy: "conservative",
    });

    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} onSaved={onSaved} />);
    await screen.findByText("Project Settings");

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Parallelism");

    const saveButton = screen.getByRole("button", { name: "Save Changes" });
    await userEvent.click(saveButton);

    expect(mockUpdateSettings).toHaveBeenCalledWith(
      "proj-1",
      expect.objectContaining({
        maxConcurrentCoders: 3,
        unknownScopeStrategy: "conservative",
      })
    );
  });

  it("Agent Config tab shows Git working mode directly above Parallelism in Worktree mode", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await screen.findByText("Project Settings");

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    const gitWorkingModeHeading = screen.getByText("Git working mode");
    const parallelismHeading = screen.getByText("Parallelism");
    expect(gitWorkingModeHeading.compareDocumentPosition(parallelismHeading)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it("Agent Config tab shows Git working mode dropdown defaulting to Worktree", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await screen.findByText("Project Settings");

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    const select = screen.getByTestId("git-working-mode-select");
    expect(select).toBeInTheDocument();
    expect(select).toHaveValue("worktree");
    expect(
      screen.getByText(/Worktree: isolated directories per task, supports parallel agents/)
    ).toBeInTheDocument();
  });

  it("when Branches selected, hides Parallelism section and shows explanatory text", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await screen.findByText("Project Settings");

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    const select = screen.getByTestId("git-working-mode-select");
    await userEvent.selectOptions(select, "branches");

    expect(screen.getByText("Branches mode uses a single coder.")).toBeInTheDocument();
    expect(screen.queryByText("Parallelism")).not.toBeInTheDocument();
    expect(screen.queryByTestId("max-concurrent-coders-slider")).not.toBeInTheDocument();
  });

  it("saves gitWorkingMode when changed", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} onSaved={onSaved} />);
    await screen.findByText("Project Settings");

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    const select = screen.getByTestId("git-working-mode-select");
    await userEvent.selectOptions(select, "branches");

    const saveButton = screen.getByRole("button", { name: "Save Changes" });
    await userEvent.click(saveButton);

    expect(mockUpdateSettings).toHaveBeenCalledWith(
      "proj-1",
      expect.objectContaining({
        gitWorkingMode: "branches",
        maxConcurrentCoders: 1,
      })
    );
  });
});
