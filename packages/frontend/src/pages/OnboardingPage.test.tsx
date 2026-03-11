import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import { OnboardingPage } from "./OnboardingPage";
import { renderApp } from "../test/test-utils";
import { api } from "../api/client";

const mockGetPrerequisites = vi.fn();
const mockNavigate = vi.fn();

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      env: {
        getPrerequisites: (...args: unknown[]) => mockGetPrerequisites(...args),
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

  it("renders Agent setup section with provider dropdown and LM Studio option", async () => {
    renderOnboarding();

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });
    const section = screen.getByTestId("onboarding-agent-setup");
    expect(section).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Agent setup" })).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-provider-select")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "LM Studio (local)" })).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-continue-button")).toBeInTheDocument();
  });

  it("supports optional intended query param", async () => {
    renderOnboarding(["/onboarding?intended=/projects/create-new"]);

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });
    expect(screen.getByTestId("onboarding-intended")).toHaveTextContent(
      "Intended destination: /projects/create-new"
    );
  });

  it("does not show intended when query param is absent", async () => {
    renderOnboarding(["/onboarding"]);

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("onboarding-intended")).not.toBeInTheDocument();
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
    expect(screen.queryByTestId("onboarding-intended")).not.toBeInTheDocument();
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
    expect(screen.queryByTestId("onboarding-intended")).not.toBeInTheDocument();
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
    expect(screen.getByTestId("onboarding-intended")).toHaveTextContent(
      "Intended destination: /projects/abc123/settings"
    );
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

  it("Cloud flow: network error shows connection message", async () => {
    const user = userEvent.setup();
    vi.mocked(api.env.validateKey).mockRejectedValue(new Error("Failed to fetch"));
    renderOnboarding();

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });
    await user.type(screen.getByTestId("onboarding-api-key-input"), "sk-ant-x");
    await user.click(screen.getByTestId("onboarding-continue-button"));

    await waitFor(() => {
      expect(screen.getByText("Unable to connect. Please check your network and try again.")).toBeInTheDocument();
    });
    expect(api.env.saveKey).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
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
