import type { StatusFilter } from "../../lib/executeTaskFilter";
import { ViewToggle } from "./ViewToggle";
import { SegmentedControl } from "../controls/SegmentedControl";
import { FilterBar } from "../controls/FilterBar";

function GridIcon({ className }: { className?: string }) {
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
      <rect x="2" y="2" width="5" height="5" rx="0.5" />
      <rect x="9" y="2" width="5" height="5" rx="0.5" />
      <rect x="2" y="9" width="5" height="5" rx="0.5" />
      <rect x="9" y="9" width="5" height="5" rx="0.5" />
    </svg>
  );
}

function ListIcon({ className }: { className?: string }) {
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
      <path d="M2 4h12" />
      <path d="M2 8h12" />
      <path d="M2 12h12" />
    </svg>
  );
}

interface ExecuteFilterToolbarProps {
  collaborationControl?: React.ReactNode;
  chipConfig: { label: string; filter: StatusFilter; count: number }[];
  statusFilter: StatusFilter;
  setStatusFilter: (f: StatusFilter) => void;
  awaitingApproval: boolean;
  /** When true, show a small non-blocking indicator that self-improvement review is in progress */
  selfImprovementRunInProgress?: boolean;
  /** Run mode determines indicator text: "audit" (or undefined) → review, "experiments" → experiment */
  selfImprovementRunMode?: "audit" | "experiments";
  searchExpanded: boolean;
  searchInputValue: string;
  setSearchInputValue: (v: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  handleSearchExpand: () => void;
  handleSearchClose: () => void;
  handleSearchKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  viewMode: "kanban" | "timeline";
  onViewModeChange: (mode: "kanban" | "timeline") => void;
  /** When "per_epic", show epic merge mode indicator. Omit or "per_task" = no indicator. */
  mergeStrategy?: "per_task" | "per_epic";
}

/** Present Execute filters, shared-session entry, search, and view controls in one toolbar. */
export function ExecuteFilterToolbar({
  chipConfig,
  collaborationControl,
  statusFilter,
  setStatusFilter,
  awaitingApproval,
  searchExpanded,
  searchInputValue,
  setSearchInputValue,
  searchInputRef,
  handleSearchExpand,
  handleSearchClose,
  handleSearchKeyDown,
  viewMode,
  onViewModeChange,
  mergeStrategy,
  selfImprovementRunInProgress = false,
  selfImprovementRunMode,
}: ExecuteFilterToolbarProps) {
  const showEpicMergeIndicator = mergeStrategy === "per_epic";

  const left = (
    <>
      <SegmentedControl
        size="phase"
        dataTestId="execute-filter-segmented"
        value={statusFilter}
        onChange={(next) => {
          const isActive = statusFilter === next;
          setStatusFilter(isActive && next !== "all" ? "all" : next);
        }}
        options={chipConfig
          .filter((c) => c.filter === "all" || c.count > 0)
          .map(({ label, filter, count }) => ({
            value: filter,
            label,
            count,
            testId: `filter-chip-${filter}`,
            ariaLabel: `${label} ${count}${statusFilter === filter ? ", selected" : ""}`,
          }))}
      />

      {awaitingApproval && (
        <span className="ml-1 text-xs font-medium text-theme-warning-text shrink-0 rounded-full bg-theme-warning-bg px-2 py-1 border border-theme-warning-border">
          Awaiting approval
        </span>
      )}

      {selfImprovementRunInProgress && (
        <span
          className="ml-1 text-xs text-theme-muted shrink-0 rounded-full bg-theme-surface-muted px-2 py-1 border border-theme-border-subtle"
          data-testid="execute-self-improvement-indicator"
          title={
            selfImprovementRunMode === "experiments"
              ? "An agent enhancement experiment is running"
              : "New tasks may appear from the self-improvement review"
          }
        >
          {selfImprovementRunMode === "experiments"
            ? "Agent enhancement experiment in progress"
            : "Self-improvement review in progress"}
        </span>
      )}

      {showEpicMergeIndicator && (
        <span
          className="ml-1 text-xs text-theme-muted shrink-0 rounded-full bg-theme-surface-muted px-2 py-1 border border-theme-border-subtle"
          data-testid="execute-epic-merge-indicator"
          title="Changes merge to main when the plan (epic) is complete"
        >
          Epic merge mode
        </span>
      )}
    </>
  );

  const right = (
    <>
      {collaborationControl}
      {searchExpanded ? (
        <div
          className="flex items-center gap-1 animate-fade-in"
          data-testid="execute-search-expanded"
        >
          <input
            ref={searchInputRef}
            type="text"
            value={searchInputValue}
            onChange={(e) => setSearchInputValue(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search tickets…"
            className="w-36 sm:w-48 md:w-56 px-3 py-1.5 text-sm bg-theme-surface-muted rounded-md text-theme-text placeholder:text-theme-muted border border-theme-border focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:border-brand-500 transition-all"
            aria-label="Search tickets"
          />
          <button
            type="button"
            onClick={handleSearchClose}
            className="p-1.5 min-h-[32px] min-w-[32px] rounded-sm text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle transition-colors inline-flex items-center justify-center"
            aria-label="Close search"
            data-testid="execute-search-close"
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
          data-testid="execute-search-expand"
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
      )}

      <ViewToggle
        compact
        options={[
          { value: "kanban", icon: <GridIcon className="w-3 h-3" />, label: "Kanban view" },
          {
            value: "timeline",
            icon: <ListIcon className="w-3 h-3" />,
            label: "Timeline view",
          },
        ]}
        value={viewMode}
        onChange={onViewModeChange}
      />
    </>
  );

  return (
    <FilterBar variant="phase" left={left} right={right} dataTestId="execute-filter-toolbar" />
  );
}
