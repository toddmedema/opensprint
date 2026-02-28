import type { ReactElement } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configureStore } from "@reduxjs/toolkit";
import { MemoryRouter } from "react-router";
import { ThemeProvider } from "../../contexts/ThemeContext";
import { DisplayPreferencesProvider } from "../../contexts/DisplayPreferencesContext";
import { NAVBAR_HEIGHT } from "../../lib/constants";
import { Layout } from "./Layout";
import notificationReducer from "../../store/slices/notificationSlice";
import executeReducer from "../../store/slices/executeSlice";
import planReducer from "../../store/slices/planSlice";
import websocketReducer from "../../store/slices/websocketSlice";
import openQuestionsReducer from "../../store/slices/openQuestionsSlice";

vi.mock("../../api/client", () => ({
  api: {
    projects: { list: () => Promise.resolve([]) },
    agents: { active: () => Promise.resolve([]) },
    notifications: {
      listByProject: () => Promise.resolve([]),
      listGlobal: () => Promise.resolve([]),
    },
  },
}));

const storage: Record<string, string> = {};
beforeEach(() => {
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

function createTestStore() {
  return configureStore({
    reducer: {
      notification: notificationReducer,
      execute: executeReducer,
      plan: planReducer,
      websocket: websocketReducer,
      openQuestions: openQuestionsReducer,
    },
  });
}

const queryClient = new QueryClient();

function renderLayout(ui: ReactElement) {
  return render(
    <Provider store={createTestStore()}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ThemeProvider>
            <DisplayPreferencesProvider>{ui}</DisplayPreferencesProvider>
          </ThemeProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </Provider>
  );
}

describe("Layout", () => {
  it("renders children in main", () => {
    renderLayout(
      <Layout>
        <span data-testid="child">Content</span>
      </Layout>
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("renders navbar with identical height on home (project=null) and project pages", () => {
    const mockProject = {
      id: "proj-1",
      name: "Test",
      repoPath: "/path",
      currentPhase: "sketch" as const,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    const { unmount } = renderLayout(
      <Layout>
        <span>Home content</span>
      </Layout>
    );
    const navHome = screen.getByRole("navigation");
    expect(navHome).toHaveStyle({ height: `${NAVBAR_HEIGHT}px` });
    unmount();

    renderLayout(
      <Layout project={mockProject} currentPhase="sketch" onPhaseChange={() => {}}>
        <span>Project content</span>
      </Layout>
    );
    const navProject = screen.getByRole("navigation");
    expect(navProject).toHaveStyle({ height: `${NAVBAR_HEIGHT}px` });
  });

  it("has main with flex flex-col min-h-0 and overflow-hidden for independent phase scroll", () => {
    renderLayout(
      <Layout>
        <span>Content</span>
      </Layout>
    );
    const main = document.querySelector("main");
    expect(main).toBeInTheDocument();
    expect(main).toHaveClass("flex");
    expect(main).toHaveClass("flex-col");
    expect(main).toHaveClass("min-h-0");
    expect(main).toHaveClass("overflow-hidden");
  });
});
