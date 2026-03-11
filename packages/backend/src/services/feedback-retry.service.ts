/**
 * Retry logic for pending feedback categorizations.
 * Extracted from feedback.service for maintainability.
 */

import type { FeedbackItem } from "@opensprint/shared";
import { createLogger } from "../utils/logger.js";

const log = createLogger("feedback-retry");

export interface FeedbackRetryDeps {
  listFeedback: (projectId: string) => Promise<FeedbackItem[]>;
  listPendingFeedbackIds: (projectId: string) => Promise<string[]>;
  enqueueForCategorization: (projectId: string, feedbackId: string) => Promise<void>;
}

/**
 * Enqueue all feedback items still in 'pending' status for the orchestrator to process.
 */
export async function retryPendingCategorizations(
  projectId: string,
  deps: FeedbackRetryDeps
): Promise<number> {
  const items = await deps.listFeedback(projectId);
  const pending = items.filter(
    (item) => item.status === "pending" && (item.createdTaskIds?.length ?? 0) === 0
  );
  if (pending.length === 0) return 0;

  const existing = new Set(await deps.listPendingFeedbackIds(projectId));
  let enqueued = 0;
  for (const item of pending) {
    if (!existing.has(item.id)) {
      await deps.enqueueForCategorization(projectId, item.id);
      existing.add(item.id);
      enqueued++;
    }
  }
  if (enqueued > 0) {
    log.info("Enqueued pending feedback for Analyst", { count: enqueued });
  }
  return enqueued;
}
