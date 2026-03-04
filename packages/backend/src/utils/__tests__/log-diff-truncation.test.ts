import { describe, it, expect } from "vitest";
import {
  truncateToThreshold,
  LOG_DIFF_TRUNCATE_AT_CHARS,
} from "../log-diff-truncation.js";

describe("log-diff-truncation", () => {
  describe("truncateToThreshold", () => {
    it("returns value unchanged when within threshold", () => {
      expect(truncateToThreshold("short", 100)).toBe("short");
    });

    it("returns value unchanged when exactly at threshold", () => {
      const s = "a".repeat(50);
      expect(truncateToThreshold(s, 50)).toBe(s);
    });

    it("truncates and appends suffix when over threshold", () => {
      const s = "a".repeat(100);
      const suffix = "\n\n... [truncated]";
      const result = truncateToThreshold(s, 50);
      expect(result).toHaveLength(50 + suffix.length);
      expect(result!.endsWith(suffix)).toBe(true);
      expect(result!.slice(0, 50)).toBe("a".repeat(50));
    });

    it("returns null for null input", () => {
      expect(truncateToThreshold(null, 100)).toBeNull();
    });

    it("returns empty string unchanged", () => {
      expect(truncateToThreshold("", 100)).toBe("");
    });

    it("returns undefined as null", () => {
      expect(truncateToThreshold(undefined, 100)).toBeNull();
    });

    it("truncates at 100KB (LOG_DIFF_TRUNCATE_AT_CHARS) when over limit", () => {
      const over = "x".repeat(LOG_DIFF_TRUNCATE_AT_CHARS + 1000);
      const result = truncateToThreshold(over, LOG_DIFF_TRUNCATE_AT_CHARS);
      expect(result).not.toBe(over);
      expect(result!.length).toBe(LOG_DIFF_TRUNCATE_AT_CHARS + "\n\n... [truncated]".length);
      expect(result!.endsWith("\n\n... [truncated]")).toBe(true);
    });

    it("does not truncate when at or under 100KB", () => {
      const at = "y".repeat(LOG_DIFF_TRUNCATE_AT_CHARS);
      expect(truncateToThreshold(at, LOG_DIFF_TRUNCATE_AT_CHARS)).toBe(at);
      const under = "z".repeat(1000);
      expect(truncateToThreshold(under, LOG_DIFF_TRUNCATE_AT_CHARS)).toBe(under);
    });
  });
});
