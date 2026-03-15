/**
 * Feedback cancellation flow — stop agents, delete tasks, delete feedback.
 * Extracted from feedback.service for maintainability.
 */

import type { FeedbackItem } from "@opensprint/shared";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { taskStore as taskStoreSingleton } from "./task-store.service.js";
import { feedbackStore } from "./feedback-store.service.js";
import { orchestratorService } from "./orchestrator.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { createLogger } from "../utils/logger.js";
import { activeAgentsService } from "./active-agents.service.js";

const log = createLogger("feedback-cancel");

export interface FeedbackCancelDeps {
  getFeedback: (projectId: string, feedbackId: string) => Promise<FeedbackItem>;
}

/**
 * Cancel pending feedback: stop agents, delete tasks, delete feedback.
 * Rejects with 409 if any linked task is done (status closed).
 */
export async function cancelFeedback(
  projectId: string,
  feedbackId: string,
  deps: FeedbackCancelDeps
): Promise<FeedbackItem> {
  const item = await deps.getFeedback(projectId, feedbackId);
  if (item.status !== "pending") {
    return item;
  }

  // Unregister any Analyst agent currently categorizing this feedback so UI stops showing "Categorizing…"
  for (const entry of activeAgentsService.listEntries(projectId)) {
    if (entry.feedbackId === feedbackId) {
      activeAgentsService.unregister(entry.id);
      log.info("Unregistered Analyst agent on cancel", {
        projectId,
        feedbackId,
        agentId: entry.id,
      });
    }
  }

  const createdIds = item.createdTaskIds ?? [];
  for (const taskId of createdIds) {
    try {
      const task = await taskStoreSingleton.show(projectId, taskId);
      if (task.status === "closed") {
        throw new AppError(
          409,
          ErrorCodes.FEEDBACK_HAS_DONE_TASK,
          "Cannot cancel feedback once at least one linked task is done",
          { feedbackId, doneTaskId: taskId }
        );
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      log.warn("Task not found when checking done (may have been deleted)", {
        projectId,
        taskId,
      });
    }
  }

  const taskIdsToDelete: string[] = [...createdIds];
  if (item.feedbackSourceTaskId) {
    taskIdsToDelete.push(item.feedbackSourceTaskId);
  }

  for (const taskId of taskIdsToDelete) {
    try {
      await orchestratorService.stopTaskAndFreeSlot(projectId, taskId);
    } catch (err) {
      log.warn("stopTaskAndFreeSlot on cancel (may not have active agent)", {
        projectId,
        taskId,
        err,
      });
    }
  }

  if (taskIdsToDelete.length > 0) {
    await taskStoreSingleton.deleteMany(projectId, taskIdsToDelete);
  }

  await feedbackStore.deleteFeedback(projectId, feedbackId);

  const cancelledItem: FeedbackItem = { ...item, status: "cancelled" };
  broadcastToProject(projectId, {
    type: "feedback.resolved",
    feedbackId: item.id,
    item: cancelledItem,
  });

  return cancelledItem;
}
