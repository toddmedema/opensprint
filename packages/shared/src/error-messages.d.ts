/**
 * Centralized error codes and failure types → user-facing messages.
 * Use this map so UI and notifications show the same actionable guidance.
 * Backend ErrorCodes and execution failure types (repo_preflight, environment_setup, etc.)
 * are linked here; backend and frontend both import from @opensprint/shared.
 */
/** User-facing message for each API error code (backend ErrorCodes). Actionable guidance. */
export declare const ERROR_CODE_MESSAGES: Record<string, string>;
/**
 * Returns the user-facing message for an error code, or null if unknown.
 */
export declare function getMessageForErrorCode(code: string | undefined): string | null;
/** Alias for UI/notification hints (one-line actionable guidance). */
export declare const ERROR_CODE_HINTS: Record<string, string>;
/** Returns the same as getMessageForErrorCode (alias for compatibility). */
export declare function getErrorCodeHint(code: string | undefined): string | null;
/** Execution failure types (used by orchestrator, failure-handler, UI). */
export type FailureType =
  | "test_failure"
  | "review_rejection"
  | "agent_crash"
  | "repo_preflight"
  | "environment_setup"
  | "timeout"
  | "no_result"
  | "merge_conflict"
  | "merge_quality_gate"
  | "coding_failure";
/** Short user-facing label for each failure type (e.g. for summaries and notifications). */
export declare const FAILURE_TYPE_LABELS: Record<FailureType, string>;
/**
 * Label for quality-gate failure (merge or environment). Use when failureType is
 * environment_setup vs merge_quality_gate to show the same text as backend summaries.
 */
export declare function getQualityGateFailureLabel(
  failureType: "environment_setup" | "merge_quality_gate"
): string;
/** "Quality gate failed" when outcome is requeued/blocked due to quality gate. */
export declare const QUALITY_GATE_FAILED_LABEL = "Quality gate failed";
/** "Quality gate blocked" when task is blocked after quality gate failure. */
export declare const QUALITY_GATE_BLOCKED_LABEL = "Quality gate blocked";
/** Display label for the quality_gate merge stage (e.g. in execution timeline). */
export declare const QUALITY_GATE_STAGE_LABEL = "Quality gate";
/** Default reason when quality gate fails (used in summaries). */
export declare const QUALITY_GATE_FAILURE_MESSAGE = "Pre-merge quality gates failed";
/**
 * Title for quality gate outcome (blocked vs failed). Use for merge/quality_gate stage.
 */
export declare function getQualityGateTitle(blocked: boolean): string;
/**
 * Title for failure type. Accepts execution failure types and "quality_gate" (alias for merge_quality_gate).
 */
export declare function getFailureTypeTitle(type: FailureType | "quality_gate"): string;
/** Titles for failure types used in orchestrator/diagnostics (environment_setup, quality_gate, repo_preflight). */
export declare const FAILURE_TYPE_TITLES: Record<string, string>;
/** Remediation for repo preflight when the failure is Git-related. */
export declare const REPO_PREFLIGHT_REMEDIATION_GIT =
  "Fix repository git setup (base branch and git identity), then retry.";
/** Remediation for repo preflight when the failure is dependency-related. */
export declare const REPO_PREFLIGHT_REMEDIATION_DEPENDENCY =
  "Run npm ci in the repository root, then fix invalid dependencies before retrying.";
/** Remediation for environment_setup failure. */
export declare const ENVIRONMENT_SETUP_REMEDIATION =
  "Run npm ci in the repository root, re-link worktree node_modules, then retry.";
/** Remediation constants (aliases for compatibility). */
export declare const REMEDIATION_ENVIRONMENT_SETUP =
  "Run npm ci in the repository root, re-link worktree node_modules, then retry.";
export declare const REMEDIATION_PREFLIGHT_DEPENDENCY =
  "Run npm ci in the repository root, then fix invalid dependencies before retrying.";
export declare const REMEDIATION_PREFLIGHT_GIT =
  "Fix repository git setup (base branch and git identity), then retry.";
/**
 * Returns the remediation message for repo_preflight or environment_setup.
 */
export declare function getRemediationForFailureType(
  failureType: "repo_preflight" | "environment_setup",
  isDependencySetupPreflight?: boolean
): string;
//# sourceMappingURL=error-messages.d.ts.map
