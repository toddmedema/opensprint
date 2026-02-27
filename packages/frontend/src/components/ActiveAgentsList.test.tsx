import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, within, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { MemoryRouter, useLocation } from "react-router-dom";
import { configureStore } from "@reduxjs/toolkit";
import { DisplayPreferencesProvider } from "../contexts/DisplayPreferencesContext";
import { ActiveAgentsList } from "./ActiveAgentsList";
import executeReducer from "../store/slices/executeSlice";
import planReducer from "../store/slices/planSlice";

const mockAgentsActive = vi.fn().mockResolvedValue([]);
const mockAgentsKill = vi.fn().mockResolvedValue({ killed: true });

vi.mock("../api/client", () => ({
  api: {
    agents: {
      active: (...args: unknown[]) => mockAgentsActive(...args),
      kill: (...args: unknown[]) => mockAgentsKill(...args),
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
      <DisplayPreferencesProvider>
        <MemoryRouter>
          <ActiveAgentsList projectId="proj-1" />
        </MemoryRouter>
      </DisplayPreferencesProvider>
    </Provider>
  );
}

describe("ActiveAgentsList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentsActive.mockResolvedValue([]);
    mockAgentsKill.mockResolvedValue({ killed: true });
  });

  it("shows loading spinner during initial fetch (never No agents running while loading)", () => {
    mockAgentsActive.mockImplementation(() => new Promise(() => {})); // Never resolves
    renderActiveAgentsList();

    expect(screen.getByTitle("Active agents")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    expect(screen.queryByText("No agents running")).not.toBeInTheDocument();
  });

  it("renders button with No agents running when empty after fetch completes", async () => {
    renderActiveAgentsList();

    expect(screen.getByTitle("Active agents")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("No agents running")).toBeInTheDocument();
    });
  });

  it("does not render colored status dot on agents-running button", async () => {
    renderActiveAgentsList();

    await waitFor(() => {
      expect(screen.getByText("No agents running")).toBeInTheDocument();
    });
    const button = screen.getByTitle("Active agents");
    // No status dot (w-2 h-2 rounded-full bg-theme-warning-solid animate-pulse)
    const dot = button.querySelector(".rounded-full.bg-theme-warning-solid");
    expect(dot).toBeNull();
  });

  it("renders button with no visible border (border-none)", async () => {
    renderActiveAgentsList();

    await waitFor(() => {
      expect(screen.getByText("No agents running")).toBeInTheDocument();
    });
    const button = screen.getByTitle("Active agents");
    expect(button.className).toContain("border-none");
    expect(button.className).toContain("ring-0");
    expect(button.className).not.toContain("border-theme-border");
  });

  it("shows dropdown when button clicked", async () => {
    const user = userEvent.setup();
    renderActiveAgentsList();

    await waitFor(() => {
      expect(screen.getByText("No agents running")).toBeInTheDocument();
    });
    await user.click(screen.getByTitle("Active agents"));

    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeInTheDocument();
    expect(within(listbox).getByText("No agents running")).toBeInTheDocument();
  });

  it("dropdown has border for visual distinction from navbar", async () => {
    const user = userEvent.setup();
    renderActiveAgentsList();

    await waitFor(() => {
      expect(screen.getByText("No agents running")).toBeInTheDocument();
    });
    await user.click(screen.getByTitle("Active agents"));

    const listbox = screen.getByRole("listbox");
    expect(listbox).toHaveClass("border-theme-border");
    expect(listbox.className).toMatch(/\bborder\b/);
  });

  it("dropdown is rendered in portal with high z-index to appear above Build sidebar (z-50)", async () => {
    const user = userEvent.setup();
    renderActiveAgentsList();

    await waitFor(() => {
      expect(screen.getByText("No agents running")).toBeInTheDocument();
    });
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
    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    fireEvent.click(screen.getByTitle("Active agents"));

    await act(async () => {
      vi.advanceTimersByTime(100);
    });

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
    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    fireEvent.click(screen.getByTitle("Active agents"));

    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    // fetchAgents is called on open — ensures fresh startedAt from list response
    expect(mockAgentsActive).toHaveBeenCalledWith("proj-1");
    // Elapsed time from startedAt (3m) — correct from first frame
    expect(screen.getByText("3m 0s")).toBeInTheDocument();

    vi.useRealTimers();
  });

  it("shows loading spinner in dropdown when opened during initial fetch", async () => {
    mockAgentsActive.mockImplementation(() => new Promise(() => {})); // Never resolves
    const user = userEvent.setup();
    renderActiveAgentsList();

    await user.click(screen.getByTitle("Active agents"));

    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeInTheDocument();
    expect(within(listbox).getByRole("status", { name: "Loading agents" })).toBeInTheDocument();
    expect(within(listbox).queryByText("No agents running")).not.toBeInTheDocument();
  });

  it("does not flash loading spinner in dropdown when opening after data is cached", async () => {
    mockAgentsActive.mockResolvedValue([
      {
        id: "task-1",
        phase: "coding",
        role: "coder",
        label: "Task 1",
        startedAt: "2026-02-16T12:00:00.000Z",
      },
    ]);

    renderActiveAgentsList();
    await waitFor(() => {
      expect(screen.getByText("1 agent running")).toBeInTheDocument();
    });

    // Stagger the next fetch so it is in-flight when dropdown opens
    let resolveSecondFetch: (value: unknown) => void;
    mockAgentsActive.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSecondFetch = resolve;
        })
    );

    const user = userEvent.setup();
    await user.click(screen.getByTitle("Active agents"));

    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeInTheDocument();
    // Cached list is shown immediately — no loading spinner flash in dropdown or button
    expect(
      within(listbox).queryByRole("status", { name: "Loading agents" })
    ).not.toBeInTheDocument();
    expect(within(listbox).getByText("Task 1")).toBeInTheDocument();
    const button = screen.getByTitle("Active agents");
    expect(within(button).queryByRole("status", { name: "Loading" })).not.toBeInTheDocument();

    resolveSecondFetch!([
      {
        id: "task-1",
        phase: "coding",
        role: "coder",
        label: "Task 1",
        startedAt: "2026-02-16T12:00:00.000Z",
      },
    ]);
  });

  it("shows em dash when agent has no startedAt", async () => {
    mockAgentsActive.mockResolvedValue([
      { id: "task-1", phase: "coding", role: "coder", label: "Task 1" },
    ]);

    renderActiveAgentsList();

    const user = userEvent.setup();
    await user.click(screen.getByTitle("Active agents"));

    expect(await screen.findByText(/—/)).toBeInTheDocument();
    expect(screen.getByText("Task 1")).toBeInTheDocument();
  });

  it("renders agent icons in canonical README/PRD order (Dreamer, Planner, ..., Coder, Reviewer)", async () => {
    mockAgentsActive.mockResolvedValue([
      {
        id: "t1",
        phase: "coding",
        role: "coder",
        label: "Task 1",
        startedAt: "2026-02-16T12:00:00.000Z",
      },
      {
        id: "t2",
        phase: "plan",
        role: "dreamer",
        label: "Task 2",
        startedAt: "2026-02-16T12:00:00.000Z",
      },
      {
        id: "t3",
        phase: "execute",
        role: "auditor",
        label: "Task 3",
        startedAt: "2026-02-16T12:00:00.000Z",
      },
    ]);

    renderActiveAgentsList();
    await waitFor(() => {
      expect(screen.getByText("3 agents running")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByTitle("Active agents"));

    const listbox = screen.getByRole("listbox");
    const labels = within(listbox)
      .getAllByText(/Task \d/)
      .map((el) => el.textContent);
    expect(labels).toEqual(["Task 2", "Task 3", "Task 1"]); // dreamer, auditor, coder
  });

  it("shows agent name in parentheses after role when name is available", async () => {
    mockAgentsActive.mockResolvedValue([
      {
        id: "task-1",
        phase: "coding",
        role: "coder",
        label: "Task 1",
        name: "Frodo",
        startedAt: "2026-02-16T12:00:00.000Z",
      },
    ]);

    renderActiveAgentsList();
    await waitFor(() => {
      expect(screen.getByText("1 agent running")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByTitle("Active agents"));

    expect(screen.getByText(/Coder \(Frodo\)/)).toBeInTheDocument();
  });

  it("shows role only when agent name is absent", async () => {
    mockAgentsActive.mockResolvedValue([
      {
        id: "task-1",
        phase: "coding",
        role: "coder",
        label: "Task 1",
        startedAt: "2026-02-16T12:00:00.000Z",
      },
    ]);

    renderActiveAgentsList();
    await waitFor(() => {
      expect(screen.getByText("1 agent running")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByTitle("Active agents"));

    expect(screen.getByText(/Coder/)).toBeInTheDocument();
    expect(screen.queryByText(/Coder \(/)).not.toBeInTheDocument();
  });

  it("shows agent role description as tooltip on dropdown item hover", async () => {
    const coderDescription = "Implements tasks and ships working code with tests.";
    mockAgentsActive.mockResolvedValue([
      {
        id: "task-1",
        phase: "coding",
        role: "coder",
        label: "Task 1",
        startedAt: "2026-02-16T12:00:00.000Z",
      },
    ]);

    renderActiveAgentsList();
    await waitFor(() => {
      expect(screen.getByText("1 agent running")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByTitle("Active agents"));

    const button = within(screen.getByRole("listbox")).getByRole("button", { name: /Task 1/ });
    expect(button).toHaveAttribute("title", coderDescription);
  });

  it("shows reviewer description when agent has phase review but no role", async () => {
    const reviewerDescription = "Validates implementation against acceptance criteria.";
    mockAgentsActive.mockResolvedValue([
      {
        id: "task-1",
        phase: "review",
        label: "Task 1",
        startedAt: "2026-02-16T12:00:00.000Z",
      },
    ]);

    renderActiveAgentsList();
    await waitFor(() => {
      expect(screen.getByText("1 agent running")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByTitle("Active agents"));

    const button = within(screen.getByRole("listbox")).getByRole("button", { name: /Task 1/ });
    expect(button).toHaveAttribute("title", reviewerDescription);
  });

  it("renders button agent icons at 1.5rem with 2px left margin when display mode is both", async () => {
    localStorage.setItem("opensprint.runningAgentsDisplayMode", "both");
    mockAgentsActive.mockResolvedValue([
      {
        id: "task-1",
        phase: "coding",
        role: "coder",
        label: "Task 1",
        startedAt: "2026-02-16T12:00:00.000Z",
      },
    ]);

    renderActiveAgentsList();
    await waitFor(() => {
      expect(screen.getByText("1 agent running")).toBeInTheDocument();
    });
    await waitFor(() => {
      const btn = screen.getByTitle("Active agents");
      expect(btn.querySelector("img")).toBeInTheDocument();
    });

    const button = screen.getByTitle("Active agents");
    const icon = button.querySelector("img");
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveStyle({
      width: "1.5rem",
      height: "1.5rem",
      marginLeft: "2px",
    });
  });

  it("navigates to Evaluate page with feedback param when clicking Analyst agent", async () => {
    mockAgentsActive.mockResolvedValue([
      {
        id: "feedback-categorize-proj-1-fsi69v-123",
        phase: "eval",
        role: "analyst",
        label: "Feedback categorization",
        startedAt: "2026-02-16T12:00:00.000Z",
        feedbackId: "fsi69v",
      },
    ]);

    function LocationDisplay() {
      const { pathname, search } = useLocation();
      return <div data-testid="location">{pathname + search}</div>;
    }

    render(
      <Provider store={createStore()}>
        <DisplayPreferencesProvider>
          <MemoryRouter initialEntries={["/projects/proj-1/execute"]}>
            <ActiveAgentsList projectId="proj-1" />
            <LocationDisplay />
          </MemoryRouter>
        </DisplayPreferencesProvider>
      </Provider>
    );

    await waitFor(() => {
      expect(screen.getByText("1 agent running")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByTitle("Active agents"));
    await user.click(screen.getByRole("button", { name: /Feedback categorization/ }));

    expect(screen.getByTestId("location")).toHaveTextContent(
      "/projects/proj-1/eval?feedback=fsi69v"
    );
  });

  it("renders agent icons sized to match two lines of text (3.01875rem) with 2px left margin in dropdown", async () => {
    mockAgentsActive.mockResolvedValue([
      {
        id: "task-1",
        phase: "coding",
        role: "coder",
        label: "Task 1",
        startedAt: "2026-02-16T12:00:00.000Z",
      },
    ]);

    renderActiveAgentsList();
    await waitFor(() => {
      expect(screen.getByText("1 agent running")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByTitle("Active agents"));

    const listbox = screen.getByRole("listbox");
    const icon = listbox.querySelector("img");
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveStyle({
      width: "3.01875rem",
      height: "3.01875rem",
      marginLeft: "2px",
    });
  });

  it("shows Kill button (circled X icon) for all agents, visible on card hover", async () => {
    const startedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    mockAgentsActive.mockResolvedValue([
      {
        id: "task-1",
        phase: "coding",
        role: "coder",
        label: "Task 1",
        startedAt,
      },
    ]);

    renderActiveAgentsList();
    await waitFor(() => {
      expect(screen.getByText("1 agent running")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByTitle("Active agents"));

    const killButton = screen.getByRole("button", { name: "Kill agent" });
    expect(killButton).toBeInTheDocument();
  });

  it("shows confirmation dialog when Kill button is clicked", async () => {
    const startedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    mockAgentsActive.mockResolvedValue([
      {
        id: "task-1",
        phase: "coding",
        role: "coder",
        label: "Task 1",
        startedAt,
      },
    ]);

    renderActiveAgentsList();
    await waitFor(() => {
      expect(screen.getByText("1 agent running")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByTitle("Active agents"));

    const killButton = screen.getByRole("button", { name: "Kill agent" });
    await user.click(killButton);

    expect(screen.getByRole("dialog", { name: /kill agent/i })).toBeInTheDocument();
    expect(screen.getByText("Are you sure you want to kill this agent?")).toBeInTheDocument();
  });

  it("calls kill API when Confirm is clicked in dialog", async () => {
    const startedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    mockAgentsActive.mockResolvedValue([
      {
        id: "task-1",
        phase: "coding",
        role: "coder",
        label: "Task 1",
        startedAt,
      },
    ]);

    renderActiveAgentsList();
    await waitFor(() => {
      expect(screen.getByText("1 agent running")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByTitle("Active agents"));

    const killButton = screen.getByRole("button", { name: "Kill agent" });
    await user.click(killButton);

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /kill agent/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(mockAgentsKill).toHaveBeenCalledWith("proj-1", "task-1");
    });
  });

  it("skips confirmation dialog when opensprint.killAgentConfirmDisabled is true", async () => {
    localStorage.setItem("opensprint.killAgentConfirmDisabled", "true");
    const startedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    mockAgentsActive.mockResolvedValue([
      {
        id: "task-1",
        phase: "coding",
        role: "coder",
        label: "Task 1",
        startedAt,
      },
    ]);

    renderActiveAgentsList();
    await waitFor(() => {
      expect(screen.getByText("1 agent running")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByTitle("Active agents"));

    const killButton = screen.getByRole("button", { name: "Kill agent" });
    await user.click(killButton);

    expect(screen.queryByRole("dialog", { name: /kill agent/i })).not.toBeInTheDocument();
    expect(mockAgentsKill).toHaveBeenCalledWith("proj-1", "task-1");

    localStorage.removeItem("opensprint.killAgentConfirmDisabled");
  });
});
