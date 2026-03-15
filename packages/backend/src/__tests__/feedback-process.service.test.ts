import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FeedbackItem } from "@opensprint/shared";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { processFeedbackWithAnalyst } from "../services/feedback-process.service.js";

const mockApply = vi.fn();
vi.mock("../services/feedback-categorization-apply.service.js", () => ({
  applyCategorizationResult: (...args: unknown[]) => mockApply(...args),
}));

describe("feedback-process.service", () => {
  const projectId = "proj-1";
  const feedbackId = "fb-1";
  const pendingItem: FeedbackItem = {
    id: feedbackId,
    text: "Some feedback",
    category: "bug",
    mappedPlanId: null,
    createdTaskIds: [],
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  beforeEach(() => {
    mockApply.mockClear();
  });

  it("skips apply when feedback was deleted (FEEDBACK_NOT_FOUND) after categorize", async () => {
    const getFeedback = vi
      .fn()
      .mockResolvedValueOnce({ ...pendingItem })
      .mockRejectedValueOnce(
        new AppError(404, ErrorCodes.FEEDBACK_NOT_FOUND, "Not found", { feedbackId })
      );

    const categorize = vi.fn().mockResolvedValue({
      done: false,
      linkIds: [],
      similarExistingTaskId: null,
      updateExistingTasks: {},
    });

    await processFeedbackWithAnalyst(projectId, feedbackId, {
      getFeedback,
      saveFeedback: vi.fn(),
      enqueueForCategorization: vi.fn(),
      categorizationService: { categorize },
      taskCreationService: {} as never,
    });

    expect(categorize).toHaveBeenCalled();
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("skips apply when feedback status is no longer pending after categorize", async () => {
    const getFeedback = vi
      .fn()
      .mockResolvedValueOnce({ ...pendingItem })
      .mockResolvedValueOnce({ ...pendingItem, status: "cancelled" as const });

    const categorize = vi.fn().mockResolvedValue({
      done: false,
      linkIds: [],
      similarExistingTaskId: null,
      updateExistingTasks: {},
    });

    await processFeedbackWithAnalyst(projectId, feedbackId, {
      getFeedback,
      saveFeedback: vi.fn(),
      enqueueForCategorization: vi.fn(),
      categorizationService: { categorize },
      taskCreationService: {} as never,
    });

    expect(categorize).toHaveBeenCalled();
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("calls apply when feedback still exists and is pending after categorize", async () => {
    const getFeedback = vi.fn().mockResolvedValue({ ...pendingItem });

    const categorize = vi.fn().mockResolvedValue({
      done: false,
      linkIds: [],
      similarExistingTaskId: null,
      updateExistingTasks: {},
    });

    await processFeedbackWithAnalyst(projectId, feedbackId, {
      getFeedback,
      saveFeedback: vi.fn(),
      enqueueForCategorization: vi.fn(),
      categorizationService: { categorize },
      taskCreationService: {} as never,
    });

    expect(mockApply).toHaveBeenCalledTimes(1);
  });
});
