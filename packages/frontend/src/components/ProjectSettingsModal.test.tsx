import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "../contexts/ThemeContext";
import { ProjectSettingsModal } from "./ProjectSettingsModal";
import type { Project } from "@opensprint/shared";

const storage: Record<string, string> = {};

const mockGetSettings = vi.fn();
const mockUpdate = vi.fn();
const mockUpdateSettings = vi.fn();
const mockGetKeys = vi.fn();

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
  },
}));

const mockProject: Project = {
  id: "proj-1",
  name: "Test Project",
  description: "A test project",
  repoPath: "/path/to/repo",
  currentPhase: "execute",
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

const mockSettings = {
  planningAgent: { type: "claude" as const, model: "claude-3-5-sonnet", cliCommand: null },
  codingAgent: { type: "claude" as const, model: "claude-3-5-sonnet", cliCommand: null },
  deployment: { mode: "custom" as const },
  hilConfig: {
    scopeChanges: "requires_approval" as const,
    architectureDecisions: "requires_approval" as const,
    dependencyModifications: "requires_approval" as const,
  },
};

describe("ProjectSettingsModal", () => {
  const onClose = vi.fn();
  const onSaved = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockResolvedValue(mockSettings);
    mockGetKeys.mockResolvedValue({ anthropic: true, cursor: true });
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
    return render(<ThemeProvider>{ui}</ThemeProvider>);
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

    await screen.findByText("Planning Agent");

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

    await screen.findByText("Planning Agent");

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

  it("hides API key banner, inputs, and status when both keys are configured", async () => {
    mockGetKeys.mockResolvedValue({ anthropic: true, cursor: true });

    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await screen.findByText("Project Settings");

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("Planning Agent");

    expect(screen.queryByText("API keys required")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("sk-ant-...")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("key_...")).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        /Both API keys configured|Claude API key configured|Cursor API key configured/
      )
    ).not.toBeInTheDocument();
  });

  it("shows API key banner and inputs when at least one key is missing", async () => {
    mockGetKeys.mockResolvedValue({ anthropic: false, cursor: true });

    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await screen.findByText("Project Settings");

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await userEvent.click(agentConfigTab);

    await screen.findByText("API keys required");
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

  it("Autonomy tab shows only configurable HIL categories (PRD §6.5.1: no testFailuresAndRetries)", async () => {
    renderModal(<ProjectSettingsModal project={mockProject} onClose={onClose} />);
    await screen.findByText("Project Settings");

    const autonomyTab = screen.getByRole("button", { name: "Autonomy" });
    await userEvent.click(autonomyTab);

    expect(screen.getByText("Scope Changes")).toBeInTheDocument();
    expect(screen.getByText("Architecture Decisions")).toBeInTheDocument();
    expect(screen.getByText("Dependency Modifications")).toBeInTheDocument();
    expect(screen.queryByText(/Test Failures|testFailuresAndRetries/i)).not.toBeInTheDocument();
  });

  it("Deliver tab shows auto-deploy toggles (PRD §7.5.3)", async () => {
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
});
