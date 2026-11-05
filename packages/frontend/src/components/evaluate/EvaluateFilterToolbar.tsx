import type { KeyboardEvent, RefObject, ReactNode } from "react";
import { SegmentedControl } from "../controls/SegmentedControl";
import { FilterBar } from "../controls/FilterBar";
import { ViewToggle } from "../execute/ViewToggle";

export type EvaluateStatusFilterChip = "all" | "pending" | "resolved" | "cancelled";
export type EvaluateViewMode = "feedback" | "intake";

function FeedbackIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function InboxIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

interface EvaluateFilterToolbarProps {
  automatedQaAction?: ReactNode;
  chipConfig: { label: string; filter: EvaluateStatusFilterChip; count: number }[];
  statusFilter: EvaluateStatusFilterChip;
  setStatusFilter: (f: EvaluateStatusFilterChip) => void;
  searchExpanded: boolean;
  searchInputValue: string;
  setSearchInputValue: (v: string) => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
  handleSearchExpand: () => void;
  handleSearchClose: () => void;
  handleSearchKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  viewMode: EvaluateViewMode;
  onViewModeChange: (mode: EvaluateViewMode) => void;
  /** Intake view: source / status / search (single top bar with view toggle). */
  intakeProviderFilter: string;
  setIntakeProviderFilter: (v: string) => void;
  intakeTriageStatusFilter: string;
  setIntakeTriageStatusFilter: (v: string) => void;
  intakeSearchQuery: string;
  setIntakeSearchQuery: (v: string) => void;
  /** Shown next to intake filters when the list query has returned successfully. */
  intakeItemCount?: number;
}

export function EvaluateFilterToolbar({
  automatedQaAction,
  chipConfig,
  statusFilter,
  setStatusFilter,
  searchExpanded,
  searchInputValue,
  setSearchInputValue,
  searchInputRef,
  handleSearchExpand,
  handleSearchClose,
  handleSearchKeyDown,
  viewMode,
  onViewModeChange,
  intakeProviderFilter,
  setIntakeProviderFilter,
  intakeTriageStatusFilter,
  setIntakeTriageStatusFilter,
  intakeSearchQuery,
  setIntakeSearchQuery,
  intakeItemCount,
}: EvaluateFilterToolbarProps) {
  const isFeedback = viewMode === "feedback";

  const left = isFeedback ? (
    <SegmentedControl
      size="phase"
      dataTestId="eval-filter-segmented"
      value={statusFilter}
      onChange={(next) => {
        const isActive = statusFilter === next;
        setStatusFilter(isActive && next !== "all" ? "all" : next);
      }}
      options={chipConfig
        .filter((c) => c.filter === "all" || c.filter === "pending" || c.count > 0)
        .map(({ label, filter, count }) => ({
          value: filter,
          label,
          count,
          testId: `eval-filter-chip-${filter}`,
          ariaLabel: `${label} ${count}${statusFilter === filter ? ", selected" : ""}`,
        }))}
    />
  ) : (
    <div className="flex items-center gap-2 min-w-0 flex-1">
      <select
        value={intakeProviderFilter}
        onChange={(e) => setIntakeProviderFilter(e.target.value)}
        className="text-xs bg-theme-surface-muted border border-theme-border rounded-sm px-2 py-1.5 min-h-[32px] max-w-[7.5rem] sm:max-w-[9rem] shrink-0 text-theme-text"
        data-testid="intake-provider-filter"
        aria-label="Filter by source"
      >
        <option value="">All Sources</option>
        <option value="todoist">Todoist</option>
        <option value="github">GitHub</option>
        <option value="slack">Slack</option>
        <option value="webhook">Webhook</option>
      </select>
      <select
        value={intakeTriageStatusFilter}
        onChange={(e) => setIntakeTriageStatusFilter(e.target.value)}
        className="text-xs bg-theme-surface-muted border border-theme-border rounded-sm px-2 py-1.5 min-h-[32px] max-w-[7.5rem] sm:max-w-[9rem] shrink-0 text-theme-text"
        data-testid="intake-status-filter"
        aria-label="Filter by triage status"
      >
        <option value="">All Statuses</option>
        <option value="new">New</option>
        <option value="triaged">Triaged</option>
        <option value="converted">Converted</option>
        <option value="ignored">Ignored</option>
      </select>
      <input
        type="text"
        value={intakeSearchQuery}
        onChange={(e) => setIntakeSearchQuery(e.target.value)}
        placeholder="Search intake…"
        className="flex-1 min-w-[6rem] text-xs bg-theme-surface-muted border border-theme-border rounded-sm px-2 py-1.5 min-h-[32px] text-theme-text placeholder:text-theme-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:border-brand-500"
        data-testid="intake-search"
        aria-label="Search intake items"
      />
      {typeof intakeItemCount === "number" && (
        <span
          className="text-[10px] text-theme-muted whitespace-nowrap shrink-0"
          data-testid="intake-item-count"
        >
          {intakeItemCount} items
        </span>
      )}
    </div>
  );

  const right = (
    <>
      {isFeedback &&
        (searchExpanded ? (
          <div
            className="flex items-center gap-1 animate-fade-in"
            data-testid="eval-search-expanded"
          >
            <input
              ref={searchInputRef}
              type="text"
              value={searchInputValue}
              onChange={(e) => setSearchInputValue(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search feedback…"
              className="w-36 sm:w-48 md:w-56 px-3 py-1.5 text-sm bg-theme-surface-muted rounded-md text-theme-text placeholder:text-theme-muted border border-theme-border focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:border-brand-500 transition-all"
              aria-label="Search feedback"
            />
            <button
              type="button"
              onClick={handleSearchClose}
              className="p-1.5 min-h-[32px] min-w-[32px] rounded-sm text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle transition-colors inline-flex items-center justify-center"
              aria-label="Close search"
              data-testid="eval-search-close"
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
            data-testid="eval-search-expand"
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
        ))}
      <ViewToggle
        compact
        options={[
          {
            value: "feedback" as EvaluateViewMode,
            icon: <FeedbackIcon className="w-3 h-3" />,
            label: "Feedback view",
          },
          {
            value: "intake" as EvaluateViewMode,
            icon: <InboxIcon className="w-3 h-3" />,
            label: "Intake view",
          },
        ]}
        value={viewMode}
        onChange={onViewModeChange}
      />
      {automatedQaAction}
    </>
  );

  return (
    <FilterBar
      variant="phase"
      left={left}
      right={right}
      dataTestId="eval-feedback-filter-toolbar"
    />
  );
}
