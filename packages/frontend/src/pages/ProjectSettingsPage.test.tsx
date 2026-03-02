import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation, Navigate } from "react-router-dom";
import { Provider } from "react-redux";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configureStore } from "@reduxjs/toolkit";
import { ThemeProvider } from "../contexts/ThemeContext";
import { DisplayPreferencesProvider } from "../contexts/DisplayPreferencesContext";
import { ProjectShell } from "./ProjectShell";
import { ProjectSettingsContent } from "./ProjectSettingsContent";
import projectReducer from "../store/slices/projectSlice";
import websocketReducer from "../store/slices/websocketSlice";
import connectionReducer from "../store/slices/connectionSlice";
import sketchReducer from "../store/slices/sketchSlice";
import planReducer from "../store/slices/planSlice";
import executeReducer from "../store/slices/executeSlice";
import evalReducer from "../store/slices/evalSlice";
import deliverReducer from "../store/slices/deliverSlice";
import notificationReducer from "../store/slices/notificationSlice";

const mockGetSettings = vi.fn();
const mockGetKeys = vi.fn();
const mockModelsList = vi.fn();

vi.mock("../api/client", () => ({
  api: {
    projects: {
      get: vi.fn().mockResolvedValue({
        id: "proj-1",
        name: "Test Project",
        repoPath: "/path/to/repo",
        currentPhase: "sketch",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      }),
      getSettings: (...args: unknown[]) => mockGetSettings(...args),
      getPlanStatus: vi.fn().mockResolvedValue({ status: "idle" }),
      update: vi.fn().mockResolvedValue({}),
      updateSettings: vi.fn().mockResolvedValue({}),
      getAgentsInstructions: vi.fn().mockResolvedValue({ content: "" }),
      updateAgentsInstructions: vi.fn().mockResolvedValue({ saved: true }),
    },
    prd: { get: vi.fn().mockResolvedValue({}), getHistory: vi.fn().mockResolvedValue([]) },
    plans: { list: vi.fn().mockResolvedValue({ plans: [], edges: [] }) },
    tasks: { list: vi.fn().mockResolvedValue([]) },
    feedback: { list: vi.fn().mockResolvedValue([]) },
    execute: { status: vi.fn().mockResolvedValue({}) },
    deliver: {
      status: vi.fn().mockResolvedValue({ activeDeployId: null, currentDeploy: null }),
      history: vi.fn().mockResolvedValue([]),
    },
    chat: { history: vi.fn().mockResolvedValue({ messages: [] }) },
    notifications: { listByProject: vi.fn().mockResolvedValue([]), listGlobal: vi.fn().mockResolvedValue([]) },
    env: {
      getKeys: (...args: unknown[]) => mockGetKeys(...args),
    },
    models: {
      list: (...args: unknown[]) => mockModelsList(...args),
    },
    globalSettings: {
      get: vi.fn().mockResolvedValue({ databaseUrl: "" }),
    },
  },
}));

vi.mock("../components/FolderBrowser", () => ({
  FolderBrowser: () => null,
}));

vi.mock("../components/layout/Layout", () => ({
  Layout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="layout">{children}</div>
  ),
}));

// Mock websocket middleware so ProjectShell does not attempt real connection
vi.mock("../store/middleware/websocketMiddleware", () => ({
  wsConnect: (payload: unknown) => ({ type: "ws/connect", payload }),
  wsDisconnect: () => ({ type: "ws/disconnect" }),
  wsSend: (payload: unknown) => ({ type: "ws/send", payload }),
  websocketMiddleware: () => (next: (a: unknown) => unknown) => (action: unknown) => next(action),
}));

function LocationCapture() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

const mockSettings = {
  simpleComplexityAgent: { type: "cursor" as const, model: null, cliCommand: null },
  complexComplexityAgent: { type: "cursor" as const, model: null, cliCommand: null },
  deployment: { mode: "custom" as const },
  aiAutonomyLevel: "confirm_all" as const,
};

function createStore() {
  return configureStore({
    reducer: {
      project: projectReducer,
      websocket: websocketReducer,
      connection: connectionReducer,
      sketch: sketchReducer,
      plan: planReducer,
      execute: executeReducer,
      eval: evalReducer,
      deliver: deliverReducer,
      notification: notificationReducer,
    },
  });
}

function renderProjectSettingsPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <Provider store={createStore()}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <DisplayPreferencesProvider>
            <MemoryRouter initialEntries={["/projects/proj-1/settings"]}>
              <Routes>
                <Route path="/projects/:projectId" element={<ProjectShell />}>
                  <Route index element={<Navigate to="sketch" replace />} />
                  <Route
                    path="settings"
                    element={
                      <>
                        <ProjectSettingsContent />
                        <LocationCapture />
                      </>
                    }
                  />
                </Route>
              </Routes>
            </MemoryRouter>
          </DisplayPreferencesProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </Provider>
  );
}

