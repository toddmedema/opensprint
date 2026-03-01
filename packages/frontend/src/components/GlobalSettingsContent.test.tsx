import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { GlobalSettingsContent } from "./GlobalSettingsContent";

vi.mock("../contexts/ThemeContext", () => ({
  useTheme: () => ({
    preference: "light",
    setTheme: vi.fn(),
  }),
}));

vi.mock("../contexts/DisplayPreferencesContext", () => ({
  useDisplayPreferences: () => ({
    runningAgentsDisplayMode: "count",
    setRunningAgentsDisplayMode: vi.fn(),
  }),
}));

const mockGlobalSettingsGet = vi.fn();
const mockGlobalSettingsPut = vi.fn();

vi.mock("../api/client", () => ({
  api: {
    globalSettings: {
      get: () => mockGlobalSettingsGet(),
      put: (...args: unknown[]) => mockGlobalSettingsPut(...args),
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

  it("renders ApiKeysSection with both providers when keys not configured", async () => {
    render(<GlobalSettingsContent />);

    await screen.findByTestId("api-keys-section-wrapper");
    expect(screen.getByTestId("api-keys-section")).toBeInTheDocument();
    expect(screen.getByText("API Keys")).toBeInTheDocument();
    expect(screen.getByText(/Keys are stored globally and used across all projects/)).toBeInTheDocument();
    expect(screen.getByText("ANTHROPIC_API_KEY (Claude API)")).toBeInTheDocument();
    expect(screen.getByText("CURSOR_API_KEY")).toBeInTheDocument();
    expect(screen.getByTestId("api-key-add-ANTHROPIC_API_KEY")).toBeInTheDocument();
    expect(screen.getByTestId("api-key-add-CURSOR_API_KEY")).toBeInTheDocument();
  });

  it("shows existing keys when apiKeys from global settings", async () => {
    mockGlobalSettingsGet.mockResolvedValue({
      databaseUrl: "postgresql://user:***@localhost:5432/opensprint",
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "k1", masked: "••••••••" }],
        CURSOR_API_KEY: [{ id: "c1", masked: "••••••••" }],
      },
    });

    render(<GlobalSettingsContent />);

    await screen.findByTestId("api-keys-section");
    const anthropicInputs = screen.getAllByTestId(/api-key-input-ANTHROPIC_API_KEY-/);
    const cursorInputs = screen.getAllByTestId(/api-key-input-CURSOR_API_KEY-/);
    expect(anthropicInputs.length).toBe(1);
    expect(cursorInputs.length).toBe(1);
  });

  it("shows limitHitAt sub-label when key is rate-limited (global store)", async () => {
    mockGlobalSettingsGet.mockResolvedValue({
      databaseUrl: "postgresql://user:***@localhost:5432/opensprint",
      apiKeys: {
        ANTHROPIC_API_KEY: [
          { id: "k1", masked: "••••••••", limitHitAt: "2025-02-25T12:00:00Z" },
        ],
      },
    });

    render(<GlobalSettingsContent />);

    await screen.findByTestId("api-keys-section");
    expect(screen.getByText(/Limit hit at/)).toBeInTheDocument();
    expect(screen.getByText(/retry after 24h/)).toBeInTheDocument();
  });

  it("renders Theme section", async () => {
    render(<GlobalSettingsContent />);

    await screen.findByText("Theme");
    expect(screen.getByText(/Choose how Open Sprint looks/)).toBeInTheDocument();
    expect(screen.getByTestId("theme-option-light")).toBeInTheDocument();
    expect(screen.getByTestId("theme-option-dark")).toBeInTheDocument();
    expect(screen.getByTestId("theme-option-system")).toBeInTheDocument();
  });

  it("renders Running agents display mode section", async () => {
    render(<GlobalSettingsContent />);

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

    render(<GlobalSettingsContent />);

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

  it("renders Database URL section with masked value", async () => {
    render(<GlobalSettingsContent />);

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

    render(<GlobalSettingsContent />);

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
    render(<GlobalSettingsContent />);

    const input = await screen.findByTestId("database-url-input");
    fireEvent.blur(input);

    expect(mockGlobalSettingsPut).not.toHaveBeenCalled();
    expect(screen.getByText("Enter the full connection URL to save changes")).toBeInTheDocument();
  });
});
