/**
 * MergeCoordinator — merge-to-main, push, conflict resolution, and post-completion.
 * Extracted from OrchestratorService. Owns all git merge/push logic and the push mutex.
 *
 * Key design principles:
 * - Merge FIRST, close task AFTER (never close before merge)
 * - Merge/rebase conflicts are handled by bounded merger rounds; unresolved conflicts are requeued
 * - Task close is a separate commit after the merge commit
 * - Push rebase conflicts: run bounded merger rounds until rebase completes or fail safely
 */

import {
  BACKOFF_FAILURE_THRESHOLD,
  type BaselineRuntimeStatus,
  type MergeValidationRuntimeStatus,
  QUALITY_GATE_FAILURE_MESSAGE,
  resolveTestCommand,
  type AgentConfig,
  type TestResults,
} from "@opensprint/shared";
import type { ServerEvent } from "@opensprint/shared";
import type { StoredTask } from "./task-store.service.js";
import { resolveEpicId } from "./task-store.service.js";
import { RebaseConflictError } from "./branch-manager.js";
import { gitCommitQueue, MergeJobError } from "./git-commit-queue.service.js";
import { agentIdentityService } from "./agent-identity.service.js";
import { eventLogService } from "./event-log.service.js";
import { triggerDeployForEvent } from "./deploy-trigger.service.js";
import { finalReviewService } from "./final-review.service.js";
import { notificationService } from "./notification.service.js";
import { selfImprovementService } from "./self-improvement.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { broadcastAuthoritativeTaskUpdated } from "../task-store-events.js";
import type { TimerRegistry } from "./timer-registry.js";
import { createLogger } from "../utils/logger.js";
import { buildTaskLastExecutionSummary, compactExecutionText } from "./task-execution-summary.js";
import { inspectGitRepoState, resolveBaseBranch } from "../utils/git-repo-state.js";
import { getMergeQualityGateCommands } from "./merge-quality-gates.js";
import type { RetryContext, RetryQualityGateDetail } from "./orchestrator-phase-context.js";
import { validationWorkspaceService } from "./validation-workspace.service.js";

const log = createLogger("merge-coordinator");
const _MAX_PUSH_REBASE_RESOLUTION_ROUNDS = 12;
const NEXT_RETRY_CONTEXT_KEY = "next_retry_context";
const MERGE_RETRY_MODE_KEY = "merge_retry_mode";
const BASELINE_MERGE_RETRY_MODE = "baseline_wait";
const MERGE_RETRY_CONTEXT_FAILURE_LIMIT = 1200;
const QUALITY_GATE_OUTPUT_SNIPPET_LIMIT = 1800;
const BASELINE_QUALITY_GATE_SUCCESS_CACHE_MS = 15_000;
const BASELINE_QUALITY_GATE_PAUSE_MS = 5 * 60_000;
const BASELINE_QUALITY_GATE_PAUSED_UNTIL_KEY = "merge_quality_gate_paused_until";
const MERGE_VALIDATION_PAUSED_UNTIL_KEY = "merge_validation_paused_until";
const BASELINE_QUALITY_GATE_NOTIFICATION_SOURCE_ID = "merge-quality-gate-baseline";
const BASELINE_QUALITY_GATE_TASK_SOURCE = "merge-quality-gate-baseline";
const MERGE_VALIDATION_HEALTH_NOTIFICATION_SOURCE_ID = "merge-validation-health";
const MERGE_VALIDATION_DEGRADED_THRESHOLD = 3;
const MERGE_VALIDATION_FAILURE_WINDOW_MS = 10 * 60_000;
const MERGE_VALIDATION_CANARY_INTERVAL_MS = 5 * 60_000;

/** One-sentence explanation for merge failures shown to users (conflicts with main in same files). */
const HUMAN_MERGE_FAILURE_MESSAGE =
  "The merge could not complete because your branch and main both changed the same files.";
const MERGE_CONFLICT_BLOCK_REASON = "Merge Failure";
const QUALITY_GATE_BLOCK_REASON = "Quality Gate Failure";

type MergeFailureStage = "rebase_before_merge" | "merge_to_main" | "push_rebase" | "quality_gate";

export interface MergeQualityGateRunOptions {
  projectId: string;
  repoPath: string;
  worktreePath: string;
  taskId: string;
  branchName: string;
  baseBranch: string;
  validationWorkspace?: "baseline" | "merged_candidate" | "task_worktree" | "repo_root";
}

export interface MergeQualityGateFailure {
  command: string;
  reason: string;
  output: string;
  outputSnippet?: string;
  worktreePath?: string;
  firstErrorLine?: string;
  validationWorkspace?: "baseline" | "merged_candidate" | "task_worktree" | "repo_root";
  category?: "environment_setup" | "quality_gate";
  autoRepairAttempted?: boolean;
  autoRepairSucceeded?: boolean;
  autoRepairCommands?: string[];
  autoRepairOutput?: string;
  executable?: string;
  cwd?: string;
  exitCode?: number | null;
  signal?: string | null;
}

export interface MergeSlot {
  taskId: string;
  attempt: number;
  worktreePath: string | null;
  branchName: string;
  /** When set (per_epic + epic task), worktree key for removeTaskWorktree (e.g. epic_<epicId>). */
  worktreeKey?: string;
  phaseResult: {
    codingDiff: string;
    codingSummary: string;
    testResults: TestResults | null;
    testOutput: string;
    qualityGateDetail?: RetryQualityGateDetail | null;
  };
  agent: { outputLog: string[]; startedAt: string };
}

interface CleanupTarget {
  taskId: string;
  branchName: string;
  worktreePath: string | null;
  gitWorkingMode: "worktree" | "branches";
  /** When set (per_epic + epic task), key for removeTaskWorktree (e.g. epic_<epicId>). */
  worktreeKey?: string;
}

type PushCompletionStatus = "published" | "local_only" | "publish_failed";

export interface MergeCoordinatorHost {
  getState(projectId: string): {
    slots: Map<string, MergeSlot>;
    status: { totalDone: number; totalFailed: number; queueDepth: number };
    globalTimers: TimerRegistry;
  };
  taskStore: {
    close(projectId: string, taskId: string, reason: string): Promise<void>;
    update(projectId: string, taskId: string, fields: Record<string, unknown>): Promise<void>;
    comment(projectId: string, taskId: string, text: string): Promise<void>;
    sync(repoPath: string): Promise<void>;
    syncForPush(projectId: string): Promise<void>;
    listAll(projectId: string): Promise<StoredTask[]>;
    show(projectId: string, id: string): Promise<StoredTask>;
    setCumulativeAttempts(
      projectId: string,
      id: string,
      count: number,
      options?: { currentLabels?: string[] }
    ): Promise<void>;
    getCumulativeAttemptsFromIssue(issue: StoredTask): number;
    setConflictFiles(projectId: string, id: string, files: string[]): Promise<void>;
    setMergeStage(projectId: string, id: string, stage: string | null): Promise<void>;
    planGetByEpicId(
      projectId: string,
      epicId: string
    ): Promise<{
      plan_id: string;
      content: string;
      metadata: Record<string, unknown>;
      shipped_content: string | null;
      updated_at: string;
    } | null>;
  };
  branchManager: {
    waitForGitReady(wtPath: string): Promise<void>;
    commitWip(wtPath: string, taskId: string): Promise<void>;
    removeTaskWorktree(repoPath: string, taskId: string, actualPath?: string): Promise<void>;
    deleteBranch(repoPath: string, branchName: string): Promise<void>;
    revertAndReturnToMain?(
      repoPath: string,
      branchName: string,
      baseBranch?: string
    ): Promise<void>;
    getChangedFiles(repoPath: string, branchName: string, baseBranch?: string): Promise<string[]>;
    prepareMainForPush(repoPath: string, baseBranch?: string): Promise<void>;
    pushMain(repoPath: string, baseBranch?: string): Promise<void>;
    pushMainToOrigin(repoPath: string, baseBranch?: string): Promise<void>;
    isMergeInProgress(repoPath: string): Promise<boolean>;
    mergeAbort(repoPath: string): Promise<void>;
    mergeContinue(repoPath: string): Promise<void>;
    rebaseAbort(repoPath: string): Promise<void>;
    rebaseContinue(repoPath: string): Promise<void>;
  };
  runMergerAgentAndWait(options: {
    projectId: string;
    cwd: string;
    config: AgentConfig;
    phase: "rebase_before_merge" | "merge_to_main" | "push_rebase";
    taskId: string;
    branchName: string;
    conflictedFiles: string[];
    testCommand?: string;
    mergeQualityGates?: string[];
    baseBranch?: string;
  }): Promise<boolean>;
  runMergeQualityGates?(
    options: MergeQualityGateRunOptions
  ): Promise<MergeQualityGateFailure | null>;
  setBaselineRuntimeState(
    projectId: string,
    repoPath: string,
    updates: {
      baselineStatus?: BaselineRuntimeStatus;
      baselineCheckedAt?: string | null;
      baselineFailureSummary?: string | null;
      dispatchPausedReason?: string | null;
    }
  ): Promise<void>;
  setMergeValidationRuntimeState(
    projectId: string,
    repoPath: string,
    updates: {
      mergeValidationStatus?: MergeValidationRuntimeStatus;
      mergeValidationFailureSummary?: string | null;
    }
  ): Promise<void>;
  sessionManager: {
    createSession(repoPath: string, data: Record<string, unknown>): Promise<{ id: string }>;
    archiveSession(
      repoPath: string,
      taskId: string,
      attempt: number,
      session: { id: string },
      wtPath?: string
    ): Promise<void>;
  };
  fileScopeAnalyzer: {
    recordActual(
      projectId: string,
      repoPath: string,
      taskId: string,
      changedFiles: string[],
      taskStore: unknown
    ): Promise<void>;
  };
  feedbackService: {
    checkAutoResolveOnTaskDone(projectId: string, taskId: string): Promise<void>;
  };
  projectService: {
    getSettings(projectId: string): Promise<{
      simpleComplexityAgent: { type: string; model?: string | null };
      complexComplexityAgent: { type: string; model?: string | null };
      deployment: { targets?: Array<{ name: string; autoDeployTrigger?: string }> };
      testCommand?: string | null;
      testFramework?: string | null;
      gitWorkingMode?: "worktree" | "branches";
      worktreeBaseBranch?: string;
      unknownScopeStrategy?: "conservative" | "optimistic";
      mergeStrategy?: "per_task" | "per_epic";
    }>;
  };
  transition(projectId: string, t: { to: "complete" | "fail"; taskId: string }): void;
  persistCounters(projectId: string, repoPath: string): Promise<void>;
  nudge(projectId: string): void;
}

export class MergeCoordinatorService {
  /** Guard against concurrent pushes per project */
  private pushInProgress = new Set<string>();
  /** Promise per project that resolves when the current push completes */
  private pushCompletion = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  /** Branch/worktree cleanup deferred until push succeeds. */
  private pendingCleanup = new Map<string, Map<string, CleanupTarget>>();
  /** Cached healthy baseline result per project/base branch. */
  private baselineQualityGateSuccessCache = new Map<string, { checkedAtMs: number }>();
  /** Shared in-flight baseline check per project/base branch. */
  private baselineQualityGateSingleFlight = new Map<
    string,
    Promise<MergeQualityGateFailure | null>
  >();
  /** Dedupes baseline gate notifications while baseline remains unhealthy. */
  private baselineQualityGateNotified = new Set<string>();
  /** Rolling timestamps of merge-validation environment failures per project. */
  private mergeValidationEnvironmentFailures = new Map<string, number[]>();
  /** Project-level merge-validation health state. */
  private mergeValidationHealth = new Map<
    string,
    {
      status: MergeValidationRuntimeStatus;
      summary: string | null;
      nextCanaryAtMs: number | null;
    }
  >();
  /** Dedupes project-level merge-validation notifications while degraded. */
  private mergeValidationHealthNotified = new Set<string>();

  constructor(private host: MergeCoordinatorHost) {}

