import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { ApiKeysSection } from "./ApiKeysSection";
import type { ApiKeysSectionSettings } from "./ApiKeysSection";

const mockSettingsClaude: ApiKeysSectionSettings = {
  simpleComplexityAgent: { type: "claude", model: "claude-3-5-sonnet", cliCommand: null },
  complexComplexityAgent: { type: "claude", model: "claude-3-5-sonnet", cliCommand: null },
  deployment: { mode: "custom" },
  hilConfig: {
    scopeChanges: "automated",
    architectureDecisions: "automated",
    dependencyModifications: "automated",
  },
  testFramework: null,
  gitWorkingMode: "worktree",
};

const mockSettingsCursor: ApiKeysSectionSettings = {
  ...mockSettingsClaude,
  simpleComplexityAgent: { type: "cursor", model: "gpt-4", cliCommand: null },
  complexComplexityAgent: { type: "cursor", model: "gpt-4", cliCommand: null },
};

const mockSettingsOpenAI: ApiKeysSectionSettings = {
  ...mockSettingsClaude,
  simpleComplexityAgent: { type: "openai", model: "gpt-4o", cliCommand: null },
  complexComplexityAgent: { type: "openai", model: "gpt-4o", cliCommand: null },
};

const mockSettingsWithKeys: ApiKeysSectionSettings = {
  ...mockSettingsClaude,
  apiKeys: {
    ANTHROPIC_API_KEY: [
      { id: "k1", value: "sk-ant-secret", limitHitAt: "2025-02-25T12:00:00Z" },
      { id: "k2", value: "sk-ant-other" },
    ],
  },
};

