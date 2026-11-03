import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredTask } from "../services/task-store.service.js";
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  pin: vi.fn(),
  accept: vi.fn(),
  authority: vi.fn(),
  lease: vi.fn(),
}));
vi.mock("../services/remote-publication-governance.service.js", () => ({
  remotePublicationGovernanceService: {
    getRemoteReviewRequest: mocks.request,
    acceptRemoteReview: mocks.accept,
  },
}));
vi.mock("../services/governance.service.js", () => ({
  governanceService: {
    getTaskPin: mocks.pin,
    withPublicationLock: async (_: string, fn: (lease: () => Promise<void>) => Promise<void>) =>
      fn(mocks.lease),
  },
}));
vi.mock("../services/governance-execution.service.js", () => ({
  governanceExecutionService: { assertPublicationAuthority: mocks.authority },
}));
import {
  getTrustedRemoteReviewRequest,
  resolveTaskReviewBase,
  acceptRemoteReviewIfRequested,
} from "../services/remote-publication-review-context.js";
const request = {
  taskId: "remote-task",
  receiptIds: ["receipt"],
  baseSha: "a".repeat(40),
  candidateSha: "b".repeat(40),
  baseBranch: "main",
  branchName: "opensprint/remote-task",
  worktreePath: "/repo/.opensprint/runtime/worktrees/remote-task",
  reason: "Merger changed code",
};
const task = { id: request.taskId, remotePublicationReview: { baseSha: "forged" } } as StoredTask;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.request.mockResolvedValue(request);
  mocks.pin.mockResolvedValue({ ...request, baseBranch: request.baseSha });
});
describe("trusted remote review lifecycle", () => {
  it("preserves ordinary review base and does not consult remote authority without a routing hint", async () => {
    expect(await resolveTaskReviewBase("p", { id: "ordinary" } as StoredTask, "main")).toBe("main");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("ignores editable task metadata and reviews the complete origin-to-candidate contribution", async () => {
    expect(await resolveTaskReviewBase("p", task, "main")).toBe(request.baseSha);
    expect(await getTrustedRemoteReviewRequest("p", task)).toEqual(request);
  });
  it("rejects a routing hint without the original immutable event or matching pinned workspace", async () => {
    mocks.request.mockResolvedValue(null);
    await expect(getTrustedRemoteReviewRequest("p", task)).rejects.toThrow(
      /original durable request/
    );
    mocks.request.mockResolvedValue(request);
    mocks.pin.mockResolvedValue({
      ...request,
      baseBranch: request.baseSha,
      worktreePath: "/other",
    });
    await expect(getTrustedRemoteReviewRequest("p", task)).rejects.toThrow(
      /original durable request/
    );
  });
  it("serializes final approval before superseding receipts and withholds acceptance on a fresh hold", async () => {
    mocks.authority.mockRejectedValueOnce(new Error("new hold"));
    const input = {
      projectId: "p",
      task,
      repoPath: "/repo",
      cwd: request.worktreePath,
      branchName: request.branchName,
    };
    await expect(acceptRemoteReviewIfRequested(input)).rejects.toThrow("new hold");
    expect(mocks.accept).not.toHaveBeenCalled();
    await acceptRemoteReviewIfRequested(input);
    expect(mocks.accept).toHaveBeenCalledWith({
      projectId: "p",
      taskId: task.id,
      repoPath: "/repo",
      cwd: request.worktreePath,
      branchName: request.branchName,
    });
    expect(mocks.lease).toHaveBeenCalledTimes(2);
  });
});
