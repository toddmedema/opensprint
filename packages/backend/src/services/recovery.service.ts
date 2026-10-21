/**
 * RecoveryService — unified recovery across all mechanisms.
 *
 * Consolidates 5 overlapping recovery paths into a single service:
 *   1. GUPP crash recovery (assignment.json scan)
 *   2. Orphaned in_progress tasks
 *   3. Stale heartbeat detection
 *   4. Stale git lock removal
 *   5. Slot vs task store reconciliation
 *
 * Called once on startup by the orchestrator and periodically by the watchdog.
 */

import fs from "fs/promises";
import path from "path";
import { AGENT_SUSPEND_GRACE_MS, HEARTBEAT_STALE_MS, OPENSPRINT_PATHS } from "@opensprint/shared";
import type { StoredTask } from "./task-store.service.js";
import { taskStore as taskStoreSingleton } from "./task-store.service.js";
import { BranchManager } from "./branch-manager.js";
import { CrashRecoveryService } from "./crash-recovery.service.js";
import { ProjectService } from "./project.service.js";
import { heartbeatService } from "./heartbeat.service.js";
import { eventLogService } from "./event-log.service.js";
import { worktreeCleanupIntentService } from "./worktree-cleanup-intent.service.js";
import type { RetryContext } from "./orchestrator-phase-context.js";
import { isProcessAlive } from "../utils/process-group.js";
import { createLogger } from "../utils/logger.js";
import { fireAndForget } from "../utils/fire-and-forget.js";
import {
  evaluateWorktreeCleanupProtection,
  getWorktreeCleanupAssignmentGuardMs,
  listAssignmentSummariesInWorktree,
  logWorktreeCleanupBlocked,
} from "../utils/worktree-health.js";
import { buildFailureBaselineSnapshot } from "./orchestrator-failure-metrics.service.js";
import { worktreeLeaseService } from "./worktree-lease.service.js";

const log = createLogger("recovery");

const GIT_LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes
const STALE_INACTIVE_WORKTREE_MS = (() => {
  const rawValue = process.env.OPENSPRINT_STALE_INACTIVE_WORKTREE_MS;
  if (rawValue == null || rawValue.trim() === "") return 24 * 60 * 60 * 1000;
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 24 * 60 * 60 * 1000;
})();
const SLOT_RECOVERY_GRACE_MS = (() => {
  const rawValue = process.env.OPENSPRINT_SLOT_RECOVERY_GRACE_MS;
  if (rawValue == null || rawValue.trim() === "") return 30_000;
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30_000;
})();
const HEARTBEAT_WITHOUT_PID_MAX_AGE_MS = (() => {
  const rawValue = process.env.OPENSPRINT_HEARTBEAT_WITHOUT_PID_MAX_AGE_MS;
  if (rawValue == null || rawValue.trim() === "") return 15 * 60 * 1000;
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 15 * 60 * 1000;
})();
const RECOVERABLE_HEARTBEAT_GAP_MAX_MS = (() => {
  const rawValue = process.env.OPENSPRINT_RECOVERABLE_HEARTBEAT_GAP_MAX_MS;
  if (rawValue == null || rawValue.trim() === "") return 15 * 60 * 1000;
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 15 * 60 * 1000;
})();
/** Min age before recovery may apply a persisted merge-success cleanup intent (avoids TOCTOU with slot finalization). */
const CLEANUP_INTENT_REPLAY_MIN_AGE_MS = (() => {
  const rawValue = process.env.OPENSPRINT_CLEANUP_INTENT_REPLAY_MIN_AGE_MS;
  if (rawValue == null || rawValue.trim() === "") return 3_000;
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3_000;
})();

export interface RecoveryResult {
  reattached: string[];
  requeued: string[];
  cleaned: string[];
}

export interface RecoveryHost {
  getSlottedTaskIds(projectId: string): string[];
  getActiveAgentIds(projectId: string): string[];
  /** Worktree keys held by active slots (task.id or epic_<epicId>). */
  getSlottedWorktreeKeys?(projectId: string): string[];
  /** Worktree paths held by active slots. */
  getSlottedWorktreePaths?(projectId: string): string[];
  /** Called to reattach a slot for a still-running agent (GUPP recovery) */
  reattachSlot?(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    assignment: GuppAssignment
  ): Promise<boolean>;
  /** Called to resume a review-phase task after restart, rebuilding review/test coordination safely. */
  resumeReviewPhase?(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    assignment: GuppAssignment,
    options: { pidAlive: boolean }
  ): Promise<boolean>;
  /** Called when a stale heartbeat still has a live process-group leader and an assignment to reattach from. */
  handleRecoverableHeartbeatGap?(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    assignment: GuppAssignment
  ): Promise<boolean>;
  /** Called when an orphaned assignment already has a terminal result.json and should be completed instead of requeued. */
  handleCompletedAssignment?(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    assignment: GuppAssignment
  ): Promise<boolean>;
  /** Called to remove a slot whose task no longer exists in task store */
  removeStaleSlot?(projectId: string, taskId: string, repoPath: string): Promise<void>;
}

export interface GuppAssignment {
  taskId: string;
  projectId: string;
  phase: "coding" | "review";
  branchName: string;
  /** Worktree key (task.id or epic_<epicId>). When present, recovery uses it for slot. */
  worktreeKey?: string;
  worktreePath: string;
  promptPath: string;
  agentConfig: unknown;
  attempt: number;
  retryContext?: RetryContext;
  createdAt: string;
  replayMetadata?: {
    baseCommitSha: string;
    behaviorVersionId?: string;
    templateVersionId?: string;
  };
}

export class RecoveryService {
  private taskStore = taskStoreSingleton;
  private branchManager = new BranchManager();
  private crashRecovery = new CrashRecoveryService();
  private projectService = new ProjectService();

