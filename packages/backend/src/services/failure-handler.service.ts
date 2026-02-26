/**
 * FailureHandler — progressive backoff, retry logic, and task blocking.
 * Extracted from OrchestratorService for clarity and single-responsibility.
 *
 * Pure failure policy: "given N failures of type T, what happens next?"
 * Delegates retry execution back to the host via callbacks.
 */

import type { TestResults } from "@opensprint/shared";
import {
  AGENT_INACTIVITY_TIMEOUT_MS,
  BACKOFF_FAILURE_THRESHOLD,
  MAX_PRIORITY_BEFORE_BLOCK,
} from "@opensprint/shared";
import type { StoredTask } from "./task-store.service.js";
import type { FailureType, RetryContext } from "./orchestrator-phase-context.js";
import { agentIdentityService, type AttemptOutcome } from "./agent-identity.service.js";
import { eventLogService } from "./event-log.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("failure-handler");

const INFRA_FAILURE_TYPES: FailureType[] = ["agent_crash", "timeout", "merge_conflict"];
const MAX_INFRA_RETRIES = 2;

export interface FailureHandlerHost {
  getState(projectId: string): {
    slots: Map<string, FailureSlot>;
    status: { totalFailed: number; queueDepth: number };
  };
  taskStore: {
    comment(repoPath: string, taskId: string, text: string): Promise<void>;
    update(repoPath: string, taskId: string, fields: Record<string, unknown>): Promise<void>;
    sync(repoPath: string): Promise<void>;
    setCumulativeAttempts(
      repoPath: string,
      taskId: string,
      attempts: number,
      opts: { currentLabels: string[] }
    ): Promise<void>;
  };
  branchManager: {
    captureBranchDiff(repoPath: string, branchName: string): Promise<string>;
    captureUncommittedDiff(wtPath: string): Promise<string>;
    removeTaskWorktree(repoPath: string, taskId: string): Promise<void>;
    deleteBranch(repoPath: string, branchName: string): Promise<void>;
    revertAndReturnToMain(repoPath: string, branchName: string): Promise<void>;
  };
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
  projectService: {
    getSettings(projectId: string): Promise<{
      simpleComplexityAgent: { type: string; model?: string | null };
      complexComplexityAgent: { type: string; model?: string | null };
      gitWorkingMode?: "worktree" | "branches";
    }>;
  };
  persistCounters(projectId: string, repoPath: string): Promise<void>;
  deleteAssignment(repoPath: string, taskId: string): Promise<void>;
  transition(projectId: string, t: { to: "fail"; taskId: string }): void;
  nudge(projectId: string): void;
  removeSlot(
    state: { slots: Map<string, FailureSlot>; status: { activeTasks: unknown } },
    taskId: string
  ): void;
  executeCodingPhase(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    slot: FailureSlot,
    retryContext: RetryContext
  ): Promise<void>;
}

export interface FailureSlot {
  taskId: string;
  attempt: number;
  infraRetries: number;
  worktreePath: string | null;
  branchName: string;
  phaseResult: {
    codingDiff: string;
    codingSummary: string;
    testResults: TestResults | null;
    testOutput: string;
  };
  agent: { outputLog: string[]; startedAt: string; killedDueToTimeout: boolean };
}

export class FailureHandlerService {
  constructor(private host: FailureHandlerHost) {}

