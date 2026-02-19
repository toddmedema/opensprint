import { useState, useRef, useCallback, useEffect } from "react";
import { api } from "../api/client";

const HOVER_DELAY_MS = 200;

export interface TaskLinkTooltipProps {
  projectId: string;
  taskId: string;
  /** If provided, used immediately when available (avoids API call) */
  cachedTitle?: string | null;
  children: React.ReactNode;
}

/**
 * Wraps ticket links in the Evaluate feedback feed. On hover, shows a tooltip with the
 * task's full title after a short delay. Fetches title via API when not cached.
 * Gracefully handles fetch failures (e.g. deleted ticket) by not showing tooltip.
 */
export function TaskLinkTooltip({
  projectId,
  taskId,
  cachedTitle,
  children,
}: TaskLinkTooltipProps) {
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const [fetchedTitle, setFetchedTitle] = useState<string | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isHoveringRef = useRef(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const title = cachedTitle ?? fetchedTitle;

  const clearTimer = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  const hideTooltip = useCallback(() => {
    clearTimer();
    setTooltipVisible(false);
  }, [clearTimer]);

  useEffect(() => {
    return () => clearTimer();
  }, [clearTimer]);

  const handleMouseEnter = useCallback(() => {
    isHoveringRef.current = true;
    setFetchFailed(false);
    if (cachedTitle) {
      hoverTimerRef.current = setTimeout(() => setTooltipVisible(true), HOVER_DELAY_MS);
      return;
    }
    if (fetchedTitle) {
      hoverTimerRef.current = setTimeout(() => setTooltipVisible(true), HOVER_DELAY_MS);
      return;
    }
    if (fetchFailed) {
      return;
    }
    hoverTimerRef.current = setTimeout(async () => {
      hoverTimerRef.current = null;
      try {
        const task = await api.tasks.get(projectId, taskId);
        setFetchedTitle(task.title ?? taskId);
        if (isHoveringRef.current) setTooltipVisible(true);
      } catch {
        setFetchFailed(true);
      }
    }, HOVER_DELAY_MS);
  }, [projectId, taskId, cachedTitle, fetchedTitle, fetchFailed]);

  const handleMouseLeave = useCallback(() => {
    isHoveringRef.current = false;
    hideTooltip();
  }, [hideTooltip]);

  const showTooltip = title && tooltipVisible;

  return (
    <span
      ref={anchorRef}
      className="relative inline-flex"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      {showTooltip && (
        <div
          ref={tooltipRef}
          role="tooltip"
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1.5 text-xs font-normal
            bg-theme-bg-elevated text-theme-text rounded-lg shadow-lg ring-1 ring-theme-border
            whitespace-normal max-w-[280px] z-50 pointer-events-none
            animate-fade-in"
          style={{ minWidth: "max-content" }}
        >
          {title}
        </div>
      )}
    </span>
  );
}
