import { useMemo } from "react";
import type { Plan, PlanStatus } from "@opensprint/shared";
import { sortPlansByStatus } from "@opensprint/shared";
import { formatPlanIdAsTitle } from "../../lib/formatting";

const PLAN_STATUS_ORDER: PlanStatus[] = ["planning", "building", "in_review", "complete"];

const SECTION_LABELS: Record<PlanStatus, string> = {
  planning: "Planning",
  building: "Building",
  in_review: "In review",
  complete: "Complete",
};

export interface PlanListViewProps {
  plans: Plan[];
  selectedPlanId: string | null;
  executingPlanId: string | null;
  reExecutingPlanId: string | null;
  planTasksPlanIds: string[];
  executeError: { planId: string; message: string } | null;
  onSelectPlan: (plan: Plan) => void;
  onShip: (planId: string, lastExecutedVersionNumber?: number) => void;
  onPlanTasks: (planId: string) => void;
  onReship: (planId: string) => void;
  onClearError: () => void;
  onMarkComplete?: (planId: string) => void;
  /** When set, the plan with this ID shows loading state for Mark complete. */
  markCompletePendingPlanId?: string | null;
  onGoToEvaluate?: () => void;
  autoExecutePlans?: boolean;
}

function PlanListRow({
  plan,
  isSelected,
  executingPlanId,
  reExecutingPlanId,
  planTasksPlanIds,
  executeError,
  onSelect,
  onShip,
  onPlanTasks,
  onReship,
  onClearError,
  onMarkComplete,
  markCompletePendingPlanId,
  onGoToEvaluate,
  autoExecutePlans,
}: {
  plan: Plan;
  isSelected: boolean;
  executingPlanId: string | null;
  reExecutingPlanId: string | null;
  planTasksPlanIds: string[];
  executeError: { planId: string; message: string } | null;
  onSelect: () => void;
  onShip: (planId: string, lastExecutedVersionNumber?: number) => void;
  onPlanTasks: (planId: string) => void;
  onReship: (planId: string) => void;
  onClearError: () => void;
  onMarkComplete?: (planId: string) => void;
  markCompletePendingPlanId?: string | null;
  onGoToEvaluate?: () => void;
  autoExecutePlans?: boolean;
}) {
  const isMarkCompletePending = markCompletePendingPlanId === plan.metadata.planId;
  const planId = plan.metadata.planId;
  const isExecuting = executingPlanId === planId;
  const isPlanningTasks = plan.status === "planning" && plan.taskCount === 0 && planTasksPlanIds.includes(planId);
  const showGenerateTasks =
    plan.status === "planning" && plan.taskCount === 0 && !autoExecutePlans && !planTasksPlanIds.includes(planId);
  const showExecute =
    plan.status === "planning" &&
    (plan.taskCount > 0 || (autoExecutePlans && (planTasksPlanIds.includes(planId) || plan.taskCount === 0)));
  const showMarkComplete = plan.status === "in_review" && onMarkComplete;
  const showReship =
    plan.status === "complete" &&
    plan.metadata.shippedAt &&
    plan.lastModified &&
    plan.lastModified > plan.metadata.shippedAt;
  const errorForThisPlan = executeError?.planId === planId;

  return (
    <li data-testid={`plan-list-row-${planId}`}>
      {isPlanningTasks && (
        <span data-testid="plan-tasks-loading" className="sr-only" aria-hidden>
          Generating tasks
        </span>
      )}
      <div className="flex items-center gap-2 px-4 py-2.5 group overflow-x-auto md:overflow-x-visible min-w-0">
        <button
          type="button"
          onClick={() => onSelect()}
          className={`flex-1 flex items-center gap-3 text-left hover:bg-theme-info-bg/50 transition-colors text-sm min-w-0 rounded px-1 -mx-1 py-1 -my-0.5 ${
            isSelected ? "bg-theme-info-bg/50" : ""
          }`}
        >
          <span className="flex-1 min-w-0 truncate font-medium text-theme-text" title={formatPlanIdAsTitle(planId)}>
            {formatPlanIdAsTitle(planId)}
          </span>
          <span className="shrink-0 text-xs text-theme-muted">
            {plan.taskCount > 0 ? `${plan.doneTaskCount}/${plan.taskCount} tasks` : "No tasks"}
          </span>
        </button>
        <span
          className="shrink-0 flex items-center gap-1.5"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          role="presentation"
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelect();
            }}
            className="shrink-0 text-xs font-medium text-theme-muted hover:bg-theme-border-subtle px-2 py-1 rounded transition-colors"
            data-testid="plan-list-edit"
          >
            Edit
          </button>
          {showGenerateTasks && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onPlanTasks(planId);
              }}
              className="shrink-0 text-xs font-medium text-brand-600 hover:bg-theme-info-bg px-2 py-1 rounded transition-colors"
              data-testid="plan-list-generate-tasks"
            >
              Generate tasks
            </button>
          )}
          {showExecute && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onShip(planId, plan.lastExecutedVersionNumber);
              }}
              disabled={!!executingPlanId || (autoExecutePlans && plan.taskCount === 0 && isPlanningTasks)}
              className="shrink-0 text-xs font-medium text-brand-600 hover:bg-theme-info-bg px-2 py-1 rounded transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              data-testid="plan-list-execute"
            >
              {(isExecuting || (autoExecutePlans && plan.taskCount === 0 && isPlanningTasks)) && (
                <span data-testid="execute-spinner" aria-hidden className="inline-block w-3 h-3 animate-spin border-2 border-current border-t-transparent rounded-full" />
              )}
              {isExecuting || (autoExecutePlans && plan.taskCount === 0 && isPlanningTasks)
                ? (plan.taskCount === 0 && isPlanningTasks ? "Generating tasks…" : "Executing…")
                : plan.lastExecutedVersionNumber != null
                  ? `Execute v${plan.lastExecutedVersionNumber}`
                  : "Execute"}
            </button>
          )}
          {showMarkComplete && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onMarkComplete!(planId);
              }}
              disabled={!!isMarkCompletePending}
              className="shrink-0 text-xs font-medium text-brand-600 hover:bg-theme-info-bg px-2 py-1 rounded transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              data-testid="plan-list-mark-complete"
            >
              {isMarkCompletePending ? "…" : "Approve"}
            </button>
          )}
          {onGoToEvaluate && plan.status === "in_review" && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onGoToEvaluate();
              }}
              className="shrink-0 text-xs font-medium text-theme-muted hover:bg-theme-border-subtle px-2 py-1 rounded transition-colors"
              data-testid="plan-list-go-to-evaluate"
            >
              Review
            </button>
          )}
          {showReship && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onReship(planId);
              }}
              disabled={!!reExecutingPlanId}
              className="shrink-0 text-xs font-medium text-theme-muted hover:bg-theme-border-subtle px-2 py-1 rounded transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              data-testid="plan-list-reship"
            >
              {reExecutingPlanId === planId ? "…" : "Re-execute"}
            </button>
          )}
          {errorForThisPlan && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClearError();
              }}
              className="shrink-0 text-xs text-theme-error-text hover:bg-theme-error-bg px-2 py-1 rounded"
              aria-label="Dismiss error"
              data-testid="plan-list-dismiss-error"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </span>
      </div>
      {errorForThisPlan && executeError && (
        <div
          className="px-4 py-2 text-xs text-theme-error-text bg-theme-error-bg border-b border-theme-border-subtle"
          role="alert"
          data-testid="plan-list-execute-error"
        >
          {executeError.message}
        </div>
      )}
    </li>
  );
}

