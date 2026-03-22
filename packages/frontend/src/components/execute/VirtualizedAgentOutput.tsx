import React, { useMemo, useDeferredValue } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Execute sidebar: no horizontal rules (task feedback x5cqqc) */
const MARKDOWN_NO_HR = { hr: () => null };

const LINES_PER_BLOCK = 30;
/** Initial estimate; virtualizer measures actual height via measureElement (ResizeObserver). */
const ESTIMATED_BLOCK_HEIGHT = 120;

export interface VirtualizedAgentOutputProps {
  /** Full content to display (joined agent output) */
  content: string;
  /** "markdown" renders via ReactMarkdown; "stream" renders plain <pre> text. */
  mode: "stream" | "markdown";
  /** Ref for the scroll container (shared with useAutoScroll) */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Callback when user scrolls (for Jump to bottom detection) */
  onScroll?: () => void;
  /** Base class names for the output area */
  className?: string;
  /** Test id for the scroll container */
  "data-testid"?: string;
}

/**
 * Virtualized agent output: renders only visible portion in DOM.
 * Splits content into blocks of lines; each visible block is rendered
 * (plain text when streaming, ReactMarkdown when stable).
 */
export const VirtualizedAgentOutput = React.memo(function VirtualizedAgentOutput({
  content,
  mode,
  containerRef,
  onScroll,
  className = "",
  "data-testid": testId = "live-agent-output",
}: VirtualizedAgentOutputProps) {
  const deferredContent = useDeferredValue(content);

  const lines = useMemo(() => {
    if (!deferredContent) return [""];
    const split = deferredContent.split("\n");
    return split.length > 0 ? split : [""];
  }, [deferredContent]);

  const blocks = useMemo(() => {
    const result: string[] = [];
    for (let i = 0; i < lines.length; i += LINES_PER_BLOCK) {
      result.push(lines.slice(i, i + LINES_PER_BLOCK).join("\n"));
    }
    if (result.length === 0) result.push("");
    return result;
  }, [lines]);

  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ESTIMATED_BLOCK_HEIGHT,
    overscan: 2,
  });

  const virtualItems = virtualizer.getVirtualItems();

  // Fallback: when scroll container has no height (e.g. jsdom), render non-virtualized
  const useFallback = virtualItems.length === 0;

  const proseClasses =
    "prose prose-sm prose-neutral dark:prose-invert prose-execute-task max-w-none text-theme-text prose-pre:bg-theme-code-bg prose-pre:text-theme-code-text prose-pre:border prose-pre:border-theme-border prose-pre:rounded-lg prose-p:my-1 prose-headings:my-1.5 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-pre:my-1.5 prose-blockquote:my-1.5";
  const streamClasses = "text-theme-text";
  const useMarkdown = mode === "markdown";
  const containerClasses = useMarkdown ? proseClasses : streamClasses;
  const preClasses = "whitespace-pre-wrap break-normal font-sans m-0 w-full";

  if (useFallback) {
    return (
      <div
        ref={containerRef}
        className={`p-4 text-xs min-h-[120px] overflow-y-auto flex-1 min-h-0 ${containerClasses} ${className}`}
        data-testid={testId}
        onScroll={onScroll}
      >
        {useMarkdown ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_NO_HR}>
            {deferredContent || ""}
          </ReactMarkdown>
        ) : (
          <pre className={preClasses}>{deferredContent || ""}</pre>
        )}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`p-4 text-xs min-h-[120px] overflow-y-auto flex-1 min-h-0 ${containerClasses} ${className}`}
      data-testid={testId}
      onScroll={onScroll}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {virtualItems.map((virtualItem) => {
          const blockContent = blocks[virtualItem.index] ?? "";
          return (
            <div
              key={virtualItem.key}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              {useMarkdown ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_NO_HR}>
                  {blockContent}
                </ReactMarkdown>
              ) : (
                <pre className={preClasses}>{blockContent}</pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
