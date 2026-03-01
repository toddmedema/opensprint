import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { Provider } from "react-redux";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configureStore } from "@reduxjs/toolkit";
import type { Task } from "@opensprint/shared";
import { ThemeProvider } from "../../contexts/ThemeContext";
import { DisplayPreferencesProvider } from "../../contexts/DisplayPreferencesContext";
import { NAVBAR_HEIGHT } from "../../lib/constants";
import { queryKeys } from "../../api/queryKeys";
import { Navbar } from "./Navbar";
import executeReducer, { toTasksByIdAndOrder } from "../../store/slices/executeSlice";
import planReducer from "../../store/slices/planSlice";
import websocketReducer from "../../store/slices/websocketSlice";
import openQuestionsReducer from "../../store/slices/openQuestionsSlice";
import notificationReducer from "../../store/slices/notificationSlice";

const mockGetSettings = vi.fn();
const mockProjectsList = vi.fn();
const mockProjectsGet = vi.fn();
const mockGetGlobalStatus = vi.fn();
vi.mock("../../api/client", () => ({
  api: {
    projects: {
      list: (...args: unknown[]) => mockProjectsList(...args),
      get: (...args: unknown[]) => mockProjectsGet(...args),
      getSettings: (...args: unknown[]) => mockGetSettings(...args),
    },
    agents: { active: vi.fn().mockResolvedValue([]) },
    notifications: {
      listByProject: vi.fn().mockResolvedValue([]),
      listGlobal: vi.fn().mockResolvedValue([]),
    },
    env: {
      getKeys: vi.fn().mockResolvedValue({
        anthropic: true,
        cursor: true,
        claudeCli: true,
        useCustomCli: false,
      }),
      getGlobalStatus: (...args: unknown[]) => mockGetGlobalStatus(...args),
    },
    globalSettings: {
      get: vi.fn().mockResolvedValue({ databaseUrl: "" }),
      put: vi.fn(),
    },
    help: {
      history: vi.fn().mockResolvedValue({ messages: [] }),
      chat: vi.fn(),
    },
  },
}));

