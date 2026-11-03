import { getEffectiveMergeStrategy } from "@opensprint/shared";
/**
 * OrchestratorLoopService — main runLoop: feedback mailbox, task selection, dispatch batching.
 * Extracted from OrchestratorService for clarity and testability.
 */

import type { ExecuteStatusEvent, OrchestratorStatus } from "@opensprint/shared";
import {
  getAgentForComplexity,
  getProviderForAgentType,
  isAgentAssignee,
} from "@opensprint/shared";
import { resolveEpicId, type StoredTask, type TaskStoreService } from "./task-store.service.js";
import { eventLogService } from "./event-log.service.js";
import type { TimerRegistry } from "./timer-registry.js";
import { notificationService } from "./notification.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { createLogger } from "../utils/logger.js";
import { fireAndForget } from "../utils/fire-and-forget.js";
import { getNextKey } from "./api-key-resolver.service.js";
import { isExhausted, clearExhausted } from "./api-key-exhausted.service.js";
import { getProviderOutageBackoff } from "./provider-outage-backoff.service.js";
import { getComplexityForAgent } from "./plan-complexity.js";
import { WorktreeBranchInUseError } from "./branch-manager.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { planPullRequestReconciler } from "./plan-pull-request-reconcile.service.js";

const log = createLogger("orchestrator-loop");

/** Debounced nudge after worktree branch contention so the task retries without a false "failed" signal. */
const WORKTREE_DEFER_NUDGE_MS = 8_000;

/** If runLoop is blocked in an await longer than this, force recovery so nudge can start a fresh loop. */
const LOOP_STUCK_GUARD_MS = 5 * 60 * 1000;

/** Baseline remediation tasks are auto-blocked after this many cumulative attempts. */
const MAX_BASELINE_REMEDIATION_ATTEMPTS = 3;

function resolveMaxNewTasksPerLoop(slotsAvailable: number): number {
  const raw = Number(process.env.OPENSPRINT_MAX_NEW_TASKS_PER_LOOP ?? "");
  if (Number.isFinite(raw) && raw > 0) {
    return Math.max(1, Math.floor(raw));
  }
  return slotsAvailable;
}

/** Minimal state shape needed by the loop (slots, run id, timers, status). */
export interface LoopState {
  slots: Map<string, unknown>;
  loopRunId: number;
  loopActive: boolean;
  globalTimers: TimerRegistry;
  status: {
    queueDepth: number;
    baselineStatus?: OrchestratorStatus["baselineStatus"];
    dispatchPausedReason?: string | null;
    dispatchBlockers?: OrchestratorStatus["dispatchBlockers"];
  };
}

export interface SchedulerResult {
  task: StoredTask;
  fileScope?: unknown;
}

export interface OrchestratorLoopHost {
  getState(projectId: string): LoopState;
  getStatus(projectId: string): Promise<OrchestratorStatus>;
  dispatchTask(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    slotQueueDepth: number
  ): Promise<void>;
  removeSlot(state: LoopState, taskId: string): void;
  buildActiveTasks(state: LoopState): OrchestratorStatus["activeTasks"];
  persistCounters(projectId: string, repoPath: string): Promise<void>;
  ensureApiBlockedNotificationsForExhaustedProviders(projectId: string): Promise<void>;
  nudge(projectId: string): void;
  runLoop(projectId: string): Promise<void>;
  stopProject(projectId: string): void;
  getProjectService(): {
    getRepoPath: (id: string) => Promise<string>;
    getSettings: (id: string) => Promise<{
      gitWorkingMode?: "worktree" | "branches";
      maxConcurrentCoders?: number;
      unknownScopeStrategy?: string;
      mergeStrategy?: string;
      deliveryMode?: "direct" | "pull_request";
    }>;
  };
  getTaskStore(): {
    readyWithStatusMap(
      projectId: string
    ): Promise<{ tasks: StoredTask[]; allIssues: StoredTask[] }>;
    update(projectId: string, taskId: string, fields: Record<string, unknown>): Promise<unknown>;
    getCumulativeAttemptsFromIssue(task: StoredTask): number;
  };
  getTaskScheduler(): {
    selectTasks(
      projectId: string,
      repoPath: string,
      readyTasks: StoredTask[],
      activeSlots: Map<string, unknown>,
      maxSlots: number,
      options?: { allIssues?: StoredTask[]; unknownScopeStrategy?: string }
    ): Promise<SchedulerResult[]>;
  };
  getFeedbackService(): {
    claimNextPendingFeedbackId(projectId: string): Promise<string | null>;
    processFeedbackWithAnalyst(projectId: string, feedbackId: string): Promise<void>;
  };
  getMaxSlotsCache(): Map<string, number>;
  setMaxSlotsCache(projectId: string, value: number): void;
}

