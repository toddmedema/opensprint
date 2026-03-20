import React from "react";

/**
 * Shared collapsible section header and content wrapper.
 * Used by Description, Source Feedback, and Live Output sections in the task detail sidebar
 * so all three have identical element structure, styling, and collapse/expand behavior.
 */
function CollapsibleSectionInner({
  title,
  expanded,
  onToggle,
  expandAriaLabel,
  collapseAriaLabel,
  contentId,
  headerId,
  contentClassName,
  containerClassName,
  children,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  expandAriaLabel: string;
  collapseAriaLabel: string;
  contentId: string;
  headerId: string;
  /** Optional. Defaults to "p-4 pt-0". Use for compact sections (e.g. Description). */
  contentClassName?: string;
  /** Optional wrapper around the whole section (e.g. callout styling for Assumptions). */
  containerClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={containerClassName}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-theme-border-subtle/50 transition-colors"
        aria-expanded={expanded}
        aria-controls={contentId}
        aria-label={expanded ? collapseAriaLabel : expandAriaLabel}
        id={headerId}
      >
        <h4 className="text-xs font-medium text-theme-muted uppercase tracking-wide">{title}</h4>
        <span className="text-theme-muted text-xs">{expanded ? "▼" : "▶"}</span>
      </button>
      {expanded && (
        <div
          id={contentId}
          role="region"
          aria-labelledby={headerId}
          className={contentClassName ?? "p-4 pt-0"}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export const CollapsibleSection = React.memo(CollapsibleSectionInner);
