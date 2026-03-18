import { describe, expect, it } from "vitest";
import {
  buildOrchestratorTestStatusContent,
  buildTestFailureRetrySummary,
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
      testCommand: "node ./node_modules/vitest/vitest.mjs run",
      mergeQualityGates: ["npm run build", "npm run lint", "npm run test"],
      results: {
        passed: 12,
        failed: 2,
        skipped: 0,
        total: 14,
        details: [
          {
            name: "src/foo.test.ts > auth > rejects invalid token",
            status: "failed",
            duration: 7,
          },
          {
            name: "src/bar.test.ts > auth > allows valid token",
            status: "failed",
            duration: 5,
          },
        ],
      },
      rawOutput: [
        " FAIL  src/foo.test.ts > auth > rejects invalid token",
        "AssertionError: expected 401 to be 403 // Object.is equality",
        "",
        " FAIL  src/bar.test.ts > auth > allows valid token",
        "TypeError: Cannot read properties of undefined (reading 'id')",
      ].join("\n"),
      updatedAt: "2026-03-04T00:00:00.000Z",
    });

    expect(content).toContain("Status: `FAILED`");
    expect(content).toContain(
      "Merge quality gates: `npm run build`, `npm run lint`, `npm run test`"
    );
    expect(content).toContain("Passed: 12");
    expect(content).toContain("Failed: 2");
    expect(content).toContain("## Primary Diagnostic");
    expect(content).toContain("Failed command: `node ./node_modules/vitest/vitest.mjs run`");
    expect(content).toContain("First failure: AssertionError: expected 401 to be 403");
    expect(content).toContain("## Highlighted Failures");
    expect(content).toContain(
      "src/foo.test.ts > auth > rejects invalid token — AssertionError: expected 401 to be 403"
    );
    expect(content).toContain(
      "src/bar.test.ts > auth > allows valid token — TypeError: Cannot read properties of undefined"
    );
    expect(content).toContain("## Output Snippet");
    expect(content).toContain("Do not approve this implementation");
    expect(content).toContain("Full raw output is omitted by default");
  });

  it("extracts jest-style failure names even when the raw file header is generic", () => {
    const content = buildOrchestratorTestStatusContent({
      status: "failed",
      testCommand: "npx jest",
      results: {
        passed: 0,
        failed: 1,
        skipped: 0,
        total: 1,
        details: [],
      },
      rawOutput: [
        "FAIL src/auth.test.ts",
        "  ● auth middleware › rejects missing token",
        "",
        "    expect(received).toBe(expected) // Object.is equality",
      ].join("\n"),
    });

    expect(content).toContain("auth middleware › rejects missing token");
    expect(content).toContain("expect(received).toBe(expected)");
  });

  it("includes optional full raw output only when explicitly enabled", () => {
    const previous = process.env.OPENSPRINT_INCLUDE_FULL_TEST_OUTPUT;
    process.env.OPENSPRINT_INCLUDE_FULL_TEST_OUTPUT = "1";
    try {
      const content = buildOrchestratorTestStatusContent({
        status: "failed",
        testCommand: "npx jest",
        results: {
          passed: 0,
          failed: 1,
          skipped: 0,
          total: 1,
          details: [],
        },
        rawOutput: "FAIL src/auth.test.ts\nTypeError: broken",
      });

      expect(content).toContain("<details>");
      expect(content).toContain("<summary>Full Raw Output</summary>");
      expect(content).toContain("FAIL src/auth.test.ts");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENSPRINT_INCLUDE_FULL_TEST_OUTPUT;
      } else {
        process.env.OPENSPRINT_INCLUDE_FULL_TEST_OUTPUT = previous;
      }
    }
  });

  it("builds a concise retry summary for coder retries", () => {
    const summary = buildTestFailureRetrySummary(
      {
        passed: 0,
        failed: 2,
        skipped: 0,
        total: 2,
        details: [
          {
            name: "src/foo.test.ts > auth > rejects invalid token",
            status: "failed",
            duration: 7,
          },
          {
            name: "src/bar.test.ts > auth > allows valid token",
            status: "failed",
            duration: 5,
          },
        ],
      },
      [
        " FAIL  src/foo.test.ts > auth > rejects invalid token",
        "AssertionError: expected 401 to be 403 // Object.is equality",
        "",
        " FAIL  src/bar.test.ts > auth > allows valid token",
        "TypeError: Cannot read properties of undefined (reading 'id')",
      ].join("\n")
    );

    expect(summary).toContain(
      "- src/foo.test.ts > auth > rejects invalid token — AssertionError: expected 401 to be 403"
    );
    expect(summary).toContain(
      "- src/bar.test.ts > auth > allows valid token — TypeError: Cannot read properties of undefined"
    );
  });
});
