import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlanPullRequestReconciler } from "../services/plan-pull-request-reconcile.service.js";
import { runCommand } from "../utils/command-runner.js";
import { runGit } from "../utils/git-command.js";
import type { StoredTask } from "../services/task-store.types.js";
import { reviewPublishedPlanPullRequest } from "../services/plan-pull-request-review.service.js";

vi.mock("../utils/git-command.js", () => ({ runGit: vi.fn() }));
vi.mock("../utils/command-runner.js", () => ({ runCommand: vi.fn() }));
vi.mock("../services/plan-pull-request-review.service.js", () => ({
  reviewPublishedPlanPullRequest: vi.fn(),
}));

const mergeSha = "a".repeat(40);
const oldSha = "b".repeat(40);
const epic = {
  id: "os-plan",
  issue_type: "epic",
  status: "open",
  pull_request_url: "https://github.com/test/repo/pull/1",
  delivery_branch: "opensprint/epic_os-plan",
  worktree_base_branch: "master",
} as StoredTask;
const child = { id: "os-plan.1", issue_type: "task", status: "closed" } as StoredTask;
let reconciler: PlanPullRequestReconciler;
let taskStore: {
  listAll: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
let dirty: boolean;
let currentRef: string;

beforeEach(() => {
  vi.resetAllMocks();
  reconciler = new PlanPullRequestReconciler();
  taskStore = {
    listAll: vi.fn().mockResolvedValue([epic, child]),
    close: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  };
  dirty = false;
  currentRef = "refs/heads/master";
  vi.mocked(runCommand).mockResolvedValue({
    stdout: JSON.stringify({
      state: "MERGED",
      mergeCommit: { oid: mergeSha },
      baseRefName: "master",
    }),
    stderr: "",
    executable: "gh",
    cwd: "/tmp/repo",
    exitCode: 0,
    signal: null,
  });
  vi.mocked(runGit).mockImplementation(async (args) => {
    if (
      args[0] === "merge-base" &&
      args[2] === "refs/remotes/origin/master" &&
      args[3] === "refs/heads/master"
    )
      throw new Error("local base behind origin");
    let stdout = "";
    if (args[0] === "remote") stdout = "git@github.com:test/repo.git\n";
    if (args[0] === "rev-parse") stdout = args[2] === "refs/heads/master" ? oldSha : mergeSha;
    if (args[0] === "symbolic-ref") stdout = currentRef;
    if (args[0] === "status") stdout = dirty ? " M README.md\n" : "";
    return { stdout, stderr: "" };
  });
});

describe("plan PR merge reconciliation", () => {
  it("fetches and fast-forwards local configured base before releasing dependent work", async () => {
    await reconciler.reconcile("project", "/tmp/repo", taskStore);
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "gh",
        args: expect.arrayContaining(["pr", "view", epic.pull_request_url, "--repo", "test/repo"]),
      }),
      expect.any(Object)
    );
    expect(runGit).toHaveBeenCalledWith(
      ["fetch", "--no-tags", "origin", "refs/heads/master:refs/remotes/origin/master"],
      expect.any(Object)
    );
    expect(runGit).toHaveBeenCalledWith(
      ["merge", "--ff-only", "refs/remotes/origin/master"],
      expect.any(Object)
    );
    expect(taskStore.close).toHaveBeenCalledWith(
      "project",
      "os-plan",
      expect.stringContaining("Pull request merged")
    );
    expect(vi.mocked(runGit).mock.invocationCallOrder.at(-1)).toBeLessThan(
      taskStore.close.mock.invocationCallOrder[0]
    );
    expect(
      vi
        .mocked(runGit)
        .mock.calls.some(([args]) => ["push", "reset", "checkout", "stash"].includes(args[0]))
    ).toBe(false);
  });

  it("never discards dirty base changes or closes the pending epic", async () => {
    dirty = true;
    await reconciler.reconcile("project", "/tmp/repo", taskStore);
    expect(taskStore.close).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(runGit)
        .mock.calls.some(([args]) => ["merge", "update-ref", "reset", "stash"].includes(args[0]))
    ).toBe(false);
  });

  it("leaves divergent base branches untouched", async () => {
    const original = vi.mocked(runGit).getMockImplementation()!;
    vi.mocked(runGit).mockImplementation(async (args, opts) => {
      if (args[0] === "merge-base" && args.includes("refs/heads/master"))
        throw new Error("diverged");
      return original(args, opts);
    });
    await reconciler.reconcile("project", "/tmp/repo", taskStore);
    expect(taskStore.close).not.toHaveBeenCalled();
    expect(
      vi.mocked(runGit).mock.calls.some(([args]) => ["merge", "update-ref"].includes(args[0]))
    ).toBe(false);
  });

  it("uses an atomic ref update when another branch is checked out without changing that checkout", async () => {
    currentRef = "refs/heads/my-work";
    await reconciler.reconcile("project", "/tmp/repo", taskStore);
    expect(runGit).toHaveBeenCalledWith(
      ["update-ref", "refs/heads/master", mergeSha, oldSha],
      expect.any(Object)
    );
    expect(taskStore.close).toHaveBeenCalled();
  });

  it.each(["OPEN", "CLOSED"])("does not advance the local base for a %s PR", async (state) => {
    vi.mocked(runCommand).mockResolvedValue({
      stdout: JSON.stringify({ state }),
      stderr: "",
      executable: "gh",
      cwd: "/tmp/repo",
      exitCode: 0,
      signal: null,
    });
    await reconciler.reconcile("project", "/tmp/repo", taskStore);
    expect(runGit).not.toHaveBeenCalled();
    expect(taskStore.close).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...epic, status: "closed" }, child],
    [epic, { ...child, status: "open" }],
  ])("does not query closed plans or unfinished tasks", async (...issues) => {
    taskStore.listAll.mockResolvedValue(issues);
    await reconciler.reconcile("project", "/tmp/repo", taskStore);
    expect(runCommand).not.toHaveBeenCalled();
    expect(taskStore.close).not.toHaveBeenCalled();
  });

  it("rechecks follow-up tasks before closing after a remote merge", async () => {
    taskStore.listAll
      .mockResolvedValueOnce([epic, child])
      .mockResolvedValue([epic, child, { ...child, id: "os-plan.2", status: "open" }]);
    await reconciler.reconcile("project", "/tmp/repo", taskStore);
    expect(taskStore.close).not.toHaveBeenCalled();
  });

  it("does not advance a base checked out in another worktree", async () => {
    currentRef = "refs/heads/my-work";
    const original = vi.mocked(runGit).getMockImplementation()!;
    vi.mocked(runGit).mockImplementation(async (args, opts) =>
      args[0] === "worktree"
        ? { stdout: "worktree /tmp/other\nbranch refs/heads/master\n", stderr: "" }
        : original(args, opts)
    );
    await reconciler.reconcile("project", "/tmp/repo", taskStore);
    expect(taskStore.close).not.toHaveBeenCalled();
    expect(vi.mocked(runGit).mock.calls.some(([args]) => args[0] === "update-ref")).toBe(false);
  });

  it("leaves unavailable GitHub requests pending and throttles repeated checks", async () => {
    vi.mocked(runCommand).mockRejectedValue(new Error("GitHub is offline"));
    await reconciler.reconcile("project", "/tmp/repo", taskStore);
    await reconciler.reconcile("project", "/tmp/repo", taskStore);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(taskStore.close).not.toHaveBeenCalled();
    expect(runGit).not.toHaveBeenCalled();
  });

  it("resumes a durable pending review after restart before reconciling its merge", async () => {
    taskStore.listAll
      .mockResolvedValueOnce([{ ...epic, final_review_pending: true }, child])
      .mockResolvedValue([{ ...epic, final_review_pending: false }, child]);
    const original = vi.mocked(runGit).getMockImplementation()!;
    vi.mocked(runGit).mockImplementation(async (args, opts) => {
      if (args[0] === "worktree")
        return {
          stdout: "worktree /tmp/plan-wt\0HEAD abc\0branch refs/heads/opensprint/epic_os-plan\0\0",
          stderr: "",
        };
      if (args[0] === "symbolic-ref" && opts.cwd === "/tmp/plan-wt")
        return { stdout: "opensprint/epic_os-plan\n", stderr: "" };
      return original(args, opts);
    });
    vi.mocked(reviewPublishedPlanPullRequest).mockResolvedValue(undefined);
    await reconciler.reconcile("project", "/tmp/repo", taskStore);
    expect(reviewPublishedPlanPullRequest).toHaveBeenCalledWith({
      projectId: "project",
      epicId: epic.id,
      worktreePath: "/tmp/plan-wt",
      taskStore,
    });
    expect(vi.mocked(reviewPublishedPlanPullRequest).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runCommand).mock.invocationCallOrder[0]
    );
    expect(taskStore.close).toHaveBeenCalled();
  });

  it("keeps a failed resumed review pending and retries it on a later pass", async () => {
    const pending = { ...epic, final_review_pending: true };
    taskStore.listAll.mockResolvedValue([pending, child]);
    vi.mocked(runGit).mockImplementation(async (args) => ({
      stdout:
        args[0] === "worktree"
          ? "worktree /tmp/plan-wt\0branch refs/heads/opensprint/epic_os-plan\0\0"
          : "opensprint/epic_os-plan\n",
      stderr: "",
    }));
    vi.mocked(reviewPublishedPlanPullRequest).mockRejectedValue(
      new Error("review agent unavailable")
    );
    await reconciler.reconcile("project", "/tmp/repo", taskStore);
    // A fresh process must retain the same durable retry, without relying on old memory.
    await new PlanPullRequestReconciler().reconcile("project", "/tmp/repo", taskStore);
    expect(reviewPublishedPlanPullRequest).toHaveBeenCalledTimes(2);
    expect(taskStore.close).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it.each(["missing", "wrong branch"])(
    "never substitutes main when the pending review checkout is %s",
    async (condition) => {
      taskStore.listAll.mockResolvedValue([{ ...epic, final_review_pending: true }, child]);
      vi.mocked(runGit).mockResolvedValue({
        stdout:
          condition === "missing"
            ? ""
            : "worktree /tmp/plan-wt\0branch refs/heads/opensprint/epic_os-plan\0\0",
        stderr: "",
      });
      await reconciler.reconcile("project", "/tmp/repo", taskStore);
      expect(reviewPublishedPlanPullRequest).not.toHaveBeenCalled();
      expect(taskStore.close).not.toHaveBeenCalled();
      expect(runCommand).not.toHaveBeenCalled();
    }
  );

  it("leaves new follow-up tasks blocked from epic closure after a resumed review", async () => {
    taskStore.listAll
      .mockResolvedValueOnce([{ ...epic, final_review_pending: true }, child])
      .mockResolvedValue([
        { ...epic, final_review_pending: false },
        child,
        { ...child, id: "os-plan.2", status: "open" },
      ]);
    vi.mocked(runGit).mockImplementation(async (args) => ({
      stdout:
        args[0] === "worktree"
          ? "worktree /tmp/plan-wt\0branch refs/heads/opensprint/epic_os-plan\0\0"
          : "opensprint/epic_os-plan\n",
      stderr: "",
    }));
    vi.mocked(reviewPublishedPlanPullRequest).mockResolvedValue(undefined);
    await reconciler.reconcile("project", "/tmp/repo", taskStore);
    expect(reviewPublishedPlanPullRequest).toHaveBeenCalledOnce();
    expect(taskStore.close).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });
});
