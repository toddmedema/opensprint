import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "../contexts/ThemeContext";
import { DisplayPreferencesProvider } from "../contexts/DisplayPreferencesContext";
import { ProjectSettingsModal } from "./ProjectSettingsModal";
import type { Project } from "@opensprint/shared";

const storage: Record<string, string> = {};

const mockGetSettings = vi.fn();
const mockUpdate = vi.fn();
const mockUpdateSettings = vi.fn();
const mockGetAgentsInstructions = vi.fn();
const mockUpdateAgentsInstructions = vi.fn();
const mockGetKeys = vi.fn();
const mockModelsList = vi.fn();

const mockGlobalSettingsGet = vi.fn();
const mockGlobalSettingsPut = vi.fn();

vi.mock("../api/client", () => ({
  api: {
    projects: {
      getSettings: (...args: unknown[]) => mockGetSettings(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      updateSettings: (...args: unknown[]) => mockUpdateSettings(...args),
      getAgentsInstructions: (...args: unknown[]) => mockGetAgentsInstructions(...args),
      updateAgentsInstructions: (...args: unknown[]) => mockUpdateAgentsInstructions(...args),
    },
    env: {
      getKeys: (...args: unknown[]) => mockGetKeys(...args),
    },
    models: {
      list: (...args: unknown[]) => mockModelsList(...args),
    },
    globalSettings: {
      get: () => mockGlobalSettingsGet(),
      put: (...args: unknown[]) => mockGlobalSettingsPut(...args),
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
  aiAutonomyLevel: "confirm_all" as const,
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
    mockGlobalSettingsGet.mockResolvedValue({
      databaseUrl: "",
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "a", masked: "••••••••" }],
        CURSOR_API_KEY: [{ id: "b", masked: "••••••••" }],
      },
    });
    mockGetAgentsInstructions.mockResolvedValue({
      content: "# Agent Instructions\n\nUse bd for tasks.",
    });
    mockUpdateAgentsInstructions.mockResolvedValue({ saved: true });
    mockGetKeys.mockResolvedValue({
      anthropic: true,
      cursor: true,
      openai: true,
      claudeCli: true,
      useCustomCli: false,
    });
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

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderModal(ui: ReactElement) {
    return render(
      <MemoryRouter>
        <ThemeProvider>
          <DisplayPreferencesProvider>{ui}</DisplayPreferencesProvider>
        </ThemeProvider>
      </MemoryRouter>
    );
  }

  /** Wait for modal to be ready (no "Settings" header per new layout) */
  async function waitForModalReady() {
    await screen.findByTestId("settings-modal-content");
  }

  it("renders modal with sub-tabs bar and project tabs", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);

    await waitForModalReady();
    expect(screen.getByTestId("settings-sub-tabs-bar")).toBeInTheDocument();
    expect(screen.getByText("Project Info")).toBeInTheDocument();
    expect(screen.getByText("Agent Config")).toBeInTheDocument();
    expect(screen.getByText("Deliver")).toBeInTheDocument();
    expect(screen.getByText("Autonomy")).toBeInTheDocument();
    expect(screen.getByText("Team")).toBeInTheDocument();
  });

  it("content area has min-h-0 and overflow-y-auto for proper scroll behavior on Agent Config", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);

    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Task Complexity");

    const contentArea = screen.getByTestId("settings-modal-content");
    expect(contentArea).toHaveClass("min-h-0");
    expect(contentArea).toHaveClass("overflow-y-auto");
    expect(contentArea).toHaveClass("overscroll-contain");
  });

  it("modal has overflow-hidden and sub-tabs bar for layout", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);

    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Task Complexity");

    const modal = screen.getByTestId("settings-modal");
    expect(modal).toHaveClass("overflow-hidden");

    const tabsBar = screen.getByTestId("settings-sub-tabs-bar");
    expect(tabsBar).toBeInTheDocument();
  });

  it("header has flex-shrink-0 to stay visible when content overflows", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);

    await waitForModalReady();

    const header = screen.getByTestId("settings-modal-header");
    expect(header).toHaveClass("flex-shrink-0");
  });

  it("hides API key banner when all keys for selected providers are configured", async () => {
    mockGlobalSettingsGet.mockResolvedValue({
      databaseUrl: "",
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "a", masked: "••••••••" }],
        CURSOR_API_KEY: [{ id: "b", masked: "••••••••" }],
      },
    });

    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Task Complexity");

    expect(screen.queryByText(/API key required/)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("sk-ant-...")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("key_...")).not.toBeInTheDocument();
  });

  it("shows configure-in-settings link when claude is selected and key is missing", async () => {
    mockGlobalSettingsGet.mockResolvedValue({
      databaseUrl: "",
      apiKeys: {
        CURSOR_API_KEY: [{ id: "b", masked: "••••••••" }],
      },
    });

    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText(/API key required/);
    const link = screen.getByTestId("configure-api-keys-link");
    expect(link).toHaveTextContent("Configure API keys in Settings");
    expect(link).toHaveAttribute("href", "/projects/proj-1/settings?level=global");
    expect(screen.queryByPlaceholderText("sk-ant-...")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("key_...")).not.toBeInTheDocument();
  });

  it("Agent Config tab does not show ApiKeysSection (API keys managed in Global Settings only)", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Task Complexity");
    expect(screen.queryByTestId("api-keys-section")).not.toBeInTheDocument();
    expect(screen.queryByTestId("api-key-add-ANTHROPIC_API_KEY")).not.toBeInTheDocument();
  });

  it("shows Code Review section with updated helptext and default review mode", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

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
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Code Review");
    const reviewModeSelect = screen.getByTestId("review-mode-select");
    expect(reviewModeSelect).toHaveValue("always");
  });

  it("saves reviewMode when changed on blur", async () => {
    mockGetSettings.mockResolvedValue({ ...mockSettings, reviewMode: "always" });

    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} onSaved={onSaved} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Code Review");
    const reviewModeSelect = screen.getByTestId("review-mode-select");
    await userEvent.selectOptions(reviewModeSelect, "never");
    fireEvent.blur(reviewModeSelect);

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({
          reviewMode: "never",
        })
      )
    );
  });

  it("shows General first and checked by default when reviewAngles is empty", async () => {
    mockGetSettings.mockResolvedValue({ ...mockSettings, reviewAngles: undefined });

    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Code Review");
    const multiselect = screen.getByTestId("review-agents-multiselect");
    const firstCheckbox = within(multiselect).getAllByRole("checkbox")[0];
    expect(firstCheckbox).toHaveAccessibleName("General");
    expect(firstCheckbox).toBeChecked();
  });

  it("disables General checkbox when it is the only selected option", async () => {
    mockGetSettings.mockResolvedValue({ ...mockSettings, reviewAngles: undefined });

    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Code Review");
    const generalCheckbox = screen.getByRole("checkbox", { name: /^General$/i });
    expect(generalCheckbox).toBeChecked();
    expect(generalCheckbox).toBeDisabled();
  });

  it("disables angle checkbox when it is the only selected option", async () => {
    mockGetSettings.mockResolvedValue({ ...mockSettings, reviewAngles: ["security"] });

    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Code Review");
    const securityCheckbox = screen.getByRole("checkbox", { name: /Security implications/i });
    expect(securityCheckbox).toBeChecked();
    expect(securityCheckbox).toBeDisabled();
  });

  it("shows review agents multi-select and persists selection", async () => {
    mockGetSettings.mockResolvedValue({ ...mockSettings, reviewAngles: undefined });

    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} onSaved={onSaved} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Code Review");
    expect(screen.getByText("Review agents")).toBeInTheDocument();
    const multiselect = screen.getByTestId("review-agents-multiselect");
    expect(multiselect).toBeInTheDocument();
    expect(
      screen.getByText(
        "Leave empty for one general review. Select one or more angles for parallel angle-specific reviews."
      )
    ).toBeInTheDocument();
    expect(within(multiselect).getByText("General")).toBeInTheDocument();
    expect(within(multiselect).getByText("Security implications")).toBeInTheDocument();
    expect(within(multiselect).getByText("Performance impact")).toBeInTheDocument();

    const securityCheckbox = screen.getByRole("checkbox", { name: /Security implications/i });
    await userEvent.click(securityCheckbox);

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({
          reviewAngles: ["security"],
          includeGeneralReview: true,
        })
      )
    );
  });

  it("adding an angle preserves General and existing angles (additive selection)", async () => {
    mockGetSettings.mockResolvedValue({
      ...mockSettings,
      reviewAngles: ["security"],
      includeGeneralReview: true,
    });

    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} onSaved={onSaved} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Code Review");
    const generalCheckbox = screen.getByRole("checkbox", { name: /^General$/i });
    const securityCheckbox = screen.getByRole("checkbox", { name: /Security implications/i });
    const designCheckbox = screen.getByRole("checkbox", {
      name: /Design, UX and accessibility/i,
    });
    expect(generalCheckbox).toBeChecked();
    expect(securityCheckbox).toBeChecked();
    expect(designCheckbox).not.toBeChecked();

    await userEvent.click(designCheckbox);

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({
          reviewAngles: expect.arrayContaining(["security", "design_ux_accessibility"]),
          includeGeneralReview: true,
        })
      )
    );
    const call = mockUpdateSettings.mock.calls[mockUpdateSettings.mock.calls.length - 1];
    expect(call[1].reviewAngles).toHaveLength(2);
    expect(call[1].reviewAngles).toContain("security");
    expect(call[1].reviewAngles).toContain("design_ux_accessibility");
  });

  it("shows pre-selected review agents when settings have them", async () => {
    mockGetSettings.mockResolvedValue({
      ...mockSettings,
      reviewAngles: ["security", "test_coverage"],
    });

    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Code Review");
    const securityCheckbox = screen.getByRole("checkbox", { name: /Security implications/i });
    const testCoverageCheckbox = screen.getByRole("checkbox", {
      name: /Validating test coverage/i,
    });
    expect(securityCheckbox).toBeChecked();
    expect(testCoverageCheckbox).toBeChecked();
  });

  it("review agent checkboxes have no visible border", async () => {
    mockGetSettings.mockResolvedValue({ ...mockSettings, reviewAngles: undefined });

    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Code Review");
    const securityCheckbox = screen.getByRole("checkbox", { name: /Security implications/i });
    expect(securityCheckbox).toHaveClass("border-0");
  });

  it("shows Self-improvement section with help text and frequency dropdown defaulting to Never", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Self-improvement");
    expect(
      screen.getByText(/When the codebase has changed since the last run, a review runs using your code review lenses and creates improvement tasks\./)
    ).toBeInTheDocument();
    const select = screen.getByTestId("self-improvement-frequency-select");
    expect(select).toBeInTheDocument();
    expect(select).toHaveValue("never");
  });

  it("saves selfImprovementFrequency when dropdown is changed", async () => {
    mockGetSettings.mockResolvedValue({ ...mockSettings, selfImprovementFrequency: "never" });

    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} onSaved={onSaved} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByTestId("self-improvement-frequency-select");
    await userEvent.selectOptions(
      screen.getByTestId("self-improvement-frequency-select"),
      "daily"
    );

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({
          selfImprovementFrequency: "daily",
        })
      )
    );
  });

  it("loads and displays persisted selfImprovementFrequency", async () => {
    mockGetSettings.mockResolvedValue({ ...mockSettings, selfImprovementFrequency: "weekly" });

    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    const select = await screen.findByTestId("self-improvement-frequency-select");
    expect(select).toHaveValue("weekly");
  });

  it("shows After each Plan help text when that frequency is selected", async () => {
    mockGetSettings.mockResolvedValue({
      ...mockSettings,
      selfImprovementFrequency: "after_each_plan",
    });

    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Self-improvement");
    expect(
      screen.getByText(/Runs once after a plan's execution is fully complete/)
    ).toBeInTheDocument();
  });

  it("shows Last run when selfImprovementLastRunAt is set", async () => {
    mockGetSettings.mockResolvedValue({
      ...mockSettings,
      selfImprovementLastRunAt: "2025-03-01T14:30:00Z",
    });

    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    const lastRun = await screen.findByTestId("self-improvement-last-run");
    expect(lastRun).toHaveTextContent("Last run:");
    expect(lastRun.textContent).toMatch(/\d/);
  });

  it("Autonomy tab shows AI Autonomy slider with three levels", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const autonomyTab = screen.getByRole("button", { name: "Autonomy" });
    await userEvent.click(autonomyTab);

    expect(screen.getByText("AI Autonomy")).toBeInTheDocument();
    expect(screen.getByText("Confirm all scope changes")).toBeInTheDocument();
    expect(screen.getByText("Major scope changes only")).toBeInTheDocument();
    expect(screen.getByText("Full autonomy")).toBeInTheDocument();
    expect(screen.getByTestId("ai-autonomy-slider")).toBeInTheDocument();
  });

  it("Team tab shows Enable human teammates checkbox; when enabled shows team members list", async () => {
    mockGetSettings.mockResolvedValueOnce({
      ...mockSettings,
      enableHumanTeammates: false,
      teamMembers: [],
    });
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const teamTab = screen.getByRole("button", { name: "Team" });
    await userEvent.click(teamTab);

    expect(screen.getByTestId("team-tab-content")).toBeInTheDocument();
    const checkbox = screen.getByTestId("enable-human-teammates-checkbox");
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText("Enable human teammates")).toBeInTheDocument();
    expect(screen.queryByText("Team Members")).not.toBeInTheDocument();

    await userEvent.click(checkbox);
    await waitFor(() => expect(mockUpdateSettings).toHaveBeenCalledWith("proj-1", expect.objectContaining({ enableHumanTeammates: true })));
  });

  it("Team tab when enableHumanTeammates true shows team members list and add button", async () => {
    mockGetSettings.mockResolvedValueOnce({
      ...mockSettings,
      enableHumanTeammates: true,
      teamMembers: [{ id: "user-1", name: "Alice" }],
    });
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const teamTab = screen.getByRole("button", { name: "Team" });
    await userEvent.click(teamTab);

    expect(screen.getByTestId("team-tab-content")).toBeInTheDocument();
    expect(screen.getByTestId("enable-human-teammates-checkbox")).toBeChecked();
    expect(screen.getByText("Team Members")).toBeInTheDocument();
    expect(screen.getByTestId("team-member-add")).toBeInTheDocument();
    const nameInput = screen.getByTestId("team-member-name-input");
    expect(nameInput).toHaveValue("Alice");
    expect(screen.queryByTestId("team-member-id-input")).not.toBeInTheDocument();
    // No ID column or visible member ID: only display name is shown
    expect(screen.queryByText("user-1")).not.toBeInTheDocument();
    expect(screen.getByText(/Each member has a display name/)).toBeInTheDocument();
  });

  it("Team tab: add member persists to backend", async () => {
    mockGetSettings.mockResolvedValueOnce({
      ...mockSettings,
      enableHumanTeammates: true,
      teamMembers: [],
    });
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const teamTab = screen.getByRole("button", { name: "Team" });
    await userEvent.click(teamTab);

    const addBtn = screen.getByTestId("team-member-add");
    await userEvent.click(addBtn);

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({
          teamMembers: expect.arrayContaining([
            expect.objectContaining({ id: expect.any(String), name: "" }),
          ]),
        })
      )
    );
  });

  it("Team tab: edit member persists to backend", async () => {
    mockGetSettings.mockResolvedValueOnce({
      ...mockSettings,
      enableHumanTeammates: true,
      teamMembers: [{ id: "user-1", name: "Alice" }],
    });
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const teamTab = screen.getByRole("button", { name: "Team" });
    await userEvent.click(teamTab);

    const nameInput = screen.getByTestId("team-member-name-input");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Alice Smith");
    nameInput.blur();

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({
          teamMembers: expect.arrayContaining([
            expect.objectContaining({ id: "user-1", name: "Alice Smith" }),
          ]),
        })
      )
    );
  });

  it("Team tab: remove member persists to backend", async () => {
    mockGetSettings.mockResolvedValueOnce({
      ...mockSettings,
      enableHumanTeammates: true,
      teamMembers: [{ id: "user-1", name: "Alice" }],
    });
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const teamTab = screen.getByRole("button", { name: "Team" });
    await userEvent.click(teamTab);

    const removeBtn = screen.getByTestId("team-member-remove");
    await userEvent.click(removeBtn);

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({
          teamMembers: [],
        })
      )
    );
  });

  it("Deliver tab shows auto-deploy per environment", async () => {
    mockGetSettings.mockResolvedValueOnce({
      ...mockSettings,
      deployment: { mode: "expo" as const },
    });
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const deploymentTab = screen.getByRole("button", { name: "Deliver" });
    await userEvent.click(deploymentTab);

    expect(screen.getByText("Auto-deploy per environment")).toBeInTheDocument();
    expect(screen.getByTestId("auto-deploy-trigger-staging")).toBeInTheDocument();
    expect(screen.getByTestId("auto-deploy-trigger-production")).toBeInTheDocument();
    expect(screen.getByTestId("auto-deploy-trigger-staging")).toHaveValue("none");
    expect(screen.getByTestId("auto-deploy-trigger-production")).toHaveValue("none");
  });

  it("saves deployment mode and auto-deploy trigger immediately on change (no blur)", async () => {
    mockGetSettings.mockResolvedValueOnce({
      ...mockSettings,
      deployment: { mode: "custom" as const },
    });
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} onSaved={onSaved} />);
    await waitForModalReady();

    const deploymentTab = screen.getByRole("button", { name: "Deliver" });
    await userEvent.click(deploymentTab);

    // Switch to Expo mode — should persist immediately without blur
    const expoRadio = screen.getByRole("radio", { name: /Expo\.dev/i });
    await userEvent.click(expoRadio);

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({
          deployment: expect.objectContaining({ mode: "expo" }),
        })
      )
    );

    mockUpdateSettings.mockClear();

    // Change auto-deploy trigger — should persist immediately without blur
    const stagingSelect = screen.getByTestId("auto-deploy-trigger-staging");
    await userEvent.selectOptions(stagingSelect, "each_epic");

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({
          deployment: expect.objectContaining({
            targets: expect.arrayContaining([
              expect.objectContaining({ name: "staging", autoDeployTrigger: "each_epic" }),
              expect.objectContaining({ name: "production", autoDeployTrigger: "none" }),
            ]),
          }),
        })
      )
    );
  });

  it("shows Saving spinner for at least 1000ms on fast project settings save", async () => {
    const timestamps: { saving?: number; saved?: number } = {};
    let seenSaving = false;
    const onSaveStatusChange = vi.fn((status: string) => {
      if (status === "saving") {
        seenSaving = true;
        timestamps.saving = Date.now();
      }
      if (status === "saved" && seenSaving) timestamps.saved = Date.now();
    });
    mockUpdate.mockResolvedValue({});
    mockUpdateSettings.mockResolvedValue({});

    renderModal(
      <ProjectSettingsModal
        project={mockProject}
        onClose={onClose}
        onSaveStatusChange={onSaveStatusChange}
      />
    );
    await waitForModalReady();

    // Change project name and blur to trigger a single save (avoids tab-switch persist)
    const nameInput = screen.getByPlaceholderText("My Awesome App");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Updated Project");
    await userEvent.tab();

    await waitFor(() => {
      expect(timestamps.saving).toBeDefined();
    });
    expect(mockUpdate).toHaveBeenCalled();

    await waitFor(
      () => {
        expect(timestamps.saved).toBeDefined();
      },
      { timeout: 2500 }
    );

    // Spinner must show for at least 1000ms (allow timing variance on CI)
    expect(timestamps.saved! - timestamps.saving!).toBeGreaterThanOrEqual(900);
  });

  it("Custom mode with targets shows per-target auto-deploy dropdowns and env vars per target", async () => {
    mockGetSettings.mockResolvedValueOnce({
      ...mockSettings,
      deployment: {
        mode: "custom" as const,
        targets: [
          { name: "staging", autoDeployTrigger: "each_task" as const },
          { name: "production", autoDeployTrigger: "nightly" as const },
        ],
      },
    });
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const deploymentTab = screen.getByRole("button", { name: "Deliver" });
    await userEvent.click(deploymentTab);

    expect(screen.getByText("Auto-deploy per environment")).toBeInTheDocument();
    expect(screen.getByTestId("auto-deploy-trigger-staging")).toBeInTheDocument();
    expect(screen.getByTestId("auto-deploy-trigger-production")).toBeInTheDocument();
    expect(screen.getByTestId("auto-deploy-trigger-staging")).toHaveValue("each_task");
    expect(screen.getByTestId("auto-deploy-trigger-production")).toHaveValue("nightly");
    expect(screen.getByText("Delivery targets")).toBeInTheDocument();
    const envVarHeadings = screen.getAllByText("Environment variables");
    expect(envVarHeadings.length).toBeGreaterThanOrEqual(2);
  });

  it("Expo mode shows environment variables per target section", async () => {
    mockGetSettings.mockResolvedValueOnce({
      ...mockSettings,
      deployment: { mode: "expo" as const },
    });
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const deploymentTab = screen.getByRole("button", { name: "Deliver" });
    await userEvent.click(deploymentTab);

    expect(screen.getByText("Environment variables per target")).toBeInTheDocument();
  });

  it("adds env var via inline inputs in Deploy settings (no prompt)", async () => {
    const promptSpy = vi.spyOn(window, "prompt").mockImplementation(() => null);
    mockGetSettings.mockResolvedValueOnce({
      ...mockSettings,
      deployment: {
        mode: "custom" as const,
        targets: [
          { name: "staging", command: "./deploy.sh", envVars: {} },
          { name: "production", command: "./deploy.sh" },
        ],
      },
    });
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const deploymentTab = screen.getByRole("button", { name: "Deliver" });
    await userEvent.click(deploymentTab);

    const nameInputs = screen.getAllByTestId("env-var-name-input");
    expect(nameInputs.length).toBeGreaterThanOrEqual(1);
    const valueInputs = screen.getAllByTestId("env-var-value-input");
    expect(valueInputs.length).toBeGreaterThanOrEqual(1);

    await userEvent.type(nameInputs[0]!, "API_KEY");
    fireEvent.blur(nameInputs[0]!);

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({
          deployment: expect.objectContaining({
            targets: expect.arrayContaining([
              expect.objectContaining({
                name: "staging",
                envVars: expect.objectContaining({ API_KEY: "" }),
              }),
            ]),
          }),
        })
      )
    );
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it("saves auto-deploy triggers for Custom mode targets on blur", async () => {
    mockGetSettings.mockResolvedValueOnce({
      ...mockSettings,
      deployment: {
        mode: "custom" as const,
        targets: [
          { name: "staging", command: "./deploy-staging.sh" },
          { name: "production", command: "./deploy-prod.sh" },
        ],
      },
    });
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} onSaved={onSaved} />);
    await waitForModalReady();

    const deploymentTab = screen.getByRole("button", { name: "Deliver" });
    await userEvent.click(deploymentTab);

    const stagingSelect = screen.getByTestId("auto-deploy-trigger-staging");
    await userEvent.selectOptions(stagingSelect, "eval_resolution");
    fireEvent.blur(stagingSelect);

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({
          deployment: expect.objectContaining({
            targets: expect.arrayContaining([
              expect.objectContaining({
                name: "staging",
                command: "./deploy-staging.sh",
                autoDeployTrigger: "eval_resolution",
              }),
              expect.objectContaining({
                name: "production",
                command: "./deploy-prod.sh",
                autoDeployTrigger: "none",
              }),
            ]),
          }),
        })
      )
    );
  });

  it("Agent Config tab shows single Task Complexity section with Simple and Complex rows", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Task Complexity");
    expect(
      screen.getByText(/Simple: routine tasks. Complex: challenging tasks/)
    ).toBeInTheDocument();
    expect(screen.getByText("Simple")).toBeInTheDocument();
    expect(screen.getByText("Complex")).toBeInTheDocument();
    expect(screen.getByTestId("task-complexity-section")).toBeInTheDocument();

    expect(screen.queryByText(/Planning Agent Slot|Coding Agent Slot/i)).not.toBeInTheDocument();
  });

  it("saves simpleComplexityAgent and complexComplexityAgent on blur", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} onSaved={onSaved} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Task Complexity");
    const section = screen.getByTestId("task-complexity-section");
    const firstSelect = within(section).getAllByRole("combobox")[0];
    fireEvent.blur(firstSelect);

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({
          simpleComplexityAgent: expect.objectContaining({
            type: "claude",
            model: "claude-3-5-sonnet",
          }),
          complexComplexityAgent: expect.objectContaining({
            type: "claude",
            model: "claude-3-5-sonnet",
          }),
        })
      )
    );
  });

  it("Agent Config tab shows parallelism slider defaulting to 1", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Parallelism");
    const slider = screen.getByTestId("max-concurrent-coders-slider");
    expect(slider).toBeInTheDocument();
    expect(slider).toHaveValue("1");
    expect(screen.queryByTestId("unknown-scope-strategy-select")).not.toBeInTheDocument();
  });

  it("saves maxConcurrentCoders and unknownScopeStrategy on blur", async () => {
    mockGetSettings.mockResolvedValue({
      ...mockSettings,
      maxConcurrentCoders: 3,
      unknownScopeStrategy: "conservative",
    });

    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} onSaved={onSaved} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Parallelism");
    const slider = screen.getByTestId("max-concurrent-coders-slider");
    fireEvent.blur(slider);

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({
          maxConcurrentCoders: 3,
          unknownScopeStrategy: "conservative",
        })
      )
    );
  });

  it("Agent Config tab shows Git working mode directly above Parallelism in Worktree mode", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

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
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    const select = screen.getByTestId("git-working-mode-select");
    expect(select).toBeInTheDocument();
    expect(select).toHaveValue("worktree");
    expect(
      screen.getByText(/Worktree: isolated directories per task, supports parallel agents/)
    ).toBeInTheDocument();
  });

  it("when Worktree selected, shows Base branch text input", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    const baseBranchInput = screen.getByTestId("worktree-base-branch-input");
    expect(baseBranchInput).toBeInTheDocument();
    expect(baseBranchInput).toHaveValue("main");
  });

  it("shows checking status text when git runtime state is refreshing", async () => {
    mockGetSettings.mockResolvedValueOnce({
      ...mockSettings,
      gitRemoteMode: undefined,
      gitRuntimeStatus: {
        lastCheckedAt: null,
        stale: true,
        refreshing: true,
      },
    });

    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    expect(screen.getByTestId("git-remote-mode")).toHaveTextContent("Checking remote configuration...");
    expect(screen.getByTestId("git-runtime-refresh-status")).toHaveTextContent(
      "Checking live Git status..."
    );
  });

  it("polls settings while git runtime refresh is active and updates status text", async () => {
    mockGetSettings
      .mockResolvedValueOnce({
        ...mockSettings,
        gitRemoteMode: undefined,
        gitRuntimeStatus: {
          lastCheckedAt: null,
          stale: true,
          refreshing: true,
        },
      })
      .mockResolvedValueOnce({
        ...mockSettings,
        gitRemoteMode: "publishable",
        gitRuntimeStatus: {
          lastCheckedAt: "2026-01-01T00:00:00.000Z",
          stale: false,
          refreshing: false,
        },
      });

    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    expect(screen.getByTestId("git-remote-mode")).toHaveTextContent("Checking remote configuration...");
    await waitFor(() => expect(mockGetSettings).toHaveBeenCalledTimes(2), { timeout: 2500 });
    await waitFor(() =>
      expect(screen.getByTestId("git-remote-mode")).toHaveTextContent("Remote configured")
    );
    expect(screen.getByTestId("git-runtime-refresh-status")).toHaveTextContent(
      "Git status is current"
    );
  });

  it("when Branches selected, hides Parallelism section and shows explanatory text", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    const select = screen.getByTestId("git-working-mode-select");
    await userEvent.selectOptions(select, "branches");

    expect(screen.getByText("Branches mode uses a single coder.")).toBeInTheDocument();
    expect(screen.queryByText("Parallelism")).not.toBeInTheDocument();
    expect(screen.queryByTestId("max-concurrent-coders-slider")).not.toBeInTheDocument();
  });

  it("saves gitWorkingMode when changed on blur", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} onSaved={onSaved} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    const select = screen.getByTestId("git-working-mode-select");
    await userEvent.selectOptions(select, "branches");
    fireEvent.blur(select);

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({
          gitWorkingMode: "branches",
          maxConcurrentCoders: 1,
        })
      )
    );
  });

  it("persists worktreeBaseBranch when changed and blurred", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} onSaved={onSaved} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    const baseBranchInput = screen.getByTestId("worktree-base-branch-input");
    fireEvent.change(baseBranchInput, { target: { value: "develop" } });
    fireEvent.blur(baseBranchInput);

    await waitFor(() => {
      const calls = mockUpdateSettings.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[0]).toBe("proj-1");
      expect(lastCall[1]).toMatchObject({ worktreeBaseBranch: "develop" });
    });
  });

  it("normalizes invalid worktreeBaseBranch to main on blur", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    const baseBranchInput = screen.getByTestId("worktree-base-branch-input");
    fireEvent.change(baseBranchInput, { target: { value: "my branch" } });
    fireEvent.blur(baseBranchInput);

    await waitFor(() => {
      const calls = mockUpdateSettings.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[0]).toBe("proj-1");
      expect(lastCall[1]).toMatchObject({ worktreeBaseBranch: "main" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("worktree-base-branch-input")).toHaveValue("main");
    });
  });

  it("keeps Base branch input visible when Branches mode selected", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    const select = screen.getByTestId("git-working-mode-select");
    await userEvent.selectOptions(select, "branches");

    expect(screen.getByTestId("worktree-base-branch-input")).toBeInTheDocument();
    expect(screen.getByTestId("worktree-base-branch-input")).toHaveValue("main");
  });

  it("Agent Config tab shows Merge strategy select defaulting to Per task with help text", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    const select = screen.getByTestId("merge-strategy-select");
    expect(select).toBeInTheDocument();
    expect(select).toHaveValue("per_task");
    expect(
      screen.getByText(/Per task \(default\): merge each task to main when complete/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Per epic: build entire plan\/epic on one branch; merge once all tasks are done/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/partial landing \(per task\) for incremental merges, or batch merge \(per epic\)/)
    ).toBeInTheDocument();
  });

  it("saves mergeStrategy when changed to Per epic", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} onSaved={onSaved} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    const select = screen.getByTestId("merge-strategy-select");
    await userEvent.selectOptions(select, "per_epic");

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({ mergeStrategy: "per_epic" })
      )
    );
  });

  it("shows Merge strategy as Per epic when settings have mergeStrategy per_epic", async () => {
    mockGetSettings.mockResolvedValueOnce({ ...mockSettings, mergeStrategy: "per_epic" });
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await waitForModalReady();

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    const select = screen.getByTestId("merge-strategy-select");
    expect(select).toHaveValue("per_epic");
  });
});
