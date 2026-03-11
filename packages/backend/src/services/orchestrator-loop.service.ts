/**
 * OrchestratorLoopService — main runLoop: feedback mailbox, task selection, dispatch batching.
 * Extracted from OrchestratorService for clarity and testability.
 */

import type { OrchestratorStatus } from "@opensprint/shared";
import {
  getAgentForComplexity,
  getProviderForAgentType,
  isAgentAssignee,
} from "@opensprint/shared";
import type { StoredTask, TaskStoreService } from "./task-store.service.js";
import type { TimerRegistry } from "./timer-registry.js";
import { notificationService } from "./notification.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { createLogger } from "../utils/logger.js";
import { getNextKey } from "./api-key-resolver.service.js";
import { isExhausted, clearExhausted } from "./api-key-exhausted.service.js";
import { getComplexityForAgent } from "./plan-complexity.js";
import { isSelfImprovementRunInProgress } from "./self-improvement-runner.service.js";
import { WorktreeBranchInUseError } from "./branch-manager.js";

const log = createLogger("orchestrator-loop");

/** If runLoop is blocked in an await longer than this, force recovery so nudge can start a fresh loop. */
const LOOP_STUCK_GUARD_MS = 5 * 60 * 1000;
/** Start at most one new coder per loop pass (throttle while no_result failures are under investigation). */
const MAX_NEW_TASKS_PER_LOOP = 1;

