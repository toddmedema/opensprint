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

import type { TestResults } from "@opensprint/shared";
import { BACKOFF_FAILURE_THRESHOLD } from "@opensprint/shared";
import type { StoredTask } from "./task-store.service.js";
import { RebaseConflictError } from "./branch-manager.js";
import { gitCommitQueue } from "./git-commit-queue.service.js";
import { agentIdentityService } from "./agent-identity.service.js";
import { eventLogService } from "./event-log.service.js";
import { triggerDeployForEvent } from "./deploy-trigger.service.js";
import { finalReviewService } from "./final-review.service.js";
import { broadcastToProject } from "../websocket/index.js";
import type { TimerRegistry } from "./timer-registry.js";
import { createLogger } from "../utils/logger.js";

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

export interface MergeCoordinatorHost {
  getState(projectId: string): {
    slots: Map<string, MergeSlot>;
    status: { totalDone: number; queueDepth: number };
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
  };
  branchManager: {
    waitForGitReady(wtPath: string): Promise<void>;
    commitWip(wtPath: string, taskId: string): Promise<void>;
    removeTaskWorktree(repoPath: string, taskId: string): Promise<void>;
    deleteBranch(repoPath: string, branchName: string): Promise<void>;
    getChangedFiles(repoPath: string, branchName: string): Promise<string[]>;
    pushMain(repoPath: string): Promise<void>;
    pushMainToOrigin(repoPath: string): Promise<void>;
    isMergeInProgress(repoPath: string): Promise<boolean>;
    mergeAbort(repoPath: string): Promise<void>;
    mergeContinue(repoPath: string): Promise<void>;
    rebaseAbort(repoPath: string): Promise<void>;
    rebaseContinue(repoPath: string): Promise<void>;
    updateMainFromOrigin(repoPath: string): Promise<void>;
    rebaseOntoMain(wtPath: string): Promise<void>;
  };
  runMergerAgentAndWait(projectId: string, cwd: string): Promise<boolean>;
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
      gitWorkingMode?: "worktree" | "branches";
    }>;
  };
  transition(projectId: string, t: { to: "complete"; taskId: string }): void;
  persistCounters(projectId: string, repoPath: string): Promise<void>;
  nudge(projectId: string): void;
}

export class MergeCoordinatorService {
  /** Guard against concurrent pushes per project */
  private pushInProgress = new Set<string>();
  /** Promise per project that resolves when the current push completes */
  private pushCompletion = new Map<string, { promise: Promise<void>; resolve: () => void }>();

  constructor(private host: MergeCoordinatorHost) {}

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

    // 1. Prepare: transition slot, commit any WIP, wait for push
    this.host.transition(projectId, { to: "complete", taskId: task.id });
    await this.host.branchManager.waitForGitReady(wtPath);
    await this.host.branchManager.commitWip(wtPath, task.id);
    await this.waitForPushComplete(projectId);

    // 2. Sync main with origin and rebase task branch onto main so we never merge
    //    into stale main (which can overwrite recent work from other tasks).
    try {
      await this.host.branchManager.updateMainFromOrigin(repoPath);
      await this.host.branchManager.rebaseOntoMain(wtPath);
    } catch (rebaseErr) {
      const isRebaseConflict =
        rebaseErr instanceof RebaseConflictError ||
        (rebaseErr as Error)?.name === "RebaseConflictError";
      if (isRebaseConflict) {
        log.info("Rebase conflict detected, invoking merger agent", { taskId: task.id, branchName });
        const resolved = await this.host.runMergerAgentAndWait(projectId, wtPath);
        if (resolved) {
          try {
            await this.host.branchManager.rebaseContinue(wtPath);
            log.info("Merger resolved rebase conflicts, continuing", { taskId: task.id });
          } catch (continueErr) {
            log.warn("rebase --continue failed after merger", {
              taskId: task.id,
              continueErr,
            });
            try {
              await this.host.branchManager.rebaseAbort(wtPath);
            } catch {
              /* best-effort */
            }
            await this.requeueTaskAfterMergeFailure(
              projectId,
              repoPath,
              task,
              continueErr instanceof Error ? continueErr : new Error(String(continueErr))
            );
            return;
          }
        } else {
          log.warn("Merger agent failed to resolve rebase conflicts", { taskId: task.id });
          try {
            await this.host.branchManager.rebaseAbort(wtPath);
          } catch {
            /* best-effort */
          }
          await this.requeueTaskAfterMergeFailure(projectId, repoPath, task, rebaseErr as Error);
          return;
        }
      } else {
        log.warn("Rebase onto main failed before merge", {
          taskId: task.id,
          branchName,
          rebaseErr,
        });
        try {
          await this.host.branchManager.rebaseAbort(wtPath);
        } catch {
          /* best-effort */
        }
        await this.requeueTaskAfterMergeFailure(projectId, repoPath, task, rebaseErr as Error);
        return;
      }
    }

