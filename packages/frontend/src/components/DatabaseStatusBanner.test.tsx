import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { MemoryRouter } from "react-router-dom";
import { DatabaseStatusBanner } from "./DatabaseStatusBanner";

const mockUseDbStatus = vi.fn();

vi.mock("../api/hooks", () => ({
  useDbStatus: () => mockUseDbStatus(),
}));

function renderBanner(
  dbStatus: ReturnType<typeof mockUseDbStatus>,
  preloadedState?: { connection?: { connectionError: boolean } },
  route = "/"
) {
  mockUseDbStatus.mockReturnValue(dbStatus);
  const store = configureStore({
    reducer: {
      connection: (
        state = { connectionError: false },
        _action: { type: string; payload?: boolean }
      ) => state,
    },
    preloadedState,
  });

  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[route]}>
        <DatabaseStatusBanner />
      </MemoryRouter>
    </Provider>
  );
}

describe("DatabaseStatusBanner", () => {
  it("renders nothing when database is connected", () => {
    renderBanner({
      data: { ok: true, state: "connected", lastCheckedAt: null },
      isPending: false,
    });
    expect(screen.queryByTestId("database-status-banner")).not.toBeInTheDocument();
  });

  it("shows the unavailable message and settings link", () => {
    renderBanner({
      data: {
        ok: false,
        state: "disconnected",
        lastCheckedAt: null,
        message: "No PostgreSQL server running",
      },
      isPending: false,
    });

    expect(screen.getByTestId("database-status-banner")).toHaveTextContent(
      "No PostgreSQL server running"
    );
    expect(screen.getByRole("link", { name: "Open Settings" })).toHaveAttribute(
      "href",
      "/settings"
    );
  });

  it("shows reconnecting copy on project routes", () => {
    renderBanner(
      {
        data: {
          ok: false,
          state: "connecting",
          lastCheckedAt: null,
          message: "No PostgreSQL server running",
        },
        isPending: false,
      },
      undefined,
      "/projects/proj-1/plan"
    );

    expect(screen.getByTestId("database-status-banner")).toHaveTextContent(
      "Reconnecting to PostgreSQL..."
    );
    expect(screen.getByRole("link", { name: "Open Settings" })).toHaveAttribute(
      "href",
      "/projects/proj-1/settings"
    );
  });

  it("hides when the server itself is unreachable", () => {
    renderBanner(
      {
        data: {
          ok: false,
          state: "disconnected",
          lastCheckedAt: null,
          message: "No PostgreSQL server running",
        },
        isPending: false,
      },
      { connection: { connectionError: true } }
    );

    expect(screen.queryByTestId("database-status-banner")).not.toBeInTheDocument();
  });
});
