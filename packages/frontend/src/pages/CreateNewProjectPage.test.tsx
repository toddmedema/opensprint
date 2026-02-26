import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { CreateNewProjectPage } from "./CreateNewProjectPage";

function LocationDisplay() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

const mockScaffold = vi.fn();
const mockGetKeys = vi.fn();

vi.mock("../api/client", () => ({
  api: {
    projects: {
      scaffold: (...args: unknown[]) => mockScaffold(...args),
    },
    env: {
      getKeys: (...args: unknown[]) => mockGetKeys(...args),
      saveKey: vi.fn().mockResolvedValue({ saved: true }),
    },
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

function renderCreateNewProjectPage() {
  return render(
    <MemoryRouter>
      <CreateNewProjectPage />
    </MemoryRouter>
  );
}

describe("CreateNewProjectPage", () => {
  beforeEach(() => {
    mockScaffold.mockReset();
    mockGetKeys.mockResolvedValue({ anthropic: true, cursor: true, claudeCli: true });
  });

  it("renders Create New Project title", () => {
    renderCreateNewProjectPage();
    expect(screen.getByRole("heading", { name: /create new project/i })).toBeInTheDocument();
  });

  it("Cancel button navigates to homepage", async () => {
    mockGetKeys.mockResolvedValue({ anthropic: true, cursor: true, claudeCli: true });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/projects/create-new"]}>
        <CreateNewProjectPage />
        <LocationDisplay />
      </MemoryRouter>
    );
    await user.click(screen.getByTestId("cancel-button"));
    expect(screen.getByTestId("location")).toHaveTextContent("/");
  });

  it("shows progress bar with Step 1 of 3", () => {
    renderCreateNewProjectPage();
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("shows Page 1 (basics) with Project Name, Project Folder, Template", () => {
    renderCreateNewProjectPage();
    expect(screen.getByTestId("create-new-basics-step")).toBeInTheDocument();
    expect(screen.getByLabelText(/project name/i)).toBeInTheDocument();
    expect(screen.getByText("Project folder")).toBeInTheDocument();
    expect(screen.getByLabelText(/template/i)).toBeInTheDocument();
    expect(screen.getByTestId("template-select")).toBeInTheDocument();
  });

  it("template dropdown has Web App (Expo/React) option", () => {
    renderCreateNewProjectPage();
    const select = screen.getByTestId("template-select");
    expect(select).toHaveValue("web-app-expo-react");
    expect(screen.getByRole("option", { name: "Web App (Expo/React)" })).toBeInTheDocument();
  });

  it("disables Next when project name is empty", () => {
    renderCreateNewProjectPage();
    const nextButton = screen.getByTestId("next-button");
    expect(nextButton).toBeDisabled();
  });

  it("disables Next when parent path is empty", async () => {
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    const nextButton = screen.getByTestId("next-button");
    expect(nextButton).toBeDisabled();
  });

  it("enables Next when path is filled (validates name on click)", async () => {
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    const nextButton = screen.getByTestId("next-button");
    expect(nextButton).toBeEnabled();
  });

  it("enables Next when name and parent path are filled", async () => {
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    const nextButton = screen.getByTestId("next-button");
    expect(nextButton).toBeEnabled();
  });

  it("shows error when Next clicked with empty name", async () => {
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));
    expect(screen.getByRole("alert")).toHaveTextContent(/project name is required/i);
  });

  it("advances to agents step when Next clicked with valid basics", async () => {
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));

    expect(screen.getByTestId("simplified-agents-step")).toBeInTheDocument();
    expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
    expect(screen.queryByTestId("create-new-basics-step")).not.toBeInTheDocument();
  });

  it("Back from agents returns to basics", async () => {
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));
    expect(screen.getByTestId("simplified-agents-step")).toBeInTheDocument();

    await user.click(screen.getByTestId("back-button"));
    expect(screen.getByTestId("create-new-basics-step")).toBeInTheDocument();
    expect(screen.getByLabelText(/project name/i)).toHaveValue("My App");
    expect(screen.getByPlaceholderText("/Users/you/projects/my-app")).toHaveValue("/path/to/parent");
  });

  it("advances to scaffold step from agents", async () => {
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));
    await user.click(screen.getByTestId("next-button"));

    expect(screen.getByTestId("create-new-scaffold-step")).toBeInTheDocument();
    expect(screen.getByText("Step 3 of 3")).toBeInTheDocument();
    expect(screen.getByTestId("scaffold-button")).toBeInTheDocument();
  });

  it("calls scaffold API when Scaffold clicked", async () => {
    mockScaffold.mockResolvedValue({
      project: { id: "proj-1", name: "My App", repoPath: "/path/to/parent/My App" },
      runCommand: "cd /path/to/parent/My\\ App && npm run web",
    });
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));
    await user.click(screen.getByTestId("next-button"));
    await user.click(screen.getByTestId("scaffold-button"));

    expect(mockScaffold).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "My App",
        parentPath: "/path/to/parent",
        template: "web-app-expo-react",
      })
    );
  });

  it("shows run command and I'm Ready after successful scaffold", async () => {
    mockScaffold.mockResolvedValue({
      project: { id: "proj-1", name: "My App", repoPath: "/path/to/parent/My App" },
      runCommand: "cd /path/to/parent/My\\ App && npm run web",
    });
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));
    await user.click(screen.getByTestId("next-button"));
    await user.click(screen.getByTestId("scaffold-button"));

    await screen.findByText(/your project is ready/i);
    expect(screen.getByText("cd /path/to/parent/My\\ App && npm run web")).toBeInTheDocument();
    expect(screen.getByTestId("im-ready-button")).toBeInTheDocument();
  });

  it("shows error when scaffold fails", async () => {
    mockScaffold.mockRejectedValue(new Error("Folder already exists"));
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));
    await user.click(screen.getByTestId("next-button"));
    await user.click(screen.getByTestId("scaffold-button"));

    const errors = await screen.findAllByText("Folder already exists");
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it("loads env keys when entering agents step", async () => {
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));

    expect(screen.getByTestId("simplified-agents-step")).toBeInTheDocument();
    expect(mockGetKeys).toHaveBeenCalled();
  });

  it("disables Next on agents step when env keys are loading", async () => {
    let resolveGetKeys: (value: { anthropic: boolean; cursor: boolean; claudeCli: boolean }) => void;
    mockGetKeys.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGetKeys = resolve;
        })
    );
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));

    expect(screen.getByTestId("simplified-agents-step")).toBeInTheDocument();
    const nextButton = screen.getByTestId("next-button");
    expect(nextButton).toBeDisabled();

    resolveGetKeys!({ anthropic: true, cursor: true, claudeCli: true });
    await screen.findByTestId("next-button");
    expect(screen.getByTestId("next-button")).toBeEnabled();
  });

  it("disables Next on agents step when cursor selected but API key missing", async () => {
    mockGetKeys.mockResolvedValue({ anthropic: true, cursor: false, claudeCli: true });
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));

    await screen.findByTestId("simplified-agents-step");
    expect(screen.getByTestId("next-button")).toBeDisabled();
  });

  it("disables Next on agents step when claude selected but API key missing", async () => {
    mockGetKeys.mockResolvedValue({ anthropic: false, cursor: true, claudeCli: true });
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));

    await screen.findByTestId("simplified-agents-step");
    const providerSelects = screen.getAllByRole("combobox");
    await user.selectOptions(providerSelects[0], "claude");
    expect(screen.getByTestId("next-button")).toBeDisabled();
  });

  it("disables Next on agents step when claude-cli selected but CLI not available", async () => {
    mockGetKeys.mockResolvedValue({ anthropic: true, cursor: true, claudeCli: false });
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));

    await screen.findByTestId("simplified-agents-step");
    const providerSelects = screen.getAllByRole("combobox");
    await user.selectOptions(providerSelects[0], "claude-cli");
    expect(screen.getByTestId("next-button")).toBeDisabled();
  });

  it("disables Next on agents step when custom CLI selected but cliCommand empty", async () => {
    mockGetKeys.mockResolvedValue({ anthropic: true, cursor: true, claudeCli: true });
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));

    await screen.findByTestId("simplified-agents-step");
    const providerSelects = screen.getAllByRole("combobox");
    await user.selectOptions(providerSelects[0], "custom");
    expect(screen.getByTestId("next-button")).toBeDisabled();
  });

  it("enables Next on agents step when custom CLI has cliCommand", async () => {
    mockGetKeys.mockResolvedValue({ anthropic: true, cursor: true, claudeCli: true });
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));

    await screen.findByTestId("simplified-agents-step");
    const providerSelects = screen.getAllByRole("combobox");
    await user.selectOptions(providerSelects[0], "custom");
    await user.type(screen.getByPlaceholderText(/e\.g\. my-agent/), "my-agent");
    expect(screen.getByTestId("next-button")).toBeEnabled();
  });

  it("passes agent config to scaffold API", async () => {
    mockScaffold.mockResolvedValue({
      project: { id: "proj-1", name: "My App", repoPath: "/path/to/parent/My App" },
      runCommand: "cd /path/to/parent/My\\ App && npm run web",
    });
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));
    await screen.findByTestId("simplified-agents-step");
    const providerSelects = screen.getAllByRole("combobox");
    await user.selectOptions(providerSelects[0], "claude");
    await user.selectOptions(providerSelects[2], "cursor");
    await user.click(screen.getByTestId("next-button"));
    await user.click(screen.getByTestId("scaffold-button"));

    expect(mockScaffold).toHaveBeenCalledWith(
      expect.objectContaining({
        simpleComplexityAgent: expect.objectContaining({ type: "claude" }),
        complexComplexityAgent: expect.objectContaining({ type: "cursor" }),
      })
    );
  });
});
