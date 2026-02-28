import React, { useRef, useMemo, useDeferredValue } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const LINES_PER_BLOCK = 30;
const ESTIMATED_LINE_HEIGHT = 20;

export interface VirtualizedAgentOutputProps {
  /** Full content to display (joined agent output) */
  content: string;
  /** When true, use plain text for faster streaming; when false, use ReactMarkdown */
  useMarkdown: boolean;
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
  useMarkdown,
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
    estimateSize: () => LINES_PER_BLOCK * ESTIMATED_LINE_HEIGHT,
    overscan: 2,
  });

  const virtualItems = virtualizer.getVirtualItems();

  // Fallback: when scroll container has no height (e.g. jsdom), render non-virtualized
  const useFallback = virtualItems.length === 0;

  const proseClasses =
    "prose prose-sm prose-neutral dark:prose-invert prose-execute-task max-w-none text-theme-success-muted prose-pre:bg-theme-code-bg prose-pre:text-theme-code-text prose-pre:border prose-pre:border-theme-border prose-pre:rounded-lg";

  if (useFallback) {
    return (
      <div
        ref={containerRef}
        className={`p-4 text-xs min-h-[120px] overflow-y-auto flex-1 min-h-0 ${proseClasses} ${className}`}
        data-testid={testId}
        onScroll={onScroll}
      >
        {useMarkdown ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{deferredContent || ""}</ReactMarkdown>
        ) : (
          <pre className="whitespace-pre-wrap font-sans m-0">{deferredContent || ""}</pre>
        )}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`p-4 text-xs min-h-[120px] overflow-y-auto flex-1 min-h-0 ${proseClasses} ${className}`}
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
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              {useMarkdown ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{blockContent}</ReactMarkdown>
              ) : (
                <pre className="whitespace-pre-wrap font-sans m-0">{blockContent}</pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