  /**
   * Run full recovery pass. Safe to call multiple times (idempotent).
   * Startup mode includes GUPP (assignment reattachment); periodic mode skips it.
   */
  async runFullRecovery(
    projectId: string,
    repoPath: string,
    host: RecoveryHost,
    opts: { includeGupp?: boolean } = {}
  ): Promise<RecoveryResult> {
    const result: RecoveryResult = { reattached: [], requeued: [], cleaned: [] };

    // Build exclude sets FIRST so every recovery phase (including GUPP) respects active slots.
    // This prevents assignment cleanup from removing worktrees belonging to in-flight agents.
    const excludeIds = new Set([
      ...host.getSlottedTaskIds(projectId),
      ...host.getActiveAgentIds(projectId),
    ]);
    const excludeWorktreeKeys = new Set([
      ...excludeIds,
      ...(host.getSlottedWorktreeKeys?.(projectId) ?? []),
    ]);
    const excludeWorktreePaths = new Set(
      (host.getSlottedWorktreePaths?.(projectId) ?? []).map((p) => path.resolve(p))
    );

    // 1. GUPP crash recovery (startup only) — now receives exclude sets
    if (
      opts.includeGupp &&
      (host.reattachSlot || host.resumeReviewPhase || host.handleCompletedAssignment)
    ) {
      const guppResult = await this.recoverFromAssignments(
        projectId,
        repoPath,
        host,
        excludeIds,
        excludeWorktreeKeys,
        excludeWorktreePaths
      );
      result.reattached.push(...guppResult.reattached);
      result.requeued.push(...guppResult.requeued);
      guppResult.reattached.forEach((id) => excludeIds.add(id));
      guppResult.requeued.forEach((id) => excludeIds.add(id));
      guppResult.reattached.forEach((id) => excludeWorktreeKeys.add(id));
      guppResult.requeued.forEach((id) => excludeWorktreeKeys.add(id));
      guppResult.worktreeKeys.forEach((k) => excludeWorktreeKeys.add(k));
      guppResult.worktreePaths.forEach((p) => excludeWorktreePaths.add(p));
    }

    // Recent assignments protect destructive cleanup, but must not hide orphaned
    // runs from the safe startup reattachment and terminal-result inspection above.
    await this.augmentExclusionsFromRecentAssignments(
      projectId,
      repoPath,
      excludeIds,
      excludeWorktreeKeys,
      excludeWorktreePaths
    );

    // 2. Stale heartbeat recovery
    const staleResult = await this.recoverFromStaleHeartbeats(
      projectId,
      repoPath,
      excludeIds,
      host,
      excludeWorktreeKeys,
      excludeWorktreePaths
    );
    result.reattached.push(...staleResult.reattached);
    result.requeued.push(...staleResult.requeued);

    staleResult.reattached.forEach((taskId) => excludeIds.add(taskId));
    staleResult.requeued.forEach((taskId) => excludeIds.add(taskId));
    staleResult.reattached.forEach((taskId) => excludeWorktreeKeys.add(taskId));
    staleResult.requeued.forEach((taskId) => excludeWorktreeKeys.add(taskId));

    // 3. Orphaned in_progress tasks
    const orphanResult = await this.recoverOrphanedTasks(projectId, repoPath, excludeIds, host);
    result.requeued.push(...orphanResult);
    orphanResult.forEach((taskId) => excludeIds.add(taskId));
    orphanResult.forEach((taskId) => excludeWorktreeKeys.add(taskId));

    // 4. Stranded merge retries: in_progress but no assignee, slot, or active agent.
    const assigneeLessResult = await this.recoverAssigneeLessInProgressTasks(
      projectId,
      repoPath,
      excludeIds,
      host
    );
    result.requeued.push(...assigneeLessResult);
    assigneeLessResult.forEach((taskId) => excludeIds.add(taskId));
    assigneeLessResult.forEach((taskId) => excludeWorktreeKeys.add(taskId));

    // 5. Stale git lock removal
    const lockCleaned = await this.cleanStaleGitLocks(projectId, repoPath);
    if (lockCleaned) result.cleaned.push(".git/index.lock");

    // 6. Reconcile slots vs task store
    if (host.removeStaleSlot) {
      const reconciled = await this.reconcileSlots(projectId, repoPath, host);
      result.cleaned.push(...reconciled);
    }

    // 7. Replay persisted merge cleanup intents (restart-safe deferred cleanup)
    const replayed = await this.replayPendingCleanupIntents(
      projectId,
      repoPath,
      excludeWorktreeKeys,
      excludeWorktreePaths
    );
    if (replayed.length > 0) {
      result.cleaned.push(...replayed.map((id) => `cleanup_intent:${id}`));
    }

    // 8. Prune orphan worktrees (closed/missing tasks), excluding active slot keys/paths
    const pruned = await this.pruneOrphanWorktrees(
      projectId,
      repoPath,
      excludeIds,
      excludeWorktreeKeys,
      excludeWorktreePaths
    );
    if (pruned.length > 0) {
      result.cleaned.push(...pruned.map((id) => `worktree:${id}`));
      log.info("Pruned orphan worktrees", { projectId, pruned });
    }

    // 9. Cleanup stale inactive open/blocked worktrees (TTL-based safety net)
    const staleInactive = await this.cleanupStaleInactiveWorktrees(
      projectId,
      repoPath,
      excludeIds,
      excludeWorktreeKeys,
      excludeWorktreePaths
    );
    if (staleInactive.length > 0) {
      result.cleaned.push(...staleInactive.map((id) => `stale_inactive_worktree:${id}`));
    }

    // 10. Emit failure-type baseline snapshot for KPI tracking
    fireAndForget(
      this.emitFailureBaselineSnapshot(projectId, repoPath),
      "recovery:failure-baseline-snapshot"
    );

    return result;
  }

  private async emitFailureBaselineSnapshot(projectId: string, repoPath: string): Promise<void> {
    try {
      const windowMs = 60 * 60 * 1000;
      const sinceIso = new Date(Date.now() - windowMs).toISOString();
      const events = await eventLogService.readSinceByProjectId(projectId, sinceIso);
      const distribution = buildFailureBaselineSnapshot(events, windowMs);
      const total = Object.values(distribution).reduce((s, n) => s + n, 0);
      if (total === 0) return;
      await eventLogService.append(repoPath, {
        timestamp: new Date().toISOString(),
        projectId,
        taskId: "_system",
        event: "metrics.failure_baseline_snapshot",
        data: { windowMs, distribution, totalFailures: total },
      });
    } catch (err) {
      log.debug("Failed to emit failure baseline snapshot", { err });
    }
  }

  // ─── GUPP: scan assignment.json files ───

