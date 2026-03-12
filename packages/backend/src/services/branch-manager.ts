import fs from "fs/promises";
import os from "os";
import path from "path";
import { OPENSPRINT_PATHS } from "@opensprint/shared";
import { createLogger } from "../utils/logger.js";
import { waitForGitReady as waitForGitReadyUtil } from "../utils/git-lock.js";
import { getGitNoHooksPath } from "../utils/git-no-hooks.js";
import { shellExec } from "../utils/shell-exec.js";
import { ensureRepoHasInitialCommit, getOriginUrl } from "../utils/git-repo-state.js";
import { formatClosedCommitMessage, parseClosedCommitMessage } from "../utils/commit-message.js";
import { assertSafeTaskWorktreePath } from "../utils/path-safety.js";
import { taskStore as taskStoreSingleton } from "./task-store.service.js";
import { ProjectService } from "./project.service.js";
import { heartbeatService } from "./heartbeat.service.js";

/** Paths we must not commit from worktrees (runtime-only; would block merge in main). Agent stats, event log, and orchestrator counters are now DB-only. */
const RUNTIME_EXCLUDE_FOR_WIP = [
  OPENSPRINT_PATHS.pendingCommits,
  `${OPENSPRINT_PATHS.sessions}/`,
  `${OPENSPRINT_PATHS.active}/`,
];
const log = createLogger("branch-manager");

/** Thrown when `pushMain` rebase encounters conflicts. Repo is left in rebase state. */
export class RebaseConflictError extends Error {
  constructor(public readonly conflictedFiles: string[]) {
    super(`Rebase conflict in ${conflictedFiles.length} file(s): ${conflictedFiles.join(", ")}`);
    this.name = "RebaseConflictError";
  }
}

/** Thrown when merge has genuine code conflicts (after infra files are auto-resolved). */
export class MergeConflictError extends Error {
  constructor(public readonly conflictedFiles: string[]) {
    super(`Merge conflict in ${conflictedFiles.length} file(s): ${conflictedFiles.join(", ")}`);
    this.name = "MergeConflictError";
  }
}

/** Thrown when our branch is checked out in another worktree that has an active agent (recent heartbeat). */
export class WorktreeBranchInUseError extends Error {
  constructor(
    message: string,
    public readonly branchName: string,
    public readonly otherPath: string,
    public readonly otherTaskId: string
  ) {
    super(message);
    this.name = "WorktreeBranchInUseError";
  }
}

export type MainSyncResult =
  | "up_to_date"
  | "fast_forwarded"
  | "local_ahead"
  | "fetch_failed"
  | "no_remote"
  | "remote_error";

export interface MergeToMainResult {
  autoResolvedFiles: string[];
}

/**
 * Options for creating a task or epic worktree.
 * When worktreeKey (and optionally branchName) are set, creates or reuses an epic worktree.
 */
export interface CreateTaskWorktreeOptions {
  /** Branch to use (e.g. opensprint/epic_<epicId>). When set with worktreeKey, first task creates branch, later tasks reuse same worktree/branch. */
  branchName?: string;
  /** Worktree path key: taskId for per-task, or epic key (e.g. epic_<epicId>) for shared epic worktree. */
  worktreeKey?: string;
}

const NPM_HEALTH_CHECK_TIMEOUT_MS = 90_000;
const NPM_REPAIR_TIMEOUT_MS = 10 * 60 * 1000;
const DEPENDENCY_HEALTH_CHECK_COMMAND = "npm ls --depth=0 --workspaces";
const DEPENDENCY_REPAIR_COMMANDS = ["npm ci", "npm install"] as const;

export interface DependencyHealthResult {
  healthy: boolean;
  checkOutput: string;
  repairAttempted: boolean;
  repairSucceeded: boolean;
  repairCommands: string[];
  repairOutput: string;
}

/** Cross-platform shell quoting: cmd.exe double-quote on Windows, bash single-quote elsewhere. */
function shellQuote(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function getErrorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof obj.message === "string") parts.push(obj.message);
    if (typeof obj.stdout === "string") parts.push(obj.stdout);
    if (typeof obj.stderr === "string") parts.push(obj.stderr);
    if (typeof obj.output === "string") parts.push(obj.output);
    return parts.join("\n");
  }
  return String(err);
}

function isNoRebaseInProgressError(err: unknown): boolean {
  return /no rebase in progress/i.test(getErrorText(err));
}

function shouldAttemptRebaseSkip(err: unknown): boolean {
  const text = getErrorText(err).toLowerCase();
  if (!text) return false;
  return (
    text.includes("could not apply") ||
    text.includes("you can instead skip this commit") ||
    text.includes("previous cherry-pick is now empty") ||
    text.includes("nothing to commit") ||
    text.includes("no changes - did you forget to use 'git add'")
  );
}

export class UnsafeCleanupPathError extends Error {
  constructor(
    message: string,
    public readonly targetPath: string
  ) {
    super(message);
    this.name = "UnsafeCleanupPathError";
  }
}

/**
 * Manages git branches for the task lifecycle:
 * - Create task branches
 * - Revert changes on failure (hard reset)
 * - Verify merges after review approval
 * - Delete branches after completion
 */
export class BranchManager {
  private taskStore = taskStoreSingleton;
  private projectService = new ProjectService();

  private async validateDisposableWorktreePath(
    repoPath: string,
    taskId: string,
    candidatePath: string,
    reason: string
  ): Promise<string> {
    const resolvedCandidate = await fs
      .realpath(candidatePath)
      .catch(() => path.resolve(candidatePath));
    const resolvedRepo = await fs.realpath(repoPath).catch(() => path.resolve(repoPath));
    try {
      assertSafeTaskWorktreePath(resolvedRepo, taskId, resolvedCandidate);
      return resolvedCandidate;
    } catch (err) {
      throw new UnsafeCleanupPathError(
        `${reason}: ${err instanceof Error ? err.message : String(err)}`,
        resolvedCandidate
      );
    }
  }

