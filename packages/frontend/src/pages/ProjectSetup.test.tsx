import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { api } from "../api/client";
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
    globalSettings: {
      get: vi.fn().mockResolvedValue({
        databaseUrl: "",
        apiKeys: {
          ANTHROPIC_API_KEY: [{ id: "a", masked: "••••••••" }],
          CURSOR_API_KEY: [{ id: "b", masked: "••••••••" }],
        },
      }),
    },
    env: {
      getKeys: vi.fn().mockResolvedValue({
        anthropic: true,
        cursor: true,
        openai: true,
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

describe("ProjectSetup - Agents step API key validation", () => {
  it("defaults provider to first with API key (Claude when anthropic has keys)", async () => {
    const user = userEvent.setup();
    vi.mocked(api.globalSettings.get).mockResolvedValue({
      databaseUrl: "",
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "a", masked: "••••••••" }],
        CURSOR_API_KEY: [],
        OPENAI_API_KEY: [],
      },
    });
    vi.mocked(api.env.getKeys).mockResolvedValue({
      anthropic: true,
      cursor: false,
      openai: false,
      claudeCli: true,
      useCustomCli: false,
    });

    renderProjectSetup();
    await user.type(screen.getByLabelText(/project name/i), "My Project");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/repo");
    await user.click(screen.getByRole("button", { name: /next/i }));

    await waitFor(() => {
      expect(screen.getByTestId("agents-step")).toBeInTheDocument();
    });
    const providerSelects = screen.getAllByRole("combobox");
    expect(providerSelects[0]).toHaveValue("claude");
    expect(providerSelects[2]).toHaveValue("claude");
  });

  it("defaults provider to OpenAI when only OpenAI has keys", async () => {
    const user = userEvent.setup();
    vi.mocked(api.globalSettings.get).mockResolvedValue({
      databaseUrl: "",
      apiKeys: {
        ANTHROPIC_API_KEY: [],
        CURSOR_API_KEY: [],
        OPENAI_API_KEY: [{ id: "o", masked: "••••••••" }],
      },
    });
    vi.mocked(api.env.getKeys).mockResolvedValue({
      anthropic: false,
      cursor: false,
      openai: true,
      claudeCli: true,
      useCustomCli: false,
    });

    renderProjectSetup();
    await user.type(screen.getByLabelText(/project name/i), "My Project");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/repo");
    await user.click(screen.getByRole("button", { name: /next/i }));

    await waitFor(() => {
      expect(screen.getByTestId("agents-step")).toBeInTheDocument();
    });
    const providerSelects = screen.getAllByRole("combobox");
    expect(providerSelects[0]).toHaveValue("openai");
    expect(providerSelects[2]).toHaveValue("openai");
  });

  it("shows no-API-keys warning when 0 providers have keys and Custom is not selected", async () => {
    const user = userEvent.setup();
    vi.mocked(api.globalSettings.get).mockResolvedValue({
      databaseUrl: "",
      apiKeys: {
        ANTHROPIC_API_KEY: [],
        CURSOR_API_KEY: [],
        OPENAI_API_KEY: [],
      },
    });
    vi.mocked(api.env.getKeys).mockResolvedValue({
      anthropic: false,
      cursor: false,
      openai: false,
      claudeCli: true,
      useCustomCli: false,
    });

    renderProjectSetup();
    await user.type(screen.getByLabelText(/project name/i), "My Project");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/repo");
    await user.click(screen.getByRole("button", { name: /next/i }));

    await waitFor(() => {
      expect(screen.getByTestId("no-api-keys-warning")).toBeInTheDocument();
    });
    expect(screen.getByTestId("no-api-keys-settings-link")).toHaveAttribute("href", "/settings");
  });

  it("does not show no-API-keys warning when Custom provider selected for both", async () => {
    const user = userEvent.setup();
    vi.mocked(api.globalSettings.get).mockResolvedValue({
      databaseUrl: "",
      apiKeys: {
        ANTHROPIC_API_KEY: [],
        CURSOR_API_KEY: [],
        OPENAI_API_KEY: [],
      },
    });
    vi.mocked(api.env.getKeys).mockResolvedValue({
      anthropic: false,
      cursor: false,
      openai: false,
      claudeCli: true,
      useCustomCli: false,
    });

    renderProjectSetup();
    await user.type(screen.getByLabelText(/project name/i), "My Project");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/repo");
    await user.click(screen.getByRole("button", { name: /next/i }));

    await waitFor(() => {
      expect(screen.getByTestId("agents-step")).toBeInTheDocument();
    });

    const selects = screen.getAllByRole("combobox");
    await user.selectOptions(selects[0], "custom");
    await user.selectOptions(selects[2], "custom");
    await user.type(screen.getAllByPlaceholderText(/e\.g\. my-agent/)[0], "my-agent");
    await user.type(screen.getAllByPlaceholderText(/e\.g\. my-agent/)[1], "my-agent");

    expect(screen.queryByTestId("no-api-keys-warning")).not.toBeInTheDocument();
  });

  it("disables Next when openai is selected and OPENAI_API_KEY is missing", async () => {
    const user = userEvent.setup();
    vi.mocked(api.globalSettings.get).mockResolvedValue({
      databaseUrl: "",
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "a", masked: "••••••••" }],
        CURSOR_API_KEY: [{ id: "b", masked: "••••••••" }],
        OPENAI_API_KEY: [],
      },
    });
    vi.mocked(api.env.getKeys).mockResolvedValue({
      anthropic: true,
      cursor: true,
      openai: false,
      claudeCli: true,
      useCustomCli: false,
    });

    renderProjectSetup();
    await user.type(screen.getByLabelText(/project name/i), "My Project");
    await user.type(screen.getByPlaceholderText("/Users/you/projects/my-app"), "/path/to/repo");
    await user.click(screen.getByRole("button", { name: /next/i }));

    expect(screen.getByTestId("agents-step")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /next/i })).toBeEnabled();
    });

    const selects = screen.getAllByRole("combobox");
    const simpleProviderSelect = selects[0];
    await user.selectOptions(simpleProviderSelect, "openai");

    const nextButton = screen.getByRole("button", { name: /next/i });
    expect(nextButton).toBeDisabled();
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

