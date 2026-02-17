import { useState, useCallback, useRef, useEffect } from "react";
import type { Plan } from "@opensprint/shared";
import { formatPlanIdAsTitle } from "../../lib/formatting";
import { parsePlanContent, serializePlanContent } from "../../lib/planContentUtils";
import { PrdSectionEditor } from "../prd/PrdSectionEditor";

const DEBOUNCE_MS = 600;

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
  const titleDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastBodyRef = useRef(body);
  lastBodyRef.current = body;

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
            disabled={saving}
            className="w-full font-semibold text-gray-900 bg-transparent border border-transparent rounded px-2 py-1 -ml-2 hover:border-gray-200 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 outline-none transition-colors disabled:opacity-50"
            placeholder="Title"
            aria-label="Title"
          />
          {saving && (
            <span className="text-xs text-gray-500" aria-live="polite">
              Saving...
            </span>
          )}
        </div>
        {headerActions && <div className="shrink-0 flex items-center gap-2">{headerActions}</div>}
      </div>
      {/* Inline editable markdown body — light mode styles only */}
      <div className="px-4 pb-4">
        <div
          data-testid="plan-markdown-editor"
          className="prose prose-sm max-w-none bg-white p-4 rounded-lg border border-gray-200 text-gray-900 text-xs"
        >
          <PrdSectionEditor
            sectionKey="plan-body"
            markdown={bodyMarkdown}
            onSave={handleBodySave}
            disabled={saving}
            lightMode
          />
        </div>
      </div>
    </div>
  );
}
