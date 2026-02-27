import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConfirmStep } from "./ConfirmStep";

const defaultMetadata = {
  name: "My App",
  repoPath: "",
};

function renderConfirmStep(overrides: Partial<Parameters<typeof ConfirmStep>[0]> = {}) {
  return render(
    <ConfirmStep
      metadata={defaultMetadata}
      repoPath="/path/to/repo"
      simpleComplexityAgent={{ type: "cursor", model: "gpt-4", cliCommand: null }}
      complexComplexityAgent={{ type: "claude", model: "claude-3-5-sonnet", cliCommand: null }}
      deploymentMode="expo"
      customDeployCommand=""
      customDeployWebhook=""
      testFramework="vitest"
      maxConcurrentCoders={1}
      {...overrides}
    />
  );
}

describe("ConfirmStep", () => {
  it("renders confirm step with data-testid", () => {
    renderConfirmStep();
    expect(screen.getByTestId("confirm-step")).toBeInTheDocument();
  });

  it("shows metadata name and repo path", () => {
    renderConfirmStep({ metadata: { name: "Test Project", repoPath: "" }, repoPath: "/home/repo" });
    expect(screen.getByText("Test Project")).toBeInTheDocument();
    expect(screen.getByText("/home/repo")).toBeInTheDocument();
  });

  it("shows low and high complexity agent labels", () => {
    renderConfirmStep({
      simpleComplexityAgent: { type: "cursor", model: "gpt-4", cliCommand: null },
      complexComplexityAgent: { type: "claude-cli", model: "claude-3-5-sonnet", cliCommand: null },
    });
    expect(screen.getByText(/Cursor.*gpt-4/)).toBeInTheDocument();
    expect(screen.getByText(/Claude \(CLI\).*claude-3-5-sonnet/)).toBeInTheDocument();
  });

  it("shows deployment and test framework", () => {
    renderConfirmStep({
      deploymentMode: "expo",
      testFramework: "vitest",
    });
    expect(screen.getByText("Expo")).toBeInTheDocument();
    const testLabel = screen.getByText("Vitest");
    expect(testLabel).toBeInTheDocument();
  });

  it("shows concurrent coders as 1 (sequential) when 1", () => {
    renderConfirmStep({ maxConcurrentCoders: 1 });
    expect(screen.getByText("1 (sequential)")).toBeInTheDocument();
  });

  it("shows concurrent coders number when greater than 1", () => {
    renderConfirmStep({ maxConcurrentCoders: 3 });
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("shows custom agent label when cliCommand is set", () => {
    renderConfirmStep({
      simpleComplexityAgent: { type: "custom", model: null, cliCommand: "my-agent --foo" },
    });
    expect(screen.getByText(/Custom: my-agent --foo/)).toBeInTheDocument();
  });

  it("shows unknown scope strategy when maxConcurrentCoders > 1", () => {
    renderConfirmStep({
      maxConcurrentCoders: 3,
      unknownScopeStrategy: "optimistic",
    });
    expect(screen.getByText("Unknown scope strategy")).toBeInTheDocument();
    expect(screen.getByText("optimistic")).toBeInTheDocument();
  });

  it("shows Git working mode Branches in summary when gitWorkingMode is branches", () => {
    renderConfirmStep({ gitWorkingMode: "branches" });
    expect(screen.getByText("Git working mode")).toBeInTheDocument();
    expect(screen.getByText("Branches")).toBeInTheDocument();
  });

  it("does not show Git working mode row when gitWorkingMode is worktree", () => {
    renderConfirmStep({ gitWorkingMode: "worktree" });
    expect(screen.queryByText("Git working mode")).not.toBeInTheDocument();
  });

  it("hides Deliver row when hideDeployment is true", () => {
    renderConfirmStep({ hideDeployment: true });
    expect(screen.queryByText("Deliver")).not.toBeInTheDocument();
  });
});
