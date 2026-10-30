import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StoredTask } from "../services/task-store.service.js";
import type { RemoteReviewRequest } from "../services/remote-publication-governance.service.js";
import {
  OrchestratorDispatchService,
  type OrchestratorDispatchHost,
} from "../services/orchestrator-dispatch.service.js";
const calls = vi.hoisted(() => ({
  request: vi.fn(),
  cases: vi.fn(),
  lease: vi.fn(),
  restore: vi.fn(),
}));
vi.mock("../services/remote-publication-review-context.js", () => ({
  getTrustedRemoteReviewRequest: calls.request,
  restoreRemoteReviewWorkspace: calls.restore,
}));
vi.mock("../services/governance.service.js", () => ({
  governanceService: {
    hasTaskHold: async () => false,
    captureTrustedScope: async () => {},
    getTaskCases: calls.cases,
  },
}));
vi.mock("../services/worktree-lease.service.js", () => ({
  worktreeLeaseService: { acquire: calls.lease },
}));
vi.mock("../services/worktree-registry.js", () => ({
  worktreeRegistry: { transition: () => true },
}));
vi.mock("../utils/git-repo-state.js", () => ({ resolveBaseBranch: async () => "main" }));
const git = promisify(execFile);
let repo: string,
  request: RemoteReviewRequest,
  task: StoredTask,
  host: OrchestratorDispatchHost,
  service: OrchestratorDispatchService;
const coder = vi.fn(),
  review = vi.fn(),
  update = vi.fn(),
  ensureMain = vi.fn(),
  remove = vi.fn();
beforeEach(async () => {
  vi.clearAllMocks();
  calls.cases.mockResolvedValue([]);
  calls.restore.mockReset();
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "remote-dispatch-"));
  await git("git", ["init", "-b", "main"], { cwd: repo });
  await git("git", ["config", "user.name", "QA"], { cwd: repo });
  await git("git", ["config", "user.email", "qa@example.test"], { cwd: repo });
  await fs.writeFile(path.join(repo, "app.ts"), "export const value = 1;\n");
  await git("git", ["add", "."], { cwd: repo });
  await git("git", ["commit", "-m", "base"], { cwd: repo });
  const sha = (await git("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  request = {
    taskId: "os-review",
    receiptIds: ["retained"],
    baseSha: sha,
    candidateSha: sha,
    baseBranch: "main",
    branchName: "opensprint/os-review",
    worktreePath: path.join(repo, ".opensprint/runtime/worktrees/os-review"),
    reason: "Merger changed an anchor",
  };
  await fs.mkdir(path.dirname(request.worktreePath), { recursive: true });
  await git("git", ["worktree", "add", "-b", request.branchName, request.worktreePath, sha], {
    cwd: repo,
  });
  calls.request.mockResolvedValue(request);
  task = {
    id: request.taskId,
    title: "Review remote candidate",
    status: "open",
    dependencies: [],
    issue_type: "task",
    remotePublicationReview: { candidateSha: sha },
  } as unknown as StoredTask;
  const state = { nextCoderIndex: 0, status: { queueDepth: 0 }, slots: new Map() };
  host = {
    getState: () => state,
    createSlot: (taskId, taskTitle, branchName, attempt, assignee, worktreeKey) => ({
      taskId,
      taskTitle,
      branchName,
      attempt,
      assignee,
      worktreeKey,
      worktreePath: null,
    }),
    transition: vi.fn(),
    persistCounters: async () => {},
    getTaskStore: () => ({
      update,
      getCumulativeAttemptsFromIssue: () => 1,
      listAll: async () => [],
    }),
    getProjectService: () => ({
      getSettings: async () => ({ gitWorkingMode: "branches", mergeStrategy: "per_epic" }),
    }),
    getBranchManager: () => ({
      ensureOnMain: ensureMain,
      getWorktreePath: () => "/wrong-default",
      removeTaskWorktree: remove,
    }),
    getFileScopeAnalyzer: () => ({ predict: async () => ({}) }),
    executeCodingPhase: coder,
    resumeGovernanceTask: review,
    performMergeRetry: vi.fn(),
  } as OrchestratorDispatchHost;
  service = new OrchestratorDispatchService(host);
});
afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});
describe("remote review dispatch with retained real Git worktrees", () => {
  it("resumes review directly with the private branch after restart even when the transient resume flag was cleared", async () => {
    await service.dispatchTask("p", repo, task, 0);
    expect(review).toHaveBeenCalledWith(
      "p",
      repo,
      task,
      expect.objectContaining({
        branchName: request.branchName,
        worktreePath: request.worktreePath,
        worktreeKey: task.id,
      })
    );
    expect(coder).not.toHaveBeenCalled();
    expect(ensureMain).not.toHaveBeenCalled();
  });
  it("returns an actual failed review or hard gate to a coder for correction while preserving the private worktree", async () => {
    task = {
      ...task,
      next_retry_context: {
        previousFailure: "Gate failed",
        failureType: "merge_quality_gate",
        useExistingBranch: true,
      },
    } as StoredTask;
    await service.dispatchTask("p", repo, task, 0);
    expect(review).not.toHaveBeenCalled();
    expect(coder).toHaveBeenCalledWith(
      "p",
      repo,
      task,
      expect.objectContaining({ worktreePath: request.worktreePath }),
      expect.objectContaining({ failureType: "merge_quality_gate" })
    );
  });
  it("honors a safe human require-fix disposition without repeating an unchanged review forever", async () => {
    calls.cases.mockResolvedValue([{ state: "fix_required" }]);
    await service.dispatchTask("p", repo, task, 0);
    expect(review).not.toHaveBeenCalled();
    expect(coder).toHaveBeenCalledOnce();
  });
  it("recovers a missing private worktree from its retained branch before claiming review", async () => {
    await fs.rm(request.worktreePath, { recursive: true, force: true });
    calls.restore.mockImplementation(async () => {
      await git("git", ["worktree", "prune"], { cwd: repo });
      await git("git", ["worktree", "add", request.worktreePath, request.branchName], {
        cwd: repo,
      });
    });
    await service.dispatchTask("p", repo, task, 0);
    expect(calls.restore).toHaveBeenCalledWith("p", task, repo);
    expect(calls.restore.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0]!
    );
    expect(review).toHaveBeenCalledOnce();
    expect(coder).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
  it("does not rebuild a lost candidate from current main or destroy retained evidence", async () => {
    await fs.rm(request.worktreePath, { recursive: true, force: true });
    await expect(service.dispatchTask("p", repo, task, 0)).rejects.toThrow(
      /restore the pinned candidate/
    );
    expect(coder).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
  it("rejects an untrusted routing hint before claiming or spawning a task", async () => {
    calls.request.mockRejectedValue(new Error("No original durable request"));
    await expect(service.dispatchTask("p", repo, task, 0)).rejects.toThrow(
      /No original durable request/
    );
    expect(update).not.toHaveBeenCalled();
    expect(coder).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
  });
});
