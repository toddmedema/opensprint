/**
 * Server diff view — renders API diff format (lines with type, text, line numbers).
 * Used by HIL approval (proposed-diff) and Sketch version list (version diff).
 * Does not duplicate PrdDiffView; consumes the backend/API response format.
 *
 * Large-diff performance: When the diff has more than INITIAL_DIFF_LINE_CAP lines,
 * only the first N lines are rendered initially with a "Show more" control to expand.
 * This keeps the DOM and initial render fast for very large SPEC.md diffs. Full
 * virtualization (e.g. windowing) is deferred for scope.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** Max lines rendered initially for large diffs; expand via "Show more". Exported for tests. */
export const INITIAL_DIFF_LINE_CAP = 500;

/** Single line in the server diff (API format) */
export interface ServerDiffLine {
  type: "add" | "remove" | "context";
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

/** Diff result from API (proposed-diff or version diff) */
export interface ServerDiffResult {
  lines: ServerDiffLine[];
  summary?: { additions: number; deletions: number };
}

export interface ServerDiffViewProps {
  /** Diff from API (lines + optional summary) */
  diff: ServerDiffResult;
  /** Optional title: "from" version (e.g. previous version id) */
  fromVersion?: string;
  /** Optional title: "to" version (e.g. "current" or version id) */
  toVersion?: string;
}

const LINE_TYPE_ARIA: Record<ServerDiffLine["type"], string> = {
  add: "Added line",
  remove: "Removed line",
  context: "Context line",
};

export function ServerDiffView({
  diff,
  fromVersion,
  toVersion,
}: ServerDiffViewProps) {
  const { lines, summary } = diff;
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);

  const isCapped = lines.length > INITIAL_DIFF_LINE_CAP && !expanded;
  const visibleLines = isCapped ? lines.slice(0, INITIAL_DIFF_LINE_CAP) : lines;
  const hiddenCount = lines.length - visibleLines.length;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (visibleLines.length === 0) return;
      const maxIndex = visibleLines.length - 1;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex((i) => (i === null ? 0 : Math.min(i + 1, maxIndex)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex((i) => (i === null ? maxIndex : Math.max(i - 1, 0)));
      } else if (e.key === "Home") {
        e.preventDefault();
        setFocusedIndex(0);
      } else if (e.key === "End") {
        e.preventDefault();
        setFocusedIndex(maxIndex);
      }
    },
    [visibleLines.length]
  );

  useEffect(() => {
    if (focusedIndex === null) return;
    const el = lineRefs.current[focusedIndex];
    el?.focus();
  }, [focusedIndex]);

  const hasTitle = fromVersion !== undefined || toVersion !== undefined;
  const title =
    hasTitle && (fromVersion !== undefined || toVersion !== undefined)
      ? `${fromVersion ?? "?"} → ${toVersion ?? "current"}`
      : null;

  return (
    <div
      className="rounded-lg border border-theme-border bg-theme-surface-muted overflow-hidden"
      data-testid="server-diff-view"
    >
      {title && (
        <div className="px-3 py-2 bg-theme-border-subtle/50 border-b border-theme-border">
          <span className="font-medium text-theme-text text-sm">{title}</span>
          {summary != null && (
            <span className="ml-2 text-xs text-theme-muted">
              +{summary.additions} −{summary.deletions}
            </span>
          )}
        </div>
      )}
      {summary != null && !title && (
        <div className="px-3 py-1.5 bg-theme-border-subtle/50 border-b border-theme-border text-xs text-theme-muted">
          +{summary.additions} −{summary.deletions}
        </div>
      )}
      <div
        className="font-mono text-xs overflow-x-auto max-h-[24rem] overflow-y-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-theme-ring"
        role="list"
        aria-label="Diff lines"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setFocusedIndex(null);
        }}
      >
        {lines.length === 0 ? (
          <div className="p-3 text-theme-muted" data-testid="server-diff-no-changes">No changes</div>
        ) : (
          <>
          <pre className="m-0 p-0 whitespace-pre-wrap break-words">
            {visibleLines.map((line, i) => {
              const isAdd = line.type === "add";
              const isRemove = line.type === "remove";
              const bg = isAdd
                ? "bg-theme-success-bg"
                : isRemove
                  ? "bg-theme-error-bg"
                  : "";
              const textColor = isAdd
                ? "text-theme-success-text"
                : isRemove
                  ? "text-theme-error-text"
                  : "text-theme-text";
              const prefix = isAdd ? "+ " : isRemove ? "- " : "  ";
              const ariaLabel = LINE_TYPE_ARIA[line.type];
              const oldNum = line.oldLineNumber != null ? String(line.oldLineNumber) : "";
              const newNum = line.newLineNumber != null ? String(line.newLineNumber) : "";
              return (
                <div
                  key={i}
                  ref={(el) => {
                    lineRefs.current[i] = el;
                  }}
                  role="listitem"
                  aria-label={`${ariaLabel}: ${line.text.slice(0, 80)}${line.text.length > 80 ? "…" : ""}`}
                  tabIndex={-1}
                  className={`flex min-w-0 border-l-2 ${isAdd ? "border-l-theme-success-border" : isRemove ? "border-l-theme-error-border" : "border-l-transparent"} ${bg} ${textColor} ${focusedIndex === i ? "ring-1 ring-inset ring-theme-ring" : ""}`}
                  data-line-type={line.type}
                >
                  <span
                    className="shrink-0 w-10 text-right pr-2 py-0.5 text-theme-muted select-none"
                    aria-hidden
                  >
                    {oldNum}
                  </span>
                  <span
                    className="shrink-0 w-10 text-right pr-2 py-0.5 text-theme-muted select-none border-r border-theme-border-subtle"
                    aria-hidden
                  >
                    {newNum}
                  </span>
                  <span className="flex-1 py-0.5 pl-1">
                    {prefix}
                    {line.text || "\u00a0"}
                  </span>
                </div>
              );
            })}
          </pre>
          {isCapped && (
            <div className="px-3 py-2 border-t border-theme-border bg-theme-surface-muted">
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="text-sm text-theme-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-theme-ring rounded"
                data-testid="server-diff-show-more"
              >
                Show more ({hiddenCount} more line{hiddenCount !== 1 ? "s" : ""})
              </button>
            </div>
          )}
          </>
        )}
      </div>
    </div>
  );
}
