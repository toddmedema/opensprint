/**
 * Process feedback with Analyst — orchestration, categorization, task creation, error handling.
 * Extracted from feedback.service for maintainability.
 */

import type { FeedbackItem } from "@opensprint/shared";
import { ErrorCodes } from "../middleware/error-codes.js";
import type { FeedbackCategorizationService } from "./feedback-categorization.service.js";
import type { FeedbackTaskCreationService } from "./feedback-task-creation.service.js";
import { applyCategorizationResult } from "./feedback-categorization-apply.service.js";

export interface FeedbackProcessDeps {
  getFeedback: (projectId: string, feedbackId: string) => Promise<FeedbackItem>;
  saveFeedback: (projectId: string, item: FeedbackItem) => Promise<void>;
  enqueueForCategorization: (projectId: string, feedbackId: string) => Promise<void>;
  categorizationService: FeedbackCategorizationService;
  taskCreationService: FeedbackTaskCreationService;
}

/**
 * Process feedback through Analyst: categorize, create/link tasks. Skips if already has tasks.
 * Re-enqueues on non-fatal errors.
 */
export async function processFeedbackWithAnalyst(
  projectId: string,
  feedbackId: string,
  deps: FeedbackProcessDeps
): Promise<void> {
  const item = await deps.getFeedback(projectId, feedbackId);
  if ((item.createdTaskIds?.length ?? 0) > 0) {
    return;
  }
  try {
    await runCategorization(projectId, item, deps);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === ErrorCodes.PROJECT_NOT_FOUND || code === ErrorCodes.FEEDBACK_NOT_FOUND) {
      throw err;
    }
    await deps.enqueueForCategorization(projectId, feedbackId);
    throw err;
  }
}

async function runCategorization(
  projectId: string,
  item: FeedbackItem,
  deps: FeedbackProcessDeps
): Promise<void> {
  const result = await deps.categorizationService.categorize(
    projectId,
    item,
    (p, f) => deps.getFeedback(p, f)
  );

  if (result.done) {
    return;
  }

  await applyCategorizationResult(
    projectId,
    item,
    {
      linkIds: result.linkIds,
      similarExistingTaskId: result.similarExistingTaskId,
      updateExistingTasks: result.updateExistingTasks,
    },
    {
      taskCreationService: deps.taskCreationService,
      saveFeedback: deps.saveFeedback,
      enqueueForCategorization: deps.enqueueForCategorization,
    }
  );
}
