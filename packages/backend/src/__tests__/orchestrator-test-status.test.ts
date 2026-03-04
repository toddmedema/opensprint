import { describe, expect, it } from "vitest";
import {
  buildOrchestratorTestStatusContent,
  getOrchestratorTestStatusPromptPath,
} from "../services/orchestrator-test-status.js";

describe("orchestrator-test-status", () => {
  it("builds a prompt path under the task context directory", () => {
    expect(getOrchestratorTestStatusPromptPath("os-1234")).toBe(
      ".opensprint/active/os-1234/context/orchestrator-test-status.md"
    );
  });

  it("renders failing test details for reviewers", () => {
    const content = buildOrchestratorTestStatusContent({
      status: "failed",
      testCommand: "npx vitest run",
      results: {
        passed: 12,
        failed: 2,
        skipped: 0,
        total: 14,
        details: [],
      },
      rawOutput: "FAIL src/foo.test.ts\nExpected true to be false",
      updatedAt: "2026-03-04T00:00:00.000Z",
    });

    expect(content).toContain("Status: `FAILED`");
    expect(content).toContain("Passed: 12");
    expect(content).toContain("Failed: 2");
    expect(content).toContain("Do not approve this implementation");
    expect(content).toContain("FAIL src/foo.test.ts");
  });
});
