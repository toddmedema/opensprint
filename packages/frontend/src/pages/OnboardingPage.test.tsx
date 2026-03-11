import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import { OnboardingPage } from "./OnboardingPage";
import { renderApp } from "../test/test-utils";

const mockGetPrerequisites = vi.fn();

vi.mock("../api/client", () => ({
  api: {
    env: {
      getPrerequisites: (...args: unknown[]) => mockGetPrerequisites(...args),
    },
  },
}));

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

  it("renders Agent setup placeholder section", async () => {
    renderOnboarding();

    await waitFor(() => {
      expect(screen.getByTestId("prereq-row-git")).toBeInTheDocument();
    });
    const section = screen.getByTestId("onboarding-agent-setup");
    expect(section).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Agent setup" })).toBeInTheDocument();
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
});
