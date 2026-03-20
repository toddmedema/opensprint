import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatPlanIdAsTitle,
  formatSectionKey,
  formatTaskDuration,
  formatTimestamp,
  formatUptime,
} from "./formatting";

describe("formatting", () => {
  describe("formatPlanIdAsTitle", () => {
    it("formats kebab-case plan ID as Title Case", () => {
      expect(formatPlanIdAsTitle("plan-phase-feature-decomposition")).toBe(
        "Plan Phase Feature Decomposition"
      );
      expect(formatPlanIdAsTitle("my-feature-plan")).toBe("My Feature Plan");
    });

    it("handles single word", () => {
      expect(formatPlanIdAsTitle("feature")).toBe("Feature");
    });

    it("handles empty string", () => {
      expect(formatPlanIdAsTitle("")).toBe("");
    });
  });

  describe("formatSectionKey", () => {
    it("converts snake_case to Title Case", () => {
      expect(formatSectionKey("executive_summary")).toBe("Executive Summary");
      expect(formatSectionKey("problem_statement")).toBe("Problem Statement");
      expect(formatSectionKey("goals_and_metrics")).toBe("Goals and Success Metrics");
      expect(formatSectionKey("assumptions_and_constraints")).toBe("Assumptions and Constraints");
    });

    it("handles single word", () => {
      expect(formatSectionKey("summary")).toBe("Summary");
    });

    it("handles empty string", () => {
      expect(formatSectionKey("")).toBe("");
    });

    it("handles already capitalized words", () => {
      expect(formatSectionKey("api_contracts")).toBe("Api Contracts");
    });
  });

  describe("formatTimestamp", () => {
    const mockNow = new Date("2026-02-16T12:00:00.000Z");

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(mockNow);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns 'Just now' for timestamps within the last minute", () => {
      const ts = new Date("2026-02-16T11:59:30.000Z").toISOString();
      expect(formatTimestamp(ts)).toBe("Just now");
    });

    it("returns minutes ago for timestamps within the last hour", () => {
      const ts = new Date("2026-02-16T11:55:00.000Z").toISOString();
      expect(formatTimestamp(ts)).toBe("5m ago");
    });

    it("returns hours ago for timestamps within the last day", () => {
      const ts = new Date("2026-02-16T10:00:00.000Z").toISOString();
      expect(formatTimestamp(ts)).toBe("2h ago");
    });

    it("returns days ago for timestamps within the last week", () => {
      const ts = new Date("2026-02-14T12:00:00.000Z").toISOString();
      expect(formatTimestamp(ts)).toBe("2d ago");
    });

    it("returns locale date string for older timestamps", () => {
      const ts = new Date("2026-01-01T12:00:00.000Z").toISOString();
      const result = formatTimestamp(ts);
      expect(result).toMatch(/\d/);
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("formatUptime", () => {
    const mockNow = new Date("2026-02-16T12:02:34.000Z");

    it("formats seconds only", () => {
      const startedAt = new Date("2026-02-16T12:02:20.000Z").toISOString();
      expect(formatUptime(startedAt, mockNow)).toBe("14s");
    });

    it("formats minutes and seconds", () => {
      const startedAt = new Date("2026-02-16T12:00:20.000Z").toISOString();
      expect(formatUptime(startedAt, mockNow)).toBe("2m 14s");
    });

    it("formats hours, minutes and seconds", () => {
      const startedAt = new Date("2026-02-16T10:55:20.000Z").toISOString();
      expect(formatUptime(startedAt, mockNow)).toBe("1h 7m 14s");
    });

    it("returns 0s for future or same timestamp", () => {
      const startedAt = new Date("2026-02-16T12:02:35.000Z").toISOString();
      expect(formatUptime(startedAt, mockNow)).toBe("0s");
    });
  });

  describe("formatTaskDuration", () => {
    it("formats duration as MM:SS", () => {
      const startedAt = "2026-02-16T12:00:00.000Z";
      const completedAt = "2026-02-16T12:05:30.000Z";
      expect(formatTaskDuration(startedAt, completedAt)).toBe("5:30");
    });

    it("pads seconds with zero", () => {
      const startedAt = "2026-02-16T12:00:00.000Z";
      const completedAt = "2026-02-16T12:03:09.000Z";
      expect(formatTaskDuration(startedAt, completedAt)).toBe("3:09");
    });

    it("handles duration over 60 minutes", () => {
      const startedAt = "2026-02-16T12:00:00.000Z";
      const completedAt = "2026-02-16T13:05:30.000Z";
      expect(formatTaskDuration(startedAt, completedAt)).toBe("65:30");
    });

    it("returns null when startedAt is missing", () => {
      expect(formatTaskDuration(null, "2026-02-16T12:05:30.000Z")).toBeNull();
      expect(formatTaskDuration(undefined, "2026-02-16T12:05:30.000Z")).toBeNull();
    });

    it("returns null when completedAt is missing", () => {
      expect(formatTaskDuration("2026-02-16T12:00:00.000Z", null)).toBeNull();
      expect(formatTaskDuration("2026-02-16T12:00:00.000Z", undefined)).toBeNull();
    });

    it("returns null when completedAt is before startedAt", () => {
      const startedAt = "2026-02-16T12:05:30.000Z";
      const completedAt = "2026-02-16T12:00:00.000Z";
      expect(formatTaskDuration(startedAt, completedAt)).toBeNull();
    });

    it("returns null for invalid timestamps", () => {
      expect(formatTaskDuration("invalid", "2026-02-16T12:05:30.000Z")).toBeNull();
      expect(formatTaskDuration("2026-02-16T12:00:00.000Z", "invalid")).toBeNull();
    });
  });
});
