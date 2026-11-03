import { finalReviewService } from "./final-review.service.js";

export interface PublishedPlanReviewInput {
  projectId: string;
  epicId: string;
  worktreePath: string;
  taskStore: {
    update(
      projectId: string,
      taskId: string,
      fields: { extra: Record<string, unknown> }
    ): Promise<unknown>;
  };
}

const inFlight = new Map<string, Promise<void>>();

/**
 * Complete the durable review stage after publishing a plan PR. Coordinator and recovery
 * callers share one review; failures leave the pending receipt intact for a later retry.
 */
export function reviewPublishedPlanPullRequest(input: PublishedPlanReviewInput): Promise<void> {
  const { projectId, epicId, worktreePath, taskStore } = input;
  const key = JSON.stringify([projectId, epicId]);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const review = Promise.resolve()
    .then(async () => {
      const result = await finalReviewService.runFinalReview(projectId, epicId, worktreePath);
      if (result?.status === "issues") {
        await finalReviewService.createTasksFromReview(projectId, epicId, result.proposedTasks);
      }
      // Do not release the PR merge gate until any follow-up tasks have been saved.
      await taskStore.update(projectId, epicId, { extra: { final_review_pending: false } });
    })
    .finally(() => {
      if (inFlight.get(key) === review) inFlight.delete(key);
    });
  inFlight.set(key, review);
  return review;
}
