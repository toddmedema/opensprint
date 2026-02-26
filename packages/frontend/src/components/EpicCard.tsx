import type { Plan, Task } from "@opensprint/shared";
import { shallowEqual } from "react-redux";
import { useAppSelector } from "../store";
import { selectTasksForEpic } from "../store/slices/executeSlice";
import { formatPlanIdAsTitle } from "../lib/formatting";
import { COLUMN_LABELS } from "./kanban/TaskStatusBadge";
import { ComplexityIcon } from "./ComplexityIcon";

export interface EpicCardProps {
  plan: Plan;
  /** When provided (e.g. in tests), use this instead of Redux. Otherwise subscribe to tasks via selectTasksForEpic. */
  tasks?: Task[];
  /** When true, show full-card loading spinner overlay (optimistic plan awaiting API) */
  isOptimistic?: boolean;
  executingPlanId: string | null;
  reExecutingPlanId: string | null;
  planTasksPlanIds: string[];
  executeError?: { planId: string; message: string } | null;
  onSelect: () => void;
  onShip: () => void;
  onPlanTasks: () => void;
  onReship: () => void;
  onClearError?: () => void;
}

const statusConfig: Record<string, { badge: string; accent: string; icon: React.ReactNode }> = {
  planning: {
    badge: "bg-theme-warning-bg text-theme-warning-text ring-1 ring-theme-warning-border/60",
    accent: "bg-theme-warning-solid",
    icon: (
      <svg
        className="w-3.5 h-3.5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
        />
      </svg>
    ),
  },
  building: {
    badge: "bg-theme-info-bg text-theme-info-text ring-1 ring-theme-info-border/60",
    accent: "bg-theme-info-solid",
    icon: (
      <svg
        className="w-3.5 h-3.5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"
        />
      </svg>
    ),
  },
  complete: {
    badge: "bg-theme-success-bg text-theme-success-text ring-1 ring-theme-success-border/60",
    accent: "bg-theme-success-solid",
    icon: (
      <svg
        className="w-3.5 h-3.5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    ),
  },
};

const defaultStatus = {
  badge: "bg-theme-surface-muted text-theme-text ring-1 ring-theme-border/60",
  accent: "bg-theme-ring",
  icon: null,
};

export function EpicCard({
  plan,
  tasks: tasksProp,
  isOptimistic = false,
  executingPlanId,
  reExecutingPlanId,
  planTasksPlanIds,
  executeError,
  onSelect,
  onShip,
  onPlanTasks,
  onReship,
  onClearError,
}: EpicCardProps) {
  const tasksFromRedux = useAppSelector(
    (s) => selectTasksForEpic(s, plan.metadata.epicId),
    shallowEqual
  );
  const tasks = tasksProp ?? tasksFromRedux;

  const progress = plan.taskCount > 0 ? (plan.doneTaskCount / plan.taskCount) * 100 : 0;
  const config = statusConfig[plan.status] ?? defaultStatus;

  return (
    <div
      className="group relative overflow-hidden rounded-xl bg-theme-surface shadow-sm ring-1 ring-theme-border cursor-pointer
        hover:shadow-lg hover:ring-theme-info-border/50 transition-all duration-200 ease-out hover:-translate-y-0.5
        focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      {/* Full-card loading overlay for optimistic plans */}
      {isOptimistic && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center bg-theme-surface/80 backdrop-blur-[1px]"
          aria-busy="true"
          aria-label="Generating plan"
        >
          <svg
            className="h-8 w-8 animate-spin text-brand-600"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden
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
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        </div>
      )}
      {/* Status accent bar */}
      <div className={`absolute left-0 top-0 bottom-0 w-1 ${config.accent}`} aria-hidden />

      <div className="pl-4 pr-4 pt-4 pb-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <h3 className="font-semibold text-theme-text text-base truncate flex-1 min-w-0 leading-tight">
            {formatPlanIdAsTitle(plan.metadata.planId)}
          </h3>
          <span
            className={`shrink-0 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium capitalize ${config.badge}`}
          >
            {config.icon}
            {plan.status}
          </span>
        </div>

        {/* Progress section — hidden when no tasks exist */}
        {plan.taskCount > 0 && (
          <div className="mb-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-theme-muted">Progress</span>
              <span className="text-xs font-semibold text-theme-text">
                {plan.doneTaskCount}/{plan.taskCount}
                <span className="ml-1 text-theme-muted font-normal">({Math.round(progress)}%)</span>
              </span>
            </div>
            <div className="w-full bg-theme-surface-muted rounded-full h-2 overflow-hidden">
              <div
                className="h-2 rounded-full transition-all duration-500 ease-out bg-gradient-to-r from-brand-500 to-brand-600"
                style={{ width: `${progress}%` }}
                role="progressbar"
                aria-valuenow={plan.doneTaskCount}
                aria-valuemin={0}
                aria-valuemax={plan.taskCount}
                aria-label={`${plan.doneTaskCount} of ${plan.taskCount} tasks done`}
              />
            </div>
            {plan.doneTaskCount > 0 &&
              plan.doneTaskCount < plan.taskCount &&
              plan.metadata.complexity && (
                <p className="text-xs text-theme-muted mt-1 inline-flex items-center gap-1.5">
                  <ComplexityIcon complexity={plan.metadata.complexity} size="xs" />
                  {plan.metadata.complexity} complexity
                </p>
              )}
          </div>
        )}

        {/* Nested subtasks */}
        {tasks.length > 0 && (
          <div className="mb-3 rounded-lg bg-theme-surface-muted/80 ring-1 ring-theme-border overflow-hidden">
            <ul className="space-y-0.5 p-2 max-h-24 overflow-y-auto">
              {tasks.map((task) => (
                <li
                  key={task.id}
                  className="flex items-center gap-2 py-1 px-2 rounded-md hover:bg-theme-border-subtle transition-colors text-xs text-theme-text"
                  title={`${task.title} — ${COLUMN_LABELS[task.kanbanColumn]}`}
                >
                  <span
                    className={`shrink-0 w-2 h-2 rounded-full ${
                      task.kanbanColumn === "done"
                        ? "bg-theme-status-done"
                        : task.kanbanColumn === "in_progress" || task.kanbanColumn === "in_review"
                          ? "bg-theme-status-in-progress"
                          : "bg-theme-ring"
                    }`}
                  />
                  <span className="truncate flex-1 min-w-0">{task.title}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Action buttons */}
        {plan.status === "planning" && (
          <>
            {plan.taskCount === 0 ? (
              <div className="space-y-2">
                <p className="text-xs text-theme-muted">
                  No tasks yet. Generate tasks from this plan, or use the AI chat to refine it
                  first.
                </p>
                {planTasksPlanIds.includes(plan.metadata.planId) ? (
                  <div
                    className="flex items-center justify-center py-2 text-theme-muted"
                    aria-busy="true"
                    aria-label="Planning tasks"
                    data-testid="plan-tasks-loading"
                  >
                    <svg
                      className="animate-spin h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
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
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      />
                    </svg>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onPlanTasks();
                    }}
                    className="btn-primary text-xs w-full py-2 rounded-lg font-medium inline-flex items-center justify-center"
                    data-testid="plan-tasks-button"
                  >
                    Plan Tasks
                  </button>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onShip();
                }}
                disabled={!!executingPlanId}
                className="btn-primary text-xs w-full py-2 disabled:opacity-60 disabled:cursor-not-allowed rounded-lg font-medium inline-flex items-center justify-center"
                data-testid="execute-button"
              >
                {executingPlanId === plan.metadata.planId ? (
                  <>
                    <svg
                      className="animate-spin -ml-0.5 mr-1.5 h-3.5 w-3.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      data-testid="execute-spinner"
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
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      />
                    </svg>
                    Executing…
                  </>
                ) : (
                  "Execute"
                )}
              </button>
            )}
            {executeError?.planId === plan.metadata.planId && (
              <div
                className="mt-2 text-xs text-theme-error-text bg-theme-error-bg border border-theme-error-border rounded-lg p-2 flex items-start gap-2"
                data-testid="execute-error-inline"
                role="alert"
              >
                <span className="flex-1 min-w-0">
                  {executeError.message.includes("no epic")
                    ? "Generate tasks first. Click \u201CPlan Tasks\u201D to create tasks from this plan, or use the AI chat to refine it."
                    : executeError.message.includes("active agent") &&
                        executeError.message.includes("worktree")
                      ? "Another task's agent is still using that branch. Wait for it to finish or restart the backend."
                      : executeError.message.includes("already used by worktree")
                        ? "A task branch was left in use by another worktree (e.g. after a crash). Retry the task; the app will clean up. If it persists, restart the backend."
                        : executeError.message}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClearError?.();
                  }}
                  className="shrink-0 text-theme-error-text hover:opacity-80"
                  aria-label="Dismiss execute error"
                >
                  <svg
                    className="h-3.5 w-3.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                    aria-hidden="true"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            )}
          </>
        )}
        {plan.status === "complete" &&
          plan.metadata.shippedAt &&
          plan.lastModified &&
          plan.lastModified > plan.metadata.shippedAt && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onReship();
              }}
              disabled={!!reExecutingPlanId}
              className="btn-secondary text-xs w-full py-2 disabled:opacity-60 disabled:cursor-not-allowed rounded-lg font-medium"
            >
              {reExecutingPlanId === plan.metadata.planId ? "Re-executing…" : "Re-execute"}
            </button>
          )}
      </div>
    </div>
  );
}
