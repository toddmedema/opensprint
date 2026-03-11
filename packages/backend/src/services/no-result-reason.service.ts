/**
 * No-result reason extraction — parses agent output to produce human-readable failure reasons.
 * Used when coding/review agents exit without a valid result.json (timeout, crash, no_result).
 * Extracted from OrchestratorService for reuse and testability.
 */

import path from "path";
import fs from "fs/promises";
import { OPENSPRINT_PATHS } from "@opensprint/shared";
import type { ReviewOutcome } from "./task-phase-coordinator.js";

const DEFAULT_REASON_LIMIT = 240;

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
