import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, Navigate } from "react-router-dom";
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
import projectReducer from "../../store/slices/projectSlice";
import connectionReducer from "../../store/slices/connectionSlice";
import sketchReducer from "../../store/slices/sketchSlice";
import evalReducer from "../../store/slices/evalSlice";
import deliverReducer from "../../store/slices/deliverSlice";

const mockGetSettings = vi.fn();
const mockProjectsList = vi.fn();
const mockProjectsGet = vi.fn();
const mockGetGlobalStatus = vi.fn();
const mockGetKeys = vi.fn();
const mockModelsList = vi.fn();
vi.mock("../../api/client", () => ({
  api: {
    projects: {
      list: (...args: unknown[]) => mockProjectsList(...args),
      get: (...args: unknown[]) => mockProjectsGet(...args),
      getSettings: (...args: unknown[]) => mockGetSettings(...args),
      updateSettings: vi.fn().mockResolvedValue({}),
      getAgentsInstructions: vi.fn().mockResolvedValue({ content: "" }),
      updateAgentsInstructions: vi.fn().mockResolvedValue({ saved: true }),
      getPlanStatus: vi.fn().mockResolvedValue({ status: "idle" }),
      getSketchContext: vi.fn().mockResolvedValue({ hasExistingCode: false }),
    },
    env: {
      getKeys: (...args: unknown[]) => mockGetKeys(...args),
      getGlobalStatus: (...args: unknown[]) => mockGetGlobalStatus(...args),
    },
    models: {
      list: (...args: unknown[]) => mockModelsList(...args),
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
    agents: { active: vi.fn().mockResolvedValue([]) },
    notifications: {
      listByProject: vi.fn().mockResolvedValue([]),
      listGlobal: vi.fn().mockResolvedValue([]),
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

vi.mock("../../store/middleware/websocketMiddleware", () => ({
  wsConnect: (payload: unknown) => ({ type: "ws/connect", payload }),
  wsDisconnect: () => ({ type: "ws/disconnect" }),
  wsConnectHome: () => ({ type: "ws/connectHome" }),
  wsSend: (payload: unknown) => ({ type: "ws/send", payload }),
  websocketMiddleware: () => (next: (a: unknown) => unknown) => (action: unknown) => next(action),
}));

const storage: Record<string, string> = {};
const mockSettings = {
  simpleComplexityAgent: { type: "cursor" as const, model: null, cliCommand: null },
  complexComplexityAgent: { type: "cursor" as const, model: null, cliCommand: null },
  deployment: { mode: "custom" as const },
  aiAutonomyLevel: "confirm_all" as const,
};

beforeEach(() => {
  mockProjectsList.mockResolvedValue([]);
  mockProjectsGet.mockResolvedValue(undefined);
  mockGetGlobalStatus.mockResolvedValue({ hasAnyKey: true, useCustomCli: false });
  mockGetSettings.mockResolvedValue(mockSettings);
  mockGetKeys.mockResolvedValue({
    anthropic: true,
    cursor: true,
    claudeCli: true,
    useCustomCli: false,
  });
  mockModelsList.mockResolvedValue([]);
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
      project: projectReducer,
      connection: connectionReducer,
      execute: executeReducer,
      plan: planReducer,
      websocket: websocketReducer,
      sketch: sketchReducer,
      eval: evalReducer,
      deliver: deliverReducer,
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

  it("hides Open Sprint title and spacer below 1000px breakpoint (uses hidden min-[1000px]:inline)", () => {
    renderNavbar(<Navbar project={null} />);
    const titleSpan = screen.getByText("Open Sprint");
    expect(titleSpan).toHaveClass("hidden");
    expect(titleSpan).toHaveClass("min-[1000px]:inline");
    const spacer = screen.getByText("/");
    expect(spacer).toHaveClass("hidden");
    expect(spacer).toHaveClass("min-[1000px]:inline");
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

  describe("integration: (?) navigates to Help page (full page, project-specific when in project)", () => {
    it("homepage (project=null): Help link navigates to Help page", async () => {
      const user = userEvent.setup();
      const { HelpPage } = await import("../../pages/HelpPage");
      render(
        <ThemeProvider>
          <DisplayPreferencesProvider>
            <Provider store={createStore()}>
              <QueryClientProvider client={queryClient}>
                <MemoryRouter initialEntries={["/"]}>
                  <Routes>
                    <Route path="/" element={<Navbar project={null} />} />
                    <Route path="/help" element={<HelpPage />} />
                  </Routes>
                </MemoryRouter>
              </QueryClientProvider>
            </Provider>
          </DisplayPreferencesProvider>
        </ThemeProvider>
      );

      const helpLink = await screen.findByRole("link", { name: "Help" });
      expect(helpLink).toHaveAttribute("href", "/help");
      await user.click(helpLink);

      expect(screen.getByTestId("help-page")).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Ask a Question" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Meet your Team" })).toBeInTheDocument();
      expect(screen.getByText(/Ask about your projects/)).toBeInTheDocument();
    });

    it("project view (project set): Help link navigates to project Help page with project context", async () => {
      const user = userEvent.setup();
      const { ProjectShell } = await import("../../pages/ProjectShell");
      const { ProjectView } = await import("../../pages/ProjectView");
      const { ProjectHelpContent } = await import("../../pages/ProjectHelpContent");
      const mockProject = {
        id: "proj-1",
        name: "Test",
        repoPath: "/path",
        currentPhase: "sketch" as const,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      };
      mockProjectsGet.mockResolvedValue(mockProject);
      render(
        <ThemeProvider>
          <DisplayPreferencesProvider>
            <Provider store={createStore()}>
              <QueryClientProvider client={queryClient}>
                <MemoryRouter initialEntries={["/projects/proj-1/sketch"]}>
                  <Routes>
                    <Route path="/projects/:projectId" element={<ProjectShell />}>
                      <Route index element={<Navigate to="sketch" replace />} />
                      <Route path=":phase" element={<ProjectView />} />
                      <Route path="help" element={<ProjectHelpContent />} />
                    </Route>
                  </Routes>
                </MemoryRouter>
              </QueryClientProvider>
            </Provider>
          </DisplayPreferencesProvider>
        </ThemeProvider>
      );

      await waitFor(() => {
        expect(screen.getByText("Test")).toBeInTheDocument();
      });
      const helpLink = screen.getByRole("link", { name: "Help" });
      expect(helpLink).toHaveAttribute("href", "/projects/proj-1/help");
      await user.click(helpLink);

      expect(screen.getByTestId("help-page")).toBeInTheDocument();
      const { api } = await import("../../api/client");
      expect(api.help.history).toHaveBeenCalledWith("proj-1");
    });

    it("project Help page shows SPEED nav buttons in header", async () => {
      const { ProjectShell } = await import("../../pages/ProjectShell");
      const { ProjectHelpContent } = await import("../../pages/ProjectHelpContent");
      const mockProject = {
        id: "proj-1",
        name: "Test Project",
        repoPath: "/path",
        currentPhase: "sketch" as const,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      };
      mockProjectsGet.mockResolvedValue(mockProject);
      render(
        <ThemeProvider>
          <DisplayPreferencesProvider>
            <Provider store={createStore()}>
              <QueryClientProvider client={queryClient}>
                <MemoryRouter initialEntries={["/projects/proj-1/help"]}>
                  <Routes>
                    <Route path="/projects/:projectId" element={<ProjectShell />}>
                      <Route index element={<Navigate to="sketch" replace />} />
                      <Route path="help" element={<ProjectHelpContent />} />
                    </Route>
                  </Routes>
                </MemoryRouter>
              </QueryClientProvider>
            </Provider>
          </DisplayPreferencesProvider>
        </ThemeProvider>
      );

      await screen.findByTestId("help-page");
      expect(screen.getByRole("button", { name: "Sketch" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Plan" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Execute" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Evaluate" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Deliver" })).toBeInTheDocument();
    });

    it("Help page shows Meet your Team tab with agent grid", async () => {
      const user = userEvent.setup();
      const { HelpPage } = await import("../../pages/HelpPage");
      render(
        <ThemeProvider>
          <DisplayPreferencesProvider>
            <Provider store={createStore()}>
              <QueryClientProvider client={queryClient}>
                <MemoryRouter initialEntries={["/"]}>
                  <Routes>
                    <Route path="/" element={<Navbar project={null} />} />
                    <Route path="/help" element={<HelpPage />} />
                  </Routes>
                </MemoryRouter>
              </QueryClientProvider>
            </Provider>
          </DisplayPreferencesProvider>
        </ThemeProvider>
      );

      await user.click(screen.getByRole("link", { name: "Help" }));
      await screen.findByTestId("help-page");
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

    it("Help link uses text color (visible in light and dark themes)", () => {
      renderNavbar(<Navbar project={null} />);
      const helpLink = screen.getByRole("link", { name: "Help" });
      expect(helpLink).toHaveClass("text-theme-muted");
      expect(helpLink).not.toHaveClass("text-brand-600");
    });

    it("Help link uses text color in project view", () => {
      const mockProject = {
        id: "proj-1",
        name: "Test",
        repoPath: "/path",
        currentPhase: "sketch" as const,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      };
      renderNavbar(<Navbar project={mockProject} currentPhase="sketch" onPhaseChange={vi.fn()} />);
      const helpLink = screen.getByRole("link", { name: "Help" });
      expect(helpLink).toHaveClass("text-theme-muted");
      expect(helpLink).not.toHaveClass("text-brand-600");
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
    expect(screen.getByTestId("global-settings-content")).toBeInTheDocument();
    expect(screen.getByTestId("theme-option-light")).toBeInTheDocument();
  });

  it("navigates to /settings when Create New Project clicked and no API keys", async () => {
    mockProjectsList.mockResolvedValue([]);
    mockGetGlobalStatus.mockResolvedValue({ hasAnyKey: false, useCustomCli: false });
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

    const trigger = screen.getByRole("button", { name: /All Projects/i });
    await user.click(trigger);

    const createNewButton = screen.getByRole("button", { name: /Create New Project/i });
    await user.click(createNewButton);

    expect(screen.getByTestId("settings-page")).toBeInTheDocument();
  });

  it("navigates to /settings when Add Existing Project clicked and no API keys", async () => {
    mockProjectsList.mockResolvedValue([]);
    mockGetGlobalStatus.mockResolvedValue({ hasAnyKey: false, useCustomCli: false });
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

    const trigger = screen.getByRole("button", { name: /All Projects/i });
    await user.click(trigger);

    const addExistingButton = screen.getByRole("button", { name: /Add Existing Project/i });
    await user.click(addExistingButton);

    expect(screen.getByTestId("settings-page")).toBeInTheDocument();
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

    await screen.findByTestId("global-settings-content");
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

  it("project settings page: only Settings icon has active state, not Sketch phase tab", async () => {
    const { ProjectSettingsPage } = await import("../../pages/ProjectSettingsPage");
    const mockProject = {
      id: "proj-1",
      name: "Test",
      repoPath: "/path",
      currentPhase: "sketch" as const,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    mockProjectsGet.mockResolvedValue(mockProject);
    render(
      <ThemeProvider>
        <DisplayPreferencesProvider>
          <Provider store={createStore()}>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter initialEntries={["/projects/proj-1/settings"]}>
                <Routes>
                  <Route path="/projects/:projectId/settings" element={<ProjectSettingsPage />} />
                </Routes>
              </MemoryRouter>
            </QueryClientProvider>
          </Provider>
        </DisplayPreferencesProvider>
      </ThemeProvider>
    );

    await screen.findByTestId("project-settings-page");
    const settingsLink = screen.getByRole("link", { name: "Project settings" });
    const sketchTab = screen.getByRole("button", { name: "Sketch" });
    expect(settingsLink).toHaveClass("phase-tab-active");
    expect(sketchTab).toHaveClass("phase-tab-inactive");
    expect(sketchTab).not.toHaveClass("phase-tab-active");
  });

  it("project help page: only Help icon has active state, not Sketch phase tab", async () => {
    const { ProjectHelpPage } = await import("../../pages/ProjectHelpPage");
    const mockProject = {
      id: "proj-1",
      name: "Test",
      repoPath: "/path",
      currentPhase: "sketch" as const,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    mockProjectsGet.mockResolvedValue(mockProject);
    render(
      <ThemeProvider>
        <DisplayPreferencesProvider>
          <Provider store={createStore()}>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter initialEntries={["/projects/proj-1/help"]}>
                <Routes>
                  <Route path="/projects/:projectId/help" element={<ProjectHelpPage />} />
                </Routes>
              </MemoryRouter>
            </QueryClientProvider>
          </Provider>
        </DisplayPreferencesProvider>
      </ThemeProvider>
    );

    await screen.findByTestId("help-page");
    const helpLink = screen.getByRole("link", { name: "Help" });
    const sketchTab = screen.getByRole("button", { name: "Sketch" });
    expect(helpLink).toHaveClass("phase-tab-active");
    expect(sketchTab).toHaveClass("phase-tab-inactive");
    expect(sketchTab).not.toHaveClass("phase-tab-active");
  });
});
