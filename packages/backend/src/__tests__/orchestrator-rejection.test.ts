import { describe, it, expect } from "vitest";
import { formatReviewFeedback } from "../services/orchestrator.service.js";
import type { ReviewAgentResult } from "@opensprint/shared";

describe("orchestrator rejection flow", () => {
  describe("formatReviewFeedback", () => {
    it("formats result with summary only", () => {
      const result: ReviewAgentResult = {
        status: "rejected",
        summary: "Tests do not adequately cover the ticket scope.",
        notes: "",
      };
      expect(formatReviewFeedback(result)).toBe(
        "Tests do not adequately cover the ticket scope.",
      );
    });

    it("formats result with summary and issues", () => {
      const result: ReviewAgentResult = {
        status: "rejected",
        summary: "Implementation has quality issues.",
        issues: ["Missing error handling", "Tests do not cover edge cases"],
        notes: "",
      };
      const formatted = formatReviewFeedback(result);
      expect(formatted).toContain("Implementation has quality issues.");
      expect(formatted).toContain("Issues to address:");
      expect(formatted).toContain("- Missing error handling");
      expect(formatted).toContain("- Tests do not cover edge cases");
    });

    it("formats result with summary, issues, and notes", () => {
      const result: ReviewAgentResult = {
        status: "rejected",
        summary: "Code quality needs improvement.",
        issues: ["Add input validation"],
        notes: "Consider using a schema validator.",
      };
      const formatted = formatReviewFeedback(result);
      expect(formatted).toContain("Code quality needs improvement.");
      expect(formatted).toContain("- Add input validation");
      expect(formatted).toContain("Notes: Consider using a schema validator.");
    });

    it("formats result with empty notes", () => {
      const result: ReviewAgentResult = {
        status: "rejected",
        summary: "Rejected.",
        notes: "   ",
      };
      expect(formatReviewFeedback(result)).toBe("Rejected.");
    });
  });
});
