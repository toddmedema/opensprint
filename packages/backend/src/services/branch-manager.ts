import fs from "fs/promises";
import os from "os";
import path from "path";
import { OPENSPRINT_DIR, OPENSPRINT_PATHS } from "@opensprint/shared";
import { createLogger } from "../utils/logger.js";
import { waitForGitReady as waitForGitReadyUtil } from "../utils/git-lock.js";
import { getGitNoHooksPath } from "../utils/git-no-hooks.js";
import { runCommand } from "../utils/command-runner.js";
import {
  getErrorText,
  isBranchNotFoundError,
  isNoRebaseInProgressError,
  shouldAttemptRebaseSkip,
} from "../utils/git-error-classifier.js";
import { runGit, gitNoHooksConfigPrefix, gitListUnmergedPaths } from "../utils/git-command.js";
import {
  ensureRepoHasInitialCommit,
  getOriginUrl,
  RepoPreflightError,
} from "../utils/git-repo-state.js";
import { formatClosedCommitMessage, parseClosedCommitMessage } from "../utils/commit-message.js";
import { assertSafeTaskWorktreePath } from "../utils/path-safety.js";
import {
  evaluateWorktreeCleanupProtection,
  getWorktreeCleanupAssignmentGuardMs,
  listAssignmentSummariesInWorktree,
  logWorktreeCleanupBlocked,
  logWorktreeDeletionImminent,
  validateWorktreeCheckout,
  worktreePathsResolveEqually,
} from "../utils/worktree-health.js";
import { taskStore as taskStoreSingleton } from "./task-store.service.js";
import { ProjectService } from "./project.service.js";
import { heartbeatService } from "./heartbeat.service.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { isNodeDependencyStrategy, resolveToolchainProfile } from "./toolchain-profile.service.js";
import { unlinkWorktreeLinks } from "../utils/worktree-links.js";
import { worktreeRegistry } from "./worktree-registry.js";
import { worktreeLeaseService } from "./worktree-lease.service.js";

/** Paths we must not commit from worktrees (runtime-only; would block merge in main). Agent stats, event log, and orchestrator counters are now DB-only. */
const RUNTIME_EXCLUDE_FOR_WIP = [
  OPENSPRINT_PATHS.pendingCommits,
  `${OPENSPRINT_PATHS.sessions}/`,
  `${OPENSPRINT_PATHS.active}/`,
  `${OPENSPRINT_DIR}/runtime/`,
];
/**
 * Keep dependency installs out of automated WIP commits.
 * Note: `node_modules/` in .gitignore does not ignore a symlink named `node_modules`,
 * so we explicitly unstage any node_modules pathspec after `git add -A`.
 */
const DEPENDENCY_EXCLUDE_PATHS_FOR_WIP = [":(glob)**/node_modules", ":(glob)**/node_modules/**"];
const WIP_EXCLUDE_PATHS = [...RUNTIME_EXCLUDE_FOR_WIP, ...DEPENDENCY_EXCLUDE_PATHS_FOR_WIP];
const log = createLogger("branch-manager");
const DIFF_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

function shellCommandToSpec(shellStyleCommand: string): { command: string; args: string[] } {
  const tokens = shellStyleCommand.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error("Command cannot be empty");
  }
  return { command: tokens[0]!, args: tokens.slice(1) };
}

/** Thrown when `pushMain` rebase encounters conflicts. Repo is left in rebase state. */
export class RebaseConflictError extends Error {
  constructor(public readonly conflictedFiles: string[]) {
    super(`Rebase conflict in ${conflictedFiles.length} file(s): ${conflictedFiles.join(", ")}`);
    this.name = "RebaseConflictError";
  }
}

/** Structured context when `rebase --continue` must not run or failed for a non-conflict reason. */
export interface RebaseContinueDiagnostics {
  cause: "preflight_unmerged" | "preflight_staged_markers" | "continue_failed";
  /** Which rebase metadata dirs exist under the resolved git dir (e.g. `rebase-merge`). */
  rebaseMetadataPresent: string[];
  conflictedFiles: string[];
  /** Truncated `git status --short` for task diagnostics. */
  gitStatusShort?: string;
  /** Git/command message when `rebase --continue` was attempted and failed. */
  underlyingMessage?: string;
}

/**
 * Thrown instead of a bare {@link CommandRunError} when automation should not treat the failure
 * as a generic infra/git glitch (e.g. unmerged paths before continue, or continue failed oddly).
 */
