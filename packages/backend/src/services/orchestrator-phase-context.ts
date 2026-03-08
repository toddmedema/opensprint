/**
 * Context interfaces for PhaseExecutor and ResultHandler.
 * Avoids circular imports between orchestrator and extracted phase/result modules.
 */

import type { StoredTask } from "./task-store.service.js";
import type { AgentConfig, ApiKeyProvider, TestResults } from "@opensprint/shared";

export type FailureType =
  | "test_failure"
  | "review_rejection"
  | "agent_crash"
  | "repo_preflight"
  | "timeout"
  | "no_result"
  | "merge_conflict"
  | "coding_failure";

export interface RetryContext {
  previousFailure?: string;
  reviewFeedback?: string;
  useExistingBranch?: boolean;
  previousTestOutput?: string;
  previousTestFailures?: string;
  previousDiff?: string;
  failureType?: FailureType;
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
  phase: "coding" | "review";
  phaseResult: {
    codingDiff: string;
    codingSummary: string;
    testResults: TestResults | null;
    testOutput: string;
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
    branchName: string
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
}
