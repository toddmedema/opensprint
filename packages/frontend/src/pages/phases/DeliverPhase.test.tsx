// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DeliverPhase } from "./DeliverPhase";
import deliverReducer from "../../store/slices/deliverSlice";
import projectReducer from "../../store/slices/projectSlice";
import { MOBILE_BREAKPOINT } from "../../lib/constants";

const {
  mockGetSettings,
  mockDeliverHistory,
  mockDeliverStatus,
  mockExpoDeploy,
  mockDeliverDeploy,
  mockExpoReadiness,
} = vi.hoisted(() => ({
  mockGetSettings: vi.fn().mockResolvedValue({
    deployment: {
      mode: "custom",
      targets: [{ name: "production", command: "echo deploy", isDefault: true }],
    },
  }),
  mockDeliverHistory: vi.fn().mockResolvedValue([]),
  mockDeliverStatus: vi.fn().mockResolvedValue({ activeDeployId: null, currentDeploy: null }),
  mockExpoDeploy: vi.fn().mockResolvedValue({ deployId: "expo-1" }),
  mockDeliverDeploy: vi.fn().mockResolvedValue({ deployId: "d1" }),
  mockExpoReadiness: vi.fn().mockResolvedValue({
    expoInstalled: true,
    expoConfigured: true,
    authOk: true,
    easProjectLinked: true,
    missing: [],
  }),
}));

vi.mock("../../api/client", () => ({
  api: {
    projects: {
      getSettings: (...args: unknown[]) => mockGetSettings(...args),
      get: vi.fn().mockResolvedValue({}),
    },
    deliver: {
      status: (...args: unknown[]) => mockDeliverStatus(...args),
      history: (...args: unknown[]) => mockDeliverHistory(...args),
      expoReadiness: (...args: unknown[]) => mockExpoReadiness(...args),
      deploy: (...args: unknown[]) => mockDeliverDeploy(...args),
      expoDeploy: (...args: unknown[]) => mockExpoDeploy(...args),
      rollback: vi.fn().mockResolvedValue({}),
      updateSettings: vi.fn().mockResolvedValue({}),
      cancel: vi.fn().mockResolvedValue({ cleared: true }),
    },
  },
}));

function createStore(initialDeployState = {}) {
  return configureStore({
    reducer: {
      deliver: deliverReducer,
      project: projectReducer,
    },
    preloadedState: {
      deliver: {
        history: [],
        currentDeploy: null,
        activeDeployId: null,
        selectedDeployId: null,
        liveLog: [],
        statusInFlightCount: 0,
        historyInFlightCount: 0,
        async: {
          status: { loading: false, error: null },
          history: { loading: false, error: null },
          trigger: { loading: false, error: null },
          expoDeploy: { loading: false, error: null },
          rollback: { loading: false, error: null },
          settings: { loading: false, error: null },
        },
        error: null,
        ...initialDeployState,
      },
    },
  });
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function renderWithRouter(
  store: ReturnType<typeof createStore>,
  projectId = "proj-1",
  onOpenSettings?: () => void
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>
        <MemoryRouter initialEntries={[`/projects/${projectId}/deliver`]}>
          <Routes>
            <Route
              path="/projects/:projectId/deliver"
              element={<DeliverPhase projectId={projectId} onOpenSettings={onOpenSettings} />}
            />
          </Routes>
        </MemoryRouter>
      </Provider>
    </QueryClientProvider>
  );
}

