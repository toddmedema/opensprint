/**
 * MergeCoordinator — merge-to-main, push, conflict resolution, and post-completion.
 * Extracted from OrchestratorService. Owns all git merge/push logic and the push mutex.
 *
 * Key design principles:
 * - Merge FIRST, close task AFTER (never close before merge)
 * - On conflict: try merger agent once; if resolution fails, abort + requeue
 * - Task close is a separate commit after the merge commit
 * - Push failures: try merger agent once; if resolution fails, abort and retry on next completion
 */

import {
  BACKOFF_FAILURE_THRESHOLD,
  resolveTestCommand,
  type AgentConfig,
  type TestResults,
} from "@opensprint/shared";
import type { StoredTask } from "./task-store.service.js";
import { RebaseConflictError } from "./branch-manager.js";
import { gitCommitQueue, MergeJobError } from "./git-commit-queue.service.js";
import { agentIdentityService } from "./agent-identity.service.js";
import { eventLogService } from "./event-log.service.js";
import { triggerDeployForEvent } from "./deploy-trigger.service.js";
import { finalReviewService } from "./final-review.service.js";
import { broadcastToProject } from "../websocket/index.js";
import type { TimerRegistry } from "./timer-registry.js";
import { createLogger } from "../utils/logger.js";
import { buildTaskLastExecutionSummary, compactExecutionText } from "./task-execution-summary.js";

const log = createLogger("merge-coordinator");

/** Extract epic ID from task ID (e.g. os-a3f8.2 -> os-a3f8). Returns null if not a child task. */
function extractEpicId(id: string | undefined | null): string | null {
  if (id == null || typeof id !== "string") return null;
  const lastDot = id.lastIndexOf(".");
  if (lastDot <= 0) return null;
  return id.slice(0, lastDot);
}

export interface MergeSlot {
  taskId: string;
  attempt: number;
  worktreePath: string | null;
  branchName: string;
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
}

