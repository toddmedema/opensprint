import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { HomeScreen } from "./HomeScreen";

const mockProjectsList = vi.fn();

vi.mock("../api/client", () => ({
  api: {
    projects: { list: (...args: unknown[]) => mockProjectsList(...args) },
  },
}));

vi.mock("./layout/Layout", () => ({
  Layout: ({ children }: { children: React.ReactNode }) => <div data-testid="layout">{children}</div>,
}));

function renderHomeScreen() {
  return render(
    <MemoryRouter>
      <HomeScreen />
    </MemoryRouter>,
  );
}

const mockProject = {
  id: "proj-1",
  name: "My Project",
  description: "A test project",
  currentPhase: "sketch",
  progressPercent: 25,
  updatedAt: "2026-02-15T12:00:00Z",
};

describe("HomeScreen", () => {
  it("shows loading state while fetching projects", async () => {
    mockProjectsList.mockImplementation(() => new Promise(() => {}));

    renderHomeScreen();

    expect(screen.getByText("Loading projects...")).toBeInTheDocument();
  });

  it("shows empty state when no projects", async () => {
    mockProjectsList.mockResolvedValue([]);

    renderHomeScreen();

    await screen.findByText("No projects yet");
    expect(screen.getByText("Get started by creating your first project")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /create new project/i })).toHaveLength(2);
  });

  it("renders project cards when projects exist", async () => {
    mockProjectsList.mockResolvedValue([mockProject]);

    renderHomeScreen();

    await screen.findByText("My Project");
    expect(screen.getByText("A test project")).toBeInTheDocument();
    expect(screen.getByText("Sketch")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
  });

  it("Create New Project button navigates to /projects/new", async () => {
    mockProjectsList.mockResolvedValue([]);
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <HomeScreen />
      </MemoryRouter>,
    );

    await screen.findByText("No projects yet");
    const createButton = screen.getAllByRole("button", { name: /create new project/i })[0];
    await user.click(createButton);

    expect(window.location.pathname).toBe("/projects/new");
  });

  it("project grid has improved spacing (gap-8 lg:gap-12)", async () => {
    mockProjectsList.mockResolvedValue([mockProject]);

    renderHomeScreen();

    await screen.findByText("My Project");
    const grid = screen.getByText("My Project").closest(".grid");
    expect(grid).toHaveClass("gap-8");
    expect(grid).toHaveClass("lg:gap-12");
  });

  it("project cards have increased padding (p-8)", async () => {
    mockProjectsList.mockResolvedValue([mockProject]);

    renderHomeScreen();

    await screen.findByText("My Project");
    const card = screen.getByRole("link", { name: /my project/i });
    expect(card).toHaveClass("p-8");
  });

  it("project card links to correct phase path", async () => {
    mockProjectsList.mockResolvedValue([mockProject]);

    renderHomeScreen();

    await screen.findByText("My Project");
    const link = screen.getByRole("link", { name: /my project/i });
    expect(link).toHaveAttribute("href", "/projects/proj-1/sketch");
  });
});