  private async recoverFromAssignments(
    projectId: string,
    repoPath: string,
    host: RecoveryHost,
    excludeIds: Set<string>,
    excludeWorktreeKeys: Set<string>,
    excludeWorktreePaths: Set<string>
  ): Promise<{
    reattached: string[];
    requeued: string[];
    /** Worktree keys (taskId or epic_*) touched by reattached/requeued assignments. */
    worktreeKeys: string[];
    /** Resolved absolute worktree paths touched by reattached/requeued assignments. */
    worktreePaths: string[];
  }> {
    const durableBase = this.branchManager.getWorktreeBasePath(repoPath);
    const legacyBase = this.branchManager.getLegacyWorktreeBasePath();
    const fromDurable = await this.crashRecovery.findOrphanedAssignmentsFromWorktrees(durableBase);
    const fromLegacy = await this.crashRecovery.findOrphanedAssignmentsFromWorktrees(legacyBase);
    const fromMainRepo = await this.crashRecovery.findOrphanedAssignments(repoPath);
    const byTaskId = new Map<string, { taskId: string; assignment: GuppAssignment }>();
    for (const o of fromMainRepo)
      byTaskId.set(o.taskId, o as { taskId: string; assignment: GuppAssignment });
    for (const o of fromLegacy)
      byTaskId.set(o.taskId, o as { taskId: string; assignment: GuppAssignment });
    for (const o of fromDurable)
      byTaskId.set(o.taskId, o as { taskId: string; assignment: GuppAssignment });
    const orphaned = [...byTaskId.values()];

    if (orphaned.length === 0)
      return { reattached: [], requeued: [], worktreeKeys: [], worktreePaths: [] };

    const allIssues = await this.taskStore.listAll(projectId);
    const idToIssue = new Map(allIssues.map((i) => [i.id, i]));
    const reattached: string[] = [];
    const requeued: string[] = [];
    const recoveredWorktreeKeys: string[] = [];
    const recoveredWorktreePaths: string[] = [];

    for (const { taskId, assignment } of orphaned) {
      if (assignment.projectId !== projectId) continue;
      const assignmentAgeMs = Date.now() - new Date(assignment.createdAt).getTime();
      const worktreeKey = this.resolveCleanupWorktreeKey(
        taskId,
        assignment.worktreeKey,
        assignment.worktreePath
      );
      const resolvedWtPath = assignment.worktreePath ? path.resolve(assignment.worktreePath) : null;
      const protectedByAge =
        !Number.isFinite(assignmentAgeMs) ||
        assignmentAgeMs < getWorktreeCleanupAssignmentGuardMs();
      const protectAssignment = () => {
        excludeIds.add(taskId);
        excludeWorktreeKeys.add(worktreeKey);
        if (resolvedWtPath) excludeWorktreePaths.add(resolvedWtPath);
      };

      // Skip destructive cleanup for tasks/worktrees that belong to active slots
      if (
        excludeIds.has(taskId) ||
        excludeWorktreeKeys.has(worktreeKey) ||
        (resolvedWtPath && excludeWorktreePaths.has(resolvedWtPath))
      ) {
        log.info("Recovery: skipping assignment cleanup for active slot", {
          projectId,
          taskId,
          worktreeKey,
          worktreePath: assignment.worktreePath,
        });
        continue;
      }

      const task = idToIssue.get(taskId);
      if (!task) {
        if (protectedByAge) {
          protectAssignment();
          continue;
        }
        this.emitStaleAssignmentTelemetry(
          repoPath,
          projectId,
          taskId,
          assignmentAgeMs,
          "task_not_found",
          assignment
        );
        log.warn("Recovery: task not found, cleaning up assignment", { projectId, taskId });
        const removed = await this.removeWorktreeIfNeeded(
          projectId,
          repoPath,
          taskId,
          assignment.worktreePath,
          assignment.worktreeKey
        );
        if (removed) await this.deleteAssignment(repoPath, taskId, assignment.worktreePath);
        continue;
      }

      if ((task.status as string) !== "in_progress") {
        if (protectedByAge) {
          protectAssignment();
          continue;
        }
        this.emitStaleAssignmentTelemetry(
          repoPath,
          projectId,
          taskId,
          assignmentAgeMs,
          "status_mismatch",
          assignment
        );
        log.info("Recovery: task no longer in_progress, removing stale assignment", {
          projectId,
          taskId,
          status: task.status,
        });
        const removed = await this.removeWorktreeIfNeeded(
          projectId,
          repoPath,
          taskId,
          assignment.worktreePath,
          assignment.worktreeKey
        );
        if (removed) await this.deleteAssignment(repoPath, taskId, assignment.worktreePath);
        continue;
      }

      const wtPath = assignment.worktreePath;
      const heartbeat = wtPath ? await heartbeatService.readHeartbeat(wtPath, taskId) : null;
      const pidAlive =
        heartbeat != null &&
        typeof heartbeat.processGroupLeaderPid === "number" &&
        heartbeat.processGroupLeaderPid > 0 &&
        isProcessAlive(heartbeat.processGroupLeaderPid);

      const trackReattach = () => {
        reattached.push(taskId);
        recoveredWorktreeKeys.push(worktreeKey);
        if (resolvedWtPath) recoveredWorktreePaths.push(resolvedWtPath);
      };

      const trackRequeue = () => {
        requeued.push(taskId);
        recoveredWorktreeKeys.push(worktreeKey);
        if (resolvedWtPath) recoveredWorktreePaths.push(resolvedWtPath);
      };

      if (!pidAlive && host.handleCompletedAssignment) {
        const terminalResult = await this.readTerminalAssignmentResult(assignment);
        if (terminalResult) {
          this.emitStaleAssignmentTelemetry(
            repoPath,
            projectId,
            taskId,
            assignmentAgeMs,
            "stale_success",
            assignment
          );
          const completed = await host.handleCompletedAssignment(
            projectId,
            repoPath,
            task,
            assignment
          );
          if (completed) {
            trackReattach();
            continue;
          }
        }
      }

      if (pidAlive && assignment.phase === "coding" && host.reattachSlot) {
        const attached = await host.reattachSlot(projectId, repoPath, task, assignment);
        if (attached) {
          trackReattach();
          continue;
        }
      }

      if (assignment.phase === "review" && host.resumeReviewPhase) {
        const resumed = await host.resumeReviewPhase(projectId, repoPath, task, assignment, {
          pidAlive,
        });
        if (resumed) {
          trackReattach();
          continue;
        }
      }

      // Final check: re-read result.json in case the agent wrote it between our
      // first read and now (closes the TOCTOU race with agent file writes).
      if (!pidAlive && host.handleCompletedAssignment) {
        const lateResult = await this.readTerminalAssignmentResult(assignment);
        if (lateResult) {
          this.emitStaleAssignmentTelemetry(
            repoPath,
            projectId,
            taskId,
            assignmentAgeMs,
            "stale_success",
            assignment
          );
          log.info("Recovery: late terminal result found before requeue, completing instead", {
            projectId,
            taskId,
            status: lateResult,
          });
          const completed = await host.handleCompletedAssignment(
            projectId,
            repoPath,
            task,
            assignment
          );
          if (completed) {
            trackReattach();
            continue;
          }
        }
      }

      if (pidAlive || protectedByAge) {
        // Liveness alone does not establish process ownership. A reused PID or
        // temporarily unavailable recovery host must never trigger an orphan kill
        // or a second execution of the same assignment.
        protectAssignment();
        log.warn("Recovery: assignment ownership remains uncertain; preserving run", {
          projectId,
          taskId,
          pidAlive,
          protectedByAge,
        });
        continue;
      }

      this.emitStaleAssignmentTelemetry(
        repoPath,
        projectId,
        taskId,
        assignmentAgeMs,
        "pid_dead_requeue",
        assignment
      );
      log.info("Recovery: PID dead or missing, requeuing task", { projectId, taskId });
      try {
        await this.taskStore.update(projectId, taskId, { status: "open", assignee: "" });
        await this.taskStore.setMergeStage(projectId, taskId, null);
        await this.taskStore.comment(
          projectId,
          taskId,
          "Agent crashed (backend restart). Task requeued for next attempt."
        );
      } catch (err) {
        log.warn("Recovery: failed to requeue task", { projectId, taskId, err });
        protectAssignment();
        continue;
      }
      const removed = await this.removeWorktreeIfNeeded(
        projectId,
        repoPath,
        taskId,
        assignment.worktreePath,
        assignment.worktreeKey
      );
      if (removed) await this.deleteAssignment(repoPath, taskId, assignment.worktreePath);
      trackRequeue();
    }

    return {
      reattached,
      requeued,
      worktreeKeys: recoveredWorktreeKeys,
      worktreePaths: recoveredWorktreePaths,
    };
  }

  // ─── Stale heartbeat recovery ───

