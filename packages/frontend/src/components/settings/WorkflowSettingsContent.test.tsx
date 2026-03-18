import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { ProjectSettings } from "@opensprint/shared";
import { WorkflowSettingsContent } from "./WorkflowSettingsContent";
import { renderApp } from "../../test/test-utils";
import { api } from "../../api/client";

vi.mock("../../api/client", () => ({
  api: {
    projects: {
      runSelfImprovement: vi.fn(),
    },
  },
}));

const baseSettings: ProjectSettings = {
  simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
  complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
  deployment: { mode: "custom" },
  hilConfig: {
    scopeChanges: "requires_approval",
    architectureDecisions: "requires_approval",
    dependencyModifications: "requires_approval",
  },
  testFramework: null,
  testCommand: null,
  reviewMode: "always",
  reviewAngles: undefined,
  includeGeneralReview: true,
  gitWorkingMode: "worktree",
  worktreeBaseBranch: "main",
  mergeStrategy: "per_task",
  maxConcurrentCoders: 1,
  unknownScopeStrategy: "optimistic",
  selfImprovementFrequency: "never",
};

function renderWorkflowContent(overrides?: Partial<ProjectSettings>) {
  const persistSettings = vi.fn();
  const scheduleSaveOnBlur = vi.fn();
  const lastReviewAnglesRef = { current: undefined as ProjectSettings["reviewAngles"] | undefined };

  renderApp(
    <WorkflowSettingsContent
      settings={{ ...baseSettings, ...overrides }}
      projectId="proj-1"
      persistSettings={persistSettings}
      scheduleSaveOnBlur={scheduleSaveOnBlur}
      lastReviewAnglesRef={lastReviewAnglesRef}
    />
  );

  return {
    persistSettings,
    scheduleSaveOnBlur,
    lastReviewAnglesRef,
  };
}

describe("WorkflowSettingsContent", () => {
  beforeEach(() => {
    vi.mocked(api.projects.runSelfImprovement).mockReset();
  });

  it("renders all three workflow cards and core controls", () => {
    renderWorkflowContent({
      selfImprovementLastRunAt: "2026-01-01T08:00:00.000Z",
      nextRunAt: "2026-01-08T08:00:00.000Z",
    });

    expect(screen.getByTestId("workflow-execution-strategy-card")).toBeInTheDocument();
    expect(screen.getByTestId("workflow-quality-gates-card")).toBeInTheDocument();
    expect(screen.getByTestId("workflow-continuous-improvement-card")).toBeInTheDocument();

    expect(screen.getByTestId("git-working-mode-select")).toBeInTheDocument();
    expect(screen.getByTestId("worktree-base-branch-input")).toBeInTheDocument();
    expect(screen.getByTestId("merge-strategy-select")).toBeInTheDocument();
    expect(screen.getByTestId("max-concurrent-coders-slider")).toBeInTheDocument();
    expect(screen.getByTestId("review-mode-select")).toBeInTheDocument();
    expect(screen.getByTestId("review-agents-multiselect")).toBeInTheDocument();
    expect(screen.getByTestId("self-improvement-frequency-select")).toBeInTheDocument();
    expect(screen.getByTestId("self-improvement-last-run")).toBeInTheDocument();
    expect(screen.getByTestId("self-improvement-next-run")).toBeInTheDocument();
  });

  it("shows unknown scope strategy only when parallelism is above 1", () => {
    renderWorkflowContent();
    expect(screen.queryByTestId("unknown-scope-strategy-select")).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId("max-concurrent-coders-slider"), {
      target: { value: "2" },
    });
    expect(screen.getByTestId("unknown-scope-strategy-select")).toBeInTheDocument();
  });

  it("persists immediate-save controls with the same override shape", () => {
    const { persistSettings } = renderWorkflowContent();

    fireEvent.change(screen.getByTestId("review-mode-select"), {
      target: { value: "on-failure-only" },
    });
    fireEvent.change(screen.getByTestId("git-working-mode-select"), {
      target: { value: "branches" },
    });
    fireEvent.change(screen.getByTestId("merge-strategy-select"), {
      target: { value: "per_epic" },
    });
    fireEvent.change(screen.getByTestId("self-improvement-frequency-select"), {
      target: { value: "daily" },
    });

    expect(persistSettings).toHaveBeenCalledWith(undefined, {
      reviewMode: "on-failure-only",
    });
    expect(persistSettings).toHaveBeenCalledWith(undefined, { gitWorkingMode: "branches" });
    expect(persistSettings).toHaveBeenCalledWith(undefined, { mergeStrategy: "per_epic" });
    expect(persistSettings).toHaveBeenCalledWith(undefined, {
      selfImprovementFrequency: "daily",
    });
  });

  it("uses blur-save handlers for test command and parallelism slider", () => {
    const { scheduleSaveOnBlur } = renderWorkflowContent();

    const testCommandInput = screen.getByPlaceholderText("e.g. npm test or npx vitest run");
    fireEvent.change(testCommandInput, { target: { value: "npm test" } });
    fireEvent.blur(testCommandInput);

    const slider = screen.getByTestId("max-concurrent-coders-slider");
    fireEvent.change(slider, { target: { value: "3" } });
    fireEvent.blur(slider);

    expect(scheduleSaveOnBlur).toHaveBeenCalledTimes(2);
  });

  it("shows Run now button in Continuous Improvement section", () => {
    renderWorkflowContent();
    expect(screen.getByTestId("self-improvement-run-now")).toBeInTheDocument();
    expect(screen.getByTestId("self-improvement-run-now")).toHaveTextContent("Run now");
  });

  it("Run now click triggers run and shows loading then result", async () => {
    let resolveRun: (v: { tasksCreated: number; skipped: string }) => void;
    const runPromise = new Promise<{ tasksCreated: number; skipped: string }>((r) => {
      resolveRun = r;
    });
    vi.mocked(api.projects.runSelfImprovement).mockReturnValue(runPromise);
    renderWorkflowContent();

    const runNowBtn = screen.getByTestId("self-improvement-run-now");
    fireEvent.click(runNowBtn);

    await waitFor(() => expect(runNowBtn).toHaveTextContent("Running…"));
    expect(api.projects.runSelfImprovement).toHaveBeenCalledWith("proj-1");

    resolveRun!({ tasksCreated: 0, skipped: "no_changes" });
    await waitFor(() => {
      expect(screen.getByTestId("self-improvement-run-now-message")).toHaveTextContent(
        "No changes since last run"
      );
    });
    expect(runNowBtn).toHaveTextContent("Run now");
  });

  it("Run now shows tasks-created message when run creates tasks", async () => {
    vi.mocked(api.projects.runSelfImprovement).mockResolvedValue({
      tasksCreated: 2,
      runId: "si-123",
    });
    renderWorkflowContent();

    fireEvent.click(screen.getByTestId("self-improvement-run-now"));

    await waitFor(() => {
      expect(screen.getByTestId("self-improvement-run-now-message")).toHaveTextContent(
        "2 tasks created"
      );
    });
  });
});