const storage: Record<string, string> = {};
beforeEach(() => {
  mockProjectsList.mockResolvedValue([]);
  mockProjectsGet.mockResolvedValue(undefined);
  mockGetGlobalStatus.mockResolvedValue({ hasAnyKey: true, useCustomCli: false });
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

const queryClient = new QueryClient();

function renderNavbar(ui: ReactElement, store = createStore()) {
  return render(
    <ThemeProvider>
      <DisplayPreferencesProvider>
        <Provider store={store}>
          <QueryClientProvider client={queryClient}>
            <MemoryRouter>{ui}</MemoryRouter>
          </QueryClientProvider>
        </Provider>
      </DisplayPreferencesProvider>
    </ThemeProvider>
  );
}

function createStore(executeTasks: Task[] = []) {
  return configureStore({
    reducer: {
      execute: executeReducer,
      plan: planReducer,
      websocket: websocketReducer,
      openQuestions: openQuestionsReducer,
      notification: notificationReducer,
    },
    preloadedState: {
      execute: {
        ...toTasksByIdAndOrder(executeTasks),
        awaitingApproval: false,
        orchestratorRunning: false,
        activeTasks: [],
        selectedTaskId: null,
        taskDetailLoading: false,
        taskDetailError: null,
        agentOutput: {},
        completionState: null,
        archivedSessions: [],
        archivedLoading: false,
        markDoneLoading: false,
        unblockLoading: false,
        statusLoading: false,
        loading: false,
        error: null,
      },
      plan: {
        plans: [],
        dependencyGraph: null,
        selectedPlanId: null,
        chatMessages: {},
        loading: false,
        decomposing: false,
        executingPlanId: null,
        reExecutingPlanId: null,
        archivingPlanId: null,
        error: null,
      },
      websocket: { connected: false, deliverToast: null },
    },
  });
}

const baseTask: Partial<Task> = {
  title: "Task",
  description: "",
  type: "task",
  status: "open",
  priority: 0,
  assignee: null,
  labels: [],
  dependencies: [],
  epicId: "epic-1",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

describe("Navbar", () => {
  it("always shows logo icon in header (visible at all viewport widths)", () => {
    renderNavbar(<Navbar project={null} />);
    const logoLink = screen.getByTestId("navbar-logo-link");
    expect(logoLink).toBeInTheDocument();
    const svg = logoLink.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute("viewBox", "0 0 80 80");
  });

  it("hides Open Sprint title and spacer below md breakpoint (uses hidden md:inline)", () => {
    renderNavbar(<Navbar project={null} />);
    const titleSpan = screen.getByText("Open Sprint");
    expect(titleSpan).toHaveClass("hidden");
    expect(titleSpan).toHaveClass("md:inline");
    const spacer = screen.getByText("/");
    expect(spacer).toHaveClass("hidden");
    expect(spacer).toHaveClass("md:inline");
  });

  it("has fixed height matching NAVBAR_HEIGHT on homepage (project=null)", () => {
    renderNavbar(<Navbar project={null} />);
    const nav = screen.getByRole("navigation");
    expect(nav).toHaveStyle({ height: `${NAVBAR_HEIGHT}px` });
  });

  it("has fixed height matching NAVBAR_HEIGHT on project pages (with phase tabs)", () => {
    const mockProject = {
      id: "proj-1",
      name: "Test",
      repoPath: "/path",
      currentPhase: "sketch" as const,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    renderNavbar(
      <Navbar project={mockProject} currentPhase="sketch" onPhaseChange={vi.fn()} />
    );
    const nav = screen.getByRole("navigation");
    expect(nav).toHaveStyle({ height: `${NAVBAR_HEIGHT}px` });
  });

  it("projects dropdown items have hover effect for clickability feedback", async () => {
    const projects = [
      {
        id: "proj-1",
        name: "Project A",
        repoPath: "/path/a",
        currentPhase: "sketch" as const,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      },
      {
        id: "proj-2",
        name: "Project B",
        repoPath: "/path/b",
        currentPhase: "sketch" as const,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      },
    ];
    mockProjectsList.mockResolvedValue(projects);
    const user = userEvent.setup();
    renderNavbar(<Navbar project={projects[0]} currentPhase="sketch" onPhaseChange={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: /Project A/i });
    await user.click(trigger);

    const nonSelectedOption = screen.getByRole("option", { name: "Project B" });
    expect(nonSelectedOption).toHaveClass("hover:bg-theme-info-bg");
  });

  it("has z-[60] so dropdowns appear above Build sidebar (z-50)", () => {
    renderNavbar(<Navbar project={null} />);

    const nav = screen.getByRole("navigation");
    expect(nav).toHaveClass("z-[60]");
  });

  it("does not render theme toggle in navbar", () => {
    renderNavbar(<Navbar project={null} />);

    expect(screen.queryByTestId("navbar-theme-light")).not.toBeInTheDocument();
    expect(screen.queryByTestId("navbar-theme-dark")).not.toBeInTheDocument();
    expect(screen.queryByTestId("navbar-theme-system")).not.toBeInTheDocument();
  });

  it("shows Execute tab label when no blocked tasks", () => {
    const mockProject = {
      id: "proj-1",
      name: "Test",
      repoPath: "/path",
      currentPhase: "sketch" as const,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    const store = createStore([{ ...baseTask, id: "epic-1.1", kanbanColumn: "ready" } as Task]);
    const onPhaseChange = vi.fn();
    renderNavbar(
      <Navbar project={mockProject} currentPhase="sketch" onPhaseChange={onPhaseChange} />,
      store
    );

    expect(screen.getByRole("button", { name: "Execute" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "⚠️ Execute" })).not.toBeInTheDocument();
  });

  it("shows ⚠️ Execute badge in phase nav when blocked task count > 0", () => {
    const mockProject = {
      id: "proj-1",
      name: "Test",
      repoPath: "/path",
      currentPhase: "sketch" as const,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    const store = createStore([{ ...baseTask, id: "epic-1.1", kanbanColumn: "blocked" } as Task]);
    const onPhaseChange = vi.fn();
    renderNavbar(
      <Navbar project={mockProject} currentPhase="sketch" onPhaseChange={onPhaseChange} />,
      store
    );

    expect(screen.getByRole("button", { name: "⚠️ Execute" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Execute" })).not.toBeInTheDocument();
  });

  it("shows Execute (no badge) when blocked count returns to zero", () => {
    const mockProject = {
      id: "proj-1",
      name: "Test",
      repoPath: "/path",
      currentPhase: "sketch" as const,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    const store = createStore([{ ...baseTask, id: "epic-1.1", kanbanColumn: "ready" } as Task]);
    const onPhaseChange = vi.fn();
    renderNavbar(
      <Navbar project={mockProject} currentPhase="execute" onPhaseChange={onPhaseChange} />,
      store
    );

    expect(screen.getByRole("button", { name: "Execute" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "⚠️ Execute" })).not.toBeInTheDocument();
  });

  describe("integration: (?) opens Help modal (preserves project context)", () => {
    it("homepage (project=null): Help button opens modal without navigating", async () => {
      const user = userEvent.setup();
      render(
        <ThemeProvider>
          <DisplayPreferencesProvider>
            <Provider store={createStore()}>
              <QueryClientProvider client={queryClient}>
                <MemoryRouter initialEntries={["/"]}>
                  <Routes>
                    <Route path="/" element={<Navbar project={null} />} />
                  </Routes>
                </MemoryRouter>
              </QueryClientProvider>
            </Provider>
          </DisplayPreferencesProvider>
        </ThemeProvider>
      );

      const helpButton = await screen.findByRole("button", { name: "Help" });
      await user.click(helpButton);

      expect(screen.getByRole("dialog", { name: /help/i })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Ask a Question" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Meet your Team" })).toBeInTheDocument();
      expect(screen.getByText(/Ask about your projects/)).toBeInTheDocument();
    });

    it("project view (project set): Help button opens modal with project context", async () => {
      const user = userEvent.setup();
      const { api } = await import("../../api/client");
      const mockProject = {
        id: "proj-1",
        name: "Test",
        repoPath: "/path",
        currentPhase: "sketch" as const,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      };
      renderNavbar(<Navbar project={mockProject} currentPhase="sketch" onPhaseChange={vi.fn()} />);

      const helpButton = screen.getByRole("button", { name: "Help" });
      await user.click(helpButton);

      expect(screen.getByRole("dialog", { name: /help/i })).toBeInTheDocument();
      expect(api.help.history).toHaveBeenCalledWith("proj-1");
    });

    it("Help modal preserves route and project view (does not navigate)", async () => {
      const user = userEvent.setup();
      const mockProject = {
        id: "proj-1",
        name: "Test Project",
        repoPath: "/path",
        currentPhase: "sketch" as const,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      };
      render(
        <ThemeProvider>
          <DisplayPreferencesProvider>
            <Provider store={createStore()}>
              <QueryClientProvider client={queryClient}>
                <MemoryRouter initialEntries={["/projects/proj-1/execute"]}>
                  <Routes>
                    <Route path="/projects/:projectId/:phase?" element={<Navbar project={mockProject} currentPhase="execute" onPhaseChange={vi.fn()} />} />
                  </Routes>
                </MemoryRouter>
              </QueryClientProvider>
            </Provider>
          </DisplayPreferencesProvider>
        </ThemeProvider>
      );

      const helpButton = screen.getByRole("button", { name: "Help" });
      await user.click(helpButton);

      expect(screen.getByRole("dialog", { name: /help/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Test Project/i })).toBeInTheDocument();
    });

    it("Meet your Team tab shows agent grid when Help modal is open", async () => {
      const user = userEvent.setup();
      renderNavbar(<Navbar project={null} />);

      await user.click(screen.getByRole("button", { name: "Help" }));
      await user.click(screen.getByRole("tab", { name: "Meet your Team" }));

      expect(screen.getByRole("tab", { name: "Meet your Team" })).toHaveAttribute(
        "aria-selected",
        "true"
      );
      expect(screen.getByText("Dreamer")).toBeInTheDocument();
      expect(screen.getByText("Planner")).toBeInTheDocument();
      expect(screen.getByText("Sketch")).toBeInTheDocument();
      expect(screen.getAllByRole("listitem")).toHaveLength(9);
    });

    it("Help button uses text color (visible in light and dark themes)", () => {
      renderNavbar(<Navbar project={null} />);
      const helpButton = screen.getByRole("button", { name: "Help" });
      expect(helpButton).toHaveClass("text-theme-muted");
      expect(helpButton).not.toHaveClass("text-brand-600");
    });

    it("Help button uses text color in project view", () => {
      const mockProject = {
        id: "proj-1",
        name: "Test",
        repoPath: "/path",
        currentPhase: "sketch" as const,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      };
      renderNavbar(<Navbar project={mockProject} currentPhase="sketch" onPhaseChange={vi.fn()} />);
      const helpButton = screen.getByRole("button", { name: "Help" });
      expect(helpButton).toHaveClass("text-theme-muted");
      expect(helpButton).not.toHaveClass("text-brand-600");
    });
  });

  it("homepage shows settings link when no projects", () => {
    mockProjectsList.mockResolvedValue([]);
    renderNavbar(<Navbar project={null} />);

    const settingsLink = screen.getByRole("link", { name: "Settings" });
    expect(settingsLink).toBeInTheDocument();
    expect(settingsLink).toHaveAttribute("href", "/settings");
  });

  it("homepage shows settings link when projects exist", async () => {
    const projects = [
      {
        id: "proj-1",
        name: "Project A",
        repoPath: "/path/a",
        currentPhase: "sketch" as const,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      },
    ];
    mockProjectsList.mockResolvedValue(projects);
    renderNavbar(<Navbar project={null} />);

    const settingsLink = await screen.findByRole("link", { name: "Settings" });
    expect(settingsLink).toHaveAttribute("href", "/settings");
  });

  it("homepage: clicking settings link navigates to settings page", async () => {
    mockProjectsList.mockResolvedValue([]);
    const user = userEvent.setup();
    const { SettingsPage } = await import("../../pages/SettingsPage");
    render(
      <ThemeProvider>
        <DisplayPreferencesProvider>
          <Provider store={createStore()}>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter initialEntries={["/"]}>
                <Routes>
                  <Route path="/" element={<Navbar project={null} />} />
                  <Route path="/settings" element={<SettingsPage />} />
                </Routes>
              </MemoryRouter>
            </QueryClientProvider>
          </Provider>
        </DisplayPreferencesProvider>
      </ThemeProvider>
    );

    const settingsLink = screen.getByRole("link", { name: "Settings" });
    await user.click(settingsLink);

    expect(screen.getByTestId("settings-page")).toBeInTheDocument();
    expect(screen.getByTestId("display-section")).toBeInTheDocument();
    expect(screen.getByTestId("theme-option-light")).toBeInTheDocument();
  });

  it("shows ApiKeySetupModal when Create New Project clicked and no API keys", async () => {
    mockProjectsList.mockResolvedValue([]);
    mockGetGlobalStatus.mockResolvedValue({ hasAnyKey: false, useCustomCli: false });
    const user = userEvent.setup();
    renderNavbar(<Navbar project={null} />);

    const trigger = screen.getByRole("button", { name: /All Projects/i });
    await user.click(trigger);

    const createNewButton = screen.getByRole("button", { name: /Create New Project/i });
    await user.click(createNewButton);

    expect(screen.getByTestId("api-key-setup-modal")).toBeInTheDocument();
    expect(screen.getByText("Enter agent API key")).toBeInTheDocument();
  });

  it("shows ApiKeySetupModal when Add Existing Project clicked and no API keys", async () => {
    mockProjectsList.mockResolvedValue([]);
    mockGetGlobalStatus.mockResolvedValue({ hasAnyKey: false, useCustomCli: false });
    const user = userEvent.setup();
    renderNavbar(<Navbar project={null} />);

    const trigger = screen.getByRole("button", { name: /All Projects/i });
    await user.click(trigger);

    const addExistingButton = screen.getByRole("button", { name: /Add Existing Project/i });
    await user.click(addExistingButton);

    expect(screen.getByTestId("api-key-setup-modal")).toBeInTheDocument();
  });

  it("theme is configurable from settings page", async () => {
    const user = userEvent.setup();
    const { SettingsPage } = await import("../../pages/SettingsPage");
    render(
      <ThemeProvider>
        <DisplayPreferencesProvider>
          <Provider store={createStore()}>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter initialEntries={["/settings"]}>
                <Routes>
                  <Route path="/" element={<Navbar project={null} />} />
                  <Route path="/settings" element={<SettingsPage />} />
                </Routes>
              </MemoryRouter>
            </QueryClientProvider>
          </Provider>
        </DisplayPreferencesProvider>
      </ThemeProvider>
    );

    await screen.findByTestId("display-section");
    await user.click(screen.getByTestId("theme-option-dark"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("opensprint.theme")).toBe("dark");
  });

  it("Settings link shows blue active state when on settings page", async () => {
    const { SettingsPage } = await import("../../pages/SettingsPage");
    render(
      <ThemeProvider>
        <DisplayPreferencesProvider>
          <Provider store={createStore()}>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter initialEntries={["/settings"]}>
                <Routes>
                  <Route path="/" element={<Navbar project={null} />} />
                  <Route path="/settings" element={<SettingsPage />} />
                </Routes>
              </MemoryRouter>
            </QueryClientProvider>
          </Provider>
        </DisplayPreferencesProvider>
      </ThemeProvider>
    );

    const settingsLink = screen.getByRole("link", { name: "Settings" });
    expect(settingsLink).toHaveClass("phase-tab-active");
  });
});