    // 3. Attempt merge (the only step that can conflict)
    try {
      await gitCommitQueue.drain();
      await gitCommitQueue.enqueueAndWait({
        type: "worktree_merge",
        repoPath,
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

    const settings = await this.host.projectService.getSettings(projectId);
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

    await this.host.persistCounters(projectId, repoPath);

    broadcastToProject(projectId, {
      type: "agent.completed",
      taskId: task.id,
      status: "approved",
      testResults: slot.phaseResult.testResults,
    });

    // 5. Cleanup worktree + branch
    log.info("Merge to main succeeded, cleaning up", { taskId: task.id, branchName });
    try {
      if (settings.gitWorkingMode !== "branches") {
        await this.host.branchManager.removeTaskWorktree(repoPath, task.id);
      }
      await this.host.branchManager.deleteBranch(repoPath, branchName);
    } catch (err) {
      log.warn("Worktree/branch cleanup failed (will be pruned by recovery)", {
        taskId: task.id,
        branchName,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    // 6. Async push + post-completion
    this.host.nudge(projectId);

    this.postCompletionAsync(projectId, repoPath, task.id).catch((err) => {
      log.warn("Post-completion async work failed", { taskId: task.id, err });
    });
  }

  /**
   * Handle merge failure: abort any in-progress merge, track attempts, requeue or block.
   * Branch is preserved so the next agent run can rebase and retry.
   */
  private async requeueTaskAfterMergeFailure(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    mergeErr: Error
  ): Promise<void> {
    if (await this.host.branchManager.isMergeInProgress(repoPath)) {
      await this.host.branchManager.mergeAbort(repoPath);
    }

    try {
      const freshIssue = await this.host.taskStore.show(projectId, task.id);
      const cumulativeAttempts = this.host.taskStore.getCumulativeAttemptsFromIssue(freshIssue) + 1;
      await this.host.taskStore.setCumulativeAttempts(projectId, task.id, cumulativeAttempts);

      const maxMergeFailures = BACKOFF_FAILURE_THRESHOLD * 2;
      if (cumulativeAttempts >= maxMergeFailures) {
        log.info(`Blocking ${task.id} after ${cumulativeAttempts} merge failures`);
        await this.host.taskStore.update(projectId, task.id, {
          status: "blocked",
          assignee: "",
          block_reason: "Merge Failure",
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
        broadcastToProject(projectId, {
          type: "task.updated",
          taskId: task.id,
          status: "blocked",
          assignee: null,
          blockReason: "Merge Failure",
        });
        return;
      }

      log.info("Reopening task after merge failure", { taskId: task.id, cumulativeAttempts });
      await this.host.taskStore.update(projectId, task.id, { status: "open", assignee: "" });
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
          data: { reason: mergeErr.message?.slice(0, 500) },
        })
        .catch(() => {});

      broadcastToProject(projectId, {
        type: "task.updated",
        taskId: task.id,
        status: "open",
        assignee: null,
      });

      this.host.nudge(projectId);
    } catch (err) {
      log.warn("Failed to requeue task after merge failure", { taskId: task.id, err });
    }
  }

  async postCompletionAsync(projectId: string, repoPath: string, taskId: string): Promise<void> {
    if (!this.pushInProgress.has(projectId)) {
      let resolvePush!: () => void;
      const pushPromise = new Promise<void>((r) => {
        resolvePush = r;
      });
      this.pushCompletion.set(projectId, { promise: pushPromise, resolve: resolvePush });
      this.pushInProgress.add(projectId);
      try {
        await this.pushMainSafe(projectId, repoPath);
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
          this.runFinalReviewAndCloseOrCreateTasks(projectId, repoPath, epicId).catch(
            (err) => log.warn("Final review flow failed", { projectId, epicId, err })
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
      broadcastToProject(projectId, {
        type: "task.updated",
        taskId: epicId,
        status: "closed",
        assignee: null,
      });
      triggerDeployForEvent(projectId, "each_epic").catch((err) => {
        log.warn("Auto-deploy on epic completion failed", { projectId, err });
      });
      return;
    }

    if (result.status === "pass") {
      await this.host.taskStore.close(projectId, epicId, "All tasks done; final review passed");
      broadcastToProject(projectId, {
        type: "task.updated",
        taskId: epicId,
        status: "closed",
        assignee: null,
      });
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
    for (const id of createdIds) {
      broadcastToProject(projectId, {
        type: "task.updated",
        taskId: id,
        status: "open",
        assignee: null,
      });
    }
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
  private async pushMainSafe(projectId: string, repoPath: string): Promise<void> {
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
    } catch (err) {
      if (err instanceof RebaseConflictError) {
        log.info("Push rebase conflict, invoking merger agent", {
          projectId,
          files: err.conflictedFiles,
        });
        const resolved = await this.host.runMergerAgentAndWait(projectId, repoPath);
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
    }
  }
}
