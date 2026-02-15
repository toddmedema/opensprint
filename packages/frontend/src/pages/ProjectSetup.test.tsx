import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ProjectSetup } from "./ProjectSetup";

// Mock the API and Layout to avoid network calls and complex layout
vi.mock("../api/client", () => ({
  api: {
    projects: { create: vi.fn() },
    env: { getKeys: vi.fn().mockResolvedValue({ anthropic: true, cursor: true }) },
    filesystem: { detectTestFramework: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock("../components/layout/Layout", () => ({
  Layout: ({ children }: { children: React.ReactNode }) => <div data-testid="layout">{children}</div>,
}));

vi.mock("../components/FolderBrowser", () => ({
  FolderBrowser: () => null,
}));

vi.mock("../components/ModelSelect", () => ({
  ModelSelect: () => <select data-testid="model-select" />,
}));

function renderProjectSetup() {
  return render(
    <MemoryRouter>
      <ProjectSetup />
    </MemoryRouter>
  );
}

describe("ProjectSetup - Step 1 validation", () => {
  it("shows project metadata step (name and description) on first load", () => {
    renderProjectSetup();

    expect(screen.getByTestId("project-metadata-step")).toBeInTheDocument();
    expect(screen.getByLabelText(/project name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/description/i)).toBeInTheDocument();
  });

  it("blocks Next when name is empty and shows error on click", async () => {
    const user = userEvent.setup();
    renderProjectSetup();

    const nextButton = screen.getByRole("button", { name: /next/i });
    expect(nextButton).toBeEnabled();

    await user.click(nextButton);

    expect(screen.getByRole("alert")).toHaveTextContent(/project name is required/i);
    expect(screen.getByTestId("project-metadata-step")).toBeInTheDocument();
  });

  it("advances to repository step when name is non-empty", async () => {
    const user = userEvent.setup();
    renderProjectSetup();

    await user.type(screen.getByLabelText(/project name/i), "My Project");
    await user.click(screen.getByRole("button", { name: /next/i }));

    expect(screen.queryByTestId("project-metadata-step")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("/Users/you/projects/my-app")).toBeInTheDocument();
  });
});
