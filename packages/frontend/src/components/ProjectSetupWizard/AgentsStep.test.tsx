import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AgentsStep } from "./AgentsStep";

vi.mock("../AgentReferenceModal", () => ({
  AgentReferenceModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="agent-reference-modal">
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  ),
}));

const mockModelsList = vi.fn();
vi.mock("../../api/client", () => ({
  api: {
    models: {
      list: (...args: unknown[]) => mockModelsList(...args),
    },
  },
}));

const defaultLowComplexityAgent = {
  type: "cursor" as const,
  model: "",
  cliCommand: "",
};
const defaultHighComplexityAgent = {
  type: "cursor" as const,
  model: "",
  cliCommand: "",
};

function renderAgentsStep(overrides: Partial<Parameters<typeof AgentsStep>[0]> = {}) {
  return render(
    <AgentsStep
      simpleComplexityAgent={defaultLowComplexityAgent}
      complexComplexityAgent={defaultHighComplexityAgent}
      onSimpleComplexityAgentChange={() => {}}
      onComplexComplexityAgentChange={() => {}}
      envKeys={null}
      modelRefreshTrigger={0}
      maxConcurrentCoders={1}
      onMaxConcurrentCodersChange={() => {}}
      unknownScopeStrategy="optimistic"
      onUnknownScopeStrategyChange={() => {}}
      gitWorkingMode="worktree"
      onGitWorkingModeChange={() => {}}
      {...overrides}
    />
  );
}

