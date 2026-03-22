import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { ProjectSettings } from "@opensprint/shared";
import { WorkflowSettingsContent } from "./WorkflowSettingsContent";
import { renderApp } from "../../test/test-utils";
import { api } from "../../api/client";
import type { SelfImprovementStatusSnapshot, SelfImprovementHistoryEntry } from "../../api/client";

vi.mock("../../api/client", () => ({
  api: {
    projects: {
      runSelfImprovement: vi.fn(),
      getSelfImprovementStatus: vi.fn(),
      getSelfImprovementHistory: vi.fn(),
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
    vi.mocked(api.projects.getSelfImprovementStatus).mockReset();
    vi.mocked(api.projects.getSelfImprovementHistory).mockReset();
    vi.mocked(api.projects.getSelfImprovementStatus).mockResolvedValue({
      status: "idle",
    } satisfies SelfImprovementStatusSnapshot);
    vi.mocked(api.projects.getSelfImprovementHistory).mockResolvedValue([]);
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

  it("persists max concurrent coders immediately on slider change", () => {
    const { persistSettings } = renderWorkflowContent();

    fireEvent.change(screen.getByTestId("max-concurrent-coders-slider"), {
      target: { value: "4" },
    });

    expect(persistSettings).toHaveBeenCalledWith(undefined, { maxConcurrentCoders: 4 });
  });

  it("uses blur-save for test command only", () => {
    const { scheduleSaveOnBlur } = renderWorkflowContent();

    const testCommandInput = screen.getByPlaceholderText("e.g. npm test or npx vitest run");
    fireEvent.change(testCommandInput, { target: { value: "npm test" } });
    fireEvent.blur(testCommandInput);

    fireEvent.change(screen.getByTestId("max-concurrent-coders-slider"), {
      target: { value: "3" },
    });

    expect(scheduleSaveOnBlur).toHaveBeenCalledTimes(1);
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

  it("renders the run-agent-enhancement-experiments checkbox unchecked by default", () => {
    renderWorkflowContent();
    const checkbox = screen.getByTestId(
      "run-agent-enhancement-experiments-checkbox"
    ) as HTMLInputElement;
    expect(checkbox).toBeInTheDocument();
    expect(checkbox.checked).toBe(false);
  });

  it("renders the checkbox checked when setting is true", () => {
    renderWorkflowContent({ runAgentEnhancementExperiments: true });
    const checkbox = screen.getByTestId(
      "run-agent-enhancement-experiments-checkbox"
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it("persists runAgentEnhancementExperiments when checkbox is toggled", () => {
    const { persistSettings } = renderWorkflowContent();
    const checkbox = screen.getByTestId("run-agent-enhancement-experiments-checkbox");

    fireEvent.click(checkbox);
    expect(persistSettings).toHaveBeenCalledWith(undefined, {
      runAgentEnhancementExperiments: true,
    });
  });

  it("shows Idle status row by default", async () => {
    renderWorkflowContent();
    await waitFor(() => {
      expect(screen.getByTestId("self-improvement-status-label")).toHaveTextContent("Idle");
    });
  });

  it("shows running audit status with spinner", async () => {
    vi.mocked(api.projects.getSelfImprovementStatus).mockResolvedValue({
      status: "running_audit",
    });
    renderWorkflowContent();

    await waitFor(() => {
      expect(screen.getByTestId("self-improvement-status-label")).toHaveTextContent(
        "Running self-improvement audit\u2026"
      );
    });
    expect(screen.getByTestId("self-improvement-status-spinner")).toBeInTheDocument();
  });

  it("shows running experiments status with spinner and stage label", async () => {
    vi.mocked(api.projects.getSelfImprovementStatus).mockResolvedValue({
      status: "running_experiments",
      stage: "generating_candidate",
    });
    renderWorkflowContent();

    await waitFor(() => {
      expect(screen.getByTestId("self-improvement-status-label")).toHaveTextContent(
        "Running agent enhancement experiments\u2026"
      );
    });
    expect(screen.getByTestId("self-improvement-status-spinner")).toBeInTheDocument();
    expect(screen.getByTestId("self-improvement-stage-label")).toHaveTextContent(
      "Generating candidate"
    );
  });

  it("shows awaiting approval status without spinner", async () => {
    vi.mocked(api.projects.getSelfImprovementStatus).mockResolvedValue({
      status: "awaiting_approval",
      pendingCandidateId: "cand-1",
    });
    renderWorkflowContent();

    await waitFor(() => {
      expect(screen.getByTestId("self-improvement-status-label")).toHaveTextContent(
        "Awaiting approval to promote agent improvements"
      );
    });
    expect(screen.queryByTestId("self-improvement-status-spinner")).not.toBeInTheDocument();
  });

  it("does not show stage label when status is idle", async () => {
    renderWorkflowContent();
    await waitFor(() => {
      expect(screen.getByTestId("self-improvement-status-label")).toHaveTextContent("Idle");
    });
    expect(screen.queryByTestId("self-improvement-stage-label")).not.toBeInTheDocument();
  });

  describe("self-improvement history", () => {
    const sampleHistory: SelfImprovementHistoryEntry[] = [
      {
        timestamp: "2026-03-20T14:00:00.000Z",
        status: "success",
        tasksCreatedCount: 3,
        mode: "audit_and_experiments",
        outcome: "tasks_created",
        summary: "Fixed lint issues and added tests",
        runId: "run-1",
      },
      {
        timestamp: "2026-03-19T10:00:00.000Z",
        status: "success",
        tasksCreatedCount: 0,
        mode: "audit_only",
        outcome: "no_changes",
        summary: "No actionable findings",
        runId: "run-2",
      },
    ];

    it("renders Recent runs list from API history", async () => {
      vi.mocked(api.projects.getSelfImprovementHistory).mockResolvedValue(sampleHistory);
      renderWorkflowContent();

      await waitFor(() => {
        expect(screen.getByTestId("self-improvement-recent-runs")).toBeInTheDocument();
      });

      const rows = screen.getAllByTestId("self-improvement-history-row");
      expect(rows).toHaveLength(2);
      expect(api.projects.getSelfImprovementHistory).toHaveBeenCalledWith("proj-1", 20);
    });

    it("renders mode badges correctly", async () => {
      vi.mocked(api.projects.getSelfImprovementHistory).mockResolvedValue(sampleHistory);
      renderWorkflowContent();

      await waitFor(() => {
        expect(screen.getByTestId("self-improvement-recent-runs")).toBeInTheDocument();
      });

      const modeBadges = screen.getAllByTestId("history-mode-badge");
      expect(modeBadges[0]).toHaveTextContent("Audit + experiments");
      expect(modeBadges[1]).toHaveTextContent("Audit only");
    });

    it("renders outcome badges correctly", async () => {
      vi.mocked(api.projects.getSelfImprovementHistory).mockResolvedValue(sampleHistory);
      renderWorkflowContent();

      await waitFor(() => {
        expect(screen.getByTestId("self-improvement-recent-runs")).toBeInTheDocument();
      });

      const outcomeBadges = screen.getAllByTestId("history-outcome-badge");
      expect(outcomeBadges[0]).toHaveTextContent("Tasks created");
      expect(outcomeBadges[1]).toHaveTextContent("No changes");
    });

    it("renders run summaries", async () => {
      vi.mocked(api.projects.getSelfImprovementHistory).mockResolvedValue(sampleHistory);
      renderWorkflowContent();

      await waitFor(() => {
        expect(screen.getByTestId("self-improvement-recent-runs")).toBeInTheDocument();
      });

      const summaries = screen.getAllByTestId("history-summary");
      expect(summaries[0]).toHaveTextContent("Fixed lint issues and added tests");
      expect(summaries[1]).toHaveTextContent("No actionable findings");
    });

    it("renders summary row with last run and last outcome", async () => {
      vi.mocked(api.projects.getSelfImprovementHistory).mockResolvedValue(sampleHistory);
      renderWorkflowContent();

      await waitFor(() => {
        expect(screen.getByTestId("self-improvement-summary-row")).toBeInTheDocument();
      });

      expect(screen.getByTestId("summary-last-run")).toBeInTheDocument();
      expect(screen.getByTestId("summary-last-outcome")).toHaveTextContent("Tasks created");
    });

    it("renders active behavior version in summary when present", async () => {
      vi.mocked(api.projects.getSelfImprovementHistory).mockResolvedValue(sampleHistory);
      renderWorkflowContent({
        selfImprovementActiveBehaviorVersionId: "bv-42",
      });

      await waitFor(() => {
        expect(screen.getByTestId("summary-active-version")).toBeInTheDocument();
      });

      expect(screen.getByTestId("summary-active-version")).toHaveTextContent("bv-42");
    });

    it("renders pending promotion in summary when present", async () => {
      vi.mocked(api.projects.getSelfImprovementHistory).mockResolvedValue(sampleHistory);
      renderWorkflowContent({
        selfImprovementPendingCandidateId: "cand-7",
      });

      await waitFor(() => {
        expect(screen.getByTestId("summary-pending-promotion")).toBeInTheDocument();
      });

      expect(screen.getByTestId("summary-pending-promotion")).toHaveTextContent("cand-7");
    });

    it("does not render summary row or Recent runs when history is empty", async () => {
      vi.mocked(api.projects.getSelfImprovementHistory).mockResolvedValue([]);
      renderWorkflowContent();

      await waitFor(() => {
        expect(screen.getByTestId("self-improvement-status-label")).toHaveTextContent("Idle");
      });

      expect(screen.queryByTestId("self-improvement-summary-row")).not.toBeInTheDocument();
      expect(screen.queryByTestId("self-improvement-recent-runs")).not.toBeInTheDocument();
    });

    it("does not render active version or pending promotion when not set", async () => {
      vi.mocked(api.projects.getSelfImprovementHistory).mockResolvedValue(sampleHistory);
      renderWorkflowContent();

      await waitFor(() => {
        expect(screen.getByTestId("self-improvement-summary-row")).toBeInTheDocument();
      });

      expect(screen.queryByTestId("summary-active-version")).not.toBeInTheDocument();
      expect(screen.queryByTestId("summary-pending-promotion")).not.toBeInTheDocument();
    });

    it("renders all outcome badge types", async () => {
      const allOutcomes: SelfImprovementHistoryEntry[] = [
        { timestamp: "2026-03-20T14:00:00Z", status: "success", tasksCreatedCount: 0, mode: "audit_only", outcome: "promoted", summary: "Promoted", runId: "r1" },
        { timestamp: "2026-03-19T14:00:00Z", status: "success", tasksCreatedCount: 0, mode: "audit_and_experiments", outcome: "promotion_pending", summary: "Pending", runId: "r2" },
        { timestamp: "2026-03-18T14:00:00Z", status: "success", tasksCreatedCount: 0, mode: "audit_only", outcome: "candidate_rejected", summary: "Rejected", runId: "r3" },
        { timestamp: "2026-03-17T14:00:00Z", status: "failed", tasksCreatedCount: 0, mode: "audit_only", outcome: "failed", summary: "Failed", runId: "r4" },
      ];
      vi.mocked(api.projects.getSelfImprovementHistory).mockResolvedValue(allOutcomes);
      renderWorkflowContent();

      await waitFor(() => {
        expect(screen.getAllByTestId("history-outcome-badge")).toHaveLength(4);
      });

      const badges = screen.getAllByTestId("history-outcome-badge");
      expect(badges[0]).toHaveTextContent("Promoted");
      expect(badges[1]).toHaveTextContent("Promotion pending");
      expect(badges[2]).toHaveTextContent("Candidate rejected");
      expect(badges[3]).toHaveTextContent("Failed");
    });
  });
});
