import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { CreateNewProjectPage } from "./CreateNewProjectPage";
import { ApiError } from "../api/client";
import { GITHUB_REPO_URL } from "../lib/constants";

function LocationDisplay() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

const mockScaffold = vi.fn();
const mockGetKeys = vi.fn();
const mockGetRuntime = vi.fn();
const mockGlobalSettingsGet = vi.fn();
const originalNavigator = global.navigator;

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      projects: {
        ...actual.api.projects,
        scaffold: (...args: unknown[]) => mockScaffold(...args),
      },
      globalSettings: {
        ...actual.api.globalSettings,
        get: () => mockGlobalSettingsGet(),
      },
      env: {
        ...actual.api.env,
        getRuntime: () => mockGetRuntime(),
        getKeys: (...args: unknown[]) => mockGetKeys(...args),
        saveKey: vi.fn().mockResolvedValue({ saved: true }),
      },
    },
  };
});

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

function setNavigator(platform: string, userAgent: string) {
  vi.stubGlobal("navigator", {
    ...originalNavigator,
    platform,
    userAgent,
  });
}

function getInstructionsPre() {
  return screen.getByText(
    (_content, element) =>
      element?.tagName === "PRE" && !!element.textContent?.includes("npm run web")
  );
}

const defaultScaffoldResponse = {
  project: { id: "proj-1", name: "My App", repoPath: "/path/to/parent/My App" },
};