export class RebaseContinueBlockedError extends Error {
  constructor(
    message: string,
    public readonly diagnostics: RebaseContinueDiagnostics,
    /** When set, merge coordination can attribute the failure to the correct stage. */
    public readonly mergeFailureStage?:
      | "rebase_before_merge"
      | "merge_to_main"
      | "push_rebase"
      | "quality_gate"
  ) {
    super(message);
    this.name = "RebaseContinueBlockedError";
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

const NPM_HEALTH_CHECK_TIMEOUT_MS = 30_000;
const NPM_REPAIR_TIMEOUT_MS = 10 * 60 * 1000;
const DEPENDENCY_HEALTH_CHECK_COMMAND = "npm ls --depth=0 --include=dev";
const DEPENDENCY_HEALTH_CHECK_WORKSPACES_COMMAND = "npm ls --depth=0 --workspaces --include=dev";
const DEPENDENCY_REPAIR_COMMAND = "npm ci";
const WORKTREE_RM_RETRYABLE_CODES = new Set(["ENOTEMPTY", "EBUSY"]);
const WORKTREE_RM_MAX_ATTEMPTS = 3;
const WORKTREE_RM_RETRY_DELAY_MS = 250;
const NPM_INCLUDE_DEV_ENV = {
  NPM_CONFIG_INCLUDE: "dev",
  npm_config_include: "dev",
  NPM_CONFIG_OMIT: "",
  npm_config_omit: "",
} as const;

export interface DependencyHealthResult {
  healthy: boolean;
  checkOutput: string;
  repairAttempted: boolean;
  repairSucceeded: boolean;
  repairCommands: string[];
  repairOutput: string;
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

export class RepoRootDirtyRestoreError extends Error {
  constructor(
    message: string,
    public readonly stashRef: string,
    public readonly originalError?: unknown,
    public readonly restoreError?: unknown
  ) {
    super(message);
    this.name = "RepoRootDirtyRestoreError";
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

  private async resolveToolchainProfileForRepo(repoPath: string) {
    try {
      const project = await this.projectService.getProjectByRepoPath(repoPath);
      if (!project) return resolveToolchainProfile(undefined);
      const settings = await this.projectService.getSettings(project.id);
      return resolveToolchainProfile(settings.toolchainProfile);
    } catch {
      return resolveToolchainProfile(undefined);
    }
  }

  private async gitExec(
    repoPath: string,
    args: string[],
    opts?: { timeout?: number; maxStdoutBytes?: number; maxStderrBytes?: number }
  ): Promise<{ stdout: string; stderr: string }> {
    return runGit(args, {
      cwd: repoPath,
      timeout: opts?.timeout ?? 30_000,
      maxStdoutBytes: opts?.maxStdoutBytes,
      maxStderrBytes: opts?.maxStderrBytes,
    });
  }

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

  private async getStatusPorcelain(repoPath: string): Promise<string> {
    const { stdout } = await this.gitExec(repoPath, ["status", "--porcelain"], { timeout: 10_000 });
    return stdout.trim();
  }

  private async stashRepoRootIfDirty(repoPath: string, reason: string): Promise<string | null> {
    const status = await this.getStatusPorcelain(repoPath).catch(() => "");
    if (!status) return null;

    const message = `opensprint-auto-stash:${reason}:${Date.now()}`;
    await this.gitExec(repoPath, ["stash", "push", "--include-untracked", "--message", message], {
      timeout: 30_000,
    }).catch((err) => {
      log.warn("Failed to create auto-stash for repo-root operation", {
        repoPath,
        reason,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    });

    const { stdout } = await this.gitExec(
      repoPath,
      ["stash", "list", "--format=%gd %s", "-n", "1"],
      { timeout: 10_000 }
    ).catch(() => ({ stdout: "" }));
    const latest = stdout.trim();
    if (!latest.includes(message)) {
      return null;
    }
    const [stashRef] = latest.split(/\s+/, 1);
    return stashRef ?? null;
  }

  async withRepoRootAutoStash<T>(
    repoPath: string,
    reason: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const stashRef = await this.stashRepoRootIfDirty(repoPath, reason);
    let result: T | undefined;
    let originalError: unknown;

    try {
      result = await fn();
    } catch (err) {
      originalError = err;
    }

    if (stashRef) {
      try {
        await this.gitExec(repoPath, ["stash", "pop", "--index", stashRef], { timeout: 30_000 });
      } catch (restoreErr) {
        throw new RepoRootDirtyRestoreError(
          `Open Sprint temporarily stashed repo-root changes for "${reason}" but could not restore them cleanly. Resolve the working tree manually and retry.`,
          stashRef,
          originalError,
          restoreErr
        );
      }
    }

    if (originalError) {
      throw originalError;
    }

    return result as T;
  }

  private async createBranchInternal(
    repoPath: string,
    branchName: string,
    baseBranch: string
  ): Promise<void> {
    await this.gitExec(repoPath, ["checkout", baseBranch]);
    await this.gitExec(repoPath, ["checkout", "-b", branchName]);
  }

  private async ensureOnMainInternal(repoPath: string, baseBranch: string): Promise<void> {
    let currentBranch: string;
    try {
      currentBranch = await this.getCurrentBranch(repoPath);
    } catch {
      return;
    }
    if (currentBranch !== baseBranch) {
      log.warn("Expected %s but on different branch, switching", { baseBranch, currentBranch });
      try {
        await this.gitExec(repoPath, ["reset", "--hard", "HEAD"]);
        await this.gitExec(repoPath, ["checkout", baseBranch]);
      } catch {
        await this.gitExec(repoPath, ["checkout", "-f", baseBranch]);
      }
    }

    try {
      if (process.platform === "win32") {
        await this.gitExec(repoPath, ["checkout", "-f", "HEAD", "--", ".opensprint/"], {
          timeout: 10_000,
        });
      } else {
        const { stdout: lsOut } = await this.gitExec(repoPath, ["ls-files", ".opensprint/"], {
          timeout: 10_000,
        }).catch(() => ({ stdout: "" }));
        for (const file of lsOut
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)) {
          await this.gitExec(
            repoPath,
            ["update-index", "--no-assume-unchanged", "--no-skip-worktree", "--", file],
            { timeout: 10_000 }
          ).catch((err: unknown) => { log.warn("git update-index failed", { err: err instanceof Error ? err.message : String(err) }); });
        }
        await this.gitExec(repoPath, ["checkout", "-f", "HEAD", "--", ".opensprint/"], {
          timeout: 10_000,
        }).catch((err: unknown) => { log.warn("git checkout .opensprint failed", { err: err instanceof Error ? err.message : String(err) }); });
      }
    } catch {
      // Best-effort cleanup; merge may still succeed without it
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
    for (let attempt = 1; attempt <= WORKTREE_RM_MAX_ATTEMPTS; attempt += 1) {
      try {
        await fs.rm(safePath, { recursive: true, force: true });
        break;
      } catch (rmErr) {
        const code =
          rmErr && typeof rmErr === "object" && "code" in rmErr
            ? String((rmErr as { code?: string }).code ?? "")
            : "";
        const retryable = WORKTREE_RM_RETRYABLE_CODES.has(code);
        const willRetry = retryable && attempt < WORKTREE_RM_MAX_ATTEMPTS;
        log.warn("fs.rm failed during worktree directory cleanup", {
          taskId,
          safePath,
          attempt,
          willRetry,
          err: rmErr instanceof Error ? rmErr.message : String(rmErr),
        });
        if (!willRetry) break;
        await new Promise((resolve) => setTimeout(resolve, WORKTREE_RM_RETRY_DELAY_MS * attempt));
      }
    }
    await this.gitExec(repoPath, ["worktree", "prune"]).catch((err: unknown) => { log.warn("git worktree prune failed", { err: err instanceof Error ? err.message : String(err) }); });
    try {
      await fs.access(safePath);
      return false;
    } catch {
      return true;
    }
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
    await this.withRepoRootAutoStash(repoPath, `create branch ${branchName}`, async () => {
      await this.createBranchInternal(repoPath, branchName, baseBranch);
    });
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
    await ensureRepoHasInitialCommit(repoPath, baseBranch);
    await this.withRepoRootAutoStash(repoPath, `checkout branch ${branchName}`, async () => {
      try {
        await this.gitExec(repoPath, ["rev-parse", "--verify", branchName]);
        await this.checkout(repoPath, branchName);
      } catch {
        await this.createBranchInternal(repoPath, branchName, baseBranch);
      }
    });
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
      await this.gitExec(repoPath, ["rev-parse", "--verify", branchName]);
    } catch {
      await this.gitExec(repoPath, ["branch", branchName, baseBranch]);
    }
  }

  /**
   * Switch to a branch.
   */
  async checkout(repoPath: string, branchName: string): Promise<void> {
    await this.gitExec(repoPath, ["checkout", branchName]);
  }

  /**
   * Get the current branch name.
   */
  async getCurrentBranch(repoPath: string): Promise<string> {
    const { stdout } = await this.gitExec(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return stdout.trim();
  }

  private async resolveGitMetadataPath(repoPath: string, fileName: string): Promise<string> {
    const dotGitPath = path.join(repoPath, ".git");
    try {
      const stat = await fs.stat(dotGitPath);
      if (stat.isDirectory()) {
        return path.join(dotGitPath, fileName);
      }
      if (stat.isFile()) {
        const gitDirPointer = await fs.readFile(dotGitPath, "utf-8");
        const match = gitDirPointer.match(/^gitdir:\s*(.+)$/m);
        if (match?.[1]) {
          const gitDir = match[1].trim();
          const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(repoPath, gitDir);
          return path.join(resolvedGitDir, fileName);
        }
      }
    } catch {
      // Fall back to the standard repo layout below.
    }
    return path.join(dotGitPath, fileName);
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
    const deleteTaskBranch = async (): Promise<void> => {
      try {
        await this.gitExec(repoPath, ["branch", "-D", branchName]);
      } catch (deleteErr: unknown) {
        if (isBranchNotFoundError(deleteErr)) {
          return; // Branch already gone (e.g. unblock before prepare)
        }
        throw deleteErr;
      }
    };

    try {
      const currentBranch = await this.getCurrentBranch(repoPath).catch(() => "");
      if (currentBranch === branchName) {
        // We're on the task branch: reset, switch to base, then delete
        await this.gitExec(repoPath, ["reset", "--hard", "HEAD"]);
        await this.gitExec(repoPath, ["clean", "-fd"]);
        await this.gitExec(repoPath, ["checkout", baseBranch]);
        await deleteTaskBranch();
      } else {
        // Not on task branch (e.g. unblock before any prepare): just delete if it exists
        await deleteTaskBranch();
      }
    } catch (error) {
      if (isBranchNotFoundError(error)) {
        // Branch didn't exist; goal achieved, no need to log or recover
        return;
      }
      log.error("Failed to revert branch", { branchName, error });
      try {
        await this.gitExec(repoPath, ["checkout", "-f", baseBranch]);
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
      const { stdout } = await this.gitExec(repoPath, ["branch", "--merged", baseBranch]);
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
      await this.gitExec(repoPath, ["branch", "-d", branchName]);
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
    const { stdout } = await this.gitExec(repoPath, ["diff", `${baseBranch}...${branchName}`], {
      maxStdoutBytes: DIFF_MAX_BUFFER_BYTES,
    });
    return stdout;
  }

  /**
   * Push a branch to the remote. Used to preserve work before crash recovery revert.
   */
  async pushBranch(repoPath: string, branchName: string): Promise<void> {
    try {
      await this.gitExec(repoPath, ["push", "-u", "origin", branchName]);
    } catch (error) {
      log.warn("pushBranch failed", { branchName, error });
      throw error;
    }
  }

  /**
   * Prepare the base branch for publishing. Fetches and rebases first when origin/<baseBranch>
   * exists (to handle concurrent pushes).
   * If the remote has no base branch (e.g. empty repo or first push), skips rebase.
   * If rebase hits conflicts, throws a RebaseConflictError (repo left in rebase state
   * so a merger agent can resolve). Caller is responsible for aborting if resolution fails.
   * @param baseBranch - Base branch to push (default: "main")
   */
  async prepareMainForPush(repoPath: string, baseBranch: string = "main"): Promise<void> {
    const originUrl = await getOriginUrl(repoPath);
    if (!originUrl) {
      log.info("prepareMainForPush: no origin configured, skipping publish prep", { baseBranch });
      return;
    }
    try {
      await this.gitExec(repoPath, ["fetch", "origin", baseBranch]);
    } catch (error) {
      log.warn("prepareMainForPush: fetch failed, pushing anyway", { error });
    }

    await this.commitWip(repoPath, "pre-push");

    const originRef = `origin/${baseBranch}`;
    const hasOriginBase = await this.hasRemoteBranch(repoPath, originRef);
    if (hasOriginBase) {
      await this.squashLocalCommits(repoPath, originRef);

      try {
        const noHooks = getGitNoHooksPath();
        await this.gitExec(
          repoPath,
          [...gitNoHooksConfigPrefix(noHooks), "rebase", "--empty=drop", originRef],
          { timeout: 120_000 }
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
      log.info(
        "prepareMainForPush: origin branch not present (e.g. empty remote), skipping rebase",
        {
          baseBranch,
        }
      );
    }
  }

  /**
   * Push the base branch to the remote. Called after successful merge so completed work reaches origin.
   * Fetches/rebases first via prepareMainForPush().
   * @param baseBranch - Base branch to push (default: "main")
   */
  async pushMain(repoPath: string, baseBranch: string = "main"): Promise<void> {
    await this.prepareMainForPush(repoPath, baseBranch);
    await this.pushMainToOrigin(repoPath, baseBranch);
  }

  /**
   * Squash all local-only commits (ahead of base) into a single commit.
   * Prevents accumulation of WIP/metadata commits that make rebase O(n) and fragile.
   * Uses "Closed <taskId>: <title truncated to ~45 chars>" when task info is available;
   * otherwise falls back to "squash N local commits for rebase".
   */
  private async squashLocalCommits(repoPath: string, base: string): Promise<void> {
    try {
      const { stdout: countStr } = await this.gitExec(
        repoPath,
        ["rev-list", "--count", `${base}..HEAD`],
        {
          timeout: 5000,
        }
      );
      const localCount = parseInt(countStr.trim(), 10);
      if (localCount <= 1) return;

      let commitMessage = `squash ${localCount} local commits for rebase`;
      const { stdout: logOut } = await this.gitExec(
        repoPath,
        ["log", "--format=%s", `${base}..HEAD`],
        { timeout: 5000 }
      );
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
      await this.gitExec(repoPath, ["reset", "--soft", base], { timeout: 10_000 });
      const noHooksSquash = getGitNoHooksPath();
      await this.gitExec(
        repoPath,
        [...gitNoHooksConfigPrefix(noHooksSquash), "commit", "-m", commitMessage],
        { timeout: 30_000 }
      );
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
      const { stdout: mergeParents } = await this.gitExec(
        repoPath,
        ["log", `${base}..HEAD`, "--merges", "-1", "--format=%P"],
        { timeout: 5000 }
      );
      const parents = mergeParents.trim().split(/\s+/).filter(Boolean);
      if (parents.length < 2) return null;

      const branchTip = parents[1];
      const { stdout: refNames } = await this.gitExec(
        repoPath,
        ["branch", "-a", "--contains", branchTip],
        { timeout: 5000 }
      );
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
      await this.gitExec(repoPath, ["rev-parse", "--verify", ref]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Push the exact current base-branch HEAD to origin without further local mutations.
   * @param baseBranch - Base branch to push (default: "main")
   */
  async pushMainToOrigin(repoPath: string, baseBranch: string = "main"): Promise<void> {
    const originUrl = await getOriginUrl(repoPath);
    if (!originUrl) {
      log.info("pushMainToOrigin: no origin configured, skipping publish", { baseBranch });
      return;
    }
    const noHooksPush = getGitNoHooksPath();
    await this.gitExec(repoPath, [
      ...gitNoHooksConfigPrefix(noHooksPush),
      "push",
      "origin",
      baseBranch,
    ]);
  }

  /**
   * List files with merge/rebase conflicts (unmerged paths).
   */
  async getConflictedFiles(repoPath: string): Promise<string[]> {
    try {
      const { stdout } = await this.gitExec(repoPath, ["diff", "--name-only", "--diff-filter=U"]);
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
      const { stdout } = await this.gitExec(repoPath, ["diff"], {
        maxStdoutBytes: DIFF_MAX_BUFFER_BYTES,
      });
      return stdout;
    } catch {
      return "";
    }
  }

  private async getStagedPathNames(repoPath: string): Promise<string[]> {
    try {
      const { stdout } = await this.gitExec(
        repoPath,
        ["diff", "--cached", "--name-only"],
        { timeout: 10_000 }
      );
      return stdout.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  private async collectRebaseContinueDiagnostics(
    repoPath: string,
    cause: RebaseContinueDiagnostics["cause"],
    opts?: { underlyingMessage?: string }
  ): Promise<RebaseContinueDiagnostics> {
    const conflictedFiles = await this.getConflictedFiles(repoPath);
    const rebaseMetadataPresent: string[] = [];
    for (const dir of ["rebase-merge", "rebase-apply"] as const) {
      try {
        const metaPath = await this.resolveGitMetadataPath(repoPath, dir);
        await fs.access(metaPath);
        rebaseMetadataPresent.push(dir);
      } catch {
        // absent
      }
    }
    let gitStatusShort: string | undefined;
    try {
      const { stdout } = await this.gitExec(repoPath, ["status", "--short"], { timeout: 10_000 });
      const t = stdout.trim();
      gitStatusShort = t.length > 2000 ? `${t.slice(0, 2000)}…` : t || undefined;
    } catch {
      // best-effort
    }
    return {
      cause,
      rebaseMetadataPresent,
      conflictedFiles,
      gitStatusShort,
      underlyingMessage: opts?.underlyingMessage,
    };
  }

  /**
   * Stage all resolved files and continue an in-progress rebase.
   */
  async rebaseContinue(repoPath: string): Promise<void> {
    await this.gitExec(repoPath, ["add", "-A"]);
    await this.resetExcludedWipPaths(repoPath);
    const unmergedPrefetch = await gitListUnmergedPaths({ cwd: repoPath, timeout: 10_000 });
    if (unmergedPrefetch.length > 0) {
      const diagnostics = await this.collectRebaseContinueDiagnostics(
        repoPath,
        "preflight_unmerged"
      );
      log.warn("rebaseContinue: skipping git rebase — unmerged paths remain after staging", {
        repoPath,
        unmerged: unmergedPrefetch,
        rebaseMetadataPresent: diagnostics.rebaseMetadataPresent,
      });
      throw new RebaseContinueBlockedError(
        `Rebase continue blocked (preflight): unmerged paths remain: ${unmergedPrefetch.join(", ")}`,
        diagnostics
      );
    }

    try {
      await this.gitExec(repoPath, ["diff", "--cached", "--check"], { timeout: 10_000 });
    } catch (checkErr) {
      const stagedNames = await this.getStagedPathNames(repoPath);
      const baseDiag = await this.collectRebaseContinueDiagnostics(
        repoPath,
        "preflight_staged_markers",
        { underlyingMessage: getErrorText(checkErr).trim().slice(0, 500) || undefined }
      );
      const conflictedFiles =
        stagedNames.length > 0 ? stagedNames : baseDiag.conflictedFiles;
      const fileHint =
        conflictedFiles.length > 0
          ? conflictedFiles.join(", ")
          : "(see git diff --cached --check output)";
      const diagnostics: RebaseContinueDiagnostics = {
        ...baseDiag,
        cause: "preflight_staged_markers",
        conflictedFiles,
      };
      log.warn("rebaseContinue: skipping git rebase — staged content still has conflict markers", {
        repoPath,
        stagedNames,
        rebaseMetadataPresent: diagnostics.rebaseMetadataPresent,
      });
      throw new RebaseContinueBlockedError(
        `Rebase continue blocked (preflight): conflict markers or whitespace errors in index (files: ${fileHint})`,
        diagnostics
      );
    }

    const noHooks = getGitNoHooksPath();
    try {
      await this.gitExec(
        repoPath,
        ["-c", "core.editor=true", "-c", `core.hooksPath=${noHooks}`, "rebase", "--continue"],
        { timeout: 30_000 }
      );
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
          await this.gitExec(
            repoPath,
            ["-c", "core.editor=true", "-c", `core.hooksPath=${noHooks}`, "rebase", "--skip"],
            { timeout: 30_000 }
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
          const skipDiag = await this.collectRebaseContinueDiagnostics(repoPath, "continue_failed", {
            underlyingMessage: getErrorText(skipErr).trim().slice(0, 500) || undefined,
          });
          log.warn("rebaseContinue: rebase --skip failed with no unmerged paths", {
            repoPath,
            diagnostics: skipDiag,
          });
          throw new RebaseContinueBlockedError(
            `Rebase continue failed after skip: ${getErrorText(skipErr).trim().slice(0, 300) || "unknown error"}`,
            skipDiag
          );
        }
      }
      const diagnostics = await this.collectRebaseContinueDiagnostics(repoPath, "continue_failed", {
        underlyingMessage: getErrorText(err).trim().slice(0, 500) || undefined,
      });
      log.warn("rebaseContinue: rebase --continue failed with no unmerged paths", {
        repoPath,
        diagnostics,
      });
      throw new RebaseContinueBlockedError(
        `Rebase continue failed: ${getErrorText(err).trim().slice(0, 300) || "unknown error"}`,
        diagnostics
      );
    }
  }

  /**
   * Abort an in-progress rebase, restoring the repo to its pre-rebase state.
   */
  async rebaseAbort(repoPath: string): Promise<void> {
    await this.gitExec(repoPath, ["rebase", "--abort"]).catch((err: unknown) => { log.warn("git rebase --abort failed", { err: err instanceof Error ? err.message : String(err) }); });
  }

  /**
   * Check whether a merge is currently in progress (merge conflicted).
   */
  async isMergeInProgress(repoPath: string): Promise<boolean> {
    try {
      const mergeHeadPath = await this.resolveGitMetadataPath(repoPath, "MERGE_HEAD");
      await fs.access(mergeHeadPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stage resolved files and complete an in-progress merge.
   */
  async mergeContinue(repoPath: string): Promise<void> {
    await this.gitExec(repoPath, ["add", "-A"]);
    await this.gitExec(repoPath, ["-c", "core.editor=true", "commit", "--no-edit"], {
      timeout: 30_000,
    });
  }

  /**
   * Abort an in-progress merge.
   */
  async mergeAbort(repoPath: string): Promise<void> {
    await this.gitExec(repoPath, ["merge", "--abort"]).catch((err: unknown) => { log.warn("git merge --abort failed", { err: err instanceof Error ? err.message : String(err) }); });
  }

  /**
   * Check whether a rebase is currently in progress.
   */
  async isRebaseInProgress(repoPath: string): Promise<boolean> {
    for (const dir of ["rebase-merge", "rebase-apply"]) {
      try {
        const candidate = await this.resolveGitMetadataPath(repoPath, dir);
        await fs.access(candidate);
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
      const { stdout } = await this.gitExec(repoPath, ["status", "--porcelain"], { timeout: 5000 });
      if (!stdout.trim()) return false;

      await this.gitExec(repoPath, ["add", "-A"]);
      await this.resetExcludedWipPaths(repoPath);
      // After excluding runtime paths, the working tree may still show untracked files
      // (e.g. `.opensprint/active/`) while nothing remains staged — do not run `git commit`
      // in that case or git exits with "nothing added to commit but untracked files present".
      try {
        await this.gitExec(repoPath, ["diff", "--cached", "--quiet"], { timeout: 5000 });
        return false;
      } catch {
        // diff --cached exits 1 when there is something staged — proceed to commit.
      }

      const noHooksWip = getGitNoHooksPath();
      await this.gitExec(
        repoPath,
        [...gitNoHooksConfigPrefix(noHooksWip), "commit", "-m", `WIP: ${taskId}`],
        { timeout: 30_000 }
      );
      return true;
    } catch (error) {
      log.warn("commitWip failed", { taskId, error });
      return false;
    }
  }

  /**
   * Tracked paths that are missing on disk but still listed in the index (`git ls-files -d`).
   * Indicates disk/index drift before merge gates (e.g. partial delete without staging).
   */
  async listGitIndexFilesDeletedOnDisk(gitCwd: string): Promise<string[]> {
    const { stdout } = await this.gitExec(gitCwd, ["ls-files", "-d"], { timeout: 10_000 });
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((line) => line.length > 0);
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
    const { stdout } = await this.gitExec(repoPath, [
      "diff",
      "--name-only",
      `${baseBranch}...${branchName}`,
    ]);
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

  /** Resolve a git ref to a full commit SHA, or null if missing/invalid. */
  async getGitRev(cwd: string, rev: string): Promise<string | null> {
    try {
      const { stdout } = await this.gitExec(cwd, ["rev-parse", rev], { timeout: 10_000 });
      const s = stdout.trim();
      return s.length > 0 ? s : null;
    } catch {
      return null;
    }
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
      await this.gitExec(repoPath, ["fetch", "origin", baseBranch]);
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
    const { stdout } = await this.gitExec(
      repoPath,
      ["rev-list", "--left-right", "--count", `${baseBranch}...${originRef}`],
      { timeout: 5000 }
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
      await this.withRepoRootAutoStash(repoPath, `sync ${baseBranch} with origin`, async () => {
        if (currentBranch !== baseBranch) {
          await this.gitExec(repoPath, ["checkout", baseBranch]);
        }
        await this.gitExec(repoPath, ["merge", "--ff-only", originRef]);
      });
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
    await this.withRepoRootAutoStash(repoPath, `ensure on ${baseBranch}`, async () => {
      await this.ensureOnMainInternal(repoPath, baseBranch);
    });
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
      const { stdout } = await this.gitExec(repoPath, ["diff", `${baseBranch}...${branchName}`], {
        maxStdoutBytes: DIFF_MAX_BUFFER_BYTES,
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
      await this.gitExec(gitPath, ["add", "-A"]);
      await this.resetExcludedWipPaths(gitPath);
      try {
        const { stdout } = await this.gitExec(gitPath, ["diff", "--cached", "HEAD"], {
          maxStdoutBytes: DIFF_MAX_BUFFER_BYTES,
        });
        return stdout;
      } finally {
        await this.gitExec(gitPath, ["reset", "HEAD"]).catch((err: unknown) => { log.warn("git reset HEAD failed", { err: err instanceof Error ? err.message : String(err) }); });
      }
    } catch {
      return "";
    }
  }

  /** Unstage paths that must never be included in automated WIP commits or diff snapshots. */
  private async resetExcludedWipPaths(repoPath: string): Promise<void> {
    await this.gitExec(repoPath, ["reset", "HEAD", "--", ...WIP_EXCLUDE_PATHS]).catch(
      (err: unknown) => log.warn("resetExcludedWipPaths failed (paths may not be staged)", { err: err instanceof Error ? err.message : String(err) })
    );
  }

  // ─── Git Worktree Operations ───

  /** Legacy temp-based base directory (pre-durable). Used for backward-compatible discovery. */
  getLegacyWorktreeBasePath(): string {
    return path.join(os.tmpdir(), "opensprint-worktrees");
  }

  /**
   * Durable base directory for task worktrees, scoped to the project repo.
   * Falls back to the legacy temp path when no repoPath is available.
   */
  getWorktreeBasePath(repoPath?: string): string {
    if (repoPath) {
      return path.join(repoPath, OPENSPRINT_PATHS.worktrees);
    }
    return this.getLegacyWorktreeBasePath();
  }

  /**
   * Get the filesystem path for a worktree by key.
   * @param key - Task ID (per-task worktree) or epic key (e.g. epic_<epicId> for shared epic worktree).
   * @param repoPath - When provided, uses the durable project-scoped root; otherwise legacy temp root.
   */
  getWorktreePath(key: string, repoPath?: string): string {
    return path.join(this.getWorktreeBasePath(repoPath), key);
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
    const { stdout } = await this.gitExec(repoPath, ["worktree", "list", "--porcelain"]);
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

        const project = await this.projectService.getProjectByRepoPath(repoPath).catch(() => null);
        if (project) {
          const resolvedOther = path.resolve(
            await fs.realpath(safeOtherPath).catch(() => safeOtherPath)
          );
          const protection = await evaluateWorktreeCleanupProtection(
            project.id,
            resolvedOther,
            (pid, tid) => this.taskStore.show(pid, tid),
            getWorktreeCleanupAssignmentGuardMs()
          );
          if (protection.forbid) {
            logWorktreeCleanupBlocked("free_branch_elsewhere", {
              projectId: project.id,
              worktreePath: resolvedOther,
              reason: protection.reason ?? "unknown",
              referencingTaskIds: protection.referencingTaskIds,
              cleanupTrigger: "free_branch_stale_duplicate",
            });
            throw new WorktreeBranchInUseError(
              `Branch ${branchName} is in use by worktree at ${worktreePath} (assignment/task guard: ${protection.reason}). Retry later or restart the backend.`,
              branchName,
              worktreePath,
              otherTaskId
            );
          }
        }

        log.warn("Branch already in use by another worktree; removing stale entry", {
          branchName,
          otherPath: worktreePath,
          ourPath,
        });
        try {
          await unlinkWorktreeLinks(safeOtherPath);
          await this.gitExec(repoPath, ["worktree", "remove", safeOtherPath, "--force"]);
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
    const wtPath = this.getWorktreePath(worktreeKey, repoPath);

    // Normalize base branch (and create initial commit if needed) *before* checking whether the
    // primary clone still has the task branch checked out. Otherwise a human (or tooling) on
    // `opensprint/<task>` would block `git worktree add` for that branch — ensureBaseBranchExists
    // moves the main repo to `baseBranch` when possible so the worktree can claim the task branch.
    await ensureRepoHasInitialCommit(repoPath, baseBranch);
    let currentBranch = await this.getCurrentBranch(repoPath).catch(() => "");

    // Primary clone must not stay on `branchName` — `git worktree add` needs that branch free.
    // `ensureRepoHasInitialCommit` usually checks out `baseBranch`; if we are still on the task
    // branch (e.g. tooling left HEAD there), try an explicit checkout before failing.
    if (currentBranch === branchName) {
      try {
        await this.gitExec(repoPath, ["checkout", baseBranch]);
      } catch {
        throw new UnsafeCleanupPathError(
          `Refusing to create worktree for ${branchName}: the main repo is checked out to that branch and could not switch to ${baseBranch}.`,
          repoPath
        );
      }
      currentBranch = await this.getCurrentBranch(repoPath).catch(() => "");
      if (currentBranch === branchName) {
        throw new UnsafeCleanupPathError(
          `Refusing to create worktree for ${branchName}: the main repo is still checked out to that branch after normalizing the base branch, so cleanup would be unsafe.`,
          repoPath
        );
      }
    }

    const isEpic = options?.worktreeKey != null;

    if (isEpic) {
      // Epic: ensure branch exists without checking out in main repo (so main stays on main and we can add worktree).
      await this.ensureBranchExists(repoPath, branchName, baseBranch);
    } else {
      // Per-task: create branch if it doesn't exist.
      try {
        await this.gitExec(repoPath, ["rev-parse", "--verify", branchName]);
      } catch {
        await this.gitExec(repoPath, ["branch", branchName, baseBranch]);
      }
    }

    if (isEpic) {
      const existing = await this.getWorktreePathForBranch(repoPath, branchName);
      if (existing !== null) {
        const resolvedExisting = await fs.realpath(existing).catch(() => path.resolve(existing));
        const resolvedWt = await fs.realpath(wtPath).catch(() => path.resolve(wtPath));
        if (resolvedExisting === resolvedWt) {
          await validateWorktreeCheckout(repoPath, wtPath);
          await this.symlinkNodeModules(repoPath, wtPath);
          return wtPath;
        }
      }
    }

    // Remove stale worktree at our path if it exists (assignment guard before lease release)
    try {
      await fs.access(wtPath);
      const project = await this.projectService.getProjectByRepoPath(repoPath).catch(() => null);
      if (project) {
        const resolvedWt = path.resolve(await fs.realpath(wtPath).catch(() => wtPath));
        const prot = await evaluateWorktreeCleanupProtection(
          project.id,
          resolvedWt,
          (pid, tid) => this.taskStore.show(pid, tid),
          getWorktreeCleanupAssignmentGuardMs(),
          {
            // Reclaim runs before assignment.json is written for this dispatch; leftovers are stale.
            ignoreFreshAssignmentForTaskIds: new Set([taskId]),
            ignoreLiveTaskStatusForTaskIds: new Set([taskId]),
          }
        );
        if (prot.forbid) {
          logWorktreeCleanupBlocked("create_task_worktree_reclaim", {
            projectId: project.id,
            worktreePath: resolvedWt,
            reason: prot.reason ?? "unknown",
            referencingTaskIds: prot.referencingTaskIds,
            cleanupTrigger: "create_task_worktree",
          });
          throw new WorktreeBranchInUseError(
            `Cannot reclaim worktree at ${wtPath}: ${prot.reason ?? "active references"}`,
            branchName,
            wtPath,
            worktreeKey
          );
        }
      }
    } catch (err) {
      if (err instanceof WorktreeBranchInUseError) throw err;
      // ENOENT: path absent — proceed to prepare/remove no-op
    }

    await this.prepareWorktreeForRemoval(worktreeKey);
    await this.removeTaskWorktree(repoPath, worktreeKey);

    // If branch is checked out in a different path (stale/wrong entry), free it
    await this.freeBranchIfUsedElsewhere(repoPath, branchName, wtPath);

    // Create worktree with hooks disabled so post-checkout hooks do not run
    // in the worktree; task store operations only run from the main repo.
    await fs.mkdir(path.dirname(wtPath), { recursive: true });
    // Defensively clear the target path so "fatal: '...' already exists" cannot occur
    // (e.g. leftover dir from crash, or path not fully removed by removeTaskWorktree).
    await this.ensureWorktreePathClear(repoPath, worktreeKey, wtPath);
    const noHooksWorktree = getGitNoHooksPath();
    await this.gitExec(
      repoPath,
      [...gitNoHooksConfigPrefix(noHooksWorktree), "worktree", "add", wtPath, branchName],
      { timeout: 30_000 }
    );

    await validateWorktreeCheckout(repoPath, wtPath);

    await this.symlinkNodeModules(repoPath, wtPath);

    worktreeRegistry.register(worktreeKey, wtPath, branchName);
    worktreeRegistry.transition(worktreeKey, "ready");

    return wtPath;
  }

  /**
   * Ensures the worktree path is absent so `git worktree add` cannot fail with "already exists".
   * Escalates through: git worktree remove → fs.rm → shell rm -rf → rename-aside.
   */
  private async ensureWorktreePathClear(
    repoPath: string,
    worktreeKey: string,
    wtPath: string
  ): Promise<void> {
    const removed = await this.removeWorktreePathWithEscalation(
      repoPath,
      worktreeKey,
      wtPath,
      "Pre-worktree-add cleanup"
    );
    if (removed) return;
    throw new Error(
      `Cannot clear worktree path for ${worktreeKey}: ${wtPath} still exists after all cleanup attempts (git worktree remove, fs.rm, shell rm -rf, and rename all failed)`
    );
  }

  /**
   * Return the worktree path that has the given branch checked out, or null if none.
   */
  private async getWorktreePathForBranch(
    repoPath: string,
    branchName: string
  ): Promise<string | null> {
    const branchRef = `refs/heads/${branchName}`;
    const { stdout } = await this.gitExec(repoPath, ["worktree", "list", "--porcelain"]);
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

  private async isNodeModulesUsable(nodeModulesPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(nodeModulesPath);
      if (!stat.isDirectory()) return false;
      const entries = await fs.readdir(nodeModulesPath, { withFileTypes: true });
      return entries.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Ensure node_modules exists in the main repo. If missing and package.json exists,
   * runs dependency repair commands. Used before symlinking so worktrees have dependencies.
   * @returns true if node_modules exists after this call, false otherwise
   */
  private async ensureNodeModules(repoPath: string): Promise<boolean> {
    const toolchain = await this.resolveToolchainProfileForRepo(repoPath);
    if (!isNodeDependencyStrategy(toolchain.dependencyStrategy)) {
      return true;
    }
    const srcRoot = path.join(repoPath, "node_modules");
    if (await this.isNodeModulesUsable(srcRoot)) {
      return true;
    }

    const pkgPath = path.join(repoPath, "package.json");
    try {
      await fs.access(pkgPath);
    } catch {
      return false;
    }

    const repair = await this.repairDependencies(
      repoPath,
      "missing node_modules",
      toolchain.dependencyInstallCommand
    );
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

  private hasWorkspaceConfig(workspaces: unknown): boolean {
    if (Array.isArray(workspaces)) return workspaces.length > 0;
    if (workspaces && typeof workspaces === "object") {
      const packages = (workspaces as { packages?: unknown }).packages;
      return Array.isArray(packages) && packages.length > 0;
    }
    return false;
  }

  private async resolveDependencyHealthCheckCommand(
    repoPath: string,
    fallbackCommand: string
  ): Promise<string> {
    if (fallbackCommand.trim() !== DEPENDENCY_HEALTH_CHECK_COMMAND) {
      return fallbackCommand;
    }
    const pkgPath = path.join(repoPath, "package.json");
    try {
      const packageJson = JSON.parse(await fs.readFile(pkgPath, "utf-8")) as {
        workspaces?: unknown;
      };
      return this.hasWorkspaceConfig(packageJson.workspaces)
        ? DEPENDENCY_HEALTH_CHECK_WORKSPACES_COMMAND
        : fallbackCommand;
    } catch (err) {
      const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
      if (code !== "ENOENT") {
        log.warn("Failed to inspect package.json for dependency workspace health check", {
          repoPath,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      return fallbackCommand;
    }
  }

  private getFirstNonEmptyLine(text: string): string | null {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length > 0) return trimmed;
    }
    return null;
  }

  async checkDependencyIntegrity(repoPath: string, wtPath?: string): Promise<void> {
    const toolchain = await this.resolveToolchainProfileForRepo(repoPath);
    if (!isNodeDependencyStrategy(toolchain.dependencyStrategy)) {
      return;
    }
    if (!toolchain.dependencyHealthCheckCommand?.trim()) {
      return;
    }
    try {
      await fs.access(path.join(repoPath, "package.json"));
    } catch {
      return;
    }

    const checkCommand = await this.resolveDependencyHealthCheckCommand(
      repoPath,
      toolchain.dependencyHealthCheckCommand
    );
    const initialHealth = await this.runDependencyHealthCheck(repoPath, checkCommand);
    if (initialHealth.healthy) return;

    const repair = await this.repairDependencies(
      repoPath,
      "dependency integrity check failed",
      toolchain.dependencyInstallCommand
    );
    if (repair.success && wtPath && wtPath !== repoPath) {
      await this.symlinkNodeModules(repoPath, wtPath);
    }

    const postRepairHealth = await this.runDependencyHealthCheck(repoPath, checkCommand);
    if (postRepairHealth.healthy) return;

    const firstError =
      this.getFirstNonEmptyLine(postRepairHealth.output) ??
      this.getFirstNonEmptyLine(repair.output) ??
      this.getFirstNonEmptyLine(initialHealth.output) ??
      "Dependency health check reported invalid or missing dependencies.";
    const installCommand = toolchain.dependencyInstallCommand ?? "dependency install";

    throw new RepoPreflightError(
      `Dependency integrity check failed after one automatic repair attempt. ${firstError} Run \`${installCommand}\` in the repo root and fix dependency manifest issues.`,
      ErrorCodes.REPO_DEPENDENCIES_INVALID,
      [installCommand, checkCommand]
    );
  }

  async ensureDependenciesHealthy(
    repoPath: string,
    wtPath?: string
  ): Promise<DependencyHealthResult> {
    const toolchain = await this.resolveToolchainProfileForRepo(repoPath);
    if (
      !isNodeDependencyStrategy(toolchain.dependencyStrategy) ||
      !toolchain.dependencyHealthCheckCommand?.trim()
    ) {
      return {
        healthy: true,
        checkOutput: "",
        repairAttempted: false,
        repairSucceeded: false,
        repairCommands: [],
        repairOutput: "",
      };
    }
    try {
      await fs.access(path.join(repoPath, "package.json"));
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

    const checkCommand = await this.resolveDependencyHealthCheckCommand(
      repoPath,
      toolchain.dependencyHealthCheckCommand
    );
    const initialHealth = await this.runDependencyHealthCheck(repoPath, checkCommand);
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

    const repair = await this.repairDependencies(
      repoPath,
      "dependency health check failed",
      toolchain.dependencyInstallCommand
    );
    if (repair.success && wtPath && wtPath !== repoPath) {
      await this.symlinkNodeModules(repoPath, wtPath);
    }
    const postRepairHealth = await this.runDependencyHealthCheck(repoPath, checkCommand);
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
    repoPath: string,
    command: string
  ): Promise<{ healthy: boolean; output: string }> {
    try {
      const spec = shellCommandToSpec(command);
      const result = await runCommand(
        { command: spec.command, args: spec.args },
        {
          cwd: repoPath,
          timeout: NPM_HEALTH_CHECK_TIMEOUT_MS,
          ...(spec.command === "npm" ? { env: { ...process.env, ...NPM_INCLUDE_DEV_ENV } } : {}),
        }
      );
      const output = [result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n")
        .trim()
        .slice(0, 4000);
      return { healthy: true, output };
    } catch (err) {
      const output = getErrorText(err).trim().slice(0, 4000);
      return { healthy: false, output };
    }
  }

  private async repairDependencies(
    repoPath: string,
    context: string,
    installCommand?: string | null
  ): Promise<{ success: boolean; commands: string[]; output: string }> {
    const commandToRun = installCommand?.trim() || DEPENDENCY_REPAIR_COMMAND;
    const parsedSpec = shellCommandToSpec(commandToRun);
    const attempts: string[] = [];
    const outputs: string[] = [];
    for (const command of [commandToRun]) {
      attempts.push(command);
      try {
        const env =
          parsedSpec.command === "npm" ? { ...process.env, ...NPM_INCLUDE_DEV_ENV } : undefined;
        const result = await runCommand(
          { command: parsedSpec.command, args: parsedSpec.args },
          { cwd: repoPath, timeout: NPM_REPAIR_TIMEOUT_MS, ...(env ? { env } : {}) }
        );
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
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
   * After merging a task branch to main, check whether dependency manifests
   * (package.json / package-lock.json) changed and run `npm ci` if so.
   * Uses ORIG_HEAD (set by git merge) to detect changes; falls back to
   * running npm ci unconditionally if the ref is unavailable.
   *
   * Pathspecs use git glob pathspecs so nested workspace manifests under
   * packages/ and apps/ are detected, not only a single directory segment
   * under packages/.
   */
  async reconcileDependenciesAfterMerge(repoPath: string): Promise<void> {
    const toolchain = await this.resolveToolchainProfileForRepo(repoPath);
    if (
      !isNodeDependencyStrategy(toolchain.dependencyStrategy) ||
      !toolchain.dependencyInstallCommand?.trim()
    ) {
      return;
    }
    let needsReconcile = true;
    try {
      const { stdout } = await this.gitExec(
        repoPath,
        ["diff", "--name-only", "ORIG_HEAD..HEAD", "--", ...toolchain.dependencyChangePathspecs],
        { timeout: 10_000 }
      );
      const changed = stdout.trim().split("\n").filter(Boolean);
      if (changed.length === 0) {
        needsReconcile = false;
        log.info("No dependency files changed in merge, skipping dependency reconcile", {
          repoPath,
        });
      } else {
        log.info("Dependency files changed in merge, running dependency reconcile", {
          repoPath,
          changed,
          command: toolchain.dependencyInstallCommand,
        });
      }
    } catch {
      log.info("Could not determine changed files after merge, running dependency reconcile", {
        repoPath,
      });
    }

    if (!needsReconcile) return;

    const repair = await this.repairDependencies(
      repoPath,
      "post-merge dependency reconciliation",
      toolchain.dependencyInstallCommand
    );
    if (!repair.success) {
      log.warn("Post-merge dependency reconcile failed — subsequent baseline checks may fail", {
        repoPath,
        output: repair.output,
      });
    }
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
    const toolchain = await this.resolveToolchainProfileForRepo(repoPath);
    if (!isNodeDependencyStrategy(toolchain.dependencyStrategy)) {
      return;
    }

    // Symlink root node_modules (ensure it exists and is non-empty first)
    const srcRoot = path.join(repoPath, "node_modules");
    const destRoot = path.join(wtPath, "node_modules");
    if (!(await this.isNodeModulesUsable(srcRoot))) {
      const ensured = await this.ensureNodeModules(repoPath);
      if (!ensured) {
        log.warn("Skipping root node_modules symlink: not usable after repair attempt", {
          srcRoot,
          reason: "no package.json or npm ci failed",
        });
        return;
      }
    }

    try {
      await this.forceSymlink(srcRoot, destRoot, { allowReplaceRealDirectory: true });
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
          await this.forceSymlink(srcPkg, destPkg, { allowReplaceRealDirectory: true });
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
  private async forceSymlink(
    target: string,
    linkPath: string,
    opts?: { allowReplaceRealDirectory?: boolean }
  ): Promise<void> {
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
        // By default, do not delete a real directory that isn't a symlink.
        // Worktree cleanup can opt into replacing these directories.
        const stat = await fs.lstat(linkPath);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          if (!opts?.allowReplaceRealDirectory) {
            log.warn("forceSymlink: path is a real directory, refusing to replace", {
              linkPath,
            });
            return;
          }
        }
        await fs.rm(linkPath, { recursive: true, force: true });
        await fs.symlink(target, linkPath, "junction");
      } else {
        throw err;
      }
    }
  }

  /**
   * Clears in-memory registry state and releases the DB worktree lease so {@link removeTaskWorktree}
   * can run. Call when intentionally destroying a worktree (slot finalization, admin cleanup,
   * reclaiming a path before recreate). Do not call on recovery paths that rely on the lease to
   * block removal while another process may still hold the worktree.
   */
  async prepareWorktreeForRemoval(worktreeKey: string): Promise<void> {
    worktreeRegistry.retire(worktreeKey);
    await Promise.resolve(worktreeLeaseService.forceRelease(worktreeKey)).catch((err: unknown) => {
      log.warn("worktree lease force-release failed", { err: err instanceof Error ? err.message : String(err) });
    });
  }

  /**
   * Remove a task or epic worktree. Safe to call even if the worktree doesn't exist.
   * Logs errors so stale worktrees can be diagnosed; always attempts cleanup.
   * @param worktreeKey - Task ID (per-task) or worktree key (e.g. epic_<epicId>) for epic worktree.
   * @param actualPath - When provided (e.g. from assignment or git worktree list), use this path
   *   instead of getWorktreePath(worktreeKey). Critical when os.tmpdir() changes between process runs,
   *   which would otherwise leave orphaned worktrees.
   * @param opts - When bypassReferenceProtection is true, skips assignment/active-task guard (internal
   *   callers that already deleted assignments or mirrored RecoveryService protection).
   * @returns false when removal was skipped (protection, lease, or unsafe target); true when cleanup ran.
   */
  async removeTaskWorktree(
    repoPath: string,
    worktreeKey: string,
    actualPath?: string,
    opts?: {
      bypassReferenceProtection?: boolean;
      ignoreLiveTaskStatusForTaskIds?: Set<string>;
    }
  ): Promise<boolean> {
    const wtPath = actualPath ?? this.getWorktreePath(worktreeKey, repoPath);

    let pathExists = false;
    try {
      await fs.access(wtPath);
      pathExists = true;
    } catch {
      pathExists = false;
    }

    if (!opts?.bypassReferenceProtection && pathExists) {
      const resolvedRepoRoot = await fs.realpath(repoPath).catch(() => path.resolve(repoPath));
      const resolvedWt = path.resolve(await fs.realpath(wtPath).catch(() => wtPath));
      const normRepo = await fs.realpath(resolvedRepoRoot).catch(() => resolvedRepoRoot);
      const normWt = await fs.realpath(resolvedWt).catch(() => resolvedWt);
      if (normRepo !== normWt) {
        const project = await this.projectService.getProjectByRepoPath(repoPath).catch(() => null);
        if (project) {
          const protection = await evaluateWorktreeCleanupProtection(
            project.id,
            resolvedWt,
            (pid, tid) => this.taskStore.show(pid, tid),
            getWorktreeCleanupAssignmentGuardMs(),
            opts?.ignoreLiveTaskStatusForTaskIds
              ? { ignoreLiveTaskStatusForTaskIds: opts.ignoreLiveTaskStatusForTaskIds }
              : undefined
          );
          if (protection.forbid) {
            logWorktreeCleanupBlocked("remove_task_worktree", {
              projectId: project.id,
              worktreePath: resolvedWt,
              reason: protection.reason ?? "unknown",
              referencingTaskIds: protection.referencingTaskIds,
              cleanupTrigger: "remove_task_worktree",
            });
            return false;
          }
        }
      }
    }

    const dbCanCleanup = await worktreeLeaseService.canCleanup(worktreeKey).catch(() => true);
    if (!dbCanCleanup) {
      log.warn("Skipping worktree removal: active DB lease prevents cleanup", {
        worktreeKey,
        worktreePath: wtPath,
      });
      return false;
    }

    const registryEntry = worktreeRegistry.get(worktreeKey);
    if (registryEntry?.state === "in_use") {
      // Durable DB lease is authoritative across processes; in-memory `in_use` can be stale
      // if the owner exited without retiring the registry.
      log.info("Retiring stale in_use registry entry; DB lease allows cleanup", {
        worktreeKey,
        worktreePath: wtPath,
        entry: registryEntry,
      });
      worktreeRegistry.retire(worktreeKey);
    }
    if (!worktreeRegistry.canCleanup(worktreeKey)) {
      log.info("Retiring registry entry before worktree removal", {
        worktreeKey,
        entry: registryEntry,
      });
      worktreeRegistry.retire(worktreeKey);
    }

    const leaseAllowsCleanup = await worktreeLeaseService.canCleanup(worktreeKey).catch((err) => {
      log.warn("Worktree lease cleanup check failed; allowing removal (degraded)", {
        worktreeKey,
        err: err instanceof Error ? err.message : String(err),
      });
      return true;
    });
    if (!leaseAllowsCleanup) {
      log.warn(
        "Skipping worktree removal: durable lease still active (execute/merge trust boundary)",
        {
          worktreeKey,
          wtPath,
        }
      );
      return false;
    }

    if (!(await this.removalTargetMatchesDurableLeasePath(worktreeKey, wtPath))) {
      return false;
    }

    const registeredPath = await this.resolveRegisteredWorktreePath(repoPath, worktreeKey, wtPath);
    if (!registeredPath) {
      // Drop stale git metadata entries that can survive abrupt process exits.
      await this.gitExec(repoPath, ["worktree", "prune"]).catch((err: unknown) => { log.warn("git worktree prune failed", { err: err instanceof Error ? err.message : String(err) }); });
      // Use same resolution as validateDisposableWorktreePath (realpath) so we
      // consistently detect repo root and return early on all platforms (e.g. macOS
      // /var vs /private/var); avoid calling removeWorktreeDirectorySafely which
      // would log.error when path-safety rejects the same path.
      const resolvedRepo = await fs.realpath(repoPath).catch(() => path.resolve(repoPath));
      const resolvedCandidate = await fs.realpath(wtPath).catch(() => path.resolve(wtPath));
      // Normalize both to canonical form so we detect repo root when one path came from
      // path.resolve fallback (e.g. /var/...) and the other from realpath (/private/var/...).
      const normRepo = await fs.realpath(resolvedRepo).catch(() => resolvedRepo);
      const normCandidate = await fs.realpath(resolvedCandidate).catch(() => resolvedCandidate);
      if (normRepo === normCandidate) {
        log.warn("Refusing unsafe worktree cleanup target (repo root)", {
          taskId: worktreeKey,
          candidatePath: wtPath,
          err: "Refusing to treat the repository root as a disposable worktree",
        });
        return false;
      }
      const projUnreg = await this.projectService.getProjectByRepoPath(repoPath).catch(() => null);
      if (projUnreg) {
        const resolvedUnreg = path.resolve(await fs.realpath(wtPath).catch(() => wtPath));
        const summariesUnreg = await listAssignmentSummariesInWorktree(resolvedUnreg).catch(() => []);
        logWorktreeDeletionImminent("remove_task_worktree", {
          projectId: projUnreg.id,
          worktreePath: resolvedUnreg,
          worktreeKey,
          assignmentSlotCount: summariesUnreg.length,
          assignmentTaskIds: summariesUnreg.map((s) => s.taskId),
          cleanupTrigger: "remove_unregistered_worktree_dir",
        });
      }
      await this.removeWorktreeDirectorySafely(
        repoPath,
        worktreeKey,
        wtPath,
        "Refusing to remove unregistered worktree path"
      );
      return true;
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
      return false;
    }

    const projectForLog = await this.projectService.getProjectByRepoPath(repoPath).catch(() => null);
    if (projectForLog) {
      const summaries = await listAssignmentSummariesInWorktree(safeRegisteredPath).catch(() => []);
      logWorktreeDeletionImminent("remove_task_worktree", {
        projectId: projectForLog.id,
        worktreePath: path.resolve(safeRegisteredPath),
        worktreeKey,
        assignmentSlotCount: summaries.length,
        assignmentTaskIds: summaries.map((s) => s.taskId),
        cleanupTrigger: "remove_registered_worktree",
      });
    }

    await unlinkWorktreeLinks(safeRegisteredPath);
    try {
      log.info("worktree.removal_after_lease_gate", {
        worktreeKey,
        path: safeRegisteredPath,
      });
      await this.gitExec(repoPath, ["worktree", "remove", safeRegisteredPath, "--force"]);
      await this.gitExec(repoPath, ["worktree", "prune"]).catch((err: unknown) => { log.warn("git worktree prune failed", { err: err instanceof Error ? err.message : String(err) }); });
    } catch (err) {
      log.warn("worktree remove failed, attempting manual cleanup", {
        worktreeKey,
        wtPath: safeRegisteredPath,
        err: err instanceof Error ? err.message : String(err),
      });
      await this.gitExec(repoPath, ["worktree", "prune"]).catch((err2: unknown) => { log.warn("git worktree prune failed", { err: err2 instanceof Error ? err2.message : String(err2) }); });
      const removed = await this.removeWorktreePathWithEscalation(
        repoPath,
        worktreeKey,
        safeRegisteredPath,
        "Manual worktree cleanup",
        { skipGitWorktreeRemove: true }
      );
      if (!removed) {
        log.warn("Manual worktree cleanup failed", {
          worktreeKey,
          wtPath: safeRegisteredPath,
        });
      }
      await this.gitExec(repoPath, ["worktree", "prune"]).catch((err: unknown) => { log.warn("git worktree prune failed", { err: err instanceof Error ? err.message : String(err) }); });
    }

    worktreeRegistry.retire(worktreeKey);
    worktreeRegistry.remove(worktreeKey);
    return true;
  }

  private async removeWorktreePathWithEscalation(
    repoPath: string,
    worktreeKey: string,
    candidatePath: string,
    reason: string,
    opts?: { skipGitWorktreeRemove?: boolean }
  ): Promise<boolean> {
    let safePath: string;
    try {
      safePath = await this.validateDisposableWorktreePath(
        repoPath,
        worktreeKey,
        candidatePath,
        reason
      );
    } catch (err) {
      log.error("Refusing unsafe worktree cleanup target", {
        taskId: worktreeKey,
        candidatePath,
        err: err instanceof Error ? err.message : String(err),
      });
      return false;
    }

    const pathGone = async () => {
      try {
        await fs.access(safePath);
        return false;
      } catch {
        return true;
      }
    };
    if (await pathGone()) return true;

    if (!opts?.skipGitWorktreeRemove) {
      await unlinkWorktreeLinks(safePath);
      try {
        await this.gitExec(repoPath, ["worktree", "remove", safePath, "--force"]);
      } catch {
        // Path may not be a registered worktree.
      }
      if (await pathGone()) return true;
    }

    await this.removeWorktreeDirectorySafely(repoPath, worktreeKey, safePath, reason);
    if (await pathGone()) return true;

    log.warn("Worktree path survived fs.rm, escalating to shell rm -rf", {
      worktreeKey,
      wtPath: safePath,
    });
    try {
      if (process.platform !== "win32") {
        await runCommand(
          { command: "rm", args: ["-rf", safePath] },
          { cwd: repoPath, timeout: 15_000 }
        );
      }
    } catch (rmErr) {
      log.warn("Shell rm -rf failed", {
        worktreeKey,
        wtPath: safePath,
        err: rmErr instanceof Error ? rmErr.message : String(rmErr),
      });
    }
    await this.gitExec(repoPath, ["worktree", "prune"]).catch((err: unknown) => { log.warn("git worktree prune failed", { err: err instanceof Error ? err.message : String(err) }); });
    if (await pathGone()) return true;

    const stalePath = `${safePath}-stale-${Date.now()}`;
    log.warn("Worktree path cannot be deleted, renaming aside", {
      worktreeKey,
      wtPath: safePath,
      stalePath,
    });
    try {
      await fs.rename(safePath, stalePath);
      await this.gitExec(repoPath, ["worktree", "prune"]).catch((err: unknown) => { log.warn("git worktree prune failed", { err: err instanceof Error ? err.message : String(err) }); });
      (process.platform !== "win32"
        ? runCommand(
            { command: "rm", args: ["-rf", stalePath] },
            { cwd: repoPath, timeout: 30_000 }
          )
        : Promise.resolve()
      ).catch(() => fs.rm(stalePath, { recursive: true, force: true }).catch((err: unknown) => { log.warn("stale worktree rm failed", { stalePath, err: err instanceof Error ? err.message : String(err) }); }));
    } catch (renameErr) {
      log.error("Failed to rename stale worktree path aside", {
        worktreeKey,
        wtPath: safePath,
        stalePath,
        err: renameErr instanceof Error ? renameErr.message : String(renameErr),
      });
    }
    return pathGone();
  }

  /**
   * If a durable lease row records a worktree path, require the removal target to match it.
   * Prevents half-deleted or re-keyed paths from being torn down under the wrong key.
   *
   * When {@link worktreeLeaseService.canCleanup} is true, the lease is released or expired; the
   * row may still carry a historic `worktree_path` (e.g. after {@link prepareWorktreeForRemoval}).
   * Path enforcement applies only while an active lease still logically holds the tree.
   */
  private async removalTargetMatchesDurableLeasePath(
    worktreeKey: string,
    candidatePath: string
  ): Promise<boolean> {
    const lease = await worktreeLeaseService.get(worktreeKey).catch(() => null);
    if (!lease?.worktreePath?.trim()) return true;
    if (lease.releasedAt) return true;
    const expiresMs = Date.parse(lease.expiresAt);
    if (Number.isFinite(expiresMs) && expiresMs <= Date.now()) return true;
    const same = await worktreePathsResolveEqually(lease.worktreePath, candidatePath);
    if (!same) {
      log.warn("Skipping worktree removal: path does not match durable lease record", {
        worktreeKey,
        candidatePath,
        leasedPath: lease.worktreePath,
      });
    }
    return same;
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

    // Only return a path when it matches candidatePath. Do not return another worktree path
    // for the same taskId (e.g. from a different tmpdir), or we would remove the wrong path
    // and leave a directory at candidatePath, causing "fatal: '...' already exists" on worktree add.
    return null;
  }

  /**
   * List all task worktrees for this repo.
   * Parses `git worktree list --porcelain` and returns { taskId, worktreePath } for each worktree
   * under any opensprint-worktrees directory (legacy temp) or the durable worktree root
   * (.opensprint/runtime/worktrees). This ensures we find worktrees from both layouts.
   */
  async listTaskWorktrees(
    repoPath: string
  ): Promise<Array<{ taskId: string; worktreePath: string }>> {
    const result: Array<{ taskId: string; worktreePath: string }> = [];
    const durableBaseRaw = path.resolve(this.getWorktreeBasePath(repoPath));
    const durableBase = await fs.realpath(durableBaseRaw).catch(() => durableBaseRaw);
    try {
      const { stdout } = await this.gitExec(repoPath, ["worktree", "list", "--porcelain"]);
      for (const line of stdout.split("\n")) {
        if (!line.startsWith("worktree ")) continue;
        const worktreePath = line.slice(9).trim();
        const rawResolved = path.resolve(worktreePath);
        const resolved = await fs.realpath(rawResolved).catch(() => rawResolved);
        const parentDir = path.basename(path.dirname(resolved));
        const isLegacyWorktree = parentDir === "opensprint-worktrees";
        const isDurableWorktree =
          resolved.startsWith(durableBase + path.sep) || resolved === durableBase;
        if (isLegacyWorktree || isDurableWorktree) {
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
   * @param excludeTaskIds - Task IDs to never remove (legacy compatibility)
   * @param excludeWorktreeKeys - Worktree keys to never remove (taskId or epic_<epicId>)
   * @param excludeWorktreePaths - Worktree paths to never remove
   */
  async pruneOrphanWorktrees(
    repoPath: string,
    projectId: string,
    excludeTaskIds: Set<string>,
    excludeWorktreeKeys: Set<string>,
    excludeWorktreePaths: Set<string>,
    taskStore: { listAll: (projectId: string) => Promise<Array<{ id: string; status?: string }>> }
  ): Promise<string[]> {
    const worktrees = await this.listTaskWorktrees(repoPath);
    const allIssues = await taskStore.listAll(projectId);
    const idToStatus = new Map(allIssues.map((i) => [i.id, (i.status as string) ?? ""]));
    const pruned: string[] = [];

    const assignmentGuardMs = getWorktreeCleanupAssignmentGuardMs();

    for (const { taskId, worktreePath } of worktrees) {
      const resolvedPath = path.resolve(worktreePath);
      if (excludeTaskIds.has(taskId)) continue;
      if (excludeWorktreeKeys.has(taskId)) continue;
      if (excludeWorktreePaths.has(resolvedPath)) continue;
      const status = idToStatus.get(taskId);
      // Remove if task doesn't exist or is closed
      if (status === undefined || status === "closed") {
        const protection = await evaluateWorktreeCleanupProtection(
          projectId,
          resolvedPath,
          (pid, tid) => this.taskStore.show(pid, tid),
          assignmentGuardMs
        );
        if (protection.forbid) {
          logWorktreeCleanupBlocked("prune_orphan_worktrees", {
            projectId,
            worktreePath: resolvedPath,
            reason: protection.reason ?? "unknown",
            referencingTaskIds: protection.referencingTaskIds,
            cleanupTrigger: "prune_orphan",
          });
          continue;
        }
        log.info("Pruning orphan worktree", { taskId, worktreePath, status: status ?? "no-task" });
        try {
          await worktreeLeaseService.forceRelease(taskId).catch(() => {});
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
      const { stdout } = await this.gitExec(repoPath, [
        "rev-list",
        "--count",
        `${baseBranch}..${branchName}`,
      ]);
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
    await this.withRepoRootAutoStash(
      repoPath,
      `merge ${branchName} into ${baseBranch}`,
      async () => {
        await this.ensureOnMainInternal(repoPath, baseBranch);
        if (message) {
          await this.gitExec(repoPath, ["merge", "-m", message, branchName]);
        } else {
          await this.gitExec(repoPath, ["merge", branchName]);
        }
      }
    );
  }

  private async mergeBranchNoCommitInternal(
    repoPath: string,
    branchName: string
  ): Promise<MergeToMainResult> {
    let autoResolvedFiles: string[] = [];
    try {
      await this.gitExec(repoPath, ["merge", "--no-commit", "--no-ff", branchName]);
    } catch (mergeErr) {
      const { stdout } = await this.gitExec(repoPath, ["diff", "--name-only", "--diff-filter=U"], {
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
          await this.gitExec(repoPath, ["rm", "-f", file], { timeout: 5000 });
        } catch {
          await this.gitExec(repoPath, ["add", file], { timeout: 5000 }).catch((err: unknown) => { log.warn("git add fallback failed", { err: err instanceof Error ? err.message : String(err) }); });
        }
      }
      autoResolvedFiles = infraFiles;

      if (codeConflicts.length > 0) {
        log.warn("Code conflicts remain after infra auto-resolve", { branchName, codeConflicts });
        throw new MergeConflictError(codeConflicts);
      }
      log.info("All conflicts auto-resolved", { branchName, resolvedCount: infraFiles.length });
    }
    return { autoResolvedFiles };
  }

  /**
   * Merge a branch into the current checked-out branch without committing.
   * Leaves the merge result staged in the current checkout.
   */
  async mergeBranchNoCommit(repoPath: string, branchName: string): Promise<MergeToMainResult> {
    return this.mergeBranchNoCommitInternal(repoPath, branchName);
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
    return this.withRepoRootAutoStash(
      repoPath,
      `prepare merge candidate ${branchName} into ${baseBranch}`,
      async () => {
        await this.ensureOnMainInternal(repoPath, baseBranch);
        return this.mergeBranchNoCommitInternal(repoPath, branchName);
      }
    );
  }

  /**
   * Remove runtime-only .opensprint paths from a staged merge result before the merge commit is created.
   */
  async stripRuntimePathsFromMergeResult(repoPath: string): Promise<void> {
    await this.gitExec(
      repoPath,
      [
        "rm",
        "-r",
        "--cached",
        "--ignore-unmatch",
        ".opensprint/pending-commits.json",
        ".opensprint/sessions",
        ".opensprint/active",
        ".opensprint/runtime",
      ],
      { timeout: 10_000 }
    ).catch((err: unknown) => { log.warn("git rm cached runtime paths failed", { err: err instanceof Error ? err.message : String(err) }); });
    const runtimePaths = [
      path.join(repoPath, ".opensprint", "pending-commits.json"),
      path.join(repoPath, ".opensprint", "sessions"),
      path.join(repoPath, ".opensprint", "active"),
      path.join(repoPath, ".opensprint", "runtime"),
    ];
    for (const runtimePath of runtimePaths) {
      try {
        const stat = await fs.stat(runtimePath);
        if (stat.isFile()) await fs.unlink(runtimePath);
        else if (stat.isDirectory()) await fs.rm(runtimePath, { recursive: true, force: true });
      } catch {
        // Path may not exist
      }
    }
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
      await this.gitExec(
        wtPath,
        [...gitNoHooksConfigPrefix(noHooks), "rebase", "--empty=drop", baseBranch],
        { timeout: 120_000 }
      );
    } catch (err) {
      const rebaseActive = await this.isRebaseInProgress(wtPath);
      const conflicted = await this.getConflictedFiles(wtPath);
      if (rebaseActive || conflicted.length > 0) {
        throw new RebaseConflictError(conflicted);
      }
      throw err;
    }
  }
}
