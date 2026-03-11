/**
 * Feedback submission flow — validation, image handling, item creation.
 * Extracted from feedback.service for maintainability.
 */

import type { FeedbackItem, FeedbackSubmitRequest } from "@opensprint/shared";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { feedbackStore, writeFeedbackImages } from "./feedback-store.service.js";

export interface FeedbackSubmitDeps {
  enqueueForCategorization: (projectId: string, feedbackId: string) => Promise<void>;
}

/**
 * Submit new feedback with validation and enqueue for AI categorization.
 */
export async function submitFeedback(
  projectId: string,
  body: FeedbackSubmitRequest,
  deps: FeedbackSubmitDeps
): Promise<FeedbackItem> {
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) {
    throw new AppError(400, ErrorCodes.INVALID_INPUT, "Feedback text is required");
  }
  const id = await feedbackStore.generateUniqueFeedbackId(projectId);

  const parentId =
    typeof body?.parent_id === "string" && body.parent_id.trim() ? body.parent_id.trim() : null;
  let depth = 0;
  if (parentId) {
    try {
      const parent = await feedbackStore.getFeedback(projectId, parentId);
      depth = (parent.depth ?? 0) + 1;
    } catch {
      throw new AppError(
        404,
        ErrorCodes.FEEDBACK_NOT_FOUND,
        `Parent feedback '${parentId}' not found`,
        { feedbackId: parentId }
      );
    }
  }

  const images: string[] = [];
  if (Array.isArray(body?.images)) {
    for (const img of body.images) {
      if (typeof img === "string" && img.length > 0) {
        const base64 = img.startsWith("data:") ? img : `data:image/png;base64,${img}`;
        images.push(base64);
      }
    }
  }

  const userPriority =
    typeof body?.priority === "number" && body.priority >= 0 && body.priority <= 4
      ? body.priority
      : undefined;

  const mappedPlanId =
    typeof body?.planId === "string" && body.planId.trim() ? body.planId.trim() : null;
  const planVersionNumber =
    typeof body?.planVersionNumber === "number" && body.planVersionNumber >= 1
      ? body.planVersionNumber
      : undefined;

  const item: FeedbackItem = {
    id,
    text,
    category: "bug",
    mappedPlanId: mappedPlanId ?? null,
    createdTaskIds: [],
    status: "pending",
    createdAt: new Date().toISOString(),
    parent_id: parentId ?? null,
    depth,
    ...(userPriority !== undefined && { userPriority }),
    ...(planVersionNumber !== undefined && { planVersionNumber }),
    ...(mappedPlanId && { submittedPlanId: mappedPlanId }),
  };

  const imagePaths = images.length > 0 ? await writeFeedbackImages(projectId, id, images) : null;
  await feedbackStore.insertFeedback(projectId, item, imagePaths);
  await deps.enqueueForCategorization(projectId, id);

  return feedbackStore.getFeedback(projectId, id);
}
