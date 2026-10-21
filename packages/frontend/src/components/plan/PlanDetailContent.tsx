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

const PARENT_SUBPLANS_SIDEBAR_COPY = "Sub-plans created — generate tasks on each sub-plan";

const PLAN_TOO_LARGE_SIDEBAR_COPY =
  "This plan may be too large for a single batch — consider narrowing scope in the SPEC";

/** Optional Plan-phase task CTAs and empty states in the detail header (sidebar). */
export interface PlanDetailPlanTasksHint {
  showTooLarge?: boolean;
  blockedBy?: { planId: string; title: string }[];
  showParentDelegateSubplans?: boolean;
  showAllSubplansHaveTasks?: boolean;
  showProminentGenerateTasks?: boolean;
}

export interface PlanDetailContentProps {
  plan: Plan;
  onContentSave: (content: string, expectedRevision?: number) => void | Promise<number | void>;
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
  /** External command to expand/collapse all plan body sections. */
  sectionExpansionCommand?: { mode: "expand" | "collapse"; token: number } | null;
  /** Parent plan for hierarchy breadcrumb (sub-plan detail sidebar). */
  parentPlanNav?: { planId: string; title: string } | null;
  /** Immediate child plans for hierarchy navigation. */
  childPlansNav?: { planId: string; title: string }[];
  /** Select another plan from hierarchy links (parent / sub-plans). */
  onSelectHierarchyPlan?: (planId: string) => void;
  /** Task-generation empty states / CTAs above the plan body. */
  planTasksHint?: PlanDetailPlanTasksHint | null;
  onPlanTasksHintGenerate?: () => void;
  onPlanTasksHintSelectPlan?: (planId: string) => void;
  /** When true, disable the prominent Generate Tasks control (e.g. generation in flight). */
  planTasksHintGenerateDisabled?: boolean;
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
  sectionExpansionCommand = null,
  parentPlanNav = null,
  childPlansNav = [],
  onSelectHierarchyPlan,
  planTasksHint = null,
  onPlanTasksHintGenerate,
  onPlanTasksHintSelectPlan,
  planTasksHintGenerateDisabled = false,
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
  const titleRevision = useRef<number | undefined>(undefined);
  const lastBodyRef = useRef(body);
  const titleValueRef = useRef(titleValue);
  const saveTitleRef = useRef<(t: string) => void>(() => {});
  lastBodyRef.current = body;
  titleValueRef.current = titleValue;

  // Sync title from props when plan changes (e.g. after fetch)
  useEffect(() => {
    const { title: t } = parsePlanContent(plan.content ?? "");
    if (
      titleRevision.current !== undefined &&
      titleValueRef.current !== (t || formatPlanIdAsTitle(plan.metadata.planId))
    )
      return;
    setTitleValue(t || formatPlanIdAsTitle(plan.metadata.planId));
  }, [plan.metadata.planId, plan.content]);

