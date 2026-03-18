import { useEffect, useState, type MutableRefObject } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
  DEFAULT_REVIEW_MODE,
  GENERAL_REVIEW_OPTION,
  REVIEW_AGENT_OPTIONS,
  SELF_IMPROVEMENT_FREQUENCY_OPTIONS,
  normalizeWorktreeBaseBranch,
} from "@opensprint/shared";
import { api } from "../../api/client";
import { queryKeys } from "../../api/queryKeys";

type WorkflowPersistOverrides = Partial<{
  testCommand: string | null;
  reviewMode: ReviewMode;
  reviewAngles: ReviewAngle[];
  includeGeneralReview?: boolean;
  selfImprovementFrequency?: SelfImprovementFrequency;
  gitWorkingMode: GitWorkingMode;
  mergeStrategy: MergeStrategy;
  worktreeBaseBranch: string;
  maxConcurrentCoders: number;
  unknownScopeStrategy: UnknownScopeStrategy;
}>;

interface WorkflowSettingsContentProps {
  settings: ProjectSettings;
  projectId: string;
  persistSettings: (
    notifyOnComplete?: boolean,
    overrides?: WorkflowPersistOverrides
  ) => Promise<void> | void;
  scheduleSaveOnBlur: () => void;
  lastReviewAnglesRef: MutableRefObject<ProjectSettings["reviewAngles"] | undefined>;
  onSettingsChange?: (updater: (current: ProjectSettings) => ProjectSettings) => void;
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

  const runNowMutation = useMutation({
    mutationFn: () => api.projects.runSelfImprovement(projectId),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.settings(projectId) });
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

  useEffect(() => {
    setDraftSettings(settings);
  }, [settings]);

  const applySettingsUpdate = (updater: (current: ProjectSettings) => ProjectSettings) => {
    onSettingsChange?.(updater);
    setDraftSettings((current) => updater(current));
  };

  const gitWorkingMode = draftSettings.gitWorkingMode ?? "worktree";
  const mergeStrategy = draftSettings.mergeStrategy ?? "per_task";
  const maxConcurrentCoders = draftSettings.maxConcurrentCoders ?? 1;
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
                  onChange={(e) =>
                    applySettingsUpdate((s) => ({
                      ...s,
                      maxConcurrentCoders: Number(e.target.value),
                    }))
                  }
                  onBlur={scheduleSaveOnBlur}
                  className="w-full accent-brand-600"
                  data-testid="max-concurrent-coders-slider"
                />
                <div className="flex justify-between text-xs text-theme-muted mt-1">
                  <span>1 (sequential)</span>
                  <span>10</span>
                </div>
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
            {(draftSettings.selfImprovementLastRunAt || draftSettings.nextRunAt) && (
              <p
                className="text-xs text-theme-muted flex flex-nowrap items-center gap-x-3"
                data-testid="self-improvement-run-schedule"
              >
                {draftSettings.selfImprovementLastRunAt && (
                  <span data-testid="self-improvement-last-run">
                    Last run:{" "}
                    {new Date(draftSettings.selfImprovementLastRunAt).toLocaleString(undefined, {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                  </span>
                )}
                {draftSettings.nextRunAt && (
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
          </div>
        </div>
      </section>
    </div>
  );
}