  private async recoverFromStaleHeartbeats(
    projectId: string,
    repoPath: string,
    excludeIds: Set<string>,
    host: RecoveryHost,
    excludeWorktreeKeys: Set<string>,
    excludeWorktreePaths: Set<string>
  ): Promise<{ reattached: string[]; requeued: string[] }> {
    const durableBase = this.branchManager.getWorktreeBasePath(repoPath);
    const legacyBase = this.branchManager.getLegacyWorktreeBasePath();
    const staleDurable = await heartbeatService.findStaleHeartbeats(durableBase);
    const staleLegacy = await heartbeatService.findStaleHeartbeats(legacyBase);
    const staleMap = new Map(staleLegacy.map((s) => [s.taskId, s]));
    for (const s of staleDurable) staleMap.set(s.taskId, s);
    const stale = [...staleMap.values()];
    const reattached: string[] = [];
    const requeued: string[] = [];

    for (const { taskId, heartbeat } of stale) {
      if (excludeIds.has(taskId)) continue;
      const staleSec = Math.round((Date.now() - heartbeat.lastOutputTimestamp) / 1000);
      log.warn("Stale heartbeat detected", {
        projectId,
        taskId,
        staleSec,
        threshold: HEARTBEAT_STALE_MS / 1000,
      });

      eventLogService
        .append(repoPath, {
          timestamp: new Date().toISOString(),
          projectId,
          taskId,
          event: "recovery.stale_heartbeat",
          data: { staleSec, threshold: HEARTBEAT_STALE_MS / 1000 },
        })
        .catch((err) => log.debug("Best-effort event log append failed", { taskId, err }));

      let assignment: GuppAssignment | null = null;
      const preserveTask = () => {
        excludeIds.add(taskId);
        excludeWorktreeKeys.add(
          this.resolveCleanupWorktreeKey(taskId, assignment?.worktreeKey, assignment?.worktreePath)
        );
        if (assignment?.worktreePath)
          excludeWorktreePaths.add(path.resolve(assignment.worktreePath));
      };
      try {
        const task = await this.taskStore.show(projectId, taskId);
        if (task.status === "in_progress") {
          const staleForMs = Math.max(0, Date.now() - heartbeat.lastOutputTimestamp);
          const pidAlive =
            typeof heartbeat.processGroupLeaderPid === "number" &&
            heartbeat.processGroupLeaderPid > 0 &&
            isProcessAlive(heartbeat.processGroupLeaderPid);
          const exceededSuspendGrace =
            Date.now() - heartbeat.lastOutputTimestamp > AGENT_SUSPEND_GRACE_MS;
          assignment = await this.readAssignment(repoPath, taskId);
          if (assignment && assignment.projectId !== projectId) {
            preserveTask();
            continue;
          }

          if (!pidAlive && assignment && host.handleCompletedAssignment) {
            const terminalResult = await this.readTerminalAssignmentResult(assignment);
            if (terminalResult) {
              const completed = await host.handleCompletedAssignment(
                projectId,
                repoPath,
                task,
                assignment
              );
              if (completed) {
                reattached.push(taskId);
                continue;
              }
            }
          }

          if (pidAlive && assignment && host.handleRecoverableHeartbeatGap) {
            const handled = await host.handleRecoverableHeartbeatGap(
              projectId,
              repoPath,
              task,
              assignment
            );
            if (handled) {
              reattached.push(taskId);
              continue;
            }
          }

          if (pidAlive) {
            log.warn("Recovery: live process ownership uncertain; preserving task", {
              taskId,
              processGroupLeaderPid: heartbeat.processGroupLeaderPid,
              exceededSuspendGrace,
              staleForMs,
              maxRecoverableGapMs: RECOVERABLE_HEARTBEAT_GAP_MAX_MS,
              hasAssignment: Boolean(assignment),
            });
            preserveTask();
            continue;
          }

          // Final re-read: the agent may have flushed result.json between the
          // first check and process termination.
          if (!pidAlive && assignment && host.handleCompletedAssignment) {
            const lateResult = await this.readTerminalAssignmentResult(assignment);
            if (lateResult) {
              log.info("Recovery: late terminal result found before heartbeat requeue", {
                projectId,
                taskId,
                status: lateResult,
              });
              const completed = await host.handleCompletedAssignment(
                projectId,
                repoPath,
                task,
                assignment
              );
              if (completed) {
                reattached.push(taskId);
                continue;
              }
            }
          }

          await this.recoverTask(projectId, repoPath, task);
          requeued.push(taskId);
        }
      } catch (err) {
        // A database, filesystem, or host callback failure does not establish that
        // the task is absent. Defer deletion to guarded orphan-worktree cleanup.
        preserveTask();
        log.warn("Recovery: heartbeat inspection failed; preserving worktree", {
          projectId,
          taskId,
          err,
        });
      }
    }

    return { reattached, requeued };
  }

  // ─── Orphaned in_progress tasks ───

  /**
   * Reset in-progress tasks assigned to an agent when no process exists for that assignee.
   * "Process exists" is determined by excludeIds: task IDs in a slot (getSlottedTaskIds) or
   * in active agent registry (getActiveAgentIds). Human-assigned tasks are never included
   * (listInProgressWithAgentAssignee returns only agent assignees).
   */
  private async recoverOrphanedTasks(
    projectId: string,
    repoPath: string,
    excludeIds: Set<string>,
    host?: RecoveryHost
  ): Promise<string[]> {
    const orphans = await this.taskStore.listInProgressWithAgentAssignee(projectId);
    const cutoffMs = Date.now() - SLOT_RECOVERY_GRACE_MS;
    const toRecover = orphans.filter((task) => {
      if (excludeIds.has(task.id)) return false;
      const updatedAtMs = Date.parse(task.updated_at ?? "");
      if (!Number.isFinite(updatedAtMs)) return true;
      return updatedAtMs <= cutoffMs;
    });
    const recovered: string[] = [];

    for (const task of toRecover) {
      try {
        if (
          await this.hasFreshRecoveryHeartbeatGuard(
            repoPath,
            task.id,
            task.updated_at ?? null,
            undefined
          )
        ) {
          continue;
        }
        // Check for a terminal result.json before blindly requeueing
        if (host?.handleCompletedAssignment) {
          const assignment = await this.readAssignment(repoPath, task.id);
          if (assignment) {
            const terminalResult = await this.readTerminalAssignmentResult(assignment);
            if (terminalResult) {
              log.info(
                "Recovery: orphaned task has terminal result; completing instead of requeue",
                {
                  projectId,
                  taskId: task.id,
                  status: terminalResult,
                }
              );
              const completed = await host.handleCompletedAssignment(
                projectId,
                repoPath,
                task,
                assignment
              );
              if (completed) {
                fireAndForget(
                  eventLogService.append(repoPath, {
                    timestamp: new Date().toISOString(),
                    projectId,
                    taskId: task.id,
                    event: "recovery.stale_success_consumed",
                    data: { source: "orphaned_task", status: terminalResult },
                  }),
                  "recovery:orphaned-task-event-log"
                );
                recovered.push(task.id);
                continue;
              }
            }
          }
        }
        await this.recoverTask(projectId, repoPath, task);
        recovered.push(task.id);
        eventLogService
          .append(repoPath, {
            timestamp: new Date().toISOString(),
            projectId,
            taskId: task.id,
            event: "recovery.agent_assignee_no_process_reset",
            data: { assignee: task.assignee ?? null, reason: "no process for agent assignee" },
          })
          .catch((err) =>
            log.debug("Best-effort event log append failed", { taskId: task.id, err })
          );
        await this.taskStore
          .comment(
            projectId,
            task.id,
            "Watchdog: no running process for agent assignee. Task requeued for next attempt."
          )
          .catch((err) =>
            log.warn("Failed to comment on recovered task", { taskId: task.id, err })
          );
      } catch (err) {
        log.warn("Failed to recover task", { taskId: task.id, err: (err as Error).message });
      }
    }

    if (recovered.length > 0) {
      log.warn("Recovered orphaned tasks", { projectId, count: recovered.length, recovered });
    }
    return recovered;
  }

  private async recoverAssigneeLessInProgressTasks(
    projectId: string,
    repoPath: string,
    excludeIds: Set<string>,
    host?: RecoveryHost
  ): Promise<string[]> {
    const stranded = await this.taskStore.listInProgressWithoutAssignee(projectId);
    const cutoffMs = Date.now() - HEARTBEAT_STALE_MS;
    const toRecover = stranded.filter((task) => {
      if (excludeIds.has(task.id)) return false;
      const updatedAtMs = Date.parse(task.updated_at ?? "");
      return Number.isFinite(updatedAtMs) && updatedAtMs <= cutoffMs;
    });
    const recovered: string[] = [];

    for (const task of toRecover) {
      try {
        if (
          await this.hasFreshRecoveryHeartbeatGuard(
            repoPath,
            task.id,
            task.updated_at ?? null,
            undefined
          )
        ) {
          continue;
        }
        // Check for a terminal result.json before blindly requeueing
        if (host?.handleCompletedAssignment) {
          const assignment = await this.readAssignment(repoPath, task.id);
          if (assignment) {
            const terminalResult = await this.readTerminalAssignmentResult(assignment);
            if (terminalResult) {
              log.info(
                "Recovery: assignee-less task has terminal result; completing instead of requeue",
                {
                  projectId,
                  taskId: task.id,
                  status: terminalResult,
                }
              );
              const completed = await host.handleCompletedAssignment(
                projectId,
                repoPath,
                task,
                assignment
              );
              if (completed) {
                fireAndForget(
                  eventLogService.append(repoPath, {
                    timestamp: new Date().toISOString(),
                    projectId,
                    taskId: task.id,
                    event: "recovery.stale_success_consumed",
                    data: { source: "assignee_less_task", status: terminalResult },
                  }),
                  "recovery:assignee-less-task-event-log"
                );
                recovered.push(task.id);
                continue;
              }
            }
          }
        }
        await this.recoverTask(projectId, repoPath, task);
        recovered.push(task.id);
        eventLogService
          .append(repoPath, {
            timestamp: new Date().toISOString(),
            projectId,
            taskId: task.id,
            event: "recovery.in_progress_without_assignee_reset",
            data: {
              reason: "in_progress task had no assignee, slot, or active agent",
              updatedAt: task.updated_at ?? null,
            },
          })
          .catch((err) =>
            log.debug("Best-effort event log append failed", { taskId: task.id, err })
          );
        await this.taskStore
          .comment(
            projectId,
            task.id,
            "Watchdog: in-progress task had no assignee or active slot. Task requeued for next attempt."
          )
          .catch((err) =>
            log.warn("Failed to comment on recovered assignee-less task", {
              taskId: task.id,
              err,
            })
          );
      } catch (err) {
        log.warn("Failed to recover assignee-less in-progress task", {
          taskId: task.id,
          err: (err as Error).message,
        });
      }
    }

    if (recovered.length > 0) {
      log.warn("Recovered assignee-less in-progress tasks", {
        projectId,
        count: recovered.length,
        recovered,
      });
    }
    return recovered;
  }

