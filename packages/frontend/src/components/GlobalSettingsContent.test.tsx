import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor, act } from "@testing-library/react";
import { GlobalSettingsContent } from "./GlobalSettingsContent";
import { renderApp } from "../test/test-utils";

function renderGlobalSettingsContent() {
  return renderApp(<GlobalSettingsContent onSaveStateChange={vi.fn()} />);
}

vi.mock("../contexts/ThemeContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../contexts/ThemeContext")>();
  return {
    ...actual,
    useTheme: () => ({
      preference: "light",
      resolved: "light",
      setTheme: vi.fn(),
      setForceLightMode: vi.fn(),
    }),
  };
});

vi.mock("../contexts/DisplayPreferencesContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../contexts/DisplayPreferencesContext")>();
  return {
    ...actual,
    useDisplayPreferences: () => ({
      runningAgentsDisplayMode: "count",
      setRunningAgentsDisplayMode: vi.fn(),
    }),
  };
});

const mockGlobalSettingsGet = vi.fn();
const mockGlobalSettingsPut = vi.fn();
const mockRevealKey = vi.fn();
const mockClearLimitHit = vi.fn();
const mockSetupTables = vi.fn();

vi.mock("../api/client", () => ({
  api: {
    globalSettings: {
      get: () => mockGlobalSettingsGet(),
      put: (...args: unknown[]) => mockGlobalSettingsPut(...args),
      revealKey: (provider: string, id: string) =>
        mockRevealKey(provider, id).then((v: { value: string }) => v),
      clearLimitHit: (provider: string, id: string) => mockClearLimitHit(provider, id),
      setupTables: (databaseUrl: string) => mockSetupTables(databaseUrl),
    },
  },
  isConnectionError: () => false,
}));

