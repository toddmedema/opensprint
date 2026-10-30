import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sharedRoot = resolve(__dirname, "../..");
const repoRoot = resolve(sharedRoot, "../..");
const scriptPath = resolve(repoRoot, "scripts/ci/summarize-test-results.mjs");

function makeVitestReport(testPath: string) {
  return {
    numTotalTestSuites: 1,
    numPassedTestSuites: 0,
    numFailedTestSuites: 1,
    numPendingTestSuites: 0,
    numTotalTests: 2,
    numPassedTests: 1,
    numFailedTests: 1,
    numPendingTests: 0,
    numTodoTests: 0,
    success: false,
    testResults: [
      {
        name: testPath,
        status: "failed",
        assertionResults: [
          {
            status: "failed",
            fullName:
              "ProjectSettingsPage navigating to ?tab=workflow shows Workflow tab active and workflow content",
            title: "shows Workflow tab active and workflow content",
            failureMessages: [
              'TestingLibraryElementError: Unable to find an element by: [data-testid="workflow-tab-content"]',
            ],
          },
        ],
      },
    ],
  };
}

describe("summarize-test-results script", () => {
  it.each([
    "/Users/todd/opensprint/packages/frontend/src/pages/ProjectSettingsPage.test.tsx",
    "C:\\repo\\packages\\frontend\\src\\pages\\ProjectSettingsPage.test.tsx",
  ])(
    "writes portable artifact paths and mirrors markdown to GITHUB_STEP_SUMMARY (%s)",
    (testPath) => {
      const tmpRoot = mkdtempSync(join(tmpdir(), "opensprint-ci-summary-"));
      const outputDir = join(tmpRoot, "artifacts", "test-results");
      const stepSummaryPath = join(tmpRoot, "step-summary.md");

      try {
        mkdirSync(outputDir, { recursive: true });
        writeFileSync(
          join(outputDir, "frontend-results.json"),
          JSON.stringify(makeVitestReport(testPath), null, 2),
          "utf8"
        );
        writeFileSync(
          join(outputDir, "affected-workspaces.json"),
          JSON.stringify({ workspaces: ["frontend"] }, null, 2),
          "utf8"
        );

        const result = spawnSync(process.execPath, [scriptPath, outputDir], {
          cwd: repoRoot,
          env: {
            ...process.env,
            GITHUB_STEP_SUMMARY: stepSummaryPath,
          },
          encoding: "utf8",
        });

        expect(result.status).toBe(0);

        const markdown = readFileSync(join(outputDir, "ci-summary.md"), "utf8");
        const stepSummary = readFileSync(stepSummaryPath, "utf8");
        const summaryJson = JSON.parse(readFileSync(join(outputDir, "ci-summary.json"), "utf8"));

        expect(markdown).toContain("# CI Test Summary");
        expect(markdown).toContain("Affected workspaces: frontend");
        expect(markdown).toContain("src/pages/ProjectSettingsPage.test.tsx");
        expect(markdown).toContain("workflow-tab-content");
        expect(stepSummary).toContain(markdown.trim());
        expect(summaryJson.workspaces).toHaveLength(1);
        expect(summaryJson.workspaces[0]).toMatchObject({
          workspace: "frontend",
          numFailedTests: 1,
        });
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    }
  );
});
