import React, { useRef, useEffect, useCallback, useMemo } from "react";
import { markdownToHtml, htmlToMarkdown, type DiagramsMode } from "../../lib/markdownUtils";
import { renderMermaidDiagrams } from "../../lib/mermaidDiagram";
import { useOptionalResolvedTheme } from "../../contexts/ThemeContext";
import { registerPrdFlush } from "../../lib/prdFlushRegistry";

const DEBOUNCE_MS = 800;

export interface PrdSectionEditorProps {
  sectionKey: string;
  markdown: string;
  onSave: (
    section: string,
    markdown: string,
    expectedRevision?: number
  ) => void | Promise<number | void>;
  revision?: number;
  disabled?: boolean;
  /** When true, skip prose dark: variants (plan embed). Selection still uses dark highlight so text stays readable. */
  lightMode?: boolean;
  /** When "mermaid", fenced mermaid blocks render as diagrams (app theme). */
  diagrams?: DiagramsMode;
  /** Ref for selection toolbar (findParentSection) */
  "data-prd-section"?: string;
}

/**
 * Inline WYSIWYG editor for a single PRD section.
 * Uses contenteditable with native Ctrl+B, Ctrl+I etc.
 * Debounced autosave; serializes to markdown before API save.
 */
const THEME_AWARE_CLASSES =
  "prose prose-gray dark:prose-invert max-w-none text-theme-text prose-headings:text-theme-text prose-p:text-theme-text prose-li:text-theme-text prose-td:text-theme-text prose-th:text-theme-text prose-a:text-brand-600 dark:prose-a:text-brand-400 prose-code:text-theme-text prose-strong:text-theme-text prose-blockquote:text-theme-text selection:bg-brand-100 dark:selection:bg-brand-900/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-theme-ring focus-visible:ring-inset rounded empty:before:content-[attr(data-placeholder)] empty:before:text-theme-muted";

const LIGHT_MODE_CLASSES =
  "prose prose-gray max-w-none text-theme-text prose-headings:text-theme-text prose-p:text-theme-text prose-li:text-theme-text prose-td:text-theme-text prose-th:text-theme-text prose-a:text-brand-600 prose-code:text-theme-text prose-strong:text-theme-text prose-blockquote:text-theme-text selection:bg-brand-100 dark:selection:bg-brand-900/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-theme-ring focus-visible:ring-inset rounded empty:before:content-[attr(data-placeholder)] empty:before:text-theme-muted [&>:first-child]:!mt-0";

export function PrdSectionEditor({
  sectionKey,
  markdown,
  onSave,
  revision,
  disabled = false,
  lightMode = false,
  diagrams = "none",
  ...rest
}: PrdSectionEditorProps) {
  const elRef = useRef<HTMLDivElement>(null);
  const resolved = useOptionalResolvedTheme();
  // Initialize with null sentinel so the sync effect always runs on first mount,
  // even when the component mounts with content already loaded from Redux.
  const lastMarkdownRef = useRef<string | null>(null);
  const isInternalUpdateRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pendingHtmlRef = useRef<string | null>(null);
  const editRevision = useRef<number | undefined>(undefined);
  const persist = useCallback(
    (md: string) => {
      const expected = editRevision.current ?? revision;
      const result =
        expected === undefined ? onSave(sectionKey, md) : onSave(sectionKey, md, expected);
      if (result)
        void result.then((nextRevision) => {
          if (typeof nextRevision === "number") editRevision.current = nextRevision;
        });
    },
    [onSave, sectionKey, revision]
  );

  const mdOpts = useMemo(
    () => (diagrams === "mermaid" ? ({ diagrams: "mermaid" } as const) : undefined),
    [diagrams]
  );

  const flushDebounce = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    // Flush pending save on unmount so edits persist when navigating away
    const html = pendingHtmlRef.current;
    pendingHtmlRef.current = null;
    if (html != null && !disabled) {
      let md = htmlToMarkdown(html, mdOpts);
      if (!md.trim() || md.trim() === "_No content yet_") md = "";
      if (md !== lastMarkdownRef.current) {
        lastMarkdownRef.current = md;
        persist(md);
      }
    }
  }, [disabled, mdOpts, persist]);

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
        let md = htmlToMarkdown(html, mdOpts);
        // Normalize empty/placeholder to empty string
        if (!md.trim() || md.trim() === "_No content yet_") md = "";
        if (md !== lastMarkdownRef.current) {
          lastMarkdownRef.current = md;
          persist(md);
        }
      }, DEBOUNCE_MS);
    },
    [mdOpts, persist]
  );

  const handleInput = useCallback(() => {
    if (disabled || !elRef.current || isInternalUpdateRef.current) return;
    if (editRevision.current === undefined) editRevision.current = revision;
    const html = elRef.current.innerHTML;
    scheduleSave(html);
  }, [disabled, scheduleSave, revision]);

  // Register flush for beforeunload so pending edits persist on refresh/close
  useEffect(() => {
    return registerPrdFlush(flushDebounce);
  }, [flushDebounce]);

  // Re-render Mermaid when app theme changes (mounts already in DOM).
  useEffect(() => {
    if (diagrams !== "mermaid") return;
    const el = elRef.current;
    if (!el) return;
    void renderMermaidDiagrams(el, resolved);
  }, [diagrams, resolved]);

  // Sync markdown from props (initial + external updates e.g. after API save).
  // Skip sync when this section has focus — avoids WebSocket prd.updated overwriting in-progress edits.
  // Skip sync when we have pending unsaved changes — avoids overwriting user edits with stale content.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    if (markdown === lastMarkdownRef.current) return;
    if (el.contains(document.activeElement)) return;
    if (pendingHtmlRef.current != null) return;
    editRevision.current = undefined;
    lastMarkdownRef.current = markdown;
    const content = markdown.trim() ? markdown.trim() : "_No content yet_";
    markdownToHtml(content, mdOpts).then((html) => {
      if (!elRef.current) return;
      if (elRef.current.contains(document.activeElement)) return;
      if (pendingHtmlRef.current != null) return;
      isInternalUpdateRef.current = true;
      elRef.current.innerHTML = html || "<p><br></p>";
      isInternalUpdateRef.current = false;
      if (diagrams === "mermaid") {
        void renderMermaidDiagrams(elRef.current, resolved);
      }
    });
    return flushDebounce;
  }, [sectionKey, markdown, flushDebounce, mdOpts, diagrams, resolved]);

  // Flush pending save when page is about to hide (refresh, navigate away, close tab).
  // Gives a chance to persist edits before unload; request may be aborted but often completes.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushDebounce();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [flushDebounce]);

  return (
    <div
      ref={elRef}
      role="textbox"
      contentEditable={!disabled}
      suppressContentEditableWarning
      tabIndex={0}
      onInput={handleInput}
      onBlur={flushDebounce}
      data-prd-section={sectionKey}
      className={lightMode ? LIGHT_MODE_CLASSES : THEME_AWARE_CLASSES}
      data-placeholder="Start typing..."
      {...rest}
    />
  );
}
