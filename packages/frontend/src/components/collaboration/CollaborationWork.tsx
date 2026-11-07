import { useRef, useState } from "react";
import type { CollaborationContext, CollaborationTaskContext } from "@opensprint/shared";

/** Map a visible text selection back to the displayed patch, never to a filesystem read. */
function selectionContext(
  text: string,
  offset: number
): Pick<CollaborationContext, "path" | "line"> & { removed?: boolean } {
  let before: string | undefined;
  let after: string | undefined;
  let oldLine: number | undefined;
  let newLine: number | undefined;
  let inHunk = false;
  const rows = text.slice(0, offset).split("\n");
  rows.pop();
  for (const row of rows) {
    if (row.startsWith("diff --git ")) {
      const paths = /^diff --git a\/(\S+) b\/(\S+)$/.exec(row);
      before = paths?.[1];
      after = paths?.[2];
      oldLine = newLine = undefined;
      inHunk = false;
    } else if (!inHunk && row.startsWith("--- ")) {
      before = row.startsWith("--- a/") ? row.slice(6) : undefined;
    } else if (!inHunk && row.startsWith("+++ ")) {
      after = row.startsWith("+++ b/") ? row.slice(6) : undefined;
    } else if (row.startsWith("@@ ")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(row);
      oldLine = match ? Number(match[1]) : undefined;
      newLine = match ? Number(match[2]) : undefined;
      inHunk = Boolean(match);
    } else if (inHunk) {
      if (oldLine !== undefined && (row.startsWith("-") || row.startsWith(" "))) oldLine++;
      if (newLine !== undefined && (row.startsWith("+") || row.startsWith(" "))) newLine++;
    }
  }
  const start = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const end = text.indexOf("\n", start);
  const selectedLine = text.slice(start, end < 0 ? undefined : end);
  const removed = inHunk && selectedLine.startsWith("-");
  const path = removed ? before : (after ?? before);
  const line =
    inHunk && /^[ +-]/.test(selectedLine) ? (removed || !after ? oldLine : newLine) : undefined;
  return { ...(path ? { path } : {}), ...(line ? { line } : {}), ...(removed ? { removed } : {}) };
}

/** Scoped work preview for guests and contextual host inspection. */
export function CollaborationWork({
  context,
  loading,
  mayDiscuss,
  onDiscuss,
}: {
  context?: CollaborationTaskContext;
  loading: boolean;
  mayDiscuss: boolean;
  onDiscuss: (source: CollaborationContext) => void;
}) {
  const patch = useRef<HTMLPreElement>(null);
  const [selection, setSelection] = useState<CollaborationContext | null>(null);
  const source = (label: string): CollaborationContext => ({
    kind: "diff",
    label,
    ...(context?.sourceAttemptId ? { attemptId: context.sourceAttemptId } : {}),
    ...(context?.sourceAttempt ? { attempt: context.sourceAttempt } : {}),
    ...(context?.diffRevision ? { diffRevision: context.diffRevision } : {}),
  });
  const selectCode = () => {
    const selected = window.getSelection();
    if (
      !context?.diff ||
      !selected?.toString().trim() ||
      !selected.rangeCount ||
      !patch.current?.contains(selected.anchorNode)
    ) {
      setSelection(null);
      return;
    }
    const selectedRange = selected.getRangeAt(0);
    const range = selectedRange.cloneRange();
    range.selectNodeContents(patch.current);
    range.setEnd(selectedRange.startContainer, selectedRange.startOffset);
    const { removed, ...location } = selectionContext(context.diff, range.toString().length);
    const label = location.path
      ? location.path + (location.line ? ":" + location.line : "") + (removed ? " (removed)" : "")
      : "Selected changes";
    setSelection({ ...source(label), ...location, kind: location.path ? "file" : "diff" });
  };
  if (loading)
    return (
      <p role="status" className="p-4 text-sm text-theme-muted">
        Loading work…
      </p>
    );
  return (
    <div className="space-y-4 p-4">
      {context?.unavailableReason && (
        <p className="text-sm text-theme-muted">{context.unavailableReason}</p>
      )}
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">Changes</h2>
        {mayDiscuss && Boolean(context?.diff) && (
          <button
            type="button"
            className="text-sm text-theme-link underline"
            onClick={() => onDiscuss(source("Task changes"))}
          >
            Comment on changes
          </button>
        )}
      </div>
      <div
        tabIndex={0}
        role="textbox"
        aria-readonly="true"
        aria-multiline="true"
        aria-label="Task diff"
        onMouseUp={selectCode}
        onKeyUp={selectCode}
        className="max-h-[60vh] overflow-auto rounded-lg bg-theme-surface-muted p-3"
      >
        <pre ref={patch} className="whitespace-pre-wrap break-words text-xs">
          {context?.diff || "No shared changes yet."}
        </pre>
      </div>
      {mayDiscuss && selection && (
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            onDiscuss(selection);
            setSelection(null);
          }}
        >
          {"Comment on " + selection.label}
        </button>
      )}
      <details className="text-xs text-theme-muted">
        <summary className="cursor-pointer">About this preview</summary>
        <p className="mt-2">
          Supported new files appear after staging or committing. This filtered preview omits binary
          changes and paths containing spaces.
        </p>
        {context?.diffTruncated && <p className="mt-2">Showing a bounded excerpt.</p>}
      </details>
      <details className="border-t border-theme-border pt-3">
        <summary className="cursor-pointer text-sm font-medium">Agent output</summary>
        <pre
          aria-label="Agent output"
          className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-theme-surface-muted p-3 text-xs"
        >
          {context?.output || "No output available yet."}
        </pre>
        {context?.outputTruncated && (
          <p className="mt-2 text-xs text-theme-muted">Showing a bounded excerpt.</p>
        )}
      </details>
    </div>
  );
}
