import { createRef, type ReactElement } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "../contexts/ThemeContext";
import { DisplayPreferencesProvider } from "../contexts/DisplayPreferencesContext";
import { ProjectSettingsModal, type ProjectSettingsModalRef } from "./ProjectSettingsModal";
import type { Project } from "@opensprint/shared";

const mockGetSettings = vi.fn();
const mockUpdate = vi.fn();
const mockUpdateSettings = vi.fn();
const mockGetAgentsInstructions = vi.fn();
const mockUpdateAgentsInstructions = vi.fn();
const mockGetKeys = vi.fn();
const mockModelsList = vi.fn();
const mockGlobalSettingsGet = vi.fn();
let restoreConfirm: (() => void) | undefined;

vi.mock("../api/client", () => ({
  isApiError: () => false,
  isConnectionError: () => false,
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
  afterEach(() => {
    restoreConfirm?.();
    restoreConfirm = undefined;
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockReset().mockResolvedValue(mockSettings);
    mockUpdate.mockReset().mockResolvedValue(mockProject);
    mockUpdateSettings.mockReset().mockResolvedValue(mockSettings);
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

  it("saves project task size through the settings API", async () => {
    const user = userEvent.setup();
    mockUpdateSettings.mockImplementation(async (_id, patch) => ({ ...mockSettings, ...patch }));
    renderModal(<ProjectSettingsModal project={mockProject} onClose={vi.fn()} />);
    await screen.findByTestId("settings-modal-content");
    await user.click(screen.getByRole("button", { name: "Workflow" }));
    await user.click(screen.getByRole("radio", { name: /^Larger/ }));
    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({ taskSize: "larger" })
      )
    );
    expect(screen.getByRole("radio", { name: /^Larger/ })).toBeChecked();
  });

  it.each([false, true])(
    "preserves a remote task-size change on unrelated saves (prior local edit: %s)",
    async (editLocally) => {
      const user = userEvent.setup();
      let serverTaskSize = "balanced";
      mockGetSettings.mockResolvedValue({ ...mockSettings, taskSize: serverTaskSize });
      mockUpdateSettings.mockImplementation(async (_id, patch) => {
        if (patch.taskSize !== undefined) serverTaskSize = patch.taskSize;
        return { ...mockSettings, ...patch, taskSize: serverTaskSize };
      });
      renderModal(<ProjectSettingsModal project={mockProject} onClose={vi.fn()} />);
      await screen.findByTestId("settings-modal-content");
      await user.click(screen.getByRole("button", { name: "Workflow" }));
      if (editLocally) {
        await user.click(screen.getByRole("radio", { name: /^Larger/ }));
        await waitFor(() => expect(serverTaskSize).toBe("larger"));
      }
      mockUpdateSettings.mockClear();
      serverTaskSize = "smaller";
      await user.selectOptions(screen.getByTestId("merge-strategy-select"), "per_epic");
      await waitFor(() => expect(mockUpdateSettings).toHaveBeenCalled());
      const patch = mockUpdateSettings.mock.calls.at(-1)![1];
      expect(patch.mergeStrategy).toBe("per_epic");
      expect(patch).not.toHaveProperty("taskSize");
      expect(serverTaskSize).toBe("smaller");
    }
  );

  it("retains a failed task-size edit for retry across tabs", async () => {
    const user = userEvent.setup();
    mockGetSettings.mockResolvedValue({ ...mockSettings, taskSize: "balanced" });
    renderModal(<ProjectSettingsModal project={mockProject} onClose={vi.fn()} />);
    await screen.findByTestId("settings-modal-content");
    await user.click(screen.getByRole("button", { name: "Workflow" }));
    mockUpdateSettings.mockClear();
    mockUpdateSettings.mockRejectedValueOnce(new Error("Task size save failed"));
    await user.click(screen.getByRole("radio", { name: /^Larger/ }));
    await screen.findByText("Task size save failed");
    expect(screen.getByRole("radio", { name: /^Larger/ })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Agent Config" }));
    await waitFor(() => expect(mockUpdateSettings).toHaveBeenCalledTimes(2));
    expect(mockUpdateSettings.mock.calls[1]![1]).toMatchObject({ taskSize: "larger" });
    await user.click(screen.getByRole("button", { name: "Workflow" }));
    expect(screen.getByRole("radio", { name: /^Larger/ })).toBeChecked();
  });

  it.each(["custom", "lmstudio"] as const)(
    "reports a blocked task-size save as not saved and retries after %s configuration is refreshed",
    async (type) => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      const onSaveStatusChange = vi.fn();
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      restoreConfirm = () => confirm.mockRestore();
      const modal = createRef<ProjectSettingsModalRef>();
      let resolveRefresh!: (value: unknown) => void;
      const refresh = new Promise((resolve) => {
        resolveRefresh = resolve;
      });
      mockGetSettings
        .mockResolvedValueOnce({
          ...mockSettings,
          taskSize: "balanced",
          simpleComplexityAgent: { type, model: null, cliCommand: null },
          gitRuntimeStatus: { refreshing: true, stale: true, lastCheckedAt: null },
        })
        .mockReturnValueOnce(refresh);
      renderModal(
        <ProjectSettingsModal
          ref={modal}
          project={mockProject}
          onClose={onClose}
          onSaveStatusChange={onSaveStatusChange}
        />
      );
      await screen.findByTestId("settings-modal-content");
      await user.click(screen.getByRole("button", { name: "Workflow" }));
      await user.click(screen.getByRole("radio", { name: /^Larger/ }));
      await waitFor(() => expect(onSaveStatusChange).toHaveBeenLastCalledWith("not_saved"));
      expect(mockUpdateSettings).not.toHaveBeenCalled();
      await user.keyboard("{Escape}");
      expect(confirm).toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();

      await waitFor(() => expect(mockGetSettings).toHaveBeenCalledTimes(2), { timeout: 3000 });
      await act(async () =>
        resolveRefresh({
          ...mockSettings,
          taskSize: "balanced",
          gitRuntimeStatus: {
            refreshing: false,
            stale: false,
            lastCheckedAt: "2026-11-06T12:00:00Z",
          },
        })
      );
      expect(screen.getByRole("radio", { name: /^Larger/ })).toBeChecked();
      await act(async () => modal.current!.persist());
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({ taskSize: "larger" })
      );
      // Successful saves keep the spinner visible for at least one second.
      await waitFor(() => expect(onSaveStatusChange).toHaveBeenLastCalledWith("saved"), {
        timeout: 2000,
      });
    }
  );

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
