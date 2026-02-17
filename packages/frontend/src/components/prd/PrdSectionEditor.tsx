import { useRef, useEffect, useCallback } from "react";
import { markdownToHtml, htmlToMarkdown } from "../../lib/markdownUtils";

const DEBOUNCE_MS = 800;

export interface PrdSectionEditorProps {
  sectionKey: string;
  markdown: string;
  onSave: (section: string, markdown: string) => void;
  disabled?: boolean;
  /** Ref for selection toolbar (findParentSection) */
  "data-prd-section"?: string;
}

/**
 * Inline WYSIWYG editor for a single PRD section.
 * Uses contenteditable with native Ctrl+B, Ctrl+I etc.
 * Debounced autosave; serializes to markdown before API save.
 */
export function PrdSectionEditor({
  sectionKey,
  markdown,
  onSave,
  disabled = false,
  ...rest
}: PrdSectionEditorProps) {
  const elRef = useRef<HTMLDivElement>(null);
  const lastMarkdownRef = useRef(markdown);
  const isInternalUpdateRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pendingHtmlRef = useRef<string | null>(null);

  const flushDebounce = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    // Flush pending save on unmount so edits persist when navigating away
    const html = pendingHtmlRef.current;
    pendingHtmlRef.current = null;
    if (html != null && !disabled) {
      let md = htmlToMarkdown(html);
      if (!md.trim() || md.trim() === "_No content yet_") md = "";
      if (md !== lastMarkdownRef.current) {
        lastMarkdownRef.current = md;
        onSave(sectionKey, md);
      }
    }
  }, [sectionKey, onSave, disabled]);

  const scheduleSave = useCallback(
    (html: string) => {
      flushDebounce();
      pendingHtmlRef.current = html;
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        pendingHtmlRef.current = null;
        let md = htmlToMarkdown(html);
        // Normalize empty/placeholder to empty string
        if (!md.trim() || md.trim() === "_No content yet_") md = "";
        if (md !== lastMarkdownRef.current) {
          lastMarkdownRef.current = md;
          onSave(sectionKey, md);
        }
      }, DEBOUNCE_MS);
    },
    [sectionKey, onSave, flushDebounce],
  );

  const handleInput = useCallback(() => {
    if (disabled || !elRef.current || isInternalUpdateRef.current) return;
    const html = elRef.current.innerHTML;
    scheduleSave(html);
  }, [disabled, scheduleSave]);

  // Sync markdown from props (initial + external updates e.g. after API save).
  // Skip sync when this section has focus — avoids WebSocket prd.updated overwriting in-progress edits.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    if (markdown === lastMarkdownRef.current) return;
    if (el.contains(document.activeElement)) return;
    lastMarkdownRef.current = markdown;
    const content = markdown.trim() ? markdown : "_No content yet_";
    markdownToHtml(content).then((html) => {
      if (!elRef.current) return;
      if (elRef.current.contains(document.activeElement)) return;
      isInternalUpdateRef.current = true;
      elRef.current.innerHTML = html || "<p><br></p>";
      isInternalUpdateRef.current = false;
    });
    return flushDebounce;
  }, [sectionKey, markdown, flushDebounce]);

  return (
    <div
      ref={elRef}
      contentEditable={!disabled}
      suppressContentEditableWarning
      onInput={handleInput}
      data-prd-section={sectionKey}
      className="prose prose-gray max-w-none prose-headings:text-gray-800 prose-p:text-gray-700 prose-li:text-gray-700 prose-td:text-gray-700 prose-th:text-gray-700 prose-a:text-brand-600 selection:bg-brand-100 min-h-[120px] p-4 rounded-lg border border-transparent hover:border-gray-200 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 outline-none transition-colors empty:before:content-[attr(data-placeholder)] empty:before:text-gray-400"
      data-placeholder="Start typing..."
      {...rest}
    />
  );
}
