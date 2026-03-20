import { useMemo } from "react";
import type { ScopeChangeMetadata } from "@opensprint/shared";
import { formatSectionKey } from "../../lib/formatting";
import { getOrderedSections } from "../../lib/prdUtils";
import { PrdSectionEditor } from "./PrdSectionEditor";
import { PrdSectionInlineDiff } from "./PrdSectionInlineDiff";

export interface PrdViewerProps {
  prdContent: Record<string, string>;
  savingSections: string[];
  onSectionChange: (section: string, markdown: string) => void;
  containerRef?: React.RefObject<HTMLDivElement | null>;
  /** Notification ID per section for scroll-to-question (e.g. { open_questions: "notif-xyz" }) */
  questionIdBySection?: Record<string, string>;
  /** Proposed PRD changes from Harmonizer — when present, sections with updates show inline diff */
  scopeChangeMetadata?: ScopeChangeMetadata;
}

export function PrdViewer({
  prdContent,
  savingSections,
  onSectionChange,
  containerRef,
  questionIdBySection,
  scopeChangeMetadata,
}: PrdViewerProps) {
  const proposedBySection = useMemo(() => {
    const map = new Map<
      string,
      NonNullable<ScopeChangeMetadata["scopeChangeProposedUpdates"]>[number]
    >();
    for (const u of scopeChangeMetadata?.scopeChangeProposedUpdates ?? []) {
      map.set(u.section, u);
    }
    return map;
  }, [scopeChangeMetadata?.scopeChangeProposedUpdates]);

  const sectionKeys = useMemo(() => {
    const base = getOrderedSections(prdContent);
    const proposedOnly = (scopeChangeMetadata?.scopeChangeProposedUpdates ?? [])
      .map((u) => u.section)
      .filter((k) => !(k in prdContent));
    const baseSet = new Set(base);
    const appended = proposedOnly.filter((k) => !baseSet.has(k));
    return [...base, ...appended];
  }, [prdContent, scopeChangeMetadata?.scopeChangeProposedUpdates]);

  return (
    <div ref={containerRef}>
      {/* PRD Sections - editable inline, or inline diff when Harmonizer proposes changes */}
      <div className="space-y-8">
        {sectionKeys.map((sectionKey, index, arr) => {
          const isLast = index === arr.length - 1;
          const questionId = questionIdBySection?.[sectionKey];
          const proposedUpdate = proposedBySection.get(sectionKey);
          const showInlineDiff = !!proposedUpdate;
          const isAssumptionsSection = sectionKey === "assumptions_and_constraints";

          return (
            <div
              key={sectionKey}
              data-prd-section={sectionKey}
              className={`group relative ${isAssumptionsSection ? "rounded-xl border border-theme-info-border/50 bg-theme-info-bg/25 dark:bg-theme-info-bg/15 px-4 py-5 sm:px-5" : ""}`}
              {...(questionId && { "data-question-id": questionId })}
            >
              {/* Section header */}
              <div className="flex items-center justify-between mb-3">
                <div className="space-y-1">
                  <h2 className="text-lg font-semibold text-theme-text">
                    {formatSectionKey(sectionKey)}
                  </h2>
                  {isAssumptionsSection && (
                    <p className="text-sm text-theme-muted max-w-prose">
                      Beliefs we are proceeding with until disproven. Open Questions (below) are for
                      decisions that still need your input.
                    </p>
                  )}
                </div>
                {showInlineDiff && (
                  <span className="text-xs text-theme-muted font-medium">Proposed changes</span>
                )}
                {!showInlineDiff && savingSections.includes(sectionKey) && (
                  <span className="text-xs text-theme-muted">Saving...</span>
                )}
              </div>

              {/* Section content: inline diff when proposed, else WYSIWYG editor */}
              {showInlineDiff ? (
                <PrdSectionInlineDiff
                  currentContent={prdContent[sectionKey] ?? ""}
                  proposedUpdate={proposedUpdate}
                />
              ) : (
                <PrdSectionEditor
                  sectionKey={sectionKey}
                  markdown={prdContent[sectionKey] ?? ""}
                  onSave={onSectionChange}
                  disabled={savingSections.includes(sectionKey)}
                />
              )}

              {/* Divider (omit after last section; PrdChangeLog provides the final separator) */}
              {!isLast && <div className="mt-8 border-b border-theme-border" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
