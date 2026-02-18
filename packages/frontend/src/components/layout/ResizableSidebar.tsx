import { useState, useCallback, useRef, useEffect } from "react";

const STORAGE_PREFIX = "opensprint-sidebar-width-";

/** Default min width per UX best practices (readable content, usable drag handle) */
const DEFAULT_MIN_WIDTH = 200;

/** Default max width as fraction of viewport (leaves main content visible) */
const DEFAULT_MAX_WIDTH_PERCENT = 0.8;

export interface ResizableSidebarProps {
  /** Unique key for localStorage persistence (e.g. "plan", "build") */
  storageKey: string;
  /** Default width in pixels when no persisted value exists */
  defaultWidth?: number;
  /** Minimum width in pixels (default 200) */
  minWidth?: number;
  /** Maximum width in pixels; if unset, uses maxWidthPercent of viewport */
  maxWidth?: number;
  /** Max width as fraction of viewport (0–1), used when maxWidth not set (default 0.8) */
  maxWidthPercent?: number;
  /** Sidebar content */
  children: React.ReactNode;
  /** Additional class names for the sidebar container */
  className?: string;
  /** Whether sidebar is visible (affects resize handle visibility) */
  visible?: boolean;
  /** When true, on mobile uses w-full max-w-[defaultWidth], on md+ uses persisted width */
  responsive?: boolean;
}

function loadPersistedWidth(
  storageKey: string,
  defaultWidth: number,
  minWidth: number,
  maxWidth: number,
): number {
  if (typeof window === "undefined") return defaultWidth;
  try {
    const stored = localStorage.getItem(STORAGE_PREFIX + storageKey);
    if (stored) {
      const parsed = parseInt(stored, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.round(Math.min(maxWidth, Math.max(minWidth, parsed)));
      }
    }
  } catch {
    // ignore
  }
  return defaultWidth;
}

function savePersistedWidth(storageKey: string, width: number): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_PREFIX + storageKey, String(width));
  } catch {
    // ignore
  }
}

function useViewportWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1024,
  );
  useEffect(() => {
    const handleResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);
  return width;
}

/**
 * A right-side sidebar with a draggable left edge. Width is persisted to localStorage.
 * Used in Plan and Build phases for the plan detail and task detail panels.
 * Min 200px, max 80% of viewport by default (per UX best practices).
 */
export function ResizableSidebar({
  storageKey,
  defaultWidth = 420,
  minWidth = DEFAULT_MIN_WIDTH,
  maxWidth: maxWidthProp,
  maxWidthPercent = DEFAULT_MAX_WIDTH_PERCENT,
  children,
  className = "",
  visible = true,
  responsive = false,
}: ResizableSidebarProps) {
  const viewportWidth = useViewportWidth();
  const maxWidth =
    maxWidthProp ??
    Math.max(minWidth, Math.round(viewportWidth * maxWidthPercent));

  const [width, setWidth] = useState(() =>
    loadPersistedWidth(storageKey, defaultWidth, minWidth, maxWidth),
  );

  // Re-clamp width when viewport changes (e.g. window resize)
  useEffect(() => {
    setWidth((w) => {
      const clamped = Math.min(maxWidth, Math.max(minWidth, w));
      if (clamped !== w) {
        savePersistedWidth(storageKey, clamped);
        return clamped;
      }
      return w;
    });
  }, [minWidth, maxWidth, storageKey]);

  const startXRef = useRef<number>(0);
  const startWidthRef = useRef<number>(0);
  const currentWidthRef = useRef<number>(width);
  currentWidthRef.current = width;

  const onHandleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startXRef.current = e.clientX;
      startWidthRef.current = width;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = startXRef.current - moveEvent.clientX;
        const newWidth = Math.round(
          Math.min(maxWidth, Math.max(minWidth, startWidthRef.current + deltaX)),
        );
        currentWidthRef.current = newWidth;
        setWidth(newWidth);
      };

      const handleMouseUp = () => {
        savePersistedWidth(storageKey, currentWidthRef.current);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [width, storageKey, minWidth, maxWidth],
  );

  const widthStyle = responsive
    ? {
        ["--sidebar-width" as string]: `${width}px`,
        ["--sidebar-mobile-max" as string]: `${defaultWidth}px`,
      }
    : { width: visible ? width : 0, minWidth: visible ? width : 0 };

  const responsiveClasses = responsive
    ? "w-full max-w-[var(--sidebar-mobile-max,420px)] md:max-w-none md:w-[var(--sidebar-width)]"
    : "";

  const borderClass = responsive ? "" : "border-l border-theme-border";

  return (
    <div
      className={`relative flex flex-col min-h-0 bg-theme-bg shrink-0 overflow-hidden ${borderClass} ${responsiveClasses} ${className}`}
      style={widthStyle}
    >
      {visible && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-valuenow={width}
          aria-valuemin={minWidth}
          aria-valuemax={maxWidth}
          aria-label="Resize sidebar"
          onMouseDown={onHandleMouseDown}
          className={`absolute left-0 top-0 bottom-0 w-2 -ml-1 cursor-col-resize z-10 flex items-center justify-center group hover:bg-brand-500/10 ${responsive ? "hidden md:flex" : ""}`}
        >
          <div className="w-1 h-12 rounded-full bg-theme-ring group-hover:bg-brand-500/60 opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      )}
      <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">{children}</div>
    </div>
  );
}
