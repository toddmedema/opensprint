import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ThemeProvider } from "../contexts/ThemeContext";
import { DisplayPreferencesProvider } from "../contexts/DisplayPreferencesContext";
import { SettingsPage } from "./SettingsPage";

const mockGetKeys = vi.fn();
const mockGlobalSettingsGet = vi.fn();

const mockGlobalSettingsPut = vi.fn();

vi.mock("../api/client", () => ({
  api: {
    env: {
      getKeys: () => mockGetKeys(),
    },
    globalSettings: {
      get: () => mockGlobalSettingsGet(),
      put: (...args: unknown[]) => mockGlobalSettingsPut(...args),
    },
  },
}));

vi.mock("../components/layout/Layout", () => ({
  Layout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="layout">{children}</div>
  ),
}));

function renderSettingsPage() {
  return render(
    <ThemeProvider>
      <DisplayPreferencesProvider>
        <MemoryRouter initialEntries={["/settings"]}>
          <Routes>
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </MemoryRouter>
      </DisplayPreferencesProvider>
    </ThemeProvider>
  );
}

describe("SettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
    );
    mockGetKeys.mockResolvedValue({
      anthropic: true,
      cursor: true,
      openai: true,
      claudeCli: true,
      useCustomCli: false,
    });
    mockGlobalSettingsGet.mockResolvedValue({ databaseUrl: "" });
  });

  it("renders settings page with scrollable container", async () => {
    renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByTestId("settings-page")).toBeInTheDocument();
    });

    const page = screen.getByTestId("settings-page");
    expect(page).toHaveClass("flex-1");
    expect(page).toHaveClass("min-h-0");
    expect(page).toHaveClass("flex");
    expect(page).toHaveClass("flex-col");
    expect(page).toHaveClass("overflow-hidden");
    // Scrollable content is in a child
    const scrollArea = page.querySelector(".overflow-y-auto");
    expect(scrollArea).toBeInTheDocument();
  });

  it("renders second-level top bar with Global and Project navigation", async () => {
    renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByTestId("settings-top-bar")).toBeInTheDocument();
    });
    expect(screen.getByTestId("settings-global-tab")).toHaveTextContent("Global");
    expect(screen.getByTestId("settings-project-tab")).toHaveTextContent("Project");
  });

  it("renders global settings content", async () => {
    renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByTestId("global-settings-content")).toBeInTheDocument();
    });
  });

  it("does not render back button in header", async () => {
    renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByTestId("settings-page")).toBeInTheDocument();
    });

    expect(screen.queryByRole("link", { name: "Back to home" })).not.toBeInTheDocument();
  });

  it("shows save indicator with Saved by default", async () => {
    renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByTestId("settings-save-indicator")).toBeInTheDocument();
    });

    expect(screen.getByTestId("settings-save-indicator")).toHaveTextContent("Saved");
  });

  it("registers beforeunload when save in progress", async () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    mockGlobalSettingsGet.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                databaseUrl: "postgresql://user:***@localhost:5432/opensprint",
                apiKeys: undefined,
              }),
            0
          );
        })
    );
    mockGlobalSettingsPut.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ databaseUrl: "", apiKeys: undefined }), 100))
    );

    renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByTestId("database-url-input")).toBeInTheDocument();
    });

    const input = screen.getByTestId("database-url-input");
    fireEvent.change(input, {
      target: { value: "postgresql://user:secret@localhost:5432/opensprint" },
    });

    await waitFor(
      () => {
        expect(screen.getByTestId("settings-save-indicator")).toHaveTextContent("Saving");
      },
      { timeout: 1000 }
    );

    expect(addSpy).toHaveBeenCalledWith("beforeunload", expect.any(Function));

    await waitFor(
      () => {
        expect(screen.getByTestId("settings-save-indicator")).toHaveTextContent("Saved");
      },
      { timeout: 1500 }
    );

    expect(removeSpy).toHaveBeenCalledWith("beforeunload", expect.any(Function));

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
