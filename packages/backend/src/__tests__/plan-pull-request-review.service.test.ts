import { beforeEach, describe, expect, it, vi } from "vitest";
import { finalReviewService } from "../services/final-review.service.js";
import { reviewPublishedPlanPullRequest } from "../services/plan-pull-request-review.service.js";

vi.mock("../services/final-review.service.js", () => ({
  finalReviewService: {
    runFinalReview: vi.fn(),
    createTasksFromReview: vi.fn(),
  },
}));

const taskStore = { update: vi.fn() };
const input = {
  projectId: "project",
  epicId: "os-plan",
  worktreePath: "/tmp/plan-worktree",
  taskStore,
};
const pass = { status: "pass" as const, assessment: "Complete", proposedTasks: [] };
const issues = {
  status: "issues" as const,
  assessment: "Missing error handling",
  proposedTasks: [{ title: "Handle failed saves", description: "Keep unsaved data recoverable." }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(finalReviewService.runFinalReview).mockResolvedValue(pass);
  vi.mocked(finalReviewService.createTasksFromReview).mockResolvedValue(["os-plan.2"]);
  taskStore.update.mockResolvedValue(undefined);
});

describe("published plan PR review", () => {
  it("reviews the implementation worktree and clears the durable pending gate after passing", async () => {
    await reviewPublishedPlanPullRequest(input);

    expect(finalReviewService.runFinalReview).toHaveBeenCalledWith(
      "project",
      "os-plan",
      "/tmp/plan-worktree"
    );
    expect(finalReviewService.createTasksFromReview).not.toHaveBeenCalled();
    expect(taskStore.update).toHaveBeenCalledWith("project", "os-plan", {
      extra: { final_review_pending: false },
    });
  });

  it("keeps the merge gate closed until follow-up tasks have been saved", async () => {
    const saved = deferred<string[]>();
    vi.mocked(finalReviewService.runFinalReview).mockResolvedValue(issues);
    vi.mocked(finalReviewService.createTasksFromReview).mockReturnValue(saved.promise);

    const review = reviewPublishedPlanPullRequest(input);
    await vi.waitFor(() => expect(finalReviewService.createTasksFromReview).toHaveBeenCalled());
    expect(finalReviewService.createTasksFromReview).toHaveBeenCalledWith(
      "project",
      "os-plan",
      issues.proposedTasks
    );
    expect(taskStore.update).not.toHaveBeenCalled();

    saved.resolve(["os-plan.2"]);
    await review;
    expect(taskStore.update).toHaveBeenCalledWith("project", "os-plan", {
      extra: { final_review_pending: false },
    });
  });

  it("shares review and task creation between concurrent coordinator and recovery calls", async () => {
    const result = deferred<typeof issues>();
    vi.mocked(finalReviewService.runFinalReview).mockReturnValue(result.promise);

    const coordinatorReview = reviewPublishedPlanPullRequest(input);
    const recoveryReview = reviewPublishedPlanPullRequest({ ...input });
    expect(recoveryReview).toBe(coordinatorReview);
    await vi.waitFor(() => expect(finalReviewService.runFinalReview).toHaveBeenCalledTimes(1));

    result.resolve(issues);
    await Promise.all([coordinatorReview, recoveryReview]);
    expect(finalReviewService.createTasksFromReview).toHaveBeenCalledTimes(1);
    expect(taskStore.update).toHaveBeenCalledTimes(1);
  });

  it.each(["review", "task persistence", "gate persistence"])(
    "allows retry after failed %s without losing the pending receipt",
    async (stage) => {
      vi.mocked(finalReviewService.runFinalReview).mockResolvedValue(issues);
      if (stage === "review") {
        vi.mocked(finalReviewService.runFinalReview).mockRejectedValueOnce(
          new Error("review failed")
        );
      } else if (stage === "task persistence") {
        vi.mocked(finalReviewService.createTasksFromReview).mockRejectedValueOnce(
          new Error("task persistence failed")
        );
      } else {
        taskStore.update.mockRejectedValueOnce(new Error("gate persistence failed"));
      }

      await expect(reviewPublishedPlanPullRequest(input)).rejects.toThrow("failed");
      if (stage !== "gate persistence") expect(taskStore.update).not.toHaveBeenCalled();

      await reviewPublishedPlanPullRequest(input);
      expect(finalReviewService.runFinalReview).toHaveBeenCalledTimes(2);
      expect(taskStore.update).toHaveBeenLastCalledWith("project", "os-plan", {
        extra: { final_review_pending: false },
      });
    }
  );

  it("keeps independent projects and epics separate", async () => {
    await Promise.all([
      reviewPublishedPlanPullRequest(input),
      reviewPublishedPlanPullRequest({ ...input, projectId: "other-project" }),
      reviewPublishedPlanPullRequest({ ...input, epicId: "os-other-plan" }),
    ]);

    expect(finalReviewService.runFinalReview).toHaveBeenCalledTimes(3);
    expect(taskStore.update).toHaveBeenCalledTimes(3);
  });

  it("finishes the review stage when no plan review is required", async () => {
    vi.mocked(finalReviewService.runFinalReview).mockResolvedValue(null);
    await reviewPublishedPlanPullRequest(input);
    expect(finalReviewService.createTasksFromReview).not.toHaveBeenCalled();
    expect(taskStore.update).toHaveBeenCalledTimes(1);
  });
});
