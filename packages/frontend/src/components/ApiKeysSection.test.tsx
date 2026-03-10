import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
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

  it("shows a retry action for exhausted keys and clears limitHitAt when clicked", async () => {
    const user = userEvent.setup();
    const onClearLimitHit = vi.fn().mockResolvedValue(undefined);
    render(
      <ApiKeysSection
        settings={mockSettingsWithKeys}
        onApiKeysChange={onApiKeysChange}
        onClearLimitHit={onClearLimitHit}
      />
    );

    await user.click(screen.getByTestId("api-key-retry-ANTHROPIC_API_KEY-k1"));

    await waitFor(() => {
      expect(onClearLimitHit).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "k1");
    });
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

  it("renders label input to the left of each API key and includes label in onApiKeysChange", async () => {
    const user = userEvent.setup();
    const settingsWithLabels: ApiKeysSectionSettings = {
      ...mockSettingsClaude,
      apiKeys: {
        ANTHROPIC_API_KEY: [
          { id: "k1", value: "sk-ant-a", label: "Production" },
          { id: "k2", value: "sk-ant-b" },
        ],
      },
    };
    render(<ApiKeysSection settings={settingsWithLabels} onApiKeysChange={onApiKeysChange} />);
    const labelInputs = screen.getAllByTestId(/api-key-label-ANTHROPIC_API_KEY-/);
    expect(labelInputs).toHaveLength(2);
    expect(labelInputs[0]).toHaveValue("Production");
    expect(labelInputs[1]).toHaveValue("");
    await user.type(labelInputs[1], "Staging");
    expect(onApiKeysChange).toHaveBeenCalled();
    const lastCall = onApiKeysChange.mock.calls[onApiKeysChange.mock.calls.length - 1][0];
    const entries = lastCall.ANTHROPIC_API_KEY!;
    expect(entries.find((e) => e.id === "k2")?.label).toBe("Staging");
  });

  it("enables remove when only one key remains (allows key rotation/cleanup)", () => {
    const settingsWithOneKey: ApiKeysSectionSettings = {
      ...mockSettingsClaude,
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-only" }],
      },
    };
    render(<ApiKeysSection settings={settingsWithOneKey} onApiKeysChange={onApiKeysChange} />);
    const removeBtn = screen.getByTestId("api-key-remove-ANTHROPIC_API_KEY-k1");
    expect(removeBtn).not.toBeDisabled();
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

  it("removes last key and allows adding new key afterward", async () => {
    const user = userEvent.setup();
    const settingsWithOneKey: ApiKeysSectionSettings = {
      ...mockSettingsClaude,
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-only" }],
      },
    };
    const { rerender } = render(
      <ApiKeysSection settings={settingsWithOneKey} onApiKeysChange={onApiKeysChange} />
    );
    const removeBtn = screen.getByTestId("api-key-remove-ANTHROPIC_API_KEY-k1");
    await user.click(removeBtn);

    expect(onApiKeysChange).toHaveBeenCalled();
    const lastCall = onApiKeysChange.mock.calls[onApiKeysChange.mock.calls.length - 1][0];
    expect(lastCall.ANTHROPIC_API_KEY).toEqual([]);

    rerender(
      <ApiKeysSection
        settings={{ ...mockSettingsClaude, apiKeys: { ANTHROPIC_API_KEY: [] } }}
        onApiKeysChange={onApiKeysChange}
      />
    );

    const addBtn = screen.getByTestId("api-key-add-ANTHROPIC_API_KEY");
    await user.click(addBtn);
    const inputs = screen.getAllByTestId(/api-key-input-ANTHROPIC_API_KEY-/);
    expect(inputs.length).toBe(1);
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

  it("reveals and fetches actual key value when eyeball clicked (global variant with onRevealKey)", async () => {
    const onRevealKey = vi.fn().mockResolvedValue("sk-ant-actual-secret");
    render(
      <ApiKeysSection
        apiKeys={{
          ANTHROPIC_API_KEY: [{ id: "k1", masked: "••••••••" }],
        }}
        providers={["ANTHROPIC_API_KEY"]}
        variant="global"
        onRevealKey={onRevealKey}
        onApiKeysChange={onApiKeysChange}
      />
    );

    const input = screen.getByTestId(/api-key-input-ANTHROPIC_API_KEY-/);
    expect(input).toHaveValue("••••••••");
    expect(input).toHaveAttribute("type", "password");

    const eyeBtn = screen.getByTestId(/api-key-eye-ANTHROPIC_API_KEY-/);
    await act(async () => {
      fireEvent.click(eyeBtn);
    });

    await waitFor(() => {
      expect(onRevealKey).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "k1");
    });
    await waitFor(() => {
      expect(input).toHaveValue("sk-ant-actual-secret");
    });
    expect(input).toHaveAttribute("type", "text");
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
    expect(
      screen.getByText(/Keys are stored globally and used across all projects/)
    ).toBeInTheDocument();
    expect(screen.getByText("ANTHROPIC_API_KEY (Claude API)")).toBeInTheDocument();
    expect(screen.getByText("CURSOR_API_KEY")).toBeInTheDocument();
  });

  it("shows Retry button when limitHitAt is set and onClearLimitHit provided", async () => {
    const user = userEvent.setup();
    const onClearLimitHit = vi.fn().mockResolvedValue(undefined);
    render(
      <ApiKeysSection
        apiKeys={{
          ANTHROPIC_API_KEY: [{ id: "k1", masked: "••••••••", limitHitAt: "2025-02-25T12:00:00Z" }],
        }}
        providers={["ANTHROPIC_API_KEY"]}
        variant="global"
        onClearLimitHit={onClearLimitHit}
        onApiKeysChange={onApiKeysChange}
      />
    );

    const retryBtn = screen.getByTestId("api-key-retry-ANTHROPIC_API_KEY-k1");
    expect(retryBtn).toBeInTheDocument();
    expect(retryBtn).toHaveTextContent("Retry");

    await user.click(retryBtn);

    await waitFor(() => {
      expect(onClearLimitHit).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "k1");
    });
  });

  it("does not show Retry button when limitHitAt is set but onClearLimitHit not provided", () => {
    render(
      <ApiKeysSection
        apiKeys={{
          ANTHROPIC_API_KEY: [{ id: "k1", masked: "••••••••", limitHitAt: "2025-02-25T12:00:00Z" }],
        }}
        providers={["ANTHROPIC_API_KEY"]}
        variant="global"
        onApiKeysChange={onApiKeysChange}
      />
    );

    expect(screen.queryByTestId("api-key-retry-ANTHROPIC_API_KEY-k1")).not.toBeInTheDocument();
  });

  it("shows drag handles when variant is global and provider has multiple keys", () => {
    render(
      <ApiKeysSection
        apiKeys={{
          ANTHROPIC_API_KEY: [
            { id: "k1", masked: "••••••••" },
            { id: "k2", masked: "••••••••" },
          ],
        }}
        providers={["ANTHROPIC_API_KEY"]}
        variant="global"
        onApiKeysChange={onApiKeysChange}
      />
    );
    expect(screen.getByTestId("api-key-drag-handle-ANTHROPIC_API_KEY-k1")).toBeInTheDocument();
    expect(screen.getByTestId("api-key-drag-handle-ANTHROPIC_API_KEY-k2")).toBeInTheDocument();
  });

  it("each API key row displays [handle][label][key] in DOM order (global variant, multiple keys)", () => {
    render(
      <ApiKeysSection
        apiKeys={{
          ANTHROPIC_API_KEY: [
            { id: "k1", masked: "••••••••" },
            { id: "k2", masked: "••••••••" },
          ],
        }}
        providers={["ANTHROPIC_API_KEY"]}
        variant="global"
        onApiKeysChange={onApiKeysChange}
      />
    );
    const keyInputs = screen.getAllByTestId(/api-key-input-ANTHROPIC_API_KEY-/);
    expect(keyInputs).toHaveLength(2);
    const DOCUMENT_POSITION_FOLLOWING = 4;
    for (let i = 0; i < keyInputs.length; i++) {
      const row = keyInputs[i].closest("[data-index]");
      expect(row).toBeInTheDocument();
      const handle = row!.querySelector(`[data-testid="api-key-drag-handle-ANTHROPIC_API_KEY-k${i + 1}"]`);
      const label = row!.querySelector(`[data-testid="api-key-label-ANTHROPIC_API_KEY-k${i + 1}"]`);
      const key = row!.querySelector(`[data-testid="api-key-input-ANTHROPIC_API_KEY-k${i + 1}"]`);
      expect(handle).toBeInTheDocument();
      expect(label).toBeInTheDocument();
      expect(key).toBeInTheDocument();
      expect((handle as Node).compareDocumentPosition(label as Node) & DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
      expect((label as Node).compareDocumentPosition(key as Node) & DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    }
  });

  it("does not show drag handles when variant is global but provider has only one key", () => {
    render(
      <ApiKeysSection
        apiKeys={{
          ANTHROPIC_API_KEY: [{ id: "k1", masked: "••••••••" }],
        }}
        providers={["ANTHROPIC_API_KEY"]}
        variant="global"
        onApiKeysChange={onApiKeysChange}
      />
    );
    expect(screen.queryByTestId("api-key-drag-handle-ANTHROPIC_API_KEY-k1")).not.toBeInTheDocument();
  });

  it("calls onApiKeysChange with reordered entries when drop reorders keys", async () => {
    const apiKeys = {
      ANTHROPIC_API_KEY: [
        { id: "k1", masked: "••••••••" },
        { id: "k2", masked: "••••••••" },
        { id: "k3", masked: "••••••••" },
      ],
    };
    render(
      <ApiKeysSection
        apiKeys={apiKeys}
        providers={["ANTHROPIC_API_KEY"]}
        variant="global"
        onApiKeysChange={onApiKeysChange}
      />
    );
    const rows = screen.getAllByTestId(/api-key-input-ANTHROPIC_API_KEY-/);
    expect(rows).toHaveLength(3);
    const rowContainers = rows.map((r) => r.closest("[data-index]"));
    const targetRow = rowContainers[0] as HTMLElement;
    expect(targetRow).toHaveAttribute("data-index", "0");

    const dragData = JSON.stringify({ provider: "ANTHROPIC_API_KEY", fromIndex: 2 });

    await act(async () => {
      fireEvent.dragOver(targetRow, { dataTransfer: { getData: () => dragData } });
      fireEvent.drop(targetRow, { dataTransfer: { getData: () => dragData } });
    });

    expect(onApiKeysChange).toHaveBeenCalledWith({
      ANTHROPIC_API_KEY: expect.arrayContaining([
        expect.objectContaining({ id: "k3" }),
        expect.objectContaining({ id: "k1" }),
        expect.objectContaining({ id: "k2" }),
      ]),
    });
    const payload = onApiKeysChange.mock.calls[onApiKeysChange.mock.calls.length - 1][0];
    const order = payload.ANTHROPIC_API_KEY!.map((e) => e.id);
    expect(order).toEqual(["k3", "k1", "k2"]);
  });
});
