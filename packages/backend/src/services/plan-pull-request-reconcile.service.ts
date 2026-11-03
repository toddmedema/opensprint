import type { StoredTask } from "./task-store.types.js";
import { runCommand } from "../utils/command-runner.js";
import { runGit } from "../utils/git-command.js";
import { createLogger } from "../utils/logger.js";
import { reviewPublishedPlanPullRequest } from "./plan-pull-request-review.service.js";
import { withUngovernedPullRequestDelivery } from "./plan-pull-request-governance.js";

const log = createLogger("plan-pr-reconcile");
const POLL_INTERVAL_MS = 60_000;

type ReconcileTaskStore = {
  listAll(projectId: string): Promise<StoredTask[]>;
  close(projectId: string, taskId: string, reason: string): Promise<unknown>;
  update(
    projectId: string,
    taskId: string,
    fields: { extra: Record<string, unknown> }
  ): Promise<unknown>;
};

function implementationTasksClosed(issues: StoredTask[], epicId: string): boolean {
  const children = issues.filter(
    (issue) =>
      issue.id.startsWith(`${epicId}.`) &&
      !issue.id.endsWith(".0") &&
      (issue.issue_type ?? issue.type) !== "epic"
  );
  return children.length > 0 && children.every((issue) => issue.status === "closed");
}

/** Keep dependency epics open until GitHub has merged the PR and its code is available locally. */
export class PlanPullRequestReconciler {
  private lastCheckedAt = new Map<string, number>();
  private inFlight = new Set<string>();

  async reconcile(
    projectId: string,
    repoPath: string,
    taskStore: ReconcileTaskStore
  ): Promise<void> {
    if (this.inFlight.has(projectId)) return;
    const now = Date.now();
    const last = this.lastCheckedAt.get(projectId);
    if (last !== undefined && now - last < POLL_INTERVAL_MS) return;
    this.inFlight.add(projectId);
    this.lastCheckedAt.set(projectId, now);
    try {
      const issues = await taskStore.listAll(projectId);
      const pending = issues.filter(
        (issue) =>
          issue.status === "open" &&
          (issue.issue_type ?? issue.type) === "epic" &&
          typeof issue.pull_request_url === "string" &&
          implementationTasksClosed(issues, issue.id)
      );
      for (const epic of pending) {
        try {
          await withUngovernedPullRequestDelivery(projectId, () =>
            this.reconcileEpic(projectId, repoPath, taskStore, epic)
          );
        } catch (err) {
          log.warn("PR delivery remains pending; local base was not advanced safely", {
            projectId,
            epicId: epic.id,
            err,
          });
        }
      }
    } catch (err) {
      log.warn("Could not inspect pending PR deliveries", { projectId, err });
    } finally {
      this.inFlight.delete(projectId);
    }
  }

