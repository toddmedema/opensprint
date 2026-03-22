/**
 * Single map of (phase × failure family) → resolution owner for operators and code navigation.
 * Behavior is implemented across FailureHandlerService, MergeCoordinatorService,
 * OrchestratorLoopService, and BlockedAutoRetryService — this module is documentation-only.
 */

export type FailurePlaybookResolution =
  | "requeue_with_retry_context"
  | "infra_retry_slot"
  | "demote_priority"
  | "block_after_backoff"
  | "merge_requeue_or_block"
  | "baseline_pause_merge_and_dispatch"
  | "defer_dispatch_same_worktree"
  | "auto_unblock_8h_technical";

/** Phase or pipeline stage as used in logs and WS `phase` / mergeStage. */
export type FailurePlaybookPhase =
  | "coding"
  | "review"
  | "merge"
  | "merge_quality_gate"
  | "dispatch"
  | "global"
  | "blocked";

/**
 * Keys are coarse failure families; see `FailureType` in orchestrator-phase-context.ts
 * and merge coordinator stages for finer detail.
 */
export const FAILURE_PLAYBOOK: Record<string, FailurePlaybookResolution> = {
  "coding:test_failure": "requeue_with_retry_context",
  "coding:review_rejection": "requeue_with_retry_context",
  "coding:no_result": "requeue_with_retry_context",
  "coding:coding_failure": "requeue_with_retry_context",
  "coding:agent_crash": "infra_retry_slot",
  "coding:timeout": "infra_retry_slot",
  "coding:repo_preflight": "requeue_with_retry_context",
  "coding:environment_setup": "requeue_with_retry_context",
  "merge:merge_conflict": "infra_retry_slot",
  "merge:merge_quality_gate": "merge_requeue_or_block",
  "merge:environment_setup": "merge_requeue_or_block",
  "global:backoff_exhausted": "demote_priority",
  "global:blocked_max_priority": "block_after_backoff",
  "global:baseline_red": "baseline_pause_merge_and_dispatch",
  "dispatch:worktree_branch_in_use": "defer_dispatch_same_worktree",
  "blocked:technical": "auto_unblock_8h_technical",
};

export function playbookLookup(phase: FailurePlaybookPhase, family: string): FailurePlaybookResolution {
  const key = `${phase}:${family}`;
  return FAILURE_PLAYBOOK[key] ?? "requeue_with_retry_context";
}
