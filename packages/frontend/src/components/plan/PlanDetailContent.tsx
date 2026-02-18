import { useState, useCallback, useRef, useEffect } from "react";
import type { Plan } from "@opensprint/shared";
import { formatPlanIdAsTitle } from "../../lib/formatting";
import { parsePlanContent, serializePlanContent } from "../../lib/planContentUtils";
import { PrdSectionEditor } from "../prd/PrdSectionEditor";

/** Matches PrdSectionEditor / Sketch phase debounce for consistency */
const DEBOUNCE_MS = 800;

export interface PlanDetailContentProps {
  plan: Plan;
  onContentSave: (content: string) => void;
  saving?: boolean;
  /** Optional actions to render in the header row next to the title (e.g. archive, close buttons) */
  headerActions?: React.ReactNode;
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
}: PlanDetailContentProps) {
  const { title, body } = parsePlanContent(plan.content ?? "");
  const displayTitle = title || formatPlanIdAsTitle(plan.metadata.planId);

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
    [body, plan.content, plan.metadata.planId, onContentSave],
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
    [saveTitle],
  );

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        (e.target as HTMLInputElement).blur();
      }
    },
    [],
  );

  const handleBodySave = useCallback(
    (sectionKey: string, newBody: string) => {
      lastBodyRef.current = newBody;
      const newContent = serializePlanContent(titleValue || displayTitle, newBody);
      if (newContent !== (plan.content ?? "")) {
        onContentSave(newContent);
      }
    },
    [titleValue, displayTitle, plan.content, onContentSave],
  );

  const bodyMarkdown = body || "_No content yet_";

  return (
    <div className="shrink-0">
      {/* Header row: title aligned to top, dark font, no HR */}
      <div className="flex items-start justify-between gap-4 p-4">
        <div className="min-w-0 flex-1 space-y-1">
          <input
            type="text"
            value={titleValue}
            onChange={handleTitleChange}
            onBlur={handleTitleBlur}
            onKeyDown={handleTitleKeyDown}
            className="w-full font-semibold text-theme-text bg-transparent border border-transparent rounded px-2 py-1 -ml-2 hover:border-theme-border focus:border-theme-info-border focus:ring-2 focus:ring-theme-info-border/30 outline-none transition-colors"
            placeholder="Title"
            aria-label="Title"
          />
          {(saving || savedRecently) && (
            <span className="text-xs text-theme-muted" aria-live="polite">
              {saving ? "Saving..." : "Saved"}
            </span>
          )}
        </div>
        {headerActions && <div className="shrink-0 flex items-center gap-2">{headerActions}</div>}
      </div>
      {/* Inline editable markdown body — light mode styles only */}
      <div className="px-4 pb-4">
        <div
          data-testid="plan-markdown-editor"
          className="prose prose-sm max-w-none bg-theme-surface p-4 rounded-lg border border-theme-border text-theme-text text-xs"
        >
          <PrdSectionEditor
            sectionKey="plan-body"
            markdown={bodyMarkdown}
            onSave={handleBodySave}
            lightMode
          />
        </div>
      </div>
    </div>
  );
}
