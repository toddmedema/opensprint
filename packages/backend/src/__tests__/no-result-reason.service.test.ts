import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs/promises";
import {
  isMeaningfulNoResultFragment,
  extractStructuredNoResultErrorFromJsonLine,
  extractStructuredAssistantTextFromJsonLine,
  extractStructuredTerminalResultFromJsonLine,
  extractNoResultReasonFromOutput,
  extractNoResultReasonFromLogs,
  buildReviewNoResultFailureReason,
  synthesizeCodingResultFromOutput,
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
      expect(
        extractStructuredNoResultErrorFromJsonLine('{"type":"system","subtype":"init"}')
      ).toBeUndefined();
    });
  });

  describe("extractStructuredTerminalResultFromJsonLine", () => {
    it("extracts terminal result text from structured NDJSON output", () => {
      const line =
        '{"type":"result","subtype":"success","result":"Unexpected workspace change detected.\\n\\nHow do you want me to proceed?"}';
      expect(extractStructuredTerminalResultFromJsonLine(line)).toEqual(
        expect.objectContaining({
          subtype: "success",
          text: expect.stringContaining("How do you want me to proceed?"),
          isError: false,
        })
      );
    });

    it("returns undefined for non-result JSON lines", () => {
      expect(
        extractStructuredTerminalResultFromJsonLine('{"type":"assistant","message":"hi"}')
      ).toBeUndefined();
    });
  });

  describe("extractStructuredAssistantTextFromJsonLine", () => {
    it("extracts assistant message text from structured NDJSON output", () => {
      const line =
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"How do you want me to proceed?"}]}}';
      expect(extractStructuredAssistantTextFromJsonLine(line)).toEqual({
        text: "How do you want me to proceed?",
      });
    });

    it("returns undefined for non-assistant JSON lines", () => {
      expect(
        extractStructuredAssistantTextFromJsonLine('{"type":"result","result":"done"}')
      ).toBeUndefined();
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

    it("extracts the final clarification request from terminal result output", () => {
      const reason = extractNoResultReasonFromOutput([
        '{"type":"result","subtype":"success","result":"Unexpected workspace change detected while running the baseline gates.\\n\\nHow do you want me to proceed?\\n- keep the formatting change\\n- leave it out"}\n',
      ]);

      expect(reason).toContain("Unexpected workspace change detected");
    });

    it("prefers actionable progress over generic kickoff narration", () => {
      const reason = extractNoResultReasonFromOutput([
        "The user wants me to restore the baseline quality gates on main.\n\n",
        "I'll start by reading the relevant test files.\n\n",
        "Both test files pass. Now run full quality gates from the repo root.\n",
      ]);

      expect(reason).toBe("Both test files pass.");
    });
  });

  describe("synthesizeCodingResultFromOutput", () => {
    it("converts terminal clarification output into failed result with open questions", () => {
      const result = synthesizeCodingResultFromOutput([
        '{"type":"result","subtype":"success","result":"Unexpected workspace change detected while running the baseline gates: packages/frontend/vite.config.js was reformatted.\\n\\nHow do you want me to proceed?\\n- keep this formatting change and include it in commits\\n- leave it out and continue with only the baseline-gate fixes."}\n',
      ]);

      expect(result).toEqual(
        expect.objectContaining({
          status: "failed",
          open_questions: [
            expect.objectContaining({
              id: "q1",
              text: expect.stringContaining("How do you want me to proceed?"),
            }),
          ],
          notes: expect.stringContaining("Unexpected workspace change detected"),
        })
      );
    });

    it("converts assistant chat clarification output into failed result with open questions", () => {
      const result = synthesizeCodingResultFromOutput([
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Unexpected workspace change detected while running the baseline gates.\\n\\nHow do you want me to proceed?\\n- keep this formatting change and include it in commits\\n- leave it out and continue with only the baseline-gate fixes."}]}}\n',
      ]);

      expect(result).toEqual(
        expect.objectContaining({
          status: "failed",
          open_questions: [
            expect.objectContaining({
              text: expect.stringContaining("How do you want me to proceed?"),
            }),
          ],
        })
      );
    });

    it("converts plain-text clarification output into failed result with open questions", () => {
      const result = synthesizeCodingResultFromOutput([
        "Unexpected workspace change detected while running the baseline gates.\n\nHow do you want me to proceed?\n- keep the formatting change\n- leave it out\n",
      ]);

      expect(result).toEqual(
        expect.objectContaining({
          status: "failed",
          open_questions: [
            expect.objectContaining({
              text: expect.stringContaining("How do you want me to proceed?"),
            }),
          ],
        })
      );
    });

    it("converts terminal result text into actionable failure summary when no question is present", () => {
      const result = synthesizeCodingResultFromOutput([
        '{"type":"result","subtype":"success","result":"Validation passed, but I exited before writing result.json."}\n',
      ]);

      expect(result).toEqual(
        expect.objectContaining({
          status: "failed",
          summary: expect.stringContaining("Agent exited without writing result.json"),
          notes: "Validation passed, but I exited before writing result.json.",
        })
      );
      expect(result?.open_questions).toBeUndefined();
    });

    it("skips generic kickoff narration when synthesizing no-result summaries", () => {
      const result = synthesizeCodingResultFromOutput([
        "The user wants me to restore the baseline quality gates on main.\n\n",
        "Let me inspect the failing tests.\n\n",
        "Both test files pass. Now run full quality gates from the repo root.\n",
      ]);

      expect(result).toEqual(
        expect.objectContaining({
          status: "failed",
          summary: "Agent exited without writing result.json: Both test files pass.",
        })
      );
      expect(result?.notes).toContain("The user wants me to restore");
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
