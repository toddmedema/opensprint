import fs from "fs/promises";
import path from "path";
import type {
  OrchestratorStatus,
  AgentPhase,
  ActiveAgent,
  ActiveTaskConfig,
  CodingAgentResult,
  ReviewAgentResult,
  TestResults,
  PendingFeedbackCategorization,
} from "@opensprint/shared";
import {
  OPENSPRINT_PATHS,
  BACKOFF_FAILURE_THRESHOLD,
  MAX_PRIORITY_BEFORE_BLOCK,
  AGENT_INACTIVITY_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  resolveTestCommand,
  DEFAULT_REVIEW_MODE,
} from "@opensprint/shared";
import { BeadsService, type BeadsIssue } from "./beads.service.js";
import { ProjectService } from "./project.service.js";
import { agentService } from "./agent.service.js";
import { triggerDeploy } from "./deploy-trigger.service.js";
import { BranchManager, RebaseConflictError } from "./branch-manager.js";
import { gitCommitQueue } from "./git-commit-queue.service.js";
import { ContextAssembler } from "./context-assembler.js";
import { SessionManager } from "./session-manager.js";
import { shouldInvokeSummarizer, buildSummarizerPrompt, countWords } from "./summarizer.service.js";
import type { TaskContext } from "./context-assembler.js";
import { TestRunner } from "./test-runner.js";
import { orphanRecoveryService } from "./orphan-recovery.service.js";
import { heartbeatService } from "./heartbeat.service.js";
import { activeAgentsService } from "./active-agents.service.js";
import { FeedbackService } from "./feedback.service.js";
import { broadcastToProject, sendAgentOutputToProject } from "../websocket/index.js";
import { writeJsonAtomic } from "../utils/file-utils.js";

/**
 * Failure types for smarter recovery routing.
 * Only agent-attributable failures count toward progressive backoff.
 */
type FailureType =
  | "test_failure"
  | "review_rejection"
  | "agent_crash"
  | "timeout"
  | "no_result"
  | "merge_conflict"
  | "coding_failure";

/** Failures caused by infrastructure, not the agent's work quality */
const INFRA_FAILURE_TYPES: FailureType[] = ["agent_crash", "timeout", "merge_conflict"];

/** Max number of free infrastructure retries before counting toward backoff */
const MAX_INFRA_RETRIES = 2;

interface RetryContext {
  previousFailure?: string;
  reviewFeedback?: string;
  useExistingBranch?: boolean;
  /** Full test runner output from the previous attempt */
  previousTestOutput?: string;
  /** Git diff from the previous attempt */
  previousDiff?: string;
  /** Type of failure that triggered this retry */
  failureType?: FailureType;
}

/** Watchdog interval: 5 minutes (PRDv2 §5.7) */
const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;

/** Polling interval for monitoring orphaned agent processes during crash recovery */
const RECOVERY_POLL_MS = 5_000;

// ─── State Persistence Types (PRDv2 §5.8) ───

/**
 * Serializable orchestrator state persisted to `.opensprint/orchestrator-state.json`.
 * Written atomically on every state transition so the backend can recover after a crash.
 */
interface PersistedOrchestratorState {
  projectId: string;
  currentTaskId: string | null;
  currentTaskTitle: string | null;
  currentPhase: AgentPhase | null;
  branchName: string | null;
  worktreePath: string | null;
  agentPid: number | null;
  attempt: number;
  startedAt: string | null;
  lastTransition: string;
  /** Epoch ms of last agent output — used to enforce inactivity timeout across restarts */
  lastOutputTimestamp: number | null;
  queueDepth: number;
  totalDone: number;
  totalFailed: number;
}

/** Check whether a PID is still running */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Extract epic ID from task ID (e.g. bd-a3f8.2 -> bd-a3f8). Returns null if not a child task. */
function extractEpicId(id: string | undefined | null): string | null {
  if (id == null || typeof id !== "string") return null;
  const lastDot = id.lastIndexOf(".");
  if (lastDot <= 0) return null;
  return id.slice(0, lastDot);
}

/** Format review rejection result into actionable feedback for the coding agent retry prompt. Exported for testing. */
export function formatReviewFeedback(result: ReviewAgentResult): string {
  const parts: string[] = [];
  if (result.summary) {
    parts.push(result.summary);
  }
  if (result.issues && result.issues.length > 0) {
    parts.push("\n\nIssues to address:");
    for (const issue of result.issues) {
      parts.push(`\n- ${issue}`);
    }
  }
  if (result.notes?.trim()) {
    parts.push(`\n\nNotes: ${result.notes.trim()}`);
  }
  if (parts.length === 0) {
    return "Review rejected (no details provided by review agent).";
  }
  return parts.join("");
}

interface OrchestratorState {
  status: OrchestratorStatus;
  /** True when the orchestrator loop is actively running (internal tracking, not exposed) */
  loopActive: boolean;
  loopTimer: ReturnType<typeof setTimeout> | null;
  watchdogTimer: ReturnType<typeof setInterval> | null;
  activeProcess: { kill: () => void; pid: number | null } | null;
  lastOutputTime: number;
  inactivityTimer: ReturnType<typeof setInterval> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  outputLog: string[];
  startedAt: string;
  attempt: number;
  lastCodingDiff: string;
  lastCodingSummary: string;
  lastTestResults: TestResults | null;
  /** Branch name of the currently active task (for persistence) */
  activeBranchName: string | null;
  /** Title of the current task (for persistence/logging) */
  activeTaskTitle: string | null;
  /** Filesystem path of the active task's git worktree (null when idle) */
  activeWorktreePath: string | null;
  /** Number of infrastructure-caused retries for the current task (not counted toward backoff) */
  infraRetries: number;
  /** Raw test output from the last test run (for richer retry context) */
  lastTestOutput: string;
  /** True when agent was killed due to inactivity timeout (for failure type classification) */
  killedDueToTimeout: boolean;
  /** Feedback items awaiting categorization (PRDv2 §5.8) */
  pendingFeedbackCategorizations: PendingFeedbackCategorization[];
}

/**
 * Build orchestrator service.
 * Manages the single-agent build loop: poll bd ready -> assign -> spawn agent -> monitor -> handle result.
 */
export class OrchestratorService {
  private state = new Map<string, OrchestratorState>();
  private beads = new BeadsService();
  private projectService = new ProjectService();
  private branchManager = new BranchManager();
  private contextAssembler = new ContextAssembler();
  private sessionManager = new SessionManager();
  private testRunner = new TestRunner();
  private feedbackService = new FeedbackService();

  private getState(projectId: string): OrchestratorState {
    if (!this.state.has(projectId)) {
      this.state.set(projectId, {
        status: this.defaultStatus(),
        loopActive: false,
        loopTimer: null,
        watchdogTimer: null,
        activeProcess: null,
        lastOutputTime: 0,
        inactivityTimer: null,
        heartbeatTimer: null,
        outputLog: [],
        startedAt: "",
        attempt: 1,
        lastCodingDiff: "",
        lastCodingSummary: "",
        lastTestResults: null,
        activeBranchName: null,
        activeTaskTitle: null,
        activeWorktreePath: null,
        infraRetries: 0,
        lastTestOutput: "",
        killedDueToTimeout: false,
        pendingFeedbackCategorizations: [],
      });
    }
    return this.state.get(projectId)!;
  }

  private defaultStatus(): OrchestratorStatus {
    return {
      currentTask: null,
      currentPhase: null,
      queueDepth: 0,
      totalDone: 0,
      totalFailed: 0,
    };
  }

  // ─── State Persistence (PRDv2 §5.8) ───

  /**
   * Persist current orchestrator state to `.opensprint/orchestrator-state.json`.
   * Uses atomic write (tmp + rename) to prevent corruption.
   */
  private async persistState(projectId: string, repoPath: string): Promise<void> {
    const state = this.getState(projectId);
    const persisted: PersistedOrchestratorState = {
      projectId,
      currentTaskId: state.status.currentTask,
      currentTaskTitle: state.activeTaskTitle,
      currentPhase: state.status.currentPhase,
      branchName: state.activeBranchName,
      worktreePath: state.activeWorktreePath,
      agentPid: state.activeProcess?.pid ?? null,
      attempt: state.attempt,
      startedAt: state.startedAt || null,
      lastTransition: new Date().toISOString(),
      lastOutputTimestamp: state.lastOutputTime || null,
      queueDepth: state.status.queueDepth,
      totalDone: state.status.totalDone,
      totalFailed: state.status.totalFailed,
    };

    const statePath = path.join(repoPath, OPENSPRINT_PATHS.orchestratorState);
    try {
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      await writeJsonAtomic(statePath, persisted);
    } catch (err) {
      console.warn("[orchestrator] Failed to persist state:", err);
    }
  }

