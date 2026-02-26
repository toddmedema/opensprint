import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { HomeScreen } from "./HomeScreen";
import { HOMEPAGE_CONTAINER_CLASS } from "../lib/constants";
import notificationReducer from "../store/slices/notificationSlice";

const mockProjectsList = vi.fn();
const mockArchive = vi.fn();
const mockDelete = vi.fn();

vi.mock("../api/client", () => ({
  api: {
    projects: {
      list: (...args: unknown[]) => mockProjectsList(...args),
      archive: (...args: unknown[]) => mockArchive(...args),
      delete: (...args: unknown[]) => mockDelete(...args),
    },
  },
}));

vi.mock("./layout/Layout", () => ({
  Layout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="layout">{children}</div>
  ),
}));

function renderHomeScreen() {
  const store = configureStore({
    reducer: { notification: notificationReducer },
  });
  return render(
    <Provider store={store}>
      <MemoryRouter>
        <HomeScreen />
      </MemoryRouter>
    </Provider>
  );
}

const mockProject = {
  id: "proj-1",
  name: "My Project",
  repoPath: "/path/to/repo",
  currentPhase: "sketch" as const,
  createdAt: "2026-02-15T12:00:00Z",
  updatedAt: "2026-02-15T12:00:00Z",
};

describe("HomeScreen", () => {
  beforeEach(() => {
    mockProjectsList.mockReset();
    mockArchive.mockReset();
    mockDelete.mockReset();
  });

  it("shows loading state while fetching projects", async () => {
    mockProjectsList.mockImplementation(() => new Promise(() => {}));

    renderHomeScreen();

    expect(screen.getByText("Loading projects...")).toBeInTheDocument();
  });

  it("shows projects grid when no projects", async () => {
    mockProjectsList.mockResolvedValue([]);

    renderHomeScreen();

    await screen.findByTestId("projects-grid");
    expect(screen.getByTestId("create-new-button")).toHaveTextContent("Create New");
    expect(screen.getByTestId("add-existing-button")).toHaveTextContent("Add Existing");
  });

  it("renders project cards when projects exist", async () => {
    mockProjectsList.mockResolvedValue([mockProject]);

    renderHomeScreen();

    await screen.findByText("My Project");
    expect(screen.getByTestId("project-card-proj-1")).toBeInTheDocument();
    expect(screen.getByText("/path/to/repo")).toBeInTheDocument();
  });

  it("project cards have hover effect for clickability feedback", async () => {
    mockProjectsList.mockResolvedValue([mockProject]);
    renderHomeScreen();
    await screen.findByTestId("project-card-proj-1");
    const card = screen.getByTestId("project-card-proj-1");
    expect(card).toHaveClass("hover:bg-theme-info-bg/40");
  });

  it("Create New button navigates to /projects/create-new", async () => {
    mockProjectsList.mockResolvedValue([]);
    const user = userEvent.setup();

    function LocationDisplay() {
      return <div data-testid="location">{useLocation().pathname}</div>;
    }

    const store = configureStore({ reducer: { notification: notificationReducer } });
    render(
      <Provider store={store}>
        <MemoryRouter>
          <HomeScreen />
          <LocationDisplay />
        </MemoryRouter>
      </Provider>
    );

    await screen.findByTestId("create-new-button");
    await user.click(screen.getByTestId("create-new-button"));

    expect(screen.getByTestId("location")).toHaveTextContent("/projects/create-new");
  });

  it("Add Existing button has hover effect for clickability feedback", async () => {
    mockProjectsList.mockResolvedValue([]);
    renderHomeScreen();
    await screen.findByTestId("add-existing-button");
    const btn = screen.getByTestId("add-existing-button");
    expect(btn).toHaveClass("hover:bg-theme-info-bg/50");
  });

  it("Add Existing button navigates to /projects/add-existing", async () => {
    mockProjectsList.mockResolvedValue([]);
    const user = userEvent.setup();

    function LocationDisplay() {
      return <div data-testid="location">{useLocation().pathname}</div>;
    }

    const store = configureStore({ reducer: { notification: notificationReducer } });
    render(
      <Provider store={store}>
        <MemoryRouter>
          <HomeScreen />
          <LocationDisplay />
        </MemoryRouter>
      </Provider>
    );

    await screen.findByTestId("add-existing-button");
    await user.click(screen.getByTestId("add-existing-button"));

    expect(screen.getByTestId("location")).toHaveTextContent("/projects/add-existing");
  });

  it("clicking project card navigates to project sketch", async () => {
    mockProjectsList.mockResolvedValue([mockProject]);
    const user = userEvent.setup();

    function LocationDisplay() {
      return <div data-testid="location">{useLocation().pathname}</div>;
    }

    const store = configureStore({ reducer: { notification: notificationReducer } });
    render(
      <Provider store={store}>
        <MemoryRouter>
          <HomeScreen />
          <LocationDisplay />
        </MemoryRouter>
      </Provider>
    );

    await screen.findByText("My Project");
    const card = screen.getByTestId("project-card-proj-1");
    await user.click(card);

    expect(screen.getByTestId("location")).toHaveTextContent("/projects/proj-1/sketch");
  });

  it("shows three-dot menu button on each project card", async () => {
    mockProjectsList.mockResolvedValue([mockProject]);

    renderHomeScreen();

    await screen.findByText("My Project");
    expect(screen.getByTestId("project-card-menu-proj-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /project actions/i })).toBeInTheDocument();
  });

  it("opens dropdown with Archive and Delete when clicking three-dot menu", async () => {
    mockProjectsList.mockResolvedValue([mockProject]);
    const user = userEvent.setup();

    renderHomeScreen();

    await screen.findByText("My Project");
    expect(screen.queryByTestId("project-card-dropdown-proj-1")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("project-card-menu-proj-1"));

    expect(screen.getByTestId("project-card-dropdown-proj-1")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /archive/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /delete/i })).toBeInTheDocument();
  });

  it("shows Archive modal when clicking Archive in dropdown", async () => {
    mockProjectsList.mockResolvedValue([mockProject]);
    const user = userEvent.setup();

    renderHomeScreen();

    await screen.findByText("My Project");
    await user.click(screen.getByTestId("project-card-menu-proj-1"));
    await user.click(screen.getByRole("menuitem", { name: /archive/i }));

    expect(screen.getByRole("heading", { name: /archive project/i })).toBeInTheDocument();
    expect(
      screen.getByText(/This will remove the project from the UI, but not delete its data/i)
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /proceed/i })).toBeInTheDocument();
  });

  it("shows Delete modal when clicking Delete in dropdown", async () => {
    mockProjectsList.mockResolvedValue([mockProject]);
    const user = userEvent.setup();

    renderHomeScreen();

    await screen.findByText("My Project");
    await user.click(screen.getByTestId("project-card-menu-proj-1"));
    await user.click(screen.getByRole("menuitem", { name: /delete/i }));

    expect(screen.getByRole("heading", { name: /delete project/i })).toBeInTheDocument();
    expect(
      screen.getByText(
        /delete all OpenSprint-related data from the project folder\. Task data in the global store is not removed/i
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /proceed/i })).toBeInTheDocument();
  });

  it("Cancel closes modal with no side effects", async () => {
    mockProjectsList.mockResolvedValue([mockProject]);
    const user = userEvent.setup();

    renderHomeScreen();

    await screen.findByText("My Project");
    await user.click(screen.getByTestId("project-card-menu-proj-1"));
    await user.click(screen.getByRole("menuitem", { name: /archive/i }));

    expect(screen.getByRole("heading", { name: /archive project/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(screen.queryByRole("heading", { name: /archive project/i })).not.toBeInTheDocument();
    expect(mockArchive).not.toHaveBeenCalled();
  });

  it("Proceed on Archive calls archive API and refreshes list", async () => {
    mockProjectsList.mockResolvedValue([mockProject]);
    mockArchive.mockResolvedValue(undefined);
    const user = userEvent.setup();

    renderHomeScreen();

    await screen.findByText("My Project");
    await user.click(screen.getByTestId("project-card-menu-proj-1"));
    await user.click(screen.getByRole("menuitem", { name: /archive/i }));
    await user.click(screen.getByRole("button", { name: /proceed/i }));

    await screen.findByTestId("projects-grid");
    expect(mockArchive).toHaveBeenCalledWith("proj-1");
    expect(mockProjectsList).toHaveBeenCalledTimes(2); // initial load + refresh
  });

  it("Proceed on Delete calls delete API and refreshes list", async () => {
    mockProjectsList.mockResolvedValue([mockProject]);
    mockDelete.mockResolvedValue(undefined);
    const user = userEvent.setup();

    renderHomeScreen();

    await screen.findByText("My Project");
    await user.click(screen.getByTestId("project-card-menu-proj-1"));
    await user.click(screen.getByRole("menuitem", { name: /delete/i }));
    await user.click(screen.getByRole("button", { name: /proceed/i }));

    await screen.findByTestId("projects-grid");
    expect(mockDelete).toHaveBeenCalledWith("proj-1");
    expect(mockProjectsList).toHaveBeenCalledTimes(2); // initial load + refresh
  });

  it("removed project no longer appears after Archive", async () => {
    mockProjectsList.mockResolvedValueOnce([mockProject]).mockResolvedValueOnce([]);
    mockArchive.mockResolvedValue(undefined);
    const user = userEvent.setup();

    renderHomeScreen();

    await screen.findByText("My Project");
    await user.click(screen.getByTestId("project-card-menu-proj-1"));
    await user.click(screen.getByRole("menuitem", { name: /archive/i }));
    await user.click(screen.getByRole("button", { name: /proceed/i }));

    await screen.findByTestId("projects-grid");
    expect(screen.queryByText("My Project")).not.toBeInTheDocument();
    expect(screen.queryByTestId("project-card-proj-1")).not.toBeInTheDocument();
  });

  it("removed project no longer appears after Delete", async () => {
    mockProjectsList.mockResolvedValueOnce([mockProject]).mockResolvedValueOnce([]);
    mockDelete.mockResolvedValue(undefined);
    const user = userEvent.setup();

    renderHomeScreen();

    await screen.findByText("My Project");
    await user.click(screen.getByTestId("project-card-menu-proj-1"));
    await user.click(screen.getByRole("menuitem", { name: /delete/i }));
    await user.click(screen.getByRole("button", { name: /proceed/i }));

    await screen.findByTestId("projects-grid");
    expect(screen.queryByText("My Project")).not.toBeInTheDocument();
    expect(screen.queryByTestId("project-card-proj-1")).not.toBeInTheDocument();
  });

  it("dispatches error notification when archive fails", async () => {
    mockProjectsList.mockResolvedValue([mockProject]);
    mockArchive.mockRejectedValue(new Error("Folder not found"));
    const user = userEvent.setup();

    const store = configureStore({ reducer: { notification: notificationReducer } });
    render(
      <Provider store={store}>
        <MemoryRouter>
          <HomeScreen />
        </MemoryRouter>
      </Provider>
    );

    await screen.findByText("My Project");
    await user.click(screen.getByTestId("project-card-menu-proj-1"));
    await user.click(screen.getByRole("menuitem", { name: /archive/i }));
    await user.click(screen.getByRole("button", { name: /proceed/i }));

    expect(store.getState().notification.items).toHaveLength(1);
    expect(store.getState().notification.items[0].message).toBe("Folder not found");
    expect(store.getState().notification.items[0].severity).toBe("error");
  });

  it("dispatches error notification when delete fails", async () => {
    mockProjectsList.mockResolvedValue([mockProject]);
    mockDelete.mockRejectedValue(new Error("Permission denied"));
    const user = userEvent.setup();

    const store = configureStore({ reducer: { notification: notificationReducer } });
    render(
      <Provider store={store}>
        <MemoryRouter>
          <HomeScreen />
        </MemoryRouter>
      </Provider>
    );

    await screen.findByText("My Project");
    await user.click(screen.getByTestId("project-card-menu-proj-1"));
    await user.click(screen.getByRole("menuitem", { name: /delete/i }));
    await user.click(screen.getByRole("button", { name: /proceed/i }));

    expect(store.getState().notification.items).toHaveLength(1);
    expect(store.getState().notification.items[0].message).toBe("Permission denied");
    expect(store.getState().notification.items[0].severity).toBe("error");
  });

  it("project list container uses wider homepage layout (HOMEPAGE_CONTAINER_CLASS)", async () => {
    mockProjectsList.mockResolvedValue([]);

    renderHomeScreen();

    await screen.findByTestId("projects-grid");
    const container = screen.getByTestId("project-list-container");
    for (const cls of HOMEPAGE_CONTAINER_CLASS.split(" ")) {
      expect(container).toHaveClass(cls);
    }
  });

  it("projects grid uses w-full to fill container", async () => {
    mockProjectsList.mockResolvedValue([]);

    renderHomeScreen();

    const grid = await screen.findByTestId("projects-grid");
    expect(grid).toHaveClass("w-full");
  });

  it("project name and path have title attribute for full text tooltip on hover", async () => {
    const longPath = "/Users/todd/opensprint.dev";
    mockProjectsList.mockResolvedValue([
      { ...mockProject, name: "My Project", repoPath: longPath },
    ]);

    renderHomeScreen();

    await screen.findByText("My Project");
    const card = screen.getByTestId("project-card-proj-1");
    const nameDiv = card.querySelector('[title="My Project"]');
    const pathDiv = card.querySelector(`[title="${longPath}"]`);
    expect(nameDiv).toBeInTheDocument();
    expect(pathDiv).toBeInTheDocument();
  });

  it("layout remains consistent with long project names and paths", async () => {
    const longName = "A".repeat(200);
    const longPath = "/very/long/path/" + "segment/".repeat(50);
    mockProjectsList.mockResolvedValue([
      { ...mockProject, id: "proj-long", name: longName, repoPath: longPath },
    ]);

    renderHomeScreen();

    await screen.findByTestId("projects-grid");
    const container = screen.getByTestId("project-list-container");
    const grid = screen.getByTestId("projects-grid");

    for (const cls of HOMEPAGE_CONTAINER_CLASS.split(" ")) {
      expect(container).toHaveClass(cls);
    }
    expect(grid).toHaveClass("w-full");
    const card = screen.getByTestId("project-card-proj-long");
    expect(card.querySelector(".truncate")).toBeInTheDocument();
  });

  it("clicking outside dropdown closes it", async () => {
    mockProjectsList.mockResolvedValue([mockProject]);
    const user = userEvent.setup();

    renderHomeScreen();

    await screen.findByText("My Project");
    await user.click(screen.getByTestId("project-card-menu-proj-1"));
    expect(screen.getByTestId("project-card-dropdown-proj-1")).toBeInTheDocument();

    await user.click(document.body);
    expect(screen.queryByTestId("project-card-dropdown-proj-1")).not.toBeInTheDocument();
  });
});