describe("DeliverPhase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockResolvedValue({
      deployment: {
        mode: "custom",
        targets: [{ name: "production", command: "echo deploy", isDefault: true }],
      },
    });
  });

  it("renders Deploy to [Target] buttons when targets configured", async () => {
    const store = createStore();
    renderWithRouter(store);
    const btn = await screen.findByTestId("deploy-to-production-button");
    expect(btn).toHaveTextContent("Deploy to production");
  });

  it("renders deployment history section", () => {
    const store = createStore();
    renderWithRouter(store);
    expect(screen.getByText("Delivery History")).toBeInTheDocument();
  });

  it("shows empty state when no deliveries", async () => {
    const store = createStore();
    renderWithRouter(store);
    expect(await screen.findByText(/No deliveries yet/)).toBeInTheDocument();
  });

  it("renders live log panel", () => {
    const store = createStore();
    renderWithRouter(store);
    expect(screen.getByTestId("deploy-log")).toBeInTheDocument();
  });

  it("renders resizable delivery history sidebar with resize handle", () => {
    const store = createStore();
    renderWithRouter(store);
    expect(
      screen.getByRole("slider", { name: "Resize delivery history sidebar" })
    ).toBeInTheDocument();
  });

  it("persists delivery history sidebar width to localStorage when resized (matches Plan/Sketch/Execute)", async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    const store = createStore();
    renderWithRouter(store);
    const handle = screen.getByRole("slider", {
      name: "Resize delivery history sidebar",
    });
    handle.dispatchEvent(new MouseEvent("mousedown", { clientX: 100, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 150, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(setItemSpy).toHaveBeenCalledWith("opensprint-sidebar-width-deliver", expect.any(String));
    setItemSpy.mockRestore();
  });

  it("renders rolled_back status badge", async () => {
    const rolledBackRecord = {
      id: "deploy-1",
      projectId: "proj-1",
      status: "rolled_back",
      startedAt: "2025-01-01T12:00:00.000Z",
      completedAt: "2025-01-01T12:01:00.000Z",
      log: [],
      rolledBackBy: "deploy-2",
    };
    mockDeliverHistory.mockResolvedValue([rolledBackRecord]);
    const store = createStore({ history: [rolledBackRecord] });
    renderWithRouter(store);
    await waitFor(() => {
      expect(screen.getByText("rolled-back")).toBeInTheDocument();
    });
  });

  it("shows fix epic link when deployment failed with fixEpicId", () => {
    const store = createStore({
      history: [
        {
          id: "deploy-1",
          projectId: "proj-1",
          status: "failed",
          startedAt: "2025-01-01T12:00:00.000Z",
          completedAt: "2025-01-01T12:01:00.000Z",
          log: [],
          error: "2 test(s) failed",
          fixEpicId: "bd-abc123",
        },
      ],
    });
    renderWithRouter(store);
    expect(screen.getByTestId("fix-epic-link")).toBeInTheDocument();
    expect(screen.getByTestId("fix-epic-link")).toHaveTextContent(/View fix epic \(bd-abc123\)/);
  });

  it("shows Deploy to [Target] buttons when targets are configured (PRD §7.5.4)", async () => {
    mockGetSettings.mockResolvedValueOnce({
      deployment: {
        mode: "custom",
        targets: [
          { name: "staging", command: "echo staging", isDefault: true },
          { name: "production", webhookUrl: "https://example.com/deploy" },
        ],
      },
    });
    const store = createStore();
    renderWithRouter(store);

    const stagingBtn = await screen.findByTestId("deploy-to-staging-button");
    const prodBtn = screen.getByTestId("deploy-to-production-button");
    expect(stagingBtn).toHaveTextContent("Deploy to staging");
    expect(prodBtn).toHaveTextContent("Deploy to production");
    expect(stagingBtn).toHaveClass("btn-primary");
    expect(prodBtn).toHaveClass("btn-secondary");
  });

  it("never shows environment display (Expo or Custom text)", async () => {
    mockGetSettings.mockResolvedValueOnce({
      deployment: { mode: "expo" },
    });
    const store = createStore();
    renderWithRouter(store);
    await waitFor(() => expect(mockGetSettings).toHaveBeenCalled());
    expect(screen.queryByText(/Environment:/)).not.toBeInTheDocument();
    expect(screen.queryByText("Expo")).not.toBeInTheDocument();
  });

  it("never shows environment display for custom mode without targets", async () => {
    mockGetSettings.mockResolvedValueOnce({
      deployment: { mode: "custom", customCommand: "echo deploy" },
    });
    const store = createStore();
    renderWithRouter(store);
    await waitFor(() => expect(mockGetSettings).toHaveBeenCalled());
    expect(screen.queryByText(/Environment:/)).not.toBeInTheDocument();
  });

  it("shows Configure Targets link on right when custom mode, no targets, and onOpenSettings provided", async () => {
    const onOpenSettings = vi.fn();
    mockGetSettings.mockResolvedValueOnce({
      deployment: { mode: "custom" },
    });
    const store = createStore();
    renderWithRouter(store, "proj-1", onOpenSettings);
    const configureBtn = await screen.findByTestId("deliver-configure-targets-link");
    expect(configureBtn).toBeInTheDocument();
    expect(configureBtn).toHaveTextContent("Configure Targets");
    const topBar = screen.getByTestId("deliver-top-bar");
    expect(topBar).toContainElement(configureBtn);
  });

  it("hides Configure Targets when expo mode even with onOpenSettings", async () => {
    mockGetSettings.mockResolvedValueOnce({
      deployment: { mode: "expo" },
    });
    const store = createStore();
    renderWithRouter(store, "proj-1", () => {});
    await waitFor(() => expect(mockGetSettings).toHaveBeenCalled());
    expect(screen.queryByTestId("deliver-configure-targets-link")).not.toBeInTheDocument();
  });

  it("shows Expo auth banner above deploy buttons when mode is expo and readiness.authOk is false", async () => {
    mockGetSettings.mockResolvedValueOnce({
      deployment: { mode: "expo" },
    });
    mockExpoReadiness.mockResolvedValueOnce({
      expoInstalled: true,
      expoConfigured: true,
      authOk: false,
      easProjectLinked: true,
      missing: ["auth"],
    });
    const onOpenSettings = vi.fn();
    const store = createStore();
    renderWithRouter(store, "proj-1", onOpenSettings);
    const banner = await screen.findByTestId("expo-readiness-auth-banner");
    expect(banner).toHaveTextContent(
      "Expo deployment requires an access token. Add it in Settings → Expo API Token."
    );
    const openSettingsBtn = screen.getByTestId("expo-readiness-open-settings");
    expect(openSettingsBtn).toHaveTextContent("Open Settings");
    fireEvent.click(openSettingsBtn);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("does not show Expo auth banner when mode is expo but readiness.authOk is true", async () => {
    queryClient.clear();
    mockGetSettings.mockResolvedValueOnce({
      deployment: { mode: "expo" },
    });
    mockExpoReadiness.mockResolvedValueOnce({
      expoInstalled: true,
      expoConfigured: true,
      authOk: true,
      easProjectLinked: true,
      missing: [],
    });
    const store = createStore();
    renderWithRouter(store, "proj-1");
    await screen.findByTestId("deploy-beta-button");
    expect(screen.queryByTestId("expo-readiness-auth-banner")).not.toBeInTheDocument();
  });

  it("shows Ready to deploy indicator when Expo mode and all readiness checks true", async () => {
    mockGetSettings.mockResolvedValueOnce({
      deployment: { mode: "expo" },
    });
    mockExpoReadiness.mockResolvedValueOnce({
      expoInstalled: true,
      expoConfigured: true,
      authOk: true,
      easProjectLinked: true,
      missing: [],
    });
    const store = createStore();
    renderWithRouter(store);
    const indicator = await screen.findByTestId("expo-ready-indicator");
    expect(indicator).toHaveTextContent("Ready to deploy");
    expect(screen.getByTestId("expo-setup-status")).toContainElement(indicator);
  });

  it("shows Setup required when Expo mode and any readiness check false (e.g. easProjectLinked)", async () => {
    mockGetSettings.mockResolvedValueOnce({
      deployment: { mode: "expo" },
    });
    mockExpoReadiness.mockResolvedValueOnce({
      expoInstalled: true,
      expoConfigured: true,
      authOk: true,
      easProjectLinked: false,
      missing: ["easProjectLinked"],
    });
    const store = createStore();
    renderWithRouter(store);
    const setupRequired = await screen.findByTestId("expo-setup-required");
    expect(setupRequired).toHaveTextContent("Setup required");
  });

  it("shows Setup required when Expo mode and expoConfigured false", async () => {
    mockGetSettings.mockResolvedValueOnce({
      deployment: { mode: "expo" },
    });
    mockExpoReadiness.mockResolvedValueOnce({
      expoInstalled: true,
      expoConfigured: false,
      authOk: true,
      easProjectLinked: true,
      missing: ["expoConfigured"],
    });
    const store = createStore();
    renderWithRouter(store);
    expect(await screen.findByTestId("expo-setup-required")).toHaveTextContent("Setup required");
  });

  it("does not show Ready to deploy when authOk is false (shows auth banner instead)", async () => {
    mockGetSettings.mockResolvedValueOnce({
      deployment: { mode: "expo" },
    });
    mockExpoReadiness.mockResolvedValueOnce({
      expoInstalled: true,
      expoConfigured: true,
      authOk: false,
      easProjectLinked: true,
      missing: ["auth"],
    });
    const store = createStore();
    renderWithRouter(store);
    await screen.findByTestId("expo-readiness-auth-banner");
    expect(screen.queryByTestId("expo-ready-indicator")).not.toBeInTheDocument();
    expect(screen.queryByTestId("expo-setup-required")).not.toBeInTheDocument();
  });

  it("shows Setting up Expo… during deploy when expoInstalled or expoConfigured false", async () => {
    mockGetSettings.mockResolvedValueOnce({
      deployment: { mode: "expo" },
    });
    mockExpoReadiness.mockResolvedValueOnce({
      expoInstalled: false,
      expoConfigured: false,
      authOk: true,
      easProjectLinked: true,
      missing: ["expoInstalled", "expoConfigured"],
    });
    const store = createStore({
      activeDeployId: "deploy-1",
      history: [
        {
          id: "deploy-1",
          projectId: "proj-1",
          status: "running",
          startedAt: new Date().toISOString(),
          completedAt: null,
          log: [],
        },
      ],
    });
    renderWithRouter(store);
    await waitFor(() => {
      expect(screen.getByTestId("expo-setting-up")).toHaveTextContent("Setting up Expo…");
    });
  });

  it("does not show expo setup status block when mode is not expo", async () => {
    mockGetSettings.mockResolvedValueOnce({
      deployment: {
        mode: "custom",
        targets: [{ name: "production", command: "echo deploy", isDefault: true }],
      },
    });
    const store = createStore();
    renderWithRouter(store);
    await screen.findByTestId("deploy-to-production-button");
    expect(screen.queryByTestId("expo-setup-status")).not.toBeInTheDocument();
    expect(screen.queryByTestId("expo-ready-indicator")).not.toBeInTheDocument();
  });

  it("positions Deploy buttons on right side of top bar (Expo mode)", async () => {
    mockGetSettings.mockResolvedValueOnce({
      deployment: { mode: "expo" },
    });
    const store = createStore();
    renderWithRouter(store);
    const betaBtn = await screen.findByTestId("deploy-beta-button");
    const prodBtn = await screen.findByTestId("deploy-prod-button");
    const topBar = screen.getByTestId("deliver-top-bar");
    expect(topBar).toContainElement(betaBtn);
    expect(topBar).toContainElement(prodBtn);
  });

  it("positions Deploy to [Target] buttons on right side of top bar (custom mode)", async () => {
    mockGetSettings.mockResolvedValueOnce({
      deployment: {
        mode: "custom",
        targets: [{ name: "production", command: "echo deploy", isDefault: true }],
      },
    });
    const store = createStore();
    renderWithRouter(store);
    const deployBtn = await screen.findByTestId("deploy-to-production-button");
    const topBar = screen.getByTestId("deliver-top-bar");
    expect(topBar).toContainElement(deployBtn);
  });

  it("shows Deploy to Staging (secondary) left of Deploy to Production (primary) when Expo mode", async () => {
    mockGetSettings.mockResolvedValueOnce({
      deployment: { mode: "expo" },
    });
    const store = createStore();
    renderWithRouter(store);
    const betaBtn = await screen.findByTestId("deploy-beta-button");
    const prodBtn = await screen.findByTestId("deploy-prod-button");
    expect(betaBtn).toBeInTheDocument();
    expect(betaBtn).toHaveTextContent("Deploy to Staging");
    expect(betaBtn).toHaveClass("btn-secondary");
    expect(prodBtn).toBeInTheDocument();
    expect(prodBtn).toHaveTextContent("Deploy to Production");
    expect(prodBtn).toHaveClass("btn-primary");
    const container = betaBtn.parentElement!;
    const buttons = Array.from(container.querySelectorAll("button"));
    const betaIdx = buttons.findIndex((b) => b === betaBtn);
    const prodIdx = buttons.findIndex((b) => b === prodBtn);
    expect(betaIdx).toBeLessThan(prodIdx);
  });

  it("shows Deploy to [Target] buttons when custom mode with targets (not Expo buttons)", async () => {
    mockGetSettings.mockResolvedValueOnce({
      deployment: {
        mode: "custom",
        targets: [{ name: "production", command: "echo deploy", isDefault: true }],
      },
    });
    const store = createStore();
    renderWithRouter(store);
    const deployBtn = await screen.findByTestId("deploy-to-production-button");
    expect(screen.queryByTestId("deploy-prod-button")).not.toBeInTheDocument();
    expect(deployBtn).toHaveTextContent("Deploy to production");
  });

  it("Deploy to Staging calls expoDeploy with variant beta", async () => {
    mockGetSettings.mockResolvedValueOnce({ deployment: { mode: "expo" } });
    const store = createStore();
    renderWithRouter(store);
    const betaBtn = await screen.findByTestId("deploy-beta-button");
    betaBtn.click();
    await waitFor(() => expect(mockExpoDeploy).toHaveBeenCalledWith("proj-1", "beta"));
  });

  it("Deploy to Production calls expoDeploy with variant prod", async () => {
    mockGetSettings.mockResolvedValueOnce({ deployment: { mode: "expo" } });
    const store = createStore();
    renderWithRouter(store);
    const prodBtn = await screen.findByTestId("deploy-prod-button");
    prodBtn.click();
    await waitFor(() => expect(mockExpoDeploy).toHaveBeenCalledWith("proj-1", "prod"));
  });

  it("Deploy to [target] calls deploy with target", async () => {
    mockGetSettings.mockResolvedValueOnce({
      deployment: {
        mode: "custom",
        targets: [
          { name: "staging", command: "echo staging", isDefault: false },
          { name: "production", command: "echo prod", isDefault: true },
        ],
      },
    });
    const store = createStore();
    renderWithRouter(store);
    const prodBtn = await screen.findByTestId("deploy-to-production-button");
    prodBtn.click();
    await waitFor(() => expect(mockDeliverDeploy).toHaveBeenCalledWith("proj-1", "production"));
  });

  it("shows Cancel Deployment button when deploying", async () => {
    mockGetSettings.mockResolvedValueOnce({
      deployment: {
        mode: "custom",
        targets: [{ name: "production", command: "echo deploy", isDefault: true }],
      },
    });
    const store = createStore({
      activeDeployId: "deploy-1",
      history: [
        {
          id: "deploy-1",
          projectId: "proj-1",
          status: "running",
          startedAt: new Date().toISOString(),
          completedAt: null,
          log: [],
        },
      ],
    });
    renderWithRouter(store);
    await waitFor(() => expect(mockGetSettings).toHaveBeenCalled());
    const cancelBtn = screen.getByTestId("cancel-deployment-button");
    expect(cancelBtn).toHaveTextContent("Cancel Deployment");
  });

  it("Cancel Deployment is on right side of top bar, directly left of deploy spinner", async () => {
    mockGetSettings.mockResolvedValueOnce({
      deployment: {
        mode: "custom",
        targets: [{ name: "production", command: "echo deploy", isDefault: true }],
      },
    });
    const store = createStore({
      activeDeployId: "deploy-1",
      history: [
        {
          id: "deploy-1",
          projectId: "proj-1",
          status: "running",
          startedAt: new Date().toISOString(),
          completedAt: null,
          log: [],
        },
      ],
    });
    renderWithRouter(store);
    await waitFor(() => expect(mockGetSettings).toHaveBeenCalled());
    const cancelBtn = screen.getByTestId("cancel-deployment-button");
    const spinner = screen.getByTestId("deploy-spinner");
    const topBar = screen.getByTestId("deliver-top-bar");
    expect(topBar).toContainElement(cancelBtn);
    expect(topBar).toContainElement(spinner);
    const ordered = Array.from(
      topBar.querySelectorAll(
        '[data-testid="cancel-deployment-button"], [data-testid="deploy-spinner"]'
      )
    );
    expect(ordered[0]).toBe(cancelBtn);
    expect(ordered[1]).toBe(spinner);
  });

  it("hides deploy buttons and shows spinner during deployment (Expo mode)", async () => {
    mockGetSettings.mockResolvedValueOnce({
      deployment: { mode: "expo" },
    });
    const store = createStore({
      activeDeployId: "deploy-1",
      history: [
        {
          id: "deploy-1",
          projectId: "proj-1",
          status: "running",
          startedAt: new Date().toISOString(),
          completedAt: null,
          log: [],
        },
      ],
    });
    renderWithRouter(store);
    await waitFor(() => expect(mockGetSettings).toHaveBeenCalled());
    expect(screen.queryByTestId("deploy-beta-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("deploy-prod-button")).not.toBeInTheDocument();
    expect(screen.getByTestId("deploy-spinner")).toBeInTheDocument();
    expect(screen.getByTestId("cancel-deployment-button")).toBeInTheDocument();
  });

  it("hides deploy buttons and shows spinner during deployment (custom mode)", async () => {
    mockGetSettings.mockResolvedValueOnce({
      deployment: {
        mode: "custom",
        targets: [{ name: "production", command: "echo deploy", isDefault: true }],
      },
    });
    const store = createStore({
      activeDeployId: "deploy-1",
      history: [
        {
          id: "deploy-1",
          projectId: "proj-1",
          status: "running",
          startedAt: new Date().toISOString(),
          completedAt: null,
          log: [],
        },
      ],
    });
    renderWithRouter(store);
    await waitFor(() => expect(mockGetSettings).toHaveBeenCalled());
    expect(screen.queryByTestId("deploy-to-production-button")).not.toBeInTheDocument();
    expect(screen.getByTestId("deploy-spinner")).toBeInTheDocument();
    expect(screen.getByTestId("cancel-deployment-button")).toBeInTheDocument();
  });

  it("shows deploy buttons after deployment completes (Expo mode)", async () => {
    mockGetSettings.mockResolvedValueOnce({
      deployment: { mode: "expo" },
    });
    const store = createStore({
      activeDeployId: null,
      history: [
        {
          id: "deploy-1",
          projectId: "proj-1",
          status: "success",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          log: [],
        },
      ],
    });
    renderWithRouter(store);
    await waitFor(() => expect(mockGetSettings).toHaveBeenCalled());
    expect(screen.getByTestId("deploy-beta-button")).toBeInTheDocument();
    expect(screen.getByTestId("deploy-prod-button")).toBeInTheDocument();
    expect(screen.queryByTestId("deploy-spinner")).not.toBeInTheDocument();
  });

  it("hides Configure Targets when onOpenSettings not provided (custom mode, no targets)", async () => {
    mockGetSettings.mockResolvedValueOnce({
      deployment: { mode: "custom" },
    });
    const store = createStore();
    renderWithRouter(store);
    await waitFor(() => expect(mockGetSettings).toHaveBeenCalled());
    expect(screen.queryByTestId("deliver-configure-targets-link")).not.toBeInTheDocument();
  });

  describe("Delivery History environment chip and filter", () => {
    it("shows environment chip on each deployment row", async () => {
      const history = [
        {
          id: "deploy-1",
          projectId: "proj-1",
          status: "success",
          startedAt: "2025-01-01T12:00:00.000Z",
          completedAt: "2025-01-01T12:01:00.000Z",
          log: [],
          target: "staging",
        },
        {
          id: "deploy-2",
          projectId: "proj-1",
          status: "success",
          startedAt: "2025-01-01T13:00:00.000Z",
          completedAt: "2025-01-01T13:01:00.000Z",
          log: [],
          target: "production",
        },
      ];
      mockDeliverHistory.mockResolvedValue(history);
      const store = createStore({ history });
      renderWithRouter(store);
      await waitFor(() => expect(screen.getByText("Staging")).toBeInTheDocument());
      expect(screen.getByText("Production")).toBeInTheDocument();
    });

    it("shows filter icon when history has deployments", async () => {
      const history = [
        {
          id: "deploy-1",
          projectId: "proj-1",
          status: "success",
          startedAt: "2025-01-01T12:00:00.000Z",
          completedAt: "2025-01-01T12:01:00.000Z",
          log: [],
          target: "staging",
        },
      ];
      const store = createStore({ history });
      renderWithRouter(store);
      const filterBtn = await screen.findByTestId("delivery-history-filter-button");
      expect(filterBtn).toBeInTheDocument();
    });

    it("filter dropdown shows counts per option (All, Staging, Production)", async () => {
      const history = [
        {
          id: "deploy-1",
          projectId: "proj-1",
          status: "success",
          startedAt: "2025-01-01T12:00:00.000Z",
          completedAt: "2025-01-01T12:01:00.000Z",
          log: [],
          target: "staging",
        },
        {
          id: "deploy-2",
          projectId: "proj-1",
          status: "success",
          startedAt: "2025-01-01T13:00:00.000Z",
          completedAt: "2025-01-01T13:01:00.000Z",
          log: [],
          target: "staging",
        },
        {
          id: "deploy-3",
          projectId: "proj-1",
          status: "success",
          startedAt: "2025-01-01T14:00:00.000Z",
          completedAt: "2025-01-01T14:01:00.000Z",
          log: [],
          target: "production",
        },
      ];
      const store = createStore({ history });
      renderWithRouter(store);
      const filterBtn = await screen.findByTestId("delivery-history-filter-button");
      filterBtn.click();
      await waitFor(() => {
        expect(screen.getByTestId("delivery-history-filter-dropdown")).toBeInTheDocument();
      });
      expect(screen.getByRole("option", { name: "All (3)" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "Staging (2)" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "Production (1)" })).toBeInTheDocument();
    });

    it("filters deployments by environment when Staging selected", async () => {
      const history = [
        {
          id: "deploy-1",
          projectId: "proj-1",
          status: "success",
          startedAt: "2025-01-01T12:00:00.000Z",
          completedAt: "2025-01-01T12:01:00.000Z",
          log: [],
          target: "staging",
        },
        {
          id: "deploy-2",
          projectId: "proj-1",
          status: "success",
          startedAt: "2025-01-01T13:00:00.000Z",
          completedAt: "2025-01-01T13:01:00.000Z",
          log: [],
          target: "production",
        },
      ];
      const store = createStore({ history });
      renderWithRouter(store);
      const filterBtn = await screen.findByTestId("delivery-history-filter-button");
      fireEvent.click(filterBtn);
      const stagingOpt = await screen.findByRole("option", { name: "Staging (1)" });
      fireEvent.click(stagingOpt);
      await waitFor(() => {
        expect(screen.getByText("Staging")).toBeInTheDocument();
        expect(screen.queryByText("Production")).not.toBeInTheDocument();
      });
    });

    it("shows empty filter message when no deployments match", async () => {
      const history = [
        {
          id: "deploy-1",
          projectId: "proj-1",
          status: "success",
          startedAt: "2025-01-01T12:00:00.000Z",
          completedAt: "2025-01-01T12:01:00.000Z",
          log: [],
          target: "staging",
        },
      ];
      const store = createStore({ history });
      renderWithRouter(store);
      const filterBtn = await screen.findByTestId("delivery-history-filter-button");
      fireEvent.click(filterBtn);
      const prodOpt = await screen.findByRole("option", { name: "Production (0)" });
      fireEvent.click(prodOpt);
      await waitFor(() => {
        expect(screen.getByText("No deployments match this filter.")).toBeInTheDocument();
      });
    });

    it("hides filter icon when no deliveries", () => {
      const store = createStore({ history: [] });
      renderWithRouter(store);
      expect(screen.queryByTestId("delivery-history-filter-button")).not.toBeInTheDocument();
    });
  });

  describe("live log updates", () => {
    it("polls status and history every second when active deployment exists", async () => {
      vi.useFakeTimers();
      try {
        mockGetSettings.mockResolvedValue({
          deployment: {
            mode: "custom",
            targets: [{ name: "production", command: "echo deploy", isDefault: true }],
          },
        });
        mockDeliverStatus.mockResolvedValue({
          activeDeployId: "deploy-1",
          currentDeploy: null,
        });
        mockDeliverHistory.mockResolvedValue([]);
        const store = createStore({
          activeDeployId: "deploy-1",
          selectedDeployId: "deploy-1",
          liveLog: [],
          history: [
            {
              id: "deploy-1",
              projectId: "proj-1",
              status: "running",
              startedAt: new Date().toISOString(),
              completedAt: null,
              log: [],
            },
          ],
        });

        renderWithRouter(store);
        // Flush initial microtasks so effect runs
        await vi.advanceTimersByTimeAsync(0);

        const beforeStatus = mockDeliverStatus.mock.calls.length;
        const beforeHistory = mockDeliverHistory.mock.calls.length;

        // Advance 2.5 seconds — interval fires at 1s and 2s
        await vi.advanceTimersByTimeAsync(2500);

        expect(mockDeliverStatus.mock.calls.length).toBeGreaterThanOrEqual(beforeStatus + 2);
        expect(mockDeliverHistory.mock.calls.length).toBeGreaterThanOrEqual(beforeHistory + 2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("shows polled history log when liveLog is empty (e.g. after refresh)", async () => {
      mockGetSettings.mockResolvedValueOnce({
        deployment: {
          mode: "custom",
          targets: [{ name: "production", command: "echo deploy", isDefault: true }],
        },
      });
      const store = createStore({
        activeDeployId: "deploy-1",
        selectedDeployId: "deploy-1",
        liveLog: [],
        history: [
          {
            id: "deploy-1",
            projectId: "proj-1",
            status: "running",
            startedAt: new Date().toISOString(),
            completedAt: null,
            log: ["Deploying...\n", "Step 1 complete\n"],
          },
        ],
      });
      renderWithRouter(store);
      await waitFor(() => expect(mockGetSettings).toHaveBeenCalled());

      const logEl = screen.getByTestId("deploy-log");
      expect(logEl).toHaveTextContent("Deploying...");
      expect(logEl).toHaveTextContent("Step 1 complete");
    });

    it("prefers liveLog over polled history when both available", async () => {
      mockGetSettings.mockResolvedValueOnce({
        deployment: {
          mode: "custom",
          targets: [{ name: "production", command: "echo deploy", isDefault: true }],
        },
      });
      const store = createStore({
        activeDeployId: "deploy-1",
        selectedDeployId: "deploy-1",
        liveLog: ["Live chunk 1\n", "Live chunk 2\n"],
        history: [
          {
            id: "deploy-1",
            projectId: "proj-1",
            status: "running",
            startedAt: new Date().toISOString(),
            completedAt: null,
            log: ["Older polled line\n"],
          },
        ],
      });
      renderWithRouter(store);
      await waitFor(() => expect(mockGetSettings).toHaveBeenCalled());

      const logEl = screen.getByTestId("deploy-log");
      expect(logEl).toHaveTextContent("Live chunk 1");
      expect(logEl).toHaveTextContent("Live chunk 2");
      expect(logEl).not.toHaveTextContent("Older polled line");
    });
  });

  describe("mobile layout", () => {
    const history = [
      {
        id: "deploy-1",
        projectId: "proj-1",
        status: "success",
        startedAt: "2025-01-01T12:00:00.000Z",
        completedAt: "2025-01-01T12:01:00.000Z",
        log: ["Deploy step 1\n", "Deploy step 2\n"],
        target: "staging",
      },
      {
        id: "deploy-2",
        projectId: "proj-1",
        status: "success",
        startedAt: "2025-01-01T13:00:00.000Z",
        completedAt: "2025-01-01T13:01:00.000Z",
        log: ["Prod deploy\n"],
        target: "production",
      },
    ];

    it("on mobile, history is full-width; tapping a deploy opens detail overlay", async () => {
      const originalInnerWidth = window.innerWidth;
      try {
        Object.defineProperty(window, "innerWidth", {
          value: MOBILE_BREAKPOINT - 1,
          writable: true,
        });
        mockGetSettings.mockResolvedValue({
          deployment: {
            mode: "custom",
            targets: [{ name: "production", command: "echo deploy", isDefault: true }],
          },
        });
        const store = createStore({ history });
        renderWithRouter(store);
        await waitFor(() => expect(screen.getByText("Delivery History")).toBeInTheDocument());
        expect(screen.getByTestId("delivery-history-mobile-main")).toBeInTheDocument();
        expect(screen.queryByRole("slider", { name: "Resize delivery history sidebar" })).not.toBeInTheDocument();
        const deploy1Row = screen.getByText("Staging").closest("button");
        expect(deploy1Row).toBeInTheDocument();
        fireEvent.click(deploy1Row!);
        await waitFor(() => {
          const overlay = document.querySelector('[role="dialog"][aria-label="Deployment detail"]');
          expect(overlay).toBeInTheDocument();
        });
        expect(screen.getByTestId("deploy-log")).toHaveTextContent("Deploy step 1");
      } finally {
        Object.defineProperty(window, "innerWidth", {
          value: originalInnerWidth,
          writable: true,
        });
      }
    });

    it("on mobile, close button and backdrop dismiss deploy detail overlay", async () => {
      const originalInnerWidth = window.innerWidth;
      try {
        Object.defineProperty(window, "innerWidth", {
          value: MOBILE_BREAKPOINT - 1,
          writable: true,
        });
        mockGetSettings.mockResolvedValue({
          deployment: {
            mode: "custom",
            targets: [{ name: "production", command: "echo deploy", isDefault: true }],
          },
        });
        const store = createStore({
          history,
          selectedDeployId: "deploy-1",
        });
        renderWithRouter(store);
        await waitFor(() => {
          const overlay = document.querySelector('[role="dialog"][aria-label="Deployment detail"]');
          expect(overlay).toBeInTheDocument();
        });
        const closeBtn = screen.getByRole("button", { name: "Close deployment detail" });
        fireEvent.click(closeBtn);
        await waitFor(() => {
          const overlay = document.querySelector('[role="dialog"][aria-label="Deployment detail"]');
          expect(overlay).not.toBeInTheDocument();
        });
      } finally {
        Object.defineProperty(window, "innerWidth", {
          value: originalInnerWidth,
          writable: true,
        });
      }
    });

    it("top bar has responsive padding (px-4 on mobile, sm:px-6)", async () => {
      mockGetSettings.mockResolvedValue({
        deployment: {
          mode: "custom",
          targets: [{ name: "production", command: "echo deploy", isDefault: true }],
        },
      });
      const store = createStore();
      renderWithRouter(store);
      const topBar = screen.getByTestId("deliver-top-bar");
      expect(topBar).toHaveClass("px-4", "sm:px-6");
    });

    it("mobile deploy detail overlay has overflow-y-auto for scrollable content", async () => {
      const originalInnerWidth = window.innerWidth;
      try {
        Object.defineProperty(window, "innerWidth", {
          value: MOBILE_BREAKPOINT - 1,
          writable: true,
        });
        mockGetSettings.mockResolvedValue({
          deployment: {
            mode: "custom",
            targets: [{ name: "production", command: "echo deploy", isDefault: true }],
          },
        });
        const store = createStore({
          history,
          selectedDeployId: "deploy-1",
        });
        renderWithRouter(store);
        await waitFor(() => {
          const overlay = document.querySelector('[role="dialog"][aria-label="Deployment detail"]');
          expect(overlay).toBeInTheDocument();
        });
        const overlayEl = document.querySelector('[role="dialog"][aria-label="Deployment detail"]');
        const scrollable = overlayEl?.querySelector(".overflow-y-auto");
        expect(scrollable).toBeTruthy();
      } finally {
        Object.defineProperty(window, "innerWidth", {
          value: originalInnerWidth,
          writable: true,
        });
      }
    });
  });
});
