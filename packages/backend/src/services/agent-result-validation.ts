import type {
  CodingAgentResult,
  ReviewAgentResult,
  StructuredReviewFinding,
  ReviewAppeal,
} from "@opensprint/shared";
import { normalizeCodingStatus, normalizeReviewStatus } from "./result-normalizers.js";
import { parseDebugArtifact } from "./agentic-repair.service.js";

export interface MergerAgentResult {
  status: "success" | "failed";
  summary: string;
  notes?: string;
  debugArtifact?: import("@opensprint/shared").DebugArtifact;
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseOpenQuestions(
  value: unknown
): CodingAgentResult["open_questions"] | CodingAgentResult["openQuestions"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const questions = value
    .filter(
      (item): item is { id?: unknown; text: string } =>
        item != null &&
        typeof item === "object" &&
        typeof (item as { text?: unknown }).text === "string"
    )
    .map((item, index) => ({
      id: typeof item.id === "string" && item.id.trim() !== "" ? item.id.trim() : `q${index + 1}`,
      text: item.text.trim(),
    }))
    .filter((item) => item.text.length > 0);
  return questions.length > 0 ? questions : undefined;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonempty);
}

/** Strict parsing never drops a malformed blocker and turns rejection into approval. O(n) time/space. */
export function parseReviewFindings(value: unknown): StructuredReviewFinding[] | null {
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  const findings: StructuredReviewFinding[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const f = item as Record<string, unknown>;
    if (
      !nonempty(f.id) ||
      ids.has(f.id) ||
      !["standard", "defect", "security", "gate", "advisory"].includes(String(f.category)) ||
      !["blocking", "warning", "info"].includes(String(f.severity)) ||
      !nonempty(f.file) ||
      !nonempty(f.codeRevision) ||
      !nonempty(f.evidence) ||
      !nonempty(f.suggestedRemedy)
    )
      return null;
    if (
      f.category === "standard" &&
      f.severity === "blocking" &&
      (!nonempty(f.ruleId) || !nonempty(f.ruleRevisionId))
    )
      return null;
    if (f.category === "advisory" && f.severity === "blocking") return null;
    const provenance = f.provenance as Record<string, unknown> | undefined;
    if (!provenance || !nonempty(provenance.reviewer)) return null;
    ids.add(f.id);
    findings.push({
      id: f.id,
      category: f.category as StructuredReviewFinding["category"],
      severity: f.severity as StructuredReviewFinding["severity"],
      file: f.file,
      codeRevision: f.codeRevision,
      evidence: f.evidence,
      suggestedRemedy: f.suggestedRemedy,
      ...(nonempty(f.ruleId) ? { ruleId: f.ruleId } : {}),
      ...(nonempty(f.ruleRevisionId) ? { ruleRevisionId: f.ruleRevisionId } : {}),
      provenance: {
        reviewer: provenance.reviewer,
        ...(nonempty(provenance.angle) ? { angle: provenance.angle } : {}),
        ...(nonempty(provenance.model) ? { model: provenance.model } : {}),
      },
    });
  }
  return findings;
}

/** O(n) time and output space; invalid appeals fail closed instead of becoming ordinary success. */
export function parseReviewAppeals(value: unknown): ReviewAppeal[] | null {
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const a = item as Record<string, unknown>;
    if (
      !nonempty(a.findingId) ||
      ids.has(a.findingId) ||
      !nonempty(a.requestedException) ||
      !nonempty(a.whyCompliantOptionsFail) ||
      !stringArray(a.alternatives) ||
      !stringArray(a.tests) ||
      !stringArray(a.risks) ||
      !stringArray(a.proposedLimits)
    )
      return null;
    ids.add(a.findingId);
  }
  return value as ReviewAppeal[];
}

