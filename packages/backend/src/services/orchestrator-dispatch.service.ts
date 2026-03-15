/**
 * OrchestratorDispatchService — task selection and agent dispatch (slot creation, transition, coding phase).
 * Extracted from OrchestratorService so the main orchestrator composes dispatch as a dependency.
 */

import { getAgentName } from "@opensprint/shared";
import type { StoredTask } from "./task-store.service.js";
import { resolveEpicId } from "./task-store.service.js";
import type {
  FailureType,
  RetryContext,
  RetryQualityGateDetail,
} from "./orchestrator-phase-context.js";
import { resolveBaseBranch } from "../utils/git-repo-state.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("orchestrator-dispatch");

const NEXT_RETRY_CONTEXT_KEY = "next_retry_context";
const MERGE_RETRY_MODE_KEY = "merge_retry_mode";
const BASELINE_MERGE_RETRY_MODE = "baseline_wait";
const BASELINE_QUALITY_GATE_PAUSED_UNTIL_KEY = "merge_quality_gate_paused_until";

const FAILURE_TYPES: FailureType[] = [
  "test_failure",
  "review_rejection",
  "agent_crash",
  "repo_preflight",
  "environment_setup",
  "timeout",
  "no_result",
  "merge_conflict",
  "merge_quality_gate",
  "coding_failure",
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function extractQualityGateDetail(value: unknown): RetryQualityGateDetail | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const command = nonEmptyString(record.command);
  const reason = nonEmptyString(record.reason);
  const outputSnippet = nonEmptyString(record.outputSnippet);
  const worktreePath = nonEmptyString(record.worktreePath);
  const firstErrorLine = nonEmptyString(record.firstErrorLine);
  if (!command && !reason && !outputSnippet && !worktreePath && !firstErrorLine) {
    return undefined;
  }
  return {
    command: command ?? null,
    reason: reason ?? null,
    outputSnippet: outputSnippet ?? null,
    worktreePath: worktreePath ?? null,
    firstErrorLine: firstErrorLine ?? null,
  };
}

function extractQualityGateDetailFromTask(task: StoredTask): RetryQualityGateDetail | undefined {
  const record = task as Record<string, unknown>;
  const nested = extractQualityGateDetail(record.qualityGateDetail);
  const command = nonEmptyString(record.failedGateCommand) ?? nested?.command ?? undefined;
  const reason = nonEmptyString(record.failedGateReason) ?? nested?.reason ?? undefined;
  const outputSnippet =
    nonEmptyString(record.failedGateOutputSnippet) ?? nested?.outputSnippet ?? undefined;
  const worktreePath = nonEmptyString(record.worktreePath) ?? nested?.worktreePath ?? undefined;
  const firstErrorLine =
    nonEmptyString(record.qualityGateFirstErrorLine) ??
    nonEmptyString(record.firstErrorLine) ??
    nested?.firstErrorLine ??
    undefined;

  if (!command && !reason && !outputSnippet && !worktreePath && !firstErrorLine) {
    return undefined;
  }

  return {
    command: command ?? null,
    reason: reason ?? null,
    outputSnippet: outputSnippet ?? null,
    worktreePath: worktreePath ?? null,
    firstErrorLine: firstErrorLine ?? null,
  };
}

function extractRetryContext(task: StoredTask): RetryContext | undefined {
  const raw = (task as Record<string, unknown>)[NEXT_RETRY_CONTEXT_KEY];
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const retryContext: RetryContext = {};
  if (typeof record.previousFailure === "string" && record.previousFailure.trim() !== "") {
    retryContext.previousFailure = record.previousFailure;
  }
  if (typeof record.reviewFeedback === "string" && record.reviewFeedback.trim() !== "") {
    retryContext.reviewFeedback = record.reviewFeedback;
  }
  if (typeof record.previousTestOutput === "string" && record.previousTestOutput.trim() !== "") {
    retryContext.previousTestOutput = record.previousTestOutput;
  }
  if (
    typeof record.previousTestFailures === "string" &&
    record.previousTestFailures.trim() !== ""
  ) {
    retryContext.previousTestFailures = record.previousTestFailures;
  }
  if (typeof record.previousDiff === "string" && record.previousDiff.trim() !== "") {
    retryContext.previousDiff = record.previousDiff;
  }
  const qualityGateDetail =
    extractQualityGateDetail(record.qualityGateDetail) ?? extractQualityGateDetailFromTask(task);
  if (qualityGateDetail) {
    retryContext.qualityGateDetail = qualityGateDetail;
  }
  if (
    typeof record.failureType === "string" &&
    FAILURE_TYPES.includes(record.failureType as FailureType)
  ) {
    retryContext.failureType = record.failureType as FailureType;
  }
  if (Object.keys(retryContext).length === 0) return undefined;
  // Re-dispatched tasks should start from a fresh branch/worktree.
  retryContext.useExistingBranch = false;
  return retryContext;
}

function extractMergeResumeState(task: StoredTask): { worktreePath: string } | undefined {
  const mode = (task as Record<string, unknown>)[MERGE_RETRY_MODE_KEY];
  const worktreePath = (task as Record<string, unknown>).worktreePath;
  if (mode !== BASELINE_MERGE_RETRY_MODE) return undefined;
  if (typeof worktreePath !== "string" || worktreePath.trim() === "") return undefined;
  return {
    worktreePath: worktreePath.trim(),
  };
}

