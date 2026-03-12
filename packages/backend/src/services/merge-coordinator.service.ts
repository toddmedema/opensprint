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
  resolveTestCommand,
  type AgentConfig,
  type TestResults,
} from "@opensprint/shared";
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
import type { TimerRegistry } from "./timer-registry.js";
import { createLogger } from "../utils/logger.js";
import { buildTaskLastExecutionSummary, compactExecutionText } from "./task-execution-summary.js";
import { inspectGitRepoState, resolveBaseBranch } from "../utils/git-repo-state.js";
import { getMergeQualityGateCommands } from "./merge-quality-gates.js";
import type { RetryContext } from "./orchestrator-phase-context.js";

const log = createLogger("merge-coordinator");
const _MAX_PUSH_REBASE_RESOLUTION_ROUNDS = 12;
const NEXT_RETRY_CONTEXT_KEY = "next_retry_context";
const MERGE_RETRY_CONTEXT_FAILURE_LIMIT = 1200;
const QUALITY_GATE_ENV_REQUEUE_COUNT_KEY = "quality_gate_env_requeue_count";
const QUALITY_GATE_ENV_REQUEUE_LIMIT = 1;

/** One-sentence explanation for merge failures shown to users (conflicts with main in same files). */
const HUMAN_MERGE_FAILURE_MESSAGE =
  "The merge could not complete because your branch and main both changed the same files.";
const HUMAN_QUALITY_GATE_FAILURE_MESSAGE =
  "Pre-merge quality gates failed (build, lint, or test).";

type MergeFailureStage = "rebase_before_merge" | "merge_to_main" | "push_rebase" | "quality_gate";

export interface MergeQualityGateRunOptions {
  projectId: string;
  repoPath: string;
  worktreePath: string;
  taskId: string;
  branchName: string;
  baseBranch: string;
}

export interface MergeQualityGateFailure {
  command: string;
  reason: string;
  output: string;
  firstErrorLine?: string;
  category?: "environment_setup" | "quality_gate";
  autoRepairAttempted?: boolean;
  autoRepairSucceeded?: boolean;
  autoRepairCommands?: string[];
  autoRepairOutput?: string;
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
    getChangedFiles(repoPath: string, branchName: string, baseBranch?: string): Promise<string[]>;
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