  async handleTaskFailure(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    reason: string,
    testResults?: TestResults | null,
    failureType: FailureType = "coding_failure",
    reviewFeedback?: string
  ): Promise<void> {
    const state = this.host.getState(projectId);
    const slot = state.slots.get(task.id);
    if (!slot) {
      log.warn("handleTaskFailure: no slot found for task", { taskId: task.id });
      return;
    }
    const cumulativeAttempts = slot.attempt;
    const wtPath = slot.worktreePath;
    const isInfraFailure = INFRA_FAILURE_TYPES.includes(failureType);

    log.error(`Task ${task.id} failed [${failureType}] (attempt ${cumulativeAttempts})`, {
      reason,
    });

    eventLogService
      .append(repoPath, {
        timestamp: new Date().toISOString(),
        projectId,
        taskId: task.id,
        event: `task.failed`,
        data: { failureType, attempt: cumulativeAttempts, reason: reason.slice(0, 500) },
      })
      .catch(() => {});

    const failSettings = await this.host.projectService.getSettings(projectId);
    const agentConfig = failSettings.simpleComplexityAgent;
    const gitWorkingMode = failSettings.gitWorkingMode ?? "worktree";
    agentIdentityService
      .recordAttempt(repoPath, {
        taskId: task.id,
        agentId: `${agentConfig.type}-${agentConfig.model ?? "default"}`,
        model: agentConfig.model ?? "unknown",
        attempt: cumulativeAttempts,
        startedAt: slot.agent.startedAt,
        completedAt: new Date().toISOString(),
        outcome: failureType as AttemptOutcome,
        durationMs: Date.now() - new Date(slot.agent.startedAt || Date.now()).getTime(),
      })
      .catch((err) => log.warn("Failed to record attempt", { err }));

    let previousDiff = "";
    let gitDiff = "";
    try {
      const branchDiff = await this.host.branchManager.captureBranchDiff(repoPath, branchName);
      previousDiff = branchDiff;
      let uncommittedDiff = "";
      if (wtPath) {
        uncommittedDiff = await this.host.branchManager.captureUncommittedDiff(wtPath);
      }
      gitDiff = [branchDiff, uncommittedDiff]
        .filter(Boolean)
        .join("\n\n--- Uncommitted changes ---\n\n");
    } catch {
      // Branch may not exist
    }

    const session = await this.host.sessionManager.createSession(repoPath, {
      taskId: task.id,
      attempt: cumulativeAttempts,
      agentType: agentConfig.type,
      agentModel: agentConfig.model || "",
      gitBranch: branchName,
      status: "failed",
      outputLog: slot.agent.outputLog.join(""),
      failureReason: reason,
      testResults: testResults ?? undefined,
      gitDiff: gitDiff || undefined,
      startedAt: slot.agent.startedAt,
    });
    await this.host.sessionManager.archiveSession(
      repoPath,
      task.id,
      cumulativeAttempts,
      session,
      wtPath ?? undefined
    );

    const inactivityMinutes = Math.round(AGENT_INACTIVITY_TIMEOUT_MS / (60 * 1000));
    const commentText =
      failureType === "timeout"
        ? `Attempt ${cumulativeAttempts} failed [timeout]: Agent stopped responding (${inactivityMinutes} min inactivity); task requeued.`
        : failureType === "review_rejection" && reviewFeedback
          ? `Review rejected (attempt ${cumulativeAttempts}):\n\n${reviewFeedback.slice(0, 2000)}`
          : `Attempt ${cumulativeAttempts} failed [${failureType}]: ${reason.slice(0, 500)}`;
    await this.host.taskStore
      .comment(repoPath, task.id, commentText)
      .catch((err) => log.warn("Failed to add failure comment", { err }));

    if (isInfraFailure && slot.infraRetries < MAX_INFRA_RETRIES) {
      slot.infraRetries += 1;
      slot.attempt = cumulativeAttempts + 1;
      log.info(`Infrastructure retry ${slot.infraRetries}/${MAX_INFRA_RETRIES} for ${task.id}`, {
        failureType,
      });

      await this.revertOrRemoveWorktree(repoPath, task.id, branchName, slot, gitWorkingMode);

      await this.host.persistCounters(projectId, repoPath);
      await this.host.executeCodingPhase(projectId, repoPath, task, slot, {
        previousFailure: reason,
        reviewFeedback,
        useExistingBranch: true,
        previousDiff,
        previousTestOutput: slot.phaseResult.testOutput || undefined,
        failureType,
      });
      return;
    }

    if (!isInfraFailure) {
      slot.infraRetries = 0;
    }

    await this.host.taskStore.setCumulativeAttempts(repoPath, task.id, cumulativeAttempts, {
      currentLabels: (task.labels ?? []) as string[],
    });

    const isDemotionPoint = cumulativeAttempts % BACKOFF_FAILURE_THRESHOLD === 0;

    if (!isDemotionPoint) {
      await this.revertOrRemoveWorktree(repoPath, task.id, branchName, slot, gitWorkingMode);

      slot.attempt = cumulativeAttempts + 1;
      log.info(`Retrying ${task.id} (attempt ${slot.attempt}), preserving branch`);

      await this.host.persistCounters(projectId, repoPath);

      await this.host.executeCodingPhase(projectId, repoPath, task, slot, {
        previousFailure: reason,
        reviewFeedback,
        useExistingBranch: true,
        previousDiff,
        previousTestOutput: slot.phaseResult.testOutput || undefined,
        failureType,
      });
    } else {
      await this.revertOrRemoveWorktree(repoPath, task.id, branchName, slot, gitWorkingMode, {
        deleteBranch: true,
      });
      await this.host.deleteAssignment(repoPath, task.id);

      const currentPriority = task.priority ?? 2;

      if (currentPriority >= MAX_PRIORITY_BEFORE_BLOCK) {
        await this.blockTask(projectId, repoPath, task, cumulativeAttempts, reason);
      } else {
        const newPriority = currentPriority + 1;
        log.info(
          `Demoting ${task.id} priority ${currentPriority} → ${newPriority} after ${cumulativeAttempts} failures`
        );

        try {
          await this.host.taskStore.update(repoPath, task.id, {
            status: "open",
            assignee: "",
            priority: newPriority,
          });
        } catch {
          // Task may already be in the right state
        }

        this.host.transition(projectId, { to: "fail", taskId: task.id });
        await this.host.persistCounters(projectId, repoPath);

        broadcastToProject(projectId, {
          type: "task.updated",
          taskId: task.id,
          status: "open",
          assignee: null,
        });
        broadcastToProject(projectId, {
          type: "agent.completed",
          taskId: task.id,
          status: "failed",
          testResults: null,
          reason: reason.slice(0, 500),
        });

        this.host.nudge(projectId);
      }
    }
  }

