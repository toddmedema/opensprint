import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { MemoryRouter } from "react-router-dom";
import { configureStore } from "@reduxjs/toolkit";
import { DisplayPreferencesProvider } from "../contexts/DisplayPreferencesContext";
import { GlobalActiveAgentsList } from "./GlobalActiveAgentsList";
import globalReducer from "../store/slices/globalSlice";
import planReducer from "../store/slices/planSlice";

const mockProjectsList = vi.fn().mockResolvedValue([]);
const mockAgentsActive = vi.fn().mockResolvedValue([]);
const mockAgentsKill = vi.fn().mockResolvedValue({ killed: true });

vi.mock("../api/client", () => ({
  api: {
    projects: {
      list: (...args: unknown[]) => mockProjectsList(...args),
    },
    agents: {
      active: (...args: unknown[]) => mockAgentsActive(...args),
      kill: (...args: unknown[]) => mockAgentsKill(...args),
    },
  },
}));

function createStore() {
  return configureStore({
    reducer: { global: globalReducer, plan: planReducer },
  });
}

function renderGlobalActiveAgentsList() {
  return render(
    <Provider store={createStore()}>
      <DisplayPreferencesProvider>
        <MemoryRouter>
          <GlobalActiveAgentsList />
        </MemoryRouter>
      </DisplayPreferencesProvider>
    </Provider>
  );
}

describe("GlobalActiveAgentsList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectsList.mockResolvedValue([]);
    mockAgentsActive.mockResolvedValue([]);
    mockAgentsKill.mockResolvedValue({ killed: true });
  });

  it("renders button agent icons at 1.5rem with 2px left margin when display mode is both", async () => {
    localStorage.setItem("opensprint.runningAgentsDisplayMode", "both");
    mockProjectsList.mockResolvedValue([{ id: "proj-1", name: "Project A" }]);
    mockAgentsActive.mockResolvedValue([
      {
        id: "task-1",
        phase: "coding",
        role: "coder",
        label: "Task 1",
        startedAt: "2026-02-16T12:00:00.000Z",
      },
    ]);

    renderGlobalActiveAgentsList();
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

  it("renders dropdown agent icons at 3.01875rem with 2px left margin", async () => {
    mockProjectsList.mockResolvedValue([{ id: "proj-1", name: "Project A" }]);
    mockAgentsActive.mockResolvedValue([
      {
        id: "task-1",
        phase: "coding",
        role: "coder",
        label: "Task 1",
        startedAt: "2026-02-16T12:00:00.000Z",
      },
    ]);

    renderGlobalActiveAgentsList();
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

  it("renders agent icons in canonical README/PRD order in both button and dropdown", async () => {
    mockProjectsList.mockResolvedValue([{ id: "proj-1", name: "Project A" }]);
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

    renderGlobalActiveAgentsList();

    await waitFor(() => {
      expect(screen.getByText("3 agents running")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByTitle("Active agents"));

    const listbox = screen.getByRole("listbox");
    const labels = within(listbox)
      .getAllByText(/Task \d/)
      .map((el) => el.textContent);
    expect(labels).toEqual(["Task 2", "Task 3", "Task 1"]); // dreamer, auditor, coder — README order
  });

  it("dropdown has border for visual distinction from navbar", async () => {
    mockProjectsList.mockResolvedValue([{ id: "proj-1", name: "Project A" }]);
    mockAgentsActive.mockResolvedValue([]);

    renderGlobalActiveAgentsList();

    await waitFor(() => {
      expect(screen.getByText("No agents running")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByTitle("Active agents"));

    const listbox = screen.getByRole("listbox");
    expect(listbox).toHaveClass("border-theme-border");
    expect(listbox.className).toMatch(/\bborder\b/);
  });

  it("shows agent name in parentheses after role when name is available", async () => {
    mockProjectsList.mockResolvedValue([{ id: "proj-1", name: "Project A" }]);
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

    renderGlobalActiveAgentsList();
    await waitFor(() => {
      expect(screen.getByText("1 agent running")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByTitle("Active agents"));

    expect(screen.getByText(/Coder \(Frodo\)/)).toBeInTheDocument();
  });

  it("shows role only when agent name is absent", async () => {
    mockProjectsList.mockResolvedValue([{ id: "proj-1", name: "Project A" }]);
    mockAgentsActive.mockResolvedValue([
      {
        id: "task-1",
        phase: "coding",
        role: "coder",
        label: "Task 1",
        startedAt: "2026-02-16T12:00:00.000Z",
      },
    ]);

    renderGlobalActiveAgentsList();
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
    mockProjectsList.mockResolvedValue([{ id: "proj-1", name: "Project A" }]);
    mockAgentsActive.mockResolvedValue([
      {
        id: "task-1",
        phase: "coding",
        role: "coder",
        label: "Task 1",
        startedAt: "2026-02-16T12:00:00.000Z",
      },
    ]);

    renderGlobalActiveAgentsList();
    await waitFor(() => {
      expect(screen.getByText("1 agent running")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByTitle("Active agents"));

    const button = within(screen.getByRole("listbox")).getByRole("button", { name: /Task 1/ });
    expect(button).toHaveAttribute("title", coderDescription);
  });

  it("does not flash loading spinner in dropdown when opening after data is cached", async () => {
    mockProjectsList.mockResolvedValue([{ id: "proj-1", name: "Project A" }]);
    mockAgentsActive.mockResolvedValue([
      {
        id: "task-1",
        phase: "coding",
        role: "coder",
        label: "Task 1",
        startedAt: "2026-02-16T12:00:00.000Z",
      },
    ]);

    renderGlobalActiveAgentsList();
    await waitFor(() => {
      expect(screen.getByText("1 agent running")).toBeInTheDocument();
    });

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

  it("shows confirmation dialog when Kill button is clicked", async () => {
    mockProjectsList.mockResolvedValue([{ id: "proj-1", name: "Project A" }]);
    mockAgentsActive.mockResolvedValue([
      {
        id: "task-1",
        phase: "coding",
        role: "coder",
        label: "Task 1",
        startedAt: "2026-02-16T12:00:00.000Z",
      },
    ]);

    renderGlobalActiveAgentsList();
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
    mockProjectsList.mockResolvedValue([{ id: "proj-1", name: "Project A" }]);
    mockAgentsActive.mockResolvedValue([
      {
        id: "task-1",
        phase: "coding",
        role: "coder",
        label: "Task 1",
        startedAt: "2026-02-16T12:00:00.000Z",
      },
    ]);

    renderGlobalActiveAgentsList();
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
    mockProjectsList.mockResolvedValue([{ id: "proj-1", name: "Project A" }]);
    mockAgentsActive.mockResolvedValue([
      {
        id: "task-1",
        phase: "coding",
        role: "coder",
        label: "Task 1",
        startedAt: "2026-02-16T12:00:00.000Z",
      },
    ]);

    renderGlobalActiveAgentsList();
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
