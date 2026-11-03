import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ProjectSettings,
  ReviewAngle,
  ReviewMode,
  SelfImprovementFrequency,
  GitWorkingMode,
  MergeStrategy,
  UnknownScopeStrategy,
} from "@opensprint/shared";
import {
  DEFAULT_MAX_TOTAL_CONCURRENT_AGENTS,
  DEFAULT_REVIEW_MODE,
  GENERAL_REVIEW_OPTION,
  MAX_TOTAL_CONCURRENT_AGENTS_CAP,
  REVIEW_AGENT_OPTIONS,
  SELF_IMPROVEMENT_FREQUENCY_OPTIONS,
  getSelfImprovementReviewerAgents,
  getSelfImprovementIncludeGeneralReview,
  normalizeWorktreeBaseBranch,
} from "@opensprint/shared";
import { api } from "../../api/client";
import { governanceAuthorityReason } from "../../lib/governance";
import type {
  SelfImprovementStatusSnapshot,
  SelfImprovementStage,
  SelfImprovementHistoryEntry,
  SelfImprovementRunOutcome,
  CandidateDiffEntry,
} from "../../api/client";
import { queryKeys } from "../../api/queryKeys";

type WorkflowPersistOverrides = Partial<{
  testCommand: string | null;
  reviewMode: ReviewMode;
  reviewAngles: ReviewAngle[];
  includeGeneralReview?: boolean;
  selfImprovementFrequency?: SelfImprovementFrequency;
  runAgentEnhancementExperiments?: boolean;
  selfImprovementReviewerAgents?: ReviewAngle[];
  selfImprovementIncludeGeneralReview?: boolean;
  gitWorkingMode: GitWorkingMode;
  mergeStrategy: MergeStrategy;
  worktreeBaseBranch: string;
  maxConcurrentCoders: number;
  maxTotalConcurrentAgents?: number | null;
  unknownScopeStrategy: UnknownScopeStrategy;
}>;

const STAGE_LABELS: Record<SelfImprovementStage, string> = {
  collecting_replay_cases: "Collecting replay cases",
  generating_candidate: "Generating candidate",
  replaying: "Replaying",
  scoring: "Scoring",
  promoting: "Promoting",
};

function statusLabel(snapshot: SelfImprovementStatusSnapshot): string {
  switch (snapshot.status) {
    case "running_audit":
      return "Running self-improvement audit\u2026";
    case "running_experiments":
      return "Running agent enhancement experiments\u2026";
    case "awaiting_approval":
      return "Awaiting approval to promote agent improvements";
    default:
      return "Idle";
  }
}

const OUTCOME_LABELS: Record<SelfImprovementRunOutcome, string> = {
  no_changes: "No changes",
  tasks_created: "Tasks created",
  candidate_rejected: "Candidate rejected",
  promotion_pending: "Promotion pending",
  promoted: "Promoted",
  failed: "Failed",
};

const OUTCOME_COLORS: Record<SelfImprovementRunOutcome, string> = {
  no_changes: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200",
  tasks_created: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  candidate_rejected: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
  promotion_pending: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  promoted: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  });
}

interface WorkflowSettingsContentProps {
  settings: ProjectSettings;
  projectId: string;
  persistSettings: (
    notifyOnComplete?: boolean,
    overrides?: WorkflowPersistOverrides
  ) => Promise<unknown> | void;
  scheduleSaveOnBlur: () => void;
  lastReviewAnglesRef: MutableRefObject<ProjectSettings["reviewAngles"] | undefined>;
  onSettingsChange?: (updater: (current: ProjectSettings) => ProjectSettings) => void;
}

interface ApiErrorLike extends Error {
  code?: string;
  details?: unknown;
}
interface CapabilityPrompt {
  retry: (capability: string) => void;
  error: string | null;
}
/** A capability cannot help when the server has no approval authority configured. */
function needsOwnerCapability(err: ApiErrorLike): boolean {
  return (
    err.code === "GOVERNANCE_HUMAN_REQUIRED" &&
    governanceAuthorityReason(err.details) !== "not_configured"
  );
}

