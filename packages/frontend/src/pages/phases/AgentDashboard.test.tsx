import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentDashboard } from "./AgentDashboard";

const mockSubscribeToAgent = vi.fn();
const mockUnsubscribeFromAgent = vi.fn();

vi.mock("../../hooks/useWebSocket", () => ({
  useWebSocket: () => ({
    subscribeToAgent: mockSubscribeToAgent,
    unsubscribeFromAgent: mockUnsubscribeFromAgent,
  }),
}));

const mockBuildStatus = vi.fn().mockResolvedValue({
  running: false,
  totalCompleted: 0,
  totalFailed: 0,
  queueDepth: 0,
});

const mockAgentsActive = vi.fn().mockResolvedValue([]);

vi.mock("../../api/client", () => ({
  api: {
    build: {
      status: (...args: unknown[]) => mockBuildStatus(...args),
    },
    agents: {
      active: (...args: unknown[]) => mockAgentsActive(...args),
    },
  },
}));

describe("AgentDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders header with title and subtitle", async () => {
    render(<AgentDashboard projectId="proj-1" />);

    expect(screen.getByText("Agent Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Monitor and manage all agent instances")).toBeInTheDocument();
  });

  it("does not render redundant Connected text in top bar", () => {
    render(<AgentDashboard projectId="proj-1" />);

    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });

  it("fetches build status on mount", async () => {
    render(<AgentDashboard projectId="proj-1" />);

    expect(mockBuildStatus).toHaveBeenCalledWith("proj-1");
    expect(mockAgentsActive).toHaveBeenCalledWith("proj-1");
  });
});