async function enterGoogleSetup() {
  vi.mocked(api.globalSettings.get).mockResolvedValue({
    apiKeys: { GOOGLE_API_KEY: [{ id: "g", masked: "key" }] },
  } as never);
  vi.mocked(api.env.getKeys).mockResolvedValue({
    anthropic: false,
    cursor: false,
    openai: false,
    google: true,
    claudeCli: true,
    cursorCli: true,
    ollamaCli: false,
  } as never);
  vi.mocked(api.projects.list).mockResolvedValue([]);
  const user = userEvent.setup();
  renderProjectSetup();
  await user.type(screen.getByLabelText(/project name/i), "Google Project");
  await user.type(screen.getByLabelText(/project folder/i), "/repo/A");
  await user.click(screen.getByRole("button", { name: /^Next$/ }));
  await waitFor(() => expect(screen.getAllByRole("combobox")[0]).toHaveValue("google"));
  return user;
}

it("keeps Google-only availability when switching provider and back", async () => {
  const user = await enterGoogleSetup();
  const selects = screen.getAllByRole("combobox");
  expect(selects[2]).toHaveValue("google");
  await user.selectOptions(selects[0], "openai");
  expect(screen.getByRole("button", { name: /^Next$/ })).toBeDisabled();
  await user.selectOptions(selects[0], "google");
  expect(screen.getByRole("button", { name: /^Next$/ })).toBeEnabled();
  expect(screen.queryByText(/GOOGLE_API_KEY.*required/i)).not.toBeInTheDocument();
});

it("preserves explicit None through late detection, step reentry and creation", async () => {
  let resolveDetection!: (value: unknown) => void;
  vi.mocked(api.filesystem.detectTestFramework)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDetection = resolve;
        }) as never
    )
    .mockResolvedValue({ framework: "vitest" } as never);
  vi.mocked(api.projects.create).mockResolvedValue({ id: "new", currentPhase: "sketch" } as never);
  const user = await enterGoogleSetup();
  await user.click(screen.getByRole("button", { name: /^Next$/ }));
  await user.selectOptions(screen.getByLabelText("Test Framework"), "none");
  await act(async () => {
    resolveDetection({ framework: "vitest" });
  });
  expect(screen.getByLabelText("Test Framework")).toHaveValue("none");
  await user.click(screen.getByRole("button", { name: /^Next$/ }));
  await user.click(screen.getByRole("button", { name: /^Back$/ }));
  await waitFor(() =>
    expect(screen.queryByText("Detecting from project...")).not.toBeInTheDocument()
  );
  expect(screen.getByLabelText("Test Framework")).toHaveValue("none");
  await user.selectOptions(screen.getByLabelText("Test Framework"), "jest");
  await user.click(screen.getByRole("button", { name: /^Next$/ }));
  await user.click(screen.getByRole("button", { name: /^Back$/ }));
  await waitFor(() =>
    expect(screen.queryByText("Detecting from project...")).not.toBeInTheDocument()
  );
  expect(screen.getByLabelText("Test Framework")).toHaveValue("jest");
  await user.click(screen.getByRole("button", { name: /^Next$/ }));
  await user.click(screen.getByRole("button", { name: /^Next$/ }));
  await user.click(screen.getByRole("button", { name: "Create Project" }));
  await waitFor(() =>
    expect(api.projects.create).toHaveBeenCalledWith(
      expect.objectContaining({
        testFramework: "jest",
        simpleComplexityAgent: expect.objectContaining({ type: "google" }),
      })
    )
  );
});

it("ignores a stale framework response after repository identity changes", async () => {
  let resolveOld!: (value: unknown) => void;
  vi.mocked(api.filesystem.detectTestFramework)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }) as never
    )
    .mockResolvedValue({ framework: "pytest" } as never);
  const user = await enterGoogleSetup();
  await user.click(screen.getByRole("button", { name: /^Next$/ }));
  await user.selectOptions(screen.getByLabelText("Test Framework"), "jest");
  await user.click(screen.getByRole("button", { name: /^Back$/ }));
  await user.click(screen.getByRole("button", { name: /^Back$/ }));
  await user.clear(screen.getByLabelText(/project folder/i));
  await user.type(screen.getByLabelText(/project folder/i), "/repo/B");
  await user.click(screen.getByRole("button", { name: /^Next$/ }));
  await user.click(screen.getByRole("button", { name: /^Next$/ }));
  await waitFor(() => expect(screen.getByLabelText("Test Framework")).toHaveValue("pytest"));
  await act(async () => {
    resolveOld({ framework: "vitest" });
  });
  expect(screen.getByLabelText("Test Framework")).toHaveValue("pytest");
});
