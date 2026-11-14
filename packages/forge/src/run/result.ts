import type { EvidenceItem, PlannedWorkItem, ResultFile, ResultStatus } from "../domain.js";
import { validateRunbook } from "../runbook/runbook.js";

export function parseResult(raw: string): ResultFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return failed("Result file was not JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return failed("Result file was not an object.");
  }
  const record = parsed as Record<string, unknown>;
  const status = record.status;
  const recognized = status === "succeeded" || status === "failed" || status === "needs_human";
  const result: ResultFile = {
    status: recognized ? (status as ResultStatus) : "failed",
    summary:
      typeof record.summary === "string"
        ? record.summary
        : recognized
          ? ""
          : "Unrecognized result status.",
    evidence: readEvidence(record.evidence),
    questions: readQuestions(record.questions),
    unrecognizedStatus: !recognized,
  };
  if (record.runbookProposal !== undefined) {
    try {
      result.runbookProposal = validateRunbook(record.runbookProposal);
    } catch (error) {
      result.status = "needs_human";
      result.summary = error instanceof Error ? error.message : "Invalid runbook proposal.";
      result.questions = result.questions.length > 0 ? result.questions : [result.summary];
    }
  }
  if (record.workItems !== undefined) result.workItems = readWorkItems(record.workItems);
  return result;
}

function failed(summary: string): ResultFile {
  return { status: "failed", summary, evidence: [], questions: [] };
}

function readEvidence(value: unknown): EvidenceItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return [
      {
        command: typeof record.command === "string" ? record.command : "",
        exitCode: typeof record.exitCode === "number" ? record.exitCode : 1,
        excerpt: typeof record.excerpt === "string" ? record.excerpt.slice(0, 2000) : "",
      },
    ];
  });
}

function readQuestions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

function readWorkItems(value: unknown): PlannedWorkItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.title !== "string" || typeof record.body !== "string") return [];
    const dependsOn = Array.isArray(record.dependsOn)
      ? record.dependsOn.filter((entry): entry is string => typeof entry === "string")
      : [];
    return [{ title: record.title, body: record.body, dependsOn }];
  });
}