  private async removeWorktreeDirectorySafely(
    repoPath: string,
    taskId: string,
    candidatePath: string,
    reason: string
  ): Promise<boolean> {
    let safePath: string;
    try {
      safePath = await this.validateDisposableWorktreePath(repoPath, taskId, candidatePath, reason);
    } catch (err) {
      log.error("Refusing unsafe worktree cleanup target", {
        taskId,
        candidatePath,
        err: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    await fs.rm(safePath, { recursive: true, force: true }).catch(() => {});
    await this.git(repoPath, "worktree prune").catch(() => {});
    return true;
  }

  /**
   * Create a task branch from the base branch.
   * @param baseBranch - Base branch to create from (default: "main")
   */
  async createBranch(
    repoPath: string,
    branchName: string,
    baseBranch: string = "main"
  ): Promise<void> {
    await ensureRepoHasInitialCommit(repoPath, baseBranch);
    await this.git(repoPath, `checkout ${baseBranch}`);
    await this.git(repoPath, `checkout -b ${branchName}`);
  }

  /**
   * Create branch if it does not exist, otherwise checkout existing branch.
   * Used when retrying after review rejection (branch already has coding agent's work).
   * @param baseBranch - Base branch to create from when branch doesn't exist (default: "main")
   */
  async createOrCheckoutBranch(
    repoPath: string,
    branchName: string,
    baseBranch: string = "main"
  ): Promise<void> {
    await this.waitForGitReady(repoPath);
    try {
      await shellExec(`git rev-parse --verify ${branchName}`, { cwd: repoPath });
      await this.checkout(repoPath, branchName);
    } catch {
      await this.createBranch(repoPath, branchName, baseBranch);
    }
  }

  /**
   * Ensure a branch exists (create from baseBranch if not). Does not change HEAD in repoPath.
   * Used for epic branches so the main repo can stay on main while we add a worktree for the epic branch.
   * @param baseBranch - Base branch to create from when branch doesn't exist (default: "main")
   */
  async ensureBranchExists(
    repoPath: string,
    branchName: string,
    baseBranch: string = "main"
  ): Promise<void> {
    await this.waitForGitReady(repoPath);
    try {
      await shellExec(`git rev-parse --verify ${branchName}`, { cwd: repoPath });
    } catch {
      await this.git(repoPath, `branch ${branchName} ${baseBranch}`);
    }
  }

  /**
   * Switch to a branch.
   */
  async checkout(repoPath: string, branchName: string): Promise<void> {
    await this.git(repoPath, `checkout ${branchName}`);
  }

  /**
   * Get the current branch name.
   */
  async getCurrentBranch(repoPath: string): Promise<string> {
    const { stdout } = await shellExec("git rev-parse --abbrev-ref HEAD", { cwd: repoPath });
    return stdout.trim();
  }

  /**
   * Revert all changes on a branch and return to the base branch.
   * @param baseBranch - Base branch to return to (default: "main")
   */
  async revertAndReturnToMain(
    repoPath: string,
    branchName: string,
    baseBranch: string = "main"
  ): Promise<void> {
    try {
      // Reset any uncommitted changes
      await this.git(repoPath, "reset --hard HEAD");
      await this.git(repoPath, "clean -fd");
      // Switch back to base branch
      await this.git(repoPath, `checkout ${baseBranch}`);
      // Delete the task branch
      await this.git(repoPath, `branch -D ${branchName}`);
    } catch (error) {
      log.error("Failed to revert branch", { branchName, error });
      // Force checkout base branch even if something failed
      try {
        await this.git(repoPath, `checkout -f ${baseBranch}`);
      } catch {
        // Last resort
      }
    }
  }

  /**
   * Verify that a branch has been merged to the base branch.
   * @param baseBranch - Base branch to check merge against (default: "main")
   */
  async verifyMerge(
    repoPath: string,
    branchName: string,
    baseBranch: string = "main"
  ): Promise<boolean> {
    try {
      const { stdout } = await shellExec(`git branch --merged ${baseBranch}`, { cwd: repoPath });
      return stdout.includes(branchName);
    } catch {
      return false;
    }
  }

  /**
   * Delete a branch (after successful merge).
   */
  async deleteBranch(repoPath: string, branchName: string): Promise<void> {
    try {
      await this.git(repoPath, `branch -d ${branchName}`);
    } catch {
      // Branch might already be deleted
    }
  }

  /**
   * Get the diff between the base branch and a task branch.
   * @param baseBranch - Base branch for diff (default: "main")
   */
  async getDiff(
    repoPath: string,
    branchName: string,
    baseBranch: string = "main"
  ): Promise<string> {
    const { stdout } = await shellExec(`git diff ${baseBranch}...${branchName}`, {
      cwd: repoPath,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  }

  /**
   * Push a branch to the remote. Used to preserve work before crash recovery revert.
   */
  async pushBranch(repoPath: string, branchName: string): Promise<void> {
    try {
      await this.git(repoPath, `push -u origin ${branchName}`);
    } catch (error) {
      log.warn("pushBranch failed", { branchName, error });
      throw error;
    }
  }

  /**
   * Push the base branch to the remote. Called after successful merge so completed work reaches origin.
   * Fetches and rebases first when origin/<baseBranch> exists (to handle concurrent pushes).
   * If the remote has no base branch (e.g. empty repo or first push), skips rebase and pushes.
   * If rebase hits conflicts, throws a RebaseConflictError (repo left in rebase state
   * so a merger agent can resolve). Caller is responsible for aborting if resolution fails.
   * @param baseBranch - Base branch to push (default: "main")
   */
  async pushMain(repoPath: string, baseBranch: string = "main"): Promise<void> {
    const originUrl = await getOriginUrl(repoPath);
    if (!originUrl) {
      log.info("pushMain: no origin configured, skipping publish", { baseBranch });
      return;
    }
    try {
      await this.git(repoPath, `fetch origin ${baseBranch}`);
    } catch (error) {
      log.warn("pushMain: fetch failed, pushing anyway", { error });
    }

    await this.commitWip(repoPath, "pre-push");

    const originRef = `origin/${baseBranch}`;
    const hasOriginBase = await this.hasRemoteBranch(repoPath, originRef);
    if (hasOriginBase) {
      await this.squashLocalCommits(repoPath, originRef);

      try {
        const noHooks = getGitNoHooksPath();
        await shellExec(
          `git -c core.hooksPath="${noHooks}" rebase --empty=drop ${originRef}`,
          {
            cwd: repoPath,
            timeout: 120000,
          }
        );
      } catch (rebaseErr) {
        const rebaseActive = await this.isRebaseInProgress(repoPath);
        if (!rebaseActive) {
          throw rebaseErr;
        }
        const conflictedFiles = await this.getConflictedFiles(repoPath);
        throw new RebaseConflictError(conflictedFiles);
      }
    } else {
      log.info("pushMain: origin branch not present (e.g. empty remote), skipping rebase", {
        baseBranch,
      });
    }

    const noHooks = getGitNoHooksPath();
    await this.git(repoPath, `-c core.hooksPath="${noHooks}" push origin ${baseBranch}`);
  }

  /**
   * Squash all local-only commits (ahead of base) into a single commit.
   * Prevents accumulation of WIP/metadata commits that make rebase O(n) and fragile.
   * Uses "Closed <taskId>: <title truncated to ~45 chars>" when task info is available;
   * otherwise falls back to "squash N local commits for rebase".
   */
  private async squashLocalCommits(repoPath: string, base: string): Promise<void> {
    try {
      const { stdout: countStr } = await shellExec(`git rev-list --count ${base}..HEAD`, {
        cwd: repoPath,
        timeout: 5000,
      });
      const localCount = parseInt(countStr.trim(), 10);
      if (localCount <= 1) return;

      let commitMessage = `squash ${localCount} local commits for rebase`;
      const { stdout: logOut } = await shellExec(`git log --format=%s ${base}..HEAD`, {
        cwd: repoPath,
        timeout: 5000,
      });
      const subjects = logOut.trim().split("\n");
      for (const s of subjects) {
        const parsed = parseClosedCommitMessage(s);
        if (parsed) {
          commitMessage = formatClosedCommitMessage(parsed.taskId, parsed.title);
          break;
        }
      }
      if (commitMessage === `squash ${localCount} local commits for rebase`) {
        const derived = await this.deriveClosedFromMergeCommits(repoPath, base);
        if (derived) {
          commitMessage = formatClosedCommitMessage(derived.taskId, derived.title);
        }
      }

      log.info(`Squashing ${localCount} local commits before rebase`, { repoPath, localCount });
      await shellExec(`git reset --soft ${base}`, { cwd: repoPath, timeout: 10000 });
      const escaped = commitMessage.replace(/"/g, '\\"');
      const noHooksSquash = getGitNoHooksPath();
      await shellExec(`git -c core.hooksPath="${noHooksSquash}" commit -m "${escaped}"`, {
        cwd: repoPath,
        timeout: 30000,
      });
    } catch (err) {
      log.warn("squashLocalCommits failed, proceeding with rebase anyway", { repoPath, err });
    }
  }

  /**
   * When no Closed commit exists, try to derive taskId and title from merge commits
   * (branch opensprint/<taskId>) and the task store.
   */
  private async deriveClosedFromMergeCommits(
    repoPath: string,
    base: string
  ): Promise<{ taskId: string; title: string } | null> {
    try {
      const { stdout: mergeParents } = await shellExec(
        `git log ${base}..HEAD --merges -1 --format=%P`,
        { cwd: repoPath, timeout: 5000 }
      );
      const parents = mergeParents.trim().split(/\s+/).filter(Boolean);
      if (parents.length < 2) return null;

      const branchTip = parents[1];
      const { stdout: refNames } = await shellExec(`git branch -a --contains ${branchTip}`, {
        cwd: repoPath,
        timeout: 5000,
      });
      const branches = refNames
        .trim()
        .split("\n")
        .map((b) =>
          b
            .trim()
            .replace(/^\*?\s*/, "")
            .replace(/^remotes\/[^/]+\//, "")
        );
      const taskBranch = branches.find((b) => b.startsWith("opensprint/"));
      if (!taskBranch) return null;

      const taskId = taskBranch.replace(/^remotes\/[^/]+\//, "").replace(/^opensprint\//, "");
      if (!taskId) return null;

      const project = await this.projectService.getProjectByRepoPath(repoPath);
      if (!project) return null;
      const issues = await this.taskStore.listAll(project.id);
      const issue = issues.find((i) => i.id === taskId);
      if (!issue) return null;
      const title = (issue.title as string) || taskId;
      return { taskId, title };
    } catch {
      return null;
    }
  }

  /**
   * Check if a ref (e.g. origin/main) exists in the repo.
   */
  private async hasRemoteBranch(repoPath: string, ref: string): Promise<boolean> {
    try {
      await shellExec(`git rev-parse --verify ${ref}`, { cwd: repoPath });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Push the base branch to origin (no fetch/rebase). Used after the merger agent has resolved conflicts.
   * @param baseBranch - Base branch to push (default: "main")
   */
  async pushMainToOrigin(repoPath: string, baseBranch: string = "main"): Promise<void> {
    const originUrl = await getOriginUrl(repoPath);
    if (!originUrl) {
      log.info("pushMainToOrigin: no origin configured, skipping publish", { baseBranch });
      return;
    }
    await this.commitWip(repoPath, "pre-push");
    const noHooksPush = getGitNoHooksPath();
    await this.git(repoPath, `-c core.hooksPath="${noHooksPush}" push origin ${baseBranch}`);
  }

  /**
   * List files with merge/rebase conflicts (unmerged paths).
   */
  async getConflictedFiles(repoPath: string): Promise<string[]> {
    try {
      const { stdout } = await shellExec("git diff --name-only --diff-filter=U", {
        cwd: repoPath,
      });
      return stdout.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Get the full diff showing conflict markers for unresolved files.
   */
  async getConflictDiff(repoPath: string): Promise<string> {
    try {
      const { stdout } = await shellExec("git diff", {
        cwd: repoPath,
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout;
    } catch {
      return "";
    }
  }

  /**
   * Stage all resolved files and continue an in-progress rebase.
   */
  async rebaseContinue(repoPath: string): Promise<void> {
    await this.git(repoPath, "add -A");
    const noHooks = getGitNoHooksPath();
    try {
      await shellExec(`git -c core.editor=true -c core.hooksPath="${noHooks}" rebase --continue`, {
        cwd: repoPath,
        timeout: 30000,
      });
    } catch (err) {
      const rebaseActive = await this.isRebaseInProgress(repoPath);
      if (!rebaseActive) {
        if (isNoRebaseInProgressError(err)) {
          // Merger agent may have already completed the rebase; treat this as done.
          return;
        }
        throw err;
      }
      const conflictedFiles = await this.getConflictedFiles(repoPath);
      if (conflictedFiles.length > 0) {
        throw new RebaseConflictError(conflictedFiles);
      }

      // Rebase can also stop with no unmerged paths when the current patch is effectively empty/already applied.
      // In that case, continue with --skip instead of failing the entire merge flow.
      if (shouldAttemptRebaseSkip(err)) {
        try {
          await shellExec(
            `git -c core.editor=true -c core.hooksPath="${noHooks}" rebase --skip`,
            {
              cwd: repoPath,
              timeout: 30000,
            }
          );
          return;
        } catch (skipErr) {
          const stillActive = await this.isRebaseInProgress(repoPath);
          if (!stillActive && isNoRebaseInProgressError(skipErr)) {
            return;
          }
          if (stillActive) {
            const conflictedAfterSkip = await this.getConflictedFiles(repoPath);
            if (conflictedAfterSkip.length > 0) {
              throw new RebaseConflictError(conflictedAfterSkip);
            }
          }
          throw skipErr;
        }
      }
      throw err;
    }
  }

  /**
   * Abort an in-progress rebase, restoring the repo to its pre-rebase state.
   */
  async rebaseAbort(repoPath: string): Promise<void> {
    await this.git(repoPath, "rebase --abort").catch(() => {});
  }

  /**
   * Check whether a merge is currently in progress (merge conflicted).
   */
  async isMergeInProgress(repoPath: string): Promise<boolean> {
    try {
      await fs.access(path.join(repoPath, ".git", "MERGE_HEAD"));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stage resolved files and complete an in-progress merge.
   */
  async mergeContinue(repoPath: string): Promise<void> {
    await this.git(repoPath, "add -A");
    await shellExec("git -c core.editor=true commit --no-edit", {
      cwd: repoPath,
      timeout: 30000,
    });
  }

  /**
   * Abort an in-progress merge.
   */
  async mergeAbort(repoPath: string): Promise<void> {
    await this.git(repoPath, "merge --abort").catch(() => {});
  }

  /**
   * Check whether a rebase is currently in progress.
   */
  async isRebaseInProgress(repoPath: string): Promise<boolean> {
    const gitDir = path.join(repoPath, ".git");
    for (const dir of ["rebase-merge", "rebase-apply"]) {
      try {
        await fs.access(path.join(gitDir, dir));
        return true;
      } catch {
        // Not present
      }
    }
    return false;
  }

  /**
   * Check for uncommitted changes and create a WIP commit if any exist.
   * Used when agent is terminated (SIGTERM, inactivity timeout) to preserve partial work.
   * Excludes runtime-only .opensprint paths so the task branch never contains them
   * (otherwise merge to main fails with "local changes would be overwritten by merge").
   */
  async commitWip(repoPath: string, taskId: string): Promise<boolean> {
    try {
      const { stdout } = await shellExec("git status --porcelain", {
        cwd: repoPath,
        timeout: 5000,
      });
      if (!stdout.trim()) return false;

      await this.git(repoPath, "add -A");
      const paths = RUNTIME_EXCLUDE_FOR_WIP.join(" ");
      await this.git(repoPath, `reset HEAD -- ${paths}`).catch(() => {
        /* paths may not be staged */
      });
      const { stdout: statusAfter } = await shellExec("git status --porcelain", {
        cwd: repoPath,
        timeout: 5000,
      });
      if (!statusAfter.trim()) return false;

      const noHooksWip = getGitNoHooksPath();
      await shellExec(`git -c core.hooksPath="${noHooksWip}" commit -m "WIP: ${taskId}"`, {
        cwd: repoPath,
        timeout: 30000,
      });
      return true;
    } catch (error) {
      log.warn("commitWip failed", { taskId, error });
      return false;
    }
  }

  /**
   * Get a summary of files changed between the base branch and a branch.
   * @param baseBranch - Base branch for diff (default: "main")
   */
  async getChangedFiles(
    repoPath: string,
    branchName: string,
    baseBranch: string = "main"
  ): Promise<string[]> {
    const { stdout } = await shellExec(`git diff --name-only ${baseBranch}...${branchName}`, {
      cwd: repoPath,
    });
    return stdout.trim().split("\n").filter(Boolean);
  }

  /**
   * Wait for .git/index.lock to be released, removing it if stale.
   * Delegates to shared git-lock util so all index-touching git operations
   * (commit queue, merge, etc.) use the same policy.
   */
  async waitForGitReady(repoPath: string): Promise<void> {
    await waitForGitReadyUtil(repoPath);
  }

  /**
   * Update local base branch to match origin/<baseBranch> (fetch + reset --hard).
   * Call before merging a task branch so we never merge into a stale base
   * and overwrite recent work (e.g. a previous task's rename that hadn't been pushed yet).
   * No-op if origin/<baseBranch> does not exist (e.g. empty remote).
   * @param baseBranch - Base branch to sync (default: "main")
   */
  async syncMainWithOrigin(repoPath: string, baseBranch: string = "main"): Promise<MainSyncResult> {
    await this.waitForGitReady(repoPath);
    const originUrl = await getOriginUrl(repoPath);
    if (!originUrl) {
      log.info("syncMainWithOrigin: no origin configured, skipping remote sync", { baseBranch });
      return "no_remote";
    }
    try {
      await this.git(repoPath, `fetch origin ${baseBranch}`);
    } catch (error) {
      log.warn("syncMainWithOrigin: fetch failed", { error });
      return "remote_error";
    }
    const originRef = `origin/${baseBranch}`;
    const hasOriginBase = await this.hasRemoteBranch(repoPath, originRef);
    if (!hasOriginBase) {
      log.info("syncMainWithOrigin: origin branch not present, skipping", { baseBranch });
      return "up_to_date";
    }
    const currentBranch = await this.getCurrentBranch(repoPath).catch(() => "");
    if (currentBranch !== baseBranch) {
      await this.git(repoPath, `checkout ${baseBranch}`);
    }
    const { stdout } = await shellExec(
      `git rev-list --left-right --count ${baseBranch}...${originRef}`,
      {
        cwd: repoPath,
        timeout: 5000,
      }
    );
    const [localAheadRaw = "0", localBehindRaw = "0"] = stdout.trim().split(/\s+/);
    const localAhead = parseInt(localAheadRaw, 10) || 0;
    const localBehind = parseInt(localBehindRaw, 10) || 0;

    if (localAhead > 0) {
      log.info("syncMainWithOrigin: local %s is ahead of origin/%s, preserving local commits", {
        baseBranch,
        localAhead,
        localBehind,
      });
      return "local_ahead";
    }

    if (localBehind > 0) {
      await this.git(repoPath, `merge --ff-only ${originRef}`);
      log.info("syncMainWithOrigin: fast-forwarded branch to origin", { baseBranch });
      return "fast_forwarded";
    }

    return "up_to_date";
  }

  async updateMainFromOrigin(repoPath: string, baseBranch: string = "main"): Promise<void> {
    await this.syncMainWithOrigin(repoPath, baseBranch);
  }

  /**
   * Ensure the main working tree is on the base branch.
   * With worktrees, this should always be the case. Logs a warning if not
   * and corrects it, but does not perform destructive operations.
   * @param baseBranch - Base branch to ensure on (default: "main")
   */
  async ensureOnMain(repoPath: string, baseBranch: string = "main"): Promise<void> {
    await this.waitForGitReady(repoPath);

    let currentBranch: string;
    try {
      currentBranch = await this.getCurrentBranch(repoPath);
    } catch {
      // No HEAD (e.g. new repo with no commits) — nothing to switch
      return;
    }
    if (currentBranch !== baseBranch) {
      log.warn("Expected %s but on different branch, switching", { baseBranch, currentBranch });
      try {
        await this.git(repoPath, "reset --hard HEAD");
        await this.git(repoPath, `checkout ${baseBranch}`);
      } catch {
        await this.git(repoPath, `checkout -f ${baseBranch}`);
      }
    }

    // Ensure .opensprint/ working tree matches HEAD so merge doesn't see
    // local modifications. Don't delete or untrack — that creates
    // modify/delete conflicts when branches have these files committed.
    try {
      if (process.platform === "win32") {
        await shellExec("git checkout -f HEAD -- .opensprint/", {
          cwd: repoPath,
          timeout: 10000,
        });
      } else {
        await shellExec(
          [
            'git ls-files .opensprint/ 2>/dev/null | while IFS= read -r f; do git update-index --no-assume-unchanged "$f" --no-skip-worktree "$f" 2>/dev/null; done',
            "git checkout -f HEAD -- .opensprint/ 2>/dev/null || true",
          ].join("; "),
          { cwd: repoPath, timeout: 10000 }
        );
      }
    } catch {
      // Best-effort cleanup; merge may still succeed without it
    }
  }

  // ─── No-Checkout Diff Capture ───

  /**
   * Capture a branch's diff from the base branch without checking it out.
   * Returns empty string if the branch doesn't exist or has no diff.
   * @param baseBranch - Base branch for diff (default: "main")
   */
  async captureBranchDiff(
    repoPath: string,
    branchName: string,
    baseBranch: string = "main"
  ): Promise<string> {
    try {
      const { stdout } = await shellExec(`git diff ${baseBranch}...${branchName}`, {
        cwd: repoPath,
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout;
    } catch {
      return "";
    }
  }

  /**
   * Capture uncommitted changes (working tree + staged + untracked) in the given path.
   * Use worktree path when agent runs in a worktree.
   * Returns empty string if no uncommitted changes or on error.
   * Temporarily stages all changes to include untracked files, then unstages.
   */
  async captureUncommittedDiff(gitPath: string): Promise<string> {
    try {
      await shellExec("git add -A", { cwd: gitPath });
      try {
        const { stdout } = await shellExec("git diff --cached HEAD", {
          cwd: gitPath,
          maxBuffer: 10 * 1024 * 1024,
        });
        return stdout;
      } finally {
        await shellExec("git reset HEAD", { cwd: gitPath }).catch(() => {});
      }
    } catch {
      return "";
    }
  }

  // ─── Git Worktree Operations ───

  /** Base directory for task worktrees (used by heartbeat stale detection) */
  getWorktreeBasePath(): string {
    return path.join(os.tmpdir(), "opensprint-worktrees");
  }

  /**
   * Get the filesystem path for a worktree by key.
   * @param key - Task ID (per-task worktree) or epic key (e.g. epic_<epicId> for shared epic worktree).
   */
  getWorktreePath(key: string): string {
    return path.join(this.getWorktreeBasePath(), key);
  }

  /**
   * If the given branch is checked out in a worktree at a different path, either remove
   * that worktree (when stale: no recent heartbeat) or throw WorktreeBranchInUseError
   * so we don't kill an active agent. Handles "branch X is already used by worktree at Y" errors.
   */
  private async freeBranchIfUsedElsewhere(
    repoPath: string,
    branchName: string,
    ourPath: string
  ): Promise<void> {
    const { stdout } = await shellExec("git worktree list --porcelain", { cwd: repoPath });
    const ourPathResolved = path.resolve(ourPath);
    const branchRef = `refs/heads/${branchName}`;
    let worktreePath: string | null = null;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        worktreePath = line.slice(9).trim();
        continue;
      }
      if (
        line.startsWith("branch ") &&
        line.trim() === `branch ${branchRef}` &&
        worktreePath != null
      ) {
        const otherResolved = path.resolve(worktreePath);
        if (otherResolved === ourPathResolved) break;

        // Derive taskId that owns that path (worktree path is base + taskId)
        const otherTaskId = path.basename(otherResolved);
        const safeOtherPath = await this.validateDisposableWorktreePath(
          repoPath,
          otherTaskId,
          worktreePath,
          `Refusing to clean up branch ${branchName} from an unsafe path`
        );
        const heartbeat = await heartbeatService.readHeartbeat(otherResolved, otherTaskId);
        if (heartbeat && !heartbeatService.isStale(heartbeat)) {
          throw new WorktreeBranchInUseError(
            `Branch ${branchName} is in use by worktree at ${worktreePath} (task ${otherTaskId} has active agent). Retry later or restart the backend.`,
            branchName,
            worktreePath,
            otherTaskId
          );
        }

        log.warn("Branch already in use by another worktree; removing stale entry", {
          branchName,
          otherPath: worktreePath,
          ourPath,
        });
        try {
          await this.git(repoPath, `worktree remove ${shellQuote(safeOtherPath)} --force`);
        } catch {
          await this.removeWorktreeDirectorySafely(
            repoPath,
            otherTaskId,
            safeOtherPath,
            "Manual stale-worktree cleanup"
          );
        }
        break;
      }
      if (line === "" || line.startsWith("worktree ")) worktreePath = null;
    }
  }

  /**
   * Create an isolated git worktree for a task or epic.
   * When options.worktreeKey is set (epic mode): uses getWorktreePath(worktreeKey) and options.branchName;
   * first task creates branch via ensureBranchExists, later tasks reuse the same worktree/branch.
   * When not set (per-task): worktree at getWorktreePath(taskId), branch opensprint/<taskId>; creates branch if not exist.
   * If the branch is already in use by another path (e.g. leftover from a crash), that worktree is removed first.
   * After creation, symlinks node_modules from the main repo.
   * Returns the worktree path.
   * @param baseBranch - Base branch to create task/epic branch from (default: "main")
   */
  async createTaskWorktree(
    repoPath: string,
    taskId: string,
    baseBranch: string = "main",
    options?: CreateTaskWorktreeOptions
  ): Promise<string> {
    const worktreeKey = options?.worktreeKey ?? taskId;
    const branchName = options?.branchName ?? `opensprint/${taskId}`;
    const wtPath = this.getWorktreePath(worktreeKey);
    const currentBranch = await this.getCurrentBranch(repoPath).catch(() => "");

    if (currentBranch === branchName) {
      throw new UnsafeCleanupPathError(
        `Refusing to create worktree for ${branchName}: the main repo is currently checked out to that task branch, so cleanup would be unsafe.`,
        repoPath
      );
    }

    await ensureRepoHasInitialCommit(repoPath, baseBranch);

    const isEpic = options?.worktreeKey != null;

    if (isEpic) {
      // Epic: ensure branch exists without checking out in main repo (so main stays on main and we can add worktree).
      await this.ensureBranchExists(repoPath, branchName, baseBranch);
    } else {
      // Per-task: create branch if it doesn't exist.
      try {
        await shellExec(`git rev-parse --verify ${branchName}`, { cwd: repoPath });
      } catch {
        await this.git(repoPath, `branch ${branchName} ${baseBranch}`);
      }
    }

    // Epic: reuse existing worktree at wtPath if it is on the right branch.
    if (isEpic) {
      const existing = await this.getWorktreePathForBranch(repoPath, branchName);
      if (existing !== null) {
        const resolvedExisting = await fs.realpath(existing).catch(() => path.resolve(existing));
        const resolvedWt = await fs.realpath(wtPath).catch(() => path.resolve(wtPath));
        if (resolvedExisting === resolvedWt) {
          await this.symlinkNodeModules(repoPath, wtPath);
          return wtPath;
        }
      }
    }

    // Remove stale worktree at our path if it exists
    await this.removeTaskWorktree(repoPath, worktreeKey);

    // If branch is checked out in a different path (stale/wrong entry), free it
    await this.freeBranchIfUsedElsewhere(repoPath, branchName, wtPath);

    // Create worktree with hooks disabled so post-checkout hooks do not run
    // in the worktree; task store operations only run from the main repo.
    await fs.mkdir(path.dirname(wtPath), { recursive: true });
    const noHooksWorktree = getGitNoHooksPath();
    await shellExec(
      `git -c core.hooksPath="${noHooksWorktree}" worktree add ${shellQuote(wtPath)} ${shellQuote(branchName)}`,
      {
        cwd: repoPath,
        timeout: 30000,
      }
    );

    // Symlink node_modules from main repo so dependencies are available in the worktree.
    // Git worktrees only contain tracked files; node_modules is gitignored.
    await this.symlinkNodeModules(repoPath, wtPath);

    return wtPath;
  }

  /**
   * Return the worktree path that has the given branch checked out, or null if none.
   */
  private async getWorktreePathForBranch(
    repoPath: string,
    branchName: string
  ): Promise<string | null> {
    const branchRef = `refs/heads/${branchName}`;
    const { stdout } = await shellExec("git worktree list --porcelain", { cwd: repoPath });
    let worktreePath: string | null = null;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        worktreePath = line.slice(9).trim();
        continue;
      }
      if (
        line.startsWith("branch ") &&
        line.trim() === `branch ${branchRef}` &&
        worktreePath != null
      ) {
        return worktreePath;
      }
      if (line === "" || line.startsWith("worktree ")) worktreePath = null;
    }
    return null;
  }

  /**
   * Ensure node_modules exists in the given repo. If missing and package.json exists,
   * runs dependency repair commands. Public for Branches mode (agent runs in main repo; no worktree symlink).
   * @returns true if node_modules exists after this call, false otherwise
   */
  async ensureRepoNodeModules(repoPath: string): Promise<boolean> {
    return this.ensureNodeModules(repoPath);
  }

  /**
   * Ensure node_modules exists in the main repo. If missing and package.json exists,
   * runs dependency repair commands. Used before symlinking so worktrees have dependencies.
   * @returns true if node_modules exists after this call, false otherwise
   */
  private async ensureNodeModules(repoPath: string): Promise<boolean> {
    const srcRoot = path.join(repoPath, "node_modules");
    try {
      await fs.access(srcRoot);
      return true;
    } catch {
      // node_modules missing — try npm install if package.json exists
    }

    const pkgPath = path.join(repoPath, "package.json");
    try {
      await fs.access(pkgPath);
    } catch {
      return false;
    }

    const repair = await this.repairDependencies(repoPath, "missing node_modules");
    if (!repair.success) {
      log.warn("Dependency repair failed while ensuring node_modules", {
        repoPath,
        attemptedCommands: repair.commands,
      });
      return false;
    }
    try {
      await fs.access(srcRoot);
      return true;
    } catch {
      return false;
    }
  }

  async ensureDependenciesHealthy(
    repoPath: string,
    wtPath?: string
  ): Promise<DependencyHealthResult> {
    const pkgPath = path.join(repoPath, "package.json");
    try {
      await fs.access(pkgPath);
    } catch {
      return {
        healthy: true,
        checkOutput: "",
        repairAttempted: false,
        repairSucceeded: false,
        repairCommands: [],
        repairOutput: "",
      };
    }

    const initialHealth = await this.runDependencyHealthCheck(repoPath);
    if (initialHealth.healthy) {
      return {
        healthy: true,
        checkOutput: initialHealth.output,
        repairAttempted: false,
        repairSucceeded: false,
        repairCommands: [],
        repairOutput: "",
      };
    }

    const repair = await this.repairDependencies(repoPath, "dependency health check failed");
    if (repair.success && wtPath && wtPath !== repoPath) {
      await this.symlinkNodeModules(repoPath, wtPath);
    }
    const postRepairHealth = await this.runDependencyHealthCheck(repoPath);
    return {
      healthy: postRepairHealth.healthy,
      checkOutput: postRepairHealth.output,
      repairAttempted: true,
      repairSucceeded: repair.success,
      repairCommands: repair.commands,
      repairOutput: repair.output,
    };
  }

  private async runDependencyHealthCheck(
    repoPath: string
  ): Promise<{ healthy: boolean; output: string }> {
    try {
      const { stdout, stderr } = await shellExec(DEPENDENCY_HEALTH_CHECK_COMMAND, {
        cwd: repoPath,
        timeout: NPM_HEALTH_CHECK_TIMEOUT_MS,
      });
      const output = [stdout, stderr].filter(Boolean).join("\n").trim().slice(0, 4000);
      return { healthy: true, output };
    } catch (err) {
      const output = getErrorText(err).trim().slice(0, 4000);
      return { healthy: false, output };
    }
  }

  private async repairDependencies(
    repoPath: string,
    context: string
  ): Promise<{ success: boolean; commands: string[]; output: string }> {
    const attempts: string[] = [];
    const outputs: string[] = [];
    for (const command of DEPENDENCY_REPAIR_COMMANDS) {
      attempts.push(command);
      try {
        const { stdout, stderr } = await shellExec(command, {
          cwd: repoPath,
          timeout: NPM_REPAIR_TIMEOUT_MS,
        });
        const output = [stdout, stderr].filter(Boolean).join("\n").trim();
        if (output) outputs.push(`[${command}] ${output}`);
        return {
          success: true,
          commands: attempts,
          output: outputs.join("\n").slice(0, 4000),
        };
      } catch (err) {
        const output = getErrorText(err).trim();
        if (output) outputs.push(`[${command}] ${output}`);
        log.warn("Dependency repair command failed", {
          repoPath,
          command,
          context,
          err: output || String(err),
        });
      }
    }

    return {
      success: false,
      commands: attempts,
      output: outputs.join("\n").slice(0, 4000),
    };
  }

  /**
   * Symlink node_modules directories from the main repo into a worktree.
   * Handles both root node_modules and any per-package node_modules
   * (e.g. .vite caches in workspace packages).
   * If the main repo lacks node_modules, runs dependency repair first.
   */
  async symlinkNodeModules(repoPath: string, wtPath: string): Promise<void> {
    // Safety: never symlink into the main repo itself
    const resolvedRepo = await fs.realpath(repoPath).catch(() => repoPath);
    const resolvedWt = await fs.realpath(wtPath).catch(() => wtPath);
    if (resolvedRepo === resolvedWt) {
      log.warn("symlinkNodeModules: wtPath equals repoPath, skipping to avoid circular symlinks");
      return;
    }

    // Symlink root node_modules (ensure it exists first)
    const srcRoot = path.join(repoPath, "node_modules");
    const destRoot = path.join(wtPath, "node_modules");
    try {
      await fs.access(srcRoot);
    } catch (err) {
      const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
      if (code === "ENOENT") {
        const ensured = await this.ensureNodeModules(repoPath);
        if (!ensured) {
          log.warn("Skipping root node_modules symlink: does not exist", {
            srcRoot,
            reason: "no package.json or npm install failed",
          });
          return;
        }
      } else {
        log.warn("Skipping root node_modules symlink", { code: code ?? err });
        return;
      }
    }

    try {
      await this.forceSymlink(srcRoot, destRoot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("Failed to symlink root node_modules", { err: msg });
    }

    // Symlink per-package node_modules (for .vite caches etc.)
    try {
      const packagesDir = path.join(repoPath, "packages");
      const entries = await fs.readdir(packagesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const srcPkg = path.join(packagesDir, entry.name, "node_modules");
        const destPkg = path.join(wtPath, "packages", entry.name, "node_modules");
        try {
          await fs.access(srcPkg);
          await fs.mkdir(path.dirname(destPkg), { recursive: true });
          await this.forceSymlink(srcPkg, destPkg);
        } catch {
          // Package doesn't have node_modules — skip
        }
      }
    } catch {
      // No packages directory or other issue — non-critical
    }
  }

  /**
   * Create a symlink, removing any existing file/symlink at the destination first.
   */
  private async forceSymlink(target: string, linkPath: string): Promise<void> {
    // Safety: never create a symlink that points to itself
    const resolvedTarget = await fs.realpath(target).catch(() => path.resolve(target));
    const resolvedLink = path.resolve(linkPath);
    if (resolvedTarget === resolvedLink) {
      log.warn("forceSymlink: target === linkPath, skipping circular symlink", {
        path: resolvedTarget,
      });
      return;
    }

    try {
      await fs.symlink(target, linkPath, "junction");
    } catch (err: unknown) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === "EEXIST") {
        // Don't delete a real directory that isn't a symlink
        const stat = await fs.lstat(linkPath);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          log.warn("forceSymlink: path is a real directory, refusing to replace", {
            linkPath,
          });
          return;
        }
        await fs.rm(linkPath, { recursive: true, force: true });
        await fs.symlink(target, linkPath, "junction");
      } else {
        throw err;
      }
    }
  }

  /**
   * Remove a task or epic worktree. Safe to call even if the worktree doesn't exist.
   * Logs errors so stale worktrees can be diagnosed; always attempts cleanup.
   * @param worktreeKey - Task ID (per-task) or worktree key (e.g. epic_<epicId>) for epic worktree.
   * @param actualPath - When provided (e.g. from assignment or git worktree list), use this path
   *   instead of getWorktreePath(worktreeKey). Critical when os.tmpdir() changes between process runs,
   *   which would otherwise leave orphaned worktrees.
   */
  async removeTaskWorktree(
    repoPath: string,
    worktreeKey: string,
    actualPath?: string
  ): Promise<void> {
    const wtPath = actualPath ?? this.getWorktreePath(worktreeKey);
    const registeredPath = await this.resolveRegisteredWorktreePath(repoPath, worktreeKey, wtPath);
    if (!registeredPath) {
      await this.removeWorktreeDirectorySafely(
        repoPath,
        worktreeKey,
        wtPath,
        "Refusing to remove unregistered worktree path"
      );
      return;
    }

    let safeRegisteredPath: string;
    try {
      safeRegisteredPath = await this.validateDisposableWorktreePath(
        repoPath,
        worktreeKey,
        registeredPath,
        "Refusing to remove registered worktree path"
      );
    } catch (err) {
      log.error("Refusing unsafe registered worktree cleanup target", {
        worktreeKey,
        registeredPath,
        err: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    try {
      await this.git(repoPath, `worktree remove ${shellQuote(safeRegisteredPath)} --force`);
    } catch (err) {
      log.warn("worktree remove failed, attempting manual cleanup", {
        worktreeKey,
        wtPath: safeRegisteredPath,
        err: err instanceof Error ? err.message : String(err),
      });
      const removed = await this.removeWorktreeDirectorySafely(
        repoPath,
        worktreeKey,
        safeRegisteredPath,
        "Manual worktree cleanup"
      );
      if (!removed) {
        log.warn("Manual worktree cleanup failed", {
          worktreeKey,
          wtPath: safeRegisteredPath,
        });
      }
    }
  }

  private async resolveRegisteredWorktreePath(
    repoPath: string,
    taskId: string,
    candidatePath: string
  ): Promise<string | null> {
    const worktrees = await this.listTaskWorktrees(repoPath);
    const candidateResolved = await fs
      .realpath(candidatePath)
      .catch(() => path.resolve(candidatePath));

    for (const worktree of worktrees) {
      if (worktree.taskId !== taskId) continue;
      const listedResolved = await fs
        .realpath(worktree.worktreePath)
        .catch(() => path.resolve(worktree.worktreePath));
      if (listedResolved === candidateResolved) {
        return worktree.worktreePath;
      }
    }

    return worktrees.find((worktree) => worktree.taskId === taskId)?.worktreePath ?? null;
  }

  /**
   * List all task worktrees for this repo.
   * Parses `git worktree list --porcelain` and returns { taskId, worktreePath } for each worktree
   * under any opensprint-worktrees directory (not just current tmpdir). This ensures we find
   * orphaned worktrees created when os.tmpdir() differed (e.g. before restart or TMPDIR change).
   */
  async listTaskWorktrees(
    repoPath: string
  ): Promise<Array<{ taskId: string; worktreePath: string }>> {
    const result: Array<{ taskId: string; worktreePath: string }> = [];
    try {
      const { stdout } = await shellExec("git worktree list --porcelain", { cwd: repoPath });
      for (const line of stdout.split("\n")) {
        if (!line.startsWith("worktree ")) continue;
        const worktreePath = line.slice(9).trim();
        const resolved = path.resolve(worktreePath);
        // Match any path under *opensprint-worktrees* (parent dir name), not just current tmpdir
        const parentDir = path.basename(path.dirname(resolved));
        if (parentDir === "opensprint-worktrees") {
          const taskId = path.basename(resolved);
          if (taskId) result.push({ taskId, worktreePath });
        }
      }
    } catch {
      // Repo may not exist or have no worktrees
    }
    return result;
  }

  /**
   * Prune orphan worktrees: remove worktrees whose tasks are closed or don't exist.
   * Called periodically by recovery to prevent accumulation of stale worktrees.
   * @param excludeTaskIds - Task IDs to never remove (e.g. slotted, in_progress)
   */
  async pruneOrphanWorktrees(
    repoPath: string,
    projectId: string,
    excludeTaskIds: Set<string>,
    taskStore: { listAll: (projectId: string) => Promise<Array<{ id: string; status?: string }>> }
  ): Promise<string[]> {
    const worktrees = await this.listTaskWorktrees(repoPath);
    const allIssues = await taskStore.listAll(projectId);
    const idToStatus = new Map(allIssues.map((i) => [i.id, (i.status as string) ?? ""]));
    const pruned: string[] = [];

    for (const { taskId, worktreePath } of worktrees) {
      if (excludeTaskIds.has(taskId)) continue;
      const status = idToStatus.get(taskId);
      // Remove if task doesn't exist or is closed
      if (status === undefined || status === "closed") {
        log.info("Pruning orphan worktree", { taskId, worktreePath, status: status ?? "no-task" });
        try {
          await this.removeTaskWorktree(repoPath, taskId, worktreePath);
          pruned.push(taskId);
        } catch (err) {
          log.warn("Failed to prune orphan worktree", { taskId, err });
        }
      }
    }
    return pruned;
  }

  /**
   * Get the number of commits a branch is ahead of the base branch.
   * Returns 0 if the branch doesn't exist or has no commits beyond the base.
   * @param baseBranch - Base branch to compare against (default: "main")
   */
  async getCommitCountAhead(
    repoPath: string,
    branchName: string,
    baseBranch: string = "main"
  ): Promise<number> {
    try {
      const { stdout } = await shellExec(`git rev-list --count ${baseBranch}..${branchName}`, {
        cwd: repoPath,
      });
      return parseInt(stdout.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Merge a branch into the base branch from the main working tree.
   * Ensures we're on baseBranch before merging.
   * @param message - Optional merge commit message (PRD §5.9: "merge: opensprint/<task-id> — <task title>")
   * @param baseBranch - Base branch to merge into (default: "main")
   */
  async mergeToMain(
    repoPath: string,
    branchName: string,
    message?: string,
    baseBranch: string = "main"
  ): Promise<void> {
    await this.ensureOnMain(repoPath, baseBranch);
    if (message) {
      const escaped = message.replace(/"/g, '\\"');
      await this.git(repoPath, `merge -m "${escaped}" ${branchName}`);
    } else {
      await this.git(repoPath, `merge ${branchName}`);
    }
  }

  /**
   * Merge a branch into the base branch without committing. Leaves the merge result staged.
   * Used when combining merge + task metadata into a single commit.
   * Ensures we're on baseBranch before merging.
   * @param baseBranch - Base branch to merge into (default: "main")
   */
  async mergeToMainNoCommit(
    repoPath: string,
    branchName: string,
    baseBranch: string = "main"
  ): Promise<MergeToMainResult> {
    await this.ensureOnMain(repoPath, baseBranch);
    let autoResolvedFiles: string[] = [];
    try {
      await this.git(repoPath, `merge --no-commit --no-ff ${branchName}`);
    } catch (mergeErr) {
      const { stdout } = await shellExec("git diff --name-only --diff-filter=U", {
        cwd: repoPath,
        timeout: 5000,
      }).catch(() => ({ stdout: "" }));
      const conflictFiles = stdout.trim().split("\n").filter(Boolean);

      if (conflictFiles.length === 0) {
        throw mergeErr;
      }

      const infraFiles = conflictFiles.filter((f) => f.startsWith(".opensprint/"));
      const codeConflicts = conflictFiles.filter((f) => !f.startsWith(".opensprint/"));

      log.info("Auto-resolving infra conflicts", {
        branchName,
        infraFiles,
        codeConflicts: codeConflicts.length,
      });

      for (const file of infraFiles) {
        try {
          await shellExec(`git rm -f ${shellQuote(file)}`, { cwd: repoPath, timeout: 5000 });
        } catch {
          await shellExec(`git add ${shellQuote(file)}`, { cwd: repoPath, timeout: 5000 }).catch(
            () => {}
          );
        }
      }
      autoResolvedFiles = infraFiles;

      if (codeConflicts.length > 0) {
        log.warn("Code conflicts remain after infra auto-resolve", { branchName, codeConflicts });
        // Do NOT mergeAbort — leave repo in merge state so merger agent can resolve.
        // Caller is responsible for mergeAbort if merger fails.
        throw new MergeConflictError(codeConflicts);
      }
      log.info("All conflicts auto-resolved", { branchName, resolvedCount: infraFiles.length });
    }

    // Strip .opensprint/ runtime paths from the staged merge result (sessions, active, pending-commits).
    await shellExec(
      "git rm -r --cached --ignore-unmatch .opensprint/pending-commits.json .opensprint/sessions .opensprint/active",
      { cwd: repoPath, timeout: 10000 }
    ).catch(() => {});
    const runtimePaths = [
      path.join(repoPath, ".opensprint", "pending-commits.json"),
      path.join(repoPath, ".opensprint", "sessions"),
      path.join(repoPath, ".opensprint", "active"),
    ];
    for (const p of runtimePaths) {
      try {
        const stat = await fs.stat(p);
        if (stat.isFile()) await fs.unlink(p);
        else if (stat.isDirectory()) await fs.rm(p, { recursive: true, force: true });
      } catch {
        // Path may not exist
      }
    }
    return { autoResolvedFiles };
  }

  /**
   * Rebase a branch onto the current base branch within a worktree.
   * Used before merge to ensure fast-forward merge is possible.
   * Throws RebaseConflictError if conflicts are found.
   * @param baseBranch - Base branch to rebase onto (default: "main")
   */
  async rebaseOntoMain(wtPath: string, baseBranch: string = "main"): Promise<void> {
    try {
      const noHooks = getGitNoHooksPath();
      await shellExec(`git -c core.hooksPath="${noHooks}" rebase --empty=drop ${baseBranch}`, {
        cwd: wtPath,
        timeout: 120000,
      });
    } catch (_err) {
      const conflicted = await this.getConflictedFiles(wtPath);
      throw new RebaseConflictError(conflicted);
    }
  }

  private async git(
    repoPath: string,
    command: string
  ): Promise<{ stdout: string; stderr: string }> {
    return shellExec(`git ${command}`, {
      cwd: repoPath,
      timeout: 30000,
    });
  }
}