describe("AgentsStep", () => {
  beforeEach(() => {
    mockModelsList.mockResolvedValue([]);
  });

  it("renders agents step with Task Complexity section and Simple/Complex rows", () => {
    renderAgentsStep();

    expect(screen.getByTestId("agents-step")).toBeInTheDocument();
    expect(screen.getByText("Task Complexity")).toBeInTheDocument();
    expect(screen.getByTestId("task-complexity-section")).toBeInTheDocument();
    expect(screen.getAllByText("Simple").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Complex").length).toBeGreaterThanOrEqual(1);
  });

  it("hides API key banner when all keys for selected providers are configured", () => {
    renderAgentsStep({
      envKeys: { anthropic: true, cursor: true, openai: true, claudeCli: true },
    });

    expect(screen.queryByText(/API key required/)).not.toBeInTheDocument();
  });

  it("shows configure-in-settings message when cursor is selected and key is missing", () => {
    renderAgentsStep({
      envKeys: { anthropic: true, cursor: false, openai: true, claudeCli: true },
    });

    expect(screen.getByText(/API key required/)).toBeInTheDocument();
    expect(screen.getByText(/Configure API keys in Settings/)).toBeInTheDocument();
  });

  it("does not show API key banner when no agent uses claude provider", () => {
    renderAgentsStep({
      envKeys: { anthropic: false, cursor: true, openai: true, claudeCli: true },
    });

    expect(screen.queryByText(/API key required/)).not.toBeInTheDocument();
  });

  it("shows configure-in-settings message when claude is selected and key is missing", () => {
    renderAgentsStep({
      simpleComplexityAgent: { type: "claude", model: "", cliCommand: "" },
      envKeys: { anthropic: false, cursor: true, openai: true, claudeCli: true },
    });

    expect(screen.getByText(/API key required/)).toBeInTheDocument();
    expect(screen.getByText(/Configure API keys in Settings/)).toBeInTheDocument();
  });

  it("shows configure-in-settings message when both providers selected and both keys missing", () => {
    renderAgentsStep({
      simpleComplexityAgent: { type: "claude", model: "", cliCommand: "" },
      envKeys: { anthropic: false, cursor: false, openai: true, claudeCli: true },
    });

    expect(screen.getByText(/API key required/)).toBeInTheDocument();
    expect(screen.getByText(/Configure API keys in Settings/)).toBeInTheDocument();
  });

  it("shows configure-in-settings message when both agents use cursor and both keys missing", () => {
    renderAgentsStep({
      envKeys: { anthropic: false, cursor: false, openai: true, claudeCli: true },
    });

    expect(screen.getByText(/API key required/)).toBeInTheDocument();
    expect(screen.getByText(/Configure API keys in Settings/)).toBeInTheDocument();
  });

  it("shows configure-in-settings message when openai is selected and key is missing", () => {
    renderAgentsStep({
      simpleComplexityAgent: { type: "openai", model: "", cliCommand: "" },
      envKeys: { anthropic: true, cursor: true, openai: false, claudeCli: true },
    });

    expect(screen.getByText(/API key required/)).toBeInTheDocument();
    expect(screen.getByText(/Configure API keys in Settings/)).toBeInTheDocument();
  });

  it("OpenAI appears as provider option in Simple and Complex dropdowns", () => {
    renderAgentsStep();

    const openaiOptions = screen.getAllByRole("option", { name: "OpenAI" });
    expect(openaiOptions).toHaveLength(2);
  });

  it("when OpenAI selected for Simple, fetches and displays OpenAI models", async () => {
    mockModelsList.mockImplementation((provider: string) => {
      if (provider === "openai") {
        return Promise.resolve([
          { id: "gpt-4o", displayName: "gpt-4o" },
          { id: "gpt-4o-mini", displayName: "gpt-4o-mini" },
        ]);
      }
      return Promise.resolve([]);
    });

    renderAgentsStep({
      simpleComplexityAgent: { type: "openai", model: "", cliCommand: "" },
      complexComplexityAgent: { type: "cursor", model: "", cliCommand: "" },
      envKeys: { anthropic: true, cursor: true, openai: true, claudeCli: true },
    });

    await waitFor(() => {
      expect(mockModelsList).toHaveBeenCalledWith("openai", undefined);
    });
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "gpt-4o" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "gpt-4o-mini" })).toBeInTheDocument();
    });
  });

  it("does not show API key section when envKeys is null", () => {
    renderAgentsStep({ envKeys: null });

    expect(screen.queryByText(/API key required/)).not.toBeInTheDocument();
  });

  it("does not require API key when claude-cli is selected", () => {
    renderAgentsStep({
      simpleComplexityAgent: { type: "claude-cli", model: "", cliCommand: "" },
      envKeys: { anthropic: false, cursor: true, openai: true, claudeCli: true },
    });

    expect(screen.queryByText(/API key required/)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("sk-ant-...")).not.toBeInTheDocument();
  });

  it("shows CLI warning when claude-cli is selected and CLI is not available", () => {
    renderAgentsStep({
      simpleComplexityAgent: { type: "claude-cli", model: "", cliCommand: "" },
      envKeys: { anthropic: false, cursor: true, openai: true, claudeCli: false },
    });

    expect(screen.getByText(/Claude CLI not found/)).toBeInTheDocument();
    expect(screen.queryByText(/API key required/)).not.toBeInTheDocument();
  });

  it("shows CLI info when claude-cli is selected and CLI is available", () => {
    renderAgentsStep({
      simpleComplexityAgent: { type: "claude-cli", model: "", cliCommand: "" },
      envKeys: { anthropic: true, cursor: true, openai: true, claudeCli: true },
    });

    expect(screen.getByText(/locally-installed Claude CLI/)).toBeInTheDocument();
    expect(screen.queryByText(/Claude CLI not found/)).not.toBeInTheDocument();
  });

  it("renders parallelism section with slider defaulting to 1", () => {
    renderAgentsStep();

    expect(screen.getByText("Parallelism")).toBeInTheDocument();
    const slider = screen.getByTestId("max-concurrent-coders-slider");
    expect(slider).toBeInTheDocument();
    expect(slider).toHaveValue("1");
  });

  it("calls onMaxConcurrentCodersChange when slider changes", () => {
    const onChange = vi.fn();
    renderAgentsStep({ onMaxConcurrentCodersChange: onChange });

    const slider = screen.getByTestId("max-concurrent-coders-slider");
    fireEvent.change(slider, { target: { value: "5" } });

    expect(onChange).toHaveBeenCalledWith(5);
  });

  it("hides unknown scope strategy when maxConcurrentCoders is 1", () => {
    renderAgentsStep({ maxConcurrentCoders: 1, gitWorkingMode: "worktree" });

    expect(screen.queryByTestId("unknown-scope-strategy-select")).not.toBeInTheDocument();
  });

  it("shows unknown scope strategy when maxConcurrentCoders > 1", () => {
    renderAgentsStep({ maxConcurrentCoders: 3, gitWorkingMode: "worktree" });

    expect(screen.getByTestId("unknown-scope-strategy-select")).toBeInTheDocument();
    expect(screen.getByTestId("unknown-scope-strategy-select")).toHaveValue("optimistic");
  });

  it("renders Git working mode dropdown with Worktree default", () => {
    renderAgentsStep();

    expect(screen.getByText("Git working mode")).toBeInTheDocument();
    const select = screen.getByTestId("git-working-mode-select");
    expect(select).toBeInTheDocument();
    expect(select).toHaveValue("worktree");
  });

  it("calls onGitWorkingModeChange when dropdown changes", () => {
    const onChange = vi.fn();
    renderAgentsStep({ onGitWorkingModeChange: onChange });

    const select = screen.getByTestId("git-working-mode-select");
    fireEvent.change(select, { target: { value: "branches" } });

    expect(onChange).toHaveBeenCalledWith("branches");
  });

  it("hides Parallelism section when Branches selected", () => {
    renderAgentsStep({ gitWorkingMode: "branches" });

    expect(screen.queryByText("Parallelism")).not.toBeInTheDocument();
    expect(screen.queryByTestId("max-concurrent-coders-slider")).not.toBeInTheDocument();
    expect(
      screen.getByText(/Branches mode uses a single branch in the main repo/)
    ).toBeInTheDocument();
  });

  it("shows Parallelism section when Worktree selected", () => {
    renderAgentsStep({ gitWorkingMode: "worktree" });

    expect(screen.getByText("Parallelism")).toBeInTheDocument();
    expect(screen.getByTestId("max-concurrent-coders-slider")).toBeInTheDocument();
  });

  describe("About the agent team section", () => {
    it("renders collapsible 'What do these agents do?' section", () => {
      renderAgentsStep();

      const section = screen.getByTestId("about-agent-team-section");
      expect(section).toBeInTheDocument();
      expect(section.tagName).toBe("DETAILS");
      expect(screen.getByText("What do these agents do?")).toBeInTheDocument();
    });

    it("is collapsed by default", () => {
      renderAgentsStep();

      const section = screen.getByTestId("about-agent-team-section");
      expect(section).not.toHaveAttribute("open");
    });

    it("expands to show compact agent list when summary is clicked", () => {
      renderAgentsStep();

      const summary = screen.getByText("What do these agents do?");
      fireEvent.click(summary);

      expect(screen.getByText("Dreamer")).toBeInTheDocument();
      expect(screen.getByText("Planner")).toBeInTheDocument();
      expect(screen.getByText("Coder")).toBeInTheDocument();
      expect(screen.getByText("Merger")).toBeInTheDocument();
    });

    it("opens AgentReferenceModal when Learn more is clicked", () => {
      renderAgentsStep();

      const summary = screen.getByText("What do these agents do?");
      fireEvent.click(summary);

      const learnMoreBtn = screen.getByRole("button", { name: "Learn more" });
      fireEvent.click(learnMoreBtn);

      expect(screen.getByTestId("agent-reference-modal")).toBeInTheDocument();
    });

    it("closes AgentReferenceModal when onClose is called", () => {
      renderAgentsStep();

      const summary = screen.getByText("What do these agents do?");
      fireEvent.click(summary);

      const learnMoreBtn = screen.getByRole("button", { name: "Learn more" });
      fireEvent.click(learnMoreBtn);

      expect(screen.getByTestId("agent-reference-modal")).toBeInTheDocument();

      const closeBtn = screen.getByRole("button", { name: "Close" });
      fireEvent.click(closeBtn);

      expect(screen.queryByTestId("agent-reference-modal")).not.toBeInTheDocument();
    });
  });

});
