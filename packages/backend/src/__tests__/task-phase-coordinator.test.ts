import type { TestResults, ReviewAgentResult } from "@opensprint/shared";
import { describe, it, expect, vi } from "vitest";
import {
  TaskPhaseCoordinator,
  type TestOutcome,
  type ReviewOutcome,
} from "../services/task-phase-coordinator.js";

describe("TaskPhaseCoordinator", () => {
  const testPassed: TestOutcome = { status: "passed" };
  const testFailedResults: TestResults = { passed: 3, failed: 2, total: 5, rawOutput: "" };
  const testFailed: TestOutcome = { status: "failed", results: testFailedResults };
  const reviewApproved: ReviewOutcome = { status: "approved", result: null, exitCode: 0 };
  const reviewRejectedResult: ReviewAgentResult = {
    status: "rejected",
    issues: ["nit"],
    summary: "Bad",
    notes: "",
  };
  const reviewRejected: ReviewOutcome = {
    status: "rejected",
    result: reviewRejectedResult,
    exitCode: 0,
  };

  it("calls resolve when both outcomes arrive (test first)", async () => {
    const resolve = vi.fn().mockResolvedValue(undefined);
    const coord = new TaskPhaseCoordinator("t1", resolve);

    coord.setTestOutcome(testPassed);
    expect(resolve).not.toHaveBeenCalled();

    coord.setReviewOutcome(reviewApproved);
    expect(resolve).toHaveBeenCalledWith(testPassed, reviewApproved);
  });

  it("calls resolve when both outcomes arrive (review first)", async () => {
    const resolve = vi.fn().mockResolvedValue(undefined);
    const coord = new TaskPhaseCoordinator("t1", resolve);

    coord.setReviewOutcome(reviewRejected);
    expect(resolve).not.toHaveBeenCalled();

    coord.setTestOutcome(testFailed);
    expect(resolve).toHaveBeenCalledWith(testFailed, reviewRejected);
  });

  it("resolves only once even if outcomes are set multiple times", () => {
    const resolve = vi.fn().mockResolvedValue(undefined);
    const coord = new TaskPhaseCoordinator("t1", resolve);

    coord.setTestOutcome(testPassed);
    coord.setReviewOutcome(reviewApproved);
    coord.setTestOutcome(testFailed);
    coord.setReviewOutcome(reviewRejected);

    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("ignores outcomes after resolution", () => {
    const resolve = vi.fn().mockResolvedValue(undefined);
    const coord = new TaskPhaseCoordinator("t1", resolve);

    coord.setTestOutcome(testPassed);
    coord.setReviewOutcome(reviewApproved);
    expect(resolve).toHaveBeenCalledTimes(1);

    coord.setTestOutcome(testFailed);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("does not throw when resolve rejects", () => {
    const resolve = vi.fn().mockRejectedValue(new Error("boom"));
    const coord = new TaskPhaseCoordinator("t1", resolve);

    expect(() => {
      coord.setTestOutcome(testPassed);
      coord.setReviewOutcome(reviewApproved);
    }).not.toThrow();
  });

  it("resolves with single angle when reviewAngles has one item", () => {
    const resolve = vi.fn().mockResolvedValue(undefined);
    const coord = new TaskPhaseCoordinator("t1", resolve, {
      reviewAngles: ["security"],
    });

    coord.setTestOutcome(testPassed);
    coord.setReviewOutcome(reviewApproved, "security");

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(
      testPassed,
      expect.objectContaining({ status: "approved" })
    );
  });

  it("waits for general and angle outcomes when includeGeneralReview is true", () => {
    const resolve = vi.fn().mockResolvedValue(undefined);
    const coord = new TaskPhaseCoordinator("t1", resolve, {
      reviewAngles: ["security"],
      includeGeneralReview: true,
    });

    coord.setTestOutcome(testPassed);
    coord.setReviewOutcome(reviewApproved, "security");
    expect(resolve).not.toHaveBeenCalled();

    coord.setReviewOutcome(reviewApproved); // general (no angle)
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(
      testPassed,
      expect.objectContaining({ status: "approved" })
    );
  });

  it("waits for all angle outcomes before resolving", () => {
    const resolve = vi.fn().mockResolvedValue(undefined);
    const coord = new TaskPhaseCoordinator("t1", resolve, {
      reviewAngles: ["security", "performance"],
    });

    coord.setTestOutcome(testPassed);
    coord.setReviewOutcome(reviewApproved, "security");
    expect(resolve).not.toHaveBeenCalled();

    coord.setReviewOutcome(reviewApproved, "performance");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(
      testPassed,
      expect.objectContaining({
        status: "approved",
      })
    );
  });

  it("aggregates rejected outcomes across angles", () => {
    const resolve = vi.fn().mockResolvedValue(undefined);
    const coord = new TaskPhaseCoordinator("t1", resolve, {
      reviewAngles: ["security", "performance", "code_quality"],
    });

    coord.setTestOutcome(testPassed);
    coord.setReviewOutcome(
      {
        status: "rejected",
        exitCode: 1,
        result: {
          status: "rejected",
          summary: "Security issue",
          issues: ["Unsanitized SQL input"],
          notes: "Use parameterized queries.",
        },
      },
      "security"
    );
    coord.setReviewOutcome(reviewApproved, "performance");
    coord.setReviewOutcome(
      {
        status: "rejected",
        exitCode: 1,
        result: {
          status: "rejected",
          summary: "Quality issue",
          issues: ["Dead code in handler"],
          notes: "Remove unused branch.",
        },
      },
      "code_quality"
    );

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(
      testPassed,
      expect.objectContaining({
        status: "rejected",
        result: expect.objectContaining({
          summary: expect.stringContaining("Security issue"),
          issues: expect.arrayContaining(["Unsanitized SQL input", "Dead code in handler"]),
        }),
      })
    );
  });

  it("returns no_result when any angle has no valid result", () => {
    const resolve = vi.fn().mockResolvedValue(undefined);
    const coord = new TaskPhaseCoordinator("t1", resolve, {
      reviewAngles: ["security", "performance"],
    });

    coord.setTestOutcome(testPassed);
    coord.setReviewOutcome(reviewApproved, "security");
    coord.setReviewOutcome(
      {
        status: "no_result",
        result: null,
        exitCode: 1,
        failureContext: [{ angle: "performance", exitCode: 1, reason: "Result file missing" }],
      },
      "performance"
    );

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(
      testPassed,
      expect.objectContaining({
        status: "no_result",
        failureContext: expect.arrayContaining([
          expect.objectContaining({
            angle: "performance",
            exitCode: 1,
            reason: "Result file missing",
          }),
        ]),
      })
    );
  });

  it("runs lead synthesizer when synthesizeReviewResults provided and multiple angles", async () => {
    const resolve = vi.fn().mockResolvedValue(undefined);
    const synthesized: ReviewOutcome = {
      status: "approved",
      result: {
        status: "approved",
        summary: "Synthesized: all angles passed",
        notes: "",
      },
      exitCode: 0,
    };
    const synthesizeReviewResults = vi.fn().mockResolvedValue(synthesized);
    const coord = new TaskPhaseCoordinator("t1", resolve, {
      reviewAngles: ["security", "performance"],
      synthesizeReviewResults,
    });

    coord.setTestOutcome(testPassed);
    coord.setReviewOutcome(reviewApproved, "security");
    coord.setReviewOutcome(reviewApproved, "performance");

    await new Promise((r) => setTimeout(r, 10));
    expect(synthesizeReviewResults).toHaveBeenCalledTimes(1);
    const outcomes = synthesizeReviewResults.mock.calls[0]![0];
    expect(outcomes.size).toBe(2);
    expect(outcomes.get("security")).toEqual(reviewApproved);
    expect(outcomes.get("performance")).toEqual(reviewApproved);
    expect(resolve).toHaveBeenCalledWith(testPassed, synthesized);
  });

  it("skips synthesis and resolves with no_result when any angle has no_result", () => {
    const resolve = vi.fn().mockResolvedValue(undefined);
    const synthesizeReviewResults = vi.fn();
    const coord = new TaskPhaseCoordinator("t1", resolve, {
      reviewAngles: ["security", "performance"],
      synthesizeReviewResults,
    });

    coord.setTestOutcome(testPassed);
    coord.setReviewOutcome(reviewApproved, "security");
    coord.setReviewOutcome({ status: "no_result", result: null, exitCode: 1 }, "performance");

    expect(synthesizeReviewResults).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(
      testPassed,
      expect.objectContaining({
        status: "no_result",
        failureContext: expect.arrayContaining([
          expect.objectContaining({ angle: "performance", exitCode: 1 }),
        ]),
      })
    );
  });

  it("skips synthesis and resolves with no_result when any angle has error", () => {
    const resolve = vi.fn().mockResolvedValue(undefined);
    const synthesizeReviewResults = vi.fn();
    const coord = new TaskPhaseCoordinator("t1", resolve, {
      reviewAngles: ["security", "performance"],
      synthesizeReviewResults,
    });

    coord.setTestOutcome(testPassed);
    coord.setReviewOutcome(reviewApproved, "security");
    coord.setReviewOutcome({ status: "error", result: null, exitCode: 1 }, "performance");

    expect(synthesizeReviewResults).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(
      testPassed,
      expect.objectContaining({ status: "no_result" })
    );
  });
});
