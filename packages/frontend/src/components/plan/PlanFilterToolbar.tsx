import { useEffect, useRef, useState } from "react";
import type { PlanStatus } from "@opensprint/shared";
import { ViewToggle } from "../execute/ViewToggle";
import { SegmentedControl } from "../controls/SegmentedControl";
import { FilterBar } from "../controls/FilterBar";

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

function KebabIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.8}
      stroke="currentColor"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 6.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 12.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 18.75a.75.75 0 110-1.5.75.75 0 010 1.5z"
      />
    </svg>
  );
}

export type PlanViewMode = "card" | "graph";

interface PlanFilterToolbarProps {
  statusFilter: "all" | PlanStatus;
  setStatusFilter: (f: "all" | PlanStatus) => void;
  planCountByStatus: {
    all: number;
    planning: number;
    building: number;
    in_review: number;
    complete: number;
  };
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
  onAddPlan: () => void;
  /** Search (mirrors ExecuteFilterToolbar) */
  searchExpanded?: boolean;
  searchInputValue?: string;
  setSearchInputValue?: (v: string) => void;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
  handleSearchExpand?: () => void;
  handleSearchClose?: () => void;
  handleSearchKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** When true, hide "Generate All Tasks" and use single "Execute All" (generate+execute in one step). */
  autoExecutePlans?: boolean;
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
  onAddPlan,
  searchExpanded,
  searchInputValue = "",
  setSearchInputValue,
  searchInputRef,
  handleSearchExpand,
  handleSearchClose,
  handleSearchKeyDown,
  autoExecutePlans: _autoExecutePlans = false,
}: PlanFilterToolbarProps) {
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false);
  const bulkMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!bulkMenuOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (bulkMenuRef.current && !bulkMenuRef.current.contains(event.target as Node)) {
        setBulkMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [bulkMenuOpen]);

  const chipConfig = [
    { label: "All", filter: "all" as const, count: planCountByStatus.all },
    { label: "Planning", filter: "planning" as const, count: planCountByStatus.planning },
    { label: "Building", filter: "building" as const, count: planCountByStatus.building },
    { label: "In review", filter: "in_review" as const, count: planCountByStatus.in_review },
    { label: "Complete", filter: "complete" as const, count: planCountByStatus.complete },
  ].filter((c) => c.filter === "all" || c.count > 0);

  const showPlanAllButton = plansWithNoTasksCount >= 2;
  const showExecuteAllButton = plansReadyToExecuteCount >= 2;
  const showBulkActions = showPlanAllButton || showExecuteAllButton;

  const left = (
    <SegmentedControl
      size="phase"
      dataTestId="plan-filter-segmented"
      value={statusFilter}
      onChange={(next) => {
        const isActive = statusFilter === next;
        setStatusFilter(isActive && next !== "all" ? "all" : next);
      }}
      options={chipConfig.map(({ label, filter, count }) => ({
        value: filter,
        label,
        count,
        testId: `plan-filter-chip-${filter}`,
        ariaLabel: `${label} ${count}${statusFilter === filter ? ", selected" : ""}`,
      }))}
    />
  );

  const right = (
    <>
      {handleSearchExpand &&
      handleSearchClose &&
      handleSearchKeyDown &&
      setSearchInputValue &&
      searchInputRef ? (
        searchExpanded ? (
          <div
            className="flex items-center gap-1 animate-fade-in"
            data-testid="plan-search-expanded"
          >
            <input
              ref={searchInputRef}
              type="text"
              value={searchInputValue}
              onChange={(e) => setSearchInputValue(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search plans…"
              className="w-48 sm:w-56 px-3 py-1.5 text-sm bg-theme-surface-muted rounded-md text-theme-text placeholder:text-theme-muted border border-theme-border focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:border-brand-500 transition-all"
              aria-label="Search plans"
            />
            <button
              type="button"
              onClick={handleSearchClose}
              className="p-1.5 min-h-[32px] min-w-[32px] rounded-sm text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle transition-colors inline-flex items-center justify-center"
              aria-label="Close search"
              data-testid="plan-search-close"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleSearchExpand}
            className="p-1.5 min-h-[32px] min-w-[32px] rounded-sm text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle transition-colors inline-flex items-center justify-center"
            aria-label="Expand search"
            data-testid="plan-search-expand"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
          </button>
        )
      ) : null}

      <button
        type="button"
        onClick={onAddPlan}
        className="btn-primary text-sm py-0.5 px-2.5 min-h-[32px] min-w-[32px] rounded-sm hover:bg-brand-800 inline-flex items-center justify-center"
        data-testid="add-plan-button"
      >
        New Plan
      </button>

      {showBulkActions && (
        <div className="relative" ref={bulkMenuRef}>
          <button
            type="button"
            onClick={() => setBulkMenuOpen((open) => !open)}
            className="btn-secondary px-2.5 min-h-[32px] min-w-[32px] rounded-sm inline-flex items-center justify-center"
            data-testid="plan-bulk-actions-button"
            aria-label="Bulk actions"
            aria-expanded={bulkMenuOpen}
            aria-haspopup="menu"
            title="Bulk actions"
          >
            <KebabIcon className="w-4 h-4" />
          </button>
          {bulkMenuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full mt-1 min-w-[13rem] rounded-lg border border-theme-border bg-theme-surface shadow-lg py-1 z-20"
              data-testid="plan-bulk-actions-menu"
            >
              {showPlanAllButton && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onPlanAllTasks();
                    setBulkMenuOpen(false);
                  }}
                  disabled={planAllInProgress || planTasksPlanIds.length > 0}
                  className="w-full text-left px-3 py-2 text-sm text-theme-text hover:bg-theme-border-subtle disabled:opacity-60 disabled:cursor-not-allowed"
                  data-testid="plan-all-tasks-button"
                >
                  {planAllInProgress ? "Generating all…" : "Generate All Tasks"}
                </button>
              )}
              {showExecuteAllButton && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onExecuteAll();
                    setBulkMenuOpen(false);
                  }}
                  disabled={!!executingPlanId || executeAllInProgress}
                  className="w-full text-left px-3 py-2 text-sm text-theme-text hover:bg-theme-border-subtle disabled:opacity-60 disabled:cursor-not-allowed"
                  data-testid="execute-all-button"
                >
                  {executeAllInProgress ? "Executing all…" : "Execute All"}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <ViewToggle
        compact
        options={[
          { value: "card", icon: <CardIcon className="w-3 h-3" />, label: "Card view" },
          { value: "graph", icon: <GraphIcon className="w-3 h-3" />, label: "Graph view" },
        ]}
        value={viewMode}
        onChange={onViewModeChange}
      />
    </>
  );

  return <FilterBar variant="phase" left={left} right={right} dataTestId="plan-filter-toolbar" />;
}