  // ─── Stale git lock removal ───

  private async cleanStaleGitLocks(projectId: string, repoPath: string): Promise<boolean> {
    const lockPath = path.join(repoPath, ".git", "index.lock");
    try {
      const stat = await fs.stat(lockPath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > GIT_LOCK_STALE_MS) {
        log.warn("Removing stale .git/index.lock", {
          projectId,
          repoPath,
          ageSec: Math.round(ageMs / 1000),
        });
        await fs.unlink(lockPath);
        eventLogService
          .append(repoPath, {
            timestamp: new Date().toISOString(),
            projectId,
            taskId: "",
            event: "recovery.stale_lock_removed",
            data: { ageMs },
          })
          .catch((err) => log.debug("Best-effort event log append failed", { err }));
        return true;
      }
    } catch {
      // No lock file — healthy
    }
    return false;
  }

  // ─── Slot reconciliation ───

  private async reconcileSlots(
    projectId: string,
    repoPath: string,
    host: RecoveryHost
  ): Promise<string[]> {
    const slottedIds = host.getSlottedTaskIds(projectId);
    const activeAgentIds = new Set(host.getActiveAgentIds(projectId));
    if (slottedIds.length === 0) return [];

    const allIssues = await this.taskStore.listAll(projectId);
    const idToIssue = new Map(allIssues.map((i) => [i.id, i]));
    const validIds = new Set(idToIssue.keys());

    // Do not remove slots when listAll returned no tasks; avoid killing agents on empty list.
    if (validIds.size === 0) {
      log.warn("Skipping slot reconciliation: listAll returned 0 tasks but we have slots", {
        projectId,
        slottedCount: slottedIds.length,
        slottedTaskIds: slottedIds,
      });
      return [];
    }

    const stale: string[] = [];

    for (const taskId of slottedIds) {
      if (activeAgentIds.has(taskId)) {
        // The orchestrator still has an active agent registered for this task.
        // Heartbeat files can lag behind process start, so avoid premature slot eviction.
        log.info("Skipping slot recovery due to guard", {
          projectId,
          taskId,
          guard: "active_agent",
        });
        continue;
      }

      if (!validIds.has(taskId)) {
        log.warn("Removing stale slot: task no longer in task store", { projectId, taskId });
        await host.removeStaleSlot!(projectId, taskId, repoPath);
        stale.push(taskId);
        continue;
      }

      const task = idToIssue.get(taskId);
      if (!task) continue;

      const assignment = await this.readAssignment(repoPath, taskId);
      if (!assignment) continue;

      const assignmentAgeMs = Date.now() - new Date(assignment.createdAt).getTime();
      if (Number.isFinite(assignmentAgeMs) && assignmentAgeMs >= 0) {
        if (assignmentAgeMs < SLOT_RECOVERY_GRACE_MS) {
          log.info("Skipping slot recovery due to guard", {
            projectId,
            taskId,
            guard: "grace_window",
            assignmentAgeMs,
            graceMs: SLOT_RECOVERY_GRACE_MS,
          });
          continue;
        }
      }

      const heartbeat = assignment.worktreePath
        ? await heartbeatService.readHeartbeat(assignment.worktreePath, taskId)
        : null;
      const assignmentAgeMsSafe =
        Number.isFinite(assignmentAgeMs) && assignmentAgeMs >= 0 ? assignmentAgeMs : null;
      const pidAlive =
        heartbeat != null &&
        typeof heartbeat.processGroupLeaderPid === "number" &&
        heartbeat.processGroupLeaderPid > 0 &&
        isProcessAlive(heartbeat.processGroupLeaderPid);
      const heartbeatHasRecentOutput =
        heartbeat != null &&
        Number.isFinite(heartbeat.lastOutputTimestamp) &&
        Date.now() - heartbeat.lastOutputTimestamp <= HEARTBEAT_STALE_MS;
      const heartbeatIsFresh =
        heartbeat != null &&
        Number.isFinite(heartbeat.heartbeatTimestamp) &&
        Date.now() - heartbeat.heartbeatTimestamp <= HEARTBEAT_STALE_MS;

      // Some agent backends do not expose a stable local process-group PID and report 0/undefined.
      // If heartbeat output is still fresh (or heartbeat itself is fresh), treat the slot as active
      // and avoid watchdog reset loops for long-running/silent turns.
      const withinNoPidGuardAge =
        assignmentAgeMsSafe == null || assignmentAgeMsSafe <= HEARTBEAT_WITHOUT_PID_MAX_AGE_MS;
      if (!pidAlive && (heartbeatHasRecentOutput || heartbeatIsFresh) && withinNoPidGuardAge) {
        log.info("Skipping slot recovery due to guard", {
          projectId,
          taskId,
          guard: heartbeatHasRecentOutput
            ? "recent_output_without_pid"
            : "fresh_heartbeat_without_pid",
          assignmentAgeMs: assignmentAgeMsSafe,
          maxGuardAgeMs: HEARTBEAT_WITHOUT_PID_MAX_AGE_MS,
        });
        continue;
      }

      if (!pidAlive && host.handleCompletedAssignment) {
        const terminalResult = await this.readTerminalAssignmentResult(assignment);
        if (terminalResult) {
          log.warn("Completing slotted task from terminal result", {
            projectId,
            taskId,
            phase: assignment.phase,
            attempt: assignment.attempt,
            status: terminalResult,
          });
          const completed = await host.handleCompletedAssignment(
            projectId,
            repoPath,
            task,
            assignment
          );
          if (completed) {
            stale.push(taskId);
            continue;
          }
        }
      }

      if (!pidAlive) {
        // Final re-read before committing to recovery: close the TOCTOU window
        // where the agent writes result.json between the first check and now.
        if (host.handleCompletedAssignment) {
          const lateResult = await this.readTerminalAssignmentResult(assignment);
          if (lateResult) {
            log.info("Recovery: late terminal result found before slot requeue", {
              projectId,
              taskId,
              status: lateResult,
            });
            const completed = await host.handleCompletedAssignment(
              projectId,
              repoPath,
              task,
              assignment
            );
            if (completed) {
              stale.push(taskId);
              continue;
            }
          }
        }

        log.warn("Recovering dead slotted task", {
          projectId,
          taskId,
          phase: assignment.phase,
          attempt: assignment.attempt,
        });
        await host.removeStaleSlot!(projectId, taskId, repoPath);
        await this.recoverTask(projectId, repoPath, task);
        stale.push(taskId);
      }
    }

    return stale;
  }

  // ─── Orphan worktree pruning ───

