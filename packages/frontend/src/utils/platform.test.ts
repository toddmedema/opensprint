import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getPlatformFamily, isMac, getSubmitShortcutLabel } from "./platform";

describe("platform", () => {
  const originalNavigator = global.navigator;

  beforeEach(() => {
    vi.stubGlobal("navigator", { ...originalNavigator });
  });

  afterEach(() => {
    vi.stubGlobal("navigator", originalNavigator);
  });

  describe("getPlatformFamily", () => {
    it("returns mac when navigator.platform includes Mac", () => {
      vi.stubGlobal("navigator", {
        ...originalNavigator,
        platform: "MacIntel",
        userAgent: "Mozilla/5.0",
      });
      expect(getPlatformFamily()).toBe("mac");
    });

    it("returns windows when navigator.platform includes Win", () => {
      vi.stubGlobal("navigator", {
        ...originalNavigator,
        platform: "Win32",
        userAgent: "Mozilla/5.0",
      });
      expect(getPlatformFamily()).toBe("windows");
    });

    it("returns windows when navigator.userAgent includes Windows", () => {
      vi.stubGlobal("navigator", {
        ...originalNavigator,
        platform: "Linux x86_64",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      });
      expect(getPlatformFamily()).toBe("windows");
    });

    it("returns linux when navigator.userAgent includes Linux", () => {
      vi.stubGlobal("navigator", {
        ...originalNavigator,
        platform: "",
        userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      });
      expect(getPlatformFamily()).toBe("linux");
    });
  });

  describe("isMac", () => {
    it("returns true when navigator.platform includes Mac", () => {
      vi.stubGlobal("navigator", {
        ...originalNavigator,
        platform: "MacIntel",
        userAgent: "Mozilla/5.0",
      });
      expect(isMac()).toBe(true);
    });

    it("returns true when navigator.userAgent includes mac", () => {
      vi.stubGlobal("navigator", {
        ...originalNavigator,
        platform: "",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      });
      expect(isMac()).toBe(true);
    });

    it("returns true when navigator.userAgentData.platform is macOS", () => {
      vi.stubGlobal("navigator", {
        ...originalNavigator,
        platform: "Linux x86_64",
        userAgent: "Mozilla/5.0",
        userAgentData: { platform: "macOS" },
      });
      expect(isMac()).toBe(true);
    });

    it("returns false on Windows", () => {
      vi.stubGlobal("navigator", {
        ...originalNavigator,
        platform: "Win32",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      });
      expect(isMac()).toBe(false);
    });

    it("returns false on Linux", () => {
      vi.stubGlobal("navigator", {
        ...originalNavigator,
        platform: "Linux x86_64",
        userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      });
      expect(isMac()).toBe(false);
    });
  });

  describe("getSubmitShortcutLabel", () => {
    it("returns Enter or Cmd + Enter to submit · Shift+Enter for new line on macOS", () => {
      vi.stubGlobal("navigator", {
        ...originalNavigator,
        platform: "MacIntel",
        userAgent: "Mozilla/5.0",
      });
      expect(getSubmitShortcutLabel()).toBe(
        "Enter or Cmd + Enter to submit · Shift+Enter for new line"
      );
    });

    it("returns Enter or Ctrl + Enter to submit · Shift+Enter for new line on Windows", () => {
      vi.stubGlobal("navigator", {
        ...originalNavigator,
        platform: "Win32",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      });
      expect(getSubmitShortcutLabel()).toBe(
        "Enter or Ctrl + Enter to submit · Shift+Enter for new line"
      );
    });

    it("returns Enter or Ctrl + Enter to submit · Shift+Enter for new line on Linux", () => {
      vi.stubGlobal("navigator", {
        ...originalNavigator,
        platform: "Linux x86_64",
        userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      });
      expect(getSubmitShortcutLabel()).toBe(
        "Enter or Ctrl + Enter to submit · Shift+Enter for new line"
      );
    });
  });
});