  /**
   * Revert and cleanup on failure. In Branches mode: revertAndReturnToMain (no worktree).
   * In Worktree mode: removeTaskWorktree (and optionally deleteBranch for demotion).
   */
  private async revertOrRemoveWorktree(
    repoPath: string,
    taskId: string,
    branchName: string,
    slot: FailureSlot,
    gitWorkingMode: "worktree" | "branches",
    options?: { deleteBranch?: boolean }
  ): Promise<void> {
    if (gitWorkingMode === "branches") {
      await this.host.branchManager.revertAndReturnToMain(repoPath, branchName);
      slot.worktreePath = null;
      return;
    }
    if (slot.worktreePath) {
      await this.host.branchManager.removeTaskWorktree(repoPath, taskId, slot.worktreePath);
      slot.worktreePath = null;
    }
    if (options?.deleteBranch) {
      await this.host.branchManager.deleteBranch(repoPath, branchName);
    }
  }

  async blockTask(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    cumulativeAttempts: number,
    reason: string
  ): Promise<void> {
    log.info(`Blocking ${task.id} after ${cumulativeAttempts} cumulative failures at max priority`);

    try {
      await this.host.taskStore.update(repoPath, task.id, {
        status: "blocked",
        assignee: "",
        block_reason: "Coding Failure",
      });
    } catch (err) {
      log.warn("Failed to block task", { err });
    }

    this.host.transition(projectId, { to: "fail", taskId: task.id });
    await this.host.persistCounters(projectId, repoPath);

    broadcastToProject(projectId, {
      type: "task.blocked",
      taskId: task.id,
      reason: `Blocked after ${cumulativeAttempts} failed attempts: ${reason.slice(0, 300)}`,
      cumulativeAttempts,
    });
    broadcastToProject(projectId, {
      type: "task.updated",
      taskId: task.id,
      status: "blocked",
      assignee: null,
      blockReason: "Coding Failure",
    });
    broadcastToProject(projectId, {
      type: "agent.completed",
      taskId: task.id,
      status: "failed",
      testResults: null,
      reason: reason.slice(0, 300),
    });

    this.host.nudge(projectId);
  }
}
