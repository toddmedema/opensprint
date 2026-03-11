import path from "path";
import { describe, expect, it, vi } from "vitest";
import { resolveSqlitePath } from "../db/sqlite-client.js";

describe("resolveSqlitePath", () => {
  it("resolves file URL local paths on non-Windows platforms", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    try {
      expect(resolveSqlitePath("file:///tmp/opensprint.sqlite")).toBe(path.resolve("/tmp/opensprint.sqlite"));
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("normalizes Windows drive-letter file URLs without an extra leading slash", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const resolved = resolveSqlitePath("file:///C:/Users/Alice/.opensprint/data/opensprint.sqlite");
      expect(resolved).toBe(
        path.win32.resolve("C:/Users/Alice/.opensprint/data/opensprint.sqlite")
      );
      expect(resolved.startsWith("\\C:")).toBe(false);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("normalizes Windows UNC file URLs", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      expect(resolveSqlitePath("file://server/share/opensprint.sqlite")).toBe(
        path.win32.resolve("\\\\server\\share\\opensprint.sqlite")
      );
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("normalizes legacy repeated sqlite: prefixes", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    try {
      expect(resolveSqlitePath("sqlite:sqlite:./data/opensprint.sqlite")).toBe(
        path.resolve("./data/opensprint.sqlite")
      );
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("normalizes legacy file:/ shorthand to a path", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    try {
      expect(resolveSqlitePath("file:/tmp/opensprint.sqlite")).toBe(
        path.resolve("/tmp/opensprint.sqlite")
      );
    } finally {
      platformSpy.mockRestore();
    }
  });
});
