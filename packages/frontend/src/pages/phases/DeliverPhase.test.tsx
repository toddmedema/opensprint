import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { DeliverPhase } from "./DeliverPhase";
import deployReducer from "../../store/slices/deploySlice";
import projectReducer from "../../store/slices/projectSlice";

const mockGetSettings = vi.fn().mockResolvedValue({
  deployment: { mode: "custom", customCommand: "echo deploy" },
});

vi.mock("../../api/client", () => ({
  api: {
    projects: {
      getSettings: mockGetSettings,
    },
  },
}));

function createStore(initialDeployState = {}) {
  return configureStore({
    reducer: {
      deploy: deployReducer,
      project: projectReducer,
    },
    preloadedState: {
      deploy: {
        history: [],
        currentDeploy: null,
        activeDeployId: null,
        selectedDeployId: null,
        liveLog: [],
        deployLoading: false,
        statusLoading: false,
        historyLoading: false,
        rollbackLoading: false,
        settingsLoading: false,
        error: null,
        ...initialDeployState,
      },
    },
  });
}

function renderWithRouter(store: ReturnType<typeof createStore>, projectId = "proj-1") {
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[`/projects/${projectId}/deliver`]}>
        <Routes>
          <Route path="/projects/:projectId/deliver" element={<DeliverPhase projectId={projectId} />} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
}

describe("DeliverPhase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockResolvedValue({
      deployment: { mode: "custom", customCommand: "echo deploy" },
    });
  });

  it("renders Deliver! button", () => {
    const store = createStore();
    renderWithRouter(store);
    expect(screen.getByTestId("deliver-button")).toHaveTextContent("Deliver!");
  });

  it("renders deployment history section", () => {
    const store = createStore();
    renderWithRouter(store);
    expect(screen.getByText("Deployment History")).toBeInTheDocument();
  });

  it("shows empty state when no deployments", () => {
    const store = createStore();
    renderWithRouter(store);
    expect(screen.getByText(/No deployments yet\. Click Deliver! to start\./)).toBeInTheDocument();
  });

  it("renders live log panel", () => {
    const store = createStore();
    renderWithRouter(store);
    expect(screen.getByTestId("deploy-log")).toBeInTheDocument();
  });

  it("renders rolled_back status badge", () => {
    const store = createStore({
      history: [
        {
          id: "deploy-1",
          projectId: "proj-1",
          status: "rolled_back",
          startedAt: "2025-01-01T12:00:00.000Z",
          completedAt: "2025-01-01T12:01:00.000Z",
          log: [],
          rolledBackBy: "deploy-2",
        },
      ],
    });
    renderWithRouter(store);
    expect(screen.getByText("rolled-back")).toBeInTheDocument();
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

  it("shows target selector when targets are configured (PRD §7.5.4)", async () => {
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

    const selector = await screen.findByTestId("deploy-target-select");
    expect(selector).toBeInTheDocument();
    expect(selector).toHaveValue("staging");
    expect(selector).toHaveTextContent("staging (default)");
    expect(selector).toHaveTextContent("production");
  });
});
