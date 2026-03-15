import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { Plan } from "@opensprint/shared";
import { formatPlanIdAsTitle } from "../../lib/formatting";
import {
  parsePlanContent,
  serializePlanContent,
  parsePlanBodySections,
  serializePlanBodySections,
} from "../../lib/planContentUtils";
import { PrdSectionEditor } from "../prd/PrdSectionEditor";
import { CollapsibleSection } from "../execute/CollapsibleSection";
import { usePlanVersions, usePlanVersion } from "../../api/hooks";

/** Matches PrdSectionEditor / Sketch phase debounce for consistency */
const DEBOUNCE_MS = 800;

export interface PlanDetailContentProps {
  plan: Plan;
  onContentSave: (content: string) => void;
  saving?: boolean;
  /** Optional actions to render in the header row next to the title (e.g. archive, close buttons) */
  headerActions?: React.ReactNode;
  /**
   * Optional render prop for sticky header layout. When provided, receives { header, body }
   * so the parent can place the header in a fixed (shrink-0) slot and the body in a scrollable area.
   */
  children?: (slots: { header: React.ReactNode; body: React.ReactNode }) => React.ReactNode;
  /** When set, show version dropdown (usePlanVersions); requires projectId and planId. */
  projectId?: string;
  planId?: string;
  /** Currently selected version in dropdown; null/undefined = current version. */
  selectedVersionNumber?: number | null;
  /** Called when user selects a version from the dropdown, or null for "Back to current". */
  onVersionSelect?: (versionNumber: number | null) => void;
}

/**
 * Inline editable plan title and markdown in the Plan phase details sidebar.
 * Title is derived from first line (# Title); body is the rest.
 * Debounced autosave for both.
 */