  private async pruneOrphanWorktrees(
    projectId: string,
    repoPath: string,
    excludeIds: Set<string>,
    excludeWorktreeKeys: Set<string>,
    excludeWorktreePaths: Set<string>
  ): Promise<string[]> {
    const settings = await this.projectService.getSettings(projectId);
    if (settings.gitWorkingMode === "branches") return [];
    return this.branchManager.pruneOrphanWorktrees(
      repoPath,
      projectId,
      excludeIds,
      excludeWorktreeKeys,
      excludeWorktreePaths,
      this.taskStore
    );
  }

  private async replayPendingCleanupIntents(
    projectId: string,
    repoPath: string,
    excludeWorktreeKeys: Set<string>,
    excludeWorktreePaths: Set<string>
  ): Promise<string[]> {
    const intents = await worktreeCleanupIntentService.list(repoPath, projectId);
    if (intents.length === 0) return [];
    const tasks = await this.taskStore.listAll(projectId);
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const cleaned: string[] = [];
    for (const intent of intents) {
      const worktreeKey = intent.worktreeKey ?? intent.taskId;
      const resolvedPath = intent.worktreePath ? path.resolve(intent.worktreePath) : null;
      if (excludeWorktreeKeys.has(worktreeKey)) continue;
      if (resolvedPath && excludeWorktreePaths.has(resolvedPath)) continue;
      const task = taskById.get(intent.taskId);
      if (task && String(task.status ?? "") === "in_progress") {
        log.warn("Skipping cleanup intent for in-progress task", {
          projectId,
          taskId: intent.taskId,
          branchName: intent.branchName,
          worktreePath: intent.worktreePath,
        });
        continue;
      }
      const createdMs = intent.createdAt ? Date.parse(intent.createdAt) : NaN;
      if (Number.isFinite(createdMs) && Date.now() - createdMs < CLEANUP_INTENT_REPLAY_MIN_AGE_MS) {
        log.info("Skipping cleanup intent replay: within post-merge cooldown window", {
          projectId,
          taskId: intent.taskId,
          worktreeKey,
          minAgeMs: CLEANUP_INTENT_REPLAY_MIN_AGE_MS,
        });
        continue;
      }
      if (intent.worktreePath) {
        const resolvedIntentPath = path.resolve(intent.worktreePath);
        const protection = await evaluateWorktreeCleanupProtection(
          projectId,
          resolvedIntentPath,
          (pid, tid) => this.taskStore.show(pid, tid),
          getWorktreeCleanupAssignmentGuardMs()
        );
        if (protection.forbid) {
          logWorktreeCleanupBlocked("replay_cleanup_intent", {
            projectId,
            worktreePath: resolvedIntentPath,
            reason: protection.reason ?? "unknown",
            referencingTaskIds: protection.referencingTaskIds,
            cleanupTrigger: "recovery_replay",
            intentTaskId: intent.taskId,
          });
          continue;
        }
      }
      try {
        if (intent.gitWorkingMode === "branches") {
          await this.branchManager.deleteBranch(repoPath, intent.branchName);
        } else {
          log.info("Releasing durable worktree lease before replayed merge-success teardown", {
            projectId,
            taskId: intent.taskId,
            worktreeKey,
          });
          await worktreeLeaseService.forceRelease(worktreeKey).catch((err) => {
            log.warn("Failed to force-release worktree lease before intent replay cleanup", {
              projectId,
              taskId: intent.taskId,
              worktreeKey,
              err: err instanceof Error ? err.message : String(err),
            });
          });
          eventLogService
            .append(repoPath, {
              timestamp: new Date().toISOString(),
              projectId,
              taskId: intent.taskId,
              event: "worktree.lease_released_for_cleanup",
              data: {
                trigger: "recovery_replay",
                worktreeKey,
              },
            })
            .catch(() => {});
          const removedOk = await this.branchManager.removeTaskWorktree(
            repoPath,
            worktreeKey,
            intent.worktreePath ?? undefined
          );
          if (!removedOk) {
            log.warn("Recovery replay skipped branch delete after worktree removal was blocked", {
              projectId,
              taskId: intent.taskId,
              branchName: intent.branchName,
              worktreeKey,
            });
            continue;
          }
          await this.branchManager.deleteBranch(repoPath, intent.branchName);
        }
        await worktreeCleanupIntentService.removeBestEffort(repoPath, projectId, intent.taskId);
        cleaned.push(intent.taskId);
        fireAndForget(
          eventLogService.append(repoPath, {
            timestamp: new Date().toISOString(),
            projectId,
            taskId: intent.taskId,
            event: "worktree.cleanup_succeeded",
            data: {
              trigger: "recovery_replay",
              branchName: intent.branchName,
              worktreePath: intent.worktreePath,
              worktreeKey,
            },
          }),
          "recovery:worktree-cleanup-event-log"
        );
      } catch (err) {
        fireAndForget(
          eventLogService.append(repoPath, {
            timestamp: new Date().toISOString(),
            projectId,
            taskId: intent.taskId,
            event: "worktree.cleanup_failed",
            data: {
              trigger: "recovery_replay",
              branchName: intent.branchName,
              worktreePath: intent.worktreePath,
              worktreeKey,
              error: err instanceof Error ? err.message : String(err),
            },
          }),
          "recovery:worktree-cleanup-complete-event-log"
        );
      }
    }
    return cleaned;
  }

  /**
   * Extend slot exclusion sets from assignment.json files on disk so recovery does not tear down
   * a worktree in the gap after assignment is written but before the orchestrator slot is visible.
   */
  private async augmentExclusionsFromRecentAssignments(
    projectId: string,
    repoPath: string,
    excludeIds: Set<string>,
    excludeWorktreeKeys: Set<string>,
    excludeWorktreePaths: Set<string>
  ): Promise<void> {
    const guardMs = getWorktreeCleanupAssignmentGuardMs();
    const now = Date.now();
    const baseCandidates = [
      this.branchManager.getWorktreeBasePath(repoPath),
      this.branchManager.getLegacyWorktreeBasePath(),
    ];
    const bases: string[] = [];
    const seenBases = new Set<string>();
    for (const b of baseCandidates) {
      const norm = path.resolve(b);
      if (seenBases.has(norm)) continue;
      seenBases.add(norm);
      bases.push(b);
    }
    const seenWt = new Set<string>();
    /** Avoid scanning huge legacy temp roots (can contain thousands of stale dirs). */
    const maxDirsPerBase = 96;

    for (const base of bases) {
      let entries;
      try {
        entries = await fs.readdir(base, { withFileTypes: true });
      } catch {
        continue;
      }
      let dirBudget = maxDirsPerBase;
      for (const e of entries) {
        if (dirBudget <= 0) {
          log.debug("Recovery: assignment exclusion scan budget exhausted for base", {
            base,
            maxDirsPerBase,
          });
          break;
        }
        if (!e.isDirectory() || e.name.startsWith("_")) continue;
        dirBudget -= 1;
        const wtPath = path.join(base, e.name);
        const resolvedWt = path.resolve(wtPath);
        if (seenWt.has(resolvedWt)) continue;
        seenWt.add(resolvedWt);

        const summaries = await listAssignmentSummariesInWorktree(wtPath);
        for (const s of summaries) {
          const createdMs = Date.parse(s.createdAt);
          const age = Number.isFinite(createdMs) ? now - createdMs : Number.POSITIVE_INFINITY;
          if (age < 0 || age >= guardMs) continue;
          excludeIds.add(s.taskId);
          excludeWorktreeKeys.add(e.name);
          excludeWorktreeKeys.add(s.taskId);
          if (s.worktreeKey) excludeWorktreeKeys.add(s.worktreeKey);
          if (s.worktreePath) excludeWorktreePaths.add(path.resolve(s.worktreePath));
          excludeWorktreePaths.add(resolvedWt);
        }
      }
    }

    try {
      const activeDir = path.join(repoPath, OPENSPRINT_PATHS.active);
      const subs = await fs.readdir(activeDir, { withFileTypes: true });
      for (const sub of subs) {
        if (!sub.isDirectory() || sub.name.startsWith("_")) continue;
        const ap = path.join(activeDir, sub.name, OPENSPRINT_PATHS.assignment);
        let raw: string;
        try {
          raw = await fs.readFile(ap, "utf-8");
        } catch {
          continue;
        }
        let parsed: {
          taskId?: string;
          createdAt?: string;
          worktreePath?: string;
          worktreeKey?: string;
        };
        try {
          parsed = JSON.parse(raw) as typeof parsed;
        } catch {
          continue;
        }
        const createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt : "";
        const createdMs = Date.parse(createdAt);
        const age = Number.isFinite(createdMs) ? now - createdMs : Number.POSITIVE_INFINITY;
        if (age < 0 || age >= guardMs) continue;
        const tid = typeof parsed.taskId === "string" ? parsed.taskId : sub.name;
        excludeIds.add(tid);
        excludeWorktreeKeys.add(tid);
        if (typeof parsed.worktreeKey === "string") excludeWorktreeKeys.add(parsed.worktreeKey);
        if (typeof parsed.worktreePath === "string") {
          const rp = path.resolve(parsed.worktreePath);
          if (rp !== path.resolve(repoPath)) excludeWorktreePaths.add(rp);
        }
      }
    } catch {
      // No main-repo active dir
    }

    log.debug("Recovery: augmented exclusions from fresh on-disk assignments", {
      projectId,
      guardMs,
      excludeIdSample: [...excludeIds].slice(0, 8),
      excludePathCount: excludeWorktreePaths.size,
    });
  }