describe("ProjectSettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockResolvedValue(mockSettings);
    mockGetKeys.mockResolvedValue({
      anthropic: true,
      cursor: true,
      openai: true,
      claudeCli: true,
      useCustomCli: false,
    });
    mockModelsList.mockResolvedValue([]);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
    );
  });

  it("renders settings page with project settings modal", async () => {
    renderProjectSettingsPage();

    await waitFor(() => {
      expect(screen.getByTestId("project-settings-page")).toBeInTheDocument();
    });
    expect(screen.getByTestId("settings-modal")).toBeInTheDocument();
  });

  it("page has flex flex-col and overflow-hidden for proper scroll containment", async () => {
    renderProjectSettingsPage();

    await waitFor(() => {
      expect(screen.getByTestId("project-settings-page")).toBeInTheDocument();
    });

    const page = screen.getByTestId("project-settings-page");
    expect(page).toHaveClass("flex");
    expect(page).toHaveClass("flex-col");
    expect(page).toHaveClass("overflow-hidden");
    expect(page).toHaveClass("min-h-0");
  });

  it("topbar and content are direct flex children of page for correct scroll chain", async () => {
    renderProjectSettingsPage();

    await waitFor(() => {
      expect(screen.getByTestId("settings-modal")).toBeInTheDocument();
    });

    const page = screen.getByTestId("project-settings-page");
    const modal = screen.getByTestId("settings-modal");
    // Page has 2 direct children: topbar navbar and content area (Execute-style layout)
    const pageChildren = Array.from(page.children);
    expect(pageChildren.length).toBe(2);
    expect(screen.getByTestId("settings-topbar-navbar")).toBeInTheDocument();
    const contentWrapper = pageChildren[1];
    expect(contentWrapper).toContainElement(modal);
    expect(contentWrapper).toHaveClass("flex-1");
    expect(contentWrapper).toHaveClass("min-h-0");
  });

  it("tabs (Global/Project and sub-tabs) are in topbar outside modal, not inside modal container", async () => {
    renderProjectSettingsPage();

    await waitFor(() => {
      expect(screen.getByTestId("settings-modal")).toBeInTheDocument();
    });

    const modal = screen.getByTestId("settings-modal");
    const topBar = screen.getByTestId("settings-top-bar");
    const subTabsBar = screen.getByTestId("settings-sub-tabs-bar");

    // Tabs must not be descendants of the modal container
    expect(modal).not.toContainElement(topBar);
    expect(modal).not.toContainElement(subTabsBar);
  });

  it("does not render back button in header", async () => {
    renderProjectSettingsPage();

    await waitFor(() => {
      expect(screen.getByTestId("project-settings-page")).toBeInTheDocument();
    });

    expect(screen.queryByRole("link", { name: "Back to project" })).not.toBeInTheDocument();
  });

  it("settings content area has overflow-y-auto for scroll when content exceeds viewport", async () => {
    renderProjectSettingsPage();

    await waitFor(() => {
      expect(screen.getByTestId("settings-modal-content")).toBeInTheDocument();
    });

    const contentArea = screen.getByTestId("settings-modal-content");
    expect(contentArea).toHaveClass("overflow-y-auto");
    expect(contentArea).toHaveClass("min-h-0");
  });

  it("navigating between settings tabs does not redirect to sketch", async () => {
    const user = userEvent.setup();
    renderProjectSettingsPage();

    await waitFor(() => {
      expect(screen.getByTestId("settings-modal")).toBeInTheDocument();
    });

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await user.click(agentConfigTab);

    await waitFor(() => {
      expect(screen.getByTestId("settings-modal")).toBeInTheDocument();
      expect(screen.getByText("Task Complexity")).toBeInTheDocument();
    });

    const deploymentTab = screen.getByRole("button", { name: "Deliver" });
    await user.click(deploymentTab);

    await waitFor(() => {
      expect(screen.getByTestId("settings-modal")).toBeInTheDocument();
      expect(screen.getByText("Delivery Mode")).toBeInTheDocument();
    });

    expect(screen.getByTestId("project-settings-page")).toBeInTheDocument();
  });

  it("updates URL with tab param when switching settings tabs", async () => {
    const user = userEvent.setup();
    renderProjectSettingsPage();

    await waitFor(() => {
      expect(screen.getByTestId("settings-modal")).toBeInTheDocument();
    });
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/proj-1/settings");

    const agentConfigTab = screen.getByRole("button", { name: "Agent Config" });
    await user.click(agentConfigTab);

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/projects/proj-1/settings?tab=agents"
      );
    });

    const deploymentTab = screen.getByRole("button", { name: "Deliver" });
    await user.click(deploymentTab);

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/projects/proj-1/settings?tab=deployment"
      );
    });
  });
});
