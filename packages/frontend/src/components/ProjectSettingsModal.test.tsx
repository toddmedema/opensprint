import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
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
    mockGetAgentsInstructions.mockResolvedValue({ content: "# Agent Instructions\n\nUse bd for tasks." });
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
    expect(link).toHaveAttribute("href", "/settings");
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

  it("Custom mode with targets shows per-target auto-deploy dropdowns", async () => {
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
          simpleComplexityAgent: expect.objectContaining({ type: "claude", model: "claude-3-5-sonnet" }),
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
});
