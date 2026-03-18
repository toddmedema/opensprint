/**
 * No-result reason extraction — parses agent output to produce human-readable failure reasons.
 * Used when coding/review agents exit without a valid result.json (timeout, crash, no_result).
 * Extracted from OrchestratorService for reuse and testability.
 */

import path from "path";
import fs from "fs/promises";
import { OPENSPRINT_PATHS } from "@opensprint/shared";
import type { CodingAgentResult } from "@opensprint/shared";
import type { ReviewOutcome } from "./task-phase-coordinator.js";

const DEFAULT_REASON_LIMIT = 240;
const DEFAULT_OPEN_QUESTION_ID = "q1";

interface StructuredTerminalResultEvent {
  subtype: string;
  text: string;
  isError: boolean;
}

interface StructuredAssistantMessageEvent {
  text: string;
}

/** True if the string has meaningful alphanumeric content (not just punctuation/whitespace). */
export function isMeaningfulNoResultFragment(fragment: string): boolean {
  return /[A-Za-z0-9]/.test(fragment.replace(/[^A-Za-z0-9]+/g, ""));
}

/** Extract a single error message from a JSON log line (NDJSON). */
export function extractStructuredNoResultErrorFromJsonLine(line: string): string | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const message =
      typeof parsed.message === "string"
        ? parsed.message
        : typeof parsed.error === "string"
          ? parsed.error
          : parsed.error &&
              typeof parsed.error === "object" &&
              typeof (parsed.error as Record<string, unknown>).message === "string"
            ? ((parsed.error as Record<string, unknown>).message as string)
            : typeof parsed.detail === "string"
              ? parsed.detail
              : undefined;
    if (!message || !isMeaningfulNoResultFragment(message)) return undefined;
    const type = typeof parsed.type === "string" ? parsed.type.toLowerCase() : "";
    const subtype = typeof parsed.subtype === "string" ? parsed.subtype.toLowerCase() : "";
    const status = typeof parsed.status === "string" ? parsed.status.toLowerCase() : "";
    if (
      type === "error" ||
      subtype === "error" ||
      status === "error" ||
      message.toLowerCase().includes("error")
    ) {
      return message.trim();
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Extract the final structured terminal result emitted by CLI agents (e.g. Cursor/Codex NDJSON). */
export function extractStructuredTerminalResultFromJsonLine(
  line: string
): StructuredTerminalResultEvent | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.type !== "result") return undefined;
    const text = typeof parsed.result === "string" ? parsed.result.trim() : "";
    if (!text || !isMeaningfulNoResultFragment(text)) return undefined;
    const subtype = typeof parsed.subtype === "string" ? parsed.subtype.toLowerCase() : "";
    return {
      subtype,
      text,
      isError: parsed.is_error === true || subtype === "error" || subtype === "failed",
    };
  } catch {
    return undefined;
  }
}

export function extractStructuredTerminalResultFromOutput(
  outputLog: string[]
): StructuredTerminalResultEvent | undefined {
  const output = outputLog.join("").replace(/\r/g, "").trim();
  if (!output) return undefined;

  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;

  return lines
    .map((line) => extractStructuredTerminalResultFromJsonLine(line))
    .filter((result): result is StructuredTerminalResultEvent => Boolean(result))
    .at(-1);
}

/** Extract assistant/chat response text from structured NDJSON output. */
export function extractStructuredAssistantTextFromJsonLine(
  line: string
): StructuredAssistantMessageEvent | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.type !== "assistant") return undefined;
    const message =
      parsed.message && typeof parsed.message === "object"
        ? (parsed.message as Record<string, unknown>)
        : null;
    if (!message) return undefined;

    const rawContent = message.content;
    let text = "";
    if (typeof rawContent === "string") {
      text = rawContent;
    } else if (Array.isArray(rawContent)) {
      text = rawContent
        .map((item) => {
          if (!item || typeof item !== "object") return "";
          const part = item as Record<string, unknown>;
          return typeof part.text === "string" ? part.text : "";
        })
        .join("");
    }

    const trimmed = text.trim();
    if (!trimmed || !isMeaningfulNoResultFragment(trimmed)) return undefined;
    return { text: trimmed };
  } catch {
    return undefined;
  }
}