describe("ApiKeysSection", () => {
  const onApiKeysChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no claude or cursor providers in use", () => {
    const settings: ApiKeysSectionSettings = {
      ...mockSettingsClaude,
      simpleComplexityAgent: { type: "claude-cli", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude-cli", model: null, cliCommand: null },
    };
    const { container } = render(
      <ApiKeysSection settings={settings} onApiKeysChange={onApiKeysChange} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders API Keys section when claude is selected", () => {
    render(<ApiKeysSection settings={mockSettingsClaude} onApiKeysChange={onApiKeysChange} />);
    expect(screen.getByTestId("api-keys-section")).toBeInTheDocument();
    expect(screen.getByText("API Keys")).toBeInTheDocument();
    expect(screen.getByText(/Add multiple keys per provider/)).toBeInTheDocument();
    expect(screen.getByText(/Project keys take precedence over keys in .env/)).toBeInTheDocument();
    expect(screen.getByText("ANTHROPIC_API_KEY (Claude API)")).toBeInTheDocument();
  });

  it("renders CURSOR_API_KEY when cursor is selected", () => {
    render(<ApiKeysSection settings={mockSettingsCursor} onApiKeysChange={onApiKeysChange} />);
    expect(screen.getByText("CURSOR_API_KEY")).toBeInTheDocument();
  });

  it("renders OPENAI_API_KEY when openai is selected", () => {
    render(<ApiKeysSection settings={mockSettingsOpenAI} onApiKeysChange={onApiKeysChange} />);
    expect(screen.getByText("OPENAI_API_KEY (OpenAI API)")).toBeInTheDocument();
    expect(screen.getByTestId("api-key-add-OPENAI_API_KEY")).toBeInTheDocument();
  });

  it("shows existing keys with masked placeholder and limitHitAt sub-label", () => {
    render(<ApiKeysSection settings={mockSettingsWithKeys} onApiKeysChange={onApiKeysChange} />);
    const inputs = screen.getAllByTestId(/api-key-input-ANTHROPIC_API_KEY-/);
    expect(inputs.length).toBe(2);
    expect(screen.getByText(/Limit hit at.*retry after 24h/)).toBeInTheDocument();
  });

  it("adds a new key when Add key is clicked", async () => {
    const user = userEvent.setup();
    render(<ApiKeysSection settings={mockSettingsClaude} onApiKeysChange={onApiKeysChange} />);
    const addBtn = screen.getByTestId("api-key-add-ANTHROPIC_API_KEY");
    await user.click(addBtn);
    const inputs = screen.getAllByTestId(/api-key-input-ANTHROPIC_API_KEY-/);
    expect(inputs.length).toBe(1);
  });

  it("shows exactly one input on first Add key click under StrictMode (no double-add)", async () => {
    const user = userEvent.setup();
    render(
      <StrictMode>
        <ApiKeysSection settings={mockSettingsClaude} onApiKeysChange={onApiKeysChange} />
      </StrictMode>
    );
    const addBtn = screen.getByTestId("api-key-add-ANTHROPIC_API_KEY");
    await user.click(addBtn);
    const inputs = screen.getAllByTestId(/api-key-input-ANTHROPIC_API_KEY-/);
    expect(inputs.length).toBe(1);
  });

  it("toggles visibility when eye icon is clicked", async () => {
    const user = userEvent.setup();
    render(<ApiKeysSection settings={mockSettingsWithKeys} onApiKeysChange={onApiKeysChange} />);
    const eyeButtons = screen.getAllByRole("button", { name: /Show key|Hide key/ });
    expect(eyeButtons.length).toBeGreaterThanOrEqual(1);
    const input = screen.getAllByTestId(/api-key-input-ANTHROPIC_API_KEY-/)[0];
    expect(input).toHaveAttribute("type", "password");
    await user.click(eyeButtons[0]);
    expect(input).toHaveAttribute("type", "text");
  });

  it("calls onApiKeysChange when user types a new key value", async () => {
    const user = userEvent.setup();
    const settingsWithOneKey: ApiKeysSectionSettings = {
      ...mockSettingsClaude,
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-existing" }],
      },
    };
    render(<ApiKeysSection settings={settingsWithOneKey} onApiKeysChange={onApiKeysChange} />);
    const input = screen.getByTestId(/api-key-input-ANTHROPIC_API_KEY-/);
    await user.clear(input);
    await user.type(input, "sk-ant-new-key");
    expect(onApiKeysChange).toHaveBeenCalled();
    const lastCall = onApiKeysChange.mock.calls[onApiKeysChange.mock.calls.length - 1][0];
    expect(lastCall.ANTHROPIC_API_KEY).toBeDefined();
    expect(lastCall.ANTHROPIC_API_KEY!.some((e) => e.value === "sk-ant-new-key")).toBe(true);
  });

  it("disables remove when only one key remains", () => {
    const settingsWithOneKey: ApiKeysSectionSettings = {
      ...mockSettingsClaude,
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-only" }],
      },
    };
    render(<ApiKeysSection settings={settingsWithOneKey} onApiKeysChange={onApiKeysChange} />);
    const removeBtn = screen.getByTestId("api-key-remove-ANTHROPIC_API_KEY-k1");
    expect(removeBtn).toBeDisabled();
  });

  it("enables remove when multiple keys exist", () => {
    render(<ApiKeysSection settings={mockSettingsWithKeys} onApiKeysChange={onApiKeysChange} />);
    const removeButtons = screen.getAllByTestId(/api-key-remove-/);
    expect(removeButtons.length).toBe(2);
    removeButtons.forEach((b) => expect(b).not.toBeDisabled());
  });

  it("removes key and calls onApiKeysChange when remove clicked with 2+ keys", async () => {
    const user = userEvent.setup();
    render(<ApiKeysSection settings={mockSettingsWithKeys} onApiKeysChange={onApiKeysChange} />);
    const removeButtons = screen.getAllByTestId(/api-key-remove-/);
    await user.click(removeButtons[0]);

    expect(onApiKeysChange).toHaveBeenCalled();
    const lastCall = onApiKeysChange.mock.calls[onApiKeysChange.mock.calls.length - 1][0];
    expect(lastCall.ANTHROPIC_API_KEY).toHaveLength(1);
    expect(lastCall.ANTHROPIC_API_KEY![0].id).toBe("k2");
  });

  it("shows both providers when mixed (claude + cursor)", () => {
    const mixedSettings: ApiKeysSectionSettings = {
      ...mockSettingsClaude,
      simpleComplexityAgent: { type: "claude", model: "claude-sonnet", cliCommand: null },
      complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
    };
    render(<ApiKeysSection settings={mixedSettings} onApiKeysChange={onApiKeysChange} />);
    expect(screen.getByText("ANTHROPIC_API_KEY (Claude API)")).toBeInTheDocument();
    expect(screen.getByText("CURSOR_API_KEY")).toBeInTheDocument();
  });

  it("uses password type by default for key inputs", () => {
    render(<ApiKeysSection settings={mockSettingsWithKeys} onApiKeysChange={onApiKeysChange} />);
    const inputs = screen.getAllByTestId(/api-key-input-/);
    inputs.forEach((input) => expect(input).toHaveAttribute("type", "password"));
  });

  it("returns null when settings is null", () => {
    const { container } = render(
      <ApiKeysSection settings={null} onApiKeysChange={onApiKeysChange} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("displays masked value for existing keys in global variant (page load/refresh)", () => {
    render(
      <ApiKeysSection
        apiKeys={{
          ANTHROPIC_API_KEY: [{ id: "k1", masked: "••••••••" }],
          CURSOR_API_KEY: [{ id: "c1", masked: "••••••••" }],
        }}
        providers={["ANTHROPIC_API_KEY", "CURSOR_API_KEY"]}
        variant="global"
        onApiKeysChange={onApiKeysChange}
      />
    );
    const anthropicInput = screen.getByTestId(/api-key-input-ANTHROPIC_API_KEY-/);
    const cursorInput = screen.getByTestId(/api-key-input-CURSOR_API_KEY-/);
    expect(anthropicInput).toHaveValue("••••••••");
    expect(cursorInput).toHaveValue("••••••••");
  });

  it("renders both providers in global mode with apiKeys and providers props", () => {
    render(
      <ApiKeysSection
        apiKeys={{}}
        providers={["ANTHROPIC_API_KEY", "CURSOR_API_KEY"]}
        variant="global"
        onApiKeysChange={onApiKeysChange}
      />
    );
    expect(screen.getByTestId("api-keys-section")).toBeInTheDocument();
    expect(screen.getByText(/Keys are stored globally and used across all projects/)).toBeInTheDocument();
    expect(screen.getByText("ANTHROPIC_API_KEY (Claude API)")).toBeInTheDocument();
    expect(screen.getByText("CURSOR_API_KEY")).toBeInTheDocument();
  });
});
