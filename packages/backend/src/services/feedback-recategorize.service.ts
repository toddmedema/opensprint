/**
 * Recategorization flow — reset feedback state, append clarification, re-enqueue.
 * Extracted from feedback.service for maintainability.
 */

import type { FeedbackItem } from "@opensprint/shared";

export interface FeedbackRecategorizeDeps {
  getFeedback: (projectId: string, feedbackId: string) => Promise<FeedbackItem>;
  saveFeedback: (projectId: string, item: FeedbackItem) => Promise<void>;
  enqueueForCategorization: (projectId: string, feedbackId: string) => Promise<void>;
}

/**
 * Reset feedback to pending, optionally append clarification, and re-enqueue for categorization.
 */
export async function recategorizeFeedback(
  projectId: string,
  feedbackId: string,
  options: { answer?: string } | undefined,
  deps: FeedbackRecategorizeDeps
): Promise<FeedbackItem> {
  const item = await deps.getFeedback(projectId, feedbackId);
  item.status = "pending";
  item.category = "bug";
  item.mappedPlanId = null;
  item.mappedEpicId = undefined;
  item.isScopeChange = undefined;
  item.createdTaskIds = [];
  item.taskTitles = undefined;
  item.proposedTasks = undefined;

  if (options?.answer?.trim()) {
    const separator = "\n\n---\n\n**Clarification:** ";
    item.text = `${item.text}${separator}${options.answer.trim()}`;
  }

  await deps.saveFeedback(projectId, item);
  await deps.enqueueForCategorization(projectId, feedbackId);

  return item;
}
