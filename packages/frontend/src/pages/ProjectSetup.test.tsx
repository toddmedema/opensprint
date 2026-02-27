import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { ProjectSetup } from "./ProjectSetup";

function LocationDisplay() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

// Mock the API and Layout to avoid network calls and complex layout
vi.mock("../api/client", () => ({
  api: {
    projects: {
      create: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
    },
    env: {
      getKeys: vi.fn().mockResolvedValue({
        anthropic: true,
        cursor: true,
        claudeCli: true,
        useCustomCli: false,
      }),
    },
    filesystem: { detectTestFramework: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock("../components/layout/Layout", () => ({
  Layout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="layout">{children}</div>
  ),
}));

vi.mock("../components/FolderBrowser", () => ({
  FolderBrowser: () => null,
}));

vi.mock("../components/ModelSelect", () => ({
  ModelSelect: () => <select data-testid="model-select" />,
}));

function renderProjectSetup(initialRoute = "/projects/add-existing") {
  return render(
    <MemoryRouter initialEntries={[initialRoute]}>
      <ProjectSetup />
    </MemoryRouter>
  );
}

describe("ProjectSetup - Step 1 validation", () => {
  it("shows project info step (name and repository) on first load", () => {
    renderProjectSetup();

    expect(screen.getByTestId("project-metadata-step")).toBeInTheDocument();
    expect(screen.getByLabelText(/project name/i)).toBeInTheDocument();
    expect(screen.getByTestId("repository-step")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("/Users/you/projects/my-app")).toBeInTheDocument();
  });

  it("disables Next when repo path is empty", () => {
    renderProjectSetup();

    const nextButton = screen.getByRole("button", { name: /next/i });
    expect(nextButton).toBeDisabled();
  });

  it("blocks Next when name is empty and shows error on click", async () => {
    const user = userEvent.setup();
    renderProjectSetup();

    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/repo");
    const nextButton = screen.getByRole("button", { name: /next/i });
    expect(nextButton).toBeEnabled();

    await user.click(nextButton);

    expect(screen.getByRole("alert")).toHaveTextContent(/project name is required/i);
    expect(screen.getByTestId("project-metadata-step")).toBeInTheDocument();
  });

  it("advances to agent config when name and repo path are filled", async () => {
    const user = userEvent.setup();
    renderProjectSetup();

    await user.type(screen.getByLabelText(/project name/i), "My Project");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/repo");
    await user.click(screen.getByRole("button", { name: /next/i }));

    expect(screen.queryByTestId("project-metadata-step")).not.toBeInTheDocument();
    expect(screen.queryByTestId("repository-step")).not.toBeInTheDocument();
    expect(screen.getByTestId("agents-step")).toBeInTheDocument();
  });
});

describe("ProjectSetup - Progress indicator", () => {
  it("renders a progressbar with Step X of Y and current step in heading", () => {
    renderProjectSetup();

    const progressbar = screen.getByRole("progressbar", {
      name: /step 1 of 5/i,
    });
    expect(progressbar).toBeInTheDocument();
    expect(progressbar).toHaveAttribute("aria-valuenow", "1");
    expect(progressbar).toHaveAttribute("aria-valuemin", "1");
    expect(progressbar).toHaveAttribute("aria-valuemax", "5");

    expect(screen.getByText("Step 1 of 5")).toBeInTheDocument();
    expect(screen.getByText(/Add Existing Project/)).toBeInTheDocument();
    expect(screen.getByText(/— Project Info/)).toBeInTheDocument();
  });

  it("progress bar fill reflects current step", () => {
    renderProjectSetup();

    const progressbar = screen.getByRole("progressbar", { name: /step 1 of 5/i });
    const fill = progressbar.querySelector("[style*='width']");
    expect(fill).toBeInTheDocument();
    expect((fill as HTMLElement).style.width).toBe("20%");
  });

  it("updates step label in heading when navigating to next step", async () => {
    const user = userEvent.setup();
    renderProjectSetup();

    expect(screen.getByText(/— Project Info/)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/project name/i), "My Project");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/repo");
    await user.click(screen.getByRole("button", { name: /next/i }));

    expect(screen.getByRole("progressbar", { name: /step 2 of 5/i })).toBeInTheDocument();
    expect(screen.getByText(/— Agent Config/)).toBeInTheDocument();
  });
});

describe("ProjectSetup - Cancel button", () => {
  it("Cancel button navigates to homepage", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/projects/add-existing"]}>
        <ProjectSetup />
        <LocationDisplay />
      </MemoryRouter>
    );
    await user.click(screen.getByTestId("cancel-button"));
    expect(screen.getByTestId("location")).toHaveTextContent("/");
  });
});

describe("ProjectSetup - Add Existing flow (no Delivery step)", () => {
  it("does not show Delivery step; flow goes basics → agents → testing → hil → confirm", async () => {
    const user = userEvent.setup();
    renderProjectSetup();

    // Step 1: basics
    await user.type(screen.getByLabelText(/project name/i), "My Project");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/repo");
    await user.click(screen.getByRole("button", { name: /next/i }));

    // Step 2: agents
    expect(screen.getByTestId("agents-step")).toBeInTheDocument();
    expect(screen.queryByTestId("deployment-step")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /next/i }));

    // Step 3: testing
    expect(screen.getByTestId("testing-step")).toBeInTheDocument();
    expect(screen.queryByTestId("deployment-step")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /next/i }));

    // Step 4: hil (skipped deployment)
    expect(screen.getByTestId("hil-step")).toBeInTheDocument();
    expect(screen.queryByTestId("deployment-step")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /next/i }));

    // Step 5: confirm
    expect(screen.getByTestId("confirm-step")).toBeInTheDocument();
    expect(screen.queryByTestId("deployment-step")).not.toBeInTheDocument();
    expect(screen.queryByText("Deliver")).not.toBeInTheDocument();
  });
});

describe("ProjectSetup - Back button", () => {
  it("Back button returns to previous step", async () => {
    const user = userEvent.setup();
    renderProjectSetup();

    await user.type(screen.getByLabelText(/project name/i), "My Project");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/repo");
    await user.click(screen.getByRole("button", { name: /next/i }));

    expect(screen.getByTestId("agents-step")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /back/i }));

    expect(screen.getByTestId("project-metadata-step")).toBeInTheDocument();
    expect(screen.getByTestId("repository-step")).toBeInTheDocument();
  });
});
