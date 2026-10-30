import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSettings } from "@opensprint/shared";
import type { StoredTask } from "../services/task-store.service.js";
import {
  OrchestratorReviewService,
  type OrchestratorReviewHost,
} from "../services/orchestrator-review.service.js";
const calls = vi.hoisted(() => ({
  approved: vi.fn(),
  accept: vi.fn(),
  merge: vi.fn(),
  failure: vi.fn(),
}));
vi.mock("../services/governance-execution.service.js", () => ({
  governanceExecutionService: { approved: calls.approved },
}));
vi.mock("../services/governance.service.js", () => ({ governanceService: {} }));
vi.mock("../services/remote-publication-review-context.js", () => ({
  resolveTaskReviewBase: async (_p: string, _t: unknown, base: string) => base,
  acceptRemoteReviewIfRequested: calls.accept,
}));
vi.mock("../websocket/index.js", () => ({ broadcastToProject: vi.fn() }));
vi.mock("../services/review-synthesizer.service.js", () => ({ reviewSynthesizerService: {} }));
const task = {
  id: "os-remote",
  remotePublicationReview: { receiptIds: ["original"] },
} as StoredTask;
let review: OrchestratorReviewService;
beforeEach(() => {
  vi.resetAllMocks();
  const host = {
    getState: () => ({
      slots: new Map([[task.id, { worktreePath: "/retained", phaseResult: {} }]]),
      status: { queueDepth: 0 },
    }),
    mergeCoordinator: { performMergeAndDone: calls.merge },
    failureHandler: { handleTaskFailure: calls.failure },
    formatQualityGateFailureReason: () => "hard gate failed",
    applyQualityGateFailure: vi.fn(),
    clearQualityGateDetail: vi.fn(),
  } as unknown as OrchestratorReviewHost;
  review = new OrchestratorReviewService(host);
});
describe("remote publication joins all checks before accepting replacement authority", () => {
  it("waits for every reviewer and the hardcheck outcome before accepting and merging", async () => {
    const coordinator = review.createReviewPhaseCoordinator("p", "/repo", task, "review-branch", {
      reviewAngles: ["security"],
      includeGeneralReview: true,
    } as ProjectSettings);
    await coordinator.setReviewOutcome({ status: "approved", exitCode: 0 }, "security");
    await coordinator.setTestOutcome({ status: "passed" });
    expect(calls.accept).not.toHaveBeenCalled();
    expect(calls.merge).not.toHaveBeenCalled();
    await coordinator.setReviewOutcome({ status: "approved", exitCode: 0 });
    expect(calls.approved).toHaveBeenCalledWith("p", task.id, "/retained");
    expect(calls.accept).toHaveBeenCalledWith({
      projectId: "p",
      task,
      repoPath: "/repo",
      cwd: "/retained",
      branchName: "review-branch",
    });
    expect(calls.merge).toHaveBeenCalledOnce();
    expect(calls.approved.mock.invocationCallOrder[0]).toBeLessThan(
      calls.accept.mock.invocationCallOrder[0]!
    );
    expect(calls.accept.mock.invocationCallOrder[0]).toBeLessThan(
      calls.merge.mock.invocationCallOrder[0]!
    );
  });
  it("cannot supersede original receipts when a hard gate fails despite approving reviewers", async () => {
    await review.resolveTestAndReview(
      "p",
      "/repo",
      task,
      "review-branch",
      { status: "failed", failureType: "merge_quality_gate" },
      { status: "approved", exitCode: 0 }
    );
    expect(calls.approved).not.toHaveBeenCalled();
    expect(calls.accept).not.toHaveBeenCalled();
    expect(calls.merge).not.toHaveBeenCalled();
    expect(calls.failure).toHaveBeenCalledOnce();
  });
  it("withholds merge and records failure when authority changes at the final acceptance seam", async () => {
    calls.accept.mockRejectedValue(new Error("ruling revoked"));
    await review.resolveTestAndReview(
      "p",
      "/repo",
      task,
      "review-branch",
      { status: "passed" },
      { status: "approved", exitCode: 0 }
    );
    expect(calls.merge).not.toHaveBeenCalled();
    expect(calls.failure).toHaveBeenCalledOnce();
  });
});