  private async reconcileEpic(
    projectId: string,
    repoPath: string,
    taskStore: ReconcileTaskStore,
    epic: StoredTask
  ): Promise<void> {
    if (epic.final_review_pending === true) {
      await this.resumePendingReview(projectId, repoPath, taskStore, epic);
      const freshIssues = await taskStore.listAll(projectId);
      const freshEpic = freshIssues.find((issue) => issue.id === epic.id);
      if (
        !freshEpic ||
        freshEpic.status !== "open" ||
        freshEpic.final_review_pending === true ||
        !implementationTasksClosed(freshIssues, epic.id)
      )
        return;
      epic = freshEpic;
    }
    const url = epic.pull_request_url as string;
    const match = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+$/);
    if (!match) throw new Error("Pending PR URL is not a GitHub pull request.");
    const repo = match[1];
    const options = { cwd: repoPath, timeout: 30_000 };
    const { stdout } = await runCommand(
      {
        command: "gh",
        args: ["pr", "view", url, "--repo", repo, "--json", "state,mergeCommit,baseRefName"],
      },
      options
    );
    const pr = JSON.parse(stdout) as {
      state?: string;
      mergeCommit?: { oid?: string };
      baseRefName?: string;
    };
    if (pr.state !== "MERGED") return;
    const baseBranch = epic.worktree_base_branch;
    if (typeof baseBranch !== "string" || !baseBranch || pr.baseRefName !== baseBranch) {
      throw new Error("Merged PR base does not match the plan's configured base branch.");
    }
    const mergeCommit = pr.mergeCommit?.oid;
    if (typeof mergeCommit !== "string" || !/^[a-f0-9]{40,64}$/i.test(mergeCommit)) {
      throw new Error("GitHub did not identify the PR merge commit.");
    }
    const { stdout: origin } = await runGit(["remote", "get-url", "origin"], options);
    const originMatch = origin
      .trim()
      .match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/);
    if (!originMatch || originMatch[1].toLowerCase() !== repo.toLowerCase()) {
      throw new Error("Origin changed since this plan PR was published.");
    }
    await runGit(["check-ref-format", "--branch", baseBranch], options);
    const baseRef = `refs/heads/${baseBranch}`;
    const trackingRef = `refs/remotes/origin/${baseBranch}`;
    await runGit(["fetch", "--no-tags", "origin", `${baseRef}:${trackingRef}`], options);
    await runGit(["merge-base", "--is-ancestor", mergeCommit, trackingRef], options);
    const { stdout: oldTip } = await runGit(["rev-parse", "--verify", baseRef], options);
    const { stdout: remoteTip } = await runGit(["rev-parse", "--verify", trackingRef], options);
    if (oldTip.trim() !== remoteTip.trim()) {
      let localAlreadyIncludesRemote = false;
      try {
        await runGit(["merge-base", "--is-ancestor", trackingRef, baseRef], options);
        localAlreadyIncludesRemote = true;
      } catch {
        // A local branch behind origin can advance; divergence must remain pending.
      }
      if (!localAlreadyIncludesRemote) {
        await runGit(["merge-base", "--is-ancestor", baseRef, trackingRef], options);
        const { stdout: currentRef } = await runGit(["symbolic-ref", "--quiet", "HEAD"], options);
        if (currentRef.trim() === baseRef) {
          const { stdout: status } = await runGit(["status", "--porcelain"], options);
          if (status.trim())
            throw new Error("Local changes must be saved before updating the base branch.");
          await runGit(["merge", "--ff-only", trackingRef], options);
        } else {
          const { stdout: worktrees } = await runGit(["worktree", "list", "--porcelain"], options);
          if (worktrees.split("\n").includes(`branch ${baseRef}`)) {
            throw new Error("Base branch is checked out in another worktree.");
          }
          await runGit(["update-ref", baseRef, remoteTip.trim(), oldTip.trim()], options);
        }
      }
    }
    await runGit(["merge-base", "--is-ancestor", mergeCommit, baseRef], options);
    // A review can create follow-up tasks while network operations are in flight.
    const freshIssues = await taskStore.listAll(projectId);
    const freshEpic = freshIssues.find((issue) => issue.id === epic.id);
    if (
      !freshEpic ||
      freshEpic.status !== "open" ||
      freshEpic.pull_request_url !== url ||
      freshEpic.final_review_pending === true ||
      !implementationTasksClosed(freshIssues, epic.id)
    )
      return;
    await taskStore.close(projectId, epic.id, `Pull request merged: ${url}`);
  }

  private async resumePendingReview(
    projectId: string,
    repoPath: string,
    taskStore: ReconcileTaskStore,
    epic: StoredTask
  ): Promise<void> {
    const branch = epic.delivery_branch;
    if (branch !== `opensprint/epic_${epic.id}` || branch === epic.worktree_base_branch) {
      throw new Error("Pending plan review does not identify a valid shared plan branch.");
    }
    const { stdout: registered } = await runGit(["worktree", "list", "--porcelain", "-z"], {
      cwd: repoPath,
      timeout: 30_000,
    });
    const entry = registered
      .split("\0\0")
      .map((record) => record.split("\0"))
      .find((fields) => fields.includes(`branch refs/heads/${branch}`));
    const worktreePath = entry
      ?.find((field) => field.startsWith("worktree "))
      ?.slice("worktree ".length);
    if (!worktreePath)
      throw new Error("Pending plan review worktree is missing; retaining delivery gate.");
    // The registry may be stale after manual Git operations. Never review the base checkout
    // or an unrelated branch as a substitute for the published implementation.
    const { stdout: checkedOutBranch } = await runGit(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      { cwd: worktreePath, timeout: 30_000 }
    );
    if (checkedOutBranch.trim() !== branch)
      throw new Error("Pending plan review worktree has a different branch checked out.");
    await reviewPublishedPlanPullRequest({ projectId, epicId: epic.id, worktreePath, taskStore });
  }
}

export const planPullRequestReconciler = new PlanPullRequestReconciler();
