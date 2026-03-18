/**
 * Centralized error codes and failure types → user-facing messages.
 * Use this map so UI and notifications show the same actionable guidance.
 * Backend ErrorCodes and execution failure types (repo_preflight, environment_setup, etc.)
 * are linked here; backend and frontend both import from @opensprint/shared.
 */

/** User-facing message for each API error code (backend ErrorCodes). Actionable guidance. */
export const ERROR_CODE_MESSAGES: Record<string, string> = {
  // 4xx — Client errors
  INVALID_INPUT: "Check your input and try again.",
  NOT_FOUND: "The requested resource was not found.",
  NOT_DIRECTORY: "Path is not a directory.",
  ALREADY_EXISTS: "Resource already exists.",
  INVALID_KEY: "Invalid or missing key.",
  INVALID_AGENT_CONFIG: "Configure API keys in Settings.",
  ALREADY_OPENSPRINT_PROJECT: "This folder is already an Open Sprint project.",
  UNSUPPORTED_REPO_PATH:
    "Use a Linux path for the repo (e.g. /home/...). Windows-mounted WSL paths are not supported.",
  GIT_IDENTITY_REQUIRED: "Configure Git user.name and user.email in the repo, then try again.",
  GIT_BASE_BRANCH_INVALID: "Set a valid base branch in Project Settings.",
  GIT_REMOTE_UNREACHABLE: "Check remote URL and network; ensure the remote is reachable.",
  DEPENDENCY_SETUP_FAILED:
    "Run npm ci in the repository root, fix invalid dependencies, then retry.",
  REPO_DEPENDENCIES_INVALID: "Fix repository dependencies (e.g. run npm ci), then retry.",
  NO_GATE_TASK: "Generate tasks first or add a gating task in Plan.",
  TASKS_IN_PROGRESS: "Wait for in-progress tasks to finish, or cancel them.",
  TASKS_NOT_COMPLETE: "Complete or cancel open tasks before this action.",
  ASSIGNEE_LOCKED: "The change was reverted.",
  NO_EPIC: "Plan has no epic. Use Generate Tasks to generate tasks first.",
  FEEDBACK_HAS_DONE_TASK: "Cannot cancel feedback once a linked task is done.",
  DECOMPOSE_PARSE_FAILED: "Plan decomposition failed; try regenerating tasks.",
  DECOMPOSE_JSON_INVALID: "Invalid plan structure; try regenerating tasks.",
  DECOMPOSE_EMPTY: "Plan produced no tasks; try again or adjust the plan.",
  MIGRATION_REQUIRED: "Database migration is required. Restart the backend or run migrations.",

  // 404 — Not found
  PROJECT_NOT_FOUND: "Project may have been removed.",
  PRD_NOT_FOUND: "PRD not found for this project.",
  PLAN_NOT_FOUND: "Plan may have been removed.",
  PLAN_VERSION_NOT_FOUND: "Plan version not found.",
  SECTION_NOT_FOUND: "Section not found.",
  SETTINGS_NOT_FOUND: "Settings not found.",
  FEEDBACK_NOT_FOUND: "Feedback not found.",
  SESSION_NOT_FOUND: "Task or session may have been removed.",
  ISSUE_NOT_FOUND: "Task or session may have been removed.",
  NOTIFICATION_NOT_FOUND: "Notification not found.",

  // 5xx — Server / external
  INTERNAL_ERROR: "An unexpected error occurred. Try again or restart the backend.",
  DATABASE_UNAVAILABLE:
    "Database is unavailable. Check connection and retry; the app will retry automatically.",
  TASK_STORE_INIT_FAILED: "Task store could not be initialized. Check database configuration.",
  TASK_STORE_WRITE_FAILED: "Failed to write to task store. Check disk and database.",
  TASK_STORE_TIMEOUT: "Task store operation timed out. Try again.",
  TASK_STORE_PARSE_FAILED: "Task data could not be read. Contact support if this persists.",
  TASK_STORE_CLOSE_FAILED: "Task store close failed. Restart the backend if needed.",
  TASK_STORE_CREATE_FAILED: "Failed to create task. Try again.",
  ENV_WRITE_FAILED: "Failed to write environment file. Check permissions.",

  // Scaffold
  SCAFFOLD_INIT_FAILED: "Project scaffold failed. Check logs and try again.",
  SCAFFOLD_PREREQUISITES_MISSING: "Install prerequisites (e.g. Node.js, npm), then try again.",

  // Agent
  AGENT_UNSUPPORTED_TYPE: "Unsupported agent type. Check Project Settings → Agent.",
  AGENT_TASK_FILE_READ_FAILED: "Could not read task file. Check worktree and retry.",
  AGENT_CLI_REQUIRED: "Install the agent CLI (see Project Settings → Agent Config).",
  AGENT_INVOKE_FAILED: "Check agent login or Project Settings → Agent Config.",
  ANTHROPIC_API_KEY_MISSING: "Add Anthropic API key in Global Settings → API keys.",
  CURSOR_API_ERROR: "Check Cursor agent login or API key in Project Settings.",
  OPENAI_API_ERROR: "Check OpenAI API key in Global Settings → API keys.",
  GOOGLE_API_ERROR: "Check Google API key in Global Settings → API keys.",
  LM_STUDIO_UNREACHABLE: "Ensure LM Studio is running and the endpoint is correct.",
};

