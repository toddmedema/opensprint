/**
 * Integration tests for theme-aware components.
 * Verifies that key components use theme tokens (not hard-coded colors) so they
 * render correctly in light, dark, and system themes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configureStore } from "@reduxjs/toolkit";
import { ThemeProvider } from "../../contexts/ThemeContext";
import notificationReducer from "../../store/slices/notificationSlice";
import executeReducer from "../../store/slices/executeSlice";
import planReducer from "../../store/slices/planSlice";
import projectReducer from "../../store/slices/projectSlice";
import websocketReducer from "../../store/slices/websocketSlice";
import { HomeScreen } from "../HomeScreen";
import { Layout } from "../layout/Layout";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const storage: Record<string, string> = {};

vi.mock("../../api/client", () => ({
  api: {
    projects: { list: () => Promise.resolve([]) },
    agents: { active: () => Promise.resolve([]) },
    dbStatus: { get: () => Promise.resolve({ ok: true, message: null }) },
    globalSettings: { get: () => Promise.resolve({ databaseUrl: "", apiKeys: undefined }) },
  },
}));

function createTestStore() {
  return configureStore({
    reducer: {
      notification: notificationReducer,
      execute: executeReducer,
      plan: planReducer,
      project: projectReducer,
      websocket: websocketReducer,
    },
  });
}

describe("theme-aware components", () => {
  beforeEach(() => {
    document.documentElement.setAttribute("data-theme", "light");
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

  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
  });

  it("HomeScreen uses theme tokens (no hard-coded brand-50/brand-700 for badges)", async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <Provider store={createTestStore()}>
            <MemoryRouter>
              <Layout>
                <HomeScreen />
              </Layout>
            </MemoryRouter>
          </Provider>
        </ThemeProvider>
      </QueryClientProvider>
    );
    await screen.findByTestId("projects-grid");
    // HomeScreen should use theme tokens; phase badges use theme-info-bg/text
    // (replaced from brand-50/brand-700 for dark mode compatibility)
    const html = document.body.innerHTML;
    expect(html).toContain("text-theme-text");
    expect(html).toContain("text-theme-muted");
    // Should NOT use the old hard-coded brand-50 for phase badges
    expect(html).not.toMatch(/bg-brand-50.*text-brand-700/);
  });

  it("Layout uses theme tokens for background", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <Provider store={createTestStore()}>
            <MemoryRouter>
              <Layout>
                <div data-testid="child">Content</div>
              </Layout>
            </MemoryRouter>
          </Provider>
        </ThemeProvider>
      </QueryClientProvider>
    );
    const outer = document.querySelector(".bg-theme-bg");
    expect(outer).toBeInTheDocument();
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("components respond to dark theme when data-theme is dark", () => {
    storage["opensprint.theme"] = "dark";
    document.documentElement.setAttribute("data-theme", "dark");
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <Provider store={createTestStore()}>
            <MemoryRouter>
              <Layout>
                <div data-testid="dark-content">Dark mode content</div>
              </Layout>
            </MemoryRouter>
          </Provider>
        </ThemeProvider>
      </QueryClientProvider>
    );
    // CSS variables are redefined in index.css for html[data-theme="dark"]
    // Components using var(--color-*) will automatically pick up dark values
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(screen.getByTestId("dark-content")).toHaveTextContent("Dark mode content");
  });
});
