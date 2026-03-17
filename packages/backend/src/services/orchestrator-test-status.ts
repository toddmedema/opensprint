import path from "path";
import { OPENSPRINT_PATHS, type TestResults } from "@opensprint/shared";

export const ORCHESTRATOR_TEST_STATUS_FILE = "orchestrator-test-status.md";
const MAX_OUTPUT_SNIPPET_CHARS = 1_800;
const MAX_OUTPUT_SNIPPET_LINES = 40;
const MAX_OUTPUT_CHARS = 20_000;
const MAX_HIGHLIGHTED_FAILURES = 8;
const PRIMARY_ERROR_NOISE_PATTERNS: RegExp[] = [
  /^>\s+/,
  /^at\s+/i,
  /^❯\s+/,
  /^›\s+/,
  /^node:/i,
  /^[-=]{3,}$/,
  /^⎯+/,
  /^Test Files\b/i,
  /^Tests\b/i,
  /^Start at\b/i,
  /^Duration\b/i,
  /^npm (err!|error)\s+(code|path|command|errno|syscall|lifecycle)\b/i,
];

export type OrchestratorTestStatus =
  | {
      status: "pending";
      testCommand?: string | null;
      mergeQualityGates?: string[] | null;
      updatedAt?: string;
    }
  | {
      status: "passed";
      testCommand?: string | null;
      mergeQualityGates?: string[] | null;
      results?: TestResults | null;
      updatedAt?: string;
    }
  | {
      status: "failed";
      testCommand?: string | null;
      mergeQualityGates?: string[] | null;
      results?: TestResults | null;
      rawOutput?: string | null;
      updatedAt?: string;
    }
  | {
      status: "error";
      testCommand?: string | null;
      mergeQualityGates?: string[] | null;
      errorMessage?: string | null;
      rawOutput?: string | null;
      updatedAt?: string;
    };

export function getOrchestratorTestStatusPromptPath(taskId: string): string {
  return `${OPENSPRINT_PATHS.active}/${taskId}/context/${ORCHESTRATOR_TEST_STATUS_FILE}`;
}

export function getOrchestratorTestStatusFsPath(basePath: string, taskId: string): string {
  return path.join(
    basePath,
    OPENSPRINT_PATHS.active,
    taskId,
    "context",
    ORCHESTRATOR_TEST_STATUS_FILE
  );
}

export function buildOrchestratorTestStatusContent(status: OrchestratorTestStatus): string {
  const updatedAt = status.updatedAt ?? new Date().toISOString();
  const command = status.testCommand?.trim() || "(not configured)";
  let content = "# Orchestrator Test Status\n\n";
  content += `- Status: \`${status.status.toUpperCase()}\`\n`;
  content += `- Updated: \`${updatedAt}\`\n`;
  content += `- Validation command: \`${command}\`\n\n`;
  const mergeQualityGates =
    status.mergeQualityGates?.filter((gate) => gate.trim().length > 0).join("`, `") ?? "";
  if (mergeQualityGates) {
    content += `- Merge quality gates: \`${mergeQualityGates}\`\n\n`;
  }

  switch (status.status) {
    case "pending":
      content +=
        "The orchestrator is still running automated validation. This includes merge quality gates when configured. Before approving, re-open this file. Do not approve while the status is `PENDING`.\n";
      break;
    case "passed":
      content += buildResultsSummary(status.results);
      content +=
        mergeQualityGates.length > 0
          ? "\nAutomated validation has passed, including the configured merge quality gates.\n"
          : "\nAutomated validation has passed.\n";
      break;
    case "failed":
      content += buildResultsSummary(status.results);
      content += buildPrimaryDiagnosticSection({
        testCommand: status.testCommand,
        results: status.results,
        rawOutput: status.rawOutput,
      });
      content += buildFailureHighlightsSection(status.results, status.rawOutput);
      content +=
        "\nAutomated validation failed. Do not approve this implementation while this file shows `FAILED`.\n";
      content += buildOutputSnippetSection(status.rawOutput);
      content += buildRawOutputSection(status.rawOutput);
      break;
    case "error":
      content +=
        "The orchestrator could not complete automated validation. Do not approve this implementation while this file shows `ERROR`.\n";
      content += buildPrimaryDiagnosticSection({
        testCommand: status.testCommand,
        rawOutput: status.rawOutput,
        fallbackError: status.errorMessage,
      });
      if (status.errorMessage?.trim()) {
        content += `\n## Error\n\n${status.errorMessage.trim()}\n`;
      }
      content += buildOutputSnippetSection(status.rawOutput);
      content += buildRawOutputSection(status.rawOutput);
      break;
  }

  return content;
}

