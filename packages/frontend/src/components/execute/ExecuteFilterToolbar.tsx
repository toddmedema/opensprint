import type { StatusFilter } from "../../lib/executeTaskFilter";
import { ViewToggle } from "./ViewToggle";

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
  chipConfig: { label: string; filter: StatusFilter; count: number }[];
  statusFilter: StatusFilter;
  setStatusFilter: (f: StatusFilter) => void;
  awaitingApproval: boolean;
  searchExpanded: boolean;
  searchInputValue: string;
  setSearchInputValue: (v: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  handleSearchExpand: () => void;
  handleSearchClose: () => void;
  handleSearchKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  viewMode: "kanban" | "timeline";
  onViewModeChange: (mode: "kanban" | "timeline") => void;
}

export function ExecuteFilterToolbar({
  chipConfig,
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
}: ExecuteFilterToolbarProps) {
  return (
    <div
      className="w-full px-6 min-h-[48px] flex items-center py-2 border-b border-theme-border bg-theme-surface shrink-0"
      data-testid="execute-filter-toolbar"
    >
      <div className="flex w-full items-center justify-between gap-4">
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
                data-testid={`filter-chip-${filter}`}
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
          {awaitingApproval && (
            <span className="ml-2 text-sm font-medium text-theme-warning-text">
              Awaiting approval…
            </span>
          )}
        </div>
        <div className="flex items-center shrink-0">
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
                className="w-48 sm:w-56 px-3 py-1.5 text-sm bg-theme-surface-muted rounded-md text-theme-text placeholder:text-theme-muted border border-theme-border focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 transition-all"
                aria-label="Search tickets"
              />
              <button
                type="button"
                onClick={handleSearchClose}
                className="p-1.5 rounded-md text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle transition-colors"
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
              className="p-1.5 rounded-md text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle transition-colors"
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
          <div className="ml-2">
            <ViewToggle
              options={[
                { value: "kanban", icon: <GridIcon className="w-4 h-4" />, label: "Kanban view" },
                {
                  value: "timeline",
                  icon: <ListIcon className="w-4 h-4" />,
                  label: "Timeline view",
                },
              ]}
              value={viewMode}
              onChange={onViewModeChange}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