export function extractStructuredAssistantTranscriptFromOutput(
  outputLog: string[]
): string | undefined {
  const output = outputLog.join("").replace(/\r/g, "").trim();
  if (!output) return undefined;

  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;

  const fragments = lines
    .map((line) => extractStructuredAssistantTextFromJsonLine(line)?.text)
    .filter((line): line is string => Boolean(line));
  if (fragments.length === 0) return undefined;

  return fragments.join("");
}

function extractPlainTextOutput(outputLog: string[]): string | undefined {
  const output = outputLog.join("").replace(/\r/g, "").trim();
  if (!output) return undefined;

  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("{"))
    .filter((line) => !/^}+$/.test(line))
    .filter((line) => isMeaningfulNoResultFragment(line));
  if (lines.length === 0) return undefined;

  return lines.join("\n");
}

function findLastQuestionCueStart(text: string): number | undefined {
  const cuePatterns = [
    /How do you want me to proceed\?/gi,
    /Do you want me to [^\n?]*\?/gi,
    /Would you like me to [^\n?]*\?/gi,
    /Should I [^\n?]*\?/gi,
    /Can you clarify[^\n?]*\?/gi,
    /Which option do you prefer\?/gi,
  ];

  let lastStart: number | undefined;
  for (const pattern of cuePatterns) {
    for (const match of text.matchAll(pattern)) {
      if (match.index == null) continue;
      if (lastStart == null || match.index > lastStart) {
        lastStart = match.index;
      }
    }
  }
  return lastStart;
}

function summarizeTextSnippet(text: string, limit: number = DEFAULT_REASON_LIMIT): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  const sentence = compact.match(/^(.{1,240}?[.!?])(?:\s|$)/)?.[1] ?? compact;
  return sentence.slice(0, limit);
}

function extractParagraphs(text: string): string[] {
  const paragraphs = text
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  if (paragraphs.length > 1) {
    return paragraphs;
  }

  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 1 ? lines : paragraphs;
}

