import {
  cloneElement,
  isValidElement,
  useState,
  useRef,
  useCallback,
  useEffect,
  useId,
  type ReactElement,
} from "react";
import { api } from "../api/client";

const HOVER_DELAY_MS = 200;
export interface TaskLinkTooltipProps {
  projectId: string;
  taskId: string;
  cachedTitle?: string | null;
  children: React.ReactNode;
}

/** Full task title shared by pointer and keyboard users, without an extra tab stop. */
export function TaskLinkTooltip({
  projectId,
  taskId,
  cachedTitle,
  children,
}: TaskLinkTooltipProps) {
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const [fetchedTitle, setFetchedTitle] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerRef = useRef(false);
  const focusRef = useRef(false);
  const generationRef = useRef(0);
  const revealActiveRef = useRef(false);
  const tooltipId = useId();
  const title = cachedTitle ?? fetchedTitle;
  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);
  const invalidateReveal = useCallback(() => {
    generationRef.current++;
  }, []);
  const dismiss = useCallback(() => {
    revealActiveRef.current = false;
    invalidateReveal();
    clearTimer();
    setTooltipVisible(false);
  }, [clearTimer, invalidateReveal]);
  useEffect(() => {
    dismiss();
    setFetchedTitle(null);
    return () => {
      invalidateReveal();
      clearTimer();
    };
  }, [projectId, taskId, dismiss, clearTimer, invalidateReveal]);
  const reveal = useCallback(
    (delay: number) => {
      revealActiveRef.current = true;
      clearTimer();
      const generation = ++generationRef.current;
      const show = async () => {
        timerRef.current = null;
        try {
          const nextTitle = title ?? (await api.tasks.get(projectId, taskId)).title ?? taskId;
          if (generation !== generationRef.current || (!pointerRef.current && !focusRef.current))
            return;
          setFetchedTitle(nextTitle);
          setTooltipVisible(true);
        } catch {
          /* Deleted or unavailable tasks have no tooltip. */
          if (generation === generationRef.current) revealActiveRef.current = false;
        }
      };
      if (delay === 0) void show();
      else
        timerRef.current = setTimeout(() => {
          void show();
        }, delay);
    },
    [clearTimer, title, projectId, taskId]
  );
  const showTooltip = Boolean(title && tooltipVisible);
  const trigger = isValidElement(children)
    ? cloneElement(children as ReactElement<{ "aria-describedby"?: string }>, {
        "aria-describedby":
          [
            (children as ReactElement<{ "aria-describedby"?: string }>).props["aria-describedby"],
            showTooltip ? tooltipId : undefined,
          ]
            .filter(Boolean)
            .join(" ") || undefined,
      })
    : children;
  return (
    <span
      className="relative inline-flex"
      role="presentation"
      onMouseEnter={() => {
        pointerRef.current = true;
        reveal(HOVER_DELAY_MS);
      }}
      onMouseLeave={() => {
        pointerRef.current = false;
        if (!focusRef.current) dismiss();
      }}
      onFocusCapture={() => {
        focusRef.current = true;
        reveal(0);
      }}
      onBlurCapture={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        focusRef.current = false;
        if (!pointerRef.current) dismiss();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && revealActiveRef.current) {
          event.preventDefault();
          event.stopPropagation();
          dismiss();
        }
      }}
    >
      {trigger}
      {showTooltip && (
        <div
          id={tooltipId}
          role="tooltip"
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1.5 text-xs font-normal bg-theme-bg-elevated text-theme-text rounded-lg shadow-lg ring-1 ring-theme-border whitespace-normal max-w-[280px] z-50 pointer-events-none animate-fade-in"
          style={{ minWidth: "max-content" }}
        >
          {title}
        </div>
      )}
    </span>
  );
}