  private async hasFreshRecoveryHeartbeatGuard(
    repoPath: string,
    taskId: string,
    taskUpdatedAt: string | null | undefined,
    assignmentWorktreePath?: string
  ): Promise<boolean> {
    const now = Date.now();
    const candidatePaths = new Set<string>();
    if (assignmentWorktreePath) candidatePaths.add(assignmentWorktreePath);
    candidatePaths.add(this.branchManager.getWorktreePath(taskId, repoPath));

    for (const worktreePath of candidatePaths) {
      const heartbeat = await heartbeatService.readHeartbeat(worktreePath, taskId);
      if (!heartbeat) continue;
      const pidAlive =
        typeof heartbeat.processGroupLeaderPid === "number" &&
        heartbeat.processGroupLeaderPid > 0 &&
        isProcessAlive(heartbeat.processGroupLeaderPid);
      if (pidAlive) {
        log.info("Skipping recovery due to live heartbeat PID", { taskId, worktreePath });
        return true;
      }

      const heartbeatFresh =
        Number.isFinite(heartbeat.heartbeatTimestamp) &&
        now - heartbeat.heartbeatTimestamp <= HEARTBEAT_STALE_MS;
      const outputFresh =
        Number.isFinite(heartbeat.lastOutputTimestamp) &&
        now - heartbeat.lastOutputTimestamp <= HEARTBEAT_STALE_MS;
      const updatedAtMs = taskUpdatedAt ? Date.parse(taskUpdatedAt) : Number.NaN;
      const withinNoPidGuardAge =
        !Number.isFinite(updatedAtMs) || now - updatedAtMs <= HEARTBEAT_WITHOUT_PID_MAX_AGE_MS;
      if ((heartbeatFresh || outputFresh) && withinNoPidGuardAge) {
        log.info("Skipping recovery due to fresh heartbeat without PID", {
          taskId,
          worktreePath,
          heartbeatFresh,
          outputFresh,
        });
        return true;
      }
    }
    return false;
  }

  private async cleanupStaleInactiveWorktrees(
    projectId: string,
    repoPath: string,
    excludeTaskIds: Set<string>,
    excludeWorktreeKeys: Set<string>,
    excludeWorktreePaths: Set<string>
  ): Promise<string[]> {
    const settings = await this.projectService.getSettings(projectId);
    if (settings.gitWorkingMode === "branches") return [];
    const worktrees = await this.branchManager.listTaskWorktrees(repoPath);
    if (worktrees.length === 0) return [];
    const tasks = await this.taskStore.listAll(projectId);
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const now = Date.now();
    const cleaned: string[] = [];

    for (const { taskId: worktreeKey, worktreePath } of worktrees) {
      const resolvedPath = path.resolve(worktreePath);
      if (excludeTaskIds.has(worktreeKey)) continue;
      if (excludeWorktreeKeys.has(worktreeKey)) continue;
      if (excludeWorktreePaths.has(resolvedPath)) continue;

      const task = taskById.get(worktreeKey);
      if (!task) continue;
      const status = String(task.status ?? "");
      if (status !== "open" && status !== "blocked") continue;

      const updatedAt = Date.parse(String(task.updated_at ?? ""));
      if (!Number.isFinite(updatedAt)) continue;
      if (now - updatedAt < STALE_INACTIVE_WORKTREE_MS) continue;

      const assignment = await this.readAssignment(repoPath, task.id);
      if (assignment?.worktreePath && path.resolve(assignment.worktreePath) === resolvedPath) {
        continue;
      }
      if (assignment?.worktreePath) {
        const heartbeat = await heartbeatService.readHeartbeat(assignment.worktreePath, task.id);
        const pid =
          heartbeat && typeof heartbeat.processGroupLeaderPid === "number"
            ? heartbeat.processGroupLeaderPid
            : 0;
        if (pid > 0 && isProcessAlive(pid)) {
          continue;
        }
      }

      const staleProtect = await evaluateWorktreeCleanupProtection(
        projectId,
        resolvedPath,
        (pid, tid) => this.taskStore.show(pid, tid),
        getWorktreeCleanupAssignmentGuardMs()
      );
      if (staleProtect.forbid) {
        logWorktreeCleanupBlocked("cleanup_stale_inactive_worktrees", {
          projectId,
          worktreePath: resolvedPath,
          reason: staleProtect.reason ?? "unknown",
          referencingTaskIds: staleProtect.referencingTaskIds,
          cleanupTrigger: "stale_inactive_ttl",
        });
        continue;
      }

      try {
        await this.branchManager.removeTaskWorktree(repoPath, worktreeKey, worktreePath);
        cleaned.push(worktreeKey);
        fireAndForget(
          eventLogService.append(repoPath, {
            timestamp: new Date().toISOString(),
            projectId,
            taskId: task.id,
            event: "worktree.cleanup_succeeded",
            data: {
              trigger: "stale_inactive_ttl",
              worktreeKey,
              worktreePath,
              taskStatus: status,
              staleForMs: now - updatedAt,
            },
          }),
          "recovery:stale-heartbeat-event-log"
        );
      } catch (err) {
        fireAndForget(
          eventLogService.append(repoPath, {
            timestamp: new Date().toISOString(),
            projectId,
            taskId: task.id,
            event: "worktree.cleanup_failed",
            data: {
              trigger: "stale_inactive_ttl",
              worktreeKey,
              worktreePath,
              taskStatus: status,
              staleForMs: now - updatedAt,
              error: err instanceof Error ? err.message : String(err),
            },
          }),
          "recovery:stale-heartbeat-cleanup-event-log"
        );
      }
    }
    return cleaned;
  }

  // ─── Shared helpers ───

  private emitStaleAssignmentTelemetry(
    repoPath: string,
    projectId: string,
    taskId: string,
    assignmentAgeMs: number,
    reason: "stale_success" | "task_not_found" | "status_mismatch" | "pid_dead_requeue",
    assignment: GuppAssignment
  ): void {
    const ageSec = Math.round(assignmentAgeMs / 1000);
    const failureType = assignment.retryContext?.failureType ?? null;
    log.warn("Stale assignment detected", {
      projectId,
      taskId,
      reason,
      ageSec,
      attempt: assignment.attempt,
      phase: assignment.phase,
      failureType,
    });
    eventLogService
      .append(repoPath, {
        timestamp: new Date().toISOString(),
        projectId,
        taskId,
        event: "recovery.stale_assignment",
        data: {
          reason,
          ageSec,
          attempt: assignment.attempt,
          phase: assignment.phase,
          failureType,
          worktreePath: assignment.worktreePath,
        },
      })
      .catch((err) => log.debug("Best-effort event log append failed", { taskId, err }));
  }

