import { useState, useCallback, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { MOBILE_BREAKPOINT } from "../../lib/constants";
import { useViewportWidth } from "../../hooks/useViewportWidth";
import { CloseButton } from "../CloseButton";

const STORAGE_PREFIX = "opensprint-sidebar-width-";

/** Default min width per UX best practices (readable content, usable drag handle) */
const DEFAULT_MIN_WIDTH = 200;

/** Default max width as fraction of viewport (leaves main content visible) */
const DEFAULT_MAX_WIDTH_PERCENT = 0.8;

/** z-index for mobile overlay — above main content, below modals */
const SIDEBAR_OVERLAY_Z = 40;

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
  /** Which side of the main content the sidebar is on (default "right") */
  side?: "left" | "right";
  /** Sidebar content */
  children: React.ReactNode;
  /** Additional class names for the sidebar container */
  className?: string;
  /** Whether sidebar is visible (affects resize handle visibility) */
  visible?: boolean;
  /** When true, on mobile (< md) renders as fixed overlay with backdrop; on md+ uses inline layout */
  responsive?: boolean;
  /** Called when user closes overlay (button, backdrop, swipe). Required when responsive=true for overlay close affordance. */
  onClose?: () => void;
  /** Accessible label for the resize handle (default "Resize sidebar") */
  resizeHandleLabel?: string;
  /** When true, no border is rendered (e.g. for minimal Sketch TOC) */
  noBorder?: boolean;
}

function loadPersistedWidth(
  storageKey: string,
  defaultWidth: number,
  minWidth: number,
  maxWidth: number
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

/** Minimum swipe distance (px) to trigger close */
const SWIPE_THRESHOLD = 80;

function useSwipeToClose(
  side: "left" | "right",
  onClose: () => void,
  enabled: boolean
): {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
  translateX: number;
} {
  const [translateX, setTranslateX] = useState(0);
  const startXRef = useRef(0);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!enabled) return;
      startXRef.current = e.touches[0].clientX;
    },
    [enabled]
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!enabled) return;
      const delta = e.touches[0].clientX - startXRef.current;
      // Right sidebar: swipe right (positive delta) closes
      // Left sidebar: swipe left (negative delta) closes
      if (side === "right") {
        setTranslateX(delta > 0 ? delta : 0);
      } else {
        setTranslateX(delta < 0 ? delta : 0);
      }
    },
    [enabled, side]
  );

  const onTouchEnd = useCallback(() => {
    if (!enabled) return;
    const shouldClose =
      (side === "right" && translateX > SWIPE_THRESHOLD) ||
      (side === "left" && translateX < -SWIPE_THRESHOLD);
    setTranslateX(0);
    if (shouldClose) onClose();
  }, [enabled, side, translateX, onClose]);

  return { onTouchStart, onTouchMove, onTouchEnd, translateX };
}

/**
 * A sidebar with a draggable edge for resize. Width is persisted to localStorage.
 * Shared by Plan, Sketch, Execute, and Deliver phases (plan detail, TOC/Discuss, task detail, delivery history).
 * When responsive=true and viewport < md: renders as fixed overlay with backdrop, close button, and swipe-to-close.
 */
