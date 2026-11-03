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
      approveSelfImprovement: vi.fn(),
      rejectSelfImprovement: vi.fn(),
      rollbackSelfImprovement: vi.fn(),
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

function renderWorkflowContent(overrides?: Partial<ProjectSettings>, routeEntries?: string[]) {
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
    />,
    { routeEntries }
  );

  return {
    persistSettings,
    scheduleSaveOnBlur,
    lastReviewAnglesRef,
  };
}

describe("WorkflowSettingsContent", () => {
  it("uses and locks a shared plan branch for PR delivery", () => {
    renderWorkflowContent({ deliveryMode: "pull_request", mergeStrategy: "per_task" });
    expect(screen.getByRole("combobox", { name: "Merge strategy" })).toHaveValue("per_epic");
    expect(screen.getByRole("combobox", { name: "Merge strategy" })).toBeDisabled();
    expect(screen.getByText(/PR delivery uses one shared branch per plan/)).toBeInTheDocument();
  });

  beforeEach(() => {
    vi.mocked(api.projects.runSelfImprovement).mockReset();
    vi.mocked(api.projects.getSelfImprovementStatus).mockReset();
    vi.mocked(api.projects.getSelfImprovementHistory).mockReset();
    vi.mocked(api.projects.rollbackSelfImprovement).mockReset();
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

  it("persists max total concurrent agents when cap is enabled then slider changes", () => {
    const { persistSettings } = renderWorkflowContent({ maxConcurrentCoders: 2 });

    fireEvent.click(screen.getByTestId("max-total-agents-cap-checkbox"));
    expect(persistSettings).toHaveBeenCalledWith(undefined, { maxTotalConcurrentAgents: 10 });

    persistSettings.mockClear();
    fireEvent.change(screen.getByTestId("max-total-concurrent-agents-slider"), {
      target: { value: "5" },
    });
    expect(persistSettings).toHaveBeenCalledWith(undefined, { maxTotalConcurrentAgents: 5 });
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

    it("renders outcome badges correctly", async () => {
      vi.mocked(api.projects.getSelfImprovementHistory).mockResolvedValue(sampleHistory);
      renderWorkflowContent();

      await waitFor(() => {
        expect(screen.getByTestId("self-improvement-recent-runs")).toBeInTheDocument();
      });

      const outcomeBadges = screen.getAllByTestId("history-outcome-badge");
      expect(outcomeBadges[0]).toHaveTextContent("Tasks created");
      expect(outcomeBadges[1]).toHaveTextContent("No changes");
      expect(screen.queryByTestId("history-mode-badge")).not.toBeInTheDocument();
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

    it("wraps multi-line run summaries instead of single-line truncation", async () => {
      const multiLineSummary =
        "Baseline: merge gates passed.\nCandidate: npm run test failed — AssertionError in orchestrator.\nNext: fix test isolation.";
      vi.mocked(api.projects.getSelfImprovementHistory).mockResolvedValue([
        {
          ...sampleHistory[0],
          summary: multiLineSummary,
        },
      ]);
      renderWorkflowContent();

      await waitFor(() => {
        expect(screen.getByTestId("self-improvement-recent-runs")).toBeInTheDocument();
      });

      const summary = screen.getByTestId("history-summary");
      expect(summary).toHaveTextContent("Baseline: merge gates passed.");
      expect(summary).toHaveTextContent("Candidate: npm run test failed");
      expect(summary).toHaveTextContent("Next: fix test isolation.");
      expect(summary.className).toContain("whitespace-pre-wrap");
      expect(summary.className).toContain("break-words");
      expect(summary.className).not.toContain("truncate");
    });

    it("does not duplicate last run / outcome in a summary grid when only history exists", async () => {
      vi.mocked(api.projects.getSelfImprovementHistory).mockResolvedValue(sampleHistory);
      renderWorkflowContent({
        selfImprovementLastRunAt: "2026-03-20T14:00:00.000Z",
      });

      await waitFor(() => {
        expect(screen.getByTestId("self-improvement-recent-runs")).toBeInTheDocument();
      });

      expect(screen.queryByTestId("self-improvement-summary-row")).not.toBeInTheDocument();
      expect(screen.queryByTestId("self-improvement-last-run")).not.toBeInTheDocument();
      const outcomeBadges = screen.getAllByTestId("history-outcome-badge");
      expect(outcomeBadges[0]).toHaveTextContent("Tasks created");
    });

    it("shows Next run in schedule but not Last run when history exists and both timestamps are set", async () => {
      vi.mocked(api.projects.getSelfImprovementHistory).mockResolvedValue(sampleHistory);
      renderWorkflowContent({
        selfImprovementLastRunAt: "2026-03-20T14:00:00.000Z",
        nextRunAt: "2026-03-25T08:00:00.000Z",
      });

      await waitFor(() => {
        expect(screen.getByTestId("self-improvement-recent-runs")).toBeInTheDocument();
      });

      expect(screen.queryByTestId("self-improvement-last-run")).not.toBeInTheDocument();
      expect(screen.getByTestId("self-improvement-next-run")).toHaveTextContent("Next run:");
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

    it("does not render summary grid when history exists but no active version or pending promotion", async () => {
      vi.mocked(api.projects.getSelfImprovementHistory).mockResolvedValue(sampleHistory);
      renderWorkflowContent();

      await waitFor(() => {
        expect(screen.getByTestId("self-improvement-recent-runs")).toBeInTheDocument();
      });

      expect(screen.queryByTestId("self-improvement-summary-row")).not.toBeInTheDocument();
      expect(screen.queryByTestId("summary-active-version")).not.toBeInTheDocument();
      expect(screen.queryByTestId("summary-pending-promotion")).not.toBeInTheDocument();
    });

    it("renders all outcome badge types", async () => {
      const allOutcomes: SelfImprovementHistoryEntry[] = [
        {
          timestamp: "2026-03-20T14:00:00Z",
          status: "success",
          tasksCreatedCount: 0,
          mode: "audit_only",
          outcome: "promoted",
          summary: "Promoted",
          runId: "r1",
        },
        {
          timestamp: "2026-03-19T14:00:00Z",
          status: "success",
          tasksCreatedCount: 0,
          mode: "audit_and_experiments",
          outcome: "promotion_pending",
          summary: "Pending",
          runId: "r2",
        },
        {
          timestamp: "2026-03-18T14:00:00Z",
          status: "success",
          tasksCreatedCount: 0,
          mode: "audit_only",
          outcome: "candidate_rejected",
          summary: "Rejected",
          runId: "r3",
        },
        {
          timestamp: "2026-03-17T14:00:00Z",
          status: "failed",
          tasksCreatedCount: 0,
          mode: "audit_only",
          outcome: "failed",
          summary: "Failed",
          runId: "r4",
        },
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

  describe("approval card", () => {
    const awaitingApprovalStatus: SelfImprovementStatusSnapshot = {
      status: "awaiting_approval",
      pendingCandidateId: "cand-42",
      summary: "A candidate behavior version is awaiting approval.",
      candidateDiff: [
        { section: "General Instructions", before: "Be concise", after: "Be concise and thorough" },
        { section: "Coder Role", before: "", after: "Always run tests before completing" },
      ],
      replaySampleSize: 15,
      baselineMetrics: { taskSuccessRate: 0.72, retryRate: 0.18, reviewPassRate: 0.85 },
      candidateMetrics: { taskSuccessRate: 0.88, retryRate: 0.1, reviewPassRate: 0.92 },
    };

    it("renders approval card when awaiting_approval with pendingCandidateId", async () => {
      vi.mocked(api.projects.getSelfImprovementStatus).mockResolvedValue(awaitingApprovalStatus);
      renderWorkflowContent();

      await waitFor(() => {
        expect(screen.getByTestId("self-improvement-approval-card")).toBeInTheDocument();
      });

      expect(screen.getByTestId("approval-promote-btn")).toBeInTheDocument();
      expect(screen.getByTestId("approval-reject-btn")).toBeInTheDocument();
      expect(screen.getByTestId("approval-promote-btn")).toHaveTextContent("Promote");
      expect(screen.getByTestId("approval-reject-btn")).toHaveTextContent("Reject");
    });

    it("does not render approval card when status is idle", async () => {
      renderWorkflowContent();

      await waitFor(() => {
        expect(screen.getByTestId("self-improvement-status-label")).toHaveTextContent("Idle");
      });

      expect(screen.queryByTestId("self-improvement-approval-card")).not.toBeInTheDocument();
    });

    it("does not render approval card when awaiting_approval but no pendingCandidateId", async () => {
      vi.mocked(api.projects.getSelfImprovementStatus).mockResolvedValue({
        status: "awaiting_approval",
      });
      renderWorkflowContent();

      await waitFor(() => {
        expect(screen.getByTestId("self-improvement-status-label")).toHaveTextContent(
          "Awaiting approval"
        );
      });

      expect(screen.queryByTestId("self-improvement-approval-card")).not.toBeInTheDocument();
    });

    it("displays candidate diff entries", async () => {
      vi.mocked(api.projects.getSelfImprovementStatus).mockResolvedValue(awaitingApprovalStatus);
      renderWorkflowContent();

      await waitFor(() => {
        expect(screen.getByTestId("approval-candidate-diff")).toBeInTheDocument();
      });

      const diffEntries = screen.getAllByTestId("approval-diff-entry");
      expect(diffEntries).toHaveLength(2);
      expect(diffEntries[0]).toHaveTextContent("General Instructions");
      expect(diffEntries[0]).toHaveTextContent("Be concise");
      expect(diffEntries[0]).toHaveTextContent("Be concise and thorough");
      expect(diffEntries[1]).toHaveTextContent("Coder Role");
      expect(diffEntries[1]).toHaveTextContent("(empty)");
      expect(diffEntries[1]).toHaveTextContent("Always run tests before completing");
    });

    it("displays replay sample size", async () => {
      vi.mocked(api.projects.getSelfImprovementStatus).mockResolvedValue(awaitingApprovalStatus);
      renderWorkflowContent();

      await waitFor(() => {
        expect(screen.getByTestId("approval-replay-sample-size")).toBeInTheDocument();
      });

      expect(screen.getByTestId("approval-replay-sample-size")).toHaveTextContent("15");
    });

    it("displays baseline vs candidate metrics", async () => {
      vi.mocked(api.projects.getSelfImprovementStatus).mockResolvedValue(awaitingApprovalStatus);
      renderWorkflowContent();

      await waitFor(() => {
        expect(screen.getByTestId("approval-metrics")).toBeInTheDocument();
      });

      expect(screen.getByTestId("approval-metrics")).toHaveTextContent("Task success rate");
      expect(screen.getByTestId("approval-metrics")).toHaveTextContent("72.0%");
      expect(screen.getByTestId("approval-metrics")).toHaveTextContent("88.0%");
      expect(screen.getByTestId("approval-metrics")).toHaveTextContent("Retry rate");
      expect(screen.getByTestId("approval-metrics")).toHaveTextContent("Review pass rate");
    });

    it("does not render diff section when candidateDiff is absent", async () => {
      vi.mocked(api.projects.getSelfImprovementStatus).mockResolvedValue({
        status: "awaiting_approval",
        pendingCandidateId: "cand-minimal",
      });
      renderWorkflowContent();

      await waitFor(() => {
        expect(screen.getByTestId("self-improvement-approval-card")).toBeInTheDocument();
      });

      expect(screen.queryByTestId("approval-candidate-diff")).not.toBeInTheDocument();
      expect(screen.queryByTestId("approval-replay-sample-size")).not.toBeInTheDocument();
      expect(screen.queryByTestId("approval-metrics")).not.toBeInTheDocument();
    });

    it("Promote button calls approveSelfImprovement and shows success", async () => {
      vi.mocked(api.projects.getSelfImprovementStatus).mockResolvedValue(awaitingApprovalStatus);
      vi.mocked(api.projects.approveSelfImprovement).mockResolvedValue({
        activeBehaviorVersionId: "cand-42",
        behaviorVersions: [{ id: "cand-42", promotedAt: "2026-03-21T00:00:00Z" }],
        history: [
          {
            timestamp: "2026-03-21T00:00:00Z",
            action: "approved",
            behaviorVersionId: "cand-42",
            candidateId: "cand-42",
          },
        ],
      });
      renderWorkflowContent();

      await waitFor(() => {
        expect(screen.getByTestId("approval-promote-btn")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId("approval-promote-btn"));

      await waitFor(() => {
        expect(api.projects.approveSelfImprovement).toHaveBeenCalledWith("proj-1", "cand-42");
      });

      await waitFor(() => {
        expect(screen.getByTestId("approval-feedback-message")).toHaveTextContent(
          "Candidate promoted successfully"
        );
      });
    });

    it("Reject button calls rejectSelfImprovement and shows success", async () => {
      vi.mocked(api.projects.getSelfImprovementStatus).mockResolvedValue(awaitingApprovalStatus);
      vi.mocked(api.projects.rejectSelfImprovement).mockResolvedValue({
        behaviorVersions: [],
        history: [
          { timestamp: "2026-03-21T00:00:00Z", action: "rejected", candidateId: "cand-42" },
        ],
      });
      renderWorkflowContent();

      await waitFor(() => {
        expect(screen.getByTestId("approval-reject-btn")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId("approval-reject-btn"));

      await waitFor(() => {
        expect(api.projects.rejectSelfImprovement).toHaveBeenCalledWith("proj-1", "cand-42");
      });

      await waitFor(() => {
        expect(screen.getByTestId("approval-feedback-message")).toHaveTextContent(
          "Candidate rejected"
        );
      });
    });

    it("Promote button shows loading state while pending", async () => {
      vi.mocked(api.projects.getSelfImprovementStatus).mockResolvedValue(awaitingApprovalStatus);
      let resolveApprove: (v: unknown) => void;
      const approvePromise = new Promise((r) => {
        resolveApprove = r;
      });
      vi.mocked(api.projects.approveSelfImprovement).mockReturnValue(
        approvePromise as ReturnType<typeof api.projects.approveSelfImprovement>
      );
      renderWorkflowContent();

      await waitFor(() => {
        expect(screen.getByTestId("approval-promote-btn")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId("approval-promote-btn"));

      await waitFor(() => {
        expect(screen.getByTestId("approval-promote-btn")).toHaveTextContent("Promoting…");
      });
      expect(screen.getByTestId("approval-reject-btn")).toBeDisabled();

      resolveApprove!({ activeBehaviorVersionId: "cand-42", behaviorVersions: [], history: [] });
      await waitFor(() => {
        expect(screen.getByTestId("approval-promote-btn")).toHaveTextContent("Promote");
      });
    });

    it("Reject button shows loading state while pending", async () => {
      vi.mocked(api.projects.getSelfImprovementStatus).mockResolvedValue(awaitingApprovalStatus);
      let resolveReject: (v: unknown) => void;
      const rejectPromise = new Promise((r) => {
        resolveReject = r;
      });
      vi.mocked(api.projects.rejectSelfImprovement).mockReturnValue(
        rejectPromise as ReturnType<typeof api.projects.rejectSelfImprovement>
      );
      renderWorkflowContent();

      await waitFor(() => {
        expect(screen.getByTestId("approval-reject-btn")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId("approval-reject-btn"));

      await waitFor(() => {
        expect(screen.getByTestId("approval-reject-btn")).toHaveTextContent("Rejecting…");
      });
      expect(screen.getByTestId("approval-promote-btn")).toBeDisabled();

      resolveReject!({ behaviorVersions: [], history: [] });
      await waitFor(() => {
        expect(screen.getByTestId("approval-reject-btn")).toHaveTextContent("Reject");
      });
    });

    it("shows error feedback when Promote fails", async () => {
      vi.mocked(api.projects.getSelfImprovementStatus).mockResolvedValue(awaitingApprovalStatus);
      vi.mocked(api.projects.approveSelfImprovement).mockRejectedValue(
        new Error("No pending candidate")
      );
      renderWorkflowContent();

      await waitFor(() => {
        expect(screen.getByTestId("approval-promote-btn")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId("approval-promote-btn"));

      await waitFor(() => {
        expect(screen.getByTestId("approval-feedback-message")).toHaveTextContent(
          "No pending candidate"
        );
      });
    });

    it("shows error feedback when Reject fails", async () => {
      vi.mocked(api.projects.getSelfImprovementStatus).mockResolvedValue(awaitingApprovalStatus);
      vi.mocked(api.projects.rejectSelfImprovement).mockRejectedValue(
        new Error("candidateId does not match")
      );
      renderWorkflowContent();

      await waitFor(() => {
        expect(screen.getByTestId("approval-reject-btn")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId("approval-reject-btn"));

      await waitFor(() => {
        expect(screen.getByTestId("approval-feedback-message")).toHaveTextContent(
          "candidateId does not match"
        );
      });
    });

    it("displays pending candidate id in card header", async () => {
      vi.mocked(api.projects.getSelfImprovementStatus).mockResolvedValue(awaitingApprovalStatus);
      renderWorkflowContent();

      await waitFor(() => {
        expect(screen.getByTestId("self-improvement-approval-card")).toBeInTheDocument();
      });

      expect(screen.getByTestId("self-improvement-approval-card")).toHaveTextContent("cand-42");
    });
  });

  describe("rollback section", () => {
    const sampleHistory: SelfImprovementHistoryEntry[] = [
      {
        timestamp: "2026-03-20T14:00:00.000Z",
        status: "success",
        tasksCreatedCount: 0,
        mode: "audit_and_experiments",
        outcome: "promoted",
        summary: "Promoted v2",
        runId: "run-1",
        promotedVersionId: "bv-2",
      },
    ];

    it("does not show rollback section when no behavior versions exist", async () => {
      vi.mocked(api.projects.getSelfImprovementHistory).mockResolvedValue(sampleHistory);
      renderWorkflowContent();

      await waitFor(() => {
        expect(screen.getByTestId("self-improvement-recent-runs")).toBeInTheDocument();
      });

      expect(screen.queryByTestId("self-improvement-rollback-section")).not.toBeInTheDocument();
    });

    it("does not show rollback section when only one version exists (the active one)", async () => {
      vi.mocked(api.projects.getSelfImprovementHistory).mockResolvedValue(sampleHistory);
      renderWorkflowContent({
        selfImprovementActiveBehaviorVersionId: "bv-2",
        selfImprovementBehaviorVersions: [{ id: "bv-2", promotedAt: "2026-03-20T14:00:00Z" }],
      });

      await waitFor(() => {
        expect(screen.getByTestId("self-improvement-summary-row")).toBeInTheDocument();
      });

      expect(screen.queryByTestId("self-improvement-rollback-section")).not.toBeInTheDocument();
    });

    it("shows rollback section when multiple promoted versions exist", async () => {
      vi.mocked(api.projects.getSelfImprovementHistory).mockResolvedValue(sampleHistory);
      renderWorkflowContent({
        selfImprovementActiveBehaviorVersionId: "bv-2",
        selfImprovementBehaviorVersions: [
          { id: "bv-1", promotedAt: "2026-03-18T10:00:00Z" },
          { id: "bv-2", promotedAt: "2026-03-20T14:00:00Z" },
        ],
      });

      await waitFor(() => {
        expect(screen.getByTestId("self-improvement-rollback-section")).toBeInTheDocument();
      });

      expect(screen.getByTestId("rollback-version-select")).toBeInTheDocument();
      expect(screen.getByTestId("rollback-btn")).toBeInTheDocument();
      expect(screen.getByTestId("rollback-btn")).toHaveTextContent("Rollback");
    });

    it("rollback button is disabled when no version is selected", async () => {
      vi.mocked(api.projects.getSelfImprovementHistory).mockResolvedValue(sampleHistory);
      renderWorkflowContent({
        selfImprovementActiveBehaviorVersionId: "bv-2",
        selfImprovementBehaviorVersions: [
          { id: "bv-1", promotedAt: "2026-03-18T10:00:00Z" },
          { id: "bv-2", promotedAt: "2026-03-20T14:00:00Z" },
        ],
      });

      await waitFor(() => {
        expect(screen.getByTestId("rollback-btn")).toBeInTheDocument();
      });

      expect(screen.getByTestId("rollback-btn")).toBeDisabled();
    });

    it("dropdown only lists versions other than the active one", async () => {
      vi.mocked(api.projects.getSelfImprovementHistory).mockResolvedValue(sampleHistory);
      renderWorkflowContent({
        selfImprovementActiveBehaviorVersionId: "bv-2",
        selfImprovementBehaviorVersions: [
          { id: "bv-1", promotedAt: "2026-03-18T10:00:00Z" },
          { id: "bv-2", promotedAt: "2026-03-20T14:00:00Z" },
        ],
      });

      await waitFor(() => {
        expect(screen.getByTestId("rollback-version-select")).toBeInTheDocument();
      });

      const select = screen.getByTestId("rollback-version-select") as HTMLSelectElement;
      const options = Array.from(select.options);
      expect(options).toHaveLength(2);
      expect(options[0]).toHaveTextContent("Select a version…");
      expect(options[1]).toHaveTextContent("bv-1");
      expect(options.some((o) => o.textContent?.includes("bv-2"))).toBe(false);
    });

    it("calls rollbackSelfImprovement on Rollback click and shows success", async () => {
      vi.mocked(api.projects.getSelfImprovementHistory).mockResolvedValue(sampleHistory);
      vi.mocked(api.projects.rollbackSelfImprovement).mockResolvedValue({
        activeBehaviorVersionId: "bv-1",
        behaviorVersions: [
          { id: "bv-1", promotedAt: "2026-03-18T10:00:00Z" },
          { id: "bv-2", promotedAt: "2026-03-20T14:00:00Z" },
        ],
        history: [
          {
            timestamp: "2026-03-21T00:00:00Z",
            action: "rollback",
            behaviorVersionId: "bv-1",
          },
        ],
      });
      renderWorkflowContent({
        selfImprovementActiveBehaviorVersionId: "bv-2",
        selfImprovementBehaviorVersions: [
          { id: "bv-1", promotedAt: "2026-03-18T10:00:00Z" },
          { id: "bv-2", promotedAt: "2026-03-20T14:00:00Z" },
        ],
      });

      await waitFor(() => {
        expect(screen.getByTestId("rollback-version-select")).toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId("rollback-version-select"), {
        target: { value: "bv-1" },
      });
      fireEvent.click(screen.getByTestId("rollback-btn"));

      await waitFor(() => {
        expect(api.projects.rollbackSelfImprovement).toHaveBeenCalledWith("proj-1", {
          behaviorVersionId: "bv-1",
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId("rollback-feedback-message")).toHaveTextContent(
          "Rolled back successfully"
        );
      });
    });

    it("shows error feedback when rollback fails", async () => {
      vi.mocked(api.projects.getSelfImprovementHistory).mockResolvedValue(sampleHistory);
      vi.mocked(api.projects.rollbackSelfImprovement).mockRejectedValue(
        new Error("Version not found")
      );
      renderWorkflowContent({
        selfImprovementActiveBehaviorVersionId: "bv-2",
        selfImprovementBehaviorVersions: [
          { id: "bv-1", promotedAt: "2026-03-18T10:00:00Z" },
          { id: "bv-2", promotedAt: "2026-03-20T14:00:00Z" },
        ],
      });

      await waitFor(() => {
        expect(screen.getByTestId("rollback-version-select")).toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId("rollback-version-select"), {
        target: { value: "bv-1" },
      });
      fireEvent.click(screen.getByTestId("rollback-btn"));

      await waitFor(() => {
        expect(screen.getByTestId("rollback-feedback-message")).toHaveTextContent(
          "Version not found"
        );
      });
    });

    it("shows loading state while rollback is pending", async () => {
      vi.mocked(api.projects.getSelfImprovementHistory).mockResolvedValue(sampleHistory);
      let resolveRollback: (v: unknown) => void;
      const rollbackPromise = new Promise((r) => {
        resolveRollback = r;
      });
      vi.mocked(api.projects.rollbackSelfImprovement).mockReturnValue(
        rollbackPromise as ReturnType<typeof api.projects.rollbackSelfImprovement>
      );
      renderWorkflowContent({
        selfImprovementActiveBehaviorVersionId: "bv-2",
        selfImprovementBehaviorVersions: [
          { id: "bv-1", promotedAt: "2026-03-18T10:00:00Z" },
          { id: "bv-2", promotedAt: "2026-03-20T14:00:00Z" },
        ],
      });

      await waitFor(() => {
        expect(screen.getByTestId("rollback-version-select")).toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId("rollback-version-select"), {
        target: { value: "bv-1" },
      });
      fireEvent.click(screen.getByTestId("rollback-btn"));

      await waitFor(() => {
        expect(screen.getByTestId("rollback-btn")).toHaveTextContent("Rolling back…");
      });

      resolveRollback!({
        activeBehaviorVersionId: "bv-1",
        behaviorVersions: [],
        history: [],
      });
      await waitFor(() => {
        expect(screen.getByTestId("rollback-btn")).toHaveTextContent("Rollback");
      });
    });
  });

  describe("self-improvement review section", () => {
    it("renders the self-improvement review section", () => {
      renderWorkflowContent();
      expect(screen.getByTestId("self-improvement-review-section")).toBeInTheDocument();
      expect(screen.getByText("Self-Improvement Review")).toBeInTheDocument();
    });

    it("does not render a review mode dropdown in the self-improvement section", () => {
      renderWorkflowContent();
      expect(screen.queryByTestId("self-improvement-review-mode-select")).not.toBeInTheDocument();
    });

    it("shows 'Using code review angles' with Customize button when no explicit angles", () => {
      renderWorkflowContent();
      expect(screen.getByText(/Using code review angles/)).toBeInTheDocument();
      expect(screen.getByTestId("si-review-customize-btn")).toBeInTheDocument();
    });

    it("angle checkboxes are disabled when in default (non-customized) mode", () => {
      renderWorkflowContent();
      const multiselect = screen.getByTestId("self-improvement-reviewer-agents-multiselect");
      const checkboxes = multiselect.querySelectorAll("input[type=checkbox]");
      checkboxes.forEach((cb) => expect(cb).toBeDisabled());
    });

    it("clicking Customize copies code review settings and enables angle editing", () => {
      const { persistSettings } = renderWorkflowContent({
        reviewAngles: ["security", "performance"],
        includeGeneralReview: true,
      });
      fireEvent.click(screen.getByTestId("si-review-customize-btn"));
      expect(persistSettings).toHaveBeenCalledWith(undefined, {
        selfImprovementReviewerAgents: ["security", "performance"],
        selfImprovementIncludeGeneralReview: true,
      });
    });

    it("shows 'Custom angles set' with Reset button when explicit angles are present", () => {
      renderWorkflowContent({
        selfImprovementReviewerAgents: ["security"],
        selfImprovementIncludeGeneralReview: false,
      });
      expect(screen.getByText(/Custom angles set/)).toBeInTheDocument();
      expect(screen.getByTestId("si-review-reset-btn")).toBeInTheDocument();
    });

    it("clicking Reset clears self-improvement review angle settings", () => {
      const { persistSettings } = renderWorkflowContent({
        selfImprovementReviewerAgents: ["security"],
        selfImprovementIncludeGeneralReview: false,
      });
      fireEvent.click(screen.getByTestId("si-review-reset-btn"));
      expect(persistSettings).toHaveBeenCalledWith(undefined, {
        selfImprovementReviewerAgents: undefined,
        selfImprovementIncludeGeneralReview: undefined,
      });
    });

    it("angle checkboxes are enabled when customized", () => {
      renderWorkflowContent({
        selfImprovementReviewerAgents: ["security"],
        selfImprovementIncludeGeneralReview: true,
      });
      const multiselect = screen.getByTestId("self-improvement-reviewer-agents-multiselect");
      const checkboxes = Array.from(multiselect.querySelectorAll("input[type=checkbox]"));
      const enabledCount = checkboxes.filter((cb) => !(cb as HTMLInputElement).disabled).length;
      expect(enabledCount).toBeGreaterThan(0);
    });

    it("toggling an angle checkbox persists self-improvement reviewer agents", () => {
      const { persistSettings } = renderWorkflowContent({
        selfImprovementReviewerAgents: ["security"],
        selfImprovementIncludeGeneralReview: true,
      });
      const siSection = screen.getByTestId("self-improvement-reviewer-agents-multiselect");
      const performanceCheckbox = siSection.querySelector(
        "#si-review-agent-performance"
      ) as HTMLInputElement;
      fireEvent.click(performanceCheckbox);
      expect(persistSettings).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({
          selfImprovementReviewerAgents: expect.arrayContaining(["security", "performance"]),
        })
      );
    });

    it("code review section still has review mode dropdown", () => {
      renderWorkflowContent();
      expect(screen.getByTestId("review-mode-select")).toBeInTheDocument();
    });

    it("renders the review angles multiselect container", () => {
      renderWorkflowContent();
      expect(
        screen.getByTestId("self-improvement-reviewer-agents-multiselect")
      ).toBeInTheDocument();
    });

    it("has exactly one review-mode-select in the entire page (Code Review only, not SI)", () => {
      renderWorkflowContent();
      const allReviewModeSelects = screen.getAllByTestId("review-mode-select");
      expect(allReviewModeSelects).toHaveLength(1);
      const qualityGatesCard = screen.getByTestId("workflow-quality-gates-card");
      expect(qualityGatesCard).toContainElement(allReviewModeSelects[0]);
    });

    it("SI section contains reviewer agents but no review mode control", () => {
      renderWorkflowContent({
        selfImprovementReviewerAgents: ["security"],
        selfImprovementIncludeGeneralReview: true,
      });
      const siSection = screen.getByTestId("self-improvement-section");
      expect(
        siSection.querySelector("[data-testid='self-improvement-reviewer-agents-multiselect']")
      ).toBeInTheDocument();
      expect(
        siSection.querySelector("[data-testid='self-improvement-review-mode-select']")
      ).not.toBeInTheDocument();
      expect(siSection.querySelector("[data-testid='review-mode-select']")).not.toBeInTheDocument();
    });

    it("does not persist a selfImprovementReviewMode key when customizing SI angles", () => {
      const { persistSettings } = renderWorkflowContent({
        reviewAngles: ["security"],
        includeGeneralReview: true,
      });
      fireEvent.click(screen.getByTestId("si-review-customize-btn"));
      for (const call of persistSettings.mock.calls) {
        const overrides = call[1];
        if (overrides && typeof overrides === "object") {
          expect(overrides).not.toHaveProperty("selfImprovementReviewMode");
        }
      }
    });
  });

  describe("focus=self-improvement deep link", () => {
    it("scrolls self-improvement card into view when focus=self-improvement is in URL", async () => {
      const scrollIntoViewMock = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoViewMock;

      renderWorkflowContent(undefined, ["/?focus=self-improvement"]);

      await waitFor(() => {
        expect(scrollIntoViewMock).toHaveBeenCalledWith({
          behavior: "smooth",
          block: "start",
        });
      });
    });

    it("does not scroll when focus param is absent", async () => {
      const scrollIntoViewMock = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoViewMock;

      renderWorkflowContent();

      expect(screen.getByTestId("workflow-continuous-improvement-card")).toBeInTheDocument();
      expect(scrollIntoViewMock).not.toHaveBeenCalled();
    });
  });
});
