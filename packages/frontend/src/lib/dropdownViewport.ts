/**
 * Viewport-safe positioning for dropdowns and popovers.
 * Ensures max-height 90vh, overflow-y-auto, safe insets, and bottom-up on mobile when needed.
 */

import type { CSSProperties } from "react";
import { MOBILE_BREAKPOINT } from "./constants";
import { DROPDOWN_PORTAL_Z_INDEX } from "./constants";

/** Safe inset (px) from viewport edges to avoid cutoff on mobile. */
const SAFE_INSET = 8;

/** When trigger's right edge is within this many px of viewport right, use right-aligned dropdown. */
export const VIEWPORT_RIGHT_EDGE_THRESHOLD = 100;

/** Default max height for dropdown content (matches 90vh). */
export const DROPDOWN_MAX_HEIGHT = "90vh";

export interface DropdownPositionOptions {
  minWidth?: number;
  /** Estimated dropdown height for bottom-up decision (px). */
  estimatedHeight?: number;
}

/**
 * Computes viewport-safe positioning for a right-aligned dropdown anchored to a trigger rect.
 * On mobile (< MOBILE_BREAKPOINT), uses bottom-up when space below is insufficient.
 */
export function getDropdownPositionRightAligned(
  anchorRect: DOMRect,
  options?: DropdownPositionOptions
): CSSProperties {
  const { minWidth = 220, estimatedHeight = 280 } = options ?? {};
  const isMobile = typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT;
  const vh = typeof window !== "undefined" ? window.innerHeight : 600;
  const vw = typeof window !== "undefined" ? window.innerWidth : 400;

  const spaceBelow = vh - anchorRect.bottom - SAFE_INSET;
  const spaceAbove = anchorRect.top - SAFE_INSET;
  const useBottomUp = isMobile && spaceBelow < estimatedHeight && spaceAbove > spaceBelow;

  const right = vw - anchorRect.right;
  const maxWidth = anchorRect.right - SAFE_INSET;

  const base = {
    position: "fixed" as const,
    right,
    ...(minWidth > 0 ? { minWidth } : {}),
    maxWidth: `${maxWidth}px`,
    maxHeight: "90vh",
    overflowY: "auto" as const,
    zIndex: DROPDOWN_PORTAL_Z_INDEX,
  };

  if (useBottomUp) {
    return { ...base, bottom: vh - anchorRect.top + 4 };
  }
  return { ...base, top: anchorRect.bottom + 4 };
}

/**
 * Returns true when the trigger's right edge is within VIEWPORT_RIGHT_EDGE_THRESHOLD of the
 * viewport right edge. Use this to choose right vs left alignment for absolute-positioned dropdowns.
 */
export function shouldRightAlignDropdown(anchorRect: DOMRect): boolean {
  const vw = typeof window !== "undefined" ? window.innerWidth : 0;
  return vw > 0 && vw - anchorRect.right < VIEWPORT_RIGHT_EDGE_THRESHOLD;
}

/**
 * Viewport-aware positioning: right-align when trigger is near viewport right edge (< 100px),
 * otherwise left-align. Use for fixed/portal dropdowns.
 */
export function getDropdownPositionViewportAware(
  anchorRect: DOMRect,
  options?: DropdownPositionOptions
): CSSProperties {
  return shouldRightAlignDropdown(anchorRect)
    ? getDropdownPositionRightAligned(anchorRect, options)
    : getDropdownPositionLeftAligned(anchorRect, options);
}

/**
 * Computes viewport-safe positioning for a left-aligned dropdown (e.g. project card kebab menu).
 */
export function getDropdownPositionLeftAligned(
  anchorRect: DOMRect,
  options?: DropdownPositionOptions
): CSSProperties {
  const { minWidth = 140, estimatedHeight = 120 } = options ?? {};
  const isMobile = typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT;
  const vh = typeof window !== "undefined" ? window.innerHeight : 600;
  const vw = typeof window !== "undefined" ? window.innerWidth : 400;

  const spaceBelow = vh - anchorRect.bottom - SAFE_INSET;
  const spaceAbove = anchorRect.top - SAFE_INSET;
  const useBottomUp = isMobile && spaceBelow < estimatedHeight && spaceAbove > spaceBelow;

  const left =
    minWidth > 0
      ? Math.max(
          SAFE_INSET,
          Math.min(anchorRect.right - minWidth, vw - minWidth - SAFE_INSET)
        )
      : Math.max(SAFE_INSET, anchorRect.left);

  const base = {
    position: "fixed" as const,
    left,
    ...(minWidth > 0 ? { minWidth } : {}),
    maxWidth: `${vw - left - SAFE_INSET}px`,
    maxHeight: "90vh",
    overflowY: "auto" as const,
    zIndex: DROPDOWN_PORTAL_Z_INDEX,
  };

  if (useBottomUp) {
    return { ...base, bottom: vh - anchorRect.top + 4 };
  }
  return { ...base, top: anchorRect.bottom + 4 };
}

/**
 * CSS classes for viewport-safe dropdown containers.
 */
export const DROPDOWN_VIEWPORT_CLASSES = "max-h-[90vh] overflow-y-auto" as const;

/**
 * Inline style for toast/notification fixed positioning with safe insets.
 * Uses env(safe-area-inset-*) when available for notched devices.
 */
export const TOAST_SAFE_STYLE: CSSProperties = {
  bottom: "max(1rem, env(safe-area-inset-bottom, 1rem))",
  right: "max(1rem, env(safe-area-inset-right, 1rem))",
};