  private registerPendingCleanup(projectId: string, target: CleanupTarget): void {
    let perProject = this.pendingCleanup.get(projectId);
    if (!perProject) {
      perProject = new Map<string, CleanupTarget>();
      this.pendingCleanup.set(projectId, perProject);
    }
    perProject.set(target.taskId, target);
  }

  private async cleanupAfterSuccessfulPush(projectId: string, repoPath: string): Promise<void> {
    const perProject = this.pendingCleanup.get(projectId);
    if (!perProject || perProject.size === 0) return;
    const settings = await this.host.projectService.getSettings(projectId);
    const baseBranch = await resolveBaseBranch(repoPath, settings.worktreeBaseBranch);

    for (const target of perProject.values()) {
      log.info("Push succeeded, cleaning up merged branch/worktree", {
        taskId: target.taskId,
        branchName: target.branchName,
      });
      try {
        if (target.gitWorkingMode === "branches") {
          if (this.host.branchManager.revertAndReturnToMain) {
            await this.host.branchManager.revertAndReturnToMain(
              repoPath,
              target.branchName,
              baseBranch
            );
          } else {
            await this.host.branchManager.deleteBranch(repoPath, target.branchName);
          }
        } else {
          const key = target.worktreeKey ?? target.taskId;
          await this.host.branchManager.removeTaskWorktree(
            repoPath,
            key,
            target.worktreePath ?? undefined
          );
          await this.host.branchManager.deleteBranch(repoPath, target.branchName);
        }
        perProject.delete(target.taskId);
      } catch (err) {
        log.warn("Deferred cleanup failed", {
          taskId: target.taskId,
          branchName: target.branchName,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (perProject.size === 0) {
      this.pendingCleanup.delete(projectId);
    }
  }

  private getScopeConfidence(issue: StoredTask): "explicit" | "inferred" | "heuristic" {
    const labels = (issue.labels ?? []) as string[];
    if (
      labels.some((l) => l.startsWith("conflict_files:")) ||
      labels.some((l) => l.startsWith("files:"))
    ) {
      return "explicit";
    }
    if (labels.some((l) => l.startsWith("actual_files:"))) {
      return "inferred";
    }
    return "heuristic";
  }

  private getHumanFailureMessage(stage: MergeFailureStage): string {
    return stage === "quality_gate" ? QUALITY_GATE_FAILURE_MESSAGE : HUMAN_MERGE_FAILURE_MESSAGE;
  }

  private getMergeFailureBlockReason(stage: MergeFailureStage): string {
    return stage === "quality_gate" ? QUALITY_GATE_BLOCK_REASON : MERGE_CONFLICT_BLOCK_REASON;
  }

  private getMergeFailureType(
    stage: MergeFailureStage,
    failureTypeOverride?: RetryContext["failureType"]
  ): RetryContext["failureType"] {
    if (failureTypeOverride) return failureTypeOverride;
    return stage === "quality_gate" ? "merge_quality_gate" : "merge_conflict";
  }

  private buildRetryContextForMergeFailure(
    stage: MergeFailureStage,
    mergeFailureReason: string,
    failureTypeOverride?: RetryContext["failureType"],
    qualityGateDetail?: RetryQualityGateDetail | null
  ): RetryContext {
    const stageLabel = stage === "quality_gate" ? "pre-merge quality gate" : "merge";
    const detailSummary =
      stage === "quality_gate" && qualityGateDetail
        ? [
            qualityGateDetail.command ? `cmd: ${qualityGateDetail.command}` : null,
            qualityGateDetail.firstErrorLine
              ? `error: ${qualityGateDetail.firstErrorLine}`
              : qualityGateDetail.reason
                ? `reason: ${qualityGateDetail.reason}`
                : null,
          ]
            .filter((part): part is string => part != null && part.trim().length > 0)
            .join(" | ")
        : "";
    const previousFailure = compactExecutionText(
      `${stageLabel} failed: ${mergeFailureReason}${detailSummary ? ` (${detailSummary})` : ""}`,
      MERGE_RETRY_CONTEXT_FAILURE_LIMIT
    );
    const retryContext: RetryContext = {
      previousFailure,
      failureType: this.getMergeFailureType(stage, failureTypeOverride),
    };
    if (stage === "quality_gate" && qualityGateDetail) {
      retryContext.qualityGateDetail = qualityGateDetail;
    }
    return retryContext;
  }

  private getFirstNonEmptyLine(text: string): string | null {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length > 0) return trimmed;
    }
    return null;
  }

  private getQualityGateFirstErrorLine(failure: MergeQualityGateFailure): string {
    const explicit = failure.firstErrorLine?.trim();
    if (explicit) return explicit;
    return (
      this.getFirstNonEmptyLine(failure.output) ??
      this.getFirstNonEmptyLine(failure.reason) ??
      "Unknown quality gate failure"
    );
  }

  private getQualityGateFailureDetails(
    mergeErr: Error
  ): MergeJobError["qualityGateFailure"] | null {
    if (!(mergeErr instanceof MergeJobError) || mergeErr.stage !== "quality_gate") return null;
    return mergeErr.qualityGateFailure ?? null;
  }

  private toOutputSnippet(text: string | null | undefined): string | null {
    const trimmed = text?.trim();
    if (!trimmed) return null;
    return compactExecutionText(trimmed, QUALITY_GATE_OUTPUT_SNIPPET_LIMIT);
  }

  private buildQualityGateStructuredDetails(
    qualityGateFailure: MergeJobError["qualityGateFailure"] | null,
    fallbackWorktreePath?: string | null
  ): {
    failedGateCommand: string | null;
    failedGateReason: string | null;
    failedGateOutputSnippet: string | null;
    worktreePath: string | null;
    qualityGateCategory: "quality_gate" | "environment_setup" | null;
    qualityGateValidationWorkspace:
      | "baseline"
      | "merged_candidate"
      | "task_worktree"
      | "repo_root"
      | null;
    qualityGateRepairAttempted: boolean;
    qualityGateRepairSucceeded: boolean;
    qualityGateExecutable: string | null;
    qualityGateCwd: string | null;
    qualityGateExitCode: number | null;
    qualityGateSignal: string | null;
    qualityGateDetail: {
      command: string | null;
      reason: string | null;
      outputSnippet: string | null;
      worktreePath: string | null;
      firstErrorLine: string | null;
      category: "quality_gate" | "environment_setup" | null;
      validationWorkspace: "baseline" | "merged_candidate" | "task_worktree" | "repo_root" | null;
      repairAttempted: boolean;
      repairSucceeded: boolean;
      executable: string | null;
      cwd: string | null;
      exitCode: number | null;
      signal: string | null;
    } | null;
  } {
    const failedGateCommand = qualityGateFailure?.command?.trim() || null;
    const failedGateReason = qualityGateFailure?.reason?.trim() || null;
    const failedGateOutputSnippet = this.toOutputSnippet(
      qualityGateFailure?.outputSnippet ?? qualityGateFailure?.firstErrorLine ?? null
    );
    const worktreePath =
      qualityGateFailure?.worktreePath?.trim() || fallbackWorktreePath?.trim() || null;
    const firstErrorLine = qualityGateFailure?.firstErrorLine?.trim() || null;
    const qualityGateCategory = qualityGateFailure?.category ?? null;
    const qualityGateValidationWorkspace = qualityGateFailure?.validationWorkspace ?? null;
    const qualityGateRepairAttempted = qualityGateFailure?.autoRepairAttempted ?? false;
    const qualityGateRepairSucceeded = qualityGateFailure?.autoRepairSucceeded ?? false;
    const qualityGateExecutable = qualityGateFailure?.executable?.trim() || null;
    const qualityGateCwd = qualityGateFailure?.cwd?.trim() || null;
    const qualityGateExitCode = qualityGateFailure?.exitCode ?? null;
    const qualityGateSignal = qualityGateFailure?.signal?.trim() || null;
    const hasDetail =
      failedGateCommand != null ||
      failedGateReason != null ||
      failedGateOutputSnippet != null ||
      worktreePath != null ||
      firstErrorLine != null ||
      qualityGateCategory != null ||
      qualityGateValidationWorkspace != null ||
      qualityGateRepairAttempted ||
      qualityGateRepairSucceeded ||
      qualityGateExecutable != null ||
      qualityGateCwd != null ||
      qualityGateExitCode != null ||
      qualityGateSignal != null;
    return {
      failedGateCommand,
      failedGateReason,
      failedGateOutputSnippet,
      worktreePath,
      qualityGateCategory,
      qualityGateValidationWorkspace,
      qualityGateRepairAttempted,
      qualityGateRepairSucceeded,
      qualityGateExecutable,
      qualityGateCwd,
      qualityGateExitCode,
      qualityGateSignal,
      qualityGateDetail: hasDetail
        ? {
            command: failedGateCommand,
            reason: failedGateReason,
            outputSnippet: failedGateOutputSnippet,
            worktreePath,
            firstErrorLine,
            category: qualityGateCategory,
            validationWorkspace: qualityGateValidationWorkspace,
            repairAttempted: qualityGateRepairAttempted,
            repairSucceeded: qualityGateRepairSucceeded,
            executable: qualityGateExecutable,
            cwd: qualityGateCwd,
            exitCode: qualityGateExitCode,
            signal: qualityGateSignal,
          }
        : null,
    };
  }

  private isEnvironmentSetupQualityGateFailure(mergeErr: Error): boolean {
    return this.getQualityGateFailureDetails(mergeErr)?.category === "environment_setup";
  }

  private buildEnvironmentSetupRemediation(params: {
    command?: string | null;
    worktreePath?: string | null;
  }): string {
    const command = params.command?.trim();
    const worktreePath = params.worktreePath?.trim();
    const commandStep = command
      ? `then rerun ${command} before retrying merge.`
      : "then rerun the failing quality gate before retrying merge.";
    return compactExecutionText(
      `Run npm ci${worktreePath ? ` in ${worktreePath}` : " in the repository root"}, re-link worktree node_modules, ${commandStep}`,
      500
    );
  }

  private buildQualityGateSummaryDetail(mergeErr: Error): string | null {
    const qualityGateFailure = this.getQualityGateFailureDetails(mergeErr);
    if (!qualityGateFailure) return null;

    const command = qualityGateFailure.command?.trim();
    const firstErrorLine = qualityGateFailure.firstErrorLine?.trim();

    const details: string[] = [];
    if (command) details.push(`cmd: ${command}`);
    if (firstErrorLine) details.push(`error: ${compactExecutionText(firstErrorLine, 220)}`);
    if (qualityGateFailure.autoRepairAttempted) {
      const commands =
        qualityGateFailure.autoRepairCommands && qualityGateFailure.autoRepairCommands.length > 0
          ? qualityGateFailure.autoRepairCommands.join(" -> ")
          : "auto-repair";
      const result = qualityGateFailure.autoRepairSucceeded ? "ok" : "failed";
      details.push(`repair: ${commands} (${result})`);
    }
    if (qualityGateFailure.category === "environment_setup") {
      details.push("category: environment_setup");
    }
    if (qualityGateFailure.validationWorkspace) {
      details.push(`workspace: ${qualityGateFailure.validationWorkspace}`);
    }
    if (details.length === 0) return null;
    return details.join(" | ");
  }

  private buildMergeQualityGateError(
    failure: MergeQualityGateFailure,
    fallbackWorktreePath: string
  ): MergeJobError {
    const reason = failure.reason.trim().slice(0, 500) || "Unknown quality gate failure";
    const outputSnippet =
      this.toOutputSnippet(failure.outputSnippet ?? failure.output) ?? "No output captured";
    const detail = outputSnippet.length > 0 ? ` | ${outputSnippet}` : "";
    const firstErrorLine = this.getQualityGateFirstErrorLine(failure).slice(0, 300);
    return new MergeJobError(
      `Quality gate failed (${failure.command}): ${reason}${detail}`,
      "quality_gate",
      [],
      "requeued",
      {
        command: failure.command,
        reason,
        outputSnippet,
        worktreePath: failure.worktreePath ?? fallbackWorktreePath,
        firstErrorLine,
        validationWorkspace: failure.validationWorkspace,
        category: failure.category ?? "quality_gate",
        autoRepairAttempted: failure.autoRepairAttempted ?? false,
        autoRepairSucceeded: failure.autoRepairSucceeded ?? false,
        autoRepairCommands: failure.autoRepairCommands,
        autoRepairOutput: failure.autoRepairOutput,
        executable: failure.executable,
        cwd: failure.cwd,
        exitCode: failure.exitCode ?? null,
        signal: failure.signal ?? null,
      }
    );
  }

  private async ensureMergeQualityGates(options: MergeQualityGateRunOptions): Promise<void> {
    if (!this.host.runMergeQualityGates) return;
    const failure = await this.host.runMergeQualityGates(options);
    if (!failure) return;

    throw this.buildMergeQualityGateError(failure, options.worktreePath);
  }

  private baselineCacheKey(projectId: string, baseBranch: string): string {
    return `${projectId}:${baseBranch}`;
  }

  private buildBaselineDispatchPausedReason(baseBranch: string): string {
    return `Merge queue paused until baseline quality gates on ${baseBranch} pass.`;
  }

  private buildBaselineFailureSummary(
    baseBranch: string,
    failure: Pick<MergeQualityGateFailure, "command" | "firstErrorLine" | "reason">
  ): string {
    const firstErrorLine =
      failure.firstErrorLine?.trim() || failure.reason?.trim() || "Unknown quality gate failure";
    return compactExecutionText(
      `Baseline quality gates failing on ${baseBranch}: ${failure.command} | ${compactExecutionText(firstErrorLine, 220)}`,
      420
    );
  }

  private buildUnexpectedBaselineFailure(err: unknown): MergeQualityGateFailure {
    const reason =
      compactExecutionText(err instanceof Error ? err.message : String(err), 500) ||
      "Baseline validation setup failed";
    return {
      command: "baseline validation setup",
      reason,
      output: reason,
      outputSnippet: reason,
      firstErrorLine: reason,
      validationWorkspace: "baseline",
      category: "environment_setup",
    };
  }

  private isBaselineQualityGateRemediationTask(task: StoredTask, baseBranch: string): boolean {
    const source = (task as { source?: unknown }).source;
    const kind = (task as { selfImprovementKind?: unknown }).selfImprovementKind;
    const sourceId = (task as { baselineQualityGateSource?: unknown }).baselineQualityGateSource;
    const taskBaseBranch = (task as { baselineBaseBranch?: unknown }).baselineBaseBranch;

    if (source !== "self-improvement") return false;
    if (kind !== "baseline-quality-gate" && sourceId !== BASELINE_QUALITY_GATE_TASK_SOURCE) {
      return false;
    }
    if (typeof taskBaseBranch === "string" && taskBaseBranch.trim() !== "") {
      return taskBaseBranch === baseBranch;
    }
    return true;
  }

  private async getBaselineQualityGateFailure(
    projectId: string,
    repoPath: string,
    baseBranch: string,
    options?: { useCache?: boolean }
  ): Promise<MergeQualityGateFailure | null> {
    if (!this.host.runMergeQualityGates) return null;

    const cacheKey = this.baselineCacheKey(projectId, baseBranch);
    const now = Date.now();
    const useCache = options?.useCache !== false;
    const cachedSuccess = this.baselineQualityGateSuccessCache.get(cacheKey);
    if (
      useCache &&
      cachedSuccess &&
      now - cachedSuccess.checkedAtMs < BASELINE_QUALITY_GATE_SUCCESS_CACHE_MS
    ) {
      return null;
    }

    const inFlight = this.baselineQualityGateSingleFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const checkPromise = (async (): Promise<MergeQualityGateFailure | null> => {
      const checkedAt = new Date().toISOString();
      await this.host.setBaselineRuntimeState(projectId, repoPath, {
        baselineStatus: "checking",
      });
      let workspace: Awaited<
        ReturnType<typeof validationWorkspaceService.createBaselineWorkspace>
      > | null = null;

      try {
        workspace = await validationWorkspaceService
          .createBaselineWorkspace(repoPath, baseBranch)
          .catch((err) => {
            throw this.buildUnexpectedBaselineFailure(err);
          });
        const failure =
          (await this.host.runMergeQualityGates?.({
            projectId,
            repoPath,
            worktreePath: workspace.worktreePath,
            taskId: `baseline:${baseBranch}`,
            branchName: baseBranch,
            baseBranch,
            validationWorkspace: "baseline",
          })) ?? null;

        if (!failure) {
          this.baselineQualityGateSuccessCache.set(cacheKey, { checkedAtMs: now });
          this.baselineQualityGateNotified.delete(cacheKey);
          await this.resolveBaselineQualityGateNotifications(projectId, baseBranch);
          await this.markMergeValidationHealthy(projectId, repoPath);
          await this.host.setBaselineRuntimeState(projectId, repoPath, {
            baselineStatus: "healthy",
            baselineCheckedAt: checkedAt,
            baselineFailureSummary: null,
            dispatchPausedReason: null,
          });
          return null;
        }

        const normalizedFailure: MergeQualityGateFailure = {
          ...failure,
          validationWorkspace: failure.validationWorkspace ?? "baseline",
        };
        if (normalizedFailure.category !== "environment_setup") {
          await this.markMergeValidationHealthy(projectId, repoPath);
        }
        this.baselineQualityGateSuccessCache.delete(cacheKey);
        await this.host.setBaselineRuntimeState(projectId, repoPath, {
          baselineStatus: "failing",
          baselineCheckedAt: checkedAt,
          baselineFailureSummary: this.buildBaselineFailureSummary(baseBranch, normalizedFailure),
          dispatchPausedReason: this.buildBaselineDispatchPausedReason(baseBranch),
        });
        return normalizedFailure;
      } catch (err) {
        const failure =
          err && typeof err === "object" && "command" in err
            ? (err as MergeQualityGateFailure)
            : this.buildUnexpectedBaselineFailure(err);
        if (failure.category !== "environment_setup") {
          await this.markMergeValidationHealthy(projectId, repoPath);
        }
        this.baselineQualityGateSuccessCache.delete(cacheKey);
        await this.host.setBaselineRuntimeState(projectId, repoPath, {
          baselineStatus: "failing",
          baselineCheckedAt: checkedAt,
          baselineFailureSummary: this.buildBaselineFailureSummary(baseBranch, failure),
          dispatchPausedReason: this.buildBaselineDispatchPausedReason(baseBranch),
        });
        return failure;
      } finally {
        this.baselineQualityGateSingleFlight.delete(cacheKey);
        await workspace?.cleanup().catch((cleanupErr) => {
          log.warn("Failed to clean up baseline validation workspace", {
            projectId,
            baseBranch,
            cleanupErr,
          });
        });
      }
    })();

    this.baselineQualityGateSingleFlight.set(cacheKey, checkPromise);
    return checkPromise;
  }

  private async createBaselineQualityGateNotification(
    projectId: string,
    baseBranch: string,
    detail: string
  ): Promise<void> {
    const cacheKey = this.baselineCacheKey(projectId, baseBranch);
    if (this.baselineQualityGateNotified.has(cacheKey)) return;

    try {
      const notification = await notificationService.createAgentFailed({
        projectId,
        source: "execute",
        sourceId: `${BASELINE_QUALITY_GATE_NOTIFICATION_SOURCE_ID}:${baseBranch}`,
        message: compactExecutionText(
          `Merge queue paused: baseline quality gates on ${baseBranch} are failing. ${detail}`,
          1800
        ),
      });
      this.baselineQualityGateNotified.add(cacheKey);
      broadcastToProject(projectId, {
        type: "notification.added",
        notification,
      });
    } catch (err) {
      log.warn("Failed to create baseline quality-gate notification", {
        projectId,
        baseBranch,
        err,
      });
    }
  }

  private buildBaselineQualityGateDetail(failure: MergeQualityGateFailure): string {
    const firstErrorLine = this.getQualityGateFirstErrorLine(failure);
    return compactExecutionText(
      `cmd: ${failure.command} | error: ${compactExecutionText(firstErrorLine, 220)}`,
      380
    );
  }

  private async resolveBaselineQualityGateNotifications(
    projectId: string,
    baseBranch: string
  ): Promise<void> {
    const sourceId = `${BASELINE_QUALITY_GATE_NOTIFICATION_SOURCE_ID}:${baseBranch}`;
    try {
      const notifications = await notificationService.listByProject(projectId);
      const baselineNotifications = notifications.filter(
        (n) =>
          n.kind === "agent_failed" &&
          n.source === "execute" &&
          n.sourceId === sourceId &&
          n.status === "open"
      );
      for (const notification of baselineNotifications) {
        await notificationService.resolve(projectId, notification.id);
        broadcastToProject(projectId, {
          type: "notification.resolved",
          notificationId: notification.id,
          projectId,
          source: notification.source,
          sourceId: notification.sourceId,
        });
      }
    } catch (err) {
      log.warn("Failed to resolve baseline quality-gate notifications", {
        projectId,
        baseBranch,
        err,
      });
    }
  }

  private getMergeValidationHealth(projectId: string): {
    status: MergeValidationRuntimeStatus;
    summary: string | null;
    nextCanaryAtMs: number | null;
  } {
    return (
      this.mergeValidationHealth.get(projectId) ?? {
        status: "healthy",
        summary: null,
        nextCanaryAtMs: null,
      }
    );
  }

  private buildMergeValidationHealthSummary(params: {
    command?: string | null;
    firstErrorLine?: string | null;
    reason?: string | null;
    remediation?: string | null;
  }): string {
    const firstErrorLine =
      params.firstErrorLine?.trim() ||
      params.reason?.trim() ||
      "Merge validation environment setup failed";
    const command = params.command?.trim();
    return compactExecutionText(
      `Merge validation environment issues detected${command ? `: ${command}` : ""} | ${compactExecutionText(firstErrorLine, 220)}${params.remediation ? ` | remediation: ${compactExecutionText(params.remediation, 220)}` : ""}`,
      500
    );
  }

  private async createMergeValidationHealthNotification(
    projectId: string,
    summary: string
  ): Promise<void> {
    if (this.mergeValidationHealthNotified.has(projectId)) return;
    try {
      const notification = await notificationService.createAgentFailed({
        projectId,
        source: "execute",
        sourceId: MERGE_VALIDATION_HEALTH_NOTIFICATION_SOURCE_ID,
        message: compactExecutionText(`Merge validation is temporarily degraded. ${summary}`, 1800),
      });
      this.mergeValidationHealthNotified.add(projectId);
      broadcastToProject(projectId, {
        type: "notification.added",
        notification,
      });
    } catch (err) {
      log.warn("Failed to create merge-validation health notification", {
        projectId,
        err,
      });
    }
  }

  private async resolveMergeValidationHealthNotifications(projectId: string): Promise<void> {
    try {
      const notifications = await notificationService.listByProject(projectId);
      const healthNotifications = notifications.filter(
        (n) =>
          n.kind === "agent_failed" &&
          n.source === "execute" &&
          n.sourceId === MERGE_VALIDATION_HEALTH_NOTIFICATION_SOURCE_ID &&
          n.status === "open"
      );
      for (const notification of healthNotifications) {
        await notificationService.resolve(projectId, notification.id);
        broadcastToProject(projectId, {
          type: "notification.resolved",
          notificationId: notification.id,
          projectId,
          source: notification.source,
          sourceId: notification.sourceId,
        });
      }
    } catch (err) {
      log.warn("Failed to resolve merge-validation health notifications", {
        projectId,
        err,
      });
    }
  }

  private async markMergeValidationHealthy(projectId: string, repoPath: string): Promise<void> {
    const current = this.getMergeValidationHealth(projectId);
    if (current.status === "healthy" && current.summary == null) return;
    this.mergeValidationHealth.set(projectId, {
      status: "healthy",
      summary: null,
      nextCanaryAtMs: null,
    });
    this.mergeValidationEnvironmentFailures.delete(projectId);
    this.mergeValidationHealthNotified.delete(projectId);
    await this.host.setMergeValidationRuntimeState(projectId, repoPath, {
      mergeValidationStatus: "healthy",
      mergeValidationFailureSummary: null,
    });
    await this.resolveMergeValidationHealthNotifications(projectId);
  }

  private async recordMergeValidationEnvironmentFailure(
    projectId: string,
    repoPath: string,
    summary: string
  ): Promise<void> {
    const now = Date.now();
    const recent = (this.mergeValidationEnvironmentFailures.get(projectId) ?? []).filter(
      (timestamp) => now - timestamp <= MERGE_VALIDATION_FAILURE_WINDOW_MS
    );
    recent.push(now);
    this.mergeValidationEnvironmentFailures.set(projectId, recent);

    const degraded = recent.length >= MERGE_VALIDATION_DEGRADED_THRESHOLD;
    const current = this.getMergeValidationHealth(projectId);
    const nextStatus: MergeValidationRuntimeStatus =
      degraded || current.status === "degraded" ? "degraded" : "healthy";
    const nextCanaryAtMs =
      nextStatus === "degraded" ? now + MERGE_VALIDATION_CANARY_INTERVAL_MS : null;
    const nextState = {
      status: nextStatus,
      summary,
      nextCanaryAtMs,
    } as const;
    this.mergeValidationHealth.set(projectId, nextState);

    if (nextStatus !== "degraded") return;

    await this.host.setMergeValidationRuntimeState(projectId, repoPath, {
      mergeValidationStatus: nextStatus,
      mergeValidationFailureSummary: summary,
    });
    if (degraded) {
      await this.createMergeValidationHealthNotification(projectId, summary);
    }
  }

  private async deferMergeValidationWhileDegraded(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    slot: MergeSlot,
    worktreePath: string
  ): Promise<boolean> {
    const health = this.getMergeValidationHealth(projectId);
    if (health.status !== "degraded") return false;
    const now = Date.now();
    if (health.nextCanaryAtMs == null || health.nextCanaryAtMs <= now) {
      return false;
    }

    const nextCanaryAt = new Date(health.nextCanaryAtMs).toISOString();
    const attempt =
      (typeof slot.attempt === "number" && Number.isFinite(slot.attempt)
        ? slot.attempt
        : Math.max(1, this.host.taskStore.getCumulativeAttemptsFromIssue(task) + 1)) || 1;
    const summary = buildTaskLastExecutionSummary({
      attempt,
      outcome: "requeued",
      phase: "merge",
      failureType: "environment_setup",
      summary: compactExecutionText(
        `Merge validation deferred while project validation health recovers. Canary retry scheduled after ${nextCanaryAt}.${health.summary ? ` ${health.summary}` : ""}`,
        500
      ),
    });
    const qualityGateDetail: RetryQualityGateDetail = {
      command: "merge validation",
      reason: health.summary ?? "Merge validation health is degraded",
      firstErrorLine: health.summary ?? "Merge validation health is degraded",
      worktreePath,
      category: "environment_setup",
      validationWorkspace: "merged_candidate",
      repairAttempted: false,
      repairSucceeded: false,
    };

    await this.host.taskStore.setMergeStage(projectId, task.id, "quality_gate");
    await this.host.taskStore.update(projectId, task.id, {
      status: "open",
      assignee: "",
      extra: {
        last_execution_summary: summary,
        [MERGE_RETRY_MODE_KEY]: BASELINE_MERGE_RETRY_MODE,
        [MERGE_VALIDATION_PAUSED_UNTIL_KEY]: nextCanaryAt,
        worktreePath,
        qualityGateCategory: "environment_setup",
        qualityGateValidationWorkspace: "merged_candidate",
        qualityGateDetail,
      },
    });
    await this.releaseMergeSlot(projectId, repoPath, "fail", task.id);
    this.host.nudge(projectId);
    return true;
  }

  private async pauseMergeForBaselineQualityGateFailure(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    baseBranch: string,
    failure: MergeQualityGateFailure
  ): Promise<void> {
    const detail = this.buildBaselineQualityGateDetail(failure);
    const firstErrorLine = this.getQualityGateFirstErrorLine(failure);
    const failedGateReason = failure.reason.trim().slice(0, 500) || "Unknown quality gate failure";
    const failedGateOutputSnippet =
      this.toOutputSnippet(failure.outputSnippet ?? failure.output) ??
      compactExecutionText(
        this.getQualityGateFirstErrorLine(failure),
        QUALITY_GATE_OUTPUT_SNIPPET_LIMIT
      );
    const worktreePath = failure.worktreePath ?? repoPath;
    const qualityGateDetail = {
      command: failure.command,
      reason: failedGateReason,
      outputSnippet: failedGateOutputSnippet,
      worktreePath,
      firstErrorLine,
      category: failure.category ?? "quality_gate",
      validationWorkspace: failure.validationWorkspace ?? null,
      repairAttempted: failure.autoRepairAttempted ?? false,
      repairSucceeded: failure.autoRepairSucceeded ?? false,
      executable: failure.executable ?? null,
      cwd: failure.cwd ?? null,
      exitCode: failure.exitCode ?? null,
      signal: failure.signal ?? null,
    };
    const attempt = Math.max(1, this.host.taskStore.getCumulativeAttemptsFromIssue(task) + 1) || 1;
    const pausedUntil = new Date(Date.now() + BASELINE_QUALITY_GATE_PAUSE_MS).toISOString();
    const isEnvironmentSetupFailure = failure.category === "environment_setup";
    const remediationAction = isEnvironmentSetupFailure
      ? this.buildEnvironmentSetupRemediation({
          command: failure.command,
          worktreePath,
        })
      : null;
    const nextAction = remediationAction ?? "Paused until baseline quality gates pass";
    const mergeValidationSummary = this.buildMergeValidationHealthSummary({
      command: failure.command,
      firstErrorLine,
      reason: failedGateReason,
      remediation: remediationAction,
    });
    if (isEnvironmentSetupFailure) {
      await this.recordMergeValidationEnvironmentFailure(
        projectId,
        repoPath,
        mergeValidationSummary
      );
    } else {
      await this.markMergeValidationHealthy(projectId, repoPath);
    }
    const requeuedSummary = buildTaskLastExecutionSummary({
      attempt,
      outcome: "requeued",
      phase: "merge",
      failureType: isEnvironmentSetupFailure ? "environment_setup" : "merge_quality_gate",
      summary: compactExecutionText(
        `Merge paused: baseline quality gates on ${baseBranch} are failing (${detail})${remediationAction ? `. Remediation: ${remediationAction}` : ""}.`,
        500
      ),
    });
    const retryContext: RetryContext = {
      previousFailure: compactExecutionText(
        `baseline quality gates failed on ${baseBranch}: ${failure.reason} (cmd: ${failure.command} | error: ${firstErrorLine})`,
        MERGE_RETRY_CONTEXT_FAILURE_LIMIT
      ),
      failureType: isEnvironmentSetupFailure ? "environment_setup" : "merge_quality_gate",
    };
    retryContext.qualityGateDetail = qualityGateDetail;

    await this.host.taskStore.setMergeStage(projectId, task.id, "quality_gate");
    await this.host.taskStore.update(projectId, task.id, {
      status: "open",
      assignee: "",
      extra: {
        last_execution_summary: requeuedSummary,
        [NEXT_RETRY_CONTEXT_KEY]: retryContext,
        [MERGE_RETRY_MODE_KEY]: BASELINE_MERGE_RETRY_MODE,
        [BASELINE_QUALITY_GATE_PAUSED_UNTIL_KEY]: pausedUntil,
        failedGateCommand: failure.command,
        failedGateReason,
        failedGateOutputSnippet,
        worktreePath,
        qualityGateCategory: failure.category ?? "quality_gate",
        qualityGateValidationWorkspace: failure.validationWorkspace ?? null,
        qualityGateAutoRepairAttempted: failure.autoRepairAttempted ?? false,
        qualityGateAutoRepairSucceeded: failure.autoRepairSucceeded ?? false,
        qualityGateExecutable: failure.executable ?? null,
        qualityGateCwd: failure.cwd ?? null,
        qualityGateExitCode: failure.exitCode ?? null,
        qualityGateSignal: failure.signal ?? null,
        qualityGateDetail,
      },
    });
    await broadcastAuthoritativeTaskUpdated(broadcastToProject, projectId, task.id);
    await this.host.taskStore.comment(
      projectId,
      task.id,
      `Merge paused because baseline quality gates on ${baseBranch} are failing. ${QUALITY_GATE_FAILURE_MESSAGE} Details: ${detail}.${remediationAction ? ` Remediation: ${remediationAction}` : ""}`
    );
    await this.createBaselineQualityGateNotification(projectId, baseBranch, detail);
    eventLogService
      .append(repoPath, {
        timestamp: new Date().toISOString(),
        projectId,
        taskId: task.id,
        event: "merge.failed",
        data: {
          reason: `Baseline quality gates failing on ${baseBranch}: ${failure.reason}`,
          stage: "quality_gate",
          failureType: retryContext.failureType ?? null,
          branchName: baseBranch,
          conflictedFiles: [],
          attempt,
          resolvedBy: "requeued",
          scopeConfidence: this.getScopeConfidence(task),
          summary: requeuedSummary.summary,
          nextAction,
          qualityGateCategory: failure.category ?? "quality_gate",
          qualityGateValidationWorkspace: failure.validationWorkspace ?? null,
          qualityGateCommand: failure.command,
          qualityGateFirstErrorLine: firstErrorLine,
          qualityGateAutoRepairAttempted: failure.autoRepairAttempted ?? false,
          qualityGateAutoRepairSucceeded: failure.autoRepairSucceeded ?? false,
          failedGateCommand: failure.command,
          failedGateReason,
          failedGateOutputSnippet,
          worktreePath,
          qualityGateExecutable: failure.executable ?? null,
          qualityGateCwd: failure.cwd ?? null,
          qualityGateExitCode: failure.exitCode ?? null,
          qualityGateSignal: failure.signal ?? null,
          qualityGateDetail,
        },
      })
      .catch(() => {});
    eventLogService
      .append(repoPath, {
        timestamp: new Date().toISOString(),
        projectId,
        taskId: task.id,
        event: "task.requeued",
        data: {
          attempt,
          phase: "merge",
          failureType: retryContext.failureType ?? null,
          mergeStage: "quality_gate",
          conflictedFiles: [],
          summary: requeuedSummary.summary,
          nextAction,
          failedGateCommand: failure.command,
          failedGateReason,
          failedGateOutputSnippet,
          worktreePath,
          qualityGateCategory: failure.category ?? "quality_gate",
          qualityGateValidationWorkspace: failure.validationWorkspace ?? null,
          qualityGateAutoRepairAttempted: failure.autoRepairAttempted ?? false,
          qualityGateAutoRepairSucceeded: failure.autoRepairSucceeded ?? false,
          qualityGateExecutable: failure.executable ?? null,
          qualityGateCwd: failure.cwd ?? null,
          qualityGateExitCode: failure.exitCode ?? null,
          qualityGateSignal: failure.signal ?? null,
          qualityGateDetail,
        },
      })
      .catch(() => {});
    this.broadcastMergeFailureWs(projectId, task.id, {
      cumulativeAttempts: attempt,
      resolvedBy: "requeued",
      reason: `Baseline quality gates failing on ${baseBranch}: ${failure.reason}`,
      mergeStage: "quality_gate",
      qualityGateDetail,
      failedGateCommand: failure.command,
      failedGateReason,
      failedGateOutputSnippet,
      worktreePath,
    });
    this.broadcastTaskRequeuedWs(projectId, task.id, {
      cumulativeAttempts: attempt,
      phase: "merge",
      mergeStage: "quality_gate",
      summary: requeuedSummary.summary,
      nextAction,
      qualityGateDetail,
      failedGateCommand: failure.command,
      failedGateReason,
      failedGateOutputSnippet,
      worktreePath,
    });
  }

  private broadcastMergeFailureWs(
    projectId: string,
    taskId: string,
    args: {
      cumulativeAttempts: number;
      resolvedBy: "requeued" | "blocked";
      reason?: string | null;
      mergeStage?: string | null;
      qualityGateDetail?: RetryQualityGateDetail | null;
      failedGateCommand?: string | null;
      failedGateReason?: string | null;
      failedGateOutputSnippet?: string | null;
      worktreePath?: string | null;
    }
  ): void {
    const qg = args.qualityGateDetail ?? null;
    broadcastToProject(projectId, {
      type: "merge.failed",
      taskId,
      cumulativeAttempts: args.cumulativeAttempts,
      resolvedBy: args.resolvedBy,
      reason: args.reason ?? null,
      mergeStage: args.mergeStage ?? null,
      qualityGateDetail: qg,
      failedGateCommand: args.failedGateCommand ?? qg?.command ?? null,
      failedGateReason: args.failedGateReason ?? qg?.reason ?? null,
      failedGateOutputSnippet: args.failedGateOutputSnippet ?? qg?.outputSnippet ?? null,
      worktreePath: args.worktreePath ?? qg?.worktreePath ?? null,
    } as unknown as ServerEvent);
  }

  private broadcastTaskRequeuedWs(
    projectId: string,
    taskId: string,
    args: {
      cumulativeAttempts: number;
      phase?: string | null;
      mergeStage?: string | null;
      summary?: string | null;
      nextAction?: string | null;
      qualityGateDetail?: RetryQualityGateDetail | null;
      failedGateCommand?: string | null;
      failedGateReason?: string | null;
      failedGateOutputSnippet?: string | null;
      worktreePath?: string | null;
    }
  ): void {
    const qg = args.qualityGateDetail ?? null;
    broadcastToProject(projectId, {
      type: "task.requeued",
      taskId,
      cumulativeAttempts: args.cumulativeAttempts,
      phase: args.phase ?? null,
      mergeStage: args.mergeStage ?? null,
      summary: args.summary ?? null,
      nextAction: args.nextAction ?? null,
      qualityGateDetail: qg,
      failedGateCommand: args.failedGateCommand ?? qg?.command ?? null,
      failedGateReason: args.failedGateReason ?? qg?.reason ?? null,
      failedGateOutputSnippet: args.failedGateOutputSnippet ?? qg?.outputSnippet ?? null,
      worktreePath: args.worktreePath ?? qg?.worktreePath ?? null,
    } as unknown as ServerEvent);
  }

  private async createBaselineQualityGateRemediationTask(
    projectId: string,
    baseBranch: string,
    failure: MergeQualityGateFailure
  ): Promise<void> {
    const failedGateReason = failure.reason.trim().slice(0, 1200) || "Unknown quality gate failure";
    const failedGateOutputSnippet =
      this.toOutputSnippet(failure.outputSnippet ?? failure.output) ?? null;
    await selfImprovementService.ensureBaselineQualityGateTask(projectId, {
      baseBranch,
      command: failure.command,
      reason: failedGateReason,
      outputSnippet: failedGateOutputSnippet,
      worktreePath:
        failure.validationWorkspace === "baseline" ? null : (failure.worktreePath ?? null),
    });
  }

  private async releaseMergeSlot(
    projectId: string,
    repoPath: string,
    outcome: "complete" | "fail",
    taskId: string
  ): Promise<void> {
    const state = this.host.getState(projectId);
    if (!state.slots.has(taskId)) {
      return;
    }
    this.host.transition(projectId, { to: outcome, taskId });
    await this.host.persistCounters(projectId, repoPath);
  }

  /**
   * Tasks that are implementation work under an epic (exclude epic itself and .0 placeholder IDs).
   * Used to decide when all work in an epic is closed for merge/final-review.
   */
  private getEpicImplementationTasks(allIssues: StoredTask[], epicId: string): StoredTask[] {
    return allIssues.filter(
      (i) =>
        i.id.startsWith(epicId + ".") &&
        !i.id.endsWith(".0") &&
        (i.issue_type ?? (i as { type?: string }).type) !== "epic"
    );
  }

  /**
   * Close task, record attempt, create/archive session, record actual files, eventLog, broadcast,
   * checkAutoResolveOnTaskDone, and release merge slot. Shared by per_epic intermediate and per_task paths.
   */
  private async closeTaskRecordAndReleaseSlot(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    baseBranch: string,
    wtPath: string,
    slot: MergeSlot,
    settings: Awaited<ReturnType<MergeCoordinatorHost["projectService"]["getSettings"]>>
  ): Promise<void> {
    const closeReason = slot.phaseResult.codingSummary || "Implemented and tested";
    await this.host.taskStore.close(projectId, task.id, closeReason);

    const agentConfig = settings.simpleComplexityAgent;
    agentIdentityService
      .recordAttempt(repoPath, {
        taskId: task.id,
        agentId: `${agentConfig.type}-${agentConfig.model ?? "default"}`,
        role: "coder",
        model: agentConfig.model ?? "unknown",
        attempt: slot.attempt,
        startedAt: slot.agent.startedAt,
        completedAt: new Date().toISOString(),
        outcome: "success",
        durationMs: Date.now() - new Date(slot.agent.startedAt).getTime(),
      })
      .catch((err) => log.warn("Failed to record attempt", { err }));

    const session = await this.host.sessionManager.createSession(repoPath, {
      taskId: task.id,
      attempt: slot.attempt,
      agentType: agentConfig.type,
      agentModel: agentConfig.model || "",
      gitBranch: branchName,
      status: "approved",
      outputLog: slot.agent.outputLog.join(""),
      gitDiff: slot.phaseResult.codingDiff,
      summary: slot.phaseResult.codingSummary || undefined,
      testResults: slot.phaseResult.testResults ?? undefined,
      startedAt: slot.agent.startedAt,
    });
    await this.host.sessionManager.archiveSession(repoPath, task.id, slot.attempt, session, wtPath);

    try {
      const changedFiles = await this.host.branchManager.getChangedFiles(
        repoPath,
        branchName,
        baseBranch
      );
      await this.host.fileScopeAnalyzer.recordActual(
        projectId,
        repoPath,
        task.id,
        changedFiles,
        this.host.taskStore
      );
    } catch {
      // best-effort
    }

    eventLogService
      .append(repoPath, {
        timestamp: new Date().toISOString(),
        projectId,
        taskId: task.id,
        event: "task.completed",
        data: { attempt: slot.attempt },
      })
      .catch(() => {});

    broadcastToProject(projectId, {
      type: "agent.completed",
      taskId: task.id,
      status: "approved",
      testResults: slot.phaseResult.testResults,
    });

    await this.host.feedbackService.checkAutoResolveOnTaskDone(projectId, task.id).catch((err) => {
      log.warn("Auto-resolve feedback on task done failed", { taskId: task.id, err });
    });

    await this.releaseMergeSlot(projectId, repoPath, "complete", task.id);
  }

  /**
   * Merge to main, then close task, archive session, clean up.
   * Merge happens FIRST — task is only closed after a successful merge.
   * On conflict: aborts merge and requeues task (branch preserved for next run).
   */
  async performMergeAndDone(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string
  ): Promise<void> {
    log.info("Starting merge and done flow", { taskId: task.id, branchName });
    const state = this.host.getState(projectId);
    const slot = state.slots.get(task.id);
    if (!slot) {
      log.warn("performMergeAndDone: no slot found for task", { taskId: task.id });
      try {
        await this.host.taskStore.update(projectId, task.id, {
          status: "open",
          assignee: "",
        });
      } catch (err) {
        log.warn("performMergeAndDone: failed to requeue task after missing slot", {
          taskId: task.id,
          err,
        });
      }
      await broadcastAuthoritativeTaskUpdated(broadcastToProject, projectId, task.id);
      this.host.nudge(projectId);
      return;
    }
    const wtPath = slot.worktreePath ?? repoPath;

    // 1. Prepare: commit any WIP, then wait for any in-flight push to finish
    await this.host.branchManager.waitForGitReady(wtPath);
    await this.host.branchManager.commitWip(wtPath, task.id);
    await this.waitForPushComplete(projectId);
    const settings = await this.host.projectService.getSettings(projectId);
    const baseBranch = await resolveBaseBranch(repoPath, settings.worktreeBaseBranch);
    const mergeStrategy = settings.mergeStrategy ?? "per_task";
    const allIssuesForEpic = await this.host.taskStore.listAll(projectId);
    const epicId = resolveEpicId(task.id, allIssuesForEpic);

    const isPerEpicIntermediate = mergeStrategy === "per_epic" && epicId != null;

    if (isPerEpicIntermediate) {
      // per_epic + epic task: do not merge to main; close task, record, archive, release slot
      await this.closeTaskRecordAndReleaseSlot(
        projectId,
        repoPath,
        task,
        branchName,
        baseBranch,
        wtPath,
        slot,
        settings
      );
      this.host.nudge(projectId);

      // Check if all implementation tasks in epic are closed; if not, return (next task uses same epic worktree)
      const freshIssues = await this.host.taskStore.listAll(projectId);
      const implTasks = this.getEpicImplementationTasks(freshIssues, epicId);
      const allImplClosed =
        implTasks.length > 0 && implTasks.every((i) => (i.status as string) === "closed");

      if (!allImplClosed) {
        return;
      }

      // Last task in epic: merge epic branch to main, then push and cleanup via postCompletionAsync
      try {
        if (await this.deferMergeValidationWhileDegraded(projectId, repoPath, task, slot, wtPath)) {
          return;
        }
        if (!this.isBaselineQualityGateRemediationTask(task, baseBranch)) {
          const baselineFailure = await this.getBaselineQualityGateFailure(
            projectId,
            repoPath,
            baseBranch
          );
          if (baselineFailure) {
            await this.createBaselineQualityGateRemediationTask(
              projectId,
              baseBranch,
              baselineFailure
            );
            await this.pauseMergeForBaselineQualityGateFailure(
              projectId,
              repoPath,
              task,
              baseBranch,
              baselineFailure
            );
            await this.releaseMergeSlot(projectId, repoPath, "fail", task.id);
            this.host.nudge(projectId);
            return;
          }
        } else {
          log.info("Skipping baseline-on-main precheck for baseline remediation task", {
            taskId: task.id,
            baseBranch,
          });
        }
        await this.ensureMergeQualityGates({
          projectId,
          repoPath,
          worktreePath: wtPath,
          taskId: task.id,
          branchName,
          baseBranch,
        });
        await gitCommitQueue.drain();
        await gitCommitQueue.enqueueAndWait({
          type: "worktree_merge",
          repoPath,
          worktreePath: wtPath,
          branchName,
          taskId: task.id,
          taskTitle: task.title || task.id,
          baseBranch,
        });
        await this.markMergeValidationHealthy(projectId, repoPath);
      } catch (mergeErr) {
        log.warn("Merge epic to main failed", { taskId: task.id, branchName, mergeErr });
        await this.requeueTaskAfterMergeFailure(projectId, repoPath, task, mergeErr as Error);
        return;
      }

      this.registerPendingCleanup(projectId, {
        taskId: task.id,
        branchName,
        worktreePath: wtPath,
        gitWorkingMode: settings.gitWorkingMode === "branches" ? "branches" : "worktree",
        worktreeKey: slot.worktreeKey,
      });
      this.host.nudge(projectId);
      this.postCompletionAsync(projectId, repoPath, task.id, { mergedToMain: true }).catch(
        (err) => {
          log.warn("Post-completion async work failed", { taskId: task.id, err });
        }
      );
      return;
    }

    // 2. Attempt merge inside the serialized queue. Rebase now happens there.
    try {
      if (await this.deferMergeValidationWhileDegraded(projectId, repoPath, task, slot, wtPath)) {
        return;
      }
      if (!this.isBaselineQualityGateRemediationTask(task, baseBranch)) {
        const baselineFailure = await this.getBaselineQualityGateFailure(
          projectId,
          repoPath,
          baseBranch
        );
        if (baselineFailure) {
          await this.createBaselineQualityGateRemediationTask(
            projectId,
            baseBranch,
            baselineFailure
          );
          await this.pauseMergeForBaselineQualityGateFailure(
            projectId,
            repoPath,
            task,
            baseBranch,
            baselineFailure
          );
          await this.releaseMergeSlot(projectId, repoPath, "fail", task.id);
          this.host.nudge(projectId);
          return;
        }
      } else {
        log.info("Skipping baseline-on-main precheck for baseline remediation task", {
          taskId: task.id,
          baseBranch,
        });
      }
      await this.ensureMergeQualityGates({
        projectId,
        repoPath,
        worktreePath: wtPath,
        taskId: task.id,
        branchName,
        baseBranch,
      });
      await gitCommitQueue.drain();
      await gitCommitQueue.enqueueAndWait({
        type: "worktree_merge",
        repoPath,
        worktreePath: wtPath,
        branchName,
        taskId: task.id,
        taskTitle: task.title || task.id,
        baseBranch,
      });
      await this.markMergeValidationHealthy(projectId, repoPath);
    } catch (mergeErr) {
      log.warn("Merge to main failed", { taskId: task.id, branchName, mergeErr });
      await this.requeueTaskAfterMergeFailure(projectId, repoPath, task, mergeErr as Error);
      return;
    }

    // 4. Merge succeeded — close task, record, archive, release slot; then register cleanup and post-completion
    this.registerPendingCleanup(projectId, {
      taskId: task.id,
      branchName,
      worktreePath: wtPath,
      gitWorkingMode: settings.gitWorkingMode === "branches" ? "branches" : "worktree",
      worktreeKey: slot.worktreeKey,
    });
    await this.closeTaskRecordAndReleaseSlot(
      projectId,
      repoPath,
      task,
      branchName,
      baseBranch,
      wtPath,
      slot,
      settings
    );

    // 5. Async push + post-completion
    this.host.nudge(projectId);

    this.postCompletionAsync(projectId, repoPath, task.id, { mergedToMain: true }).catch((err) => {
      log.warn("Post-completion async work failed", { taskId: task.id, err });
    });
  }

  /**
   * Handle merge failure: abort any in-progress merge, archive session (so output is visible),
   * track attempts, requeue or block. Branch is preserved so the next agent run can rebase and retry.
   */
  private async requeueTaskAfterMergeFailure(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    mergeErr: Error
  ): Promise<void> {
    const slot = this.host.getState(projectId).slots.get(task.id);
    const failedBranchName = slot?.branchName ?? `opensprint/${task.id}`;
    const stage =
      mergeErr instanceof MergeJobError
        ? mergeErr.stage
        : mergeErr instanceof RebaseConflictError
          ? "push_rebase"
          : "merge_to_main";
    const normalizedStage = stage as MergeFailureStage;
    const humanFailureMessage = this.getHumanFailureMessage(normalizedStage);
    const isQualityGateFailure = normalizedStage === "quality_gate";
    const conflictedFiles =
      mergeErr instanceof MergeJobError
        ? mergeErr.conflictedFiles
        : mergeErr instanceof RebaseConflictError
          ? mergeErr.conflictedFiles
          : [];
    if (await this.host.branchManager.isMergeInProgress(repoPath)) {
      await this.host.branchManager.mergeAbort(repoPath);
    }

    // Archive session so task detail sidebar can show agent output when task is blocked/failed
    try {
      const state = this.host.getState(projectId);
      const slot = state.slots.get(task.id);
      if (slot) {
        const settings = await this.host.projectService.getSettings(projectId);
        const agentConfig = settings.simpleComplexityAgent;
        const wtPath = slot.worktreePath ?? repoPath;
        const session = await this.host.sessionManager.createSession(repoPath, {
          taskId: task.id,
          attempt: slot.attempt,
          agentType: agentConfig.type,
          agentModel: agentConfig.model || "",
          gitBranch: slot.branchName,
          status: "failed",
          outputLog: slot.agent.outputLog.join(""),
          failureReason: humanFailureMessage,
          startedAt: slot.agent.startedAt,
        });
        await this.host.sessionManager.archiveSession(
          repoPath,
          task.id,
          slot.attempt,
          session,
          wtPath
        );
      }
    } catch (archiveErr) {
      log.warn("Failed to archive session on merge failure", { taskId: task.id, archiveErr });
    }

    let shouldNudge = false;
    try {
      const freshIssue = await this.host.taskStore.show(projectId, task.id);
      const cumulativeAttempts = this.host.taskStore.getCumulativeAttemptsFromIssue(freshIssue) + 1;
      await this.host.taskStore.setCumulativeAttempts(projectId, task.id, cumulativeAttempts);
      await this.host.taskStore.setConflictFiles(projectId, task.id, conflictedFiles);
      await this.host.taskStore.setMergeStage(projectId, task.id, normalizedStage);
      const scopeConfidence = this.getScopeConfidence(freshIssue);
      const mergeFailureReason = mergeErr.message?.slice(0, 500) ?? "Merge failed";
      const stageLabel = isQualityGateFailure ? "quality-gate" : "merge";
      const qualityGateFailureDetails = this.getQualityGateFailureDetails(mergeErr);
      const qualityGateStructuredDetails = this.buildQualityGateStructuredDetails(
        qualityGateFailureDetails,
        slot?.worktreePath ?? repoPath
      );
      const isEnvironmentSetupQualityGateFailure =
        isQualityGateFailure && this.isEnvironmentSetupQualityGateFailure(mergeErr);
      const environmentSetupRemediation = isEnvironmentSetupQualityGateFailure
        ? this.buildEnvironmentSetupRemediation({
            command:
              qualityGateStructuredDetails.failedGateCommand ??
              qualityGateFailureDetails?.command ??
              null,
            worktreePath: qualityGateStructuredDetails.worktreePath,
          })
        : null;
      const qualityGateSummaryDetail = isQualityGateFailure
        ? this.buildQualityGateSummaryDetail(mergeErr)
        : null;
      const qualityGateSummarySuffix = qualityGateSummaryDetail
        ? ` (${qualityGateSummaryDetail})`
        : "";
      const qualityGateCommentDetail = qualityGateSummaryDetail
        ? ` Details: ${qualityGateSummaryDetail}.`
        : "";
      const retryContext = this.buildRetryContextForMergeFailure(
        normalizedStage,
        mergeFailureReason,
        isEnvironmentSetupQualityGateFailure ? "environment_setup" : undefined,
        qualityGateStructuredDetails.qualityGateDetail
      );
      const mergeBlockReason = this.getMergeFailureBlockReason(normalizedStage);
      const mergeFailureType = this.getMergeFailureType(
        normalizedStage,
        isEnvironmentSetupQualityGateFailure ? "environment_setup" : undefined
      );
      if (isQualityGateFailure) {
        if (isEnvironmentSetupQualityGateFailure) {
          await this.recordMergeValidationEnvironmentFailure(
            projectId,
            repoPath,
            this.buildMergeValidationHealthSummary({
              command:
                qualityGateStructuredDetails.failedGateCommand ??
                qualityGateFailureDetails?.command ??
                null,
              firstErrorLine:
                qualityGateStructuredDetails.qualityGateDetail?.firstErrorLine ??
                qualityGateFailureDetails?.firstErrorLine ??
                null,
              reason:
                qualityGateStructuredDetails.failedGateReason ??
                qualityGateFailureDetails?.reason ??
                mergeFailureReason,
              remediation: environmentSetupRemediation,
            })
          );
        } else {
          await this.markMergeValidationHealthy(projectId, repoPath);
        }
      }

      const maxMergeFailures = BACKOFF_FAILURE_THRESHOLD * 2;
      if (isEnvironmentSetupQualityGateFailure || cumulativeAttempts >= maxMergeFailures) {
        const blockedNextAction = environmentSetupRemediation ?? "Blocked pending investigation";
        log.info(`Blocking ${task.id} after ${cumulativeAttempts} ${stageLabel} failures`);
        const blockedSummary = buildTaskLastExecutionSummary({
          attempt: cumulativeAttempts,
          outcome: "blocked",
          phase: "merge",
          failureType: mergeFailureType,
          blockReason: mergeBlockReason,
          summary: compactExecutionText(
            `Attempt ${cumulativeAttempts} ${stageLabel} failed: ${humanFailureMessage}${qualityGateSummarySuffix}${environmentSetupRemediation ? ` | remediation: ${environmentSetupRemediation}` : ""}`,
            500
          ),
        });
        await this.host.taskStore.update(projectId, task.id, {
          status: "blocked",
          assignee: "",
          block_reason: mergeBlockReason,
          extra: {
            last_execution_summary: blockedSummary,
            [NEXT_RETRY_CONTEXT_KEY]: retryContext,
            failedGateCommand: qualityGateStructuredDetails.failedGateCommand,
            failedGateReason: qualityGateStructuredDetails.failedGateReason,
            failedGateOutputSnippet: qualityGateStructuredDetails.failedGateOutputSnippet,
            worktreePath: qualityGateStructuredDetails.worktreePath,
            qualityGateCategory: qualityGateStructuredDetails.qualityGateCategory,
            qualityGateValidationWorkspace:
              qualityGateStructuredDetails.qualityGateValidationWorkspace,
            qualityGateAutoRepairAttempted: qualityGateStructuredDetails.qualityGateRepairAttempted,
            qualityGateAutoRepairSucceeded: qualityGateStructuredDetails.qualityGateRepairSucceeded,
            qualityGateExecutable: qualityGateStructuredDetails.qualityGateExecutable,
            qualityGateCwd: qualityGateStructuredDetails.qualityGateCwd,
            qualityGateExitCode: qualityGateStructuredDetails.qualityGateExitCode,
            qualityGateSignal: qualityGateStructuredDetails.qualityGateSignal,
            qualityGateDetail: qualityGateStructuredDetails.qualityGateDetail,
          },
        });
        await this.host.taskStore.comment(
          projectId,
          task.id,
          isQualityGateFailure
            ? isEnvironmentSetupQualityGateFailure
              ? `Blocked after deterministic environment setup quality-gate failure. ${humanFailureMessage}${qualityGateCommentDetail} Remediation: ${environmentSetupRemediation}`
              : `Blocked after ${cumulativeAttempts} consecutive quality-gate failures. ${humanFailureMessage}${qualityGateCommentDetail}`
            : `Blocked after ${cumulativeAttempts} consecutive merge failures. ${humanFailureMessage}`
        );
        broadcastToProject(projectId, {
          type: "task.blocked",
          taskId: task.id,
          reason: isQualityGateFailure
            ? isEnvironmentSetupQualityGateFailure
              ? "Blocked due deterministic environment setup quality-gate failure"
              : `Blocked after ${cumulativeAttempts} quality-gate failures`
            : `Blocked after ${cumulativeAttempts} merge failures`,
          cumulativeAttempts,
          qualityGateDetail: qualityGateStructuredDetails?.qualityGateDetail ?? null,
          failedGateCommand: qualityGateStructuredDetails?.failedGateCommand ?? null,
          failedGateReason: qualityGateStructuredDetails?.failedGateReason ?? null,
          failedGateOutputSnippet: qualityGateStructuredDetails?.failedGateOutputSnippet ?? null,
          worktreePath: qualityGateStructuredDetails?.worktreePath ?? null,
        } as ServerEvent);
        eventLogService
          .append(repoPath, {
            timestamp: new Date().toISOString(),
            projectId,
            taskId: task.id,
            event: "merge.failed",
            data: {
              reason: mergeFailureReason,
              stage: normalizedStage,
              failureType: mergeFailureType,
              branchName: failedBranchName,
              conflictedFiles,
              attempt: cumulativeAttempts,
              resolvedBy: "blocked",
              blockReason: mergeBlockReason,
              scopeConfidence,
              summary: blockedSummary.summary,
              qualityGateCategory: qualityGateFailureDetails?.category ?? null,
              qualityGateValidationWorkspace:
                qualityGateFailureDetails?.validationWorkspace ?? null,
              qualityGateCommand: qualityGateFailureDetails?.command ?? null,
              qualityGateFirstErrorLine: qualityGateFailureDetails?.firstErrorLine ?? null,
              qualityGateAutoRepairAttempted:
                qualityGateFailureDetails?.autoRepairAttempted ?? false,
              qualityGateAutoRepairSucceeded:
                qualityGateFailureDetails?.autoRepairSucceeded ?? false,
              qualityGateAutoRepairCommands: qualityGateFailureDetails?.autoRepairCommands ?? [],
              qualityGateExecutable: qualityGateFailureDetails?.executable ?? null,
              qualityGateCwd: qualityGateFailureDetails?.cwd ?? null,
              qualityGateExitCode: qualityGateFailureDetails?.exitCode ?? null,
              qualityGateSignal: qualityGateFailureDetails?.signal ?? null,
              failedGateCommand: qualityGateStructuredDetails.failedGateCommand,
              failedGateReason: qualityGateStructuredDetails.failedGateReason,
              failedGateOutputSnippet: qualityGateStructuredDetails.failedGateOutputSnippet,
              worktreePath: qualityGateStructuredDetails.worktreePath,
              qualityGateDetail: qualityGateStructuredDetails.qualityGateDetail,
              nextAction: blockedNextAction,
            },
          })
          .catch(() => {});
        this.broadcastMergeFailureWs(projectId, task.id, {
          cumulativeAttempts,
          resolvedBy: "blocked",
          reason: mergeFailureReason,
          mergeStage: normalizedStage,
          qualityGateDetail: qualityGateStructuredDetails.qualityGateDetail,
          failedGateCommand: qualityGateStructuredDetails.failedGateCommand,
          failedGateReason: qualityGateStructuredDetails.failedGateReason,
          failedGateOutputSnippet: qualityGateStructuredDetails.failedGateOutputSnippet,
          worktreePath: qualityGateStructuredDetails.worktreePath,
        });
        eventLogService
          .append(repoPath, {
            timestamp: new Date().toISOString(),
            projectId,
            taskId: task.id,
            event: "task.blocked",
            data: {
              attempt: cumulativeAttempts,
              phase: "merge",
              failureType: mergeFailureType,
              blockReason: mergeBlockReason,
              mergeStage: normalizedStage,
              conflictedFiles,
              summary: blockedSummary.summary,
              nextAction: blockedNextAction,
              failedGateCommand: qualityGateStructuredDetails.failedGateCommand,
              failedGateReason: qualityGateStructuredDetails.failedGateReason,
              failedGateOutputSnippet: qualityGateStructuredDetails.failedGateOutputSnippet,
              worktreePath: qualityGateStructuredDetails.worktreePath,
              qualityGateCategory: qualityGateStructuredDetails.qualityGateCategory,
              qualityGateValidationWorkspace:
                qualityGateStructuredDetails.qualityGateValidationWorkspace,
              qualityGateAutoRepairAttempted:
                qualityGateStructuredDetails.qualityGateRepairAttempted,
              qualityGateAutoRepairSucceeded:
                qualityGateStructuredDetails.qualityGateRepairSucceeded,
              qualityGateExecutable: qualityGateStructuredDetails.qualityGateExecutable,
              qualityGateCwd: qualityGateStructuredDetails.qualityGateCwd,
              qualityGateExitCode: qualityGateStructuredDetails.qualityGateExitCode,
              qualityGateSignal: qualityGateStructuredDetails.qualityGateSignal,
              qualityGateDetail: qualityGateStructuredDetails.qualityGateDetail,
            },
          })
          .catch(() => {});
        return;
      }

      log.info("Reopening task after merge failure", { taskId: task.id, cumulativeAttempts });
      const requeuedSummary = buildTaskLastExecutionSummary({
        attempt: cumulativeAttempts,
        outcome: "requeued",
        phase: "merge",
        failureType: mergeFailureType,
        summary: compactExecutionText(
          `Attempt ${cumulativeAttempts} ${stageLabel} failed: ${humanFailureMessage}${qualityGateSummarySuffix}`,
          500
        ),
      });
      await this.host.taskStore.update(projectId, task.id, {
        status: "open",
        assignee: "",
        extra: {
          last_execution_summary: requeuedSummary,
          [NEXT_RETRY_CONTEXT_KEY]: retryContext,
          failedGateCommand: qualityGateStructuredDetails.failedGateCommand,
          failedGateReason: qualityGateStructuredDetails.failedGateReason,
          failedGateOutputSnippet: qualityGateStructuredDetails.failedGateOutputSnippet,
          worktreePath: qualityGateStructuredDetails.worktreePath,
          qualityGateCategory: qualityGateStructuredDetails.qualityGateCategory,
          qualityGateValidationWorkspace:
            qualityGateStructuredDetails.qualityGateValidationWorkspace,
          qualityGateAutoRepairAttempted: qualityGateStructuredDetails.qualityGateRepairAttempted,
          qualityGateAutoRepairSucceeded: qualityGateStructuredDetails.qualityGateRepairSucceeded,
          qualityGateExecutable: qualityGateStructuredDetails.qualityGateExecutable,
          qualityGateCwd: qualityGateStructuredDetails.qualityGateCwd,
          qualityGateExitCode: qualityGateStructuredDetails.qualityGateExitCode,
          qualityGateSignal: qualityGateStructuredDetails.qualityGateSignal,
          qualityGateDetail: qualityGateStructuredDetails.qualityGateDetail,
        },
      });
      await this.host.taskStore.comment(
        projectId,
        task.id,
        isQualityGateFailure
          ? `Pre-merge quality gates failed. Task requeued — next run will retry after fixes. ${humanFailureMessage}${qualityGateCommentDetail}`
          : `Merge conflict with current main. Task requeued — next run will rebase and retry. ${humanFailureMessage}`
      );
      eventLogService
        .append(repoPath, {
          timestamp: new Date().toISOString(),
          projectId,
          taskId: task.id,
          event: "merge.failed",
          data: {
            reason: mergeFailureReason,
            stage: normalizedStage,
            failureType: mergeFailureType,
            branchName: failedBranchName,
            conflictedFiles,
            attempt: cumulativeAttempts,
            resolvedBy: "requeued",
            scopeConfidence,
            summary: requeuedSummary.summary,
            qualityGateCategory: qualityGateFailureDetails?.category ?? null,
            qualityGateValidationWorkspace: qualityGateFailureDetails?.validationWorkspace ?? null,
            qualityGateCommand: qualityGateFailureDetails?.command ?? null,
            qualityGateFirstErrorLine: qualityGateFailureDetails?.firstErrorLine ?? null,
            qualityGateAutoRepairAttempted: qualityGateFailureDetails?.autoRepairAttempted ?? false,
            qualityGateAutoRepairSucceeded: qualityGateFailureDetails?.autoRepairSucceeded ?? false,
            qualityGateAutoRepairCommands: qualityGateFailureDetails?.autoRepairCommands ?? [],
            qualityGateExecutable: qualityGateFailureDetails?.executable ?? null,
            qualityGateCwd: qualityGateFailureDetails?.cwd ?? null,
            qualityGateExitCode: qualityGateFailureDetails?.exitCode ?? null,
            qualityGateSignal: qualityGateFailureDetails?.signal ?? null,
            failedGateCommand: qualityGateStructuredDetails.failedGateCommand,
            failedGateReason: qualityGateStructuredDetails.failedGateReason,
            failedGateOutputSnippet: qualityGateStructuredDetails.failedGateOutputSnippet,
            worktreePath: qualityGateStructuredDetails.worktreePath,
            qualityGateDetail: qualityGateStructuredDetails.qualityGateDetail,
            nextAction: "Requeued for retry",
          },
        })
        .catch(() => {});
      this.broadcastMergeFailureWs(projectId, task.id, {
        cumulativeAttempts,
        resolvedBy: "requeued",
        reason: mergeFailureReason,
        mergeStage: normalizedStage,
        qualityGateDetail: qualityGateStructuredDetails.qualityGateDetail,
        failedGateCommand: qualityGateStructuredDetails.failedGateCommand,
        failedGateReason: qualityGateStructuredDetails.failedGateReason,
        failedGateOutputSnippet: qualityGateStructuredDetails.failedGateOutputSnippet,
        worktreePath: qualityGateStructuredDetails.worktreePath,
      });
      eventLogService
        .append(repoPath, {
          timestamp: new Date().toISOString(),
          projectId,
          taskId: task.id,
          event: "task.requeued",
          data: {
            attempt: cumulativeAttempts,
            phase: "merge",
            failureType: mergeFailureType,
            mergeStage: normalizedStage,
            conflictedFiles,
            summary: requeuedSummary.summary,
            nextAction: "Requeued for retry",
            failedGateCommand: qualityGateStructuredDetails.failedGateCommand,
            failedGateReason: qualityGateStructuredDetails.failedGateReason,
            failedGateOutputSnippet: qualityGateStructuredDetails.failedGateOutputSnippet,
            worktreePath: qualityGateStructuredDetails.worktreePath,
            qualityGateCategory: qualityGateStructuredDetails.qualityGateCategory,
            qualityGateValidationWorkspace:
              qualityGateStructuredDetails.qualityGateValidationWorkspace,
            qualityGateAutoRepairAttempted: qualityGateStructuredDetails.qualityGateRepairAttempted,
            qualityGateAutoRepairSucceeded: qualityGateStructuredDetails.qualityGateRepairSucceeded,
            qualityGateExecutable: qualityGateStructuredDetails.qualityGateExecutable,
            qualityGateCwd: qualityGateStructuredDetails.qualityGateCwd,
            qualityGateExitCode: qualityGateStructuredDetails.qualityGateExitCode,
            qualityGateSignal: qualityGateStructuredDetails.qualityGateSignal,
            qualityGateDetail: qualityGateStructuredDetails.qualityGateDetail,
          },
        })
        .catch(() => {});
      this.broadcastTaskRequeuedWs(projectId, task.id, {
        cumulativeAttempts,
        phase: "merge",
        mergeStage: normalizedStage,
        summary: requeuedSummary.summary,
        nextAction: "Requeued for retry",
        qualityGateDetail: qualityGateStructuredDetails.qualityGateDetail,
        failedGateCommand: qualityGateStructuredDetails.failedGateCommand,
        failedGateReason: qualityGateStructuredDetails.failedGateReason,
        failedGateOutputSnippet: qualityGateStructuredDetails.failedGateOutputSnippet,
        worktreePath: qualityGateStructuredDetails.worktreePath,
      });

      shouldNudge = true;
    } catch (err) {
      log.warn("Failed to requeue task after merge failure", { taskId: task.id, err });
    } finally {
      await this.releaseMergeSlot(projectId, repoPath, "fail", task.id);
      if (shouldNudge) {
        this.host.nudge(projectId);
      }
    }
  }

  async postCompletionAsync(
    projectId: string,
    repoPath: string,
    taskId: string,
    options?: { mergedToMain?: boolean }
  ): Promise<void> {
    const mergedToMain = options?.mergedToMain !== false;
    let pushStatus: PushCompletionStatus = "publish_failed";
    if (!this.pushInProgress.has(projectId)) {
      let resolvePush!: () => void;
      const pushPromise = new Promise<void>((r) => {
        resolvePush = r;
      });
      this.pushCompletion.set(projectId, { promise: pushPromise, resolve: resolvePush });
      this.pushInProgress.add(projectId);
      try {
        pushStatus = await this.pushMainSafe(projectId, repoPath);
        if (pushStatus !== "publish_failed") {
          await this.cleanupAfterSuccessfulPush(projectId, repoPath);
        }
      } finally {
        this.pushInProgress.delete(projectId);
        const entry = this.pushCompletion.get(projectId);
        if (entry) {
          entry.resolve();
          this.pushCompletion.delete(projectId);
        }
      }
    } else {
      log.info("Push already in progress, skipping (will retry on next completion)");
    }

    this.host.feedbackService.checkAutoResolveOnTaskDone(projectId, taskId).catch((err) => {
      log.warn("Auto-resolve feedback on task done failed", { taskId, err });
    });

    // PRD §7.5.3: Auto-deploy on each task only when a merge to main occurred
    if (mergedToMain) {
      triggerDeployForEvent(projectId, "each_task").catch((err) => {
        log.warn("Auto-deploy on task completion failed", { projectId, err });
      });
    }

    const allIssues = await this.host.taskStore.listAll(projectId);
    const epicId = resolveEpicId(taskId, allIssues);
    if (epicId) {
      const implTasks = this.getEpicImplementationTasks(allIssues, epicId);
      const allClosed =
        implTasks.length > 0 && implTasks.every((i) => (i.status as string) === "closed");
      if (allClosed) {
        const epicIssue = allIssues.find((i) => i.id === epicId);
        if (epicIssue && (epicIssue.status as string) !== "closed") {
          this.runFinalReviewAndCloseOrCreateTasks(projectId, repoPath, epicId).catch((err) =>
            log.warn("Final review flow failed", { projectId, epicId, err })
          );
        } else {
          const shouldDeploy = await this.shouldTriggerDeployForEpic(projectId, epicId);
          if (shouldDeploy) {
            triggerDeployForEvent(projectId, "each_epic").catch((err) => {
              log.warn("Auto-deploy on epic completion failed", { projectId, err });
            });
          }
          const planRow = await this.host.taskStore.planGetByEpicId(projectId, epicId);
          if (planRow) {
            // Self-improvement (frequency after_each_plan): run once when plan execution is fully complete.
            // runIfDue checks frequency, hasCodeChangesSince(lastRunAt, baseBranch), and no run in progress.
            selfImprovementService
              .runIfDue(projectId, { trigger: "after_each_plan", planId: planRow.plan_id })
              .catch((err) =>
                log.warn("Self-improvement after plan completion failed", {
                  projectId,
                  epicId,
                  err,
                })
              );
          }
        }
      }
    }
  }

  /**
   * Deliver gate: trigger deploy for epic only when plan is complete (reviewedAt set).
   * When plan is in_review (reviewedAt null), do not trigger; user must mark plan complete first.
   */
  private async shouldTriggerDeployForEpic(projectId: string, epicId: string): Promise<boolean> {
    const planRow = await this.host.taskStore.planGetByEpicId(projectId, epicId);
    if (!planRow) return false;
    return planRow.metadata?.reviewedAt != null;
  }

  /**
   * Run final review agent when last task of epic is done.
   * If pass: close epic, trigger deploy. If issues: create tasks, epic stays open, nudge.
   */
  private async runFinalReviewAndCloseOrCreateTasks(
    projectId: string,
    repoPath: string,
    epicId: string
  ): Promise<void> {
    const result = await finalReviewService.runFinalReview(projectId, epicId, repoPath);

    if (result === null) {
      // No plan (deploy-fix epic) or agent failed — close epic; deploy only when plan is complete (reviewedAt set)
      await this.host.taskStore.close(projectId, epicId, "All tasks done");
      const shouldDeploy = await this.shouldTriggerDeployForEpic(projectId, epicId);
      if (shouldDeploy) {
        triggerDeployForEvent(projectId, "each_epic").catch((err) => {
          log.warn("Auto-deploy on epic completion failed", { projectId, err });
        });
      }
      const planRow = await this.host.taskStore.planGetByEpicId(projectId, epicId);
      if (planRow) {
        // Self-improvement (after_each_plan): runIfDue does change detection and run-in-progress check.
        selfImprovementService
          .runIfDue(projectId, { trigger: "after_each_plan", planId: planRow.plan_id })
          .catch((err) =>
            log.warn("Self-improvement after plan completion failed", { projectId, epicId, err })
          );
      }
      return;
    }

    if (result.status === "pass") {
      await this.host.taskStore.close(projectId, epicId, "All tasks done; final review passed");
      const shouldDeploy = await this.shouldTriggerDeployForEpic(projectId, epicId);
      if (shouldDeploy) {
        triggerDeployForEvent(projectId, "each_epic").catch((err) => {
          log.warn("Auto-deploy on epic completion failed", { projectId, err });
        });
      }
      const planRow = await this.host.taskStore.planGetByEpicId(projectId, epicId);
      if (planRow) {
        // Self-improvement (after_each_plan): runIfDue does change detection and run-in-progress check.
        selfImprovementService
          .runIfDue(projectId, { trigger: "after_each_plan", planId: planRow.plan_id })
          .catch((err) =>
            log.warn("Self-improvement after plan completion failed", { projectId, epicId, err })
          );
      }
      return;
    }

    // Issues found — create tasks, epic stays open
    const createdIds = await finalReviewService.createTasksFromReview(
      projectId,
      epicId,
      result.proposedTasks
    );
    log.info("Final review found issues, created tasks", {
      projectId,
      epicId,
      assessment: result.assessment,
      createdCount: createdIds.length,
    });
    this.host.nudge(projectId);
  }

  async waitForPushComplete(projectId: string): Promise<void> {
    if (!this.pushInProgress.has(projectId)) return;
    const entry = this.pushCompletion.get(projectId);
    if (entry) await entry.promise;
  }

  private async ensurePreparedMainQualityGates(
    projectId: string,
    repoPath: string,
    baseBranch: string
  ): Promise<void> {
    const failure = await this.getBaselineQualityGateFailure(projectId, repoPath, baseBranch, {
      useCache: false,
    });
    if (!failure) return;

    await this.createBaselineQualityGateRemediationTask(projectId, baseBranch, failure);
    await this.createBaselineQualityGateNotification(
      projectId,
      baseBranch,
      this.buildBaselineQualityGateDetail(failure)
    );
    throw this.buildMergeQualityGateError(failure, repoPath);
  }

  private async resolvePushRebaseConflicts(options: {
    projectId: string;
    repoPath: string;
    baseBranch: string;
    settings: Awaited<ReturnType<MergeCoordinatorHost["projectService"]["getSettings"]>>;
    initialConflict: RebaseConflictError;
  }): Promise<{ ok: true } | { ok: false; error: Error }> {
    const { projectId, repoPath, baseBranch, settings, initialConflict } = options;
    const MAX_PUSH_REBASE_CONFLICT_ROUNDS = 12;
    let round = 0;
    let pendingConflict: RebaseConflictError | null = initialConflict;

    while (pendingConflict) {
      round += 1;
      if (round > MAX_PUSH_REBASE_CONFLICT_ROUNDS) {
        const err = new Error(
          `Push rebase conflict unresolved after ${MAX_PUSH_REBASE_CONFLICT_ROUNDS} attempts`
        );
        log.warn("Push rebase conflict exceeded max conflict-resolution rounds", {
          projectId,
          baseBranch,
          maxRounds: MAX_PUSH_REBASE_CONFLICT_ROUNDS,
        });
        await this.host.branchManager.rebaseAbort(repoPath);
        return { ok: false, error: err };
      }

      log.info("Push rebase conflict, invoking merger agent", {
        projectId,
        files: pendingConflict.conflictedFiles,
        round,
      });
      const resolved = await this.host.runMergerAgentAndWait({
        projectId,
        cwd: repoPath,
        config: settings.simpleComplexityAgent as AgentConfig,
        phase: "push_rebase",
        taskId: "",
        branchName: baseBranch,
        conflictedFiles: pendingConflict.conflictedFiles,
        testCommand: resolveTestCommand(settings),
        mergeQualityGates: getMergeQualityGateCommands(),
        baseBranch,
      });
      if (!resolved) {
        log.warn("Merger agent failed to resolve push rebase conflicts", {
          projectId,
          round,
        });
        await this.host.branchManager.rebaseAbort(repoPath);
        return {
          ok: false,
          error: new RebaseConflictError(pendingConflict.conflictedFiles),
        };
      }

      try {
        await this.host.branchManager.rebaseContinue(repoPath);
        pendingConflict = null;
      } catch (continueErr) {
        if (continueErr instanceof RebaseConflictError) {
          pendingConflict = continueErr;
        } else {
          log.warn("rebase --continue failed after merger", {
            projectId,
            continueErr,
            round,
          });
          await this.host.branchManager.rebaseAbort(repoPath);
          return {
            ok: false,
            error: continueErr instanceof Error ? continueErr : new Error(String(continueErr)),
          };
        }
      }
    }

    try {
      await this.ensurePreparedMainQualityGates(projectId, repoPath, baseBranch);
      await this.host.branchManager.pushMainToOrigin(repoPath, baseBranch);
      log.info("Merger resolved push rebase conflicts, push succeeded", { projectId });
      eventLogService
        .append(repoPath, {
          timestamp: new Date().toISOString(),
          projectId,
          taskId: "",
          event: "push.succeeded",
        })
        .catch(() => {});
      return { ok: true };
    } catch (pushErr) {
      log.warn("push to origin failed after resolving push rebase conflicts", {
        projectId,
        pushErr,
      });
      return {
        ok: false,
        error: pushErr instanceof Error ? pushErr : new Error(String(pushErr)),
      };
    }
  }

  /**
   * Push main to origin.
   * On rebase conflict: run merger/rebase-continue rounds until rebase is complete
   * (bounded by MAX_PUSH_REBASE_CONFLICT_ROUNDS). If unresolved, abort and retry on next completion.
   */
  private async pushMainSafe(projectId: string, repoPath: string): Promise<PushCompletionStatus> {
    await gitCommitQueue.drain();
    await this.host.taskStore.syncForPush(projectId);

    const settings = await this.host.projectService.getSettings(projectId);
    const baseBranch = await resolveBaseBranch(repoPath, settings.worktreeBaseBranch);
    const repoState = await inspectGitRepoState(repoPath, baseBranch);

    if (repoState.remoteMode === "local_only") {
      log.info("No origin configured; skipping publish after local merge", {
        projectId,
        baseBranch,
      });
      eventLogService
        .append(repoPath, {
          timestamp: new Date().toISOString(),
          projectId,
          taskId: "",
          event: "push.skipped",
          data: {
            reason: "local_only",
          },
        })
        .catch(() => {});
      return "local_only";
    }

    try {
      await this.host.branchManager.prepareMainForPush(repoPath, baseBranch);
      await this.ensurePreparedMainQualityGates(projectId, repoPath, baseBranch);
      await this.host.branchManager.pushMainToOrigin(repoPath, baseBranch);
      log.info("Push to origin succeeded", { projectId });
      eventLogService
        .append(repoPath, {
          timestamp: new Date().toISOString(),
          projectId,
          taskId: "",
          event: "push.succeeded",
        })
        .catch(() => {});
      return "published";
    } catch (err) {
      let terminalError: Error = err instanceof Error ? err : new Error(String(err));
      let pushStage: "push_rebase" | "push" | "quality_gate" = "push";
      if (err instanceof RebaseConflictError) {
        pushStage = "push_rebase";
        const resolution = await this.resolvePushRebaseConflicts({
          projectId,
          repoPath,
          baseBranch,
          settings,
          initialConflict: err,
        });
        if (resolution.ok) {
          return "published";
        }
        terminalError = resolution.error;
      } else {
        log.warn("Push failed, will retry on next task completion", { projectId, err });
      }
      if (terminalError instanceof MergeJobError && terminalError.stage === "quality_gate") {
        pushStage = "quality_gate";
      }
      const reason = terminalError.message.slice(0, 500);
      eventLogService
        .append(repoPath, {
          timestamp: new Date().toISOString(),
          projectId,
          taskId: "",
          event: "push.failed",
          data: {
            reason,
            conflictedFiles:
              terminalError instanceof RebaseConflictError ? terminalError.conflictedFiles : [],
            stage: pushStage,
          },
        })
        .catch(() => {});
      await notificationService
        .create({
          projectId,
          source: "execute",
          sourceId: "remote-publish",
          questions: [
            {
              id: `push-${projectId}`,
              text: `Work merged locally, but publish to origin failed: ${reason}`,
            },
          ],
        })
        .catch((notificationErr) =>
          log.warn("Failed to create remote publish warning notification", {
            projectId,
            notificationErr,
          })
        );
      return "publish_failed";
    }
  }
}
