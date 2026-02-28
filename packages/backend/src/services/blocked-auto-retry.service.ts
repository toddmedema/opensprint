/**
 * Auto-retry service for tasks blocked by technical errors.
 *
 * Runs every 8 hours. Unblocks tasks with block_reason "Merge Failure" or "Coding Failure"
 * (technical errors). Never retries tasks blocked on human feedback (e.g. Open Question, API blocked).
 * Limits retry to once per 8-hour window per task via last_auto_retry_at.
 */

import { AUTO_RETRY_BLOCKED_INTERVAL_MS } from "@opensprint/shared";
import { taskStore } from "./task-store.service.js";
import { orchestratorService } from "./orchestrator.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("blocked-auto-retry");

export interface BlockedAutoRetryTarget {
  projectId: string;
  repoPath: string;
}

let interval: ReturnType<typeof setInterval> | null = null;

/**
 * Run one auto-retry pass: for each project, unblock tasks blocked by technical errors
 * that are eligible (last_auto_retry_at null or > 8 hours ago).
 */
export async function runBlockedAutoRetryPass(
  getTargets: () => Promise<BlockedAutoRetryTarget[]>
): Promise<{ projectId: string; taskId: string }[]> {
  const targets = await getTargets();
  const retried: { projectId: string; taskId: string }[] = [];

  for (const target of targets) {
    try {
      const eligible = await taskStore.listBlockedByTechnicalErrorEligibleForRetry(
        target.projectId
      );
      for (const task of eligible) {
        try {
          const now = new Date().toISOString();
          await taskStore.update(target.projectId, task.id, {
            status: "open",
            block_reason: null,
            last_auto_retry_at: now,
          });
          retried.push({ projectId: target.projectId, taskId: task.id });
          log.info("Auto-retried task blocked by technical error", {
            projectId: target.projectId,
            taskId: task.id,
            blockReason: task.block_reason,
          });
          broadcastToProject(target.projectId, {
            type: "task.updated",
            taskId: task.id,
            status: "open",
            assignee: null,
            blockReason: null,
          });
          orchestratorService.nudge(target.projectId);
        } catch (err) {
          log.warn("Failed to auto-retry task", {
            projectId: target.projectId,
            taskId: task.id,
            err: (err as Error).message,
          });
        }
      }
    } catch (err) {
      log.warn("Auto-retry pass failed for project", {
        projectId: target.projectId,
        err: (err as Error).message,
      });
    }
  }

  if (retried.length > 0) {
    log.info("Blocked auto-retry pass completed", {
      retriedCount: retried.length,
      retried: retried.map((r) => r.taskId),
    });
  }

  return retried;
}

/**
 * Start the 8-hour auto-retry timer. Runs immediately on start, then every 8 hours.
 */
export function startBlockedAutoRetry(
  getTargets: () => Promise<BlockedAutoRetryTarget[]>
): void {
  if (interval) return;

  const run = () => {
    runBlockedAutoRetryPass(getTargets).catch((err) => {
      log.warn("Blocked auto-retry pass failed", { err: (err as Error).message });
    });
  };

  run(); // Run immediately
  interval = setInterval(run, AUTO_RETRY_BLOCKED_INTERVAL_MS);
  log.info("Started blocked auto-retry", {
    intervalHours: AUTO_RETRY_BLOCKED_INTERVAL_MS / (60 * 60 * 1000),
  });
}

/**
 * Stop the 8-hour auto-retry timer.
 */
export function stopBlockedAutoRetry(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
    log.info("Stopped blocked auto-retry");
  }
}
