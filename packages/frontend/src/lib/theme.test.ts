import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getStoredTheme,
  setStoredTheme,
  getResolvedTheme,
  applyTheme,
} from "./theme";

describe("theme", () => {
  const storage: Record<string, string> = {};
  let matchMediaMatches = false;

  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => {
        storage[key] = value;
      },
      removeItem: (key: string) => {
        delete storage[key];
      },
      clear: () => {
        Object.keys(storage).forEach((k) => delete storage[k]);
      },
      length: 0,
      key: () => null,
    });
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: matchMediaMatches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("getStoredTheme", () => {
    it("returns 'system' when nothing stored", () => {
      expect(getStoredTheme()).toBe("system");
    });

    it("returns stored 'light'", () => {
      storage["opensprint.theme"] = "light";
      expect(getStoredTheme()).toBe("light");
    });

    it("returns stored 'dark'", () => {
      storage["opensprint.theme"] = "dark";
      expect(getStoredTheme()).toBe("dark");
    });

    it("returns 'system' for invalid stored value", () => {
      storage["opensprint.theme"] = "invalid";
      expect(getStoredTheme()).toBe("system");
    });
  });

  describe("setStoredTheme", () => {
    it("persists theme to localStorage", () => {
      setStoredTheme("light");
      expect(storage["opensprint.theme"]).toBe("light");
      setStoredTheme("dark");
      expect(storage["opensprint.theme"]).toBe("dark");
      setStoredTheme("system");
      expect(storage["opensprint.theme"]).toBe("system");
    });
  });

  describe("getResolvedTheme", () => {
    it("returns 'light' when preference is light", () => {
      storage["opensprint.theme"] = "light";
      matchMediaMatches = true;
      expect(getResolvedTheme()).toBe("light");
    });

    it("returns 'dark' when preference is dark", () => {
      storage["opensprint.theme"] = "dark";
      matchMediaMatches = false;
      expect(getResolvedTheme()).toBe("dark");
    });

    it("returns 'dark' when system prefers dark", () => {
      storage["opensprint.theme"] = "system";
      matchMediaMatches = true;
      expect(getResolvedTheme()).toBe("dark");
    });

    it("returns 'light' when system prefers light", () => {
      storage["opensprint.theme"] = "system";
      matchMediaMatches = false;
      expect(getResolvedTheme()).toBe("light");
    });
  });

  describe("applyTheme", () => {
    it("sets data-theme and persists", () => {
      const doc = document.documentElement;
      applyTheme("light");
      expect(doc.getAttribute("data-theme")).toBe("light");
      expect(storage["opensprint.theme"]).toBe("light");

      applyTheme("dark");
      expect(doc.getAttribute("data-theme")).toBe("dark");
      expect(storage["opensprint.theme"]).toBe("dark");
    });

    it("resolves system preference when applying system", () => {
      matchMediaMatches = true;
      applyTheme("system");
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
      matchMediaMatches = false;
      applyTheme("system");
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    });
  });
});
