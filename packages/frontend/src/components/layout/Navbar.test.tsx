import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { Navbar } from "./Navbar";
import buildReducer from "../../store/slices/buildSlice";
import planReducer from "../../store/slices/planSlice";

vi.mock("../../api/client", () => ({
  api: {
    projects: { list: vi.fn().mockResolvedValue([]) },
    agents: { active: vi.fn().mockResolvedValue([]) },
  },
}));

function createStore() {
  return configureStore({
    reducer: { build: buildReducer, plan: planReducer },
  });
}

describe("Navbar", () => {
  it("has z-[60] so dropdowns appear above Build sidebar (z-50)", () => {
    render(
      <Provider store={createStore()}>
        <MemoryRouter>
          <Navbar project={null} />
        </MemoryRouter>
      </Provider>,
    );

    const nav = screen.getByRole("navigation");
    expect(nav).toHaveClass("z-[60]");
  });
});