export function buildTestFailureRetrySummary(
  results?: TestResults | null,
  rawOutput?: string | null
): string | undefined {
  const highlights = mergeFailureHighlights(results, rawOutput);
  if (highlights.length === 0) return undefined;

  return highlights
    .slice(0, MAX_HIGHLIGHTED_FAILURES)
    .map((highlight) => {
      const name = highlight.name.trim();
      const error = highlight.error?.trim();
      return `- ${name}${error ? ` — ${error}` : ""}`;
    })
    .join("\n");
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
  if (!shouldIncludeFullRawOutput()) {
    return "\nFull raw output is omitted by default to reduce agent context noise. Set `OPENSPRINT_INCLUDE_FULL_TEST_OUTPUT=1` to include it.\n";
  }

  const clipped =
    trimmed.length > MAX_OUTPUT_CHARS
      ? `${trimmed.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated]`
      : trimmed;

  return `\n<details>\n<summary>Full Raw Output</summary>\n\n\`\`\`text\n${clipped}\n\`\`\`\n\n</details>\n`;
}

interface FailureHighlight {
  name: string;
  error?: string;
}

function buildFailureHighlightsSection(
  results?: TestResults | null,
  rawOutput?: string | null
): string {
  const highlights = mergeFailureHighlights(results, rawOutput);
  if (highlights.length === 0) return "";

  const lines = ["", "## Highlighted Failures", ""];
  for (const highlight of highlights) {
    const name = highlight.name.trim();
    const error = highlight.error?.trim();
    lines.push(`- ${name}${error ? ` — ${error}` : ""}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function buildPrimaryDiagnosticSection(params: {
  testCommand?: string | null;
  results?: TestResults | null;
  rawOutput?: string | null;
  fallbackError?: string | null;
}): string {
  const failedCommand = params.testCommand?.trim() || null;
  const firstHighlight = mergeFailureHighlights(params.results, params.rawOutput)[0] ?? null;
  const firstError =
    firstHighlight?.error?.trim() ||
    extractFirstMeaningfulErrorLine(params.rawOutput) ||
    params.fallbackError?.trim() ||
    null;
  if (!failedCommand && !firstError) return "";

  const lines = ["", "## Primary Diagnostic", ""];
  if (failedCommand) lines.push(`- Failed command: \`${failedCommand}\``);
  if (firstError) lines.push(`- First failure: ${firstError}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function buildOutputSnippetSection(rawOutput?: string | null): string {
  const snippet = extractOutputSnippet(rawOutput);
  if (!snippet) return "";
  return `\n## Output Snippet\n\n\`\`\`text\n${snippet}\n\`\`\`\n`;
}

function mergeFailureHighlights(
  results?: TestResults | null,
  rawOutput?: string | null
): FailureHighlight[] {
  const fromDetails = (results?.details ?? [])
    .filter((detail) => detail.status === "failed")
    .map((detail) => ({
      name: detail.name.trim(),
      ...(detail.error?.trim() ? { error: detail.error.trim() } : {}),
    }));
  const fromRaw = extractFailureHighlightsFromRawOutput(rawOutput);

  if (fromDetails.length === 0) {
    return fromRaw.slice(0, MAX_HIGHLIGHTED_FAILURES);
  }

  const remainingRaw = [...fromRaw];
  const merged: FailureHighlight[] = fromDetails.map((detail, index) => {
    let rawIndex = remainingRaw.findIndex((candidate) =>
      failureNamesMatch(detail.name, candidate.name)
    );
    if (rawIndex === -1 && !detail.error && index < remainingRaw.length) {
      rawIndex = index;
    }

    const rawMatch = rawIndex >= 0 ? remainingRaw.splice(rawIndex, 1)[0] : undefined;
    return {
      name: preferFailureName(detail.name, rawMatch?.name),
      error: detail.error ?? rawMatch?.error,
    };
  });

  for (const raw of remainingRaw) {
    if (merged.length >= MAX_HIGHLIGHTED_FAILURES) break;
    merged.push(raw);
  }

  return merged.slice(0, MAX_HIGHLIGHTED_FAILURES);
}

function extractFailureHighlightsFromRawOutput(rawOutput?: string | null): FailureHighlight[] {
  const trimmed = rawOutput?.trim();
  if (!trimmed) return [];

  const lines = trimmed.split(/\r?\n/);
  const highlights: FailureHighlight[] = [];

  for (let i = 0; i < lines.length && highlights.length < MAX_HIGHLIGHTED_FAILURES; i++) {
    const rawLine = lines[i]?.trim();
    const header = parseFailureHeader(rawLine);
    if (!header) continue;
    if (shouldSkipGenericFailureHeader(rawLine, lines, i)) continue;

    let error: string | undefined;
    for (let j = i + 1; j < Math.min(lines.length, i + 15); j++) {
      const candidate = lines[j]?.trim() ?? "";
      if (!candidate) continue;
      if (parseFailureHeader(candidate)) break;
      if (isNoiseLine(candidate)) continue;
      error = normalizeFailureMessage(candidate);
      if (isHighSignalErrorLine(candidate)) break;
    }

    highlights.push({
      name: header,
      ...(error ? { error } : {}),
    });
  }

  return dedupeFailureHighlights(highlights);
}

function extractFirstMeaningfulErrorLine(rawOutput?: string | null): string | null {
  const trimmed = rawOutput?.trim();
  if (!trimmed) return null;
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (parseFailureHeader(line)) continue;
    if (isPrimaryErrorNoiseLine(line)) continue;
    return normalizeFailureMessage(line);
  }
  return null;
}

function extractOutputSnippet(rawOutput?: string | null): string | null {
  const trimmed = rawOutput?.trim();
  if (!trimmed) return null;
  const lines = trimmed.split(/\r?\n/);
  if (lines.length === 0) return null;

  const firstSignalLine = lines.findIndex((rawLine) => {
    const line = rawLine.trim();
    return Boolean(parseFailureHeader(line) || isLikelyErrorLine(line));
  });
  const start = firstSignalLine >= 0 ? Math.max(0, firstSignalLine - 2) : 0;

  const selected: string[] = [];
  let length = 0;
  let endedEarly = false;
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const nextLength = length + line.length + 1;
    if (selected.length >= MAX_OUTPUT_SNIPPET_LINES || nextLength > MAX_OUTPUT_SNIPPET_CHARS) {
      endedEarly = true;
      break;
    }
    selected.push(line);
    length = nextLength;
  }

  if (selected.length === 0) return null;
  const snippet = selected.join("\n").trim();
  if (!snippet) return null;
  return endedEarly ? `${snippet}\n...[truncated]` : snippet;
}

