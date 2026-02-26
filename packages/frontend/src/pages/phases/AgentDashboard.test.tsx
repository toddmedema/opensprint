import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { AgentDashboard } from "./AgentDashboard";
import executeReducer, { initialExecuteState } from "../../store/slices/executeSlice";

const mockBuildStatus = vi.fn().mockResolvedValue({
  running: false,
  totalDone: 0,
  totalFailed: 0,
  queueDepth: 0,
});

const mockAgentsActive = vi.fn().mockResolvedValue([]);
const mockLiveOutput = vi.fn().mockResolvedValue({ output: "" });

vi.mock("../../api/client", () => ({
  api: {
    execute: {
      status: (...args: unknown[]) => mockBuildStatus(...args),
      liveOutput: (...args: unknown[]) => mockLiveOutput(...args),
    },
    agents: {
      active: (...args: unknown[]) => mockAgentsActive(...args),
    },
  },
}));

function createStore() {
  return configureStore({
    reducer: { execute: executeReducer },
  });
}

function renderAgentDashboard() {
  return render(
    <Provider store={createStore()}>
      <AgentDashboard projectId="proj-1" />
    </Provider>
  );
}

describe("AgentDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildStatus.mockResolvedValue({
      running: false,
      totalDone: 0,
      totalFailed: 0,
      queueDepth: 0,
    });
    mockAgentsActive.mockResolvedValue([]);
    mockLiveOutput.mockResolvedValue({ output: "" });
  });

  it("renders header with title and subtitle", async () => {
    renderAgentDashboard();

    expect(screen.getByText("Agent Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Monitor and manage all agent instances")).toBeInTheDocument();

    await waitFor(() => {
      expect(mockBuildStatus).toHaveBeenCalledWith("proj-1");
    });
  });

  it("does not render redundant Connected text in top bar", async () => {
    renderAgentDashboard();

    expect(screen.queryByText("Connected")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(mockBuildStatus).toHaveBeenCalled();
    });
  });

  it("fetches execute status on mount", async () => {
    renderAgentDashboard();

    await waitFor(() => {
      expect(mockBuildStatus).toHaveBeenCalledWith("proj-1");
      expect(mockAgentsActive).toHaveBeenCalledWith("proj-1");
    });
  });

  it("renders agent output as markdown when agent is selected", async () => {
    const user = userEvent.setup();
    mockAgentsActive.mockResolvedValue([
      {
        id: "task-1",
        phase: "coding",
        branchName: "opensprint/task-1",
        label: "opensprint/task-1",
        startedAt: "2024-01-01T12:00:00Z",
      },
    ]);
    mockLiveOutput.mockResolvedValue({ output: "**Bold text** and `code`" });
    const store = configureStore({
      reducer: { execute: executeReducer },
      preloadedState: {
        execute: {
          ...initialExecuteState,
          agentOutput: { "task-1": ["**Bold text** and `code`"] },
          activeAgents: [
            {
              id: "task-1",
              phase: "coding",
              branchName: "opensprint/task-1",
              label: "opensprint/task-1",
              startedAt: "2024-01-01T12:00:00Z",
            },
          ],
          activeAgentsLoadedOnce: true,
        },
      },
    });
    render(
      <Provider store={store}>
        <AgentDashboard projectId="proj-1" />
      </Provider>
    );

    await waitFor(() => {
      expect(screen.getByText("task-1")).toBeInTheDocument();
    });
    await user.click(screen.getByText("task-1"));

    expect(screen.getByText("Bold text")).toBeInTheDocument();
    expect(screen.getByText("code")).toBeInTheDocument();

    const outputContainer = screen.getByTestId("agent-output");
    expect(outputContainer).toHaveClass("prose-execute-task");
  });

  it("applies same prose/code styling as TaskDetailSidebar for consistency", async () => {
    mockAgentsActive.mockResolvedValue([
      {
        id: "task-1",
        phase: "coding",
        branchName: "opensprint/task-1",
        label: "opensprint/task-1",
        startedAt: "2024-01-01T12:00:00Z",
      },
    ]);
    const store = configureStore({
      reducer: { execute: executeReducer },
      preloadedState: {
        execute: {
          ...initialExecuteState,
          agentOutput: { "task-1": ["# Header\n\nSome content"] },
          activeAgents: [
            {
              id: "task-1",
              phase: "coding",
              branchName: "opensprint/task-1",
              label: "opensprint/task-1",
              startedAt: "2024-01-01T12:00:00Z",
            },
          ],
          activeAgentsLoadedOnce: true,
        },
      },
    });
    const { container } = render(
      <Provider store={store}>
        <AgentDashboard projectId="proj-1" />
      </Provider>
    );

    const user = userEvent.setup();
    await user.click(screen.getByText("task-1"));

    const outputDiv = container.querySelector('[data-testid="agent-output"]');
    expect(outputDiv).toBeInTheDocument();
    expect(outputDiv).toHaveClass("prose-execute-task");
    expect(outputDiv).toHaveClass("text-theme-success-muted");
  });

  it("fetches and polls live output when agent is selected", async () => {
    mockAgentsActive.mockResolvedValue([
      {
        id: "task-1",
        phase: "coding",
        branchName: "opensprint/task-1",
        label: "opensprint/task-1",
        startedAt: "2024-01-01T12:00:00Z",
      },
    ]);
    mockLiveOutput.mockResolvedValue({ output: "Initial output" });
    const store = configureStore({
      reducer: { execute: executeReducer },
      preloadedState: {
        execute: {
          ...initialExecuteState,
          activeAgents: [
            {
              id: "task-1",
              phase: "coding",
              branchName: "opensprint/task-1",
              label: "opensprint/task-1",
              startedAt: "2024-01-01T12:00:00Z",
            },
          ],
          activeAgentsLoadedOnce: true,
        },
      },
    });
    const user = userEvent.setup();
    render(
      <Provider store={store}>
        <AgentDashboard projectId="proj-1" />
      </Provider>
    );

    await waitFor(() => {
      expect(screen.getByText("task-1")).toBeInTheDocument();
    });
    await user.click(screen.getByText("task-1"));

    await waitFor(() => {
      expect(mockLiveOutput).toHaveBeenCalledWith("proj-1", "task-1");
    });
  });
});