describe("GlobalSettingsContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGlobalSettingsGet.mockResolvedValue({
      databaseUrl: "postgresql://user:***@localhost:5432/opensprint",
      apiKeys: undefined,
    });
  });

  it("renders ApiKeysSection with all providers when keys not configured", async () => {
    renderGlobalSettingsContent();

    await screen.findByTestId("api-keys-section-wrapper");
    expect(screen.getByTestId("api-keys-section")).toBeInTheDocument();
    expect(screen.getByText("API Keys")).toBeInTheDocument();
    expect(
      screen.getByText(/Keys are stored globally and used across all projects/)
    ).toBeInTheDocument();
    expect(screen.getByText("ANTHROPIC_API_KEY (Claude API)")).toBeInTheDocument();
    expect(screen.getByText("CURSOR_API_KEY")).toBeInTheDocument();
    expect(screen.getByText("OPENAI_API_KEY (OpenAI API)")).toBeInTheDocument();
    expect(screen.getByTestId("api-key-add-ANTHROPIC_API_KEY")).toBeInTheDocument();
    expect(screen.getByTestId("api-key-add-CURSOR_API_KEY")).toBeInTheDocument();
    expect(screen.getByTestId("api-key-add-OPENAI_API_KEY")).toBeInTheDocument();
  });

  it("shows existing keys when apiKeys from global settings", async () => {
    mockGlobalSettingsGet.mockResolvedValue({
      databaseUrl: "postgresql://user:***@localhost:5432/opensprint",
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "k1", masked: "••••••••" }],
        CURSOR_API_KEY: [{ id: "c1", masked: "••••••••" }],
      },
    });

    renderGlobalSettingsContent();

    await screen.findByTestId("api-keys-section");
    const anthropicInputs = screen.getAllByTestId(/api-key-input-ANTHROPIC_API_KEY-/);
    const cursorInputs = screen.getAllByTestId(/api-key-input-CURSOR_API_KEY-/);
    expect(anthropicInputs.length).toBe(1);
    expect(cursorInputs.length).toBe(1);
    expect(anthropicInputs[0]).toHaveValue("••••••••");
    expect(cursorInputs[0]).toHaveValue("••••••••");
  });

  it("reveals API key when eyeball clicked after refresh (calls revealKey API)", async () => {
    mockGlobalSettingsGet.mockResolvedValue({
      databaseUrl: "postgresql://user:***@localhost:5432/opensprint",
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "k1", masked: "••••••••" }],
      },
    });
    mockRevealKey.mockResolvedValue({ value: "sk-ant-revealed-secret" });

    renderGlobalSettingsContent();

    await screen.findByTestId("api-keys-section");
    const input = screen.getByTestId(/api-key-input-ANTHROPIC_API_KEY-/);
    expect(input).toHaveValue("••••••••");

    const eyeBtn = screen.getByTestId(/api-key-eye-ANTHROPIC_API_KEY-/);
    await act(async () => {
      fireEvent.click(eyeBtn);
    });

    await waitFor(() => {
      expect(mockRevealKey).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "k1");
    });
    await waitFor(() => {
      expect(input).toHaveValue("sk-ant-revealed-secret");
    });
  });

  it("shows limitHitAt sub-label when key is rate-limited (global store)", async () => {
    mockGlobalSettingsGet.mockResolvedValue({
      databaseUrl: "postgresql://user:***@localhost:5432/opensprint",
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "k1", masked: "••••••••", limitHitAt: "2025-02-25T12:00:00Z" }],
      },
    });

    renderGlobalSettingsContent();

    await screen.findByTestId("api-keys-section");
    expect(screen.getByText(/Limit hit at/)).toBeInTheDocument();
    expect(screen.getByText(/retry after 24h/)).toBeInTheDocument();
  });

  it("calls clearLimitHit and updates apiKeys when Retry clicked on rate-limited key", async () => {
    mockGlobalSettingsGet.mockResolvedValue({
      databaseUrl: "postgresql://user:***@localhost:5432/opensprint",
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "k1", masked: "••••••••", limitHitAt: "2025-02-25T12:00:00Z" }],
      },
    });
    mockClearLimitHit.mockResolvedValue({
      databaseUrl: "postgresql://user:***@localhost:5432/opensprint",
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "k1", masked: "••••••••" }],
      },
    });

    renderGlobalSettingsContent();

    await screen.findByTestId("api-key-retry-ANTHROPIC_API_KEY-k1");
    const retryBtn = screen.getByTestId("api-key-retry-ANTHROPIC_API_KEY-k1");
    await act(async () => {
      fireEvent.click(retryBtn);
    });

    await waitFor(() => {
      expect(mockClearLimitHit).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "k1");
    });
    await waitFor(() => {
      expect(screen.queryByText(/Limit hit at/)).not.toBeInTheDocument();
    });
  });

  it("renders Theme section", async () => {
    renderGlobalSettingsContent();

    await screen.findByText("Theme");
    expect(screen.getByText(/Choose how Open Sprint looks/)).toBeInTheDocument();
    expect(screen.getByTestId("theme-option-light")).toBeInTheDocument();
    expect(screen.getByTestId("theme-option-dark")).toBeInTheDocument();
    expect(screen.getByTestId("theme-option-system")).toBeInTheDocument();
  });

  it("renders Running agents display mode section", async () => {
    renderGlobalSettingsContent();

    await screen.findByText("Running agents display mode");
    expect(screen.getByTestId("running-agents-display-mode")).toBeInTheDocument();
  });

  it("calls globalSettings.put when apiKeys change", async () => {
    mockGlobalSettingsPut.mockResolvedValue({
      databaseUrl: "postgresql://user:***@localhost:5432/opensprint",
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "new-id", masked: "••••••••" }],
      },
    });

    renderGlobalSettingsContent();

    await screen.findByTestId("api-key-add-ANTHROPIC_API_KEY");
    const addBtn = screen.getByTestId("api-key-add-ANTHROPIC_API_KEY");
    await act(async () => {
      fireEvent.click(addBtn);
    });

    const input = await screen.findByTestId(/api-key-input-ANTHROPIC_API_KEY-/);
    await act(async () => {
      fireEvent.change(input, { target: { value: "sk-ant-new-key" } });
    });
    await act(async () => {
      fireEvent.blur(input);
    });

    await waitFor(() => {
      expect(mockGlobalSettingsPut).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKeys: expect.objectContaining({
            ANTHROPIC_API_KEY: expect.arrayContaining([
              expect.objectContaining({ id: expect.any(String), value: "sk-ant-new-key" }),
            ]),
          }),
        })
      );
    });
  });

  it("preserves previously saved providers when a later save happens after masked reload state", async () => {
    mockGlobalSettingsPut
      .mockResolvedValueOnce({
        databaseUrl: "postgresql://user:***@localhost:5432/opensprint",
        apiKeys: {
          ANTHROPIC_API_KEY: [{ id: "anth-1", masked: "••••••••" }],
        },
      })
      .mockResolvedValueOnce({
        databaseUrl: "postgresql://user:***@localhost:5432/opensprint",
        apiKeys: {
          ANTHROPIC_API_KEY: [{ id: "anth-1", masked: "••••••••" }],
          CURSOR_API_KEY: [{ id: "cursor-1", masked: "••••••••" }],
        },
      });

    renderGlobalSettingsContent();

    await screen.findByTestId("api-key-add-ANTHROPIC_API_KEY");
    await act(async () => {
      fireEvent.click(screen.getByTestId("api-key-add-ANTHROPIC_API_KEY"));
    });

    const anthropicInput = await screen.findByTestId(/api-key-input-ANTHROPIC_API_KEY-/);
    await act(async () => {
      fireEvent.change(anthropicInput, { target: { value: "sk-ant-first-key" } });
    });

    await waitFor(() => {
      expect(mockGlobalSettingsPut).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("api-key-add-CURSOR_API_KEY"));
    });

    const cursorInput = await screen.findByTestId(/api-key-input-CURSOR_API_KEY-/);
    await act(async () => {
      fireEvent.change(cursorInput, { target: { value: "cursor-second-key" } });
    });

    await waitFor(() => {
      expect(mockGlobalSettingsPut).toHaveBeenCalledTimes(2);
    });

    expect(mockGlobalSettingsPut).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        apiKeys: expect.objectContaining({
          ANTHROPIC_API_KEY: [expect.objectContaining({ id: "anth-1" })],
          CURSOR_API_KEY: [expect.objectContaining({ value: "cursor-second-key" })],
        }),
      })
    );
  });

  it("renders Database URL section with masked value", async () => {
    renderGlobalSettingsContent();

    await screen.findByTestId("database-url-section");
    expect(screen.getByText("Database URL")).toBeInTheDocument();
    expect(
      screen.getByText(/PostgreSQL connection URL for tasks, feedback, and sessions/)
    ).toBeInTheDocument();
    expect(screen.getByText(/Password is hidden in display/)).toBeInTheDocument();
    const input = screen.getByTestId("database-url-input");
    expect(input).toHaveAttribute("placeholder", "postgresql://user:password@host:port/database");
    expect(input).toHaveValue("postgresql://user:***@localhost:5432/opensprint");
  });

  it("saves database URL after debounce on change", async () => {
    mockGlobalSettingsPut.mockResolvedValue({
      databaseUrl: "postgresql://user:***@db.example.com:5432/opensprint",
    });

    renderGlobalSettingsContent();

    await screen.findByTestId("database-url-input");
    const input = screen.getByTestId("database-url-input");
    await act(async () => {
      fireEvent.change(input, {
        target: { value: "postgresql://user:secret@db.example.com:5432/opensprint" },
      });
    });

    await waitFor(
      () =>
        expect(mockGlobalSettingsPut).toHaveBeenCalledWith({
          databaseUrl: "postgresql://user:secret@db.example.com:5432/opensprint",
        }),
      { timeout: 1000 }
    );
    await waitFor(() => {
      expect(input).toHaveValue("postgresql://user:***@db.example.com:5432/opensprint");
    });
  });

  it("shows error when blurring masked URL", async () => {
    renderGlobalSettingsContent();

    const input = await screen.findByTestId("database-url-input");
    fireEvent.blur(input);

    expect(mockGlobalSettingsPut).not.toHaveBeenCalled();
    expect(screen.getByText("Enter the full connection URL to save changes")).toBeInTheDocument();
  });

  it("shows Set up tables button when DB URL has value and is not masked", async () => {
    mockGlobalSettingsGet.mockResolvedValue({ databaseUrl: "", apiKeys: undefined });

    renderGlobalSettingsContent();

    await screen.findByTestId("database-url-input");
    const input = screen.getByTestId("database-url-input");
    await act(async () => {
      fireEvent.change(input, {
        target: { value: "postgresql://user:secret@localhost:5432/opensprint" },
      });
    });

    expect(screen.getByTestId("setup-tables-button")).toBeInTheDocument();
  });

  it("hides Set up tables button when DB URL is masked", async () => {
    renderGlobalSettingsContent();

    await screen.findByTestId("database-url-input");
    expect(screen.queryByTestId("setup-tables-button")).not.toBeInTheDocument();
  });

  it("opens confirmation dialog with warning when Set up tables clicked", async () => {
    mockGlobalSettingsGet.mockResolvedValue({ databaseUrl: "", apiKeys: undefined });

    renderGlobalSettingsContent();

    await screen.findByTestId("database-url-input");
    const input = screen.getByTestId("database-url-input");
    await act(async () => {
      fireEvent.change(input, {
        target: { value: "postgresql://user:secret@localhost:5432/opensprint" },
      });
    });

    const setupBtn = screen.getByTestId("setup-tables-button");
    await act(async () => {
      fireEvent.click(setupBtn);
    });

    expect(screen.getByTestId("setup-tables-dialog")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Data loss may occur. Please confirm that you've backed up any important data in this database before proceeding."
      )
    ).toBeInTheDocument();
  });

  it("calls setupTables on confirm", async () => {
    mockGlobalSettingsGet.mockResolvedValue({ databaseUrl: "", apiKeys: undefined });
    mockSetupTables.mockResolvedValue({ ok: true });

    renderGlobalSettingsContent();

    await screen.findByTestId("database-url-input");
    const input = screen.getByTestId("database-url-input");
    await act(async () => {
      fireEvent.change(input, {
        target: { value: "postgresql://user:secret@localhost:5432/opensprint" },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("setup-tables-button"));
    });

    const confirmBtn = await screen.findByTestId("setup-tables-confirm");
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(mockSetupTables).toHaveBeenCalledWith(
        "postgresql://user:secret@localhost:5432/opensprint"
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId("setup-tables-dialog")).not.toBeInTheDocument();
    });
  });

  it("does not call setupTables on cancel", async () => {
    mockGlobalSettingsGet.mockResolvedValue({ databaseUrl: "", apiKeys: undefined });

    renderGlobalSettingsContent();

    await screen.findByTestId("database-url-input");
    const input = screen.getByTestId("database-url-input");
    await act(async () => {
      fireEvent.change(input, {
        target: { value: "postgresql://user:secret@localhost:5432/opensprint" },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("setup-tables-button"));
    });

    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    await act(async () => {
      fireEvent.click(cancelBtn);
    });

    expect(mockSetupTables).not.toHaveBeenCalled();
    expect(screen.queryByTestId("setup-tables-dialog")).not.toBeInTheDocument();
  });

  it("shows Saving spinner for at least 500ms on fast database URL save", async () => {
    const timestamps: { saving?: number; saved?: number } = {};
    const onSaveStateChange = vi.fn((status: string) => {
      if (status === "saving") timestamps.saving = Date.now();
      if (status === "saved") timestamps.saved = Date.now();
    });
    mockGlobalSettingsPut.mockImplementation(
      () => Promise.resolve({ databaseUrl: "postgresql://user:***@localhost:5432/opensprint", apiKeys: undefined })
    );

    renderApp(<GlobalSettingsContent onSaveStateChange={onSaveStateChange} />);

    await screen.findByTestId("database-url-input");
    const input = screen.getByTestId("database-url-input");
    fireEvent.change(input, {
      target: { value: "postgresql://user:secret@localhost:5432/opensprint" },
    });

    await waitFor(() => {
      expect(timestamps.saving).toBeDefined();
    });

    expect(mockGlobalSettingsPut).toHaveBeenCalled();
    expect(timestamps.saved).toBeUndefined();

    await waitFor(
      () => {
        expect(timestamps.saved).toBeDefined();
      },
      { timeout: 1500 }
    );

    expect(timestamps.saved! - timestamps.saving!).toBeGreaterThanOrEqual(500);
  });

  it("hides Saving spinner when save completes on slow (>500ms) database URL save", async () => {
    const onSaveStateChange = vi.fn();
    mockGlobalSettingsPut.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                databaseUrl: "postgresql://user:***@localhost:5432/opensprint",
                apiKeys: undefined,
              }),
            600
          )
        )
    );

    renderApp(<GlobalSettingsContent onSaveStateChange={onSaveStateChange} />);

    await screen.findByTestId("database-url-input");
    const input = screen.getByTestId("database-url-input");
    fireEvent.change(input, {
      target: { value: "postgresql://user:secret@localhost:5432/opensprint" },
    });

    await waitFor(() => {
      expect(onSaveStateChange).toHaveBeenCalledWith("saving");
    });

    await waitFor(
      () => {
        expect(onSaveStateChange).toHaveBeenCalledWith("saved");
      },
      { timeout: 2000 }
    );

    expect(onSaveStateChange).toHaveBeenCalledWith("saved");
  });
});