  private async recoverTask(projectId: string, repoPath: string, task: StoredTask): Promise<void> {
    const settings = await this.projectService.getSettings(projectId);
    const gitWorkingMode = settings.gitWorkingMode ?? "worktree";
    // Persist the ownership transition before destructive filesystem cleanup.
    // A failed task-store write must leave the recoverable checkout intact.
    await this.taskStore.update(projectId, task.id, { status: "open", assignee: "" });
    await this.taskStore.setMergeStage(projectId, task.id, null);

    // In Branches mode, agent runs in repoPath; no worktree. In Worktree mode, use worktree path.
    const workPath =
      gitWorkingMode === "branches"
        ? repoPath
        : this.branchManager.getWorktreePath(task.id, repoPath);
    try {
      await fs.access(workPath);
      await this.branchManager.commitWip(workPath, task.id);
    } catch {
      // Worktree/path may not exist
    }

    // Clean up worktree only in Worktree mode (Branches mode: no worktree to remove)
    if (gitWorkingMode !== "branches") {
      try {
        const worktrees = await this.branchManager.listTaskWorktrees(repoPath);
        const found = worktrees.find((w) => w.taskId === task.id);
        const wtForTask = found?.worktreePath;
        if (wtForTask) {
          const protection = await evaluateWorktreeCleanupProtection(
            projectId,
            path.resolve(wtForTask),
            (pid, tid) => this.taskStore.show(pid, tid),
            getWorktreeCleanupAssignmentGuardMs(),
            { ignoreLiveTaskStatusForTaskIds: new Set([task.id]) }
          );
          if (protection.forbid) {
            logWorktreeCleanupBlocked("recover_task", {
              projectId,
              worktreePath: path.resolve(wtForTask),
              reason: protection.reason ?? "unknown",
              referencingTaskIds: protection.referencingTaskIds,
              cleanupTrigger: "recover_task",
            });
            return;
          }
        }
        await this.branchManager.removeTaskWorktree(repoPath, task.id, found?.worktreePath, {
          ignoreLiveTaskStatusForTaskIds: new Set([task.id]),
        });
      } catch {
        // Worktree may not exist
      }
    }
  }

  private async readAssignment(repoPath: string, taskId: string): Promise<GuppAssignment | null> {
    try {
      const readAssignmentAt = (
        this.crashRecovery as {
          readAssignmentAt?: (
            basePath: string,
            assignmentTaskId: string
          ) => Promise<GuppAssignment | null>;
        }
      ).readAssignmentAt;
      if (typeof readAssignmentAt !== "function") return null;
      const worktreePath = this.branchManager.getWorktreePath(taskId, repoPath);
      const legacyPath = this.branchManager.getWorktreePath(taskId);
      return (
        (await readAssignmentAt(worktreePath, taskId)) ??
        (await readAssignmentAt(legacyPath, taskId)) ??
        (await readAssignmentAt(repoPath, taskId))
      );
    } catch {
      return null;
    }
  }

  private async readTerminalAssignmentResult(assignment: GuppAssignment): Promise<string | null> {
    const resultPath = path.join(path.dirname(assignment.promptPath), "result.json");
    try {
      const raw = await fs.readFile(resultPath, "utf-8");
      const parsed = JSON.parse(raw) as { status?: string };
      const status = typeof parsed?.status === "string" ? parsed.status.toLowerCase() : "";
      return ["success", "failed", "approved", "rejected"].includes(status) ? status : null;
    } catch {
      return null;
    }
  }

  /**
   * Remove worktree when the path is a task worktree (not main repo).
   * In Branches mode assignment.worktreePath === repoPath; in Worktree mode it's a temp path.
   * Uses actual path so we clean up correctly when os.tmpdir() changed since creation.
   */
  private resolveCleanupWorktreeKey(
    taskId: string,
    assignmentWorktreeKey?: string,
    worktreePath?: string
  ): string {
    if (assignmentWorktreeKey && assignmentWorktreeKey.trim().length > 0) {
      return assignmentWorktreeKey;
    }
    if (worktreePath) {
      const worktreeBasename = path.basename(path.resolve(worktreePath));
      if (worktreeBasename.startsWith("epic_")) {
        return worktreeBasename;
      }
    }
    return taskId;
  }

  private async removeWorktreeIfNeeded(
    projectId: string,
    repoPath: string,
    taskId: string,
    worktreePath?: string,
    assignmentWorktreeKey?: string
  ): Promise<boolean> {
    if (!worktreePath) return true;
    const repoResolved = path.resolve(repoPath);
    const wtResolved = path.resolve(worktreePath);
    if (repoResolved === wtResolved) return true; // Branches mode: no worktree
    const protection = await evaluateWorktreeCleanupProtection(
      projectId,
      wtResolved,
      (pid, tid) => this.taskStore.show(pid, tid),
      getWorktreeCleanupAssignmentGuardMs(),
      { ignoreLiveTaskStatusForTaskIds: new Set([taskId]) }
    );
    if (protection.forbid) {
      logWorktreeCleanupBlocked("recovery_remove_worktree_if_needed", {
        projectId,
        worktreePath: wtResolved,
        reason: protection.reason ?? "unknown",
        referencingTaskIds: protection.referencingTaskIds,
        cleanupTrigger: "recovery_remove_worktree_if_needed",
      });
      return false;
    }
    const worktreeKey = this.resolveCleanupWorktreeKey(taskId, assignmentWorktreeKey, worktreePath);
    const canCleanup = await worktreeLeaseService.canCleanup(worktreeKey).catch((err) => {
      log.warn("Skipping worktree removal: lease ownership could not be checked", {
        taskId,
        worktreeKey,
        err,
      });
      return false;
    });
    if (!canCleanup) {
      log.info("Skipping worktree removal: active lease exists", {
        taskId,
        worktreeKey,
        worktreePath,
      });
      return false;
    }
    const lease = await worktreeLeaseService.get(worktreeKey).catch(() => null);
    log.info("Proceeding with worktree removal (lease allows cleanup)", {
      taskId,
      worktreeKey,
      worktreePath,
      leaseState: lease ? (lease.releasedAt ? "released" : "expired") : "no_lease",
      leaseExpiresAt: lease?.expiresAt ?? null,
      leaseReleasedAt: lease?.releasedAt ?? null,
    });
    try {
      const removed = await this.branchManager.removeTaskWorktree(
        repoPath,
        worktreeKey,
        worktreePath,
        {
          ignoreLiveTaskStatusForTaskIds: new Set([taskId]),
        }
      );
      if (!removed) return false;
      await worktreeLeaseService.forceRelease(worktreeKey).catch((err) => {
        log.warn("worktree lease force-release failed", {
          worktreeKey,
          err: err instanceof Error ? err.message : String(err),
        });
      });
      return true;
    } catch {
      // Best effort; worktree may already be gone
      return false;
    }
  }

  private async deleteAssignment(
    repoPath: string,
    taskId: string,
    worktreePath?: string
  ): Promise<void> {
    if (worktreePath) {
      await this.crashRecovery.deleteAssignmentAt(worktreePath, taskId);
    }
    const { OPENSPRINT_PATHS } = await import("@opensprint/shared");
    const assignmentPath = path.join(
      repoPath,
      OPENSPRINT_PATHS.active,
      taskId,
      OPENSPRINT_PATHS.assignment
    );
    try {
      await fs.unlink(assignmentPath);
    } catch {
      // File may not exist
    }
  }
}

export const recoveryService = new RecoveryService();
