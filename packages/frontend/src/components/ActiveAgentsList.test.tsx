import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { MemoryRouter } from "react-router-dom";
import { configureStore } from "@reduxjs/toolkit";
import { ActiveAgentsList } from "./ActiveAgentsList";
import buildReducer from "../store/slices/buildSlice";
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
    reducer: { build: buildReducer, plan: planReducer },
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

  it("dropdown has z-[100] to appear above Build sidebar (z-50)", async () => {
    const user = userEvent.setup();
    renderActiveAgentsList();

    await user.click(screen.getByTitle("Active agents"));

    const dropdown = screen.getByRole("listbox");
    expect(dropdown).toHaveClass("z-[100]");
  });
});
