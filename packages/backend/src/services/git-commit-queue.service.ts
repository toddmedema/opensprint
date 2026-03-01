/**
 * Serialized git commit queue (Refinery-like, PRD §5.9).
 * Async FIFO queue with single worker for all main-branch git operations.
 * Prevents .git/index.lock contention when multiple agents/processes trigger
 * commits (PRD update, worktree merge). Task state lives on the central server only.
 */

import { resolveTestCommand, type AgentConfig } from "@opensprint/shared";
import { taskStore as taskStoreSingleton } from "./task-store.service.js";
import { BranchManager, MergeConflictError, RebaseConflictError } from "./branch-manager.js";
import { ProjectService } from "./project.service.js";
import { agentService } from "./agent.service.js";
import { eventLogService } from "./event-log.service.js";
import { createLogger } from "../utils/logger.js";
import { waitForGitReady } from "../utils/git-lock.js";
import { shellExec } from "../utils/shell-exec.js";
const log = createLogger("git-commit-queue");

/** Thrown when a job cannot proceed due to existing unmerged files. */
export class RepoConflictError extends Error {
  constructor(public readonly unmergedFiles: string[]) {
    super(
      `Cannot proceed: repo has ${unmergedFiles.length} unmerged file(s): ${unmergedFiles.join(", ")}`
    );
    this.name = "RepoConflictError";
  }
}

export class MergeJobError extends Error {
  constructor(
    message: string,
    public readonly stage: "rebase_before_merge" | "merge_to_main",
    public readonly conflictedFiles: string[],
    public readonly resolvedBy: "requeued" | "blocked" = "requeued"
  ) {
    super(message);
    this.name = "MergeJobError";
  }
}

/** Job types for main-branch git operations.
 * Commit message patterns per PRD §5.9:
 * - prd: updated after Plan <plan-id> built | prd: Sketch session update
 * - Closed <task-id>: <task title truncated to ~30 chars>
 */
export type GitCommitJobType = "prd_update" | "worktree_merge";

export interface PrdUpdateJob {
  type: "prd_update";
  repoPath: string;
  /** "plan" | "sketch" | "eval" | "execute" | "deliver" — for commit message */
  source: "plan" | "sketch" | "eval" | "execute" | "deliver";
  planId?: string;
}

export interface WorktreeMergeJob {
  type: "worktree_merge";
  repoPath: string;
  worktreePath: string;
  branchName: string;
  taskId: string;
  /** Fallback when task store show fails; queue fetches title via taskStore.show(taskId) */
  taskTitle?: string;
}

import { formatClosedCommitMessage as formatClosedCommitMessageUtil } from "../utils/commit-message.js";

/**
 * Build PRD update commit message based on source phase.
 * Exported for unit tests.
 */
export function formatPrdCommitMessage(source: PrdUpdateJob["source"], planId?: string): string {
  switch (source) {
    case "sketch":
      return "prd: Sketch session update";
    case "eval":
      return "prd: Evaluate feedback";
    default:
      return planId ? `prd: updated after Plan ${planId} built` : "prd: updated";
  }
}

/**
 * Build worktree merge commit message: "Closed <taskId>: <truncated title>".
 * Exported for unit tests.
 */
export function formatMergeCommitMessage(taskId: string, taskTitle: string): string {
  return formatClosedCommitMessageUtil(taskId, taskTitle);
}

export type GitCommitJob = PrdUpdateJob | WorktreeMergeJob;

export interface GitCommitQueueService {
  enqueue(job: GitCommitJob): Promise<void>;
  /** Enqueue and wait for this job to complete. Use when caller must wait (e.g. before cleanup). */
  enqueueAndWait(job: GitCommitJob): Promise<void>;
  /** Wait for all queued jobs to complete (for tests). */
  drain(): Promise<void>;
}

interface QueuedItem {
  job: GitCommitJob;
  resolve?: () => void;
  reject?: (err: Error) => void;
}

class GitCommitQueueImpl implements GitCommitQueueService {
  private queue: QueuedItem[] = [];
  private processing = false;
  private taskStore = taskStoreSingleton;
  private branchManager = new BranchManager();
  private projectService = new ProjectService();
  private drainResolvers: Array<() => void> = [];

  // ─── Pre-flight checks ───

