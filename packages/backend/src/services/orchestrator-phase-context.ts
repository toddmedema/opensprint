/**
 * Context interfaces for PhaseExecutor and ResultHandler.
 * Avoids circular imports between orchestrator and extracted phase/result modules.
 */

import type { StoredTask } from "./task-store.service.js";
import type {
  AgentConfig,
  ApiKeyProvider,
  ReviewAgentResult,
  ReviewAngle,
  TestResults,
} from "@opensprint/shared";
import type { MergeGateVerificationArtifact } from "./merge-verification.service.js";

export type FailureType =
  | "test_failure"
  | "review_rejection"
  | "agent_crash"
  | "repo_preflight"
  | "environment_setup"
  | "workspace_invalid"
  | "timeout"
  | "no_result"
  | "merge_conflict"
  | "merge_quality_gate"
  | "coding_failure";

export interface RetryQualityGateDetail {
  preserveWork?: boolean;
  recoveryIncidentId?: string;
  command?: string | null;
  reason?: string | null;
  outputSnippet?: string | null;
  worktreePath?: string | null;
  firstErrorLine?: string | null;
  category?: "quality_gate" | "environment_setup" | null;
  validationWorkspace?: "baseline" | "merged_candidate" | "task_worktree" | "repo_root" | null;
  repairAttempted?: boolean;
  repairSucceeded?: boolean;
  executable?: string | null;
  cwd?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  classificationConfidence?: "high" | "low" | null;
  classificationReason?: string | null;
  gitStatusPorcelainSnippet?: string | null;
  gitNameStatusSnippet?: string | null;
  gateNodeVersion?: string | null;
  gateNpmVersion?: string | null;
  gateDependencyStrategy?: string | null;
  gateHermeticNodeModules?: boolean | null;
}

/** Condensed prior failure for multi-attempt prompts (avoids ping-pong regressions). */
export interface RetryFailureHistoryEntry {
  attempt: number;
  failureType: FailureType;
  summary: string;
  /** Failure timestamp (ISO). Older entries may not include this. */
  occurredAt?: string;
  /** Stable signature for duplicate-failure suppression. */
  signature?: string;
}

export interface RetryContext {
  previousFailure?: string;
  reviewFeedback?: string;
  useExistingBranch?: boolean;
  structuredOutputRepairAttempted?: boolean;
  previousTestOutput?: string;
  previousTestFailures?: string;
  previousDiff?: string;
  qualityGateDetail?: RetryQualityGateDetail;
  failureType?: FailureType;
  /** Last N failures from earlier attempts on this task (newest appended in handleTaskFailure). */
  failureHistory?: RetryFailureHistoryEntry[];
}

/** Slot shape needed by executeCodingPhase; full AgentSlot from orchestrator */
export interface AgentSlotLike {
  taskId: string;
  taskTitle: string | null;
  branchName: string;
  /** When set (per_epic + epic task), worktree key for createTaskWorktree (e.g. epic_<epicId>). */
  worktreeKey?: string;
  worktreePath: string | null;
  attempt: number;
  /** Unique ID for this attempt, for cross-event correlation. */
  attemptId?: string;
  phase: "coding" | "review";
  phaseResult: {
    codingDiff: string;
    codingSummary: string;
    governanceAppeals?: import("@opensprint/shared").ReviewAppeal[];
    testResults: TestResults | null;
    testOutput: string;
    validationCommand?: string | null;
    qualityGateDetail?: RetryQualityGateDetail | null;
  };
  infraRetries: number;
  agent: { outputLog: string[]; startedAt: string; killedDueToTimeout: boolean };
  timers: { clearAll: () => void };
  reviewAgents?: Map<
    string,
    {
      angle?: string;
      agent: { outputLog: string[]; startedAt: string; killedDueToTimeout: boolean };
      timers: { clearAll: () => void };
    }
  >;
  /** When true, general reviewer runs alongside angle-specific reviewers (multi-angle review). */
  includeGeneralReview?: boolean;
  retryContext?: RetryContext;
  /** Agent config used for the currently running attempt (set before spawn). */
  activeAgentConfig?: AgentConfig;
}

export type ReviewRetryTarget = "general" | ReviewAngle;

/** Results carried over from coding phase to review/merge */
export interface PhaseResult {
  codingDiff: string;
  codingSummary: string;
  governanceAppeals?: import("@opensprint/shared").ReviewAppeal[];
  testResults: TestResults | null;
  testOutput: string;
  validationCommand?: string | null;
  qualityGateDetail?: RetryQualityGateDetail | null;
  mergeGateArtifactTaskWorktree?: MergeGateVerificationArtifact | null;
}

/** Format review rejection result into actionable feedback for the coding agent retry prompt. */
export function formatReviewFeedback(result: ReviewAgentResult): string {
  const parts: string[] = [];
  if (result.summary) {
    parts.push(result.summary);
  }
  if (result.issues && result.issues.length > 0) {
    parts.push("\n\nIssues to address:");
    for (const issue of result.issues) {
      parts.push(`\n- ${issue}`);
    }
  }
  if (result.findings?.length) {
    parts.push(
      `\n\nStructured findings (fix or submit a bounded appeal for an eligible standard):\n${JSON.stringify(result.findings)}`
    );
  }
  if (result.notes?.trim()) {
    parts.push(`\n\nNotes: ${result.notes.trim()}`);
  }
  if (parts.length === 0) {
    return "Review rejected (no details provided by review agent).";
  }
  return parts.join("");
}

/** Callbacks PhaseExecutor needs from ResultHandler (passed from Orchestrator) */
export interface PhaseExecutorCallbacks {
  handleCodingDone(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    exitCode: number | null
  ): Promise<void>;
  handleReviewDone(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    exitCode: number | null,
    angle?: import("@opensprint/shared").ReviewAngle
  ): Promise<void>;
  handleTaskFailure(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    reason: string,
    testResults?: TestResults | null,
    failureType?: FailureType,
    reviewFeedback?: string
  ): Promise<void>;
  /** Called when API keys are exhausted for a provider; orchestrator reverts task, frees slot, emits notification */
  handleApiKeysExhausted?(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    provider: ApiKeyProvider
  ): Promise<void>;
}

/** Callbacks ResultHandler needs from PhaseExecutor (passed from Orchestrator) */
export interface ResultHandlerCallbacks {
  executeCodingPhase(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    slot: AgentSlotLike,
    retryContext?: RetryContext
  ): Promise<void>;
  executeReviewPhase(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    retryContext?: RetryContext,
    reviewTarget?: ReviewRetryTarget
  ): Promise<void>;
}

/** GUPP-style assignment file shape (see AGENTS.md) */
export interface TaskAssignmentLike {
  taskId: string;
  projectId: string;
  phase: "coding" | "review";
  branchName: string;
  /** Worktree key (task.id or epic_<epicId>). Persisted so recovery uses same branch/worktree. */
  worktreeKey?: string;
  worktreePath: string;
  promptPath: string;
  agentConfig: AgentConfig;
  attempt: number;
  retryContext?: RetryContext;
  angle?: string;
  createdAt: string;
  invocationId?: string;
  governance?: {
    releaseId: string;
    contextHash: string;
    baseSha: string;
    headSha: string;
    trustedScopeHash: string;
  };
  /** Present when agent enhancement / behavior versioning supplies replay context (assignment.json). */
  replayMetadata?: {
    baseCommitSha: string;
    behaviorVersionId?: string;
    templateVersionId?: string;
  };
}
