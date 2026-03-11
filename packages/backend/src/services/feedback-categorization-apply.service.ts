/**
 * Apply categorization result — link validation, retry cap, task creation/linking.
 * Extracted from feedback.service for maintainability.
 */

import type { FeedbackItem } from "@opensprint/shared";
import { taskStore as taskStoreSingleton } from "./task-store.service.js";
import { feedbackStore } from "./feedback-store.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { createLogger } from "../utils/logger.js";
import type { FeedbackTaskCreationService } from "./feedback-task-creation.service.js";

const log = createLogger("feedback-categorization-apply");

const LINK_INVALID_RETRY_CAP = 2;

export interface CategorizationApplyResult {
  linkIds: string[];
  similarExistingTaskId: string | null;
  updateExistingTasks: Record<string, { title?: string; description?: string }>;
}

export interface FeedbackCategorizationApplyDeps {
  taskCreationService: FeedbackTaskCreationService;
  saveFeedback: (projectId: string, item: FeedbackItem) => Promise<void>;
  enqueueForCategorization: (projectId: string, feedbackId: string) => Promise<void>;
}

/**
 * Apply categorization result: link to existing tasks or create new ones.
 * Handles link validation retry and fallback to create path.
 */
export async function applyCategorizationResult(
  projectId: string,
  item: FeedbackItem,
  result: CategorizationApplyResult,
  deps: FeedbackCategorizationApplyDeps
): Promise<void> {
  const { linkIds, similarExistingTaskId, updateExistingTasks } = result;

  try {
    if (linkIds.length > 0) {
      const allTasks = await taskStoreSingleton.listAll(projectId);
      const validIds = new Set(
        allTasks
          .filter(
            (t) =>
              (t.status as string) === "open" &&
              (t.issue_type ?? t.type) !== "epic" &&
              (t.issue_type ?? t.type) !== "chore"
          )
          .map((t) => t.id)
      );
      const invalidIds = linkIds.filter((id) => !validIds.has(id));
      if (invalidIds.length > 0) {
        const fresh = await feedbackStore.getFeedback(projectId, item.id);
        const retryCount = fresh.linkInvalidRetryCount ?? 0;
        log.warn("Invalid task IDs in link_to_existing_task_ids", {
          feedbackId: item.id,
          invalidIds: [...new Set(invalidIds)],
          retryCount,
        });
        if (retryCount >= LINK_INVALID_RETRY_CAP) {
          log.warn("Link invalid retry cap exceeded, falling back to create path", {
            feedbackId: item.id,
          });
          item.createdTaskIds = await deps.taskCreationService.createTasksFromFeedback(
            projectId,
            item,
            similarExistingTaskId ?? undefined
          );
        } else {
          item.linkInvalidRetryCount = retryCount + 1;
          await deps.saveFeedback(projectId, item);
          await deps.enqueueForCategorization(projectId, item.id);
          return;
        }
      } else {
        item.createdTaskIds = await deps.taskCreationService.linkFeedbackToExistingTasks(
          projectId,
          item,
          linkIds,
          updateExistingTasks
        );
      }
    } else {
      item.createdTaskIds = await deps.taskCreationService.createTasksFromFeedback(
        projectId,
        item,
        similarExistingTaskId ?? undefined
      );
    }
  } catch (err) {
    log.error("Failed to create or link tasks", { feedbackId: item.id, err });
  }
  item.status = "pending";

  await deps.saveFeedback(projectId, item);

  broadcastToProject(projectId, {
    type: "feedback.updated",
    feedbackId: item.id,
    planId: item.mappedPlanId || "",
    taskIds: item.createdTaskIds,
    item,
  });
}
