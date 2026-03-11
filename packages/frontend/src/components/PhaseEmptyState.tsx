/** Reusable empty-state pattern for phase pages.
 * Pattern: copy (title + description), optional illustration, primary action.
 * Keeps empty states consistent and actionable across Sketch, Plan, Execute, Eval, Deliver.
 * Use EMPTY_STATE_COPY from lib/emptyStateCopy for phase-specific copy.
 * @see docs/design/empty-state-pattern.md for full spec. */
export interface PhaseEmptyStateProps {
  /** Short title (e.g. "No plans yet") */
  title: string;
  /** Supporting copy explaining what to do next */
  description: string;
  /** Optional illustration (e.g. phase icon or OpenSprint logo) */
  illustration?: React.ReactNode;
  /** Primary action button — makes the empty state actionable */
  primaryAction?: {
    label: string;
    onClick: () => void;
    "data-testid"?: string;
  };
  /** Optional className for the container */
  className?: string;
}

export function PhaseEmptyState({
  title,
  description,
  illustration,
  primaryAction,
  className = "",
}: PhaseEmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center text-center py-10 px-4 ${className}`}
      data-testid="phase-empty-state"
    >
      {illustration && (
        <div className="mb-4 flex items-center justify-center" aria-hidden>
          {illustration}
        </div>
      )}
      <h3 className="text-base font-semibold text-theme-text">{title}</h3>
      <p className="text-theme-muted text-sm mt-1 max-w-md">{description}</p>
      {primaryAction && (
        <button
          type="button"
          onClick={primaryAction.onClick}
          className="btn-primary mt-4 rounded-lg px-4 py-2 text-sm font-medium"
          data-testid={primaryAction["data-testid"] ?? "phase-empty-state-action"}
        >
          {primaryAction.label}
        </button>
      )}
    </div>
  );
}

/** Optional OpenSprint logo illustration for empty states */
export function PhaseEmptyStateLogo({ className = "w-10 h-10" }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" className={className} aria-hidden>
      <polygon points="4,10 36,40 4,70" fill="#c7d2fe" />
      <polygon points="22,10 54,40 22,70" fill="#818cf8" />
      <polygon points="40,10 72,40 40,70" fill="#4f46e5" />
    </svg>
  );
}
