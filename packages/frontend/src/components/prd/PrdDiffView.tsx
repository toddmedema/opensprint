/**
 * PRD diff view — displays proposed PRD changes with line-level diff.
 * Used in HIL approval flow for scope-change feedback (Evaluate, Harmonizer).
 */

import * as Diff from "diff";
import type { Prd, ScopeChangeMetadata } from "@opensprint/shared";
import { formatSectionKey } from "../../lib/formatting";

export interface PrdDiffViewProps {
  /** Current PRD (from api.prd.get) */
  currentPrd: Prd | null;
  /** Proposed updates from scope-change HIL metadata */
  scopeChangeMetadata: ScopeChangeMetadata;
}

/**
 * Renders a section-level diff: for each proposed section, shows current vs proposed with line-level changes.
 */
export function PrdDiffView({ currentPrd, scopeChangeMetadata }: PrdDiffViewProps) {
  const { scopeChangeSummary, scopeChangeProposedUpdates } = scopeChangeMetadata;

  if (!scopeChangeProposedUpdates?.length) {
    return (
      <div className="text-sm text-theme-muted">
        {scopeChangeSummary || "Proposed PRD section updates."}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {scopeChangeSummary && (
        <p className="text-sm text-theme-text whitespace-pre-wrap">{scopeChangeSummary}</p>
      )}
      <div className="space-y-4">
        {scopeChangeProposedUpdates.map((update) => {
          const currentContent = currentPrd?.sections?.[update.section]?.content?.trim() ?? "";
          const proposedContent = (update.content ?? "").trim();
          const changeLogEntry = update.changeLogEntry;

          const diffParts = Diff.diffLines(currentContent, proposedContent, {
            newlineIsToken: true,
          });

          return (
            <div
              key={update.section}
              className="rounded-lg border border-theme-border bg-theme-surface-muted overflow-hidden"
              data-testid={`prd-diff-section-${update.section}`}
            >
              <div className="px-3 py-2 bg-theme-border-subtle/50 border-b border-theme-border">
                <span className="font-medium text-theme-text">
                  {formatSectionKey(update.section)}
                </span>
                {changeLogEntry && (
                  <span className="ml-2 text-sm text-theme-muted">— {changeLogEntry}</span>
                )}
              </div>
              <div className="p-3 font-mono text-xs overflow-x-auto max-h-64 overflow-y-auto">
                {diffParts.length === 0 && currentContent === "" && proposedContent === "" ? (
                  <span className="text-theme-muted">(No content)</span>
                ) : (
                  <pre className="m-0 whitespace-pre-wrap break-words">
                    {diffParts.map((part, i) => {
                      const bg = part.added
                        ? "bg-theme-success-bg"
                        : part.removed
                          ? "bg-theme-error-bg/40"
                          : "";
                      const prefix = part.added ? "+ " : part.removed ? "- " : "  ";
                      const textColor = part.added
                        ? "text-theme-success-text"
                        : part.removed
                          ? "text-theme-error-text"
                          : "text-theme-text";
                      const lines = part.value.split("\n");
                      return (
                        <div key={i} className={`${bg} ${textColor}`}>
                          {lines.map((line, j) => (
                            <div key={j}>
                              {prefix}
                              {line || "\u00a0"}
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </pre>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