  const saveTitle = useCallback(
    (newTitle: string) => {
      const trimmed = newTitle.trim();
      const effectiveTitle = trimmed || formatPlanIdAsTitle(plan.metadata.planId);
      const newContent = serializePlanContent(effectiveTitle, body || lastBodyRef.current);
      if (newContent !== (plan.content ?? "")) {
        const expected = titleRevision.current ?? plan.revision;
        const result =
          expected === undefined ? onContentSave(newContent) : onContentSave(newContent, expected);
        if (result)
          void result.then((revision) => {
            if (typeof revision === "number") titleRevision.current = revision;
          });
      }
    },
    [body, plan.content, plan.metadata.planId, plan.revision, onContentSave]
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
      if (titleRevision.current === undefined) titleRevision.current = plan.revision;
      setTitleValue(v);
      if (titleDebounceRef.current) clearTimeout(titleDebounceRef.current);
      titleDebounceRef.current = setTimeout(() => saveTitle(v), DEBOUNCE_MS);
    },
    [saveTitle, plan.revision]
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
    (sectionIndex: number, newSectionContent: string, expectedRevision?: number) => {
      const updated = sections.map((s, i) =>
        i === sectionIndex ? { ...s, content: newSectionContent } : s
      );
      const newBody = serializePlanBodySections(updated);
      lastBodyRef.current = newBody;
      const fullContent = serializePlanContent(titleValue || displayTitle, newBody);
      if (fullContent !== (plan.content ?? "")) {
        const expected = expectedRevision ?? plan.revision;
        return expected === undefined
          ? onContentSave(fullContent)
          : onContentSave(fullContent, expected);
      }
    },
    [sections, titleValue, displayTitle, plan.content, plan.revision, onContentSave]
  );

  const lastSectionCommandTokenRef = useRef<number | null>(null);
  useEffect(() => {
    if (!sectionExpansionCommand) return;
    if (lastSectionCommandTokenRef.current === sectionExpansionCommand.token) return;
    lastSectionCommandTokenRef.current = sectionExpansionCommand.token;
    const expanded = sectionExpansionCommand.mode === "expand";
    const next: Record<number, boolean> = {};
    for (const { originalIndex } of sectionsToRender) {
      next[originalIndex] = expanded;
    }
    setSectionExpanded(next);
  }, [sectionExpansionCommand, sectionsToRender]);

  const header = (
    <div className="flex flex-col gap-2 p-4">
      {parentPlanNav && onSelectHierarchyPlan && (
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => onSelectHierarchyPlan(parentPlanNav.planId)}
            className="text-left text-sm text-brand-600 hover:underline"
            data-testid="plan-detail-parent-link"
          >
            Parent: {parentPlanNav.title}
          </button>
        </div>
      )}
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
        <div className="shrink-0 flex items-center gap-2 flex-wrap justify-end">
          {showVersionSelector && (
            <>
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
            </>
          )}
          {headerActions && <div className="shrink-0 flex items-center gap-2">{headerActions}</div>}
        </div>
      </div>
      {childPlansNav.length > 0 && onSelectHierarchyPlan && (
        <div
          className="rounded-lg border border-theme-border-subtle bg-theme-surface-muted/40 px-3 py-2"
          data-testid="plan-detail-sub-plans"
        >
          <p className="text-xs font-medium text-theme-muted mb-1.5">
            Sub-plans ({childPlansNav.length})
          </p>
          <ul className="space-y-1">
            {childPlansNav.map((c) => (
              <li key={c.planId}>
                <button
                  type="button"
                  onClick={() => onSelectHierarchyPlan(c.planId)}
                  className="text-left text-sm text-brand-600 hover:underline w-full truncate"
                  title={c.title}
                  data-testid={`plan-detail-child-link-${c.planId}`}
                >
                  {c.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {planTasksHint && (
        <div className="px-4 space-y-2" data-testid="plan-detail-tasks-hint">
          {planTasksHint.showTooLarge && (
            <p
              className="text-sm text-theme-warning-text rounded-lg border border-theme-warning-border bg-theme-warning-bg/30 px-3 py-2"
              data-testid="plan-detail-too-large"
              role="alert"
            >
              {PLAN_TOO_LARGE_SIDEBAR_COPY}
            </p>
          )}
          {planTasksHint.blockedBy && planTasksHint.blockedBy.length > 0 && (
            <p className="text-sm text-theme-muted" data-testid="plan-detail-blocked-by">
              <span className="font-medium text-theme-text">Blocked by:</span>{" "}
              {planTasksHint.blockedBy.map((b, i) => (
                <span key={b.planId}>
                  {i > 0 ? ", " : ""}
                  {onPlanTasksHintSelectPlan ? (
                    <button
                      type="button"
                      className="text-brand-600 hover:underline font-medium"
                      data-testid={`plan-detail-blocker-link-${b.planId}`}
                      onClick={() => onPlanTasksHintSelectPlan(b.planId)}
                    >
                      {b.title}
                    </button>
                  ) : (
                    <span className="font-medium text-theme-text">{b.title}</span>
                  )}
                </span>
              ))}
            </p>
          )}
          {planTasksHint.showParentDelegateSubplans && (
            <p
              className="text-sm text-theme-muted"
              data-testid="plan-detail-parent-delegate"
              role="status"
            >
              {PARENT_SUBPLANS_SIDEBAR_COPY}
            </p>
          )}
          {planTasksHint.showProminentGenerateTasks && onPlanTasksHintGenerate && (
            <button
              type="button"
              onClick={onPlanTasksHintGenerate}
              disabled={planTasksHintGenerateDisabled}
              className="w-full text-sm font-semibold text-white bg-brand-600 hover:bg-brand-700 dark:bg-brand-500 dark:hover:bg-brand-600 px-4 py-2.5 rounded-lg shadow-sm transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              data-testid="plan-detail-generate-tasks-prominent"
            >
              Generate tasks
            </button>
          )}
          {planTasksHint.showAllSubplansHaveTasks && (
            <p
              className="text-sm font-medium text-theme-success-text inline-flex items-center gap-1.5"
              data-testid="plan-detail-all-subplans-tasks"
              role="status"
            >
              <span aria-hidden>✓</span>
              All sub-plans have tasks
            </p>
          )}
        </div>
      )}
      {showVersionSelector && <div data-testid="plan-version-selector" className="sr-only" />}
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
            sectionNavId={`plan-body-section-${originalIndex}`}
            sectionNavTitle={section.title}
          >
            <div
              data-testid="plan-markdown-editor"
              className="prose prose-sm max-w-none text-theme-text text-xs [&>div>:first-child]:!mt-0"
            >
              <PrdSectionEditor
                sectionKey={`plan-section-${originalIndex}`}
                markdown={section.content || "_No content yet_"}
                revision={plan.revision}
                onSave={(_key, md, expectedRevision) =>
                  handleSectionSave(
                    originalIndex,
                    !md || md === "_No content yet_" ? "" : md,
                    expectedRevision
                  )
                }
                disabled={isReadOnly}
                lightMode
                diagrams="mermaid"
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

export {
  PLAN_TASK_BATCH_MAX,
  PLAN_TASK_BATCH_CAP_TOOLTIP,
  formatPlanTasksSidebarSectionTitle,
} from "./planTaskBatchCap";