export function parseCodingAgentResult(raw: string | null | undefined): CodingAgentResult | null {
  if (!raw || raw.trim() === "") return null;
  const record = parseJsonRecord(raw);
  if (!record || typeof record.status !== "string") return null;

  const candidate: CodingAgentResult = {
    status: "failed",
    summary: typeof record.summary === "string" ? record.summary : "",
    filesChanged: Array.isArray(record.filesChanged)
      ? record.filesChanged.filter((item): item is string => typeof item === "string")
      : [],
    testsWritten: typeof record.testsWritten === "number" ? record.testsWritten : 0,
    testsPassed: typeof record.testsPassed === "number" ? record.testsPassed : 0,
    notes: typeof record.notes === "string" ? record.notes : "",
    ...(parseOpenQuestions(record.open_questions) && {
      open_questions: parseOpenQuestions(record.open_questions),
    }),
    ...(parseOpenQuestions(record.openQuestions) && {
      openQuestions: parseOpenQuestions(record.openQuestions),
    }),
  };

  if (record.appeals !== undefined) {
    const appeals = parseReviewAppeals(record.appeals);
    if (!appeals) return null;
    candidate.appeals = appeals;
  }

  const debugArtifact = parseDebugArtifact(record);
  if (debugArtifact) candidate.debugArtifact = debugArtifact;

  (candidate as { status: string }).status = record.status;

  normalizeCodingStatus(candidate);

  if (candidate.status !== "success" && candidate.status !== "failed") {
    return null;
  }

  if (!candidate.summary.trim()) {
    const openQuestions = candidate.open_questions ?? candidate.openQuestions;
    if (!openQuestions || openQuestions.length === 0) {
      return null;
    }
    candidate.summary = "Needs clarification before proceeding.";
  }

  return candidate;
}

export function parseReviewAgentResult(raw: string | null | undefined): ReviewAgentResult | null {
  if (!raw || raw.trim() === "") return null;
  const record = parseJsonRecord(raw);
  if (!record || typeof record.status !== "string") return null;

  const candidate: ReviewAgentResult = {
    status: "rejected",
    summary: typeof record.summary === "string" ? record.summary : "",
    ...(Array.isArray(record.issues) && {
      issues: record.issues.filter((item): item is string => typeof item === "string"),
    }),
    notes: typeof record.notes === "string" ? record.notes : "",
  };

  if (record.findings !== undefined) {
    const findings = parseReviewFindings(record.findings);
    if (!findings) return null;
    candidate.findings = findings;
  }
  if (record.withdrawnFindingIds !== undefined) {
    if (!stringArray(record.withdrawnFindingIds)) return null;
    candidate.withdrawnFindingIds = record.withdrawnFindingIds;
  }

  const debugArtifact = parseDebugArtifact(record);
  if (debugArtifact) candidate.debugArtifact = debugArtifact;

  (candidate as { status: string }).status = record.status;

  normalizeReviewStatus(candidate);

  if (candidate.status !== "approved" && candidate.status !== "rejected") {
    return null;
  }

  if (candidate.findings?.some((f) => f.severity === "blocking")) {
    candidate.status = "rejected";
  }

  if (!candidate.summary.trim()) {
    candidate.summary =
      candidate.status === "approved"
        ? "Approved (no summary provided)"
        : "Rejected (no summary provided)";
  }

  return candidate;
}

export function parseMergerAgentResult(raw: string | null | undefined): MergerAgentResult | null {
  if (!raw || raw.trim() === "") return null;
  const record = parseJsonRecord(raw);
  if (!record || typeof record.status !== "string") return null;

  const status = record.status.toLowerCase().trim();
  if (status !== "success" && status !== "failed") {
    return null;
  }

  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  if (!summary) {
    return null;
  }

  const mergerDebugArtifact = parseDebugArtifact(record);
  return {
    status,
    summary,
    ...(typeof record.notes === "string" && record.notes.trim() !== ""
      ? { notes: record.notes.trim() }
      : {}),
    ...(mergerDebugArtifact ? { debugArtifact: mergerDebugArtifact } : {}),
  };
}

export function describeStructuredOutputProblem(params: {
  fileLabel: string;
  rawContent: string | null | undefined;
  expectedShape: string;
}): string {
  const raw = params.rawContent;
  if (raw == null) {
    return `${params.fileLabel} was missing. Expected ${params.expectedShape}.`;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return `${params.fileLabel} was empty. Expected ${params.expectedShape}.`;
  }

  const preview = trimmed.slice(0, 1200);
  let reason = `${params.fileLabel} did not match the expected structure (${params.expectedShape}).`;
  if (preview) {
    reason += `\n\nPrevious content:\n\`\`\`\n${preview}\n\`\`\``;
  }
  return reason;
}