export function PlanDetailContent({
  plan,
  onContentSave,
  saving = false,
  headerActions,
  children: renderSlots,
  projectId,
  planId,
  selectedVersionNumber,
  onVersionSelect,
}: PlanDetailContentProps) {
  const { title, body } = parsePlanContent(plan.content ?? "");
  const displayTitle = title || formatPlanIdAsTitle(plan.metadata.planId);

  const versionsQuery = usePlanVersions(projectId, planId, {
    enabled: Boolean(projectId && planId),
  });
  const versions = useMemo(() => {
    const list = versionsQuery.data ?? [];
    return [...list].sort((a, b) => (b.version_number ?? 0) - (a.version_number ?? 0));
  }, [versionsQuery.data]);
  const currentVersion = plan.currentVersionNumber ?? 1;
  const lastExecuted = plan.lastExecutedVersionNumber;
  const showVersionSelector = Boolean(projectId && planId);
  const effectiveSelectedVersion = selectedVersionNumber ?? currentVersion;
  const isViewingPastVersion =
    selectedVersionNumber != null && selectedVersionNumber !== currentVersion;

  const versionQuery = usePlanVersion(projectId, planId, selectedVersionNumber ?? undefined, {
    enabled: Boolean(projectId && planId && isViewingPastVersion),
  });
  const versionContent = versionQuery.data;
  const versionLoadError = versionQuery.isError && isViewingPastVersion;

  const { viewTitle, viewBody, isReadOnly } = useMemo(() => {
    if (isViewingPastVersion && versionContent && !versionQuery.isError) {
      const parsed = parsePlanContent(versionContent.content ?? "");
      return {
        viewTitle:
          (versionContent.title ?? parsed.title) || formatPlanIdAsTitle(plan.metadata.planId),
        viewBody: (parsed.body ?? "").trim() || "_No content yet_",
        isReadOnly: true,
      };
    }
    return {
      viewTitle: displayTitle,
      viewBody: (body ?? "").trim() || "_No content yet_",
      isReadOnly: false,
    };
  }, [
    isViewingPastVersion,
    versionContent,
    versionQuery.isError,
    plan.metadata.planId,
    displayTitle,
    body,
  ]);

  const [titleValue, setTitleValue] = useState(displayTitle);
  const [savedRecently, setSavedRecently] = useState(false);
  const prevSavingRef = useRef(saving);

  // Show "Saved" briefly when save completes
  useEffect(() => {
    if (prevSavingRef.current && !saving) {
      setSavedRecently(true);
      const t = setTimeout(() => setSavedRecently(false), 2000);
      return () => clearTimeout(t);
    }
    prevSavingRef.current = saving;
  }, [saving]);
  const titleDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastBodyRef = useRef(body);
  const titleValueRef = useRef(titleValue);
  const saveTitleRef = useRef<(t: string) => void>(() => {});
  lastBodyRef.current = body;
  titleValueRef.current = titleValue;

  // Sync title from props when plan changes (e.g. after fetch)
  useEffect(() => {
    const { title: t } = parsePlanContent(plan.content ?? "");
    setTitleValue(t || formatPlanIdAsTitle(plan.metadata.planId));
  }, [plan.metadata.planId, plan.content]);

  const saveTitle = useCallback(
    (newTitle: string) => {
      const trimmed = newTitle.trim();
      const effectiveTitle = trimmed || formatPlanIdAsTitle(plan.metadata.planId);
      const newContent = serializePlanContent(effectiveTitle, body || lastBodyRef.current);
      if (newContent !== (plan.content ?? "")) {
        onContentSave(newContent);
      }
    },
    [body, plan.content, plan.metadata.planId, onContentSave]
  );

  saveTitleRef.current = saveTitle;

  // Flush pending title save on unmount only (navigate away before debounce fires)
  useEffect(() => {
    return () => {
      if (titleDebounceRef.current) {
        clearTimeout(titleDebounceRef.current);
        titleDebounceRef.current = null;
      }
      saveTitleRef.current(titleValueRef.current);
    };
  }, []);

  const handleTitleBlur = useCallback(() => {
    if (titleDebounceRef.current) {
      clearTimeout(titleDebounceRef.current);
      titleDebounceRef.current = null;
    }
    saveTitle(titleValue);
  }, [titleValue, saveTitle]);

  const handleTitleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      setTitleValue(v);
      if (titleDebounceRef.current) clearTimeout(titleDebounceRef.current);
      titleDebounceRef.current = setTimeout(() => saveTitle(v), DEBOUNCE_MS);
    },
    [saveTitle]
  );

  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    }
  }, []);

  const sections = useMemo(
    () => parsePlanBodySections(viewBody === "_No content yet_" ? "" : viewBody),
    [viewBody]
  );

  /** When structured mockups exist in metadata, hide the markdown "Mockup(s)" section to avoid duplicate sections. */
  const sectionsToRender = useMemo(() => {
    const hasStructuredMockups = plan.metadata.mockups && plan.metadata.mockups.length > 0;
    if (!hasStructuredMockups) return sections.map((s, i) => ({ section: s, originalIndex: i }));
    return sections
      .map((s, i) => ({ section: s, originalIndex: i }))
      .filter(({ section: s }) => {
        const t = s.title.trim().toLowerCase();
        return t !== "mockup" && t !== "mockups";
      });
  }, [sections, plan.metadata.mockups]);

  const [sectionExpanded, setSectionExpanded] = useState<Record<number, boolean>>(() => ({}));
  const setSectionExpandedAt = useCallback((index: number, expanded: boolean) => {
    setSectionExpanded((prev) => ({ ...prev, [index]: expanded }));
  }, []);

  const handleSectionSave = useCallback(
    (sectionIndex: number, newSectionContent: string) => {
      const updated = sections.map((s, i) =>
        i === sectionIndex ? { ...s, content: newSectionContent } : s
      );
      const newBody = serializePlanBodySections(updated);
      lastBodyRef.current = newBody;
      const fullContent = serializePlanContent(titleValue || displayTitle, newBody);
      if (fullContent !== (plan.content ?? "")) {
        onContentSave(fullContent);
      }
    },
    [sections, titleValue, displayTitle, plan.content, onContentSave]
  );

  const header = (
    <div className="flex flex-col gap-2 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          {isReadOnly ? (
            <h2
              className="font-semibold text-theme-text px-2 py-1"
              data-testid="plan-viewing-title"
            >
              {viewTitle}
            </h2>
          ) : (
            <>
              <input
                type="text"
                value={titleValue}
                onChange={handleTitleChange}
                onBlur={handleTitleBlur}
                onKeyDown={handleTitleKeyDown}
                className="w-full font-semibold text-theme-text bg-transparent border border-transparent rounded px-2 py-1 -ml-2 hover:border-theme-border focus:outline-none focus-visible:border-theme-info-border focus-visible:ring-2 focus-visible:ring-theme-info-border/30 transition-colors"
                placeholder="Title"
                aria-label="Title"
              />
              {(saving || savedRecently) && (
                <span className="text-xs text-theme-muted" aria-live="polite">
                  {saving ? "Saving..." : "Saved"}
                </span>
              )}
            </>
          )}
        </div>
        {headerActions && !isReadOnly && (
          <div className="shrink-0 flex items-center gap-2">{headerActions}</div>
        )}
      </div>
      {showVersionSelector && (
        <div className="flex items-center gap-2 flex-wrap" data-testid="plan-version-selector">
          <span className="text-xs text-theme-muted shrink-0">Version:</span>
          {isViewingPastVersion && (
            <button
              type="button"
              onClick={() => onVersionSelect?.(null)}
              className="text-xs text-theme-info hover:underline shrink-0"
              data-testid="plan-back-to-current"
            >
              Back to current
            </button>
          )}
          {versions.length > 0 && (
            <select
              data-testid="plan-version-dropdown"
              aria-label="Select plan version"
              value={effectiveSelectedVersion}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) onVersionSelect?.(n);
              }}
              className="text-xs bg-theme-surface border border-theme-border rounded px-2 py-1 text-theme-text min-w-0 max-w-[8rem]"
            >
              {versions.map((v) => {
                const num = v.version_number ?? 0;
                const isExecuted =
                  num === lastExecuted ||
                  (v as { is_executed_version?: boolean }).is_executed_version;
                const label = isExecuted ? `v${num} (Executed)` : `v${num}`;
                return (
                  <option key={v.id ?? num} value={num}>
                    {label}
                  </option>
                );
              })}
            </select>
          )}
        </div>
      )}
    </div>
  );

  const bodySlot = (
    <div>
      {versionLoadError && (
        <div
          className="mb-3 mx-4 px-3 py-2 rounded-lg border border-theme-error-border bg-theme-error-bg/50 text-theme-error-text text-sm"
          data-testid="plan-version-not-found"
          role="alert"
        >
          Version not found. Showing current version.
        </div>
      )}
      {isViewingPastVersion && versionQuery.isLoading ? (
        <div className="p-4 text-theme-muted text-sm py-2" data-testid="plan-version-loading">
          Loading version…
        </div>
      ) : (
        sectionsToRender.map(({ section, originalIndex }) => (
          <CollapsibleSection
            key={`${section.title}-${originalIndex}`}
            title={section.title}
            expanded={sectionExpanded[originalIndex] ?? true}
            onToggle={() =>
              setSectionExpandedAt(originalIndex, !(sectionExpanded[originalIndex] ?? true))
            }
            expandAriaLabel={`Expand ${section.title}`}
            collapseAriaLabel={`Collapse ${section.title}`}
            contentId={`plan-section-${originalIndex}-content`}
            headerId={`plan-section-${originalIndex}-header`}
            contentClassName="p-4 pt-0"
          >
            <div
              data-testid="plan-markdown-editor"
              className="prose prose-sm max-w-none text-theme-text text-xs [&>div>:first-child]:!mt-0"
            >
              <PrdSectionEditor
                sectionKey={`plan-section-${originalIndex}`}
                markdown={section.content || "_No content yet_"}
                onSave={(_key, md) =>
                  handleSectionSave(originalIndex, !md || md === "_No content yet_" ? "" : md)
                }
                disabled={isReadOnly}
                lightMode
              />
            </div>
          </CollapsibleSection>
        ))
      )}
    </div>
  );

  if (renderSlots) {
    return <>{renderSlots({ header, body: bodySlot })}</>;
  }

  return (
    <div className="shrink-0">
      {header}
      {bodySlot}
    </div>
  );
}
