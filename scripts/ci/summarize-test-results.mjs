#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const outputDir = path.resolve(process.cwd(), process.argv[2] ?? "artifacts/test-results");
const summaryMarkdownPath = path.join(outputDir, "ci-summary.md");
const summaryJsonPath = path.join(outputDir, "ci-summary.json");
const affectedWorkspacesPath = path.join(outputDir, "affected-workspaces.json");
const githubStepSummaryPath = process.env.GITHUB_STEP_SUMMARY?.trim() || "";

function trimText(value, max = 320) {
  const normalized = String(value ?? "")
    .replace(/\u001B\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function toRelativePath(filePath) {
  if (!filePath) return "";
  const relative = path.isAbsolute(filePath) ? path.relative(process.cwd(), filePath) : filePath;
  return relative.replace(/\\/g, "/");
}

function getWorkspaceName(filePath) {
  return path.basename(filePath).replace(/-results\.json$/u, "");
}

function summarizeWorkspace(filePath, report) {
  const workspace = getWorkspaceName(filePath);
  const testResults = Array.isArray(report?.testResults) ? report.testResults : [];
  const failures = [];

  for (const testFile of testResults) {
    const assertionResults = Array.isArray(testFile?.assertionResults)
      ? testFile.assertionResults
      : [];
    const failedAssertions = assertionResults.filter((assertion) => assertion?.status === "failed");

    for (const assertion of failedAssertions) {
      const failureMessages = Array.isArray(assertion?.failureMessages)
        ? assertion.failureMessages
        : [];
      const message =
        trimText(failureMessages.find((entry) => trimText(entry))) ||
        trimText(testFile?.message) ||
        "No failure message captured.";
      failures.push({
        file: toRelativePath(testFile?.name),
        name: assertion?.fullName || assertion?.title || "(unnamed test)",
        message,
      });
    }

    if (failedAssertions.length === 0 && testFile?.status === "failed") {
      const fileMessage = trimText(testFile?.message);
      if (fileMessage) {
        failures.push({
          file: toRelativePath(testFile?.name),
          name: "(file-level failure)",
          message: fileMessage,
        });
      }
    }
  }

  return {
    workspace,
    file: path.basename(filePath),
    numTotalTestSuites: report?.numTotalTestSuites ?? 0,
    numPassedTestSuites: report?.numPassedTestSuites ?? 0,
    numFailedTestSuites: report?.numFailedTestSuites ?? 0,
    numPendingTestSuites: report?.numPendingTestSuites ?? 0,
    numTotalTests: report?.numTotalTests ?? 0,
    numPassedTests: report?.numPassedTests ?? 0,
    numFailedTests: report?.numFailedTests ?? 0,
    numPendingTests: report?.numPendingTests ?? 0,
    numTodoTests: report?.numTodoTests ?? 0,
    success: Boolean(report?.success),
    failures,
  };
}

function buildMarkdown({ generatedAt, affectedWorkspaces, workspaces, parseErrors }) {
  const lines = ["# CI Test Summary", "", `Generated: ${generatedAt}`, ""];

  if (affectedWorkspaces.length > 0) {
    lines.push(`Affected workspaces: ${affectedWorkspaces.join(", ")}`, "");
  }

  if (workspaces.length === 0) {
    lines.push("No Vitest JSON reports were found.");
  } else {
    lines.push("## Workspace Status", "");
    for (const workspace of workspaces) {
      lines.push(
        `- ${workspace.workspace}: ${workspace.numPassedTests} passed, ${workspace.numFailedTests} failed, ${workspace.numPendingTests} skipped, ${workspace.numTodoTests} todo`
      );
    }

    const failingWorkspaces = workspaces.filter((workspace) => workspace.failures.length > 0);
    lines.push("");
    if (failingWorkspaces.length === 0) {
      lines.push("No failing tests were captured in the Vitest JSON reports.");
    } else {
      lines.push("## Failing Tests", "");
      for (const workspace of failingWorkspaces) {
        lines.push(`### ${workspace.workspace}`, "");
        for (const failure of workspace.failures) {
          const location = failure.file ? `\`${failure.file}\`` : "`(unknown file)`";
          lines.push(`- ${location} :: ${failure.name}`);
          lines.push(`  - ${failure.message}`);
        }
        lines.push("");
      }
    }
  }

  if (parseErrors.length > 0) {
    lines.push("## Parse Errors", "");
    for (const parseError of parseErrors) {
      lines.push(`- \`${parseError.file}\`: ${parseError.message}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

async function writeGitHubStepSummary(markdown) {
  if (!githubStepSummaryPath) return;
  await fs.mkdir(path.dirname(githubStepSummaryPath), { recursive: true });
  await fs.appendFile(githubStepSummaryPath, `${markdown}\n`, "utf8");
}

async function readAffectedWorkspaces() {
  try {
    const raw = JSON.parse(await fs.readFile(affectedWorkspacesPath, "utf8"));
    return Array.isArray(raw?.workspaces)
      ? raw.workspaces.filter((entry) => typeof entry === "string" && entry.trim())
      : [];
  } catch {
    return [];
  }
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  const dirEntries = await fs.readdir(outputDir, { withFileTypes: true }).catch(() => []);
  const resultFiles = dirEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith("-results.json"))
    .map((entry) => path.join(outputDir, entry.name))
    .sort();

  const affectedWorkspaces = await readAffectedWorkspaces();
  const workspaces = [];
  const parseErrors = [];

  for (const filePath of resultFiles) {
    try {
      const report = JSON.parse(await fs.readFile(filePath, "utf8"));
      workspaces.push(summarizeWorkspace(filePath, report));
    } catch (error) {
      parseErrors.push({
        file: path.basename(filePath),
        message: trimText(
          (error && typeof error === "object" && "message" in error && error.message) || error
        ),
      });
    }
  }

  const generatedAt = new Date().toISOString();
  const summary = {
    generatedAt,
    affectedWorkspaces,
    workspaces,
    parseErrors,
  };
  const markdown = buildMarkdown(summary);

  await fs.writeFile(summaryJsonPath, JSON.stringify(summary, null, 2), "utf8");
  await fs.writeFile(summaryMarkdownPath, markdown, "utf8");
  await writeGitHubStepSummary(markdown);
}

await main();
