import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import { OnboardingPage } from "./OnboardingPage";
import { renderApp } from "../test/test-utils";
import { api } from "../api/client";

const mockGetPrerequisites = vi.fn();
const mockGetGlobalStatus = vi.fn();
const mockGetKeys = vi.fn();
const mockNavigate = vi.fn();

const defaultEnvKeys = {
  anthropic: false,
  cursor: false,
  openai: false,
  google: false,
  claudeCli: true,
  cursorCli: true,
  ollamaCli: true,
  useCustomCli: false,
};

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      env: {
        getPrerequisites: (...args: unknown[]) => mockGetPrerequisites(...args),
        getGlobalStatus: (...args: unknown[]) => mockGetGlobalStatus(...args),
        getKeys: (...args: unknown[]) => mockGetKeys(...args),
        validateKey: vi.fn(),
        saveKey: vi.fn(),
        setGlobalSettings: vi.fn(),
      },
    },
  };
});

vi.mock("react-router-dom", async (importOriginal) => {
  const mod = await importOriginal<typeof import("react-router-dom")>();
  return { ...mod, useNavigate: () => mockNavigate };
});

vi.mock("../components/layout/Layout", () => ({
  Layout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="layout">{children}</div>
  ),
}));

function renderOnboarding(routeEntries: string[] = ["/onboarding"]) {
  return renderApp(
    <Routes>
      <Route path="/onboarding" element={<OnboardingPage />} />
    </Routes>,
    { routeEntries }
  );
}