export function WorkflowSettingsContent({
  settings,
  projectId,
  persistSettings,
  scheduleSaveOnBlur,
  lastReviewAnglesRef,
  onSettingsChange,
}: WorkflowSettingsContentProps) {
  const [draftSettings, setDraftSettings] = useState<ProjectSettings>(settings);
  const queryClient = useQueryClient();
  const [runNowMessage, setRunNowMessage] = useState<string | null>(null);
  const selfImprovementCardRef = useRef<HTMLElement>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const focusParam = searchParams.get("focus");

  useEffect(() => {
    if (focusParam === "self-improvement" && selfImprovementCardRef.current) {
      selfImprovementCardRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("focus");
          return next;
        },
        { replace: true }
      );
    }
  }, [focusParam, setSearchParams]);

  const selfImprovementStatusQuery = useQuery({
    queryKey: queryKeys.projects.selfImprovementStatus(projectId),
    queryFn: () => api.projects.getSelfImprovementStatus(projectId),
    refetchInterval: 10_000,
  });
  const siStatus: SelfImprovementStatusSnapshot = selfImprovementStatusQuery.data ?? {
    status: "idle",
  };

  const historyQuery = useQuery({
    queryKey: queryKeys.projects.selfImprovementHistory(projectId),
    queryFn: () => api.projects.getSelfImprovementHistory(projectId, 20),
  });
  const historyRuns: SelfImprovementHistoryEntry[] = historyQuery.data ?? [];
  /** Avoid duplicating the latest run timestamp: Recent runs lists it with outcome; settings lastRunAt is fallback when history is empty. */
  const showLastRunInSchedule =
    Boolean(draftSettings.selfImprovementLastRunAt) && historyRuns.length === 0;
  const showNextRunInSchedule = Boolean(draftSettings.nextRunAt);

  const runNowMutation = useMutation({
    mutationFn: () => api.projects.runSelfImprovement(projectId),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.settings(projectId) });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.selfImprovementHistory(projectId),
      });
      if (data.tasksCreated > 0) {
        setRunNowMessage(`${data.tasksCreated} task${data.tasksCreated === 1 ? "" : "s"} created`);
      } else if (data.skipped === "no_changes") {
        setRunNowMessage("No changes since last run");
      } else if (data.skipped === "run_in_progress") {
        setRunNowMessage("Run already in progress");
      } else {
        setRunNowMessage("Run completed");
      }
      setTimeout(() => setRunNowMessage(null), 5000);
    },
    onError: (err: Error) => {
      setRunNowMessage(err.message || "Run failed");
      setTimeout(() => setRunNowMessage(null), 5000);
    },
  });

  const [approvalMessage, setApprovalMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const [rollbackMessage, setRollbackMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [selectedRollbackVersionId, setSelectedRollbackVersionId] = useState<string>("");

  /** The owner's capability is held only until the prompted action has been retried. */
  const [capabilityPrompt, setCapabilityPrompt] = useState<CapabilityPrompt | null>(null);
  const [capabilityInput, setCapabilityInput] = useState("");
  const capabilityInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (capabilityPrompt) capabilityInputRef.current?.focus();
  }, [capabilityPrompt]);
  const promptForCapability = (err: Error, retry: (capability: string) => void): boolean => {
    if (!needsOwnerCapability(err)) return false;
    setCapabilityPrompt({
      retry,
      error:
        governanceAuthorityReason((err as ApiErrorLike).details) === "incorrect"
          ? err.message
          : null,
    });
    return true;
  };
  const closeCapabilityPrompt = () => {
    setCapabilityPrompt(null);
    setCapabilityInput("");
  };

  const approveMutation = useMutation({
    mutationFn: (capability?: string) =>
      capability
        ? api.projects.approveSelfImprovement(projectId, siStatus.pendingCandidateId, capability)
        : api.projects.approveSelfImprovement(projectId, siStatus.pendingCandidateId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.selfImprovementStatus(projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.selfImprovementHistory(projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.settings(projectId),
      });
      closeCapabilityPrompt();
      setApprovalMessage({ type: "success", text: "Candidate promoted successfully" });
      setTimeout(() => setApprovalMessage(null), 5000);
    },
    onError: (err: Error) => {
      if (promptForCapability(err, (capability) => approveMutation.mutate(capability))) return;
      setApprovalMessage({ type: "error", text: err.message || "Failed to promote candidate" });
      setTimeout(() => setApprovalMessage(null), 5000);
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (capability?: string) =>
      capability
        ? api.projects.rejectSelfImprovement(projectId, siStatus.pendingCandidateId, capability)
        : api.projects.rejectSelfImprovement(projectId, siStatus.pendingCandidateId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.selfImprovementStatus(projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.selfImprovementHistory(projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.settings(projectId),
      });
      closeCapabilityPrompt();
      setApprovalMessage({ type: "success", text: "Candidate rejected" });
      setTimeout(() => setApprovalMessage(null), 5000);
    },
    onError: (err: Error) => {
      if (promptForCapability(err, (capability) => rejectMutation.mutate(capability))) return;
      setApprovalMessage({ type: "error", text: err.message || "Failed to reject candidate" });
      setTimeout(() => setApprovalMessage(null), 5000);
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: ({
      behaviorVersionId,
      capability,
    }: {
      behaviorVersionId: string;
      capability?: string;
    }) =>
      capability
        ? api.projects.rollbackSelfImprovement(projectId, { behaviorVersionId }, capability)
        : api.projects.rollbackSelfImprovement(projectId, { behaviorVersionId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.selfImprovementStatus(projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.selfImprovementHistory(projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.settings(projectId),
      });
      closeCapabilityPrompt();
      setRollbackMessage({ type: "success", text: "Rolled back successfully" });
      setSelectedRollbackVersionId("");
      setTimeout(() => setRollbackMessage(null), 5000);
    },
    onError: (err: Error, { behaviorVersionId }) => {
      if (
        promptForCapability(err, (capability) =>
          rollbackMutation.mutate({ behaviorVersionId, capability })
        )
      )
        return;
      setRollbackMessage({ type: "error", text: err.message || "Rollback failed" });
      setTimeout(() => setRollbackMessage(null), 5000);
    },
  });

  useEffect(() => {
    setDraftSettings(settings);
  }, [settings]);

  const applySettingsUpdate = (updater: (current: ProjectSettings) => ProjectSettings) => {
    onSettingsChange?.(updater);
    setDraftSettings((current) => updater(current));
  };

  const renderMetricRow = (
    label: string,
    baseline: number,
    candidate: number,
    higherIsBetter: boolean
  ) => {
    const improved = higherIsBetter ? candidate > baseline : candidate < baseline;
    const changed = candidate !== baseline;
    return (
      <tr key={label} className="border-b border-theme-border last:border-b-0">
        <td className="py-1 text-theme-text">{label}</td>
        <td className="py-1 text-right text-theme-muted">{formatPercent(baseline)}</td>
        <td
          className={`py-1 text-right font-medium ${changed ? (improved ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400") : "text-theme-text"}`}
        >
          {formatPercent(candidate)}
        </td>
      </tr>
    );
  };

  const gitWorkingMode = draftSettings.gitWorkingMode ?? "worktree";
  const mergeStrategy = draftSettings.mergeStrategy ?? "per_task";
  const maxConcurrentCoders = draftSettings.maxConcurrentCoders ?? 1;
  const maxTotalConcurrentAgents = draftSettings.maxTotalConcurrentAgents;
  const gitRemoteModeText =
    draftSettings.gitRemoteMode === "publishable"
      ? "Remote configured"
      : draftSettings.gitRemoteMode === "remote_error"
        ? "Remote unreachable"
        : draftSettings.gitRemoteMode === "local_only"
          ? "Local-only repo"
          : draftSettings.gitRuntimeStatus?.refreshing
            ? "Checking remote configuration..."
            : "Local-only repo";
  const gitRuntimeRefreshText = draftSettings.gitRuntimeStatus?.refreshing
    ? draftSettings.gitRuntimeStatus.lastCheckedAt
      ? "Refreshing live Git status..."
      : "Checking live Git status..."
    : draftSettings.gitRuntimeStatus?.lastCheckedAt
      ? "Git status is current"
      : null;

  return (
    <div className="space-y-4" data-testid={`workflow-settings-content-${projectId}`}>
      <section
        className="space-y-4 p-4 rounded-lg bg-theme-bg-elevated border border-theme-border"
        data-testid="workflow-execution-strategy-card"
      >
        <div>
          <h3 className="text-sm font-semibold text-theme-text">Execution Strategy</h3>
          <p className="text-xs text-theme-muted">
            Configure how coders run and how task branches are created and merged.
          </p>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h4 className="text-sm font-semibold text-theme-text">Git working mode</h4>
            <p className="text-xs text-theme-muted">
              {gitWorkingMode === "worktree"
                ? "Worktree: isolated directories per task, supports parallel agents."
                : "Branches: agents work in main repo on task branches, one at a time."}
            </p>
            <p className="text-xs text-theme-muted mt-1" data-testid="git-remote-mode">
              {gitRemoteModeText}
            </p>
            {gitRuntimeRefreshText && (
              <p className="text-xs text-theme-muted mt-1" data-testid="git-runtime-refresh-status">
                {gitRuntimeRefreshText}
              </p>
            )}
          </div>
          <select
            className="input w-48 shrink-0"
            value={gitWorkingMode}
            onChange={(e) => {
              const mode = e.target.value as GitWorkingMode;
              applySettingsUpdate((s) => ({ ...s, gitWorkingMode: mode }));
              void persistSettings(undefined, { gitWorkingMode: mode });
            }}
            data-testid="git-working-mode-select"
          >
            <option value="worktree">Worktree</option>
            <option value="branches">Branches</option>
          </select>
        </div>

        <div>
          <label
            htmlFor="worktree-base-branch-input"
            className="block text-sm font-medium text-theme-text mb-1"
          >
            Base branch
          </label>
          <p className="text-xs text-theme-muted mb-2">
            Task branches are created from and merged into this branch. Use alphanumeric, slash,
            underscore, hyphen, or dot.
          </p>
          <input
            id="worktree-base-branch-input"
            type="text"
            className="input w-full max-w-xs"
            value={draftSettings.worktreeBaseBranch ?? "main"}
            onChange={(e) =>
              applySettingsUpdate((s) => ({ ...s, worktreeBaseBranch: e.target.value || "main" }))
            }
            onBlur={() => {
              const normalized = normalizeWorktreeBaseBranch(draftSettings.worktreeBaseBranch);
              applySettingsUpdate((s) => ({ ...s, worktreeBaseBranch: normalized }));
              void persistSettings(undefined, { worktreeBaseBranch: normalized });
            }}
            placeholder="main"
            data-testid="worktree-base-branch-input"
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h4 className="text-sm font-semibold text-theme-text">Merge strategy</h4>
            <p className="text-xs text-theme-muted">
              Per task (default): merge each task to main when complete. Per epic: build entire
              plan/epic on one branch; merge once all tasks are done.
            </p>
          </div>
          <select
            aria-label="Merge strategy"
            className="input w-48 shrink-0"
            value={mergeStrategy}
            onChange={(e) => {
              const strategy = e.target.value as MergeStrategy;
              applySettingsUpdate((s) => ({ ...s, mergeStrategy: strategy }));
              void persistSettings(undefined, { mergeStrategy: strategy });
            }}
            data-testid="merge-strategy-select"
          >
            <option value="per_task">Per task (default)</option>
            <option value="per_epic">Per epic</option>
          </select>
        </div>

        {gitWorkingMode === "worktree" ? (
          <div>
            <h4 className="text-sm font-semibold text-theme-text mb-1">Parallelism</h4>
            <p className="text-xs text-theme-muted mb-3">
              Run multiple coding agents simultaneously on independent tasks. Higher values speed up
              builds but use more resources.
            </p>
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="max-concurrent-coders-slider"
                  className="block text-sm font-medium text-theme-text mb-2"
                >
                  Max Concurrent Coders: <span className="font-bold">{maxConcurrentCoders}</span>
                </label>
                <input
                  id="max-concurrent-coders-slider"
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={maxConcurrentCoders}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    applySettingsUpdate((s) => ({ ...s, maxConcurrentCoders: n }));
                    void persistSettings(undefined, { maxConcurrentCoders: n });
                  }}
                  className="w-full accent-brand-600"
                  data-testid="max-concurrent-coders-slider"
                />
                <div className="flex justify-between text-xs text-theme-muted mt-1">
                  <span>1 (sequential)</span>
                  <span>10</span>
                </div>
              </div>

              <div className="pt-4 border-t border-theme-border space-y-3">
                <div className="flex items-start gap-2">
                  <input
                    id="max-total-agents-cap-enabled"
                    type="checkbox"
                    className="mt-1 rounded border-theme-border"
                    checked={maxTotalConcurrentAgents != null}
                    onChange={(e) => {
                      if (e.target.checked) {
                        const n = Math.min(
                          MAX_TOTAL_CONCURRENT_AGENTS_CAP,
                          Math.max(DEFAULT_MAX_TOTAL_CONCURRENT_AGENTS, maxConcurrentCoders)
                        );
                        applySettingsUpdate((s) => ({ ...s, maxTotalConcurrentAgents: n }));
                        void persistSettings(undefined, { maxTotalConcurrentAgents: n });
                      } else {
                        applySettingsUpdate((s) => {
                          const next = { ...s };
                          delete next.maxTotalConcurrentAgents;
                          return next;
                        });
                        void persistSettings(undefined, { maxTotalConcurrentAgents: null });
                      }
                    }}
                    data-testid="max-total-agents-cap-checkbox"
                  />
                  <div className="min-w-0 flex-1">
                    <label
                      htmlFor="max-total-agents-cap-enabled"
                      className="text-sm font-medium text-theme-text cursor-pointer"
                    >
                      Cap total concurrent agents (all phases)
                    </label>
                    <p className="text-xs text-theme-muted mt-1">
                      When enabled, limits overlapping work across task generation, plan chat,
                      coders, reviewers, and merger agents so you can stay within provider
                      concurrency limits. When off, only &quot;Max concurrent coders&quot; applies
                      to execute parallelism.
                    </p>
                  </div>
                </div>
                {maxTotalConcurrentAgents != null && (
                  <div>
                    <label
                      htmlFor="max-total-concurrent-agents-slider"
                      className="block text-sm font-medium text-theme-text mb-2"
                    >
                      Max total concurrent agents:{" "}
                      <span className="font-bold">{maxTotalConcurrentAgents}</span>
                    </label>
                    <input
                      id="max-total-concurrent-agents-slider"
                      type="range"
                      min={1}
                      max={MAX_TOTAL_CONCURRENT_AGENTS_CAP}
                      step={1}
                      value={maxTotalConcurrentAgents}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        applySettingsUpdate((s) => ({ ...s, maxTotalConcurrentAgents: n }));
                        void persistSettings(undefined, { maxTotalConcurrentAgents: n });
                      }}
                      className="w-full accent-brand-600"
                      data-testid="max-total-concurrent-agents-slider"
                    />
                    <div className="flex justify-between text-xs text-theme-muted mt-1">
                      <span>1</span>
                      <span>{MAX_TOTAL_CONCURRENT_AGENTS_CAP}</span>
                    </div>
                  </div>
                )}
              </div>

              {maxConcurrentCoders > 1 && (
                <div>
                  <label
                    htmlFor="unknown-scope-strategy-select"
                    className="block text-sm font-medium text-theme-text mb-1"
                  >
                    Unknown Scope Strategy
                  </label>
                  <p className="text-xs text-theme-muted mb-2">
                    Agents identify task scope based on expected touched files. What should agents
                    do when the scope is unclear?
                  </p>
                  <select
                    id="unknown-scope-strategy-select"
                    className="input"
                    value={draftSettings.unknownScopeStrategy ?? "optimistic"}
                    onChange={(e) => {
                      const strategy = e.target.value as UnknownScopeStrategy;
                      applySettingsUpdate((s) => ({ ...s, unknownScopeStrategy: strategy }));
                      void persistSettings(undefined, { unknownScopeStrategy: strategy });
                    }}
                    data-testid="unknown-scope-strategy-select"
                  >
                    <option value="optimistic">Optimistic (parallelize, rely on merger)</option>
                    <option value="conservative">Conservative (serialize)</option>
                  </select>
                </div>
              )}
            </div>
          </div>
        ) : null}
      </section>

      <section
        className="space-y-4 p-4 rounded-lg bg-theme-bg-elevated border border-theme-border"
        data-testid="workflow-quality-gates-card"
      >
        <div>
          <h3 className="text-sm font-semibold text-theme-text">Quality Gates</h3>
          <p className="text-xs text-theme-muted">
            Define how tests and review checks are applied to coding output.
          </p>
        </div>

        <div>
          <h4 className="text-sm font-semibold text-theme-text mb-1">Test Command</h4>
          <p className="text-xs text-theme-muted mb-3">
            Override the test command (auto-detected from package.json). Leave empty to use
            detection.
          </p>
          <input
            type="text"
            className="input w-full font-mono text-sm"
            placeholder="e.g. npm test or npx vitest run"
            value={draftSettings.testCommand ?? ""}
            onChange={(e) =>
              applySettingsUpdate((s) => ({ ...s, testCommand: e.target.value.trim() || null }))
            }
            onBlur={scheduleSaveOnBlur}
          />
        </div>

        <div>
          <div className="flex items-center justify-between gap-4 mb-3">
            <div className="min-w-0 flex-1">
              <h4 className="text-sm font-semibold text-theme-text">Code Review mode</h4>
              <p className="text-xs text-theme-muted">
                Run a review agent after coding to validate scope, tests, and code quality.
              </p>
            </div>
            <select
              data-testid="review-mode-select"
              className="input w-48 shrink-0"
              value={draftSettings.reviewMode ?? DEFAULT_REVIEW_MODE}
              onChange={(e) => {
                const mode = e.target.value as ReviewMode;
                applySettingsUpdate((s) => ({ ...s, reviewMode: mode }));
                void persistSettings(undefined, { reviewMode: mode });
              }}
            >
              <option value="never">Never</option>
              <option value="always">Always</option>
              <option value="on-failure-only">On Failure Only</option>
            </select>
          </div>
          <div role="group" aria-labelledby="review-agents-heading">
            <span
              id="review-agents-heading"
              className="block text-xs font-medium text-theme-muted mb-2"
            >
              Review angles
            </span>
            <p className="text-xs text-theme-muted mb-2">
              Leave empty for one general review. Select one or more angles for parallel
              angle-specific reviews.
            </p>
            <div className="flex flex-wrap gap-2" data-testid="review-agents-multiselect">
              {REVIEW_AGENT_OPTIONS.map((opt) => {
                const isGeneral = opt.value === GENERAL_REVIEW_OPTION;
                const angleValue: ReviewAngle | null = isGeneral
                  ? null
                  : (opt.value as ReviewAngle);
                const angles = draftSettings.reviewAngles ?? [];
                const includeGeneral = draftSettings.includeGeneralReview === true;
                const generalSelected = angles.length === 0 || includeGeneral;
                const selected = isGeneral
                  ? generalSelected
                  : angleValue !== null && angles.includes(angleValue);
                const selectedCount = (generalSelected ? 1 : 0) + angles.length;
                const wouldLeaveZero = selected && selectedCount === 1;
                const disabled = wouldLeaveZero;
                return (
                  <label
                    key={opt.value}
                    htmlFor={`review-agent-${opt.value}`}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border transition-colors text-sm ${
                      disabled
                        ? "cursor-not-allowed opacity-90"
                        : "cursor-pointer hover:border-theme-muted"
                    } ${
                      selected
                        ? "border-brand-600 bg-brand-50 dark:bg-brand-900/20"
                        : "border-theme-border"
                    }`}
                  >
                    <input
                      id={`review-agent-${opt.value}`}
                      type="checkbox"
                      checked={selected}
                      disabled={disabled}
                      onChange={() => {
                        if (disabled) return;
                        if (isGeneral) {
                          if (selected) {
                            applySettingsUpdate((s) => ({ ...s, includeGeneralReview: false }));
                            void persistSettings(undefined, { includeGeneralReview: false });
                          } else {
                            applySettingsUpdate((s) => ({ ...s, includeGeneralReview: true }));
                            void persistSettings(undefined, { includeGeneralReview: true });
                          }
                        } else {
                          const current = angles;
                          const next: ReviewAngle[] = selected
                            ? current.filter((a) => a !== angleValue)
                            : angleValue
                              ? [...current, angleValue]
                              : current;
                          lastReviewAnglesRef.current = next.length > 0 ? next : undefined;
                          if (next.length === 0 && selected && !includeGeneral) return;
                          const wasGeneralOnly = current.length === 0 && generalSelected;
                          const nextReviewAngles = next.length > 0 ? next : ([] as ReviewAngle[]);
                          applySettingsUpdate((s) => {
                            const nextSettings: ProjectSettings = {
                              ...s,
                              reviewAngles: next.length > 0 ? next : undefined,
                            };
                            if (wasGeneralOnly) nextSettings.includeGeneralReview = true;
                            return nextSettings;
                          });
                          void persistSettings(undefined, {
                            reviewAngles: nextReviewAngles,
                            ...(wasGeneralOnly && { includeGeneralReview: true }),
                          });
                        }
                      }}
                      className="rounded border-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-0 disabled:cursor-not-allowed"
                    />
                    <span className="text-theme-text">{opt.label}</span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <section
        ref={selfImprovementCardRef}
        className="space-y-4 p-4 rounded-lg bg-theme-bg-elevated border border-theme-border"
        data-testid="workflow-continuous-improvement-card"
      >
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-theme-text">Continuous Improvement</h3>
          <p className="text-xs text-theme-muted">
            When the codebase has changed, a review runs with your code review lenses and creates
            improvement tasks.
          </p>
          <div data-testid="self-improvement-section" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <label
                htmlFor="self-improvement-frequency-select"
                className="block text-xs font-medium text-theme-muted"
              >
                Self-improvement frequency
              </label>
              <select
                id="self-improvement-frequency-select"
                data-testid="self-improvement-frequency-select"
                className="input w-48"
                value={draftSettings.selfImprovementFrequency ?? "never"}
                onChange={(e) => {
                  const value = e.target.value as SelfImprovementFrequency;
                  applySettingsUpdate((s) => ({ ...s, selfImprovementFrequency: value }));
                  void persistSettings(undefined, {
                    selfImprovementFrequency: value,
                  });
                }}
              >
                {SELF_IMPROVEMENT_FREQUENCY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                data-testid="self-improvement-run-now"
                className="btn btn-secondary"
                disabled={runNowMutation.isPending}
                onClick={() => runNowMutation.mutate()}
              >
                {runNowMutation.isPending ? "Running…" : "Run now"}
              </button>
            </div>
            {runNowMessage && (
              <p
                className="text-xs text-theme-muted"
                data-testid="self-improvement-run-now-message"
                role="status"
              >
                {runNowMessage}
              </p>
            )}

            <label
              htmlFor="run-agent-enhancement-experiments-checkbox"
              className="flex items-center gap-2 cursor-pointer"
            >
              <input
                id="run-agent-enhancement-experiments-checkbox"
                type="checkbox"
                data-testid="run-agent-enhancement-experiments-checkbox"
                checked={draftSettings.runAgentEnhancementExperiments ?? false}
                onChange={(e) => {
                  const checked = e.target.checked;
                  applySettingsUpdate((s) => ({
                    ...s,
                    runAgentEnhancementExperiments: checked,
                  }));
                  void persistSettings(undefined, {
                    runAgentEnhancementExperiments: checked,
                  });
                }}
                className="rounded border-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-0"
              />
              <span className="text-sm text-theme-text">Run experiments to enhance agents</span>
            </label>

            {/* Self-Improvement Review agent selector */}
            <div data-testid="self-improvement-review-section">
              <h4 className="text-sm font-semibold text-theme-text mb-1">
                Self-Improvement Review
              </h4>
              <p className="text-xs text-theme-muted mb-3">
                Configure which review angles to use when the self-improvement audit reviews recent
                code changes. When not customized, these inherit the code review angles above.
              </p>

              {/* Review angles multi-select */}
              <div role="group" aria-labelledby="self-improvement-reviewer-agents-heading">
                <span
                  id="self-improvement-reviewer-agents-heading"
                  className="block text-xs font-medium text-theme-muted mb-2"
                >
                  Review angles
                </span>
                {(() => {
                  const hasExplicitAngles =
                    draftSettings.selfImprovementReviewerAgents !== undefined ||
                    draftSettings.selfImprovementIncludeGeneralReview !== undefined;
                  const effectiveAngles = getSelfImprovementReviewerAgents(draftSettings) ?? [];
                  const effectiveIncludeGeneral =
                    getSelfImprovementIncludeGeneralReview(draftSettings);
                  const angles = hasExplicitAngles
                    ? (draftSettings.selfImprovementReviewerAgents ?? [])
                    : effectiveAngles;
                  const includeGeneral = hasExplicitAngles
                    ? (draftSettings.selfImprovementIncludeGeneralReview ?? false)
                    : effectiveIncludeGeneral;

                  return (
                    <>
                      {!hasExplicitAngles && (
                        <p className="text-xs text-theme-muted mb-2">
                          Using code review angles.{" "}
                          <button
                            type="button"
                            className="text-brand-600 hover:underline"
                            data-testid="si-review-customize-btn"
                            onClick={() => {
                              const fromCodeReview =
                                lastReviewAnglesRef.current ?? draftSettings.reviewAngles ?? [];
                              const includeGeneral = draftSettings.includeGeneralReview ?? false;
                              applySettingsUpdate((s) => ({
                                ...s,
                                selfImprovementReviewerAgents: fromCodeReview,
                                selfImprovementIncludeGeneralReview: includeGeneral,
                              }));
                              void persistSettings(undefined, {
                                selfImprovementReviewerAgents: fromCodeReview,
                                selfImprovementIncludeGeneralReview: includeGeneral,
                              });
                            }}
                          >
                            Customize
                          </button>
                        </p>
                      )}
                      {hasExplicitAngles && (
                        <p className="text-xs text-theme-muted mb-2">
                          Custom angles set.{" "}
                          <button
                            type="button"
                            className="text-brand-600 hover:underline"
                            data-testid="si-review-reset-btn"
                            onClick={() => {
                              applySettingsUpdate((s) => {
                                const next = { ...s };
                                delete next.selfImprovementReviewerAgents;
                                delete next.selfImprovementIncludeGeneralReview;
                                return next;
                              });
                              void persistSettings(undefined, {
                                selfImprovementReviewerAgents: undefined,
                                selfImprovementIncludeGeneralReview: undefined,
                              });
                            }}
                          >
                            Reset to code review defaults
                          </button>
                        </p>
                      )}
                      <div
                        className="flex flex-wrap gap-2"
                        data-testid="self-improvement-reviewer-agents-multiselect"
                      >
                        {REVIEW_AGENT_OPTIONS.map((opt) => {
                          const isGeneral = opt.value === GENERAL_REVIEW_OPTION;
                          const angleValue: ReviewAngle | null = isGeneral
                            ? null
                            : (opt.value as ReviewAngle);
                          const generalSelected = angles.length === 0 || includeGeneral;
                          const selected = isGeneral
                            ? generalSelected
                            : angleValue !== null && angles.includes(angleValue);
                          const selectedCount = (generalSelected ? 1 : 0) + angles.length;
                          const wouldLeaveZero = selected && selectedCount === 1;
                          const disabled = wouldLeaveZero || !hasExplicitAngles;
                          return (
                            <label
                              key={opt.value}
                              htmlFor={`si-review-agent-${opt.value}`}
                              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border transition-colors text-sm ${
                                disabled
                                  ? "cursor-not-allowed opacity-90"
                                  : "cursor-pointer hover:border-theme-muted"
                              } ${
                                selected
                                  ? "border-brand-600 bg-brand-50 dark:bg-brand-900/20"
                                  : "border-theme-border"
                              }`}
                            >
                              <input
                                id={`si-review-agent-${opt.value}`}
                                type="checkbox"
                                checked={selected}
                                disabled={disabled}
                                onChange={() => {
                                  if (disabled) return;
                                  if (isGeneral) {
                                    if (selected) {
                                      applySettingsUpdate((s) => ({
                                        ...s,
                                        selfImprovementIncludeGeneralReview: false,
                                      }));
                                      void persistSettings(undefined, {
                                        selfImprovementIncludeGeneralReview: false,
                                      });
                                    } else {
                                      applySettingsUpdate((s) => ({
                                        ...s,
                                        selfImprovementIncludeGeneralReview: true,
                                      }));
                                      void persistSettings(undefined, {
                                        selfImprovementIncludeGeneralReview: true,
                                      });
                                    }
                                  } else {
                                    const current = angles;
                                    const next: ReviewAngle[] = selected
                                      ? current.filter((a) => a !== angleValue)
                                      : angleValue
                                        ? [...current, angleValue]
                                        : current;
                                    if (next.length === 0 && selected && !includeGeneral) return;
                                    const wasGeneralOnly = current.length === 0 && generalSelected;
                                    applySettingsUpdate((s) => {
                                      const nextSettings: ProjectSettings = {
                                        ...s,
                                        selfImprovementReviewerAgents:
                                          next.length > 0 ? next : undefined,
                                      };
                                      if (wasGeneralOnly)
                                        nextSettings.selfImprovementIncludeGeneralReview = true;
                                      return nextSettings;
                                    });
                                    void persistSettings(undefined, {
                                      selfImprovementReviewerAgents: next.length > 0 ? next : [],
                                      ...(wasGeneralOnly && {
                                        selfImprovementIncludeGeneralReview: true,
                                      }),
                                    });
                                  }
                                }}
                                className="rounded border-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-0 disabled:cursor-not-allowed"
                              />
                              <span className="text-theme-text">{opt.label}</span>
                            </label>
                          );
                        })}
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>

            <div
              className="flex items-center gap-2 text-xs text-theme-muted"
              data-testid="self-improvement-status-row"
              role="status"
            >
              {(siStatus.status === "running_audit" ||
                siStatus.status === "running_experiments") && (
                <svg
                  className="animate-spin h-3.5 w-3.5 text-brand-600"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  data-testid="self-improvement-status-spinner"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                  />
                </svg>
              )}
              <span data-testid="self-improvement-status-label">{statusLabel(siStatus)}</span>
              {siStatus.stage && (
                <span className="ml-1 italic" data-testid="self-improvement-stage-label">
                  — {STAGE_LABELS[siStatus.stage]}
                </span>
              )}
            </div>

            {siStatus.status === "awaiting_approval" && siStatus.pendingCandidateId && (
              <div
                className="mt-2 p-3 rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20 space-y-3"
                data-testid="self-improvement-approval-card"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-amber-800 dark:text-amber-200">
                    Candidate awaiting approval
                  </span>
                  <span className="text-xs text-amber-600 dark:text-amber-400 font-mono">
                    {siStatus.pendingCandidateId}
                  </span>
                </div>

                {siStatus.candidateDiff && siStatus.candidateDiff.length > 0 && (
                  <div data-testid="approval-candidate-diff">
                    <h5 className="text-xs font-semibold text-theme-text mb-1">Proposed changes</h5>
                    <div className="space-y-2">
                      {siStatus.candidateDiff.map((entry: CandidateDiffEntry) => (
                        <div
                          key={entry.section}
                          className="text-xs border border-theme-border rounded p-2 bg-theme-bg"
                          data-testid="approval-diff-entry"
                        >
                          <span className="font-medium text-theme-text">{entry.section}</span>
                          <div className="mt-1 grid grid-cols-2 gap-2">
                            <div>
                              <span className="text-[10px] uppercase text-theme-muted">Before</span>
                              <pre className="mt-0.5 whitespace-pre-wrap text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded p-1 max-h-24 overflow-y-auto">
                                {entry.before || "(empty)"}
                              </pre>
                            </div>
                            <div>
                              <span className="text-[10px] uppercase text-theme-muted">After</span>
                              <pre className="mt-0.5 whitespace-pre-wrap text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 rounded p-1 max-h-24 overflow-y-auto">
                                {entry.after || "(empty)"}
                              </pre>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {siStatus.replaySampleSize != null && (
                  <p className="text-xs text-theme-muted" data-testid="approval-replay-sample-size">
                    Replay sample size:{" "}
                    <span className="font-medium text-theme-text">{siStatus.replaySampleSize}</span>
                  </p>
                )}

                {siStatus.baselineMetrics && siStatus.candidateMetrics && (
                  <div data-testid="approval-metrics">
                    <h5 className="text-xs font-semibold text-theme-text mb-1">
                      Baseline vs Candidate
                    </h5>
                    <table className="w-full text-xs border-collapse">
                      <thead>
                        <tr className="border-b border-theme-border">
                          <th className="text-left py-1 text-theme-muted font-medium">Metric</th>
                          <th className="text-right py-1 text-theme-muted font-medium">Baseline</th>
                          <th className="text-right py-1 text-theme-muted font-medium">
                            Candidate
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {renderMetricRow(
                          "Task success rate",
                          siStatus.baselineMetrics.taskSuccessRate,
                          siStatus.candidateMetrics.taskSuccessRate,
                          true
                        )}
                        {siStatus.baselineMetrics.retryRate != null &&
                          siStatus.candidateMetrics.retryRate != null &&
                          renderMetricRow(
                            "Retry rate",
                            siStatus.baselineMetrics.retryRate,
                            siStatus.candidateMetrics.retryRate,
                            false
                          )}
                        {siStatus.baselineMetrics.reviewPassRate != null &&
                          siStatus.candidateMetrics.reviewPassRate != null &&
                          renderMetricRow(
                            "Review pass rate",
                            siStatus.baselineMetrics.reviewPassRate,
                            siStatus.candidateMetrics.reviewPassRate,
                            true
                          )}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    className="btn btn-primary text-xs px-3 py-1"
                    data-testid="approval-promote-btn"
                    disabled={approveMutation.isPending || rejectMutation.isPending}
                    onClick={() => approveMutation.mutate(undefined)}
                  >
                    {approveMutation.isPending ? "Promoting…" : "Promote"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary text-xs px-3 py-1"
                    data-testid="approval-reject-btn"
                    disabled={approveMutation.isPending || rejectMutation.isPending}
                    onClick={() => rejectMutation.mutate(undefined)}
                  >
                    {rejectMutation.isPending ? "Rejecting…" : "Reject"}
                  </button>
                  {approvalMessage && (
                    <span
                      className={`text-xs ${approvalMessage.type === "success" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
                      data-testid="approval-feedback-message"
                      role="status"
                    >
                      {approvalMessage.text}
                    </span>
                  )}
                </div>
              </div>
            )}

            {(showLastRunInSchedule || showNextRunInSchedule) && (
              <p
                className="text-xs text-theme-muted flex flex-nowrap items-center gap-x-3"
                data-testid="self-improvement-run-schedule"
              >
                {showLastRunInSchedule && draftSettings.selfImprovementLastRunAt && (
                  <span data-testid="self-improvement-last-run">
                    Last run:{" "}
                    {new Date(draftSettings.selfImprovementLastRunAt).toLocaleString(undefined, {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                  </span>
                )}
                {showNextRunInSchedule && draftSettings.nextRunAt && (
                  <span data-testid="self-improvement-next-run">
                    Next run:{" "}
                    {new Date(draftSettings.nextRunAt).toLocaleString(undefined, {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                  </span>
                )}
              </p>
            )}

            {(draftSettings.selfImprovementActiveBehaviorVersionId ||
              draftSettings.selfImprovementPendingCandidateId) && (
              <div
                className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs border-t border-theme-border pt-2"
                data-testid="self-improvement-summary-row"
              >
                {draftSettings.selfImprovementActiveBehaviorVersionId && (
                  <>
                    <span className="text-theme-muted">Active agent behavior version</span>
                    <span
                      className="text-theme-text font-mono truncate"
                      data-testid="summary-active-version"
                    >
                      {draftSettings.selfImprovementActiveBehaviorVersionId}
                    </span>
                  </>
                )}

                {draftSettings.selfImprovementPendingCandidateId && (
                  <>
                    <span className="text-theme-muted">Pending promotion</span>
                    <span
                      className="text-theme-text font-mono truncate"
                      data-testid="summary-pending-promotion"
                    >
                      {draftSettings.selfImprovementPendingCandidateId}
                    </span>
                  </>
                )}
              </div>
            )}

            {(() => {
              const versions = draftSettings.selfImprovementBehaviorVersions ?? [];
              const activeId = draftSettings.selfImprovementActiveBehaviorVersionId;
              const rollbackTargets = versions.filter((v) => v.id !== activeId);
              if (rollbackTargets.length === 0) return null;
              return (
                <div
                  className="mt-2 p-3 rounded-lg border border-theme-border bg-theme-bg space-y-2"
                  data-testid="self-improvement-rollback-section"
                >
                  <h5 className="text-xs font-semibold text-theme-text">
                    Rollback to previous version
                  </h5>
                  <div className="flex items-center gap-2">
                    <select
                      className="input text-xs flex-1"
                      data-testid="rollback-version-select"
                      value={selectedRollbackVersionId}
                      onChange={(e) => setSelectedRollbackVersionId(e.target.value)}
                    >
                      <option value="">Select a version…</option>
                      {rollbackTargets.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.id} (promoted {formatTimestamp(v.promotedAt)})
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-secondary text-xs px-3 py-1"
                      data-testid="rollback-btn"
                      disabled={!selectedRollbackVersionId || rollbackMutation.isPending}
                      onClick={() => {
                        if (selectedRollbackVersionId) {
                          rollbackMutation.mutate({ behaviorVersionId: selectedRollbackVersionId });
                        }
                      }}
                    >
                      {rollbackMutation.isPending ? "Rolling back…" : "Rollback"}
                    </button>
                  </div>
                  {rollbackMessage && (
                    <p
                      className={`text-xs ${rollbackMessage.type === "success" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
                      data-testid="rollback-feedback-message"
                      role="status"
                    >
                      {rollbackMessage.text}
                    </p>
                  )}
                </div>
              );
            })()}

            {capabilityPrompt && (
              <form
                className="mt-3 space-y-3 rounded-lg border border-theme-border bg-theme-surface p-4"
                data-testid="self-improvement-capability-prompt"
                onSubmit={(event) => {
                  event.preventDefault();
                  capabilityPrompt.retry(capabilityInput);
                }}
              >
                <p className="text-sm text-theme-text">
                  This action changes governed agent behavior and needs the designated owner’s
                  approval. Nothing has changed yet.
                </p>
                {capabilityPrompt.error && (
                  <p role="alert" className="text-sm text-theme-error-text">
                    {capabilityPrompt.error}
                  </p>
                )}
                <label className="block text-sm text-theme-text">
                  Owner approval capability
                  <input
                    ref={capabilityInputRef}
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    value={capabilityInput}
                    onChange={(event) => setCapabilityInput(event.target.value)}
                    className="input mt-1.5"
                    required
                  />
                </label>
                <div className="flex flex-wrap gap-3">
                  <button
                    type="submit"
                    className="btn-secondary disabled:opacity-50"
                    disabled={
                      !capabilityInput ||
                      approveMutation.isPending ||
                      rejectMutation.isPending ||
                      rollbackMutation.isPending
                    }
                  >
                    Authorize and retry
                  </button>
                  <button
                    type="button"
                    className="text-sm text-theme-muted underline"
                    onClick={closeCapabilityPrompt}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}

            {historyRuns.length > 0 && (
              <div className="mt-3" data-testid="self-improvement-recent-runs">
                <h4 className="text-xs font-semibold text-theme-text mb-2">Recent runs</h4>
                <ul className="space-y-1.5 max-h-64 overflow-y-auto">
                  {historyRuns.map((run, i) => (
                    <li
                      key={run.runId ?? i}
                      className="flex items-start gap-2 text-xs"
                      data-testid="self-improvement-history-row"
                    >
                      <span className="text-theme-muted shrink-0 w-28 pt-0.5">
                        {formatTimestamp(run.timestamp)}
                      </span>
                      <span
                        className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 mt-0.5 ${OUTCOME_COLORS[run.outcome]}`}
                        data-testid="history-outcome-badge"
                      >
                        {OUTCOME_LABELS[run.outcome]}
                      </span>
                      {run.summary && (
                        <span
                          className="text-theme-muted min-w-0 flex-1 break-words whitespace-pre-wrap max-h-32 overflow-y-auto [overflow-wrap:anywhere]"
                          title={run.summary}
                          data-testid="history-summary"
                        >
                          {run.summary}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
