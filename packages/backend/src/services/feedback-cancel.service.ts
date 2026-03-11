/**
 * Feedback cancellation flow — stop agents, delete tasks, delete feedback.
 * Extracted from feedback.service for maintainability.
 */

import type { FeedbackItem } from "@opensprint/shared";
import { taskStore as taskStoreSingleton } from "./task-store.service.js";
import { feedbackStore } from "./feedback-store.service.js";
import { orchestratorService } from "./orchestrator.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("feedback-cancel");

export interface FeedbackCancelDeps {
  getFeedback: (projectId: string, feedbackId: string) => Promise<FeedbackItem>;
}

/**
 * Cancel pending feedback: stop agents, delete tasks, delete feedback.
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

  const taskIdsToDelete: string[] = [...(item.createdTaskIds ?? [])];
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
