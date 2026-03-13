import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, Navigate } from "react-router-dom";
import { Provider } from "react-redux";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configureStore } from "@reduxjs/toolkit";
import type { Task } from "@opensprint/shared";
import { ThemeProvider } from "../../contexts/ThemeContext";
import { DisplayPreferencesProvider } from "../../contexts/DisplayPreferencesContext";
import { NAVBAR_HEIGHT } from "../../lib/constants";
import { mockViewport, VIEWPORT_MOBILE, VIEWPORT_TABLET } from "../../test/test-utils";
import { Navbar } from "./Navbar";
import executeReducer, { toTasksByIdAndOrder } from "../../store/slices/executeSlice";
import planReducer from "../../store/slices/planSlice";
import websocketReducer from "../../store/slices/websocketSlice";
import globalReducer from "../../store/slices/globalSlice";
import openQuestionsReducer from "../../store/slices/openQuestionsSlice";
import notificationReducer from "../../store/slices/notificationSlice";
import projectReducer from "../../store/slices/projectSlice";
import connectionReducer from "../../store/slices/connectionSlice";
import sketchReducer from "../../store/slices/sketchSlice";
import evalReducer from "../../store/slices/evalSlice";
import deliverReducer from "../../store/slices/deliverSlice";
import unreadPhaseReducer from "../../store/slices/unreadPhaseSlice";
import routeReducer from "../../store/slices/routeSlice";