describe("CreateNewProjectPage", () => {
  beforeEach(() => {
    setNavigator("Linux x86_64", "Mozilla/5.0 (X11; Linux x86_64)");
    mockScaffold.mockReset();
    mockGetRuntime.mockReset();
    mockScaffold.mockResolvedValue(defaultScaffoldResponse);
    mockGlobalSettingsGet.mockResolvedValue({
      databaseUrl: "",
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "a", masked: "••••••••" }],
        CURSOR_API_KEY: [{ id: "b", masked: "••••••••" }],
      },
    });
    mockGetKeys.mockResolvedValue({
      anthropic: true,
      cursor: true,
      openai: true,
      claudeCli: true,
      useCustomCli: false,
    });
    mockGetRuntime.mockResolvedValue({
      platform: "linux",
      isWsl: false,
      wslDistroName: null,
      repoPathPolicy: "any",
    });
  });

  afterEach(() => {
    vi.stubGlobal("navigator", originalNavigator);
  });

  it("renders Create New Project title", () => {
    renderCreateNewProjectPage();
    expect(screen.getByRole("heading", { name: /create new project/i })).toBeInTheDocument();
  });

  it("Cancel button navigates to homepage", async () => {
    mockGetKeys.mockResolvedValue({
      anthropic: true,
      cursor: true,
      openai: true,
      claudeCli: true,
      useCustomCli: false,
    });
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
    expect(screen.getByRole("link", { name: "Request a template" })).toHaveAttribute(
      "href",
      `${GITHUB_REPO_URL}/issues/new`
    );
  });

  it("shows 'Project files will be created in this folder' label under directory picker", () => {
    renderCreateNewProjectPage();
    expect(screen.getByText("Project files will be created in this folder")).toBeInTheDocument();
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

  it("defaults provider to first with API key (Claude when anthropic has keys)", async () => {
    const user = userEvent.setup();
    mockGlobalSettingsGet.mockResolvedValue({
      databaseUrl: "",
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "a", masked: "••••••••" }],
        CURSOR_API_KEY: [],
        OPENAI_API_KEY: [],
      },
    });
    mockGetKeys.mockResolvedValue({
      anthropic: true,
      cursor: false,
      openai: false,
      claudeCli: true,
      useCustomCli: false,
    });

    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));

    await screen.findByTestId("simplified-agents-step");
    const providerSelects = screen.getAllByRole("combobox");
    expect(providerSelects[0]).toHaveValue("claude");
    expect(providerSelects[2]).toHaveValue("claude");
  });

  it("shows no-API-keys warning when 0 providers have keys and Custom is not selected", async () => {
    const user = userEvent.setup();
    mockGlobalSettingsGet.mockResolvedValue({
      databaseUrl: "",
      apiKeys: {
        ANTHROPIC_API_KEY: [],
        CURSOR_API_KEY: [],
        OPENAI_API_KEY: [],
      },
    });
    mockGetKeys.mockResolvedValue({
      anthropic: false,
      cursor: false,
      openai: false,
      claudeCli: true,
      useCustomCli: false,
    });

    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));

    expect(await screen.findByTestId("no-api-keys-warning")).toBeInTheDocument();
    expect(screen.getByTestId("no-api-keys-settings-link")).toHaveAttribute("href", "/settings");
  });

  it("does not show no-API-keys warning when Custom provider selected for both", async () => {
    const user = userEvent.setup();
    mockGlobalSettingsGet.mockResolvedValue({
      databaseUrl: "",
      apiKeys: {
        ANTHROPIC_API_KEY: [],
        CURSOR_API_KEY: [],
        OPENAI_API_KEY: [],
      },
    });
    mockGetKeys.mockResolvedValue({
      anthropic: false,
      cursor: false,
      openai: false,
      claudeCli: true,
      useCustomCli: false,
    });

    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));

    await screen.findByTestId("simplified-agents-step");

    const comboboxes = screen.getAllByRole("combobox");
    await user.selectOptions(comboboxes[0], "custom");
    await user.selectOptions(comboboxes[2], "custom");
    const cliInputs = screen.getAllByPlaceholderText(/e\.g\. my-agent/);
    await user.type(cliInputs[0], "my-agent");
    await user.type(cliInputs[1], "my-agent");

    expect(screen.queryByTestId("no-api-keys-warning")).not.toBeInTheDocument();
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
    expect(screen.getByPlaceholderText("/Users/you/projects/my-app")).toHaveValue(
      "/path/to/parent"
    );
  });

  it("advances to scaffold step from agents and scaffolds on mount", async () => {
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));
    await user.click(screen.getByTestId("next-button"));

    expect(screen.getByTestId("create-new-scaffold-step")).toBeInTheDocument();
    expect(screen.getByText("Step 3 of 3")).toBeInTheDocument();
    await screen.findByText(/your project is ready/i);
    expect(screen.getByTestId("im-ready-button")).toBeInTheDocument();
  });

  it("calls scaffold API when entering scaffold step", async () => {
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));
    await user.click(screen.getByTestId("next-button"));

    await screen.findByText(/your project is ready/i);

    expect(mockScaffold).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "My App",
        parentPath: "/path/to/parent",
        template: "web-app-expo-react",
      })
    );
  });

  it("shows quoted Unix run instructions and I'm Ready after successful scaffold", async () => {
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));
    await user.click(screen.getByTestId("next-button"));

    await screen.findByText(/your project is ready/i);
    expect(screen.getByText(/run these commands in order/i)).toBeInTheDocument();
    expect(getInstructionsPre()).toHaveTextContent('cd "/path/to/parent/My App"');
    expect(getInstructionsPre()).toHaveTextContent("npm run web");
    expect(screen.getByTestId("im-ready-button")).toBeInTheDocument();
  });

  it("shows WSL run instructions for a Windows browser when the backend is running in WSL", async () => {
    setNavigator("Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    mockGetRuntime.mockResolvedValue({
      platform: "linux",
      isWsl: true,
      wslDistroName: "Ubuntu",
      repoPathPolicy: "linux_fs_only",
    });
    mockScaffold.mockResolvedValue({
      project: {
        id: "proj-1",
        name: "My App",
        repoPath: "/home/todd/My App",
      },
    });
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/home/todd");
    await user.click(screen.getByTestId("next-button"));
    await user.click(screen.getByTestId("next-button"));

    await screen.findByText(/your project is ready/i);
    expect(screen.getByText(/run these commands in your wsl terminal/i)).toBeInTheDocument();
    expect(getInstructionsPre()).toHaveTextContent('cd "/home/todd/My App"');
    expect(getInstructionsPre()).toHaveTextContent("npm run web");
    expect(getInstructionsPre()).not.toHaveTextContent("&&");
    expect(getInstructionsPre()).not.toHaveTextContent("pushd");
  });

  it("shows Windows-safe run instructions when the backend itself is native Windows", async () => {
    setNavigator("Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    mockGetRuntime.mockResolvedValue({
      platform: "win32",
      isWsl: false,
      wslDistroName: null,
      repoPathPolicy: "any",
    });
    mockScaffold.mockResolvedValue({
      project: {
        id: "proj-1",
        name: "My App",
        repoPath: "C:\\Users\\Todd\\My App",
      },
    });
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "C:\\Users\\Todd");
    await user.click(screen.getByTestId("next-button"));
    await user.click(screen.getByTestId("next-button"));

    await screen.findByText(/your project is ready/i);
    expect(getInstructionsPre()).toHaveTextContent('pushd "C:\\Users\\Todd\\My App"');
    expect(getInstructionsPre()).toHaveTextContent("npm run web");
    expect(getInstructionsPre()).not.toHaveTextContent("&&");
    expect(getInstructionsPre()).not.toHaveTextContent("cd /d");
  });

  it("blocks /mnt paths when the backend runtime is WSL", async () => {
    mockGetRuntime.mockResolvedValue({
      platform: "linux",
      isWsl: true,
      wslDistroName: "Ubuntu",
      repoPathPolicy: "linux_fs_only",
    });
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/mnt/c/Users/Todd");

    expect(await screen.findByTestId("repository-step-error")).toHaveTextContent(
      /project repos must be in the wsl filesystem/i
    );
    expect(screen.getByTestId("next-button")).toBeDisabled();
  });

  it("I'm Ready navigates to project sketch phase", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/projects/create-new"]}>
        <CreateNewProjectPage />
        <LocationDisplay />
      </MemoryRouter>
    );
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));
    await user.click(screen.getByTestId("next-button"));

    await screen.findByText(/your project is ready/i);
    await user.click(screen.getByTestId("im-ready-button"));

    expect(screen.getByTestId("location")).toHaveTextContent("/projects/proj-1/sketch");
  });

  it("shows Building your project spinner during scaffold", async () => {
    let resolveScaffold: (value: typeof defaultScaffoldResponse) => void;
    mockScaffold.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScaffold = resolve;
        })
    );
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));
    await user.click(screen.getByTestId("next-button"));

    expect(screen.getByText("Building your project...")).toBeInTheDocument();

    resolveScaffold!(defaultScaffoldResponse);
    await screen.findByText(/your project is ready/i);
  });

  it("shows error when scaffold fails", async () => {
    mockScaffold.mockRejectedValue(new Error("Folder already exists"));
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));
    await user.click(screen.getByTestId("next-button"));

    const errors = await screen.findAllByText("Folder already exists");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId("scaffold-retry-button")).toBeInTheDocument();
  });

  it("shows clear actionable error when prerequisites (git/node) are missing", async () => {
    const prereqMsg =
      "Git is not installed or not available in PATH. Install Git from https://git-scm.com/ and ensure it is in your PATH, then try again.";
    mockScaffold.mockRejectedValue(
      new ApiError(prereqMsg, "SCAFFOLD_PREREQUISITES_MISSING", { missing: ["Git"] })
    );
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));
    await user.click(screen.getByTestId("next-button"));

    const errorDetails = await screen.findByTestId("scaffold-error-details");
    expect(errorDetails).toHaveTextContent(/git.*not installed/i);
    expect(errorDetails).toHaveTextContent("https://git-scm.com/");
    expect(errorDetails).toHaveTextContent(/path/i);
    expect(screen.getByTestId("scaffold-retry-button")).toBeInTheDocument();
    const installGit = screen.getByTestId("install-git-button");
    expect(installGit).toBeInTheDocument();
    expect(installGit).toHaveAttribute("href", "https://git-scm.com/");
    expect(installGit).toHaveAttribute("target", "_blank");
  });

  it("shows one-click Install buttons for each missing prerequisite", async () => {
    mockScaffold.mockRejectedValue(
      new ApiError("Git and Node.js are not installed.", "SCAFFOLD_PREREQUISITES_MISSING", {
        missing: ["Git", "Node.js"],
      })
    );
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));
    await user.click(screen.getByTestId("next-button"));

    await screen.findByTestId("prereq-install-buttons");
    expect(screen.getByTestId("install-git-button")).toHaveAttribute(
      "href",
      "https://git-scm.com/"
    );
    expect(screen.getByTestId("install-nodejs-button")).toHaveAttribute(
      "href",
      "https://nodejs.org/"
    );
  });

  it("loads env keys when entering agents step", async () => {
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));

    expect(screen.getByTestId("simplified-agents-step")).toBeInTheDocument();
    expect(mockGlobalSettingsGet).toHaveBeenCalled();
    expect(mockGetKeys).toHaveBeenCalled();
  });

  it("disables Next on agents step when env keys are loading", async () => {
    let resolveGlobalSettings: (value: { databaseUrl: string; apiKeys?: unknown }) => void;
    let resolveGetKeys: (value: {
      anthropic: boolean;
      cursor: boolean;
      openai: boolean;
      claudeCli: boolean;
      useCustomCli: boolean;
    }) => void;
    mockGlobalSettingsGet.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGlobalSettings = resolve;
        })
    );
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

    resolveGlobalSettings!({
      databaseUrl: "",
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "a", masked: "••••••••" }],
        CURSOR_API_KEY: [{ id: "b", masked: "••••••••" }],
      },
    });
    resolveGetKeys!({
      anthropic: true,
      cursor: true,
      openai: true,
      claudeCli: true,
      useCustomCli: false,
    });
    await screen.findByTestId("next-button");
    expect(screen.getByTestId("next-button")).toBeEnabled();
  });

  it("disables Next on agents step when cursor selected but API key missing", async () => {
    mockGlobalSettingsGet.mockResolvedValue({
      databaseUrl: "",
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "a", masked: "••••••••" }],
      },
    });
    mockGetKeys.mockResolvedValue({
      anthropic: true,
      cursor: false,
      openai: true,
      claudeCli: true,
      useCustomCli: false,
    });
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));

    await screen.findByTestId("simplified-agents-step");
    // Default is claude (first with keys); select cursor which has no key
    const providerSelects = screen.getAllByRole("combobox");
    await user.selectOptions(providerSelects[0], "cursor");
    expect(screen.getByTestId("next-button")).toBeDisabled();
  });

  it("disables Next on agents step when claude selected but API key missing", async () => {
    mockGlobalSettingsGet.mockResolvedValue({
      databaseUrl: "",
      apiKeys: {
        CURSOR_API_KEY: [{ id: "b", masked: "••••••••" }],
      },
    });
    mockGetKeys.mockResolvedValue({
      anthropic: false,
      cursor: true,
      openai: true,
      claudeCli: true,
      useCustomCli: false,
    });
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
    mockGetKeys.mockResolvedValue({
      anthropic: true,
      cursor: true,
      openai: true,
      claudeCli: false,
      useCustomCli: false,
    });
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
    mockGetKeys.mockResolvedValue({
      anthropic: true,
      cursor: true,
      openai: true,
      claudeCli: true,
      useCustomCli: false,
    });
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
    mockGetKeys.mockResolvedValue({
      anthropic: true,
      cursor: true,
      openai: true,
      claudeCli: true,
      useCustomCli: false,
    });
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

    await screen.findByText(/your project is ready/i);

    expect(mockScaffold).toHaveBeenCalledWith(
      expect.objectContaining({
        simpleComplexityAgent: expect.objectContaining({ type: "claude" }),
        complexComplexityAgent: expect.objectContaining({ type: "cursor" }),
      })
    );
  });

  it("shows recovery info when scaffold fails with agent recovery details", async () => {
    const apiErr = new ApiError("Node.js is not installed", "SCAFFOLD_INIT_FAILED", {
      recovery: {
        attempted: true,
        success: false,
        errorCategory: "missing_node",
        errorSummary: "Node.js is not installed or not in PATH",
      },
    });
    mockScaffold.mockRejectedValue(apiErr);
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));
    await user.click(screen.getByTestId("next-button"));

    await screen.findByTestId("scaffold-error-details");
    expect(screen.getByTestId("scaffold-recovery-info")).toBeInTheDocument();
    expect(screen.getByText(/Agent recovery attempted/)).toBeInTheDocument();
    expect(screen.getByText(/Node\.js is not installed or not in PATH/)).toBeInTheDocument();
    expect(screen.getByText(/could not resolve/i)).toBeInTheDocument();
  });

  it("shows non-recoverable error info when recovery was not attempted", async () => {
    const apiErr = new ApiError("Network error", "SCAFFOLD_INIT_FAILED", {
      recovery: {
        attempted: false,
        success: false,
        errorCategory: "network_error",
        errorSummary: "Network error — check your internet connection",
      },
    });
    mockScaffold.mockRejectedValue(apiErr);
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));
    await user.click(screen.getByTestId("next-button"));

    await screen.findByTestId("scaffold-error-details");
    expect(screen.getByTestId("scaffold-recovery-info")).toBeInTheDocument();
    expect(screen.getByText(/Recovery not attempted/)).toBeInTheDocument();
    expect(screen.getByText(/manual intervention/i)).toBeInTheDocument();
  });

  it("shows recovery success banner when scaffold succeeds after recovery", async () => {
    mockScaffold.mockResolvedValue({
      ...defaultScaffoldResponse,
      recovery: {
        attempted: true,
        success: true,
        errorCategory: "missing_npm",
        errorSummary: "npm is not installed or not in PATH",
      },
    });
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));
    await user.click(screen.getByTestId("next-button"));

    await screen.findByText(/your project is ready/i);
    expect(screen.getByTestId("scaffold-recovery-success")).toBeInTheDocument();
    expect(screen.getByText(/automatically resolved/i)).toBeInTheDocument();
    expect(screen.getByText(/npm is not installed/i)).toBeInTheDocument();
  });

  it("clears recovery info on retry", async () => {
    const apiErr = new ApiError("npm not found", "SCAFFOLD_INIT_FAILED", {
      recovery: {
        attempted: true,
        success: false,
        errorCategory: "missing_npm",
        errorSummary: "npm is not installed",
      },
    });
    mockScaffold.mockRejectedValueOnce(apiErr).mockResolvedValueOnce(defaultScaffoldResponse);
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));
    await user.click(screen.getByTestId("next-button"));

    await screen.findByTestId("scaffold-recovery-info");
    await user.click(screen.getByTestId("scaffold-retry-button"));

    await screen.findByText(/your project is ready/i);
    expect(screen.queryByTestId("scaffold-recovery-info")).not.toBeInTheDocument();
  });

  it("shows detailed error message with Initialization failed header", async () => {
    const apiErr = new ApiError(
      "Recovery agent ran but the command still failed: npx not found",
      "SCAFFOLD_INIT_FAILED",
      {
        recovery: {
          attempted: true,
          success: false,
          errorCategory: "missing_npx",
          errorSummary: "npx is not installed or not in PATH",
          agentOutput: "Tried to install node...",
        },
      }
    );
    mockScaffold.mockRejectedValue(apiErr);
    const user = userEvent.setup();
    renderCreateNewProjectPage();
    await user.type(screen.getByLabelText(/project name/i), "My App");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/parent");
    await user.click(screen.getByTestId("next-button"));
    await user.click(screen.getByTestId("next-button"));

    const errorDetails = await screen.findByTestId("scaffold-error-details");
    expect(screen.getByText("Initialization failed")).toBeInTheDocument();
    const errorTextElements = screen.getAllByText(
      /Recovery agent ran but the command still failed/i
    );
    expect(errorTextElements.length).toBeGreaterThanOrEqual(1);
    expect(errorDetails).toBeInTheDocument();
  });
});
