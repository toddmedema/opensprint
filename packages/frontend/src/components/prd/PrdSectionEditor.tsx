import React, { useRef, useEffect, useCallback } from "react";
import { markdownToHtml, htmlToMarkdown } from "../../lib/markdownUtils";

const DEBOUNCE_MS = 800;

export interface PrdSectionEditorProps {
  sectionKey: string;
  markdown: string;
  onSave: (section: string, markdown: string) => void;
  disabled?: boolean;
  /** When true, use light mode styles only (no dark: variants). Used in plan details. */
  lightMode?: boolean;
  /** Ref for selection toolbar (findParentSection) */
  "data-prd-section"?: string;
}

/**
 * Inline WYSIWYG editor for a single PRD section.
 * Uses contenteditable with native Ctrl+B, Ctrl+I etc.
 * Debounced autosave; serializes to markdown before API save.
 */
const THEME_AWARE_CLASSES =
  "prose prose-gray dark:prose-invert max-w-none text-theme-text prose-headings:text-theme-text prose-p:text-theme-text prose-li:text-theme-text prose-td:text-theme-text prose-th:text-theme-text prose-a:text-brand-600 dark:prose-a:text-brand-400 prose-code:text-theme-text prose-strong:text-theme-text prose-blockquote:text-theme-text selection:bg-brand-100 dark:selection:bg-brand-900/40 outline-none empty:before:content-[attr(data-placeholder)] empty:before:text-theme-muted";

const LIGHT_MODE_CLASSES =
  "prose prose-gray max-w-none text-theme-text prose-headings:text-theme-text prose-p:text-theme-text prose-li:text-theme-text prose-td:text-theme-text prose-th:text-theme-text prose-a:text-brand-600 prose-code:text-theme-text prose-strong:text-theme-text prose-blockquote:text-theme-text selection:bg-brand-100 outline-none empty:before:content-[attr(data-placeholder)] empty:before:text-theme-muted";

export function PrdSectionEditor({
  sectionKey,
  markdown,
  onSave,
  disabled = false,
  lightMode = false,
  ...rest
}: PrdSectionEditorProps) {
  const elRef = useRef<HTMLDivElement>(null);
  // Initialize with null sentinel so the sync effect always runs on first mount,
  // even when the component mounts with content already loaded from Redux.
  const lastMarkdownRef = useRef<string | null>(null);
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
      // Clear existing timer only — do NOT flush pending (that would save on every keystroke)
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
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
    [sectionKey, onSave]
  );

  const handleInput = useCallback(() => {
    if (disabled || !elRef.current || isInternalUpdateRef.current) return;
    const html = elRef.current.innerHTML;
    scheduleSave(html);
  }, [disabled, scheduleSave]);

  // Sync markdown from props (initial + external updates e.g. after API save).
  // Skip sync when this section has focus — avoids WebSocket prd.updated overwriting in-progress edits.
  // Skip sync when we have pending unsaved changes — avoids overwriting user edits with stale content.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    if (markdown === lastMarkdownRef.current) return;
    if (el.contains(document.activeElement)) return;
    if (pendingHtmlRef.current != null) return;
    lastMarkdownRef.current = markdown;
    const content = markdown.trim() ? markdown : "_No content yet_";
    markdownToHtml(content).then((html) => {
      if (!elRef.current) return;
      if (elRef.current.contains(document.activeElement)) return;
      if (pendingHtmlRef.current != null) return;
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
      onBlur={flushDebounce}
      data-prd-section={sectionKey}
      className={lightMode ? LIGHT_MODE_CLASSES : THEME_AWARE_CLASSES}
      data-placeholder="Start typing..."
      {...rest}
    />
  );
}