const mockGetSettings = vi.fn();
const mockProjectsList = vi.fn();
const mockProjectsGet = vi.fn();
const mockGetGlobalStatus = vi.fn();
const mockGetKeys = vi.fn();
const mockGetPrerequisites = vi.fn();
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
      getPrerequisites: (...args: unknown[]) => mockGetPrerequisites(...args),
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
    dbStatus: {
      get: vi.fn().mockResolvedValue({ ok: true, state: "connected", lastCheckedAt: null }),
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
  mockGetPrerequisites.mockResolvedValue({ missing: [], platform: "darwin" });
  mockGetSettings.mockResolvedValue(mockSettings);
  mockGetKeys.mockResolvedValue({
    anthropic: true,
    cursor: true,
    openai: true,
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

function createStore(
  executeTasks: Task[] = [],
  overrides?: {
    websocket?: { connected: boolean; deliverToast: string | null };
    unreadPhase?: Record<string, { plan?: boolean; sketch?: boolean; execute?: boolean }>;
  }
) {
  return configureStore({
    reducer: {
      project: projectReducer,
      connection: connectionReducer,
      execute: executeReducer,
      plan: planReducer,
      websocket: websocketReducer,
      global: globalReducer,
      sketch: sketchReducer,
      eval: evalReducer,
      deliver: deliverReducer,
      openQuestions: openQuestionsReducer,
      notification: notificationReducer,
      unreadPhase: unreadPhaseReducer,
      route: routeReducer,
    },
    preloadedState: {
      execute: {
        ...toTasksByIdAndOrder(executeTasks),
        awaitingApproval: false,
        orchestratorRunning: false,
        activeTasks: [],
        activeAgents: [],
        activeAgentsLoadedOnce: false,
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
      websocket: overrides?.websocket ?? { connected: false, deliverToast: null },
      unreadPhase: overrides?.unreadPhase ?? {},
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

  it("shows only logo and project picker in top-left (no Open Sprint text)", () => {
    renderNavbar(<Navbar project={null} />);
    expect(screen.getByTestId("navbar-logo-link")).toBeInTheDocument();
    expect(screen.getByTestId("navbar-project-select")).toBeInTheDocument();
    expect(screen.queryByText("Open Sprint")).not.toBeInTheDocument();
  });

  it("on macOS Electron, keeps logo for Home and offsets left slot for traffic lights", () => {
    const prev =
      typeof window !== "undefined" && (window as unknown as { electron?: unknown }).electron;
    if (typeof window !== "undefined") {
      (window as unknown as { electron: { isElectron: true; platform: string } }).electron = {
        isElectron: true,
        platform: "darwin",
      };
    }
    renderNavbar(<Navbar project={null} />);
    expect(screen.getByTestId("navbar-logo-link")).toBeInTheDocument();
    expect(screen.getByTestId("navbar-left-slot")).toHaveClass("pl-[62px]");
    if (typeof window !== "undefined") {
      if (prev !== undefined) (window as unknown as { electron: unknown }).electron = prev;
      else delete (window as unknown as { electron?: unknown }).electron;
    }
  });

  it("on macOS Electron, right slot has no right padding so right-edge controls sit at edge", () => {
    const prev =
      typeof window !== "undefined" && (window as unknown as { electron?: unknown }).electron;
    if (typeof window !== "undefined") {
      (window as unknown as { electron: { isElectron: true; platform: string } }).electron = {
        isElectron: true,
        platform: "darwin",
      };
    }
    renderNavbar(<Navbar project={null} />);
    expect(screen.getByTestId("navbar-right-slot")).toHaveClass("pr-0");
    if (typeof window !== "undefined") {
      if (prev !== undefined) (window as unknown as { electron: unknown }).electron = prev;
      else delete (window as unknown as { electron?: unknown }).electron;
    }
  });

  it("on macOS Electron, settings icon in nav bar has 4px right margin", () => {
    const prev =
      typeof window !== "undefined" && (window as unknown as { electron?: unknown }).electron;
    if (typeof window !== "undefined") {
      (window as unknown as { electron: { isElectron: true; platform: string } }).electron = {
        isElectron: true,
        platform: "darwin",
      };
    }
    renderNavbar(<Navbar project={null} />);
    const settingsLink = screen.getByRole("link", { name: "Settings" });
    expect(settingsLink).toHaveClass("mr-1");
    if (typeof window !== "undefined") {
      if (prev !== undefined) (window as unknown as { electron: unknown }).electron = prev;
      else delete (window as unknown as { electron?: unknown }).electron;
    }
  });

  it("on macOS Electron, top bar is draggable (webkit-app-region: drag) and interactive elements are no-drag", () => {
    const prev =
      typeof window !== "undefined" && (window as unknown as { electron?: unknown }).electron;
    try {
      if (typeof window !== "undefined") {
        (window as unknown as { electron: { isElectron: true; platform: string } }).electron = {
          isElectron: true,
          platform: "darwin",
        };
      }
      renderNavbar(<Navbar project={null} />);
      const nav = screen.getByRole("navigation") as HTMLElement;
      const logoLink = screen.getByTestId("navbar-logo-link") as HTMLElement;
      const rightSlot = screen.getByTestId("navbar-right-slot") as HTMLElement;
      // React sets -webkit-app-region on the style object; jsdom may not serialize it to getAttribute("style")
      const navStyleObj = nav.style as unknown as Record<string, string>;
      const logoStyleObj = logoLink.style as unknown as Record<string, string>;
      const rightStyleObj = rightSlot.style as unknown as Record<string, string>;
      expect(navStyleObj.webkitAppRegion || navStyleObj.WebkitAppRegion).toBe("drag");
      expect(logoStyleObj.webkitAppRegion || logoStyleObj.WebkitAppRegion).toBe("no-drag");
      expect(rightStyleObj.webkitAppRegion || rightStyleObj.WebkitAppRegion).toBe("no-drag");
    } finally {
      if (typeof window !== "undefined") {
        if (prev !== undefined) (window as unknown as { electron: unknown }).electron = prev;
        else delete (window as unknown as { electron?: unknown }).electron;
      }
    }
  });

  it("on Windows Electron, shows integrated window controls (minimize, maximize, close) in navbar", async () => {
    const prev =
      typeof window !== "undefined" && (window as unknown as { electron?: unknown }).electron;
    if (typeof window !== "undefined") {
      (window as unknown as {
        electron: {
          isElectron: true;
          platform: string;
          getWindowMaximized: () => Promise<boolean>;
          onWindowMaximized: (cb: () => void) => () => void;
          onWindowUnmaximized: (cb: () => void) => () => void;
          minimizeWindow: () => Promise<void>;
          maximizeWindow: () => Promise<void>;
          closeWindow: () => Promise<void>;
        };
      }).electron = {
        isElectron: true,
        platform: "win32",
        getWindowMaximized: vi.fn().mockResolvedValue(false),
        onWindowMaximized: vi.fn(() => () => {}),
        onWindowUnmaximized: vi.fn(() => () => {}),
        minimizeWindow: vi.fn().mockResolvedValue(undefined),
        maximizeWindow: vi.fn().mockResolvedValue(undefined),
        closeWindow: vi.fn().mockResolvedValue(undefined),
      };
    }
    renderNavbar(<Navbar project={null} />);
    await waitFor(() => {
      expect(screen.getByTestId("navbar-window-controls")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Minimize" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Maximize" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    if (typeof window !== "undefined") {
      if (prev !== undefined) (window as unknown as { electron: unknown }).electron = prev;
      else delete (window as unknown as { electron?: unknown }).electron;
    }
  });

  it("on Windows Electron, settings icon has 5px less right margin in top nav", async () => {
    const prev =
      typeof window !== "undefined" && (window as unknown as { electron?: unknown }).electron;
    if (typeof window !== "undefined") {
      (window as unknown as {
        electron: {
          isElectron: true;
          platform: string;
          getWindowMaximized: () => Promise<boolean>;
          onWindowMaximized: (cb: () => void) => () => void;
          onWindowUnmaximized: (cb: () => void) => () => void;
          minimizeWindow: () => Promise<void>;
          maximizeWindow: () => Promise<void>;
          closeWindow: () => Promise<void>;
        };
      }).electron = {
        isElectron: true,
        platform: "win32",
        getWindowMaximized: vi.fn().mockResolvedValue(false),
        onWindowMaximized: vi.fn(() => () => {}),
        onWindowUnmaximized: vi.fn(() => () => {}),
        minimizeWindow: vi.fn().mockResolvedValue(undefined),
        maximizeWindow: vi.fn().mockResolvedValue(undefined),
        closeWindow: vi.fn().mockResolvedValue(undefined),
      };
    }
    renderNavbar(<Navbar project={null} />);
    const settingsLink = await screen.findByRole("link", { name: "Settings" });
    expect(settingsLink).toHaveClass("-mr-[5px]");
    if (typeof window !== "undefined") {
      if (prev !== undefined) (window as unknown as { electron: unknown }).electron = prev;
      else delete (window as unknown as { electron?: unknown }).electron;
    }
  });

  it("hides project select below 800px breakpoint (uses hidden min-[800px]:flex)", () => {
    renderNavbar(<Navbar project={null} />);
    const projectSelect = screen.getByTestId("navbar-project-select");
    expect(projectSelect).toHaveClass("hidden");
    expect(projectSelect).toHaveClass("min-[800px]:flex");
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
    renderNavbar(<Navbar project={mockProject} currentPhase="sketch" onPhaseChange={vi.fn()} />);
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

  it("project selector dropdown shows full list when opened (projects + Add/Create buttons)", async () => {
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
    const user = userEvent.setup();
    renderNavbar(<Navbar project={projects[0]} currentPhase="sketch" onPhaseChange={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: /Project A/i });
    await user.click(trigger);

    const dropdown = screen.getByTestId("navbar-project-dropdown");
    expect(dropdown).toBeInTheDocument();
    expect(dropdown).toBeVisible();
    expect(screen.getByRole("option", { name: "Project A" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add Existing Project/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create New Project/i })).toBeInTheDocument();
  });

  it("uses responsive edge spacing (pl/pr-4 on mobile, pl/pr-6 on md+) so logo left matches Settings right", () => {
    renderNavbar(<Navbar project={null} />);
    const nav = screen.getByRole("navigation");
    const content = nav.children[1];
    expect(content).toHaveClass("pl-4");
    expect(content).toHaveClass("pr-4");
    expect(content).toHaveClass("md:pl-6");
    expect(content).toHaveClass("md:pr-6");
  });

  it("uses flush layout (no gap above nav buttons): nav and inner content have py-0, phase tablist has items-stretch", () => {
    renderNavbar(<Navbar project={null} />);
    const nav = screen.getByRole("navigation");
    expect(nav).toHaveClass("py-0");
    expect(nav).toHaveClass("overflow-hidden");
    const content = nav.children[1] as HTMLElement;
    expect(content).toHaveClass("py-0");
    expect(content).toHaveClass("items-stretch");
  });

  it("uses 3-column grid so phase tabs (nav icons) are viewport-centered regardless of left content width", () => {
    renderNavbar(<Navbar project={null} />);
    const nav = screen.getByRole("navigation");
    const grid = nav.children[1] as HTMLElement;
    expect(grid).toHaveClass("grid");
    expect(grid).toHaveClass("grid-cols-[1fr_auto_1fr]");
  });

  it("phase tab row and buttons use flush layout (no gap above): tablist py-0/items-stretch, tabs min-h-0 h-full", () => {
    const mockProject = {
      id: "proj-1",
      name: "Test",
      repoPath: "/path",
      currentPhase: "sketch" as const,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    renderNavbar(<Navbar project={mockProject} currentPhase="sketch" onPhaseChange={vi.fn()} />);
    const tablist = screen.getByRole("tablist", { name: "Phase navigation" });
    expect(tablist).toHaveClass("py-0");
    expect(tablist).toHaveClass("items-stretch");
    const sketchTab = screen.getByRole("tab", { name: /Sketch/ });
    expect(sketchTab).toHaveClass("min-h-0");
    expect(sketchTab).toHaveClass("h-full");
  });

  it("phase tabs container is horizontally scrollable on mobile (overflow-x-auto)", () => {
    const mockProject = {
      id: "proj-1",
      name: "Test",
      repoPath: "/path",
      currentPhase: "sketch" as const,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    renderNavbar(<Navbar project={mockProject} currentPhase="sketch" onPhaseChange={vi.fn()} />);
    const phaseTabsContainer = screen
      .getByRole("tab", { name: /Sketch/ })
      .closest("div")?.parentElement;
    expect(phaseTabsContainer).toHaveClass("overflow-x-auto");
  });

  it("phase tabs have aria-label and aria-current for accessibility", () => {
    const mockProject = {
      id: "proj-1",
      name: "Test",
      repoPath: "/path",
      currentPhase: "sketch" as const,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    renderNavbar(<Navbar project={mockProject} currentPhase="sketch" onPhaseChange={vi.fn()} />);
    const sketchTab = screen.getByRole("tab", { name: /Sketch/ });
    const planTab = screen.getByRole("tab", { name: /Plan/ });
    expect(sketchTab).toHaveAttribute("aria-label", "Switch to Sketch phase");
    expect(sketchTab).toHaveAttribute("aria-current", "page");
    expect(planTab).toHaveAttribute("aria-label", "Switch to Plan phase");
    expect(planTab).not.toHaveAttribute("aria-current");
  });

  it("phase tabs have role tab and tablist for keyboard navigation", () => {
    const mockProject = {
      id: "proj-1",
      name: "Test",
      repoPath: "/path",
      currentPhase: "sketch" as const,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    renderNavbar(<Navbar project={mockProject} currentPhase="sketch" onPhaseChange={vi.fn()} />);
    const tablist = screen.getByRole("tablist", { name: "Phase navigation" });
    expect(tablist).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(5);
  });

  describe("viewport behavior", () => {
    it("navbar and phase tabs render at mobile viewport (375×667)", () => {
      const restore = mockViewport(VIEWPORT_MOBILE.width, VIEWPORT_MOBILE.height);
      try {
        const mockProject = {
          id: "proj-1",
          name: "Test",
          repoPath: "/path",
          currentPhase: "sketch" as const,
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T00:00:00Z",
        };
        renderNavbar(<Navbar project={mockProject} currentPhase="sketch" onPhaseChange={vi.fn()} />);
        expect(screen.getByRole("navigation")).toBeInTheDocument();
        expect(screen.getByRole("tab", { name: /Sketch/ })).toBeInTheDocument();
        expect(screen.getByRole("tab", { name: /Plan/ })).toBeInTheDocument();
        expect(screen.getByRole("tab", { name: /Execute/ })).toBeInTheDocument();
      } finally {
        restore();
      }
    });

    it("navbar and phase tabs render at tablet viewport (768×1024)", () => {
      const restore = mockViewport(VIEWPORT_TABLET.width, VIEWPORT_TABLET.height);
      try {
        const mockProject = {
          id: "proj-1",
          name: "Test",
          repoPath: "/path",
          currentPhase: "sketch" as const,
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T00:00:00Z",
        };
        renderNavbar(<Navbar project={mockProject} currentPhase="sketch" onPhaseChange={vi.fn()} />);
        expect(screen.getByRole("navigation")).toBeInTheDocument();
        expect(screen.getByRole("tab", { name: /Sketch/ })).toBeInTheDocument();
        expect(screen.getByRole("tab", { name: /Plan/ })).toBeInTheDocument();
      } finally {
        restore();
      }
    });

    it("phase navigation works at mobile viewport", async () => {
      const restore = mockViewport(VIEWPORT_MOBILE.width, VIEWPORT_MOBILE.height);
      try {
        const user = userEvent.setup();
        const onPhaseChange = vi.fn();
        const mockProject = {
          id: "proj-1",
          name: "Test",
          repoPath: "/path",
          currentPhase: "sketch" as const,
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T00:00:00Z",
        };
        renderNavbar(
          <Navbar project={mockProject} currentPhase="sketch" onPhaseChange={onPhaseChange} />
        );
        await user.click(screen.getByRole("tab", { name: /Plan/ }));
        expect(onPhaseChange).toHaveBeenCalledWith("plan");
      } finally {
        restore();
      }
    });
  });

  it("phase tabs use NavButton with ~36px height", () => {
    const mockProject = {
      id: "proj-1",
      name: "Test",
      repoPath: "/path",
      currentPhase: "sketch" as const,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    renderNavbar(<Navbar project={mockProject} currentPhase="sketch" onPhaseChange={vi.fn()} />);
    const sketchTab = screen.getByRole("tab", { name: /Sketch/ });
    expect(sketchTab).toHaveClass("min-h-[36px]");
  });

  it("phase tabs support arrow key navigation", async () => {
    const mockProject = {
      id: "proj-1",
      name: "Test",
      repoPath: "/path",
      currentPhase: "sketch" as const,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    const onPhaseChange = vi.fn();
    renderNavbar(
      <Navbar project={mockProject} currentPhase="sketch" onPhaseChange={onPhaseChange} />
    );
    const planTab = screen.getByRole("tab", { name: /Plan/ });
    planTab.focus();
    const user = userEvent.setup();
    await user.keyboard("{ArrowRight}");
    expect(onPhaseChange).toHaveBeenCalledWith("execute");
  });

  it("has z-[60] so dropdowns appear above Build sidebar (z-50)", () => {
    renderNavbar(<Navbar project={null} />);

    const nav = screen.getByRole("navigation");
    expect(nav).toHaveClass("z-[60]");
  });

  it("renders bottom border overlay for continuous line across full navbar width", () => {
    const mockProject = {
      id: "proj-1",
      name: "Test",
      repoPath: "/path",
      currentPhase: "sketch" as const,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    renderNavbar(<Navbar project={mockProject} currentPhase="sketch" onPhaseChange={vi.fn()} />);
    const border = screen.getByTestId("navbar-bottom-border");
    expect(border).toBeInTheDocument();
    expect(border).toHaveClass(
      "absolute",
      "bottom-0",
      "left-0",
      "right-0",
      "bg-theme-border",
      "z-10"
    );
    expect(border).toHaveAttribute("aria-hidden", "true");
  });

  it("renders bottom border overlay on homepage (no phase tabs)", () => {
    renderNavbar(<Navbar project={null} />);
    const border = screen.getByTestId("navbar-bottom-border");
    expect(border).toBeInTheDocument();
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

    expect(screen.getByRole("tab", { name: /Execute/ })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /⚠️ Execute/ })).not.toBeInTheDocument();
  });

  it("shows Execute tab with unread dot when blocked task count > 0 and not on Execute phase", () => {
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

    const executeTab = screen.getByRole("tab", { name: "Execute has blocked tasks" });
    expect(executeTab).toHaveTextContent("Execute");
    expect(executeTab.querySelector("[data-testid=nav-button-unread-dot]")).toBeInTheDocument();
  });

  it("shows Execute tab without unread dot when on Execute phase (cleared on enter)", () => {
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

    const executeTab = screen.getByRole("tab", { name: /Switch to Execute phase/ });
    expect(executeTab).toHaveTextContent("Execute");
    expect(executeTab.querySelector("[data-testid=nav-button-unread-dot]")).not.toBeInTheDocument();
  });

  it("clears Execute unread when on Execute phase (effect clears preloaded unread)", () => {
    const mockProject = {
      id: "proj-1",
      name: "Test",
      repoPath: "/path",
      currentPhase: "execute" as const,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    const store = createStore([{ ...baseTask, id: "epic-1.1", kanbanColumn: "blocked" } as Task], {
      unreadPhase: { "proj-1": { execute: true } },
    });
    renderNavbar(
      <Navbar project={mockProject} currentPhase="execute" onPhaseChange={vi.fn()} />,
      store
    );
    expect(screen.getByRole("tab", { name: /Switch to Execute phase/ }).querySelector("[data-testid=nav-button-unread-dot]")).not.toBeInTheDocument();
  });

  it("clears Execute unread when blocked count is 0 (effect clears even when not on Execute)", () => {
    const mockProject = {
      id: "proj-1",
      name: "Test",
      repoPath: "/path",
      currentPhase: "sketch" as const,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    const store = createStore([{ ...baseTask, id: "epic-1.1", kanbanColumn: "ready" } as Task], {
      unreadPhase: { "proj-1": { execute: true } },
    });
    renderNavbar(
      <Navbar project={mockProject} currentPhase="sketch" onPhaseChange={vi.fn()} />,
      store
    );
    expect(screen.getByRole("tab", { name: /Switch to Execute phase/ }).querySelector("[data-testid=nav-button-unread-dot]")).not.toBeInTheDocument();
  });

  it("shows Plan tab with unread dot when phaseUnread.plan is true for current project", () => {
    const mockProject = {
      id: "proj-1",
      name: "Test",
      repoPath: "/path",
      currentPhase: "sketch" as const,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    const store = createStore([], {
      unreadPhase: { "proj-1": { plan: true } },
    });
    renderNavbar(
      <Navbar project={mockProject} currentPhase="sketch" onPhaseChange={vi.fn()} />,
      store
    );

    const planTab = screen.getByRole("tab", { name: "Plan has updates" });
    expect(planTab).toHaveTextContent("Plan");
    expect(planTab.querySelector("[data-testid=nav-button-unread-dot]")).toBeInTheDocument();
  });

  it("shows Sketch tab with unread dot when phaseUnread.sketch is true for current project", () => {
    const mockProject = {
      id: "proj-1",
      name: "Test",
      repoPath: "/path",
      currentPhase: "plan" as const,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    const store = createStore([], {
      unreadPhase: { "proj-1": { sketch: true } },
    });
    renderNavbar(
      <Navbar project={mockProject} currentPhase="plan" onPhaseChange={vi.fn()} />,
      store
    );

    const sketchTab = screen.getByRole("tab", { name: "Sketch has updates" });
    expect(sketchTab).toHaveTextContent("Sketch");
    expect(sketchTab.querySelector("[data-testid=nav-button-unread-dot]")).toBeInTheDocument();
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
      expect(screen.getByRole("tab", { name: /Sketch/ })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /Plan/ })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /Execute/ })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /Evaluate/ })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /Deliver/ })).toBeInTheDocument();
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

  it("shows Help and Settings in nav when running in Electron (matches web behavior)", async () => {
    const prev = (typeof window !== "undefined" && (window as unknown as { electron?: unknown }).electron);
    if (typeof window !== "undefined") (window as unknown as { electron: { isElectron: true } }).electron = { isElectron: true };
    mockProjectsList.mockResolvedValue([
      {
        id: "proj-1",
        name: "Project A",
        repoPath: "/path/a",
        currentPhase: "sketch" as const,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      },
    ]);
    renderNavbar(
      <Navbar
        project={{
          id: "proj-1",
          name: "Project A",
          repoPath: "/path/a",
          currentPhase: "sketch",
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T00:00:00Z",
        }}
        currentPhase="sketch"
        onPhaseChange={vi.fn()}
      />
    );
    await waitFor(() => {
      expect(screen.getByRole("tablist", { name: "Phase navigation" })).toBeInTheDocument();
    });
    expect(screen.getByRole("link", { name: "Help" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Project settings" })).toBeInTheDocument();
    if (typeof window !== "undefined") {
      if (prev !== undefined) (window as unknown as { electron: unknown }).electron = prev;
      else delete (window as unknown as { electron?: unknown }).electron;
    }
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

  it("navigates to /onboarding?intended=/projects/create-new when Create New Project clicked and no API keys", async () => {
    mockProjectsList.mockResolvedValue([]);
    mockGetGlobalStatus.mockResolvedValue({ hasAnyKey: false, useCustomCli: false });
    const user = userEvent.setup();
    const { OnboardingPage } = await import("../../pages/OnboardingPage");
    render(
      <ThemeProvider>
        <DisplayPreferencesProvider>
          <Provider store={createStore()}>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter initialEntries={["/"]}>
                <Routes>
                  <Route path="/" element={<Navbar project={null} />} />
                  <Route path="/onboarding" element={<OnboardingPage />} />
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

    expect(await screen.findByTestId("onboarding-page")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-intended")).toHaveTextContent(
      /\/projects\/create-new/
    );
  });

  it("navigates to /onboarding?intended=/projects/add-existing when Add Existing Project clicked and no API keys", async () => {
    mockProjectsList.mockResolvedValue([]);
    mockGetGlobalStatus.mockResolvedValue({ hasAnyKey: false, useCustomCli: false });
    const user = userEvent.setup();
    const { OnboardingPage } = await import("../../pages/OnboardingPage");
    render(
      <ThemeProvider>
        <DisplayPreferencesProvider>
          <Provider store={createStore()}>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter initialEntries={["/"]}>
                <Routes>
                  <Route path="/" element={<Navbar project={null} />} />
                  <Route path="/onboarding" element={<OnboardingPage />} />
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

    expect(await screen.findByTestId("onboarding-page")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-intended")).toHaveTextContent(
      /\/projects\/add-existing/
    );
  });

  it("when useCustomCli true, Create New Project navigates to /projects/create-new", async () => {
    mockProjectsList.mockResolvedValue([]);
    mockGetGlobalStatus.mockResolvedValue({ hasAnyKey: false, useCustomCli: true });
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <DisplayPreferencesProvider>
          <Provider store={createStore()}>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter initialEntries={["/"]}>
                <Routes>
                  <Route path="/" element={<Navbar project={null} />} />
                  <Route path="/projects/create-new" element={<div data-testid="create-new-page">Create New</div>} />
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
    expect(await screen.findByTestId("create-new-page")).toBeInTheDocument();
  });

  it("when useCustomCli true, Add Existing Project navigates to /projects/add-existing", async () => {
    mockProjectsList.mockResolvedValue([]);
    mockGetGlobalStatus.mockResolvedValue({ hasAnyKey: false, useCustomCli: true });
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <DisplayPreferencesProvider>
          <Provider store={createStore()}>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter initialEntries={["/"]}>
                <Routes>
                  <Route path="/" element={<Navbar project={null} />} />
                  <Route path="/projects/add-existing" element={<div data-testid="add-existing-page">Add Existing</div>} />
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
    expect(await screen.findByTestId("add-existing-page")).toBeInTheDocument();
  });

  it("on global-status error navigates to route (fallback)", async () => {
    mockGetGlobalStatus.mockRejectedValue(new Error("network error"));
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <DisplayPreferencesProvider>
          <Provider store={createStore()}>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter initialEntries={["/"]}>
                <Routes>
                  <Route path="/" element={<Navbar project={null} />} />
                  <Route path="/projects/create-new" element={<div data-testid="create-new-page">Create New</div>} />
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
    expect(await screen.findByTestId("create-new-page")).toBeInTheDocument();
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
    expect(settingsLink).toHaveAttribute("data-active", "true");
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
    const sketchTab = screen.getByRole("tab", { name: /Sketch/ });
    expect(settingsLink).toHaveAttribute("data-active", "true");
    expect(sketchTab).toHaveAttribute("data-active", "false");
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
    const sketchTab = screen.getByRole("tab", { name: /Sketch/ });
    expect(helpLink).toHaveAttribute("data-active", "true");
    expect(sketchTab).toHaveAttribute("data-active", "false");
  });

  it("Help button displays as square when active (aspect-square)", async () => {
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
    expect(helpLink).toHaveClass("aspect-square");
  });

  describe("agent dropdown visibility when offline", () => {
    const mockProject = {
      id: "proj-1",
      name: "Test",
      repoPath: "/path",
      currentPhase: "sketch" as const,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    const projects = [mockProject];

    it("shows agent dropdown when online (websocket connected)", async () => {
      mockProjectsList.mockResolvedValue(projects);
      const store = createStore([], {
        websocket: { connected: true, deliverToast: null },
      });
      renderNavbar(
        <Navbar project={mockProject} currentPhase="sketch" onPhaseChange={vi.fn()} />,
        store
      );

      await waitFor(() => {
        expect(screen.getByTitle("Active agents")).toBeInTheDocument();
      });
    });

    it("hides agent dropdown when offline (offline indicator shown)", async () => {
      vi.useFakeTimers();
      try {
        mockProjectsList.mockResolvedValue(projects);
        const store = createStore([], {
          websocket: { connected: false, deliverToast: null },
        });
        renderNavbar(
          <Navbar project={mockProject} currentPhase="sketch" onPhaseChange={vi.fn()} />,
          store
        );

        // useIsOffline debounces 600ms; advance timers so offline state is shown
        await act(async () => {
          await vi.advanceTimersByTimeAsync(700);
        });

        expect(screen.queryByTitle("Active agents")).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it("shows offline indicator when offline", async () => {
      vi.useFakeTimers();
      try {
        mockProjectsList.mockResolvedValue(projects);
        const store = createStore([], {
          websocket: { connected: false, deliverToast: null },
        });
        renderNavbar(
          <Navbar project={mockProject} currentPhase="sketch" onPhaseChange={vi.fn()} />,
          store
        );

        await act(async () => {
          await vi.advanceTimersByTimeAsync(700);
        });

        expect(screen.getByText("Offline")).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