export class OrchestratorLoopService {
  constructor(private host: OrchestratorLoopHost) {}

  private collectActiveWorktreeKeys(state: LoopState): Set<string> {
    const keys = new Set<string>();
    for (const slot of state.slots.values()) {
      const s = slot as { worktreeKey?: string; taskId: string };
      keys.add(s.worktreeKey ?? s.taskId);
    }
    return keys;
  }

  /** Matches dispatch worktree key logic in OrchestratorDispatchService (per-epic shared branch). */
  private dispatchWorktreeKey(
    task: StoredTask,
    mergeStrategy: string,
    allIssues: StoredTask[]
  ): string {
    const epicId = resolveEpicId(task.id, allIssues);
    const useEpicBranch = mergeStrategy === "per_epic" && epicId != null;
    return useEpicBranch ? `epic_${epicId}` : task.id;
  }

  private isBaselineQualityGateRemediationTask(task: StoredTask): boolean {
    const source = (task as { source?: unknown }).source;
    const kind = (task as { selfImprovementKind?: unknown }).selfImprovementKind;
    const sourceId = (task as { baselineQualityGateSource?: unknown }).baselineQualityGateSource;
    return (
      source === "self-improvement" &&
      (kind === "baseline-quality-gate" || sourceId === "merge-quality-gate-baseline")
    );
  }

  private async broadcastExecuteStatus(projectId: string): Promise<void> {
    const status = await this.host.getStatus(projectId);
    const payload: ExecuteStatusEvent = {
      type: "execute.status",
      activeTasks: status.activeTasks,
      queueDepth: status.queueDepth,
      baselineStatus: status.baselineStatus,
      baselineCheckedAt: status.baselineCheckedAt ?? null,
      baselineFailureSummary: status.baselineFailureSummary ?? null,
      baselineRemediationStatus: status.baselineRemediationStatus ?? null,
      mergeValidationStatus: status.mergeValidationStatus,
      mergeValidationFailureSummary: status.mergeValidationFailureSummary ?? null,
      dispatchPausedReason: status.dispatchPausedReason ?? null,
      dispatchBlockers: status.dispatchBlockers ?? null,
      selfImprovementRunInProgress: status.selfImprovementRunInProgress,
      selfImprovementRunMode: status.selfImprovementRunMode,
      gitMergeQueue: status.gitMergeQueue,
      ...(status.pendingFeedbackCategorizations && {
        pendingFeedbackCategorizations: status.pendingFeedbackCategorizations,
      }),
    };
    broadcastToProject(projectId, payload);
  }

