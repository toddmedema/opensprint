import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "../contexts/ThemeContext";
import { DisplayPreferencesProvider } from "../contexts/DisplayPreferencesContext";
import { ProjectSettingsModal } from "./ProjectSettingsModal";
import type { Project } from "@opensprint/shared";

const mockGetSettings = vi.fn();
const mockUpdate = vi.fn();
const mockUpdateSettings = vi.fn();
const mockGetAgentsInstructions = vi.fn();
const mockUpdateAgentsInstructions = vi.fn();
const mockGetKeys = vi.fn();
const mockModelsList = vi.fn();
const mockGlobalSettingsGet = vi.fn();

vi.mock("../api/client", () => ({
  api: {
    projects: {
      getSettings: (...args: unknown[]) => mockGetSettings(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      updateSettings: (...args: unknown[]) => mockUpdateSettings(...args),
      getAgentsInstructions: (...args: unknown[]) => mockGetAgentsInstructions(...args),
      updateAgentsInstructions: (...args: unknown[]) => mockUpdateAgentsInstructions(...args),
      runSelfImprovement: vi.fn().mockResolvedValue({ tasksCreated: 0, skipped: "no_changes" }),
    },
    env: {
      getKeys: (...args: unknown[]) => mockGetKeys(...args),
    },
    models: {
      list: (...args: unknown[]) => mockModelsList(...args),
    },
    globalSettings: {
      get: () => mockGlobalSettingsGet(),
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

function renderModal(ui: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ThemeProvider>
          <DisplayPreferencesProvider>{ui}</DisplayPreferencesProvider>
        </ThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("ProjectSettingsModal workflow integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockResolvedValue(mockSettings);
    mockGetAgentsInstructions.mockResolvedValue({ content: "# Agent Instructions" });
    mockUpdateAgentsInstructions.mockResolvedValue({ saved: true });
    mockGetKeys.mockResolvedValue({
      anthropic: true,
      cursor: true,
      openai: true,
      google: true,
      claudeCli: true,
      useCustomCli: false,
    });
    mockGlobalSettingsGet.mockResolvedValue({
      databaseUrl: "",
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "anth", masked: "••••••••" }],
      },
    });
    mockModelsList.mockResolvedValue([]);
  });

  it("shows workflow tab and renders workflow controls in that tab", async () => {
    const user = userEvent.setup();
    renderModal(<ProjectSettingsModal project={mockProject} onClose={vi.fn()} />);

    await screen.findByTestId("settings-modal-content");
    expect(screen.getByRole("button", { name: "Workflow" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Workflow" }));
    await screen.findByTestId("workflow-execution-strategy-card");

    expect(screen.getByTestId("workflow-quality-gates-card")).toBeInTheDocument();
    expect(screen.getByTestId("workflow-continuous-improvement-card")).toBeInTheDocument();
    expect(screen.queryByText("Task Complexity")).not.toBeInTheDocument();
  });

  it("keeps Agent Config focused on complexity rows and advanced instructions", async () => {
    const user = userEvent.setup();
    renderModal(<ProjectSettingsModal project={mockProject} onClose={vi.fn()} />);

    await screen.findByTestId("settings-modal-content");
    await user.click(screen.getByRole("button", { name: "Agent Config" }));

    expect(screen.getByText("Simple")).toBeInTheDocument();
    expect(screen.getByText("Complex")).toBeInTheDocument();
    expect(screen.getByTestId("agents-advanced-section")).toBeInTheDocument();
    expect(screen.queryByTestId("merge-strategy-select")).not.toBeInTheDocument();
    expect(screen.queryByTestId("review-mode-select")).not.toBeInTheDocument();
  });

  it("hides Agent Instructions by default (Advanced section collapsed)", async () => {
    const user = userEvent.setup();
    renderModal(<ProjectSettingsModal project={mockProject} onClose={vi.fn()} />);

    await screen.findByTestId("settings-modal-content");
    await user.click(screen.getByRole("button", { name: "Agent Config" }));

    expect(screen.getByTestId("agents-advanced-section")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand Advanced" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Agent Instructions" })).not.toBeInTheDocument();
  });

  it("shows AgentsMdSection when Advanced section is expanded", async () => {
    const user = userEvent.setup();
    renderModal(<ProjectSettingsModal project={mockProject} onClose={vi.fn()} />);

    await screen.findByTestId("settings-modal-content");
    await user.click(screen.getByRole("button", { name: "Agent Config" }));
    await user.click(screen.getByRole("button", { name: "Expand Advanced" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Agent Instructions" })).toBeInTheDocument();
    });
  });

  it("shows provider-specific API prerequisite copy per row", async () => {
    mockGlobalSettingsGet.mockResolvedValue({ databaseUrl: "", apiKeys: {} });
    const user = userEvent.setup();

    renderModal(<ProjectSettingsModal project={mockProject} onClose={vi.fn()} />);
    await screen.findByTestId("settings-modal-content");
    await user.click(screen.getByRole("button", { name: "Agent Config" }));

    await waitFor(() => {
      expect(screen.getByTestId("configure-api-keys-link-simple")).toBeInTheDocument();
      expect(screen.getByTestId("configure-api-keys-link-complex")).toBeInTheDocument();
    });
    expect(screen.queryByText(/^API key required:/)).not.toBeInTheDocument();
  });
});
