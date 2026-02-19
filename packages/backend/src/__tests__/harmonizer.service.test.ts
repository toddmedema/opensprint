import { describe, it, expect } from "vitest";
import {
  buildHarmonizerPromptBuildIt,
  buildHarmonizerPromptScopeChange,
  parseHarmonizerResult,
  parseHarmonizerResultFull,
} from "../services/harmonizer.service.js";

describe("harmonizer.service", () => {
  describe("buildHarmonizerPromptBuildIt", () => {
    it("includes plan id and content", () => {
      const prompt = buildHarmonizerPromptBuildIt("auth-plan", "# Auth\n\nContent");
      expect(prompt).toContain("auth-plan");
      expect(prompt).toContain("# Auth");
      expect(prompt).toContain("build_it");
    });

    it("includes valid section keys", () => {
      const prompt = buildHarmonizerPromptBuildIt("x", "y");
      expect(prompt).toContain("executive_summary");
      expect(prompt).toContain("technical_architecture");
    });
  });

  describe("buildHarmonizerPromptScopeChange", () => {
    it("includes feedback text", () => {
      const prompt = buildHarmonizerPromptScopeChange("Add dark mode");
      expect(prompt).toContain("Add dark mode");
      expect(prompt).toContain("scope_change");
    });
  });

  describe("parseHarmonizerResult", () => {
    it("parses no_changes_needed", () => {
      const result = parseHarmonizerResult('{"status":"no_changes_needed"}');
      expect(result).toEqual({ status: "no_changes_needed", prdUpdates: [] });
    });

    it("parses success with prd_updates", () => {
      const content = JSON.stringify({
        status: "success",
        prd_updates: [{ section: "feature_list", action: "update", content: "New feature" }],
      });
      const result = parseHarmonizerResult(content);
      expect(result?.status).toBe("success");
      expect(result?.prdUpdates).toHaveLength(1);
      expect(result?.prdUpdates[0]).toEqual({
        section: "feature_list",
        content: "New feature",
      });
    });

    it("returns no_changes_needed when success with empty prd_updates", () => {
      const content = JSON.stringify({ status: "success", prd_updates: [] });
      const result = parseHarmonizerResult(content);
      expect(result?.status).toBe("no_changes_needed");
      expect(result?.prdUpdates).toHaveLength(0);
    });

    it("filters invalid section keys", () => {
      const content = JSON.stringify({
        status: "success",
        prd_updates: [
          { section: "feature_list", action: "update", content: "Valid" },
          { section: "invalid_section", action: "update", content: "Skip" },
        ],
      });
      const result = parseHarmonizerResult(content);
      expect(result?.prdUpdates).toHaveLength(1);
      expect(result?.prdUpdates[0].section).toBe("feature_list");
    });

    it("returns null for unparseable content without legacy", () => {
      const result = parseHarmonizerResult("random text");
      expect(result).toBeNull();
    });
  });

  describe("parseHarmonizerResultFull", () => {
    it("parses success with change_log_entry", () => {
      const content = JSON.stringify({
        status: "success",
        prd_updates: [
          {
            section: "feature_list",
            action: "update",
            content: "New feature",
            change_log_entry: "Add dark mode support",
          },
        ],
      });
      const result = parseHarmonizerResultFull(content);
      expect(result?.status).toBe("success");
      expect(result?.prdUpdates).toHaveLength(1);
      expect(result?.prdUpdates[0]).toEqual({
        section: "feature_list",
        content: "New feature",
        changeLogEntry: "Add dark mode support",
      });
    });

    it("parses no_changes_needed", () => {
      const result = parseHarmonizerResultFull('{"status":"no_changes_needed"}');
      expect(result).toEqual({ status: "no_changes_needed", prdUpdates: [] });
    });
  });
});
