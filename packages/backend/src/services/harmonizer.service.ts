/**
 * Harmonizer agent service — PRD §12.3.3.
 * Reviews shipped Plan against PRD and proposes section updates.
 * Invoked during Execute! flow (trigger: build_it) and scope-change feedback (trigger: scope_change).
 */

import type { PrdSectionKey } from "@opensprint/shared";
import { extractJsonFromAgentResponse } from "../utils/json-extract.js";
import { JSON_OUTPUT_PREAMBLE } from "../utils/agent-prompts.js";

const VALID_SECTION_KEYS: PrdSectionKey[] = [
  "executive_summary",
  "problem_statement",
  "user_personas",
  "goals_and_metrics",
  "assumptions_and_constraints",
  "feature_list",
  "technical_architecture",
  "data_model",
  "api_contracts",
  "non_functional_requirements",
  "open_questions",
];

function isLegacyNoChangesNeeded(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("no updates needed") ||
    normalized.includes("no changes needed") ||
    normalized.includes("already aligned") ||
    normalized.includes("already reflects")
  );
}

/** Harmonizer result.json format per PRD 12.3.3 */
export interface HarmonizerResult {
  status: "success" | "no_changes_needed" | "failed";
  prd_updates?: Array<{
    section: string;
    action: "update";
    content: string;
    change_log_entry?: string;
  }>;
}

/** Build the Harmonizer prompt for build_it trigger (Execute! flow) */
export function buildHarmonizerPromptBuildIt(planId: string, planContent: string): string {
  return `# Harmonizer: Review shipped Plan against PRD

## Trigger
build_it — A Plan has just been approved for execution (Execute!).

## Task
Review the approved Plan against the current PRD. Update any PRD sections that should reflect the Plan's decisions, scope, technical approach, or acceptance criteria. The PRD is the living document; it should stay aligned with what is being built.

Return no_changes_needed promptly when the Plan adds no new information beyond the PRD. Prefer targeted updates to specific sections over rewriting entire sections. Only update sections that meaningfully differ from the Plan. change_log_entry should be one sentence describing the update (for HIL approval display).

## Approved Plan (${planId})

${planContent}

## Output
${JSON_OUTPUT_PREAMBLE} Use one of these formats:

**If updates are needed:**
{"status":"success","prd_updates":[{"section":"<section_key>","action":"update","content":"<markdown>","change_log_entry":"<description>"}]}

**If no updates are needed:**
{"status":"no_changes_needed"}

Valid section keys: ${VALID_SECTION_KEYS.join(", ")}

Do NOT include a top-level section header (e.g. "## 1. Executive Summary") in the content — the UI already displays the section title. Start with the body content directly.`;
}

/** Build the Harmonizer prompt for scope_change trigger (Evaluate feedback) */
export function buildHarmonizerPromptScopeChange(feedbackText: string): string {
  return `# Harmonizer: Review scope-change feedback against PRD

## Trigger
scope_change — A user has submitted validation feedback that was categorized as a scope change and approved for PRD updates.

## Task
Review the feedback against the current PRD. Determine if updates are necessary. If so, produce targeted section updates that incorporate the scope change. The PRD is the living document; it should reflect the approved scope change.

Return no_changes_needed promptly when the feedback adds no new information beyond the PRD. Prefer targeted updates to specific sections. change_log_entry should be one sentence (for HIL approval display). If the feedback is vague or could apply to multiple sections, propose updates to the most relevant section and note ambiguity in change_log_entry.

## Feedback

"${feedbackText.replace(/"/g, '\\"')}"

## Output
${JSON_OUTPUT_PREAMBLE} Use one of these formats:

**If updates are needed:**
{"status":"success","prd_updates":[{"section":"<section_key>","action":"update","content":"<markdown>","change_log_entry":"<description>"}]}

**If no updates are needed:**
{"status":"no_changes_needed"}

Valid section keys: ${VALID_SECTION_KEYS.join(", ")}

Do NOT include a top-level section header in the content. Start with the body content directly.`;
}

/** Harmonizer update with optional change log (for scope-change summary) */
export interface HarmonizerPrdUpdate {
  section: PrdSectionKey;
  content: string;
  changeLogEntry?: string;
}

/** Parse Harmonizer result from agent response (result.json format). */
export function parseHarmonizerResult(content: string): {
  status: "success" | "no_changes_needed";
  prdUpdates: Array<{ section: PrdSectionKey; content: string }>;
} | null {
  const full = parseHarmonizerResultFull(content);
  if (!full) return null;
  return {
    status: full.status,
    prdUpdates: full.prdUpdates.map(({ section, content }) => ({ section, content })),
  };
}

/** Parse Harmonizer result including change_log_entry (for scope-change HIL summary). */
export function parseHarmonizerResultFull(
  content: string
): { status: "success" | "no_changes_needed"; prdUpdates: HarmonizerPrdUpdate[] } | null {
  const parsed = extractJsonFromAgentResponse<HarmonizerResult>(content, "status");
  if (parsed) {
    const status = parsed.status?.toLowerCase();
    if (status === "no_changes_needed") {
      return { status: "no_changes_needed", prdUpdates: [] };
    }
    if (status === "success" && parsed.prd_updates && parsed.prd_updates.length > 0) {
      const prdUpdates = parsed.prd_updates
        .filter((u) => VALID_SECTION_KEYS.includes(u.section as PrdSectionKey))
        .map((u) => ({
          section: u.section as PrdSectionKey,
          content: u.content?.trim() ?? "",
          changeLogEntry: u.change_log_entry?.trim(),
        }))
        .filter((u) => u.content.length > 0);
      return { status: "success", prdUpdates };
    }
    if (status === "success" && (!parsed.prd_updates || parsed.prd_updates.length === 0)) {
      return { status: "no_changes_needed", prdUpdates: [] };
    }
  }

  if (isLegacyNoChangesNeeded(content)) {
    return { status: "no_changes_needed", prdUpdates: [] };
  }

  return null;
}
