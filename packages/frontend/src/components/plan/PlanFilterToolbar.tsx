import type { PlanStatus } from "@opensprint/shared";
import { ViewToggle } from "../execute/ViewToggle";

function CardIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2" y="2" width="12" height="10" rx="1" />
      <path d="M2 6h12" />
    </svg>
  );
}

function GraphIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="4" cy="4" r="2" />
      <circle cx="12" cy="4" r="2" />
      <circle cx="4" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <path d="M6 4h4" />
      <path d="M4 8v4" />
      <path d="M12 8v4" />
      <path d="M8 4v4" />
    </svg>
  );
}

export type PlanViewMode = "card" | "graph";

interface PlanFilterToolbarProps {
  statusFilter: "all" | PlanStatus;
  setStatusFilter: (f: "all" | PlanStatus) => void;
  planCountByStatus: { all: number; planning: number; building: number; complete: number };
  viewMode: PlanViewMode;
  onViewModeChange: (mode: PlanViewMode) => void;
  plansWithNoTasksCount: number;
  plansReadyToExecuteCount: number;
  planAllInProgress: boolean;
  executeAllInProgress: boolean;
  executingPlanId: string | null;
  planTasksPlanIds: string[];
  onPlanAllTasks: () => void;
  onExecuteAll: () => void;
}

export function PlanFilterToolbar({
  statusFilter,
  setStatusFilter,
  planCountByStatus,
  viewMode,
  onViewModeChange,
  plansWithNoTasksCount,
  plansReadyToExecuteCount,
  planAllInProgress,
  executeAllInProgress,
  executingPlanId,
  planTasksPlanIds,
  onPlanAllTasks,
  onExecuteAll,
}: PlanFilterToolbarProps) {
  const chipConfig = [
    { label: "All", filter: "all" as const, count: planCountByStatus.all },
    { label: "Planning", filter: "planning" as const, count: planCountByStatus.planning },
    { label: "Building", filter: "building" as const, count: planCountByStatus.building },
    { label: "Complete", filter: "complete" as const, count: planCountByStatus.complete },
  ];

  return (
    <div className="px-6 py-4 border-b border-theme-border bg-theme-surface shrink-0">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2 flex-1 min-w-0">
          {chipConfig.map(({ label, filter, count }) => {
            const isActive = statusFilter === filter;
            const isAll = filter === "all";
            const handleClick = () => {
              setStatusFilter(isActive && !isAll ? "all" : filter);
            };
            return (
              <button
                key={filter}
                type="button"
                onClick={handleClick}
                data-testid={`plan-filter-chip-${filter}`}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-brand-600 text-white ring-2 ring-brand-500 ring-offset-2 ring-offset-theme-bg"
                    : "bg-theme-surface-muted text-theme-text hover:bg-theme-border-subtle"
                }`}
                aria-pressed={isActive}
                aria-label={`${label} ${count}${isActive ? ", selected" : ""}`}
              >
                <span>{label}</span>
                <span className={isActive ? "opacity-90" : "text-theme-muted"}>{count}</span>
              </button>
            );
          })}
          {plansWithNoTasksCount >= 2 && (
            <button
              type="button"
              onClick={onPlanAllTasks}
              disabled={planAllInProgress || planTasksPlanIds.length > 0}
              className="btn-primary text-sm py-1.5 px-2.5 disabled:opacity-60 disabled:cursor-not-allowed"
              data-testid="plan-all-tasks-button"
            >
              {planAllInProgress ? "Planning all…" : "Plan All Tasks"}
            </button>
          )}
          {plansReadyToExecuteCount >= 2 && (
            <button
              type="button"
              onClick={onExecuteAll}
              disabled={!!executingPlanId || executeAllInProgress}
              className="btn-primary text-sm py-1.5 px-2.5 disabled:opacity-60 disabled:cursor-not-allowed"
              data-testid="execute-all-button"
            >
              {executeAllInProgress ? "Executing all…" : "Execute All"}
            </button>
          )}
        </div>
        <div className="flex items-center shrink-0">
          <ViewToggle
            options={[
              { value: "card", icon: <CardIcon className="w-4 h-4" />, label: "Card view" },
              { value: "graph", icon: <GraphIcon className="w-4 h-4" />, label: "Graph view" },
            ]}
            value={viewMode}
            onChange={onViewModeChange}
          />
        </div>
      </div>
    </div>
  );
}