/**
 * Returns the user-facing message for an error code, or null if unknown.
 */
export function getMessageForErrorCode(code: string | undefined): string | null {
  if (!code) return null;
  return ERROR_CODE_MESSAGES[code] ?? null;
}

/** Alias for UI/notification hints (one-line actionable guidance). */
export const ERROR_CODE_HINTS = ERROR_CODE_MESSAGES;

/** Returns the same as getMessageForErrorCode (alias for compatibility). */
export function getErrorCodeHint(code: string | undefined): string | null {
  return getMessageForErrorCode(code);
}

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
export const FAILURE_TYPE_LABELS: Record<FailureType, string> = {
  test_failure: "Tests failed",
  review_rejection: "Review rejected",
  agent_crash: "Agent crashed",
  repo_preflight: "Repo preflight failed",
  environment_setup: "Environment setup failed",
  timeout: "Timeout",
  no_result: "No result",
  merge_conflict: "Merge conflict",
  merge_quality_gate: "Quality gate failed",
  coding_failure: "Coding failed",
};

/**
 * Label for quality-gate failure (merge or environment). Use when failureType is
 * environment_setup vs merge_quality_gate to show the same text as backend summaries.
 */
export function getQualityGateFailureLabel(
  failureType: "environment_setup" | "merge_quality_gate"
): string {
  return failureType === "environment_setup"
    ? FAILURE_TYPE_LABELS.environment_setup
    : FAILURE_TYPE_LABELS.merge_quality_gate;
}

/** "Quality gate failed" when outcome is requeued/blocked due to quality gate. */
export const QUALITY_GATE_FAILED_LABEL = "Quality gate failed";

/** "Quality gate blocked" when task is blocked after quality gate failure. */
export const QUALITY_GATE_BLOCKED_LABEL = "Quality gate blocked";

/** Display label for the quality_gate merge stage (e.g. in execution timeline). */
export const QUALITY_GATE_STAGE_LABEL = "Quality gate";

/** Default reason when quality gate fails (used in summaries). */
export const QUALITY_GATE_FAILURE_MESSAGE = "Pre-merge quality gates failed";

/**
 * Title for quality gate outcome (blocked vs failed). Use for merge/quality_gate stage.
 */
export function getQualityGateTitle(blocked: boolean): string {
  return blocked ? QUALITY_GATE_BLOCKED_LABEL : QUALITY_GATE_FAILED_LABEL;
}

/**
 * Title for failure type. Accepts execution failure types and "quality_gate" (alias for merge_quality_gate).
 */
export function getFailureTypeTitle(type: FailureType | "quality_gate"): string {
  const key = type === "quality_gate" ? "merge_quality_gate" : type;
  return FAILURE_TYPE_LABELS[key as FailureType] ?? type;
}

/** Titles for failure types used in orchestrator/diagnostics (environment_setup, quality_gate, repo_preflight). */
export const FAILURE_TYPE_TITLES: Record<string, string> = {
  environment_setup: FAILURE_TYPE_LABELS.environment_setup,
  quality_gate: FAILURE_TYPE_LABELS.merge_quality_gate,
  repo_preflight: FAILURE_TYPE_LABELS.repo_preflight,
};

/** Remediation for repo preflight when the failure is Git-related. */
export const REPO_PREFLIGHT_REMEDIATION_GIT =
  "Fix repository git setup (base branch and git identity), then retry.";

/** Remediation for repo preflight when the failure is dependency-related. */
export const REPO_PREFLIGHT_REMEDIATION_DEPENDENCY =
  "Run npm ci in the repository root, then fix invalid dependencies before retrying.";

/** Remediation for environment_setup failure. */
export const ENVIRONMENT_SETUP_REMEDIATION =
  "Run npm ci in the repository root, re-link worktree node_modules, then retry.";

/** Remediation constants (aliases for compatibility). */
export const REMEDIATION_ENVIRONMENT_SETUP = ENVIRONMENT_SETUP_REMEDIATION;
export const REMEDIATION_PREFLIGHT_DEPENDENCY = REPO_PREFLIGHT_REMEDIATION_DEPENDENCY;
export const REMEDIATION_PREFLIGHT_GIT = REPO_PREFLIGHT_REMEDIATION_GIT;

/**
 * Returns the remediation message for repo_preflight or environment_setup.
 */
export function getRemediationForFailureType(
  failureType: "repo_preflight" | "environment_setup",
  isDependencySetupPreflight?: boolean
): string {
  if (failureType === "environment_setup") return ENVIRONMENT_SETUP_REMEDIATION;
  return isDependencySetupPreflight
    ? REPO_PREFLIGHT_REMEDIATION_DEPENDENCY
    : REPO_PREFLIGHT_REMEDIATION_GIT;
}