/** Minimal state shape needed by the loop (slots, run id, timers, status). */
export interface LoopState {
  slots: Map<string, unknown>;
  loopRunId: number;
  loopActive: boolean;
  globalTimers: TimerRegistry;
  status: { queueDepth: number };
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
  getProjectService(): { getRepoPath: (id: string) => Promise<string>; getSettings: (id: string) => Promise<{
    gitWorkingMode?: "worktree" | "branches";
    maxConcurrentCoders?: number;
    unknownScopeStrategy?: string;
  }> };
  getTaskStore(): {
    readyWithStatusMap(projectId: string): Promise<{ tasks: StoredTask[]; allIssues: StoredTask[] }>;
    update(projectId: string, taskId: string, fields: Record<string, unknown>): Promise<void>;
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
          const status = await this.host.getStatus(projectId);
          broadcastToProject(projectId, {
            type: "execute.status",
            activeTasks: status.activeTasks,
            queueDepth: status.queueDepth,
            selfImprovementRunInProgress: status.selfImprovementRunInProgress,
            ...(status.pendingFeedbackCategorizations && {
              pendingFeedbackCategorizations: status.pendingFeedbackCategorizations,
            }),
          });
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

      const taskStore = this.host.getTaskStore() as TaskStoreService;
      const { tasks: readyTasksRaw, allIssues } =
        await taskStore.readyWithStatusMap(projectId);

      let readyTasks = readyTasksRaw.filter((t) => (t.issue_type ?? t.type) !== "epic");
      readyTasks = readyTasks.filter((t) => (t.issue_type ?? t.type) !== "chore");
      readyTasks = readyTasks.filter((t) => (t.status as string) !== "blocked");
      readyTasks = readyTasks.filter((t) => !state.slots.has(t.id));
      readyTasks = readyTasks.filter((t) => !t.assignee || isAgentAssignee(t.assignee));

      state.status.queueDepth = readyTasks.length;

      const hasPendingPrdSpecHil = await notificationService.hasOpenPrdSpecHilApproval(projectId);
      if (hasPendingPrdSpecHil) {
        log.info("Open PRD/SPEC HIL approval — blocking task assignment until resolved", {
          projectId,
        });
        if (state.loopRunId === myRunId) state.loopActive = false;
        broadcastToProject(projectId, {
          type: "execute.status",
          activeTasks: this.host.buildActiveTasks(state),
          queueDepth: state.status.queueDepth,
          selfImprovementRunInProgress: isSelfImprovementRunInProgress(projectId),
        });
        return;
      }

      const slotsAvailable = maxSlots - state.slots.size;
      if (readyTasks.length === 0 || slotsAvailable <= 0) {
        log.info("No ready tasks or no slots available, going idle", {
          projectId,
          readyTasks: readyTasks.length,
          slotsAvailable,
        });
        if (state.loopRunId === myRunId) state.loopActive = false;
        broadcastToProject(projectId, {
          type: "execute.status",
          activeTasks: this.host.buildActiveTasks(state),
          queueDepth: state.status.queueDepth,
          selfImprovementRunInProgress: isSelfImprovementRunInProgress(projectId),
        });
        return;
      }

      const selected = await this.host.getTaskScheduler().selectTasks(
        projectId,
        repoPath,
        readyTasks,
        state.slots,
        maxSlots,
        {
          allIssues,
          unknownScopeStrategy: settings.unknownScopeStrategy ?? "conservative",
        }
      );

      for (const provider of ["ANTHROPIC_API_KEY", "CURSOR_API_KEY", "OPENAI_API_KEY"] as const) {
        if (isExhausted(projectId, provider)) {
          const resolved = await getNextKey(projectId, provider);
          if (resolved?.key?.trim()) {
            clearExhausted(projectId, provider);
            log.info("API keys available again, cleared exhausted", { projectId, provider });
          }
        }
      }

      const dispatchableTasks: SchedulerResult[] = [];
      for (const st of selected) {
        const complexity = await getComplexityForAgent(
          projectId,
          repoPath,
          st.task,
          taskStore
        );
        const agentConfig = getAgentForComplexity(settings as import("@opensprint/shared").ProjectSettings, complexity);
        const provider = getProviderForAgentType(agentConfig.type);
        if (provider && isExhausted(projectId, provider)) {
          log.info("Skipping task: provider exhausted", {
            projectId,
            taskId: st.task.id,
            provider,
          });
          continue;
        }
        dispatchableTasks.push(st);
      }

      const dispatchBatch = dispatchableTasks.slice(0, MAX_NEW_TASKS_PER_LOOP);
      if (dispatchableTasks.length > dispatchBatch.length) {
        log.info("Dispatch capped for stability; deferring additional ready tasks", {
          projectId,
          selectedTasks: dispatchableTasks.length,
          dispatchingNow: dispatchBatch.length,
        });
      }

      if (dispatchableTasks.length === 0) {
        log.info("No dispatchable tasks after conflict-aware scheduling or provider exhaustion", {
          projectId,
          readyTasks: readyTasks.length,
          activeSlots: state.slots.size,
        });
        await this.host.ensureApiBlockedNotificationsForExhaustedProviders(projectId);
        if (state.loopRunId === myRunId) state.loopActive = false;
        broadcastToProject(projectId, {
          type: "execute.status",
          activeTasks: this.host.buildActiveTasks(state),
          queueDepth: state.status.queueDepth,
          selfImprovementRunInProgress: isSelfImprovementRunInProgress(projectId),
        });
        return;
      }

      for (let i = 0; i < dispatchBatch.length; i++) {
        const selectedTask = dispatchBatch[i]!;
        try {
          await this.host.dispatchTask(
            projectId,
            repoPath,
            selectedTask.task,
            Math.max(0, selected.length - (i + 1))
          );
        } catch (error) {
          if (error instanceof WorktreeBranchInUseError) {
            const failedTask = selectedTask.task;
            log.warn("Worktree branch in use by active agent, failing task and freeing slot", {
              projectId,
              taskId: failedTask.id,
              otherPath: error.otherPath,
              otherTaskId: error.otherTaskId,
            });
            this.host.removeSlot(state, failedTask.id);
            try {
              await taskStore.update(projectId, failedTask.id, {
                status: "open",
                assignee: "",
              });
            } catch (revertErr) {
              log.warn("Failed to revert task status", {
                taskId: failedTask.id,
                err: revertErr,
              });
            }
            broadcastToProject(projectId, {
              type: "agent.completed",
              taskId: failedTask.id,
              status: "failed",
              testResults: null,
              reason: error.message.slice(0, 500),
            });
            broadcastToProject(projectId, {
              type: "execute.status",
              activeTasks: this.host.buildActiveTasks(state),
              queueDepth: state.status.queueDepth,
              selfImprovementRunInProgress: isSelfImprovementRunInProgress(projectId),
            });
            continue;
          }
          throw error;
        }
      }

      if (state.loopRunId === myRunId) state.loopActive = false;
    } catch (error) {
      log.error(`Orchestrator loop error for project ${projectId}`, { error });
      if (state.loopRunId === myRunId) {
        state.loopActive = false;
        state.globalTimers.setTimeout("loop", () => this.host.runLoop(projectId), 10000);
      }
    } finally {
      state.globalTimers.clear("loopStuckGuard");
    }
  }
}
