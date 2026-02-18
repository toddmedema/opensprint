import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { MemoryRouter } from "react-router-dom";
import { configureStore } from "@reduxjs/toolkit";
import { ActiveAgentsList } from "./ActiveAgentsList";
import executeReducer from "../store/slices/executeSlice";
import planReducer from "../store/slices/planSlice";

const mockAgentsActive = vi.fn().mockResolvedValue([]);

vi.mock("../api/client", () => ({
  api: {
    agents: {
      active: (...args: unknown[]) => mockAgentsActive(...args),
    },
  },
}));

function createStore() {
  return configureStore({
    reducer: { execute: executeReducer, plan: planReducer },
  });
}

function renderActiveAgentsList() {
  return render(
    <Provider store={createStore()}>
      <MemoryRouter>
        <ActiveAgentsList projectId="proj-1" />
      </MemoryRouter>
    </Provider>,
  );
}

describe("ActiveAgentsList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentsActive.mockResolvedValue([]);
  });

  it("renders button with No agents running when empty", async () => {
    renderActiveAgentsList();

    expect(screen.getByTitle("Active agents")).toBeInTheDocument();
    expect(screen.getByText("No agents running")).toBeInTheDocument();
  });

  it("shows dropdown when button clicked", async () => {
    const user = userEvent.setup();
    renderActiveAgentsList();

    await user.click(screen.getByTitle("Active agents"));

    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByText("No agents running")).toBeInTheDocument();
  });

  it("dropdown is rendered in portal with high z-index to appear above Build sidebar (z-50)", async () => {
    const user = userEvent.setup();
    renderActiveAgentsList();

    await user.click(screen.getByTitle("Active agents"));

    const dropdown = screen.getByRole("listbox");
    expect(dropdown.parentElement).toBe(document.body);
    expect(Number(dropdown.style.zIndex)).toBeGreaterThanOrEqual(9999);
  });

  it("shows live uptime for each agent when dropdown is open", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-16T12:00:00.000Z"));
    const startedAt = "2026-02-16T12:00:00.000Z";
    mockAgentsActive.mockResolvedValue([
      { id: "task-1", phase: "coding", role: "coder", label: "Task 1", startedAt },
    ]);

    renderActiveAgentsList();
    await vi.runAllTimersAsync();

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByTitle("Active agents"));

    // Elapsed time correct from first frame (startedAt in list response, no separate fetch)
    expect(screen.getByText("0s")).toBeInTheDocument();

    // Advance 2m 34s — uptime tick fires every second, so "now" updates
    await act(async () => {
      vi.advanceTimersByTime(154_000);
    });

    expect(screen.getByText("2m 34s")).toBeInTheDocument();
    expect(screen.getByText("Task 1")).toBeInTheDocument();
    expect(screen.getByText(/Coder/)).toBeInTheDocument();

    vi.useRealTimers();
  });

  it("fetches agents when dropdown opens so elapsed time is correct from first frame", async () => {
    const startedAt = "2026-02-16T11:57:00.000Z"; // 3 min ago from 12:00
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-16T12:00:00.000Z"));
    mockAgentsActive.mockResolvedValue([
      { id: "task-1", phase: "coding", role: "coder", label: "Task 1", startedAt },
    ]);

    renderActiveAgentsList();
    await vi.runAllTimersAsync();

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByTitle("Active agents"));

    // fetchAgents is called on open — ensures fresh startedAt from list response
    expect(mockAgentsActive).toHaveBeenCalledWith("proj-1");
    // Elapsed time from startedAt (3m) — correct from first frame
    expect(screen.getByText("3m 0s")).toBeInTheDocument();

    vi.useRealTimers();
  });

  it("shows em dash when agent has no startedAt", async () => {
    mockAgentsActive.mockResolvedValue([
      { id: "task-1", phase: "coding", role: "coder", label: "Task 1" },
    ]);

    renderActiveAgentsList();
    await vi.runAllTimersAsync();

    const user = userEvent.setup();
    await user.click(screen.getByTitle("Active agents"));

    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("Task 1")).toBeInTheDocument();
  });
});
