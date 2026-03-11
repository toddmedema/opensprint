import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import {
  isMeaningfulNoResultFragment,
  extractStructuredNoResultErrorFromJsonLine,
  extractNoResultReasonFromOutput,
  extractNoResultReasonFromLogs,
  buildReviewNoResultFailureReason,
} from "../services/no-result-reason.service.js";

vi.mock("fs/promises");

describe("no-result-reason.service", () => {
  describe("isMeaningfulNoResultFragment", () => {
    it("returns true for strings with alphanumeric content", () => {
      expect(isMeaningfulNoResultFragment("error")).toBe(true);
      expect(isMeaningfulNoResultFragment("Error 123")).toBe(true);
      expect(isMeaningfulNoResultFragment("  x  ")).toBe(true);
    });
    it("returns false for punctuation/whitespace only", () => {
      expect(isMeaningfulNoResultFragment("")).toBe(false);
      expect(isMeaningfulNoResultFragment("   \n")).toBe(false);
      expect(isMeaningfulNoResultFragment("}\n")).toBe(false);
    });
  });

  describe("extractStructuredNoResultErrorFromJsonLine", () => {
    it("extracts message from type=error JSON line", () => {
      const line = '{"type":"error","message":"Security command failed"}';
      expect(extractStructuredNoResultErrorFromJsonLine(line)).toBe("Security command failed");
    });
    it("returns undefined for non-JSON or init lines", () => {
      expect(extractStructuredNoResultErrorFromJsonLine("")).toBeUndefined();
      expect(extractStructuredNoResultErrorFromJsonLine('{"type":"system","subtype":"init"}')).toBeUndefined();
    });
  });

  describe("extractNoResultReasonFromOutput", () => {
    it("extracts structured error from JSON output", () => {
      const reason = extractNoResultReasonFromOutput([
        '{"type":"system","subtype":"init"}\n',
        '{"type":"error","message":"Security command failed: code 45"}\n',
      ]);
      expect(reason).toContain("Security command failed");
    });
    it("returns undefined for punctuation-only output", () => {
      expect(extractNoResultReasonFromOutput(["}\n", " \n"])).toBeUndefined();
    });
  });

  describe("buildReviewNoResultFailureReason", () => {
    it("formats angle-aware no_result reasons", () => {
      const reason = buildReviewNoResultFailureReason({
        status: "no_result",
        result: null,
        exitCode: 1,
        failureContext: [
          { angle: "security", exitCode: 1, reason: "missing result.json" },
          { angle: "performance", exitCode: 0 },
        ],
      });
      expect(reason).toContain("security");
      expect(reason).toContain("performance");
      expect(reason).toContain("missing result.json");
    });
    it("returns generic message when no context", () => {
      const reason = buildReviewNoResultFailureReason({
        status: "no_result",
        result: null,
        exitCode: null,
      });
      expect(reason).toBe("One or more review agents exited without producing a valid result");
    });
  });

  describe("extractNoResultReasonFromLogs", () => {
    beforeEach(() => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("not found"));
    });

    it("uses in-memory output when present", async () => {
      const reason = await extractNoResultReasonFromLogs("/wt", "task-1", [
        '{"type":"error","message":"API key invalid"}\n',
      ]);
      expect(reason).toContain("API key invalid");
    });
    it("returns undefined when memory and file have no reason", async () => {
      const reason = await extractNoResultReasonFromLogs("/wt", "task-1", ["}\n"]);
      expect(reason).toBeUndefined();
    });
  });
});