describe("OnboardingPage", () => {
  beforeEach(() => {
    mockGetPrerequisites.mockReset();
    mockGetPrerequisites.mockResolvedValue({ missing: [], platform: "darwin" });
    mockGetGlobalStatus.mockReset();
    mockGetGlobalStatus.mockResolvedValue({ hasAnyKey: false, useCustomCli: false });
    mockGetKeys.mockReset();
    mockGetKeys.mockResolvedValue(defaultEnvKeys);
    mockNavigate.mockClear();
    vi.mocked(api.env.validateKey).mockReset();
    vi.mocked(api.env.saveKey).mockReset();
    vi.mocked(api.env.setGlobalSettings).mockReset();
  });

  it("renders full-page layout with title Initial Setup", async () => {
    renderOnboarding();

    expect(screen.getByTestId("onboarding-page")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-title")).toHaveTextContent("Initial Setup");
    expect(screen.getByTestId("layout")).toBeInTheDocument();
    await waitFor(() => {
      expect(mockGetPrerequisites).toHaveBeenCalled();
    });
  });

  it("renders Prerequisites section and fetches prerequisites on mount", async () => {
    renderOnboarding();

    const section = screen.getByTestId("onboarding-prerequisites");
    expect(section).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Prerequisites" })).toBeInTheDocument();
    expect(mockGetPrerequisites).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });
  });

  it("shows loading state while fetching prerequisites", () => {
    mockGetPrerequisites.mockImplementation(() => new Promise(() => {}));
    renderOnboarding();

    expect(screen.getByText("Checking Git and Node.js…")).toBeInTheDocument();
  });

  it("shows checkmarks when Git and Node.js are present", async () => {
    mockGetPrerequisites.mockResolvedValue({ missing: [], platform: "darwin" });
    renderOnboarding();

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
      expect(screen.getByTestId("prereq-row-nodejs")).toBeInTheDocument();
    });
    expect(screen.getByTestId("prereq-row-git")).toHaveTextContent("Installed");
    expect(screen.getByTestId("prereq-row-nodejs")).toHaveTextContent("Installed");
    expect(screen.queryByTestId("prereq-install-git")).not.toBeInTheDocument();
    expect(screen.queryByTestId("prereq-install-nodejs")).not.toBeInTheDocument();
  });

  it("shows Install Git and Install Node.js links when missing", async () => {
    mockGetPrerequisites.mockResolvedValue({
      missing: ["Git", "Node.js"],
      platform: "darwin",
    });
    renderOnboarding();

    await waitFor(() => {
      expect(screen.getByTestId("prereq-install-git")).toBeInTheDocument();
      expect(screen.getByTestId("prereq-install-nodejs")).toBeInTheDocument();
    });
    const installGit = screen.getByRole("link", { name: "Install Git" });
    const installNode = screen.getByRole("link", { name: "Install Node.js" });
    expect(installGit).toHaveAttribute("href", "https://git-scm.com/");
    expect(installNode).toHaveAttribute("href", "https://nodejs.org/");
  });

  it("uses win32 Git install URL when platform is win32", async () => {
    mockGetPrerequisites.mockResolvedValue({
      missing: ["Git"],
      platform: "win32",
    });
    renderOnboarding();

    await waitFor(() => {
      expect(screen.getByTestId("prereq-install-git")).toBeInTheDocument();
    });
    expect(screen.getByRole("link", { name: "Install Git" })).toHaveAttribute(
      "href",
      "https://git-scm.com/download/win"
    );
  });

  it("renders Agent setup section with provider dropdown and local provider options", async () => {
    renderOnboarding();

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });
    const section = screen.getByTestId("onboarding-agent-setup");
    expect(section).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Agent setup" })).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-provider-select")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "LM Studio (local)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Ollama (local)" })).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-continue-button")).toBeInTheDocument();
  });

  it("completion with no intended param navigates to /", async () => {
    const user = userEvent.setup();
    renderOnboarding(["/onboarding"]);

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByTestId("onboarding-provider-select"), "LM Studio (local)");
    await user.click(screen.getByTestId("onboarding-continue-button"));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/");
    });
  });

  it("completion with intended=/projects/create-new navigates to Create New flow", async () => {
    const user = userEvent.setup();
    renderOnboarding(["/onboarding?intended=/projects/create-new"]);

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByTestId("onboarding-provider-select"), "LM Studio (local)");
    await user.click(screen.getByTestId("onboarding-continue-button"));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/projects/create-new");
    });
  });

  it("explicit intended=/ is allowed and completion navigates to /", async () => {
    const user = userEvent.setup();
    renderOnboarding(["/onboarding?intended=/"]);

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByTestId("onboarding-provider-select"), "LM Studio (local)");
    await user.click(screen.getByTestId("onboarding-continue-button"));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/");
    });
  });

  it("invalid intended param is sanitized and completion navigates to /", async () => {
    const user = userEvent.setup();
    renderOnboarding(["/onboarding?intended=/settings"]);

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByTestId("onboarding-provider-select"), "LM Studio (local)");
    await user.click(screen.getByTestId("onboarding-continue-button"));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/");
    });
  });

  it("intended /projects/:id navigates to that path on completion", async () => {
    const user = userEvent.setup();
    renderOnboarding(["/onboarding?intended=/projects/abc123/settings"]);

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByTestId("onboarding-provider-select"), "LM Studio (local)");
    await user.click(screen.getByTestId("onboarding-continue-button"));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/projects/abc123/settings");
    });
  });

  it("selecting provider toggles key visibility: cloud shows key input, LM Studio and Custom show no-key message", async () => {
    const user = userEvent.setup();
    renderOnboarding();

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });
    expect(screen.getByTestId("onboarding-api-key-input")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-eye-toggle")).toBeInTheDocument();
    expect(screen.queryByTestId("onboarding-no-key-message")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByTestId("onboarding-provider-select"), "LM Studio (local)");
    expect(screen.queryByTestId("onboarding-api-key-input")).not.toBeInTheDocument();
    expect(screen.getByTestId("onboarding-no-key-message")).toHaveTextContent(
      "No API key needed — you're good to go."
    );

    await user.selectOptions(screen.getByTestId("onboarding-provider-select"), "Custom/CLI");
    expect(screen.queryByTestId("onboarding-api-key-input")).not.toBeInTheDocument();
    expect(screen.getByTestId("onboarding-no-key-message")).toBeInTheDocument();

    await user.selectOptions(screen.getByTestId("onboarding-provider-select"), "Claude");
    expect(screen.getByTestId("onboarding-api-key-input")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-eye-toggle")).toBeInTheDocument();
  });

  it("selecting Ollama hides key input and shows local runtime guidance", async () => {
    const user = userEvent.setup();
    renderOnboarding();

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });

    await user.selectOptions(screen.getByTestId("onboarding-provider-select"), "Ollama (local)");

    expect(screen.queryByTestId("onboarding-api-key-input")).not.toBeInTheDocument();
    expect(screen.getByTestId("onboarding-no-key-message")).toHaveTextContent(
      "No API key needed — install/start Ollama and you’re good to go."
    );
  });

  it("Continue with Custom/CLI persists useCustomCli and navigates to intended", async () => {
    const user = userEvent.setup();
    vi.mocked(api.env.setGlobalSettings).mockResolvedValue({ useCustomCli: true });
    renderOnboarding(["/onboarding?intended=/projects/create-new"]);

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByTestId("onboarding-provider-select"), "Custom/CLI");
    await user.click(screen.getByTestId("onboarding-continue-button"));

    await waitFor(() => {
      expect(api.env.setGlobalSettings).toHaveBeenCalledWith({ useCustomCli: true });
    });
    expect(api.env.validateKey).not.toHaveBeenCalled();
    expect(api.env.saveKey).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("/projects/create-new");
  });

  it("Continue with LM Studio navigates without saving key", async () => {
    const user = userEvent.setup();
    renderOnboarding(["/onboarding?intended=/projects/add-existing"]);

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByTestId("onboarding-provider-select"), "LM Studio (local)");
    await user.click(screen.getByTestId("onboarding-continue-button"));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/projects/add-existing");
    });
    expect(api.env.setGlobalSettings).not.toHaveBeenCalled();
    expect(api.env.validateKey).not.toHaveBeenCalled();
    expect(api.env.saveKey).not.toHaveBeenCalled();
  });

  it("Cloud flow: Continue validates then saves and navigates", async () => {
    const user = userEvent.setup();
    vi.mocked(api.env.validateKey).mockResolvedValue({ valid: true });
    vi.mocked(api.env.saveKey).mockResolvedValue({ saved: true });
    renderOnboarding(["/onboarding?intended=/projects/create-new"]);

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });
    await user.type(screen.getByTestId("onboarding-api-key-input"), "sk-ant-test-key");
    await user.click(screen.getByTestId("onboarding-continue-button"));

    await waitFor(() => {
      expect(api.env.validateKey).toHaveBeenCalledWith("claude", "sk-ant-test-key");
    });
    expect(api.env.saveKey).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "sk-ant-test-key");
    expect(mockNavigate).toHaveBeenCalledWith("/projects/create-new");
  });

  it("Cloud flow: invalid key shows inline error and does not save or navigate", async () => {
    const user = userEvent.setup();
    vi.mocked(api.env.validateKey).mockResolvedValue({
      valid: false,
      error: "Invalid API key",
    });
    renderOnboarding(["/onboarding?intended=/projects/create-new"]);

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });
    await user.type(screen.getByTestId("onboarding-api-key-input"), "bad-key");
    await user.click(screen.getByTestId("onboarding-continue-button"));

    await waitFor(() => {
      expect(screen.getByTestId("onboarding-key-error")).toHaveTextContent("Invalid API key");
    });
    expect(api.env.saveKey).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("Cloud flow: Continue button disabled when key empty", async () => {
    renderOnboarding();

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });
    expect(screen.getByTestId("onboarding-provider-select")).toHaveValue("claude");
    expect(screen.getByTestId("onboarding-continue-button")).toBeDisabled();
    expect(api.env.validateKey).not.toHaveBeenCalled();
  });

  it("Cloud flow: network error shows connection message and Try again", async () => {
    const user = userEvent.setup();
    vi.mocked(api.env.validateKey).mockRejectedValue(new Error("Failed to fetch"));
    renderOnboarding();

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });
    await user.type(screen.getByTestId("onboarding-api-key-input"), "sk-ant-x");
    await user.click(screen.getByTestId("onboarding-continue-button"));

    await waitFor(() => {
      expect(
        screen.getByText("Unable to connect. Please check your network and try again.")
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("onboarding-try-again")).toBeInTheDocument();
    expect(api.env.saveKey).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("Cloud flow: network error on save shows connection message and does not navigate", async () => {
    const user = userEvent.setup();
    vi.mocked(api.env.validateKey).mockResolvedValue({ valid: true });
    vi.mocked(api.env.saveKey).mockRejectedValue(new Error("Network request failed"));
    renderOnboarding();

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });
    await user.type(screen.getByTestId("onboarding-api-key-input"), "sk-ant-valid");
    await user.click(screen.getByTestId("onboarding-continue-button"));

    await waitFor(() => {
      expect(
        screen.getByText("Unable to connect. Please check your network and try again.")
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("onboarding-try-again")).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("Cancel button navigates to home without saving", async () => {
    const user = userEvent.setup();
    renderOnboarding(["/onboarding?intended=/projects/create-new"]);

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("onboarding-cancel-button"));

    expect(mockNavigate).toHaveBeenCalledWith("/");
    expect(api.env.validateKey).not.toHaveBeenCalled();
    expect(api.env.saveKey).not.toHaveBeenCalled();
    expect(api.env.setGlobalSettings).not.toHaveBeenCalled();
  });

  it("Try again clears connection error so user can retry", async () => {
    const user = userEvent.setup();
    vi.mocked(api.env.validateKey)
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValueOnce({ valid: true });
    vi.mocked(api.env.saveKey).mockResolvedValue({ saved: true });
    renderOnboarding(["/onboarding?intended=/projects/create-new"]);

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });
    await user.type(screen.getByTestId("onboarding-api-key-input"), "sk-ant-retry");
    await user.click(screen.getByTestId("onboarding-continue-button"));

    await waitFor(() => {
      expect(screen.getByTestId("onboarding-try-again")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("onboarding-try-again"));

    expect(screen.queryByTestId("onboarding-key-error")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("onboarding-continue-button"));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/projects/create-new");
    });
  });

  it("Cursor: after entering a key, fetches env keys and blocks Continue when Cursor CLI is missing", async () => {
    const user = userEvent.setup();
    mockGetKeys.mockResolvedValue({ ...defaultEnvKeys, cursorCli: false });
    renderOnboarding();

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByTestId("onboarding-provider-select"), "Cursor");
    await user.type(screen.getByTestId("onboarding-api-key-input"), "key_test");

    await waitFor(() => {
      expect(mockGetKeys).toHaveBeenCalled();
    });
    expect(screen.getByTestId("agent-provider-cli-banner-cursor")).toBeInTheDocument();
    expect(screen.getByTestId("install-cursor-cli-btn")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-continue-button")).toBeDisabled();
  });

  it("Cursor: Continue proceeds when Cursor CLI is present", async () => {
    const user = userEvent.setup();
    mockGetKeys.mockResolvedValue({ ...defaultEnvKeys, cursorCli: true });
    vi.mocked(api.env.validateKey).mockResolvedValue({ valid: true });
    vi.mocked(api.env.saveKey).mockResolvedValue({ saved: true });
    renderOnboarding(["/onboarding?intended=/"]);

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByTestId("onboarding-provider-select"), "Cursor");
    await user.type(screen.getByTestId("onboarding-api-key-input"), "key_ok");

    await waitFor(() => {
      expect(screen.getByTestId("onboarding-continue-button")).not.toBeDisabled();
    });
    await user.click(screen.getByTestId("onboarding-continue-button"));

    await waitFor(() => {
      expect(api.env.validateKey).toHaveBeenCalledWith("cursor", "key_ok");
    });
    expect(mockNavigate).toHaveBeenCalledWith("/");
  });

  it("Claude: after entering a key, fetches env keys and shows Claude CLI banner when CLI missing but does not block Continue", async () => {
    const user = userEvent.setup();
    mockGetKeys.mockResolvedValue({ ...defaultEnvKeys, claudeCli: false });
    renderOnboarding();

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });
    await user.type(screen.getByTestId("onboarding-api-key-input"), "sk-ant-x");

    await waitFor(() => {
      expect(mockGetKeys).toHaveBeenCalled();
    });
    expect(screen.getByTestId("agent-provider-cli-banner-claude")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-continue-button")).not.toBeDisabled();
  });

  it("Claude: Continue still validates and saves when Claude CLI is missing (API path)", async () => {
    const user = userEvent.setup();
    mockGetKeys.mockResolvedValue({ ...defaultEnvKeys, claudeCli: false });
    vi.mocked(api.env.validateKey).mockResolvedValue({ valid: true });
    vi.mocked(api.env.saveKey).mockResolvedValue({ saved: true });
    renderOnboarding(["/onboarding?intended=/projects/create-new"]);

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });
    await user.type(screen.getByTestId("onboarding-api-key-input"), "sk-ant-ok");
    await waitFor(() => {
      expect(screen.getByTestId("agent-provider-cli-banner-claude")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("onboarding-continue-button"));

    await waitFor(() => {
      expect(api.env.saveKey).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "sk-ant-ok");
    });
    expect(mockNavigate).toHaveBeenCalledWith("/projects/create-new");
  });

  it("eye toggle switches password visibility", async () => {
    const user = userEvent.setup();
    renderOnboarding();

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });
    const input = screen.getByTestId("onboarding-api-key-input");
    const eyeToggle = screen.getByTestId("onboarding-eye-toggle");
    expect(input).toHaveAttribute("type", "password");
    await user.click(eyeToggle);
    expect(input).toHaveAttribute("type", "text");
    await user.click(eyeToggle);
    expect(input).toHaveAttribute("type", "password");
  });
});