function isGenericKickoffParagraph(paragraph: string): boolean {
  const compact = paragraph.replace(/\s+/g, " ").trim();
  if (!compact) return true;
  return [
    /^the user wants me to\b/i,
    /^the task indicates\b/i,
    /^i need to\b/i,
    /^let me\b/i,
    /^i['’]ll start by\b/i,
    /^i['’]ll\b/i,
    /^restoring .*?:\b/i,
    /^reviewing .*?:\b/i,
    /^running .*?:\b/i,
    /^checking .*?:\b/i,
    /^implementing .*?:\b/i,
    /^writing the review result\b/i,
    /^writing result\.json\b/i,
  ].some((pattern) => pattern.test(compact));
}

function scoreActionableParagraph(paragraph: string, index: number, total: number): number {
  const compact = paragraph.replace(/\s+/g, " ").trim();
  if (!compact) return Number.NEGATIVE_INFINITY;

  let score = 0;
  if (!isGenericKickoffParagraph(compact)) score += 4;
  if (compact.length >= 40) score += 1;
  if (/[`]/.test(compact)) score += 1;
  if (/\b(error|failed|failure|timed out|timeout|exception|result\.json|enoent)\b/i.test(compact)) {
    score += 3;
  }
  if (/\b(npm run|npx |vitest|jest|build|lint|test|review|mock|fix|patch|result\.json)\b/i.test(compact)) {
    score += 2;
  }
  score += index / Math.max(total, 1);
  return score;
}

function selectActionableSummaryFocus(text: string): string {
  const normalized = text.replace(/\r/g, "").trim();
  if (!normalized) return "";

  const paragraphs = extractParagraphs(normalized);
  if (paragraphs.length === 0) return normalized;

  const scored = paragraphs
    .map((paragraph, index) => ({
      paragraph,
      score: scoreActionableParagraph(paragraph, index, paragraphs.length),
      index,
    }))
    .sort((a, b) => b.score - a.score || b.index - a.index);

  const best = scored[0];
  if (!best || best.score <= 0) {
    return normalized;
  }
  return best.paragraph;
}

function extractOpenQuestionBlock(text: string): string | undefined {
  const normalized = text.replace(/\r/g, "").trim();
  if (!normalized) return undefined;

  const cueStart = findLastQuestionCueStart(normalized);
  if (cueStart == null) return undefined;

  const paragraphStart = normalized.lastIndexOf("\n\n", cueStart);
  if (paragraphStart >= 0) {
    const questionText = normalized.slice(paragraphStart + 2).trim();
    const contextSource = normalized.slice(0, paragraphStart).trim();
    const contextSentence = summarizeTextSnippet(contextSource, DEFAULT_REASON_LIMIT);
    return contextSentence ? `${contextSentence}\n\n${questionText}` : questionText;
  }

  const sentenceStart = normalized.lastIndexOf(". ", cueStart);
  const start = sentenceStart >= 0 ? sentenceStart + 2 : 0;
  return normalized.slice(start).trim();
}

function summarizeTerminalResultText(text: string, limit: number = DEFAULT_REASON_LIMIT): string {
  const focus = extractOpenQuestionBlock(text) ?? selectActionableSummaryFocus(text);
  return summarizeTextSnippet(focus, limit);
}

/**
 * Convert structured agent output into a synthetic coding result when the agent
 * exits without writing result.json. This preserves open questions instead of
 * turning them into a generic no_result failure.
 */
export function synthesizeCodingResultFromOutput(
  outputLog: string[]
): CodingAgentResult | undefined {
  const candidateTexts = [
    extractStructuredTerminalResultFromOutput(outputLog)?.text,
    extractStructuredAssistantTranscriptFromOutput(outputLog),
    extractPlainTextOutput(outputLog),
  ].filter((text): text is string => Boolean(text?.trim()));

  const notes = candidateTexts.find((text) => extractOpenQuestionBlock(text) || text.trim());
  if (!notes) return undefined;

  const openQuestionText = extractOpenQuestionBlock(notes);
  if (openQuestionText) {
    return {
      status: "failed",
      summary: summarizeTerminalResultText(openQuestionText),
      filesChanged: [],
      testsWritten: 0,
      testsPassed: 0,
      notes,
      open_questions: [{ id: DEFAULT_OPEN_QUESTION_ID, text: openQuestionText }],
    };
  }

  const summary = summarizeTerminalResultText(notes);
  if (!summary) return undefined;
  return {
    status: "failed",
    summary: `Agent exited without writing result.json: ${summary}`.slice(0, DEFAULT_REASON_LIMIT),
    filesChanged: [],
    testsWritten: 0,
    testsPassed: 0,
    notes,
  };
}

/**
 * Derive a short reason from in-memory output log (coding or review agent).
 */
export function extractNoResultReasonFromOutput(
  outputLog: string[],
  limit: number = DEFAULT_REASON_LIMIT
): string | undefined {
  const output = outputLog.join("").replace(/\r/g, "").trim();
  if (!output) return undefined;

  const agentErrorMatches = [...output.matchAll(/\[Agent error:\s*([^\]]+)\]/gi)];
  const latestAgentError = agentErrorMatches
    .map((match) => match[1]?.trim() ?? "")
    .filter((line) => isMeaningfulNoResultFragment(line))
    .at(-1);
  if (latestAgentError) {
    return latestAgentError.slice(0, limit);
  }

  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;

  const structuredErrors = lines
    .map((line) => extractStructuredNoResultErrorFromJsonLine(line))
    .filter((line): line is string => Boolean(line))
    .filter((line) => isMeaningfulNoResultFragment(line));
  if (structuredErrors.length > 0) {
    return structuredErrors.at(-1)?.slice(0, limit);
  }

  const assistantTranscript = extractStructuredAssistantTranscriptFromOutput(outputLog);
  if (assistantTranscript) {
    const summary = summarizeTerminalResultText(assistantTranscript, limit);
    if (summary) return summary;
  }

  const terminalResult = extractStructuredTerminalResultFromOutput(outputLog);
  if (terminalResult) {
    const summary = summarizeTerminalResultText(terminalResult.text, limit);
    if (summary) return summary;
  }

  const plainTextOutput = extractPlainTextOutput(outputLog);
  if (plainTextOutput) {
    const summary = summarizeTerminalResultText(plainTextOutput, limit);
    if (summary) return summary;
  }

  const nonJsonLines = lines
    .filter((line) => !line.startsWith("{"))
    .map((line) => line.replace(/^\s*[A-Z]:\s*/i, "").trim())
    .filter((line) => !/^}+$/.test(line))
    .filter((line) => isMeaningfulNoResultFragment(line));
  if (nonJsonLines.length === 0) return undefined;

  const errorLike =
    /not available|please|switch to|error|invalid|required|cannot|unable|try |failed|rate limit|authentication|api key/i;
  const preferred = [...nonJsonLines].reverse().find((line) => {
    if (line.length > 400) return false;
    if (errorLike.test(line)) return true;
    return /[.?]$/.test(line) || (line.length < 150 && !/^[\s\S]*[\d{"]$/.test(line));
  });
  return (preferred ?? nonJsonLines.at(-1))?.slice(0, limit);
}

/**
 * Try in-memory log first, then read from output log file (main or review angle).
 */
export async function extractNoResultReasonFromLogs(
  wtPath: string,
  taskId: string,
  outputLog: string[],
  angle?: string
): Promise<string | undefined> {
  const fromMemory = extractNoResultReasonFromOutput(outputLog);
  if (fromMemory) return fromMemory;

  const outputLogPath = angle
    ? path.join(
        wtPath,
        OPENSPRINT_PATHS.active,
        taskId,
        "review-angles",
        angle,
        OPENSPRINT_PATHS.agentOutputLog
      )
    : path.join(wtPath, OPENSPRINT_PATHS.active, taskId, OPENSPRINT_PATHS.agentOutputLog);
  try {
    const fileOutput = await fs.readFile(outputLogPath, "utf-8");
    const fromFile = extractNoResultReasonFromOutput([fileOutput]);
    if (fromFile) return fromFile;
  } catch {
    // Missing log file is expected for very-early failures.
  }
  return undefined;
}

/** Build a single failure message from coordinated review no_result/error outcome. */
export function buildReviewNoResultFailureReason(reviewOutcome: ReviewOutcome): string {
  const contexts = (reviewOutcome.failureContext ?? []).filter((ctx) => {
    const hasAngle = typeof ctx.angle === "string" && ctx.angle.trim().length > 0;
    const hasReason = typeof ctx.reason === "string" && ctx.reason.trim().length > 0;
    return hasAngle || hasReason || ctx.exitCode !== null;
  });
  if (contexts.length === 0) {
    return "One or more review agents exited without producing a valid result";
  }

  const details = contexts.map((ctx) => {
    const label = ctx.angle ? `angle '${ctx.angle}'` : "general review";
    let detail = `${label} exited with code ${ctx.exitCode ?? "null"} without producing a valid result`;
    if (ctx.reason) {
      detail += ` (${ctx.reason})`;
    }
    return detail;
  });
  if (details.length === 1) return details[0]!;
  return `Review agents failed to produce valid results: ${details.join("; ")}`;
}
