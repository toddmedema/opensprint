import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { DeployPhase } from "./DeployPhase";
import deployReducer from "../../store/slices/deploySlice";
import projectReducer from "../../store/slices/projectSlice";

vi.mock("../../api/client", () => ({
  api: {
    projects: {
      getSettings: vi.fn().mockResolvedValue({
        deployment: { mode: "custom", customCommand: "echo deploy" },
      }),
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

describe("DeployPhase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders Deploy! button", () => {
    const store = createStore();
    render(
      <Provider store={store}>
        <DeployPhase projectId="proj-1" />
      </Provider>,
    );
    expect(screen.getByTestId("deploy-button")).toHaveTextContent("Deploy!");
  });

  it("renders deployment history section", () => {
    const store = createStore();
    render(
      <Provider store={store}>
        <DeployPhase projectId="proj-1" />
      </Provider>,
    );
    expect(screen.getByText("Deployment History")).toBeInTheDocument();
  });

  it("shows empty state when no deployments", () => {
    const store = createStore();
    render(
      <Provider store={store}>
        <DeployPhase projectId="proj-1" />
      </Provider>,
    );
    expect(screen.getByText(/No deployments yet/)).toBeInTheDocument();
  });

  it("renders live log panel", () => {
    const store = createStore();
    render(
      <Provider store={store}>
        <DeployPhase projectId="proj-1" />
      </Provider>,
    );
    expect(screen.getByTestId("deploy-log")).toBeInTheDocument();
  });
});
