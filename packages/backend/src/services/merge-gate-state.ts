import type { MergeGateState } from "@opensprint/shared";
import { parseTaskLastExecutionSummary } from "./task-execution-summary.js";
import { getMergeStageFromIssue } from "./task-store-helpers.js";
import type { StoredTask } from "./task-store.service.js";

type MergeGateTaskLike = Record<string, unknown>;

export function getMergePausedUntilFromIssue(issue: MergeGateTaskLike): string | null {
  const raw = issue.merge_quality_gate_paused_until;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || parsed <= Date.now()) return null;
  return raw;
}

export function deriveMergeGateStateFromIssue(issue: MergeGateTaskLike): MergeGateState | null {
  const mergePausedUntil = getMergePausedUntilFromIssue(issue);
  if (mergePausedUntil) return "blocked_on_baseline";

  const mergeStage = getMergeStageFromIssue(issue as StoredTask);
  if (mergeStage === "merge_to_main" || mergeStage === "rebase_before_merge") {
    return "merging";
  }
  if (mergeStage !== "quality_gate") {
    return null;
  }

  const lastExecution = parseTaskLastExecutionSummary(issue.last_execution_summary);
  if (lastExecution?.failureType === "environment_setup") {
    return "environment_repair_needed";
  }
  if (lastExecution?.failureType === "merge_quality_gate") {
    return "candidate_fix_needed";
  }
  return "validating";
}