/** Groups plans by status and renders a line-item list with section headers and row actions on the right (Execute queue pattern). */
export function PlanListView({
  plans,
  selectedPlanId,
  executingPlanId,
  reExecutingPlanId,
  planTasksPlanIds,
  executeError,
  onSelectPlan,
  onShip,
  onPlanTasks,
  onReship,
  onClearError,
  onMarkComplete,
  markCompletePendingPlanId = null,
  onGoToEvaluate,
  autoExecutePlans = false,
}: PlanListViewProps) {
  const grouped = useMemo(() => {
    const byStatus: Record<PlanStatus, Plan[]> = {
      planning: [],
      building: [],
      in_review: [],
      complete: [],
    };
    for (const p of plans) {
      if (p.status in byStatus) byStatus[p.status as PlanStatus].push(p);
    }
    for (const status of PLAN_STATUS_ORDER) {
      byStatus[status] = sortPlansByStatus(byStatus[status]);
    }
    return byStatus;
  }, [plans]);

  return (
    <div data-testid="plan-list-view">
      {PLAN_STATUS_ORDER.map((status) => {
        const sectionPlans = grouped[status];
        if (sectionPlans.length === 0) return null;
        return (
          <section key={status} data-testid={`plan-list-section-${status}`}>
            <div className="sticky top-[-0.5rem] sm:top-[-0.75rem] z-10 -mx-4 sm:-mx-6 px-4 sm:px-6 pt-6 pb-[2px] mb-[7px] border-b border-theme-border-subtle bg-theme-bg/95 backdrop-blur-sm">
              <h3 className="text-xs font-semibold text-theme-muted tracking-wide uppercase">
                {SECTION_LABELS[status]}
              </h3>
            </div>
            <ul className="divide-y divide-theme-border-subtle">
              {sectionPlans.map((plan) => (
                <PlanListRow
                  key={plan.metadata.planId}
                  plan={plan}
                  isSelected={selectedPlanId === plan.metadata.planId}
                  executingPlanId={executingPlanId}
                  reExecutingPlanId={reExecutingPlanId}
                  planTasksPlanIds={planTasksPlanIds}
                  executeError={executeError}
                  onSelect={() => onSelectPlan(plan)}
                  onShip={onShip}
                  onPlanTasks={onPlanTasks}
                  onReship={onReship}
                  onClearError={onClearError}
                  onMarkComplete={onMarkComplete}
                  markCompletePendingPlanId={markCompletePendingPlanId}
                  onGoToEvaluate={onGoToEvaluate}
                  autoExecutePlans={autoExecutePlans}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
