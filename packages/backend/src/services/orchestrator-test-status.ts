import path from "path";
import { OPENSPRINT_PATHS, type TestResults } from "@opensprint/shared";

export const ORCHESTRATOR_TEST_STATUS_FILE = "orchestrator-test-status.md";
const MAX_OUTPUT_CHARS = 20_000;

export type OrchestratorTestStatus =
  | {
      status: "pending";
      testCommand?: string | null;
      updatedAt?: string;
    }
  | {
      status: "passed";
      testCommand?: string | null;
      results?: TestResults | null;
      updatedAt?: string;
    }
  | {
      status: "failed";
      testCommand?: string | null;
      results?: TestResults | null;
      rawOutput?: string | null;
      updatedAt?: string;
    }
  | {
      status: "error";
      testCommand?: string | null;
      errorMessage?: string | null;
      rawOutput?: string | null;
      updatedAt?: string;
    };

export function getOrchestratorTestStatusPromptPath(taskId: string): string {
  return `${OPENSPRINT_PATHS.active}/${taskId}/context/${ORCHESTRATOR_TEST_STATUS_FILE}`;
}

export function getOrchestratorTestStatusFsPath(basePath: string, taskId: string): string {
  return path.join(basePath, OPENSPRINT_PATHS.active, taskId, "context", ORCHESTRATOR_TEST_STATUS_FILE);
}

export function buildOrchestratorTestStatusContent(status: OrchestratorTestStatus): string {
  const updatedAt = status.updatedAt ?? new Date().toISOString();
  const command = status.testCommand?.trim() || "(not configured)";
  let content = "# Orchestrator Test Status\n\n";
  content += `- Status: \`${status.status.toUpperCase()}\`\n`;
  content += `- Updated: \`${updatedAt}\`\n`;
  content += `- Validation command: \`${command}\`\n\n`;

  switch (status.status) {
    case "pending":
      content +=
        "The orchestrator is still running automated validation. Before approving, re-open this file. Do not approve while the status is `PENDING`.\n";
      break;
    case "passed":
      content += buildResultsSummary(status.results);
      content += "\nAutomated validation has passed.\n";
      break;
    case "failed":
      content += buildResultsSummary(status.results);
      content +=
        "\nAutomated validation failed. Do not approve this implementation while this file shows `FAILED`.\n";
      content += buildRawOutputSection(status.rawOutput);
      break;
    case "error":
      content +=
        "The orchestrator could not complete automated validation. Do not approve this implementation while this file shows `ERROR`.\n";
      if (status.errorMessage?.trim()) {
        content += `\n## Error\n\n${status.errorMessage.trim()}\n`;
      }
      content += buildRawOutputSection(status.rawOutput);
      break;
  }

  return content;
}

function buildResultsSummary(results?: TestResults | null): string {
  if (!results) {
    return "No structured test summary was available.\n";
  }

  return [
    "## Summary",
    "",
    `- Passed: ${results.passed}`,
    `- Failed: ${results.failed}`,
    `- Skipped: ${results.skipped}`,
    `- Total: ${results.total}`,
    "",
  ].join("\n");
}

function buildRawOutputSection(rawOutput?: string | null): string {
  const trimmed = rawOutput?.trim();
  if (!trimmed) return "";

  const clipped =
    trimmed.length > MAX_OUTPUT_CHARS ? `${trimmed.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated]` : trimmed;

  return `\n## Raw Output\n\n\`\`\`text\n${clipped}\n\`\`\`\n`;
}