export interface MergeCoordinatorHost {
  getState(projectId: string): {
    slots: Map<string, MergeSlot>;
    status: { totalDone: number; totalFailed: number; queueDepth: number };
    globalTimers: TimerRegistry;
  };
  taskStore: {
    close(repoPath: string, taskId: string, reason: string): Promise<void>;
    update(repoPath: string, taskId: string, fields: Record<string, unknown>): Promise<void>;
    comment(repoPath: string, taskId: string, text: string): Promise<void>;
    sync(repoPath: string): Promise<void>;
    syncForPush(repoPath: string): Promise<void>;
    listAll(repoPath: string): Promise<StoredTask[]>;
    show(repoPath: string, id: string): Promise<StoredTask>;
    setCumulativeAttempts(
      repoPath: string,
      id: string,
      count: number,
      options?: { currentLabels?: string[] }
    ): Promise<void>;
    getCumulativeAttemptsFromIssue(issue: StoredTask): number;
    setConflictFiles(projectId: string, id: string, files: string[]): Promise<void>;
    setMergeStage(projectId: string, id: string, stage: string | null): Promise<void>;
  };
  branchManager: {
    waitForGitReady(wtPath: string): Promise<void>;
    commitWip(wtPath: string, taskId: string): Promise<void>;
    removeTaskWorktree(repoPath: string, taskId: string, actualPath?: string): Promise<void>;
    deleteBranch(repoPath: string, branchName: string): Promise<void>;
    getChangedFiles(repoPath: string, branchName: string): Promise<string[]>;
    pushMain(repoPath: string): Promise<void>;
    pushMainToOrigin(repoPath: string): Promise<void>;
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
  }): Promise<boolean>;
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
      unknownScopeStrategy?: "conservative" | "optimistic";
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
          await this.host.branchManager.removeTaskWorktree(
            repoPath,
            target.taskId,
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

    // 2. Attempt merge inside the serialized queue. Rebase now happens there.
    try {
      await gitCommitQueue.drain();
      await gitCommitQueue.enqueueAndWait({
        type: "worktree_merge",
        repoPath,
        worktreePath: wtPath,
        branchName,
        taskId: task.id,
        taskTitle: task.title || task.id,
      });
    } catch (mergeErr) {
      log.warn("Merge to main failed", { taskId: task.id, branchName, mergeErr });
      await this.requeueTaskAfterMergeFailure(projectId, repoPath, task, mergeErr as Error);
      return;
    }

    // 4. Merge succeeded — now close task and record everything
    const closeReason = slot.phaseResult.codingSummary || "Implemented and tested";

    await this.host.taskStore.close(projectId, task.id, closeReason);

    const agentConfig = settings.simpleComplexityAgent;
    agentIdentityService
      .recordAttempt(repoPath, {
        taskId: task.id,
        agentId: `${agentConfig.type}-${agentConfig.model ?? "default"}`,
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
      const changedFiles = await this.host.branchManager.getChangedFiles(repoPath, branchName);
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

    this.registerPendingCleanup(projectId, {
      taskId: task.id,
      branchName,
      worktreePath: wtPath,
      gitWorkingMode: settings.gitWorkingMode === "branches" ? "branches" : "worktree",
    });
    await this.releaseMergeSlot(projectId, repoPath, "complete", task.id);

    // 5. Async push + post-completion
    this.host.nudge(projectId);

    this.postCompletionAsync(projectId, repoPath, task.id).catch((err) => {
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
          failureReason: mergeErr.message ?? "Merge failed",
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
      await this.host.taskStore.setMergeStage(projectId, task.id, stage);
      const scopeConfidence = this.getScopeConfidence(freshIssue);
      const mergeFailureReason = mergeErr.message?.slice(0, 500) ?? "Merge failed";

      const maxMergeFailures = BACKOFF_FAILURE_THRESHOLD * 2;
      if (cumulativeAttempts >= maxMergeFailures) {
        log.info(`Blocking ${task.id} after ${cumulativeAttempts} merge failures`);
        const blockedSummary = buildTaskLastExecutionSummary({
          attempt: cumulativeAttempts,
          outcome: "blocked",
          phase: "merge",
          blockReason: "Merge Failure",
          summary: compactExecutionText(
            `Attempt ${cumulativeAttempts} merge failed during ${stage}: ${mergeFailureReason}`,
            500
          ),
        });
        await this.host.taskStore.update(projectId, task.id, {
          status: "blocked",
          assignee: "",
          block_reason: "Merge Failure",
          extra: {
            last_execution_summary: blockedSummary,
          },
        });
        await this.host.taskStore.comment(
          projectId,
          task.id,
          `Blocked after ${cumulativeAttempts} consecutive merge failures. Last error: ${mergeErr.message?.slice(0, 300) ?? "unknown"}`
        );
        broadcastToProject(projectId, {
          type: "task.blocked",
          taskId: task.id,
          reason: `Blocked after ${cumulativeAttempts} merge failures`,
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
              stage,
              branchName: failedBranchName,
              conflictedFiles,
              attempt: cumulativeAttempts,
              resolvedBy: "blocked",
              blockReason: "Merge Failure",
              scopeConfidence,
              summary: blockedSummary.summary,
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
              mergeStage: stage,
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
          `Attempt ${cumulativeAttempts} merge failed during ${stage}: ${mergeFailureReason}`,
          500
        ),
      });
      await this.host.taskStore.update(projectId, task.id, {
        status: "open",
        assignee: "",
        extra: {
          last_execution_summary: requeuedSummary,
        },
      });
      await this.host.taskStore.comment(
        projectId,
        task.id,
        `Merge conflict with current main. Task requeued — next run will rebase and retry. Error: ${mergeErr.message?.slice(0, 300) ?? "unknown"}`
      );
      eventLogService
        .append(repoPath, {
          timestamp: new Date().toISOString(),
          projectId,
          taskId: task.id,
          event: "merge.failed",
          data: {
            reason: mergeFailureReason,
            stage,
            branchName: failedBranchName,
            conflictedFiles,
            attempt: cumulativeAttempts,
            resolvedBy: "requeued",
            scopeConfidence,
            summary: requeuedSummary.summary,
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
            mergeStage: stage,
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

  async postCompletionAsync(projectId: string, repoPath: string, taskId: string): Promise<void> {
    let pushed = false;
    if (!this.pushInProgress.has(projectId)) {
      let resolvePush!: () => void;
      const pushPromise = new Promise<void>((r) => {
        resolvePush = r;
      });
      this.pushCompletion.set(projectId, { promise: pushPromise, resolve: resolvePush });
      this.pushInProgress.add(projectId);
      try {
        pushed = await this.pushMainSafe(projectId, repoPath);
        if (pushed) {
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

    // PRD §7.5.3: Auto-deploy on each task (merge to main)
    triggerDeployForEvent(projectId, "each_task").catch((err) => {
      log.warn("Auto-deploy on task completion failed", { projectId, err });
    });

    const epicId = extractEpicId(taskId);
    if (epicId) {
      const allIssues = await this.host.taskStore.listAll(projectId);
      const implTasks = allIssues.filter(
        (i) =>
          i.id.startsWith(epicId + ".") &&
          !i.id.endsWith(".0") &&
          (i.issue_type ?? i.type) !== "epic"
      );
      const allClosed =
        implTasks.length > 0 && implTasks.every((i) => (i.status as string) === "closed");
      if (allClosed) {
        const epicIssue = allIssues.find((i) => i.id === epicId);
        if (epicIssue && (epicIssue.status as string) !== "closed") {
          this.runFinalReviewAndCloseOrCreateTasks(projectId, repoPath, epicId).catch((err) =>
            log.warn("Final review flow failed", { projectId, epicId, err })
          );
        } else {
          triggerDeployForEvent(projectId, "each_epic").catch((err) => {
            log.warn("Auto-deploy on epic completion failed", { projectId, err });
          });
        }
      }
    }
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
      // No plan (deploy-fix epic) or agent failed — close epic and deploy
      await this.host.taskStore.close(projectId, epicId, "All tasks done");
      triggerDeployForEvent(projectId, "each_epic").catch((err) => {
        log.warn("Auto-deploy on epic completion failed", { projectId, err });
      });
      return;
    }

    if (result.status === "pass") {
      await this.host.taskStore.close(projectId, epicId, "All tasks done; final review passed");
      triggerDeployForEvent(projectId, "each_epic").catch((err) => {
        log.warn("Auto-deploy on epic completion failed", { projectId, err });
      });
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

  /**
   * Push main to origin. On rebase conflict: try merger agent once; if resolution fails, abort and retry on next completion.
   */
  private async pushMainSafe(projectId: string, repoPath: string): Promise<boolean> {
    await gitCommitQueue.drain();
    await this.host.taskStore.syncForPush(projectId);

    try {
      await this.host.branchManager.pushMain(repoPath);
      log.info("Push to origin succeeded", { projectId });
      eventLogService
        .append(repoPath, {
          timestamp: new Date().toISOString(),
          projectId,
          taskId: "",
          event: "push.succeeded",
        })
        .catch(() => {});
      return true;
    } catch (err) {
      if (err instanceof RebaseConflictError) {
        log.info("Push rebase conflict, invoking merger agent", {
          projectId,
          files: err.conflictedFiles,
        });
        const settings = await this.host.projectService.getSettings(projectId);
        const resolved = await this.host.runMergerAgentAndWait({
          projectId,
          cwd: repoPath,
          config: settings.simpleComplexityAgent as AgentConfig,
          phase: "push_rebase",
          taskId: "",
          branchName: "main",
          conflictedFiles: err.conflictedFiles,
          testCommand: resolveTestCommand(settings),
        });
        if (resolved) {
          try {
            await this.host.branchManager.rebaseContinue(repoPath);
            await this.host.branchManager.pushMainToOrigin(repoPath);
            log.info("Merger resolved push rebase conflicts, push succeeded", { projectId });
            eventLogService
              .append(repoPath, {
                timestamp: new Date().toISOString(),
                projectId,
                taskId: "",
                event: "push.succeeded",
              })
              .catch(() => {});
            return true;
          } catch (continueErr) {
            log.warn("rebase --continue or push failed after merger", {
              projectId,
              continueErr,
            });
            await this.host.branchManager.rebaseAbort(repoPath);
          }
        } else {
          log.warn("Merger agent failed to resolve push rebase conflicts", { projectId });
          await this.host.branchManager.rebaseAbort(repoPath);
        }
      } else {
        log.warn("Push failed, will retry on next task completion", { projectId, err });
      }
      eventLogService
        .append(repoPath, {
          timestamp: new Date().toISOString(),
          projectId,
          taskId: "",
          event: "push.failed",
          data: {
            reason: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
            conflictedFiles: err instanceof RebaseConflictError ? err.conflictedFiles : [],
            stage: err instanceof RebaseConflictError ? "push_rebase" : "push",
          },
        })
        .catch(() => {});
      return false;
    }
  }
}