function isLikelyErrorLine(line: string): boolean {
  if (!line) return false;
  if (parseFailureHeader(line)) return true;
  return /(assertionerror|typeerror|referenceerror|syntaxerror|error:|failed|cannot find|not found)/i.test(
    line
  );
}

function parseFailureHeader(line?: string): string | null {
  if (!line) return null;

  const directMatch = line.match(/^(?:FAIL|✗|✕)\s+(.+?)$/);
  if (directMatch) {
    return cleanFailureName(directMatch[1] ?? "");
  }

  const jestMatch = line.match(/^●\s+(.+?)$/);
  if (jestMatch) {
    return cleanFailureName(jestMatch[1] ?? "");
  }

  return null;
}

function shouldSkipGenericFailureHeader(line: string, lines: string[], index: number): boolean {
  if (!/^FAIL\s+/i.test(line)) return false;

  const name = cleanFailureName(line.replace(/^FAIL\s+/i, ""));
  const isGenericFileOnly = !name.includes(">") && !name.includes("›") && !name.includes("::");
  if (!isGenericFileOnly) return false;

  for (let i = index + 1; i < Math.min(lines.length, index + 12); i++) {
    if (/^●\s+/.test(lines[i]?.trim() ?? "")) {
      return true;
    }
  }

  return false;
}

function cleanFailureName(name: string): string {
  return name
    .replace(/\s+\(\d+\s*ms\)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeFailureMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

function isNoiseLine(line: string): boolean {
  return (
    /^[-+]{2,}$/.test(line) ||
    /^at\s+/i.test(line) ||
    /^❯\s+/.test(line) ||
    /^›\s+/.test(line) ||
    /^stdout\s*\|/i.test(line) ||
    /^stderr\s*\|/i.test(line) ||
    /^Test Files\b/i.test(line) ||
    /^Tests\b/i.test(line) ||
    /^Start at\b/i.test(line) ||
    /^Duration\b/i.test(line) ||
    /^Serialized Error:/i.test(line) ||
    /^Caused by:/i.test(line) ||
    /^Expected:/i.test(line) ||
    /^Received:/i.test(line) ||
    /^Snapshot:/i.test(line) ||
    /^⎯+/.test(line)
  );
}

function isPrimaryErrorNoiseLine(line: string): boolean {
  return PRIMARY_ERROR_NOISE_PATTERNS.some((pattern) => pattern.test(line));
}

function isHighSignalErrorLine(line: string): boolean {
  return /(AssertionError|TypeError|ReferenceError|SyntaxError|Error:|Expected|expected)/i.test(
    line
  );
}

function dedupeFailureHighlights(highlights: FailureHighlight[]): FailureHighlight[] {
  const deduped: FailureHighlight[] = [];
  const seen = new Set<string>();

  for (const highlight of highlights) {
    const key = normalizeFailureNameKey(highlight.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(highlight);
  }

  return deduped;
}

function normalizeFailureNameKey(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

function failureNamesMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeFailureNameKey(left);
  const normalizedRight = normalizeFailureNameKey(right);
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(normalizedRight) ||
    normalizedRight.endsWith(normalizedLeft)
  );
}

function preferFailureName(detailName: string, rawName?: string): string {
  if (!rawName) return detailName;
  if (rawName.length > detailName.length && failureNamesMatch(detailName, rawName)) {
    return rawName;
  }
  return detailName;
}

function shouldIncludeFullRawOutput(): boolean {
  return process.env.OPENSPRINT_INCLUDE_FULL_TEST_OUTPUT === "1";
}