  private async hasUnmergedFiles(repoPath: string): Promise<string[]> {
    try {
      const { stdout } = await shellExec("git diff --name-only --diff-filter=U", {
        cwd: repoPath,
        timeout: 10_000,
      });
      return stdout.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Stage files and commit. Returns true if a commit was created, false if
   * there was nothing to commit (file unchanged since last commit).
   * Throws on real git errors.
   * Calls waitForGitReady immediately before git so we clear any .git/index.lock
   * that appeared during the job (e.g. from another process).
   */
  private async addAndCommit(repoPath: string, files: string[], message: string): Promise<boolean> {
    await waitForGitReady(repoPath);
    const addCmd = files.map((f) => `git add ${f}`).join(" && ");
    const escaped = message.replace(/"/g, '\\"');
    try {
      await shellExec(`${addCmd} && git commit -m "${escaped}"`, {
        cwd: repoPath,
        timeout: 30_000,
      });
      return true;
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string };
      const output = (e.stdout || "") + (e.stderr || "");
      if (
        output.includes("nothing to commit") ||
        output.includes("nothing added to commit") ||
        output.includes("no changes added to commit")
      ) {
        return false;
      }
      throw err;
    }
  }

  private async getMergeAgentConfig(repoPath: string, _taskId: string): Promise<{
    projectId: string;
    config: AgentConfig;
    testCommand?: string;
  }> {
    const project = await this.projectService.getProjectByRepoPath(repoPath);
    if (!project) {
      throw new Error(`Cannot resolve project for repo path: ${repoPath}`);
    }
    const settings = await this.projectService.getSettings(project.id);
    return {
      projectId: project.id,
      config: settings.simpleComplexityAgent as AgentConfig,
      testCommand: resolveTestCommand(settings),
    };
  }

  // ─── Job execution ───

  private async processNext(): Promise<void> {
    if (this.queue.length === 0) {
      this.processing = false;
      for (const resolve of this.drainResolvers) resolve();
      this.drainResolvers = [];
      return;
    }

    const item = this.queue.shift()!;
    const job = item.job;
    const maxRetries = 2;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const unmerged = await this.hasUnmergedFiles(job.repoPath);
        if (unmerged.length > 0) {
          throw new RepoConflictError(unmerged);
        }

        await this.executeJob(job);
        item.resolve?.();
        break;
      } catch (err) {
        log.warn("Job failed", { jobType: job.type, attempt: attempt + 1, maxRetries, err });
        if (
          err instanceof MergeConflictError ||
          err instanceof RepoConflictError ||
          err instanceof RebaseConflictError ||
          err instanceof MergeJobError
        ) {
          item.reject?.(err);
          break;
        }
        if (job.type === "worktree_merge") {
          try {
            await this.branchManager.mergeAbort(job.repoPath);
          } catch {
            /* no merge in progress — fine */
          }
          try {
            await this.branchManager.rebaseAbort(job.worktreePath);
          } catch {
            /* no rebase in progress — fine */
          }
        }
        if (attempt === maxRetries - 1) {
          item.reject?.(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }

    setImmediate(() => this.processNext());
  }

  private async executeJob(job: GitCommitJob): Promise<void> {
    const { repoPath } = job;
    await waitForGitReady(repoPath);

    switch (job.type) {
      case "prd_update": {
        const msg = formatPrdCommitMessage(job.source, job.planId);
        await this.addAndCommit(repoPath, ["SPEC.md", ".opensprint/spec-metadata.json"], msg);
        break;
      }
      case "worktree_merge": {
        let taskTitle = job.taskTitle ?? job.taskId;
        try {
          await this.taskStore.init();
          const project = await this.projectService.getProjectByRepoPath(repoPath);
          if (project) {
            const issue = await this.taskStore.show(project.id, job.taskId);
            taskTitle = (issue.title as string) || job.taskId;
          }
        } catch {
          log.warn("Could not fetch task title via task store, using fallback", {
            taskId: job.taskId,
            fallback: job.taskTitle ?? job.taskId,
          });
        }
        log.info("Executing worktree_merge", {
          branchName: job.branchName,
          taskTitle,
        });
        await this.branchManager.syncMainWithOrigin(repoPath);
        await this.branchManager.ensureOnMain(repoPath);

        // Skip merge when branch is already merged (e.g. previous run or manual merge).
        if (await this.branchManager.verifyMerge(repoPath, job.branchName)) {
          log.info("Branch already merged, skipping merge and commit", {
            branchName: job.branchName,
          });
          break;
        }

        const sharedRepoPath = job.worktreePath === repoPath;
        if (sharedRepoPath) {
          await this.branchManager.checkout(repoPath, job.branchName);
        }
        try {
          await this.branchManager.rebaseOntoMain(job.worktreePath);
        } catch (rebaseErr) {
          if (rebaseErr instanceof RebaseConflictError) {
            const { projectId, config, testCommand } = await this.getMergeAgentConfig(
              repoPath,
              job.taskId
            );
            log.info("Rebase conflict detected, invoking merger agent", {
              branchName: job.branchName,
              conflictedFiles: rebaseErr.conflictedFiles,
            });
            const resolved = await agentService.runMergerAgentAndWait({
              projectId,
              cwd: job.worktreePath,
              config,
              phase: "rebase_before_merge",
              taskId: job.taskId,
              branchName: job.branchName,
              conflictedFiles: rebaseErr.conflictedFiles,
              testCommand,
            });
            if (!resolved) {
              await this.branchManager.rebaseAbort(job.worktreePath);
              throw new MergeJobError(
                `Rebase conflict in ${rebaseErr.conflictedFiles.length} file(s): ${rebaseErr.conflictedFiles.join(", ")}`,
                "rebase_before_merge",
                rebaseErr.conflictedFiles
              );
            }
            await this.branchManager.rebaseContinue(job.worktreePath);
            eventLogService
              .append(repoPath, {
                timestamp: new Date().toISOString(),
                projectId,
                taskId: job.taskId,
                event: "merge.resolved",
                data: {
                  stage: "rebase_before_merge",
                  branchName: job.branchName,
                  conflictedFiles: rebaseErr.conflictedFiles,
                  resolvedBy: "merger",
                },
              })
              .catch(() => {});
          } else {
            throw rebaseErr;
          }
        }
        if (sharedRepoPath) {
          await this.branchManager.ensureOnMain(repoPath);
        }

        try {
          const mergeResult = await this.branchManager.mergeToMainNoCommit(repoPath, job.branchName);
          if (mergeResult.autoResolvedFiles.length > 0) {
            const project = await this.projectService.getProjectByRepoPath(repoPath);
            if (project) {
              eventLogService
                .append(repoPath, {
                  timestamp: new Date().toISOString(),
                  projectId: project.id,
                  taskId: job.taskId,
                  event: "merge.resolved",
                  data: {
                    stage: "merge_to_main",
                    branchName: job.branchName,
                    conflictedFiles: mergeResult.autoResolvedFiles,
                    resolvedBy: "auto",
                  },
                })
                .catch(() => {});
            }
          }
        } catch (mergeErr) {
          if (mergeErr instanceof MergeConflictError) {
            log.info("Merge conflict detected, invoking merger agent", {
              branchName: job.branchName,
              conflictedFiles: mergeErr.conflictedFiles,
            });
            const { projectId, config, testCommand } = await this.getMergeAgentConfig(
              repoPath,
              job.taskId
            );
            const resolved = await agentService.runMergerAgentAndWait({
              projectId,
              cwd: repoPath,
              config,
              phase: "merge_to_main",
              taskId: job.taskId,
              branchName: job.branchName,
              conflictedFiles: mergeErr.conflictedFiles,
              testCommand,
            });
            if (resolved) {
              try {
                const msg = formatMergeCommitMessage(job.taskId, taskTitle);
                await waitForGitReady(repoPath);
                await shellExec(
                  `git add -A && git -c core.hooksPath=/dev/null commit -m "${msg.replace(/"/g, '\\"')}"`,
                  {
                    cwd: repoPath,
                    timeout: 30_000,
                  }
                );
                log.info("Merger resolved conflicts, merge commit created", {
                  branchName: job.branchName,
                });
                eventLogService
                  .append(repoPath, {
                    timestamp: new Date().toISOString(),
                    projectId,
                    taskId: job.taskId,
                    event: "merge.resolved",
                    data: {
                      stage: "merge_to_main",
                      branchName: job.branchName,
                      conflictedFiles: mergeErr.conflictedFiles,
                      resolvedBy: "merger",
                    },
                  })
                  .catch(() => {});
              } catch (continueErr) {
                log.warn("merge commit failed after merger", {
                  branchName: job.branchName,
                  continueErr,
                });
                await this.branchManager.mergeAbort(repoPath);
                throw continueErr instanceof Error ? continueErr : new Error(String(continueErr));
              }
            } else {
              log.warn("Merger agent failed to resolve merge conflicts", { branchName: job.branchName });
              await this.branchManager.mergeAbort(repoPath);
              throw new MergeJobError(
                `Merge conflict in ${mergeErr.conflictedFiles.length} file(s): ${mergeErr.conflictedFiles.join(", ")}`,
                "merge_to_main",
                mergeErr.conflictedFiles
              );
            }
          } else {
            throw mergeErr;
          }
        }

        // If merge was "Already up to date", git does not set MERGE_HEAD — nothing to commit.
        if (!(await this.branchManager.isMergeInProgress(repoPath))) {
          log.info("Already up to date, skipping merge commit", { branchName: job.branchName });
          break;
        }

        const msg = formatMergeCommitMessage(job.taskId, taskTitle);
        await waitForGitReady(repoPath);
        await shellExec(`git -c core.hooksPath=/dev/null commit -m "${msg.replace(/"/g, '\\"')}"`, {
          cwd: repoPath,
          timeout: 30_000,
        });
        log.info("Merge commit created", { branchName: job.branchName });
        break;
      }
    }
  }

  // ─── Public API ───

  async enqueue(job: GitCommitJob): Promise<void> {
    this.queue.push({ job });
    if (!this.processing) {
      this.processing = true;
      setImmediate(() => this.processNext());
    }
  }

  async enqueueAndWait(job: GitCommitJob): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      if (!this.processing) {
        this.processing = true;
        setImmediate(() => this.processNext());
      }
    });
  }

  async drain(): Promise<void> {
    if (this.queue.length === 0 && !this.processing) return;
    return new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }
}

export const gitCommitQueue: GitCommitQueueService = new GitCommitQueueImpl();
