import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getDropdownPositionRightAligned,
  getDropdownPositionLeftAligned,
  getDropdownPositionViewportAware,
  shouldRightAlignDropdown,
  TOAST_SAFE_STYLE,
} from "./dropdownViewport";

describe("dropdownViewport", () => {
  const originalInnerWidth = window.innerWidth;
  const originalInnerHeight = window.innerHeight;

  beforeEach(() => {
    vi.stubGlobal("window", {
      innerWidth: 1024,
      innerHeight: 768,
    });
  });

  afterEach(() => {
    vi.stubGlobal("window", {
      innerWidth: originalInnerWidth,
      innerHeight: originalInnerHeight,
    });
  });

  describe("getDropdownPositionRightAligned", () => {
    it("positions dropdown below trigger on desktop", () => {
      const rect = new DOMRect(800, 100, 100, 40);
      const style = getDropdownPositionRightAligned(rect);
      expect(style.position).toBe("fixed");
      expect(style.top).toBe(144);
      expect(style.right).toBe(124);
      expect(style.maxHeight).toBe("90vh");
      expect(style.overflowY).toBe("auto");
    });

    it("uses bottom-up on mobile when space below is insufficient", () => {
      vi.stubGlobal("window", { innerWidth: 375, innerHeight: 667 });
      const rect = new DOMRect(300, 600, 80, 40);
      const style = getDropdownPositionRightAligned(rect, {
        minWidth: 220,
        estimatedHeight: 280,
      });
      expect(style.position).toBe("fixed");
      expect(style.bottom).toBeDefined();
      expect(style.bottom).toBe(667 - 600 + 4);
    });

    it("respects minWidth option", () => {
      const rect = new DOMRect(900, 100, 50, 40);
      const style = getDropdownPositionRightAligned(rect, { minWidth: 260 });
      expect(style.minWidth).toBe(260);
    });

    it("omits minWidth when 0 so dropdown sizes to content", () => {
      const rect = new DOMRect(900, 100, 50, 40);
      const style = getDropdownPositionRightAligned(rect, { minWidth: 0 });
      expect(style.minWidth).toBeUndefined();
    });
  });

  describe("getDropdownPositionLeftAligned", () => {
    it("positions dropdown below trigger", () => {
      const rect = new DOMRect(200, 100, 40, 40);
      const style = getDropdownPositionLeftAligned(rect);
      expect(style.position).toBe("fixed");
      expect(style.top).toBe(144);
      expect(style.left).toBeGreaterThanOrEqual(8);
      expect(style.maxHeight).toBe("90vh");
    });

    it("clamps left to stay within viewport", () => {
      const rect = new DOMRect(50, 100, 40, 40);
      const style = getDropdownPositionLeftAligned(rect, { minWidth: 140 });
      expect(style.left).toBeGreaterThanOrEqual(8);
    });

    it("omits minWidth when 0 so dropdown sizes to content and left-aligns to trigger", () => {
      const rect = new DOMRect(100, 100, 80, 40);
      const style = getDropdownPositionLeftAligned(rect, { minWidth: 0 });
      expect(style.minWidth).toBeUndefined();
      expect(style.left).toBe(100);
    });
  });

  describe("shouldRightAlignDropdown", () => {
    it("returns true when trigger right edge is within threshold of viewport right", () => {
      const vw = 1024;
      vi.stubGlobal("window", { innerWidth: vw, innerHeight: 768 });
      const rect = new DOMRect(vw - 80, 100, 60, 40);
      expect(shouldRightAlignDropdown(rect)).toBe(true);
    });

    it("returns false when trigger is far from viewport right edge", () => {
      vi.stubGlobal("window", { innerWidth: 1024, innerHeight: 768 });
      const rect = new DOMRect(200, 100, 100, 40);
      expect(shouldRightAlignDropdown(rect)).toBe(false);
    });

    it("returns false when distance from right equals threshold", () => {
      vi.stubGlobal("window", { innerWidth: 1024, innerHeight: 768 });
      const rect = new DOMRect(1024 - 100 - 50, 100, 50, 40);
      expect(shouldRightAlignDropdown(rect)).toBe(false);
    });
  });

  describe("getDropdownPositionViewportAware", () => {
    it("returns right-aligned style when trigger is near viewport right edge", () => {
      vi.stubGlobal("window", { innerWidth: 1024, innerHeight: 768 });
      const rect = new DOMRect(950, 100, 60, 40);
      const style = getDropdownPositionViewportAware(rect);
      expect(style.position).toBe("fixed");
      expect(style.right).toBeDefined();
      expect(style.top).toBe(144);
    });

    it("returns left-aligned style when trigger is far from viewport right edge", () => {
      vi.stubGlobal("window", { innerWidth: 1024, innerHeight: 768 });
      const rect = new DOMRect(200, 100, 100, 40);
      const style = getDropdownPositionViewportAware(rect);
      expect(style.position).toBe("fixed");
      expect(style.left).toBeDefined();
      expect(style.top).toBe(144);
    });
  });

  describe("TOAST_SAFE_STYLE", () => {
    it("provides safe area insets for bottom and right", () => {
      expect(TOAST_SAFE_STYLE.bottom).toContain("safe-area-inset-bottom");
      expect(TOAST_SAFE_STYLE.right).toContain("safe-area-inset-right");
    });
  });
});