export function ResizableSidebar({
  storageKey,
  defaultWidth = 420,
  minWidth = DEFAULT_MIN_WIDTH,
  maxWidth: maxWidthProp,
  maxWidthPercent = DEFAULT_MAX_WIDTH_PERCENT,
  side = "right",
  children,
  className = "",
  visible = true,
  responsive = false,
  onClose,
  resizeHandleLabel = "Resize sidebar",
  noBorder = false,
}: ResizableSidebarProps) {
  const viewportWidth = useViewportWidth();
  const maxWidth = maxWidthProp ?? Math.max(minWidth, Math.round(viewportWidth * maxWidthPercent));

  const [width, setWidth] = useState(() =>
    loadPersistedWidth(storageKey, defaultWidth, minWidth, maxWidth)
  );

  const isMobileOverlay = responsive && viewportWidth < MOBILE_BREAKPOINT;
  const swipe = useSwipeToClose(side, onClose ?? (() => {}), isMobileOverlay && !!onClose);

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
        const deltaX =
          side === "left"
            ? moveEvent.clientX - startXRef.current
            : startXRef.current - moveEvent.clientX;
        const newWidth = Math.round(
          Math.min(maxWidth, Math.max(minWidth, startWidthRef.current + deltaX))
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
    [width, storageKey, minWidth, maxWidth, side]
  );

  const widthStyle = responsive && !isMobileOverlay
    ? {
        ["--sidebar-width" as string]: `${width}px`,
        ["--sidebar-mobile-max" as string]: `${defaultWidth}px`,
      }
    : !isMobileOverlay
      ? { width: visible ? width : 0, minWidth: visible ? width : 0 }
      : undefined;

  const responsiveClasses = responsive && !isMobileOverlay
    ? "w-full max-w-[var(--sidebar-mobile-max,420px)] md:max-w-none md:w-[var(--sidebar-width)]"
    : "";

  const borderClass =
    noBorder || responsive
      ? ""
      : side === "left"
        ? "border-r border-theme-border"
        : "border-l border-theme-border";

  const handlePositionClass =
    side === "left"
      ? "absolute right-0 top-0 bottom-0 w-2 -mr-1 cursor-col-resize z-10 flex items-center justify-center group hover:bg-brand-500/10"
      : "absolute left-0 top-0 bottom-0 w-2 -ml-1 cursor-col-resize z-10 flex items-center justify-center group hover:bg-brand-500/10";

  // Mobile overlay: fixed panel with backdrop, close button, swipe-to-close
  if (isMobileOverlay && visible) {
    const overlay = (
      <div
        className="fixed inset-0 z-[var(--sidebar-overlay-z)]"
        style={{ "--sidebar-overlay-z": SIDEBAR_OVERLAY_Z } as React.CSSProperties}
        aria-modal="true"
        role="dialog"
        aria-label="Sidebar panel"
      >
        {/* Semi-transparent backdrop */}
        <button
          type="button"
          onClick={onClose}
          className="absolute inset-0 bg-black/50 backdrop-blur-sm transition-opacity"
          aria-label="Close sidebar (backdrop)"
        />
        {/* Panel */}
        <div
          className={`absolute top-0 bottom-0 h-full w-full flex flex-col bg-theme-bg shadow-xl ${
            side === "right"
              ? "right-0 animate-slide-in-right"
              : "left-0 animate-slide-in-left"
          }`}
          style={{
            [side]: 0,
            width: Math.min(viewportWidth, defaultWidth),
            maxWidth: "100%",
            transform: `translateX(${swipe.translateX}px)`,
            transition: swipe.translateX !== 0 ? "none" : "transform 0.2s ease-out",
          }}
          onTouchStart={swipe.onTouchStart}
          onTouchMove={swipe.onTouchMove}
          onTouchEnd={swipe.onTouchEnd}
        >
          {/* Close button — 44×44px touch target, floating top corner */}
          {onClose && (
            <div
              className={`absolute top-2 z-10 min-h-[44px] min-w-[44px] flex items-center justify-center ${
                side === "right" ? "right-2" : "left-2"
              }`}
            >
              <CloseButton
                onClick={onClose}
                ariaLabel="Close sidebar"
                className="p-2 rounded-md text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle transition-colors bg-theme-bg/90"
                size="w-5 h-5"
              />
            </div>
          )}
          <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">{children}</div>
        </div>
      </div>
    );
    return createPortal(overlay, document.body);
  }

  // Desktop or non-responsive: inline sidebar (no overlay)
  if (isMobileOverlay && !visible) {
    return null;
  }

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
          aria-label={resizeHandleLabel}
          onMouseDown={onHandleMouseDown}
          className={`${handlePositionClass} ${responsive ? "hidden md:flex" : ""}`}
        >
          <div className="w-1 h-12 rounded-full bg-theme-ring group-hover:bg-brand-500/60 opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      )}
      <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">{children}</div>
    </div>
  );
}