  /** Load persisted state from disk (returns null if none exists or is unreadable) */
  private async loadPersistedState(repoPath: string): Promise<PersistedOrchestratorState | null> {
    const statePath = path.join(repoPath, OPENSPRINT_PATHS.orchestratorState);
    try {
      const raw = await fs.readFile(statePath, "utf-8");
      return JSON.parse(raw) as PersistedOrchestratorState;
    } catch {
      return null;
    }
  }

  /** Clear persisted state (task completed or recovered) */
  private async clearPersistedState(repoPath: string): Promise<void> {
    const statePath = path.join(repoPath, OPENSPRINT_PATHS.orchestratorState);
    try {
      await fs.unlink(statePath);
    } catch {
      // File may not exist
    }
  }

  // ─── Crash Recovery (PRDv2 §5.8) ───

  /**
   * Attempt to recover from a crash based on persisted state.
   * Three scenarios:
   *   1. No active task → normal start
   *   2. Active task, agent PID alive → monitor until exit, then handle result
   *   3. Active task, agent PID dead → revert branch, comment, requeue
   */
  private async recoverFromPersistedState(
    projectId: string,
    repoPath: string,
    persisted: PersistedOrchestratorState
  ): Promise<void> {
    const state = this.getState(projectId);

    // Restore aggregate counters from persisted state
    state.status.totalDone =
      persisted.totalDone ?? (persisted as { totalCompleted?: number }).totalCompleted ?? 0;
    state.status.totalFailed = persisted.totalFailed;

    if (!persisted.currentTaskId || !persisted.branchName) {
      console.log("[orchestrator] Recovery: no active task in persisted state, starting fresh");
      await this.clearPersistedState(repoPath);
      return;
    }

    const taskId = persisted.currentTaskId;
    const branchName = persisted.branchName;
    const pid = persisted.agentPid;

    console.log("[orchestrator] Recovery: found persisted active task", {
      projectId,
      taskId,
      phase: persisted.currentPhase,
      pid,
    });

    // Scenario 2: PID is still alive — check inactivity timeout, then monitor
    if (pid && isPidAlive(pid)) {
      // Determine last known output time: prefer heartbeat file (updated every 10s),
      // fall back to persisted state, then current time as last resort.
      const wtPath = persisted.worktreePath;
      let lastOutput = Date.now();
      let lastOutputSource = "now (fallback)";

      if (wtPath) {
        const hb = await heartbeatService.readHeartbeat(wtPath, taskId);
        if (hb && hb.lastOutputTimestamp > 0) {
          lastOutput = hb.lastOutputTimestamp;
          lastOutputSource = "heartbeat file";
        } else if (persisted.lastOutputTimestamp && persisted.lastOutputTimestamp > 0) {
          lastOutput = persisted.lastOutputTimestamp;
          lastOutputSource = "persisted state";
        }
      } else if (persisted.lastOutputTimestamp && persisted.lastOutputTimestamp > 0) {
        lastOutput = persisted.lastOutputTimestamp;
        lastOutputSource = "persisted state";
      }

      const inactiveMs = Date.now() - lastOutput;
      console.log(`[orchestrator] Recovery: agent PID ${pid} still alive`, {
        lastOutputSource,
        inactiveForSec: Math.round(inactiveMs / 1000),
        timeoutSec: Math.round(AGENT_INACTIVITY_TIMEOUT_MS / 1000),
      });

      // If the agent has already exceeded the inactivity timeout, kill it immediately
      if (inactiveMs > AGENT_INACTIVITY_TIMEOUT_MS) {
        console.warn(
          `[orchestrator] Recovery: agent PID ${pid} exceeded inactivity timeout ` +
            `(${Math.round(inactiveMs / 1000)}s > ${Math.round(AGENT_INACTIVITY_TIMEOUT_MS / 1000)}s), killing`
        );
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            /* already dead */
          }
        }
        setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            /* ignore */
          }
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* ignore */
          }
        }, 5000);

        await this.performCrashRecovery(
          projectId,
          repoPath,
          taskId,
          branchName,
          persisted.worktreePath
        );
        return;
      }

      // Agent is still within timeout window — resume monitoring with inactivity enforcement
      console.log(`[orchestrator] Recovery: resuming monitoring for PID ${pid}`);

      state.status.currentTask = taskId;
      state.status.currentPhase = persisted.currentPhase;
      state.activeBranchName = branchName;
      state.activeTaskTitle = persisted.currentTaskTitle;
      state.activeWorktreePath = persisted.worktreePath ?? null;
      state.attempt = persisted.attempt;
      state.startedAt = persisted.startedAt ?? new Date().toISOString();
      state.lastOutputTime = lastOutput;
      state.loopActive = true;

      // Combined poll: check both PID death and inactivity timeout
      const pollTimer = setInterval(async () => {
        // Check inactivity timeout (using heartbeat for freshest timestamp)
        let currentLastOutput = state.lastOutputTime;
        if (wtPath) {
          const hb = await heartbeatService.readHeartbeat(wtPath, taskId);
          if (hb && hb.lastOutputTimestamp > currentLastOutput) {
            currentLastOutput = hb.lastOutputTimestamp;
            state.lastOutputTime = currentLastOutput;
          }
        }

        const elapsed = Date.now() - currentLastOutput;
        if (elapsed > AGENT_INACTIVITY_TIMEOUT_MS && isPidAlive(pid)) {
          clearInterval(pollTimer);
          console.warn(
            `[orchestrator] Recovery: agent timeout for ${taskId} ` +
              `(${Math.round(elapsed / 1000)}s of inactivity), killing PID ${pid}`
          );
          state.killedDueToTimeout = true;
          try {
            process.kill(-pid, "SIGTERM");
          } catch {
            try {
              process.kill(pid, "SIGTERM");
            } catch {
              /* already dead */
            }
          }
          setTimeout(async () => {
            try {
              process.kill(-pid, "SIGKILL");
            } catch {
              /* ignore */
            }
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              /* ignore */
            }
            try {
              const task = await this.beads.show(repoPath, taskId);
              await this.handleTaskFailure(
                projectId,
                repoPath,
                task,
                branchName,
                `Agent killed after ${Math.round(elapsed / 1000)}s of inactivity (recovery timeout)`,
                null,
                "timeout"
              );
            } catch (err) {
              console.error("[orchestrator] Recovery: timeout handler failed:", err);
              await this.performCrashRecovery(projectId, repoPath, taskId, branchName, wtPath);
            }
          }, 5000);
          return;
        }

        // Check PID death
        if (isPidAlive(pid)) return;
        clearInterval(pollTimer);

        console.log(`[orchestrator] Recovery: agent PID ${pid} has exited, handling result`);
        try {
          const task = await this.beads.show(repoPath, taskId);
          if (persisted.currentPhase === "review") {
            await this.handleReviewDone(projectId, repoPath, task, branchName, null);
          } else {
            await this.handleCodingDone(projectId, repoPath, task, branchName, null);
          }
        } catch (err) {
          console.error("[orchestrator] Recovery: post-exit handling failed:", err);
          await this.performCrashRecovery(
            projectId,
            repoPath,
            taskId,
            branchName,
            persisted.worktreePath
          );
        }
      }, RECOVERY_POLL_MS);
      return;
    }

    // Scenario 3: PID is dead (or missing) — crash recovery
    await this.performCrashRecovery(
      projectId,
      repoPath,
      taskId,
      branchName,
      persisted.worktreePath
    );
  }

  /**
   * Crash recovery with checkpoint detection.
   *
   * Instead of always wiping everything, checks if the branch has meaningful
   * committed work. If it does, preserves the branch so the next attempt can
   * build on the progress. Only deletes the branch if there are no commits
   * beyond main (nothing worth preserving).
   *
   * CRITICAL: persisted state is cleared FIRST before any file-mutating operations.
   */
  private async performCrashRecovery(
    projectId: string,
    repoPath: string,
    taskId: string,
    branchName: string,
    _worktreePath?: string | null
  ): Promise<void> {
    const state = this.getState(projectId);
    console.log(
      `[orchestrator] Recovery: crash recovery for task ${taskId} (branch ${branchName})`
    );

    // 1. Clear persisted state FIRST — breaks any restart loop
    await this.clearPersistedState(repoPath);

    // 2. Check for committed work on the branch (checkpoint detection)
    const commitCount = await this.branchManager.getCommitCountAhead(repoPath, branchName);
    const diff = await this.branchManager.captureBranchDiff(repoPath, branchName);
    if (diff) {
      console.log(
        `[orchestrator] Recovery: captured ${diff.length} bytes of diff from ${branchName} (${commitCount} commits ahead)`
      );
    }

    // 3. Clean up worktree (always — it may be corrupted)
    try {
      await this.branchManager.removeTaskWorktree(repoPath, taskId);
    } catch (err) {
      console.warn("[orchestrator] Recovery: worktree cleanup failed:", err);
    }

    // 4. Decide whether to preserve or delete the branch
    if (commitCount > 0) {
      // Branch has committed work — PRESERVE it for the next attempt
      console.log(
        `[orchestrator] Recovery: preserving branch ${branchName} with ${commitCount} commits`
      );
      try {
        await this.beads.comment(
          repoPath,
          taskId,
          `Agent crashed (backend restart). Branch preserved with ${commitCount} commits for next attempt.`
        );
      } catch (err) {
        console.warn("[orchestrator] Recovery: failed to add comment:", err);
      }
    } else {
      // No commits — delete the branch (nothing to preserve)
      try {
        await this.branchManager.deleteBranch(repoPath, branchName);
      } catch {
        // Branch may not exist
      }
      try {
        await this.beads.comment(
          repoPath,
          taskId,
          "Agent crashed (backend restart). No committed work found, task requeued."
        );
      } catch (err) {
        console.warn("[orchestrator] Recovery: failed to add comment:", err);
      }
    }

    // 5. Requeue the task (set back to open/unassigned)
    try {
      await this.beads.update(repoPath, taskId, {
        status: "open",
        assignee: "",
      });
    } catch {
      // Task may already be in the right state
    }

    state.status.totalFailed += 1;
    state.status.currentTask = null;
    state.status.currentPhase = null;
    state.activeBranchName = null;
    state.activeTaskTitle = null;
    state.activeWorktreePath = null;
    state.loopActive = false;

    broadcastToProject(projectId, {
      type: "task.updated",
      taskId,
      status: "open",
      assignee: null,
    });

    console.log(`[orchestrator] Recovery: task ${taskId} requeued, resuming normal operation`);
  }

  // ─── Lifecycle ───

  /**
   * Stop the orchestrator for a project, tearing down all timers and killing any
   * active agent process. Used when repoPath changes to allow a clean restart.
   */
  stopProject(projectId: string): void {
    const state = this.state.get(projectId);
    if (!state) return;

    console.log(`[orchestrator] Stopping orchestrator for project ${projectId}`);

    if (state.watchdogTimer) {
      clearInterval(state.watchdogTimer);
      state.watchdogTimer = null;
    }
    if (state.loopTimer) {
      clearTimeout(state.loopTimer);
      state.loopTimer = null;
    }
    if (state.inactivityTimer) {
      clearInterval(state.inactivityTimer);
      state.inactivityTimer = null;
    }
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
    if (state.activeProcess) {
      if (state.status.currentTask) {
        activeAgentsService.unregister(state.status.currentTask);
      }
      try {
        state.activeProcess.kill();
      } catch {
        // Process may already be dead
      }
      state.activeProcess = null;
    }

    state.loopActive = false;
    this.state.delete(projectId);

    console.log(`[orchestrator] Orchestrator stopped for project ${projectId}`);
  }

  /**
   * Initialize the always-on orchestrator for a project (PRDv2 §5.7).
   * Called once on backend boot. Checks for persisted state and recovers if needed,
   * then starts the loop and the 5-minute watchdog (PRDv2 §5.8).
   */
  async ensureRunning(projectId: string): Promise<OrchestratorStatus> {
    await this.projectService.getProject(projectId);
    const state = this.getState(projectId);
    const repoPath = await this.projectService.getRepoPath(projectId);

    // Orphan recovery: reset in_progress tasks with agent assignee but no active process
    const persisted = await this.loadPersistedState(repoPath);
    const excludeTaskId =
      persisted?.currentTaskId && persisted.agentPid && isPidAlive(persisted.agentPid)
        ? persisted.currentTaskId
        : undefined;
    let orphanResult: { recovered: string[] };
    try {
      orphanResult = await orphanRecoveryService.recoverOrphanedTasks(repoPath, excludeTaskId);
    } catch (err) {
      console.error("[orchestrator] Orphan recovery failed:", err);
      orphanResult = { recovered: [] };
    }
    // Stale heartbeat recovery: identify orphaned tasks via heartbeat files > 2 min old
    let staleHeartbeatResult: { recovered: string[] };
    try {
      staleHeartbeatResult = await orphanRecoveryService.recoverFromStaleHeartbeats(
        repoPath,
        excludeTaskId
      );
    } catch (err) {
      console.error("[orchestrator] Stale heartbeat recovery failed:", err);
      staleHeartbeatResult = { recovered: [] };
    }
    const recovered = [...new Set([...orphanResult.recovered, ...staleHeartbeatResult.recovered])];
    if (recovered.length > 0) {
      console.warn(
        `[orchestrator] Recovered ${recovered.length} orphaned task(s) on startup: ${recovered.join(", ")}`
      );
    }

    // Crash recovery: check for persisted state from a previous run
    if (persisted && persisted.currentTaskId) {
      await this.recoverFromPersistedState(projectId, repoPath, persisted);
    } else if (persisted) {
      // Persisted state exists but no active task — restore counters and clean up
      state.status.totalDone =
        persisted.totalDone ?? (persisted as { totalCompleted?: number }).totalCompleted ?? 0;
      state.status.totalFailed = persisted.totalFailed;
      await this.clearPersistedState(repoPath);
    }

    // Start watchdog timer if not already running
    if (!state.watchdogTimer) {
      state.watchdogTimer = setInterval(() => {
        this.nudge(projectId);
      }, WATCHDOG_INTERVAL_MS);
      console.log("[orchestrator] Watchdog started (5m interval) for project", projectId);
    }

    // Kick off the loop if idle (recovery may have left it active for PID-alive monitoring)
    if (!state.loopActive) {
      this.nudge(projectId);
    }

    return state.status;
  }

  /**
   * Event-driven dispatch trigger (PRDv2 §5.7).
   * Called on: agent completion, feedback submission, "Build it!" click, watchdog tick.
   * If the loop is idle (no active task, no pending loop timer), starts the loop.
   */
  nudge(projectId: string): void {
    const state = this.getState(projectId);

    // Don't start a second loop if one is already active, has an agent running, or is scheduled
    if (state.loopActive || state.loopTimer || state.activeProcess) {
      return;
    }

    console.log("[orchestrator] Nudge received, starting loop for project", projectId);
    this.runLoop(projectId);
  }

  /** Get orchestrator status */
  async getStatus(projectId: string): Promise<OrchestratorStatus> {
    await this.projectService.getProject(projectId);
    const state = this.getState(projectId);
    return {
      ...state.status,
      worktreePath: state.activeWorktreePath ?? null,
      pendingFeedbackCategorizations: state.pendingFeedbackCategorizations ?? [],
    };
  }

  /**
   * Get active agents for the project (from central ActiveAgentsService registry).
   */
  async getActiveAgents(projectId: string): Promise<ActiveAgent[]> {
    await this.projectService.getProject(projectId);
    return activeAgentsService.list(projectId);
  }

  // ─── Main Orchestrator Loop ───

  private async runLoop(projectId: string): Promise<void> {
    const state = this.getState(projectId);

    // Mark the loop as active to prevent duplicate loops
    state.loopActive = true;
    state.loopTimer = null;

    try {
      const repoPath = await this.projectService.getRepoPath(projectId);

      // 1. Poll bd ready for next task
      let readyTasks = await this.beads.ready(repoPath);

      // Filter out Plan approval gate tasks — they are closed by user "Build It!", not by agents
      readyTasks = readyTasks.filter((t) => (t.title ?? "") !== "Plan approval gate");
      // Filter out epics — they are containers, not work items; agents implement tasks/bugs
      readyTasks = readyTasks.filter((t) => (t.issue_type ?? t.type) !== "epic");
      // Filter out blocked tasks — they require user intervention to unblock (PRDv2 §9.1)
      // Use beads native blocked status (bd update --status blocked); bd ready may exclude them but filter as safety
      readyTasks = readyTasks.filter((t) => (t.status as string) !== "blocked");

      state.status.queueDepth = readyTasks.length;

      if (readyTasks.length === 0) {
        console.log("[orchestrator] No ready tasks, going idle", { projectId });
        state.loopActive = false;
        broadcastToProject(projectId, {
          type: "execute.status",
          currentTask: null,
          queueDepth: 0,
        });
        return;
      }

      // 2. Pick the highest-priority task (pre-flight: verify all blockers are closed)
      let task: BeadsIssue | null = null;
      for (const t of readyTasks) {
        const allClosed = await this.beads.areAllBlockersClosed(repoPath, t.id);
        if (allClosed) {
          task = t;
          break;
        }
        console.log("[orchestrator] Skipping task (blockers not all closed)", {
          projectId,
          taskId: t.id,
          title: t.title,
        });
      }
      if (!task) {
        console.log("[orchestrator] No task with all blockers closed, going idle", {
          projectId,
        });
        state.loopActive = false;
        broadcastToProject(projectId, {
          type: "execute.status",
          currentTask: null,
          queueDepth: 0,
        });
        return;
      }
      console.log("[orchestrator] Picking task", { projectId, taskId: task.id, title: task.title });

      // 3. Assign the task
      await this.beads.update(repoPath, task.id, {
        status: "in_progress",
        assignee: "agent-1",
      });

      // PRD §5.9: Beads export at checkpoint after claim
      gitCommitQueue.enqueue({
        type: "beads_export",
        repoPath,
        summary: `claimed ${task.id}`,
      });

      // Load cumulative attempt count from bead metadata (PRDv2 §9.1)
      const cumulativeAttempts = await this.beads.getCumulativeAttempts(repoPath, task.id);

      state.status.currentTask = task.id;
      state.status.currentPhase = "coding";
      state.attempt = cumulativeAttempts + 1;
      state.activeBranchName = `opensprint/${task.id}`;
      state.activeTaskTitle = task.title ?? null;
      state.activeWorktreePath = null;

      // Persist state: idle → coding transition (PRDv2 §5.8)
      await this.persistState(projectId, repoPath);

      broadcastToProject(projectId, {
        type: "task.updated",
        taskId: task.id,
        status: "in_progress",
        assignee: "agent-1",
      });

      broadcastToProject(projectId, {
        type: "execute.status",
        currentTask: task.id,
        currentPhase: "coding",
        queueDepth: readyTasks.length - 1,
      });

      // agent.started (with startedAt) is broadcast from executeCodingPhase after agent spawn

      // 4. Verify main WT is on main (assertion, not corrective checkout)
      await this.branchManager.ensureOnMain(repoPath);

      // 5. Execute the coding phase (creates worktree, no checkout in main WT)
      await this.executeCodingPhase(projectId, repoPath, task, undefined);
    } catch (error) {
      console.error(`Orchestrator loop error for project ${projectId}:`, error);
      // Retry loop after delay
      state.loopActive = false;
      state.loopTimer = setTimeout(() => this.runLoop(projectId), 10000);
    }
  }

  private async executeCodingPhase(
    projectId: string,
    repoPath: string,
    task: BeadsIssue,
    retryContext?: RetryContext
  ): Promise<void> {
    const state = this.getState(projectId);
    state.killedDueToTimeout = false;
    const settings = await this.projectService.getSettings(projectId);
    const branchName = `opensprint/${task.id}`;

    try {
      // Create an isolated worktree for the agent (no checkout in main WT).
      // createTaskWorktree already handles existing branches — it reuses the
      // branch if it exists, preserving committed work from prior attempts.
      const wtPath = await this.branchManager.createTaskWorktree(repoPath, task.id);
      state.activeWorktreePath = wtPath;

      // Pre-flight health check: ensure environment is ready before spawning agent
      await this.preflightCheck(repoPath, wtPath, task.id);

      // Context assembly: read from main repo (PRD, plans, deps), write prompt to worktree
      let context: TaskContext = await this.contextAssembler.buildContext(
        repoPath,
        task.id,
        this.beads,
        this.branchManager
      );

      // Summarizer: condense context when thresholds exceeded (PRD §7.3.2, §12.3.5)
      if (shouldInvokeSummarizer(context)) {
        const depCount = context.dependencyOutputs.length;
        const planWordCount = countWords(context.planContent);
        const summarizerPrompt = buildSummarizerPrompt(task.id, context, depCount, planWordCount);
        const systemPrompt = `You are the Summarizer agent for OpenSprint (PRD §12.3.5). Condense context into a focused summary when it exceeds size thresholds.`;

        const summarizerId = `summarizer-${projectId}-${task.id}-${Date.now()}`;
        activeAgentsService.register(
          summarizerId,
          projectId,
          "execute",
          "summarizer",
          "Context condensation",
          new Date().toISOString()
        );

        try {
          const summarizerResponse = await agentService.invokePlanningAgent({
            config: settings.planningAgent,
            messages: [{ role: "user", content: summarizerPrompt }],
            systemPrompt,
          });

          const jsonMatch = summarizerResponse.content.match(/\{[\s\S]*"status"[\s\S]*\}/);
          if (jsonMatch) {
            try {
              const parsed = JSON.parse(jsonMatch[0]) as { status: string; summary?: string };
              if (parsed.status === "success" && parsed.summary?.trim()) {
                context = {
                  ...context,
                  planContent: parsed.summary.trim(),
                  prdExcerpt:
                    "Context condensed by Summarizer (thresholds exceeded). See plan.md for full context.",
                  dependencyOutputs: [],
                };
                console.log(`[orchestrator] Summarizer condensed context for task ${task.id}`);
              }
            } catch {
              // Fall through: use raw context if Summarizer output unparseable
            }
          }
        } catch (err) {
          console.warn(
            `[orchestrator] Summarizer failed for ${task.id}, using raw context:`,
            err instanceof Error ? err.message : err
          );
        } finally {
          activeAgentsService.unregister(summarizerId);
        }
      }

      const config: ActiveTaskConfig = {
        invocation_id: task.id,
        agent_role: "coder",
        taskId: task.id,
        repoPath: wtPath,
        branch: branchName,
        testCommand: resolveTestCommand(settings) || 'echo "No test command configured"',
        attempt: state.attempt,
        phase: "coding",
        previousFailure: retryContext?.previousFailure ?? null,
        reviewFeedback: retryContext?.reviewFeedback ?? null,
        previousTestOutput: retryContext?.previousTestOutput ?? null,
        previousDiff: retryContext?.previousDiff ?? null,
        useExistingBranch: retryContext?.useExistingBranch ?? false,
      };

      // Write prompt/config to worktree, read context from main repo
      await this.contextAssembler.assembleTaskDirectory(wtPath, task.id, config, context);

      state.startedAt = new Date().toISOString();
      state.outputLog = [];
      state.lastOutputTime = Date.now();

      activeAgentsService.register(
        task.id,
        projectId,
        "coding",
        "coder",
        state.activeTaskTitle ?? task.id,
        state.startedAt,
        branchName
      );

      broadcastToProject(projectId, {
        type: "agent.started",
        taskId: task.id,
        phase: "coding",
        branchName,
        startedAt: state.startedAt,
      });

      // Spawn the coding agent in the worktree
      const taskDir = this.sessionManager.getActiveDir(wtPath, task.id);
      const promptPath = path.join(taskDir, "prompt.md");

      state.activeProcess = agentService.invokeCodingAgent(promptPath, settings.codingAgent, {
        cwd: wtPath,
        agentRole: "coder",
        onOutput: (chunk: string) => {
          state.outputLog.push(chunk);
          state.lastOutputTime = Date.now();
          sendAgentOutputToProject(projectId, task.id, chunk);
        },
        onExit: async (code: number | null) => {
          state.activeProcess = null;
          if (state.inactivityTimer) {
            clearInterval(state.inactivityTimer);
            state.inactivityTimer = null;
          }
          if (state.heartbeatTimer) {
            clearInterval(state.heartbeatTimer);
            state.heartbeatTimer = null;
          }
          await heartbeatService.deleteHeartbeat(wtPath, task.id);

          await this.handleCodingDone(projectId, repoPath, task, branchName, code);
        },
      });

      // Persist state with agent PID for crash recovery (PRDv2 §5.8)
      await this.persistState(projectId, repoPath);

      // Start heartbeat writing (every 10 seconds)
      state.heartbeatTimer = setInterval(() => {
        if (!state.activeProcess) return;
        heartbeatService
          .writeHeartbeat(wtPath, task.id, {
            pid: state.activeProcess.pid ?? 0,
            lastOutputTimestamp: state.lastOutputTime,
            heartbeatTimestamp: Date.now(),
          })
          .catch(() => {});
      }, HEARTBEAT_INTERVAL_MS);

      // Start inactivity monitoring (commit WIP in worktree before killing)
      // Also check heartbeat: if process is dead (pid check) but timer hasn't fired, recover immediately
      state.inactivityTimer = setInterval(() => {
        const elapsed = Date.now() - state.lastOutputTime;
        const proc = state.activeProcess;
        const pidDead = proc && proc.pid !== null && !isPidAlive(proc.pid);
        if (pidDead) {
          console.warn(
            `Agent process dead for task ${task.id} (PID ${proc.pid}), recovering immediately`
          );
          if (state.inactivityTimer) {
            clearInterval(state.inactivityTimer);
            state.inactivityTimer = null;
          }
          if (state.heartbeatTimer) {
            clearInterval(state.heartbeatTimer);
            state.heartbeatTimer = null;
          }
          state.activeProcess = null;
          heartbeatService.deleteHeartbeat(wtPath, task.id).catch(() => {});
          this.branchManager
            .commitWip(wtPath, task.id)
            .then(() => this.handleCodingDone(projectId, repoPath, task, branchName, null))
            .catch((err) => {
              console.error(`[orchestrator] Post-death handler failed for ${task.id}:`, err);
              this.handleCodingDone(projectId, repoPath, task, branchName, null);
            });
          return;
        }
        if (elapsed > AGENT_INACTIVITY_TIMEOUT_MS) {
          console.warn(`Agent timeout for task ${task.id}: ${elapsed}ms of inactivity`);
          if (state.activeProcess) {
            state.killedDueToTimeout = true;
            this.branchManager
              .commitWip(wtPath, task.id)
              .then(() => state.activeProcess?.kill())
              .catch((err) => {
                console.error(`[orchestrator] Inactivity handler failed for ${task.id}:`, err);
                state.activeProcess?.kill();
              });
          }
        }
      }, 30000);
    } catch (error) {
      console.error(`Coding phase failed for task ${task.id}:`, error);
      await this.handleTaskFailure(
        projectId,
        repoPath,
        task,
        branchName,
        String(error),
        null,
        "agent_crash"
      );
    }
  }

  private async handleCodingDone(
    projectId: string,
    repoPath: string,
    task: BeadsIssue,
    branchName: string,
    exitCode: number | null
  ): Promise<void> {
    activeAgentsService.unregister(task.id);
    const state = this.getState(projectId);
    const wtPath = state.activeWorktreePath ?? repoPath;

    // Check for result.json (in worktree where agent wrote it)
    const result = (await this.sessionManager.readResult(
      wtPath,
      task.id
    )) as CodingAgentResult | null;

    // Normalize status: agents sometimes write "completed"/"done" instead of "success"
    if (result && result.status) {
      const normalized = result.status.toLowerCase().trim();
      if (["completed", "complete", "done", "passed"].includes(normalized)) {
        (result as { status: string }).status = "success";
      }
    }

    // Determine failure type when agent didn't produce a result
    if (!result) {
      const failureType: FailureType = state.killedDueToTimeout
        ? "timeout"
        : exitCode === 143 || exitCode === 137
          ? "agent_crash"
          : "no_result";
      state.killedDueToTimeout = false;
      await this.handleTaskFailure(
        projectId,
        repoPath,
        task,
        branchName,
        `Agent exited with code ${exitCode} without producing a result`,
        null,
        failureType
      );
      return;
    }

    if (result.status === "success") {
      // Get diff without checkout (works across worktree boundaries)
      state.lastCodingDiff = await this.branchManager.captureBranchDiff(repoPath, branchName);
      state.lastCodingSummary = result.summary ?? "";

      // Run scoped tests (only files changed by this task) in the worktree
      const settings = await this.projectService.getSettings(projectId);
      const testCommand = resolveTestCommand(settings) || undefined;
      let changedFiles: string[] = [];
      try {
        changedFiles = await this.branchManager.getChangedFiles(repoPath, branchName);
      } catch {
        // Fall back to full suite
      }
      const scopedResult = await this.testRunner.runScopedTests(wtPath, changedFiles, testCommand);
      state.lastTestOutput = scopedResult.rawOutput;

      if (scopedResult.failed > 0) {
        await this.handleTaskFailure(
          projectId,
          repoPath,
          task,
          branchName,
          `Tests failed: ${scopedResult.failed} failed, ${scopedResult.passed} passed`,
          scopedResult,
          "test_failure"
        );
        return;
      }

      state.lastTestResults = scopedResult;

      // Commit any uncommitted changes in worktree before review/merge
      await this.branchManager.commitWip(wtPath, task.id);

      // Check reviewMode setting to decide whether to invoke the review agent
      const reviewMode = settings.reviewMode ?? DEFAULT_REVIEW_MODE;

      if (reviewMode === "never") {
        // Skip review — go straight to merge
        await this.performMergeAndDone(projectId, repoPath, task, branchName);
      } else {
        // Move to review phase (coding-to-review transition)
        state.status.currentPhase = "review";
        await this.persistState(projectId, repoPath);

        broadcastToProject(projectId, {
          type: "task.updated",
          taskId: task.id,
          status: "in_progress",
          assignee: "agent-1",
        });
        broadcastToProject(projectId, {
          type: "execute.status",
          currentTask: task.id,
          currentPhase: "review",
          queueDepth: state.status.queueDepth,
        });

        await this.executeReviewPhase(projectId, repoPath, task, branchName);
      }
    } else {
      // Coding failed
      const reason = result.summary || `Agent exited with code ${exitCode}`;
      await this.handleTaskFailure(
        projectId,
        repoPath,
        task,
        branchName,
        reason,
        null,
        "coding_failure"
      );
    }
  }

  private async executeReviewPhase(
    projectId: string,
    repoPath: string,
    task: BeadsIssue,
    branchName: string
  ): Promise<void> {
    const state = this.getState(projectId);
    state.killedDueToTimeout = false;
    const settings = await this.projectService.getSettings(projectId);
    const wtPath = state.activeWorktreePath ?? repoPath;

    try {
      // Update config for review phase (written to worktree)
      const config: ActiveTaskConfig = {
        invocation_id: task.id,
        agent_role: "reviewer",
        taskId: task.id,
        repoPath: wtPath,
        branch: branchName,
        testCommand: resolveTestCommand(settings) || 'echo "No test command configured"',
        attempt: state.attempt,
        phase: "review",
        previousFailure: null,
        reviewFeedback: null,
      };

      const taskDir = this.sessionManager.getActiveDir(wtPath, task.id);
      await fs.writeFile(path.join(taskDir, "config.json"), JSON.stringify(config, null, 2));

      // Generate review prompt (read context from main repo, write to worktree)
      const context = await this.contextAssembler.buildContext(
        repoPath,
        task.id,
        this.beads,
        this.branchManager
      );
      await this.contextAssembler.assembleTaskDirectory(wtPath, task.id, config, context);

      state.startedAt = new Date().toISOString();
      state.outputLog = [];
      state.lastOutputTime = Date.now();

      activeAgentsService.register(
        task.id,
        projectId,
        "review",
        "reviewer",
        state.activeTaskTitle ?? task.id,
        state.startedAt,
        branchName
      );

      broadcastToProject(projectId, {
        type: "agent.started",
        taskId: task.id,
        phase: "review",
        branchName,
        startedAt: state.startedAt,
      });

      const promptPath = path.join(taskDir, "prompt.md");

      state.activeProcess = agentService.invokeReviewAgent(promptPath, settings.codingAgent, {
        cwd: wtPath,
        onOutput: (chunk: string) => {
          state.outputLog.push(chunk);
          state.lastOutputTime = Date.now();
          sendAgentOutputToProject(projectId, task.id, chunk);
        },
        onExit: async (code: number | null) => {
          state.activeProcess = null;
          if (state.inactivityTimer) {
            clearInterval(state.inactivityTimer);
            state.inactivityTimer = null;
          }
          if (state.heartbeatTimer) {
            clearInterval(state.heartbeatTimer);
            state.heartbeatTimer = null;
          }
          await heartbeatService.deleteHeartbeat(wtPath, task.id);

          await this.handleReviewDone(projectId, repoPath, task, branchName, code);
        },
      });

      // Persist state with review agent PID for crash recovery (PRDv2 §5.8)
      await this.persistState(projectId, repoPath);

      // Start heartbeat writing (every 10 seconds)
      state.heartbeatTimer = setInterval(() => {
        if (!state.activeProcess) return;
        heartbeatService
          .writeHeartbeat(wtPath, task.id, {
            pid: state.activeProcess.pid ?? 0,
            lastOutputTimestamp: state.lastOutputTime,
            heartbeatTimestamp: Date.now(),
          })
          .catch(() => {});
      }, HEARTBEAT_INTERVAL_MS);

      // Start inactivity monitoring (commit WIP in worktree before killing)
      // Also check heartbeat: if process is dead (pid check) but timer hasn't fired, recover immediately
      state.inactivityTimer = setInterval(() => {
        const elapsed = Date.now() - state.lastOutputTime;
        const proc = state.activeProcess;
        const pidDead = proc && proc.pid !== null && !isPidAlive(proc.pid);
        if (pidDead) {
          console.warn(
            `Agent process dead for task ${task.id} (PID ${proc.pid}), recovering immediately`
          );
          if (state.inactivityTimer) {
            clearInterval(state.inactivityTimer);
            state.inactivityTimer = null;
          }
          if (state.heartbeatTimer) {
            clearInterval(state.heartbeatTimer);
            state.heartbeatTimer = null;
          }
          state.activeProcess = null;
          heartbeatService.deleteHeartbeat(wtPath, task.id).catch(() => {});
          this.branchManager
            .commitWip(wtPath, task.id)
            .then(() => this.handleReviewDone(projectId, repoPath, task, branchName, null))
            .catch((err) => {
              console.error(`[orchestrator] Post-death handler failed for ${task.id}:`, err);
              this.handleReviewDone(projectId, repoPath, task, branchName, null);
            });
          return;
        }
        if (elapsed > AGENT_INACTIVITY_TIMEOUT_MS) {
          console.warn(`Agent timeout for task ${task.id}: ${elapsed}ms of inactivity`);
          if (state.activeProcess) {
            state.killedDueToTimeout = true;
            this.branchManager
              .commitWip(wtPath, task.id)
              .then(() => state.activeProcess?.kill())
              .catch((err) => {
                console.error(`[orchestrator] Inactivity handler failed for ${task.id}:`, err);
                state.activeProcess?.kill();
              });
          }
        }
      }, 30000);
    } catch (error) {
      console.error(`Review phase failed for task ${task.id}:`, error);
      await this.handleTaskFailure(
        projectId,
        repoPath,
        task,
        branchName,
        String(error),
        null,
        "agent_crash"
      );
    }
  }

  private async handleReviewDone(
    projectId: string,
    repoPath: string,
    task: BeadsIssue,
    branchName: string,
    exitCode: number | null
  ): Promise<void> {
    activeAgentsService.unregister(task.id);
    const state = this.getState(projectId);
    const wtPath = state.activeWorktreePath ?? repoPath;
    const result = (await this.sessionManager.readResult(
      wtPath,
      task.id
    )) as ReviewAgentResult | null;

    // Normalize status: agents sometimes write variants like "approve"/"reject" instead of "approved"/"rejected"
    if (result && result.status) {
      const normalized = String(result.status).toLowerCase().trim();
      if (["approve", "success", "accept", "accepted"].includes(normalized)) {
        (result as { status: string }).status = "approved";
      } else if (["reject", "fail", "failed"].includes(normalized)) {
        (result as { status: string }).status = "rejected";
      }
    }

    if (result && result.status === "approved") {
      await this.performMergeAndDone(projectId, repoPath, task, branchName);
    } else if (result && result.status === "rejected") {
      // Review rejected — add feedback to bead, trigger coding retry with feedback in prompt (PRD §7.3.2)
      const reason = `Review rejected: ${result.issues?.join("; ") || result.summary || "No details provided"}`;
      const reviewFeedback = formatReviewFeedback(result);

      // Capture git diff before archiving (branch diff + uncommitted)
      let gitDiff = "";
      try {
        const branchDiff = await this.branchManager.captureBranchDiff(repoPath, branchName);
        const uncommittedDiff = await this.branchManager.captureUncommittedDiff(wtPath);
        gitDiff = [branchDiff, uncommittedDiff]
          .filter(Boolean)
          .join("\n\n--- Uncommitted changes ---\n\n");
      } catch {
        // Best-effort capture
      }

      // Archive rejection session before handling failure
      const session = await this.sessionManager.createSession(repoPath, {
        taskId: task.id,
        attempt: state.attempt,
        agentType: (await this.projectService.getSettings(projectId)).codingAgent.type,
        agentModel: (await this.projectService.getSettings(projectId)).codingAgent.model || "",
        gitBranch: branchName,
        status: "rejected",
        outputLog: state.outputLog.join(""),
        failureReason: result.summary || "Review rejected (no summary provided)",
        gitDiff: gitDiff || undefined,
        startedAt: state.startedAt,
      });
      await this.sessionManager.archiveSession(repoPath, task.id, state.attempt, session, wtPath);

      await this.handleTaskFailure(
        projectId,
        repoPath,
        task,
        branchName,
        reason,
        null,
        "review_rejection",
        reviewFeedback
      );
    } else {
      const failureType: FailureType = state.killedDueToTimeout
        ? "timeout"
        : exitCode === 143 || exitCode === 137
          ? "agent_crash"
          : "no_result";
      state.killedDueToTimeout = false;
      await this.handleTaskFailure(
        projectId,
        repoPath,
        task,
        branchName,
        `Review agent exited with code ${exitCode} without producing a valid result`,
        null,
        failureType
      );
    }
  }

  /**
   * Merge to main, close task, archive session, clean up.
   * Shared by both the direct-merge path (reviewMode: "never") and the review-approved path.
   */
  private async performMergeAndDone(
    projectId: string,
    repoPath: string,
    task: BeadsIssue,
    branchName: string
  ): Promise<void> {
    const state = this.getState(projectId);
    const wtPath = state.activeWorktreePath ?? repoPath;

    // Wait for any lingering git operations in the worktree to finish
    await this.branchManager.waitForGitReady(wtPath);

    // Commit any remaining changes in worktree before merge
    await this.branchManager.commitWip(wtPath, task.id);

    // Merge to main via serialized queue (PRD §5.9)
    try {
      await gitCommitQueue.enqueueAndWait({
        type: "worktree_merge",
        repoPath,
        branchName,
        taskTitle: task.title || task.id,
      });
    } catch (mergeErr) {
      console.warn("[orchestrator] Merge to main failed:", mergeErr);
      const merged = await this.branchManager.verifyMerge(repoPath, branchName);
      if (!merged) {
        await this.handleTaskFailure(
          projectId,
          repoPath,
          task,
          branchName,
          `Merge to main failed: ${mergeErr}`,
          null,
          "merge_conflict"
        );
        return;
      }
    }

    // Close the task in beads
    await this.beads.close(repoPath, task.id, state.lastCodingSummary || "Implemented and tested");

    // PRD §5.9: Orchestrator manages beads persistence explicitly via export at checkpoints
    gitCommitQueue.enqueue({
      type: "beads_export",
      repoPath,
      summary: `closed ${task.id}`,
    });

    // Archive session
    const session = await this.sessionManager.createSession(repoPath, {
      taskId: task.id,
      attempt: state.attempt,
      agentType: (await this.projectService.getSettings(projectId)).codingAgent.type,
      agentModel: (await this.projectService.getSettings(projectId)).codingAgent.model || "",
      gitBranch: branchName,
      status: "approved",
      outputLog: state.outputLog.join(""),
      gitDiff: state.lastCodingDiff,
      summary: state.lastCodingSummary || undefined,
      testResults: state.lastTestResults ?? undefined,
      startedAt: state.startedAt,
    });
    await this.sessionManager.archiveSession(repoPath, task.id, state.attempt, session, wtPath);

    // Clean up worktree then delete branch
    await this.branchManager.removeTaskWorktree(repoPath, task.id);
    await this.branchManager.deleteBranch(repoPath, branchName);

    // Push main to remote so completed work reaches origin.
    // If rebase conflicts with origin/main, spawn a merger agent to resolve them.
    await this.pushMainWithMergerFallback(projectId, repoPath);

    state.status.totalDone += 1;
    state.status.currentTask = null;
    state.status.currentPhase = null;
    state.activeBranchName = null;
    state.activeTaskTitle = null;
    state.activeWorktreePath = null;

    // Clear persisted state: task completed successfully (PRDv2 §5.8)
    await this.clearPersistedState(repoPath);

    broadcastToProject(projectId, {
      type: "task.updated",
      taskId: task.id,
      status: "closed",
      assignee: null,
    });

    // PRD §10.2: Auto-resolve feedback when all its created tasks are Done
    this.feedbackService.checkAutoResolveOnTaskDone(projectId, task.id).catch((err) => {
      console.warn(`[orchestrator] Auto-resolve feedback on task done failed for ${task.id}:`, err);
    });

    broadcastToProject(projectId, {
      type: "agent.completed",
      taskId: task.id,
      status: "approved",
      testResults: state.lastTestResults,
    });

    // PRD §7.5.3: Auto-deploy on epic completion — only when all epic tasks are Done and config enabled
    const epicId = extractEpicId(task.id);
    if (epicId) {
      const allIssues = await this.beads.listAll(repoPath);
      const implTasks = allIssues.filter(
        (i) =>
          i.id.startsWith(epicId + ".") &&
          !i.id.endsWith(".0") &&
          (i.issue_type ?? i.type) !== "epic"
      );
      const allClosed =
        implTasks.length > 0 && implTasks.every((i) => (i.status as string) === "closed");
      if (allClosed) {
        const settings = await this.projectService.getSettings(projectId);
        if (settings.deployment.autoDeployOnEpicCompletion) {
          triggerDeploy(projectId).catch((err) => {
            console.warn(
              `[orchestrator] Auto-deploy on epic completion failed for ${projectId}:`,
              err
            );
          });
        }
      }
    }

    // Mark loop as idle, then re-trigger after a short delay to let git settle
    state.loopActive = false;
    state.loopTimer = setTimeout(() => {
      state.loopTimer = null;
      this.nudge(projectId);
    }, 3000);
  }

  /**
   * Push main to remote, spawning a merger agent to resolve rebase conflicts if needed.
   * On unrecoverable failure, logs a warning but does not throw — the task is already
   * done; we just couldn't push yet.
   */
  private async pushMainWithMergerFallback(projectId: string, repoPath: string): Promise<void> {
    try {
      await this.branchManager.pushMain(repoPath);
    } catch (err) {
      if (!(err instanceof RebaseConflictError)) {
        console.warn("[orchestrator] pushMain failed (non-conflict):", err);
        return;
      }

      console.log(
        `[orchestrator] Rebase conflict in ${err.conflictedFiles.length} file(s), spawning merger agent`
      );

      try {
        const resolved = await this.spawnMergerAgent(projectId, repoPath, err.conflictedFiles);
        if (resolved) {
          await this.branchManager.pushMainToOrigin(repoPath);
          console.log("[orchestrator] Merger agent resolved conflicts, push succeeded");
        } else {
          console.warn("[orchestrator] Merger agent failed to resolve conflicts, aborting rebase");
          await this.branchManager.rebaseAbort(repoPath);
        }
      } catch (mergeErr) {
        console.warn("[orchestrator] Merger agent error, aborting rebase:", mergeErr);
        await this.branchManager.rebaseAbort(repoPath);
      }
    }
  }

  /**
   * Spawn a merger agent to resolve rebase conflicts. Returns true if resolution succeeded.
   * The agent runs synchronously (we await its exit) since this is part of the push flow.
   */
  private async spawnMergerAgent(
    projectId: string,
    repoPath: string,
    conflictedFiles: string[]
  ): Promise<boolean> {
    const settings = await this.projectService.getSettings(projectId);
    const conflictDiff = await this.branchManager.getConflictDiff(repoPath);

    const prompt = this.contextAssembler.generateMergeConflictPrompt({
      conflictedFiles,
      conflictDiff,
    });

    // Write prompt to a temporary file in .opensprint/
    const mergerDir = path.join(repoPath, OPENSPRINT_PATHS.active, "_merger");
    await fs.mkdir(mergerDir, { recursive: true });
    const promptPath = path.join(mergerDir, "prompt.md");
    await fs.writeFile(promptPath, prompt);

    const resultPath = path.join(repoPath, ".opensprint", "merge-result.json");
    try {
      await fs.unlink(resultPath);
    } catch {
      // May not exist
    }

    return new Promise<boolean>((resolve) => {
      const outputLog: string[] = [];

      const handle = agentService.invokeMergerAgent(promptPath, settings.codingAgent, {
        cwd: repoPath,
        onOutput: (chunk: string) => {
          outputLog.push(chunk);
          sendAgentOutputToProject(projectId, "_merger", chunk);
        },
        onExit: async (code: number | null) => {
          console.log(`[orchestrator] Merger agent exited with code ${code}`);

          // Clean up prompt dir
          await fs.rm(mergerDir, { recursive: true, force: true }).catch(() => {});

          // Check if rebase is still in progress (agent failed to complete it)
          const rebaseStillActive = await this.branchManager.isRebaseInProgress(repoPath);
          if (rebaseStillActive) {
            resolve(false);
            return;
          }

          // Read result.json if agent wrote one — its status is authoritative
          try {
            const raw = await fs.readFile(resultPath, "utf-8");
            const result = JSON.parse(raw) as { status: string; summary?: string };
            await fs.unlink(resultPath).catch(() => {});
            if (result.status === "success") {
              console.log(`[orchestrator] Merger agent: ${result.summary ?? "conflicts resolved"}`);
              resolve(true);
            } else {
              console.warn(`[orchestrator] Merger agent reported status: ${result.status}`);
              resolve(false);
            }
            return;
          } catch {
            // No result file — fall back to exit code
          }

          resolve(code === 0 && !rebaseStillActive);
        },
      });

      // Safety timeout: kill merger after 5 minutes
      setTimeout(() => {
        console.warn("[orchestrator] Merger agent timed out after 5 minutes");
        handle.kill();
      }, 300_000);
    });
  }

  /**
   * Progressive backoff error handler (PRDv2 §9.1) with failure classification.
   *
   * Key improvements:
   *   - Infrastructure failures (crash, timeout, merge_conflict) get free retries
   *     and don't count toward the progressive backoff budget.
   *   - On immediate retries, the branch and worktree are PRESERVED so the agent
   *     can build on its previous work rather than starting from scratch.
   *   - On demotion points (every 3rd backoff-eligible failure), branch is deleted
   *     for a clean slate.
   *   - Richer retry context: test output, diff, and failure type are passed to
   *     the next coding attempt.
   */
  private async handleTaskFailure(
    projectId: string,
    repoPath: string,
    task: BeadsIssue,
    branchName: string,
    reason: string,
    testResults?: TestResults | null,
    failureType: FailureType = "coding_failure",
    reviewFeedback?: string
  ): Promise<void> {
    const state = this.getState(projectId);
    const cumulativeAttempts = state.attempt;
    const wtPath = state.activeWorktreePath;
    const isInfraFailure = INFRA_FAILURE_TYPES.includes(failureType);

    console.error(
      `Task ${task.id} failed [${failureType}] (attempt ${cumulativeAttempts}): ${reason}`
    );

    // Capture diff before any cleanup (for richer retry context and session archive)
    let previousDiff = "";
    let gitDiff = "";
    try {
      const branchDiff = await this.branchManager.captureBranchDiff(repoPath, branchName);
      previousDiff = branchDiff;
      let uncommittedDiff = "";
      if (wtPath) {
        uncommittedDiff = await this.branchManager.captureUncommittedDiff(wtPath);
      }
      gitDiff = [branchDiff, uncommittedDiff]
        .filter(Boolean)
        .join("\n\n--- Uncommitted changes ---\n\n");
    } catch {
      // Branch may not exist
    }

    // Archive failure session (always, even on immediate retry)
    const session = await this.sessionManager.createSession(repoPath, {
      taskId: task.id,
      attempt: cumulativeAttempts,
      agentType: (await this.projectService.getSettings(projectId)).codingAgent.type,
      agentModel: (await this.projectService.getSettings(projectId)).codingAgent.model || "",
      gitBranch: branchName,
      status: "failed",
      outputLog: state.outputLog.join(""),
      failureReason: reason,
      testResults: testResults ?? undefined,
      gitDiff: gitDiff || undefined,
      startedAt: state.startedAt,
    });
    await this.sessionManager.archiveSession(
      repoPath,
      task.id,
      cumulativeAttempts,
      session,
      wtPath ?? undefined
    );

    // Add failure comment for audit trail (PRD §7.3.2: rejection feedback as bead comment)
    const commentText =
      failureType === "review_rejection" && reviewFeedback
        ? `Review rejected (attempt ${cumulativeAttempts}):\n\n${reviewFeedback.slice(0, 2000)}`
        : `Attempt ${cumulativeAttempts} failed [${failureType}]: ${reason.slice(0, 500)}`;
    await this.beads
      .comment(repoPath, task.id, commentText)
      .catch((err) => console.warn("[orchestrator] Failed to add failure comment:", err));

    // Infrastructure failures get free retries (up to MAX_INFRA_RETRIES)
    if (isInfraFailure && state.infraRetries < MAX_INFRA_RETRIES) {
      state.infraRetries += 1;
      state.attempt = cumulativeAttempts + 1;
      console.log(
        `[orchestrator] Infrastructure retry ${state.infraRetries}/${MAX_INFRA_RETRIES} for ${task.id} [${failureType}]`
      );

      // Clean up worktree but keep the branch for retry
      if (wtPath) {
        await this.branchManager.removeTaskWorktree(repoPath, task.id);
        state.activeWorktreePath = null;
      }

      await this.persistState(projectId, repoPath);
      await this.executeCodingPhase(projectId, repoPath, task, {
        previousFailure: reason,
        reviewFeedback,
        useExistingBranch: true,
        previousDiff,
        previousTestOutput: state.lastTestOutput || undefined,
        failureType,
      });
      return;
    }

    // Reset infra retry counter for agent-attributable failures
    if (!isInfraFailure) {
      state.infraRetries = 0;
    }

    // Persist cumulative attempt count on the bead issue (PRDv2 §9.1)
    await this.beads.setCumulativeAttempts(repoPath, task.id, cumulativeAttempts);

    const isDemotionPoint = cumulativeAttempts % BACKOFF_FAILURE_THRESHOLD === 0;

    if (!isDemotionPoint) {
      // Immediate retry — KEEP the branch so agent builds on previous work
      if (wtPath) {
        await this.branchManager.removeTaskWorktree(repoPath, task.id);
        state.activeWorktreePath = null;
      }

      state.attempt = cumulativeAttempts + 1;
      console.log(
        `[orchestrator] Retrying ${task.id} (attempt ${state.attempt}), preserving branch`
      );

      await this.persistState(projectId, repoPath);

      await this.executeCodingPhase(projectId, repoPath, task, {
        previousFailure: reason,
        reviewFeedback,
        useExistingBranch: true,
        previousDiff,
        previousTestOutput: state.lastTestOutput || undefined,
        failureType,
      });
    } else {
      // Demotion point: clean slate — delete branch and worktree
      if (wtPath) {
        await this.branchManager.removeTaskWorktree(repoPath, task.id);
        state.activeWorktreePath = null;
      }
      await this.branchManager.deleteBranch(repoPath, branchName);

      const currentPriority = task.priority ?? 2;

      if (currentPriority >= MAX_PRIORITY_BEFORE_BLOCK) {
        await this.blockTask(projectId, repoPath, task, cumulativeAttempts, reason);
      } else {
        const newPriority = currentPriority + 1;
        console.log(
          `[orchestrator] Demoting ${task.id} priority ${currentPriority} → ${newPriority} after ${cumulativeAttempts} failures`
        );

        try {
          await this.beads.update(repoPath, task.id, {
            status: "open",
            assignee: "",
            priority: newPriority,
          });
        } catch {
          // Task may already be in the right state
        }

        state.status.totalFailed += 1;
        state.status.currentTask = null;
        state.status.currentPhase = null;
        state.activeBranchName = null;
        state.activeTaskTitle = null;
        state.activeWorktreePath = null;

        await this.clearPersistedState(repoPath);

        broadcastToProject(projectId, {
          type: "task.updated",
          taskId: task.id,
          status: "open",
          assignee: null,
        });

        broadcastToProject(projectId, {
          type: "agent.completed",
          taskId: task.id,
          status: "failed",
          testResults: null,
        });

        state.loopActive = false;
        state.loopTimer = setTimeout(() => {
          state.loopTimer = null;
          this.nudge(projectId);
        }, 2000);
      }
    }
  }

  // ─── Pre-Flight Health Check ───

  /**
   * Validate the worktree environment before spawning an agent.
   * Fixes recoverable issues (missing symlinks, stale result.json) in-place.
   * If pre-flight fails, the issue is environmental — not the agent's fault.
   */
  private async preflightCheck(repoPath: string, wtPath: string, taskId: string): Promise<void> {
    // 1. Ensure git is ready (no stale locks)
    await this.branchManager.waitForGitReady(wtPath);

    // 2. Ensure node_modules symlink is intact
    try {
      await fs.access(path.join(wtPath, "node_modules"));
    } catch {
      console.warn("[orchestrator] Pre-flight: node_modules missing, re-symlinking");
      await this.branchManager.symlinkNodeModules(repoPath, wtPath);
    }

    // 3. Clear stale result.json from a previous run
    await this.sessionManager.clearResult(wtPath, taskId);
  }

  /**
   * Block a task after progressive backoff exhaustion (PRDv2 §9.1).
   * Sets beads status to blocked via bd update --status blocked; emits task.blocked.
   */
  private async blockTask(
    projectId: string,
    repoPath: string,
    task: BeadsIssue,
    cumulativeAttempts: number,
    reason: string
  ): Promise<void> {
    const state = this.getState(projectId);

    console.log(
      `[orchestrator] Blocking ${task.id} after ${cumulativeAttempts} cumulative failures at max priority`
    );

    try {
      await this.beads.update(repoPath, task.id, {
        status: "blocked",
        assignee: "",
      });
    } catch (err) {
      console.warn("[orchestrator] Failed to block task:", err);
    }

    state.status.totalFailed += 1;
    state.status.currentTask = null;
    state.status.currentPhase = null;
    state.activeBranchName = null;
    state.activeTaskTitle = null;
    state.activeWorktreePath = null;

    // Clear persisted state (PRDv2 §5.8)
    await this.clearPersistedState(repoPath);

    broadcastToProject(projectId, {
      type: "task.blocked",
      taskId: task.id,
      reason: `Blocked after ${cumulativeAttempts} failed attempts: ${reason.slice(0, 300)}`,
      cumulativeAttempts,
    });

    broadcastToProject(projectId, {
      type: "task.updated",
      taskId: task.id,
      status: "blocked",
      assignee: null,
    });

    broadcastToProject(projectId, {
      type: "agent.completed",
      taskId: task.id,
      status: "failed",
      testResults: null,
    });

    // Mark loop idle and schedule next iteration
    state.loopActive = false;
    state.loopTimer = setTimeout(() => {
      state.loopTimer = null;
      this.nudge(projectId);
    }, 2000);
  }
}

/** Shared orchestrator instance for build routes and task list (kanban phase override) */
export const orchestratorService = new OrchestratorService();