  async runLoop(projectId: string): Promise<void> {
    const state = this.host.getState(projectId);

    const myRunId = (state.loopRunId ?? 0) + 1;
    state.loopRunId = myRunId;
    state.loopActive = true;
    state.globalTimers.clear("loop");

    state.globalTimers.setTimeout(
      "loopStuckGuard",
      () => {
        if (state.loopRunId !== myRunId) return;
        log.warn("Orchestrator loop stuck (timeout), recovering so work can resume", {
          projectId,
          stuckRunId: myRunId,
        });
        state.loopRunId = myRunId + 1;
        state.loopActive = false;
        this.host.nudge(projectId);
      },
      LOOP_STUCK_GUARD_MS
    );

    try {
      const nextFeedbackId = await this.host
        .getFeedbackService()
        .claimNextPendingFeedbackId(projectId);
      if (nextFeedbackId) {
        log.info("Processing queued feedback with Analyst", {
          projectId,
          feedbackId: nextFeedbackId,
        });
        try {
          await this.host
            .getFeedbackService()
            .processFeedbackWithAnalyst(projectId, nextFeedbackId);
          await this.broadcastExecuteStatus(projectId);
        } catch (err) {
          log.error("Analyst failed for queued feedback; leaving in inbox for retry", {
            projectId,
            feedbackId: nextFeedbackId,
            err,
          });
        }
        if (state.loopRunId === myRunId) state.loopActive = false;
        this.host.nudge(projectId);
        return;
      }

      const projectService = this.host.getProjectService();
      const repoPath = await projectService.getRepoPath(projectId);
      const settings = await projectService.getSettings(projectId);
      const maxSlots =
        settings.gitWorkingMode === "branches" ? 1 : (settings.maxConcurrentCoders ?? 1);
      this.host.setMaxSlotsCache(projectId, maxSlots);

      const taskStore = this.host.getTaskStore() as unknown as TaskStoreService;
      if (settings.deliveryMode === "pull_request" && state.slots.size === 0) {
        await planPullRequestReconciler.reconcile(projectId, repoPath, taskStore);
      }
      const { tasks: readyTasksRaw, allIssues } = await taskStore.readyWithStatusMap(projectId);

      let readyTasks = readyTasksRaw.filter((t) => (t.issue_type ?? t.type) !== "epic");
      readyTasks = readyTasks.filter((t) => (t.issue_type ?? t.type) !== "chore");
      readyTasks = readyTasks.filter((t) => (t.status as string) !== "blocked");
      readyTasks = readyTasks.filter((t) => !state.slots.has(t.id));
      readyTasks = readyTasks.filter((t) => !t.assignee || isAgentAssignee(t.assignee));

      state.status.queueDepth = readyTasks.length;
      state.status.dispatchBlockers = null;

      if (state.status.baselineStatus === "failing") {
        const taskStore = this.host.getTaskStore();
        const remediationTasks = readyTasks.filter((task) =>
          this.isBaselineQualityGateRemediationTask(task)
        );

        const dispatchableRemediation: StoredTask[] = [];
        for (const task of remediationTasks) {
          const attempts = taskStore.getCumulativeAttemptsFromIssue(task);
          if (attempts >= MAX_BASELINE_REMEDIATION_ATTEMPTS) {
            log.warn("Baseline remediation task exceeded attempt budget; auto-blocking", {
              projectId,
              taskId: task.id,
              attempts,
              maxAttempts: MAX_BASELINE_REMEDIATION_ATTEMPTS,
            });
            taskStore
              .update(projectId, task.id, {
                status: "blocked",
                assignee: "",
                block_reason: `Baseline remediation failed after ${attempts} attempts`,
              })
              .catch((err) => log.warn("Failed to block exhausted remediation task", { err }));
            continue;
          }
          dispatchableRemediation.push(task);
        }

        if (dispatchableRemediation.length > 0) {
          const normalTasks = readyTasks.filter(
            (task) => !this.isBaselineQualityGateRemediationTask(task)
          );
          readyTasks = [...dispatchableRemediation, ...normalTasks];
          log.info("Baseline failing; prioritizing remediation but allowing normal tasks", {
            projectId,
            remediationTasks: dispatchableRemediation.length,
            normalTasks: normalTasks.length,
          });
        } else {
          log.warn(
            "Baseline quality gates are failing but no remediation tasks are ready (all blocked/completed); " +
              "resuming normal dispatch to avoid deadlock",
            {
              projectId,
              dispatchPausedReason: state.status.dispatchPausedReason ?? null,
              readyTasks: readyTasks.length,
            }
          );
        }
      }

      const hasPendingPrdSpecHil = await notificationService.hasOpenPrdSpecHilApproval(projectId);
      if (hasPendingPrdSpecHil) {
        log.info("Open PRD/SPEC HIL approval — blocking task assignment until resolved", {
          projectId,
        });
        if (state.loopRunId === myRunId) state.loopActive = false;
        await this.broadcastExecuteStatus(projectId);
        return;
      }

      const slotsAvailable = maxSlots - state.slots.size;
      const dispatchBlockers: NonNullable<OrchestratorStatus["dispatchBlockers"]> = {
        slotsFull: 0,
        providerBackoff: 0,
        providerExhausted: 0,
        worktreeConflict: 0,
      };
      if (readyTasks.length === 0 || slotsAvailable <= 0) {
        if (slotsAvailable <= 0 && readyTasks.length > 0) {
          dispatchBlockers.slotsFull = readyTasks.length;
        }
        state.status.dispatchBlockers = dispatchBlockers;
        log.debug("No ready tasks or no slots available, going idle", {
          projectId,
          readyTasks: readyTasks.length,
          slotsAvailable,
          activeSlotCount: state.slots.size,
        });
        if (state.loopRunId === myRunId) state.loopActive = false;
        await this.broadcastExecuteStatus(projectId);
        return;
      }

      const selected = await this.host
        .getTaskScheduler()
        .selectTasks(projectId, repoPath, readyTasks, state.slots, maxSlots, {
          allIssues,
          unknownScopeStrategy: settings.unknownScopeStrategy ?? "conservative",
        });

      for (const provider of ["ANTHROPIC_API_KEY", "CURSOR_API_KEY", "OPENAI_API_KEY"] as const) {
        if (isExhausted(projectId, provider)) {
          const resolved = await getNextKey(projectId, provider);
          if (resolved?.key?.trim()) {
            clearExhausted(projectId, provider);
            log.info("API keys available again, cleared exhausted", { projectId, provider });
          }
        }
      }

      let dispatchableTasks: SchedulerResult[] = [];
      let skippedForProviderExhaustion = 0;
      let skippedForProviderBackoff = 0;
      for (const st of selected) {
        const complexity = await getComplexityForAgent(projectId, repoPath, st.task, taskStore);
        const agentConfig = getAgentForComplexity(
          settings as import("@opensprint/shared").ProjectSettings,
          complexity
        );
        const provider = getProviderForAgentType(agentConfig.type);
        const outageBackoff = provider ? getProviderOutageBackoff(projectId, provider) : null;
        if (provider && outageBackoff) {
          skippedForProviderBackoff += 1;
          log.debug("Skipping task: provider outage backoff active", {
            projectId,
            taskId: st.task.id,
            provider,
            backoffUntil: outageBackoff.until,
            backoffAttempts: outageBackoff.attempts,
          });
          continue;
        }
        if (provider && isExhausted(projectId, provider)) {
          skippedForProviderExhaustion += 1;
          log.debug("Skipping task: provider exhausted", {
            projectId,
            taskId: st.task.id,
            provider,
          });
          continue;
        }
        dispatchableTasks.push(st);
      }

      const mergeStrategy = getEffectiveMergeStrategy(settings);
      const worktreeKeysPlanned = this.collectActiveWorktreeKeys(state);
      const epicAwareDispatch: SchedulerResult[] = [];
      let skippedForWorktreeConflict = 0;
      for (const st of dispatchableTasks) {
        const key = this.dispatchWorktreeKey(st.task, mergeStrategy, allIssues);
        if (worktreeKeysPlanned.has(key)) {
          skippedForWorktreeConflict += 1;
          log.debug("Skipping task: shared epic/worktree branch already active", {
            projectId,
            taskId: st.task.id,
            worktreeKey: key,
          });
          continue;
        }
        worktreeKeysPlanned.add(key);
        epicAwareDispatch.push(st);
      }
      dispatchableTasks = epicAwareDispatch;
      dispatchBlockers.providerExhausted = skippedForProviderExhaustion;
      dispatchBlockers.providerBackoff = skippedForProviderBackoff;
      dispatchBlockers.worktreeConflict = skippedForWorktreeConflict;
      dispatchBlockers.slotsFull = Math.max(0, readyTasks.length - slotsAvailable);
      state.status.dispatchBlockers = dispatchBlockers;

      const maxNewTasksThisPass = Math.min(
        slotsAvailable,
        resolveMaxNewTasksPerLoop(slotsAvailable)
      );
      const dispatchBatch = dispatchableTasks.slice(0, maxNewTasksThisPass);
      const dispatchedTaskIds = new Set<string>();
      if (dispatchableTasks.length > dispatchBatch.length) {
        log.info("Dispatch capped for stability; deferring additional ready tasks", {
          projectId,
          selectedTasks: dispatchableTasks.length,
          dispatchingNow: dispatchBatch.length,
          maxNewTasksThisPass,
        });
      }

      if (dispatchableTasks.length === 0) {
        log.info("No dispatchable tasks after conflict-aware scheduling or provider checks", {
          projectId,
          readyTasks: readyTasks.length,
          activeSlots: state.slots.size,
          skippedForProviderExhaustion,
          skippedForProviderBackoff,
        });
        if (skippedForProviderExhaustion > 0) {
          await this.host.ensureApiBlockedNotificationsForExhaustedProviders(projectId);
        }
        if (state.loopRunId === myRunId) state.loopActive = false;
        await this.broadcastExecuteStatus(projectId);
        return;
      }

      for (let i = 0; i < dispatchBatch.length; i++) {
        const selectedTask = dispatchBatch[i]!;
        if (dispatchedTaskIds.has(selectedTask.task.id) || state.slots.has(selectedTask.task.id)) {
          log.debug("Skipping dispatch: task already selected or active this pass", {
            projectId,
            taskId: selectedTask.task.id,
            reason: dispatchedTaskIds.has(selectedTask.task.id)
              ? "already_selected_this_loop"
              : "active_slot_exists",
          });
          continue;
        }
        try {
          await this.host.dispatchTask(
            projectId,
            repoPath,
            selectedTask.task,
            Math.max(0, selected.length - (i + 1))
          );
          dispatchedTaskIds.add(selectedTask.task.id);
        } catch (error) {
          if (error instanceof WorktreeBranchInUseError) {
            dispatchBlockers.worktreeConflict += 1;
            state.status.dispatchBlockers = dispatchBlockers;
            const deferredTask = selectedTask.task;
            log.warn(
              "Worktree branch in use by active agent; deferring dispatch (not a task failure)",
              {
                projectId,
                taskId: deferredTask.id,
                otherPath: error.otherPath,
                otherTaskId: error.otherTaskId,
              }
            );
            this.host.removeSlot(state, deferredTask.id);
            try {
              await taskStore.update(projectId, deferredTask.id, {
                status: "open",
                assignee: "",
              });
            } catch (revertErr) {
              log.warn("Failed to revert task status", {
                projectId,
                taskId: deferredTask.id,
                err: revertErr,
              });
            }
            const reason = error.message.slice(0, 500);
            fireAndForget(
              eventLogService.append(repoPath, {
                timestamp: new Date().toISOString(),
                projectId,
                taskId: deferredTask.id,
                event: "task.dispatch_deferred",
                data: {
                  phase: "dispatch",
                  failureType: "worktree_branch_in_use",
                  policyDecision: "defer_dispatch",
                  otherTaskId: error.otherTaskId ?? null,
                  otherWorktreePath: error.otherPath ?? null,
                  reason,
                },
              }),
              "orchestrator-loop:dispatch-deferred-event-log"
            );
            broadcastToProject(projectId, {
              type: "task.dispatch_deferred",
              taskId: deferredTask.id,
              reason,
              otherTaskId: error.otherTaskId ?? null,
              otherWorktreePath: error.otherPath ?? null,
            });
            state.globalTimers.clear("worktreeBranchDeferNudge");
            state.globalTimers.setTimeout(
              "worktreeBranchDeferNudge",
              () => {
                this.host.nudge(projectId);
              },
              WORKTREE_DEFER_NUDGE_MS
            );
            await this.broadcastExecuteStatus(projectId);
            continue;
          }
          throw error;
        }
      }

      if (state.loopRunId === myRunId) state.loopActive = false;
    } catch (error) {
      const errorCode = (error as { code?: string } | null)?.code;
      if (errorCode === ErrorCodes.PROJECT_NOT_FOUND) {
        log.info("Stopping orchestrator loop for deleted project", { projectId });
        if (state.loopRunId === myRunId) state.loopActive = false;
        this.host.stopProject(projectId);
        return;
      }
      if (errorCode === ErrorCodes.ISSUE_NOT_FOUND) {
        log.info("Ignoring orchestrator loop race after task disappeared", { projectId });
        if (state.loopRunId === myRunId) state.loopActive = false;
        return;
      }
      log.error(`Orchestrator loop error for project ${projectId}`, { error });
      if (state.loopRunId === myRunId) {
        state.loopActive = false;
        state.globalTimers.setTimeout(
          "loop",
          () => {
            void this.host.runLoop(projectId).catch((err) => {
              log.error("Deferred orchestrator loop run failed after error recovery", {
                projectId,
                err,
              });
            });
          },
          10000
        );
      }
    } finally {
      state.globalTimers.clear("loopStuckGuard");
    }
  }
}
