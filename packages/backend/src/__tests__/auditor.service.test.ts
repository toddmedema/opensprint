import { describe, it, expect } from "vitest";
import { buildAuditorPrompt, parseAuditorResult } from "../services/auditor.service.js";

describe("auditor.service", () => {
  describe("buildAuditorPrompt", () => {
    it("includes plan_id and epic_id in prompt", () => {
      const prompt = buildAuditorPrompt("auth-plan", "bd-abc123");
      expect(prompt).toContain("auth-plan");
      expect(prompt).toContain("bd-abc123");
      expect(prompt).toContain("file_tree.txt");
      expect(prompt).toContain("key_files");
      expect(prompt).toContain("completed_tasks.json");
      expect(prompt).toContain("plan_old.md");
      expect(prompt).toContain("plan_new.md");
    });
  });

  describe("parseAuditorResult", () => {
    it("parses success with capability_summary and tasks", () => {
      const content = JSON.stringify({
        status: "success",
        capability_summary: "## Features\n- Auth implemented",
        tasks: [
          { index: 0, title: "Add endpoint", description: "...", priority: 1, depends_on: [] },
          { index: 1, title: "Add tests", description: "...", priority: 2, depends_on: [0] },
        ],
      });
      const result = parseAuditorResult(content);
      expect(result).toEqual({
        status: "success",
        capability_summary: "## Features\n- Auth implemented",
        tasks: [
          { index: 0, title: "Add endpoint", description: "...", priority: 1, depends_on: [] },
          { index: 1, title: "Add tests", description: "...", priority: 2, depends_on: [0] },
        ],
      });
    });

    it("parses success with capability_summary but no tasks", () => {
      const content = '{"status":"success","capability_summary":"# Summary"}';
      const result = parseAuditorResult(content);
      expect(result).toEqual({ status: "success", capability_summary: "# Summary" });
    });

    it("parses success from markdown code block", () => {
      const content = '```json\n{"status":"success","capability_summary":"# Summary"}\n```';
      const result = parseAuditorResult(content);
      expect(result).toEqual({ status: "success", capability_summary: "# Summary" });
    });

    it("parses no_changes_needed", () => {
      const result = parseAuditorResult(
        '{"status":"no_changes_needed","capability_summary":"# All good"}'
      );
      expect(result).toEqual({ status: "no_changes_needed", capability_summary: "# All good" });
    });

    it("returns null for invalid JSON", () => {
      expect(parseAuditorResult("not json")).toBeNull();
      expect(parseAuditorResult("{}")).toBeNull();
    });

    it("parses failed status", () => {
      const result = parseAuditorResult('{"status":"failed"}');
      expect(result).toEqual({ status: "failed" });
    });

    it("treats success without capability_summary as no_changes_needed", () => {
      const result = parseAuditorResult('{"status":"success"}');
      expect(result).toEqual({ status: "no_changes_needed" });
    });

    it("treats success with empty tasks as no_changes_needed", () => {
      const result = parseAuditorResult('{"status":"success","tasks":[]}');
      expect(result).toEqual({ status: "no_changes_needed" });
    });

    it("clamps priority to 0-4", () => {
      const result = parseAuditorResult(
        '{"status":"success","capability_summary":"# X","tasks":[{"index":0,"title":"X","description":"","priority":10,"depends_on":[]}]}'
      );
      expect(result?.tasks?.[0].priority).toBe(4);
    });

    it("accepts camelCase dependsOn from Planner (aligns with API validation)", () => {
      const content = JSON.stringify({
        status: "success",
        capability_summary: "## Features",
        tasks: [
          { index: 0, title: "Task A", description: "First", priority: 1, dependsOn: [] },
          { index: 1, title: "Task B", description: "Second", priority: 2, dependsOn: [0] },
        ],
      });
      const result = parseAuditorResult(content);
      expect(result?.tasks).toHaveLength(2);
      expect(result?.tasks?.[0].depends_on).toEqual([]);
      expect(result?.tasks?.[1].depends_on).toEqual([0]);
    });

    it("parses complexity (1-10) when provided, migrates legacy simple/complex to 3/7", () => {
      const content = JSON.stringify({
        status: "success",
        capability_summary: "## Features",
        tasks: [
          { index: 0, title: "Easy task", description: "...", priority: 1, depends_on: [], complexity: "low" },
          { index: 1, title: "Hard task", description: "...", priority: 2, depends_on: [0], complexity: "high" },
        ],
      });
      const result = parseAuditorResult(content);
      expect(result?.tasks?.[0].complexity).toBe(3);
      expect(result?.tasks?.[1].complexity).toBe(7);
    });

    it("omits complexity when invalid or absent", () => {
      const content = JSON.stringify({
        status: "success",
        capability_summary: "## Features",
        tasks: [
          { index: 0, title: "Task", description: "...", priority: 1, depends_on: [], complexity: "medium" },
        ],
      });
      const result = parseAuditorResult(content);
      expect(result?.tasks?.[0]).not.toHaveProperty("complexity");
    });

    it("accepts task_list (snake_case) and task_title, task_description, task_priority", () => {
      const content = JSON.stringify({
        status: "success",
        capability_summary: "## Features",
        task_list: [
          {
            index: 0,
            task_title: "Setup",
            task_description: "Setup step",
            task_priority: 0,
            depends_on: [],
          },
          {
            index: 1,
            task_title: "Implement",
            task_description: "Implement step",
            task_priority: 1,
            depends_on: [0],
          },
        ],
      });
      const result = parseAuditorResult(content);
      expect(result?.tasks).toHaveLength(2);
      expect(result?.tasks?.[0]).toMatchObject({
        title: "Setup",
        description: "Setup step",
        priority: 0,
      });
      expect(result?.tasks?.[1]).toMatchObject({
        title: "Implement",
        description: "Implement step",
        priority: 1,
        depends_on: [0],
      });
    });
  });
});
