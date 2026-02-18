/**
 * Serialized git commit queue (PRD §5.9).
 * Async FIFO queue with single worker for all main-branch git operations.
 * Prevents .git/index.lock contention when multiple agents trigger commits.
 */

import { exec } from "child_process";
import { promisify } from "util";
import { BeadsService } from "./beads.service.js";
import { BranchManager } from "./branch-manager.js";

const execAsync = promisify(exec);

/** Job types for main-branch git operations.
 * Commit message patterns per PRD §5.9:
 * - beads: <summary of changes>
 * - prd: updated after Plan <plan-id> built | prd: Sketch session update
 * - merge: opensprint/<task-id> — <task title>
 */
export type GitCommitJobType = "beads_export" | "prd_update" | "worktree_merge";

export interface BeadsExportJob {
  type: "beads_export";
  repoPath: string;
  summary: string;
}

export interface PrdUpdateJob {
  type: "prd_update";
  repoPath: string;
  /** "plan" | "sketch" | "eval" — for commit message */
  source: "plan" | "sketch" | "eval";
  planId?: string;
}

export interface WorktreeMergeJob {
  type: "worktree_merge";
  repoPath: string;
  branchName: string;
  taskTitle: string;
}

export type GitCommitJob = BeadsExportJob | PrdUpdateJob | WorktreeMergeJob;

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
}

class GitCommitQueueImpl implements GitCommitQueueService {
  private queue: QueuedItem[] = [];
  private processing = false;
  private beads = new BeadsService();
  private branchManager = new BranchManager();
  private drainResolvers: Array<() => void> = [];

  private async processNext(): Promise<void> {
    if (this.queue.length === 0) {
      this.processing = false;
      for (const resolve of this.drainResolvers) resolve();
      this.drainResolvers = [];
      return;
    }

    const item = this.queue.shift()!;
    const job = item.job;
    const maxRetries = 2; // PRD: retry once; if fails again, log and proceed

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await this.executeJob(job);
        item.resolve?.();
        break;
      } catch (err) {
        console.warn(`[git-commit-queue] Job failed (attempt ${attempt + 1}/${maxRetries}):`, err);
        if (attempt === maxRetries - 1) {
          console.error(`[git-commit-queue] Job failed after ${maxRetries} attempts, proceeding to next:`, job);
          item.resolve?.();
        }
      }
    }

    setImmediate(() => this.processNext());
  }

  private async executeJob(job: GitCommitJob): Promise<void> {
    const { repoPath } = job;

    switch (job.type) {
      case "beads_export": {
        await this.beads.export(repoPath, ".beads/issues.jsonl");
        const msg = `beads: ${job.summary}`.replace(/"/g, '\\"');
        await execAsync(`git add .beads/issues.jsonl && git commit -m "${msg}"`, {
          cwd: repoPath,
          timeout: 30000,
        });
        break;
      }
      case "prd_update": {
        const msg =
          job.source === "sketch"
            ? "prd: Sketch session update"
            : job.source === "eval"
              ? "prd: Eval feedback"
              : job.planId
                ? `prd: updated after Plan ${job.planId} built`
                : "prd: updated";
        const escaped = msg.replace(/"/g, '\\"');
        await execAsync(`git add .opensprint/prd.json && git commit -m "${escaped}"`, {
          cwd: repoPath,
          timeout: 30000,
        });
        break;
      }
      case "worktree_merge": {
        await this.branchManager.ensureOnMain(repoPath);
        const msg = `merge: ${job.branchName} — ${job.taskTitle}`;
        await this.branchManager.mergeToMain(repoPath, job.branchName, msg);
        break;
      }
    }
  }

  async enqueue(job: GitCommitJob): Promise<void> {
    this.queue.push({ job });
    if (!this.processing) {
      this.processing = true;
      setImmediate(() => this.processNext());
    }
  }

  async enqueueAndWait(job: GitCommitJob): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push({ job, resolve });
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
      if (this.queue.length === 0 && !this.processing) return;
      setImmediate(() => this.processNext());
    });
  }
}

export const gitCommitQueue: GitCommitQueueService = new GitCommitQueueImpl();
