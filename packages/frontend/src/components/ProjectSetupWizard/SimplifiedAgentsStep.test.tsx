import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SimplifiedAgentsStep } from "./SimplifiedAgentsStep";

vi.mock("../ModelSelect", () => ({
  ModelSelect: ({
    value,
    onChange,
  }: {
    value: string | null;
    onChange: (id: string | null) => void;
  }) => (
    <select
      data-testid="model-select"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      aria-label="Model selection"
    >
      <option value="">Select model</option>
      <option value="claude-3-5-sonnet">Claude 3.5 Sonnet</option>
    </select>
  ),
}));

vi.mock("../../api/client", () => ({
  api: {
    models: {
      list: vi.fn().mockResolvedValue([]),
    },
  },
}));

const defaultSimpleAgent = {
  type: "cursor" as const,
  model: "",
  cliCommand: "",
};
const defaultComplexAgent = {
  type: "cursor" as const,
  model: "",
  cliCommand: "",
};

function renderSimplifiedAgentsStep(
  overrides: Partial<Parameters<typeof SimplifiedAgentsStep>[0]> = {}
) {
  return render(
    <SimplifiedAgentsStep
      simpleComplexityAgent={defaultSimpleAgent}
      complexComplexityAgent={defaultComplexAgent}
      onSimpleComplexityAgentChange={() => {}}
      onComplexComplexityAgentChange={() => {}}
      envKeys={null}
      keyInput={{ anthropic: "", cursor: "" }}
      onKeyInputChange={() => {}}
      savingKey={null}
      onSaveKey={() => {}}
      modelRefreshTrigger={0}
      {...overrides}
    />
  );
}

describe("SimplifiedAgentsStep", () => {
  it("renders with Task Complexity section and Simple/Complex rows", () => {
    renderSimplifiedAgentsStep();

    expect(screen.getByTestId("simplified-agents-step")).toBeInTheDocument();
    expect(screen.getByText("Task Complexity")).toBeInTheDocument();
    expect(screen.getByTestId("task-complexity-section")).toBeInTheDocument();
    expect(screen.getAllByText("Simple").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Complex").length).toBeGreaterThanOrEqual(1);
  });

  it("omits git work mode section", () => {
    renderSimplifiedAgentsStep();

    expect(screen.queryByText("Git working mode")).not.toBeInTheDocument();
    expect(screen.queryByTestId("git-working-mode-select")).not.toBeInTheDocument();
  });

  it("omits parallelism section", () => {
    renderSimplifiedAgentsStep();

    expect(screen.queryByText("Parallelism")).not.toBeInTheDocument();
    expect(screen.queryByTestId("max-concurrent-coders-slider")).not.toBeInTheDocument();
  });

  it("omits unknown scope strategy", () => {
    renderSimplifiedAgentsStep();

    expect(screen.queryByTestId("unknown-scope-strategy-select")).not.toBeInTheDocument();
  });

  it("omits About the agent team section", () => {
    renderSimplifiedAgentsStep();

    expect(screen.queryByTestId("about-agent-team-section")).not.toBeInTheDocument();
    expect(screen.queryByText("What do these agents do?")).not.toBeInTheDocument();
  });

  it("hides API key banner when all keys for selected providers are configured", () => {
    renderSimplifiedAgentsStep({
      envKeys: { anthropic: true, cursor: true, claudeCli: true },
    });

    expect(screen.queryByText(/API key required/)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("sk-ant-...")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("key_...")).not.toBeInTheDocument();
  });

  it("shows cursor key input when cursor is selected and key is missing", () => {
    renderSimplifiedAgentsStep({
      envKeys: { anthropic: true, cursor: false, claudeCli: true },
    });

    expect(screen.getByText(/API key required/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("sk-ant-...")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("key_...")).toBeInTheDocument();
  });

  it("shows anthropic key input when an agent uses claude provider and key is missing", () => {
    renderSimplifiedAgentsStep({
      simpleComplexityAgent: { type: "claude", model: "", cliCommand: "" },
      envKeys: { anthropic: false, cursor: true, claudeCli: true },
    });

    expect(screen.getByText(/API key required/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("sk-ant-...")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("key_...")).not.toBeInTheDocument();
  });

  it("does not show API key section when envKeys is null", () => {
    renderSimplifiedAgentsStep({ envKeys: null });

    expect(screen.queryByText(/API key required/)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("sk-ant-...")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("key_...")).not.toBeInTheDocument();
  });

  it("shows CLI warning when claude-cli is selected and CLI is not available", () => {
    renderSimplifiedAgentsStep({
      simpleComplexityAgent: { type: "claude-cli", model: "", cliCommand: "" },
      envKeys: { anthropic: false, cursor: true, claudeCli: false },
    });

    expect(screen.getByText(/Claude CLI not found/)).toBeInTheDocument();
  });

  it("calls onSimpleComplexityAgentChange when Simple provider changes", () => {
    const onChange = vi.fn();
    renderSimplifiedAgentsStep({ onSimpleComplexityAgentChange: onChange });

    const comboboxes = screen.getAllByRole("combobox");
    const simpleProviderSelect = comboboxes[0];
    fireEvent.change(simpleProviderSelect, { target: { value: "claude" } });

    expect(onChange).toHaveBeenCalledWith({
      type: "claude",
      model: "",
      cliCommand: "",
    });
  });

  it("calls onComplexComplexityAgentChange when Complex provider changes", () => {
    const onChange = vi.fn();
    renderSimplifiedAgentsStep({ onComplexComplexityAgentChange: onChange });

    const comboboxes = screen.getAllByRole("combobox");
    const complexProviderSelect = comboboxes[2];
    fireEvent.change(complexProviderSelect, { target: { value: "claude" } });

    expect(onChange).toHaveBeenCalledWith({
      type: "claude",
      model: "",
      cliCommand: "",
    });
  });

  it("calls onSaveKey when Save button is clicked for anthropic key", () => {
    const onSaveKey = vi.fn();
    renderSimplifiedAgentsStep({
      simpleComplexityAgent: { type: "claude", model: "", cliCommand: "" },
      envKeys: { anthropic: false, cursor: true, claudeCli: true },
      keyInput: { anthropic: "sk-ant-test", cursor: "" },
      onSaveKey,
    });

    const saveBtn = screen.getByRole("button", { name: "Save" });
    fireEvent.click(saveBtn);

    expect(onSaveKey).toHaveBeenCalledWith("ANTHROPIC_API_KEY");
  });

  it("calls onKeyInputChange when key input changes", () => {
    const onKeyInputChange = vi.fn();
    renderSimplifiedAgentsStep({
      simpleComplexityAgent: { type: "claude", model: "", cliCommand: "" },
      envKeys: { anthropic: false, cursor: true, claudeCli: true },
      onKeyInputChange,
    });

    const input = screen.getByPlaceholderText("sk-ant-...");
    fireEvent.change(input, { target: { value: "sk-ant-xyz" } });

    expect(onKeyInputChange).toHaveBeenCalledWith("anthropic", "sk-ant-xyz");
  });

  it("renders ModelSelect for non-custom providers", () => {
    renderSimplifiedAgentsStep();

    expect(screen.getAllByTestId("model-select").length).toBe(2);
  });

  it("renders CLI command input when custom provider is selected", () => {
    renderSimplifiedAgentsStep({
      simpleComplexityAgent: { type: "custom", model: "", cliCommand: "my-agent" },
    });

    expect(screen.getByPlaceholderText(/e\.g\. my-agent/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/e\.g\. my-agent/)).toHaveValue("my-agent");
  });
});