    for (const target of perProject.values()) {
      log.info("Push succeeded, cleaning up merged branch/worktree", {
        taskId: target.taskId,
        branchName: target.branchName,
      });
      try {
        if (target.gitWorkingMode !== "branches") {
          const key = target.worktreeKey ?? target.taskId;
          await this.host.branchManager.removeTaskWorktree(
            repoPath,
            key,
            target.worktreePath ?? undefined
          );
        }
        await this.host.branchManager.deleteBranch(repoPath, target.branchName);
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
    return stage === "quality_gate"
      ? HUMAN_QUALITY_GATE_FAILURE_MESSAGE
      : HUMAN_MERGE_FAILURE_MESSAGE;
  }

  private buildRetryContextForMergeFailure(
    stage: MergeFailureStage,
    mergeFailureReason: string
  ): RetryContext {
    const stageLabel = stage === "quality_gate" ? "pre-merge quality gate" : "merge";
    const previousFailure = compactExecutionText(
      `${stageLabel} failed: ${mergeFailureReason}`,
      MERGE_RETRY_CONTEXT_FAILURE_LIMIT
    );
    return {
      previousFailure,
      failureType: stage === "quality_gate" ? "coding_failure" : "merge_conflict",
    };
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

  private getQualityGateFailureDetails(mergeErr: Error): MergeJobError["qualityGateFailure"] | null {
    if (!(mergeErr instanceof MergeJobError) || mergeErr.stage !== "quality_gate") return null;
    return mergeErr.qualityGateFailure ?? null;
  }

  private isEnvironmentSetupQualityGateFailure(mergeErr: Error): boolean {
    return this.getQualityGateFailureDetails(mergeErr)?.category === "environment_setup";
  }

  private getNumericExtra(issue: StoredTask, key: string): number {
    const raw = (issue as Record<string, unknown>)[key];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
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
    if (details.length === 0) return null;
    return details.join(" | ");
  }

  private async ensureMergeQualityGates(options: MergeQualityGateRunOptions): Promise<void> {
    if (!this.host.runMergeQualityGates) return;
    const failure = await this.host.runMergeQualityGates(options);
    if (!failure) return;

    const reason = failure.reason.trim().slice(0, 500) || "Unknown quality gate failure";
    const outputSnippet = failure.output.trim().slice(0, 1200);
    const detail = outputSnippet.length > 0 ? ` | ${outputSnippet}` : "";
    const firstErrorLine = this.getQualityGateFirstErrorLine(failure).slice(0, 300);
    throw new MergeJobError(
      `Quality gate failed (${failure.command}): ${reason}${detail}`,
      "quality_gate",
      [],
      "requeued",
      {
        command: failure.command,
        firstErrorLine,
        category: failure.category,
        autoRepairAttempted: failure.autoRepairAttempted,
        autoRepairSucceeded: failure.autoRepairSucceeded,
        autoRepairCommands: failure.autoRepairCommands,
      }
    );
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
    await this.host.sessionManager.archiveSession(
      repoPath,
      task.id,
      slot.attempt,
      session,
      wtPath
    );

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

    const isPerEpicIntermediate =
      mergeStrategy === "per_epic" && epicId != null;

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
        implTasks.length > 0 &&
        implTasks.every((i) => (i.status as string) === "closed");

      if (!allImplClosed) {
        return;
      }

      // Last task in epic: merge epic branch to main, then push and cleanup via postCompletionAsync
      try {
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
      this.postCompletionAsync(projectId, repoPath, task.id, { mergedToMain: true }).catch((err) => {
        log.warn("Post-completion async work failed", { taskId: task.id, err });
      });
      return;
    }

    // 2. Attempt merge inside the serialized queue. Rebase now happens there.
    try {
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
      const isEnvironmentSetupQualityGateFailure =
        isQualityGateFailure && this.isEnvironmentSetupQualityGateFailure(mergeErr);
      const qualityGateEnvRequeueCount = this.getNumericExtra(
        freshIssue,
        QUALITY_GATE_ENV_REQUEUE_COUNT_KEY
      );
      const shouldBlockForEnvironmentSetup =
        isEnvironmentSetupQualityGateFailure &&
        qualityGateEnvRequeueCount >= QUALITY_GATE_ENV_REQUEUE_LIMIT;
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
        mergeFailureReason
      );

      const maxMergeFailures = BACKOFF_FAILURE_THRESHOLD * 2;
      if (shouldBlockForEnvironmentSetup || cumulativeAttempts >= maxMergeFailures) {
        log.info(`Blocking ${task.id} after ${cumulativeAttempts} ${stageLabel} failures`);
        const blockedSummary = buildTaskLastExecutionSummary({
          attempt: cumulativeAttempts,
          outcome: "blocked",
          phase: "merge",
          blockReason: "Merge Failure",
          summary: compactExecutionText(
            `Attempt ${cumulativeAttempts} ${stageLabel} failed: ${humanFailureMessage}${qualityGateSummarySuffix}`,
            500
          ),
        });
        await this.host.taskStore.update(projectId, task.id, {
          status: "blocked",
          assignee: "",
          block_reason: "Merge Failure",
          extra: {
            last_execution_summary: blockedSummary,
            [NEXT_RETRY_CONTEXT_KEY]: retryContext,
            [QUALITY_GATE_ENV_REQUEUE_COUNT_KEY]: isEnvironmentSetupQualityGateFailure
              ? qualityGateEnvRequeueCount + 1
              : 0,
          },
        });
        await this.host.taskStore.comment(
          projectId,
          task.id,
          isQualityGateFailure
            ? isEnvironmentSetupQualityGateFailure
              ? `Blocked after repeated environment setup quality-gate failures. ${humanFailureMessage}${qualityGateCommentDetail}`
              : `Blocked after ${cumulativeAttempts} consecutive quality-gate failures. ${humanFailureMessage}${qualityGateCommentDetail}`
            : `Blocked after ${cumulativeAttempts} consecutive merge failures. ${humanFailureMessage}`
        );
        broadcastToProject(projectId, {
          type: "task.blocked",
          taskId: task.id,
          reason: isQualityGateFailure
            ? `Blocked after ${cumulativeAttempts} quality-gate failures`
            : `Blocked after ${cumulativeAttempts} merge failures`,
          cumulativeAttempts,
        });
        eventLogService
          .append(repoPath, {
            timestamp: new Date().toISOString(),
            projectId,
            taskId: task.id,
            event: "merge.failed",
            data: {
              reason: mergeFailureReason,
              stage: normalizedStage,
              branchName: failedBranchName,
              conflictedFiles,
              attempt: cumulativeAttempts,
              resolvedBy: "blocked",
              blockReason: "Merge Failure",
              scopeConfidence,
              summary: blockedSummary.summary,
              qualityGateCategory: qualityGateFailureDetails?.category ?? null,
              qualityGateCommand: qualityGateFailureDetails?.command ?? null,
              qualityGateFirstErrorLine: qualityGateFailureDetails?.firstErrorLine ?? null,
              qualityGateAutoRepairAttempted:
                qualityGateFailureDetails?.autoRepairAttempted ?? false,
              qualityGateAutoRepairSucceeded:
                qualityGateFailureDetails?.autoRepairSucceeded ?? false,
              qualityGateAutoRepairCommands:
                qualityGateFailureDetails?.autoRepairCommands ?? [],
              nextAction: "Blocked pending investigation",
            },
          })
          .catch(() => {});
        eventLogService
          .append(repoPath, {
            timestamp: new Date().toISOString(),
            projectId,
            taskId: task.id,
            event: "task.blocked",
            data: {
              attempt: cumulativeAttempts,
              phase: "merge",
              blockReason: "Merge Failure",
              mergeStage: normalizedStage,
              conflictedFiles,
              summary: blockedSummary.summary,
              nextAction: "Blocked pending investigation",
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
          [QUALITY_GATE_ENV_REQUEUE_COUNT_KEY]: isEnvironmentSetupQualityGateFailure
            ? qualityGateEnvRequeueCount + 1
            : 0,
        },
      });
      await this.host.taskStore.comment(
        projectId,
        task.id,
        isQualityGateFailure
          ? isEnvironmentSetupQualityGateFailure
            ? `Pre-merge quality gates failed due environment setup. Auto-repair was attempted and the task was requeued once. ${humanFailureMessage}${qualityGateCommentDetail}`
            : `Pre-merge quality gates failed. Task requeued — next run will retry after fixes. ${humanFailureMessage}${qualityGateCommentDetail}`
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
            branchName: failedBranchName,
            conflictedFiles,
            attempt: cumulativeAttempts,
            resolvedBy: "requeued",
            scopeConfidence,
            summary: requeuedSummary.summary,
            qualityGateCategory: qualityGateFailureDetails?.category ?? null,
            qualityGateCommand: qualityGateFailureDetails?.command ?? null,
            qualityGateFirstErrorLine: qualityGateFailureDetails?.firstErrorLine ?? null,
            qualityGateAutoRepairAttempted:
              qualityGateFailureDetails?.autoRepairAttempted ?? false,
            qualityGateAutoRepairSucceeded:
              qualityGateFailureDetails?.autoRepairSucceeded ?? false,
            qualityGateAutoRepairCommands: qualityGateFailureDetails?.autoRepairCommands ?? [],
            nextAction: "Requeued for retry",
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
            attempt: cumulativeAttempts,
            phase: "merge",
            mergeStage: normalizedStage,
            conflictedFiles,
            summary: requeuedSummary.summary,
            nextAction: "Requeued for retry",
          },
        })
        .catch(() => {});

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
              .catch((err) => log.warn("Self-improvement after plan completion failed", { projectId, epicId, err }));
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
          .catch((err) => log.warn("Self-improvement after plan completion failed", { projectId, epicId, err }));
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
          .catch((err) => log.warn("Self-improvement after plan completion failed", { projectId, epicId, err }));
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
            error:
              continueErr instanceof Error ? continueErr : new Error(String(continueErr)),
          };
        }
      }
    }

    try {
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
  private async pushMainSafe(
    projectId: string,
    repoPath: string
  ): Promise<PushCompletionStatus> {
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
      await this.host.branchManager.pushMain(repoPath, baseBranch);
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
      let terminalError: Error =
        err instanceof Error ? err : new Error(String(err));
      let pushStage: "push_rebase" | "push" = "push";
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