/** Slot shape required by dispatch (must have branchName, fileScope assignable). */
export interface DispatchSlotLike {
  taskId: string;
  taskTitle: string | null;
  branchName: string;
  worktreeKey?: string;
  worktreePath: string | null;
  attempt: number;
  assignee?: string;
  fileScope?: unknown;
  [key: string]: unknown;
}

/** State shape required by dispatch (must have nextCoderIndex and status). */
export interface DispatchStateLike {
  nextCoderIndex: number;
  status: { queueDepth: number };
  slots: Map<string, unknown>;
}

export interface OrchestratorDispatchHost {
  getState(projectId: string): DispatchStateLike;
  createSlot(
    taskId: string,
    taskTitle: string | null,
    branchName: string,
    attempt: number,
    assignee?: string,
    worktreeKey?: string
  ): DispatchSlotLike;
  transition(
    projectId: string,
    t: {
      to: "start_task";
      taskId: string;
      taskTitle: string | null;
      branchName: string;
      attempt: number;
      queueDepth: number;
      slot: DispatchSlotLike;
    }
  ): void;
  persistCounters(projectId: string, repoPath: string): Promise<void>;
  getTaskStore(): {
    update(projectId: string, taskId: string, fields: Record<string, unknown>): Promise<void>;
    getCumulativeAttemptsFromIssue(task: StoredTask): number;
    listAll(projectId: string): Promise<StoredTask[]>;
  };
  getProjectService(): {
    getSettings(
      projectId: string
    ): Promise<{ mergeStrategy?: string; worktreeBaseBranch?: string }>;
  };
  getBranchManager(): { ensureOnMain(repoPath: string, baseBranch: string): Promise<void> };
  getFileScopeAnalyzer(): {
    predict(
      projectId: string,
      repoPath: string,
      task: StoredTask,
      taskStore: { listAll(projectId: string): Promise<StoredTask[]> }
    ): Promise<unknown>;
  };
  executeCodingPhase(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    slot: DispatchSlotLike,
    retryContext?: RetryContext
  ): Promise<void>;
  performMergeRetry(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    slot: DispatchSlotLike
  ): Promise<void>;
}

export class OrchestratorDispatchService {
  constructor(private host: OrchestratorDispatchHost) {}

  async dispatchTask(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    slotQueueDepth: number
  ): Promise<void> {
    const state = this.host.getState(projectId);
    log.info("Picking task", { projectId, taskId: task.id, title: task.title });
    const retryContext = extractRetryContext(task);
    const mergeResumeState = extractMergeResumeState(task);

    let assignee: string | undefined;
    if (!mergeResumeState) {
      assignee = getAgentName(state.nextCoderIndex);
      state.nextCoderIndex += 1;
    }

    const taskStore = this.host.getTaskStore();
    await taskStore.update(projectId, task.id, {
      status: "in_progress",
      ...(assignee !== undefined && { assignee }),
      ...((retryContext != null || mergeResumeState != null) && {
        extra: {
          ...(retryContext != null && { [NEXT_RETRY_CONTEXT_KEY]: null }),
          ...(mergeResumeState && {
            [MERGE_RETRY_MODE_KEY]: null,
            [BASELINE_QUALITY_GATE_PAUSED_UNTIL_KEY]: null,
          }),
        },
      }),
    });
    const cumulativeAttempts = taskStore.getCumulativeAttemptsFromIssue(task);
    const settings = await this.host.getProjectService().getSettings(projectId);
    const mergeStrategy = settings.mergeStrategy ?? "per_task";
    const allIssues = await taskStore.listAll(projectId);
    const epicId = resolveEpicId(task.id, allIssues);
    const useEpicBranch = mergeStrategy === "per_epic" && epicId != null;
    const branchName = useEpicBranch ? `opensprint/epic_${epicId}` : `opensprint/${task.id}`;
    const worktreeKey = useEpicBranch ? `epic_${epicId}` : task.id;

    const slot = this.host.createSlot(
      task.id,
      task.title ?? null,
      branchName,
      cumulativeAttempts + 1,
      assignee,
      worktreeKey
    );
    if (mergeResumeState) {
      slot.worktreePath = mergeResumeState.worktreePath;
    }
    slot.fileScope = await this.host
      .getFileScopeAnalyzer()
      .predict(projectId, repoPath, task, { listAll: (p: string) => taskStore.listAll(p) });

    this.host.transition(projectId, {
      to: "start_task",
      taskId: task.id,
      taskTitle: task.title ?? null,
      branchName,
      attempt: cumulativeAttempts + 1,
      queueDepth: slotQueueDepth,
      slot,
    });

    await this.host.persistCounters(projectId, repoPath);
    const baseBranch = await resolveBaseBranch(repoPath, settings.worktreeBaseBranch);
    await this.host.getBranchManager().ensureOnMain(repoPath, baseBranch);
    if (mergeResumeState) {
      await this.host.performMergeRetry(projectId, repoPath, task, slot);
      return;
    }
    await this.host.executeCodingPhase(projectId, repoPath, task, slot, retryContext);
  }
}
