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
} from "@opensprint/shared";
import {
  OPENSPRINT_PATHS,
  BACKOFF_FAILURE_THRESHOLD,
  MAX_PRIORITY_BEFORE_BLOCK,
  AGENT_INACTIVITY_TIMEOUT_MS,
  getTestCommandForFramework,
} from "@opensprint/shared";
import { BeadsService, type BeadsIssue } from "./beads.service.js";
import { ProjectService } from "./project.service.js";
import { agentService } from "./agent.service.js";
import { deploymentService } from "./deployment-service.js";
import { BranchManager } from "./branch-manager.js";
import { ContextAssembler } from "./context-assembler.js";
import { SessionManager } from "./session-manager.js";
import { TestRunner } from "./test-runner.js";
import { orphanRecoveryService } from "./orphan-recovery.service.js";
import { broadcastToProject, sendAgentOutputToProject } from "../websocket/index.js";

interface RetryContext {
  previousFailure?: string;
  reviewFeedback?: string;
  useExistingBranch?: boolean;
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
  queueDepth: number;
  totalCompleted: number;
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

interface OrchestratorState {
  status: OrchestratorStatus;
  /** True when the orchestrator loop is actively running (internal tracking, not exposed) */
  loopActive: boolean;
  loopTimer: ReturnType<typeof setTimeout> | null;
  watchdogTimer: ReturnType<typeof setInterval> | null;
  activeProcess: { kill: () => void; pid: number | null } | null;
  lastOutputTime: number;
  inactivityTimer: ReturnType<typeof setInterval> | null;
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
        outputLog: [],
        startedAt: "",
        attempt: 1,
        lastCodingDiff: "",
        lastCodingSummary: "",
        lastTestResults: null,
        activeBranchName: null,
        activeTaskTitle: null,
        activeWorktreePath: null,
      });
    }
    return this.state.get(projectId)!;
  }

  private defaultStatus(): OrchestratorStatus {
    return {
      currentTask: null,
      currentPhase: null,
      queueDepth: 0,
      totalCompleted: 0,
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
      queueDepth: state.status.queueDepth,
      totalCompleted: state.status.totalCompleted,
      totalFailed: state.status.totalFailed,
    };

    const statePath = path.join(repoPath, OPENSPRINT_PATHS.orchestratorState);
    const tmpPath = statePath + ".tmp";
    try {
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      await fs.writeFile(tmpPath, JSON.stringify(persisted, null, 2));
      await fs.rename(tmpPath, statePath);
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
    persisted: PersistedOrchestratorState,
  ): Promise<void> {
    const state = this.getState(projectId);

    // Restore aggregate counters from persisted state
    state.status.totalCompleted = persisted.totalCompleted;
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

    // Scenario 2: PID is still alive — monitor and wait for exit
    if (pid && isPidAlive(pid)) {
      console.log(`[orchestrator] Recovery: agent PID ${pid} still alive, resuming monitoring`);

      state.status.currentTask = taskId;
      state.status.currentPhase = persisted.currentPhase;
      state.activeBranchName = branchName;
      state.activeTaskTitle = persisted.currentTaskTitle;
      state.activeWorktreePath = persisted.worktreePath ?? null;
      state.attempt = persisted.attempt;
      state.startedAt = persisted.startedAt ?? new Date().toISOString();
      state.loopActive = true;

      // Poll until the process exits, then handle the result
      const pollTimer = setInterval(async () => {
        if (isPidAlive(pid)) return;
        clearInterval(pollTimer);

        console.log(`[orchestrator] Recovery: agent PID ${pid} has exited, handling result`);
        try {
          const task = await this.beads.show(repoPath, taskId);
          if (persisted.currentPhase === "review") {
            await this.handleReviewComplete(projectId, repoPath, task, branchName, null);
          } else {
            await this.handleCodingComplete(projectId, repoPath, task, branchName, null);
          }
        } catch (err) {
          console.error("[orchestrator] Recovery: post-exit handling failed:", err);
          await this.performCrashRecovery(projectId, repoPath, taskId, branchName, persisted.worktreePath);
        }
      }, RECOVERY_POLL_MS);
      return;
    }

    // Scenario 3: PID is dead (or missing) — crash recovery
    await this.performCrashRecovery(projectId, repoPath, taskId, branchName, persisted.worktreePath);
  }

  /**
   * Crash recovery: clear state, clean up worktree, requeue task.
   *
   * CRITICAL: persisted state is cleared FIRST before any file-mutating operations.
   * This ensures that even if tsx restarts during cleanup, the new process sees no
   * state to recover and starts fresh. Orphan recovery will catch any leftover tasks.
   *
   * No `git checkout` operations are performed in the main working tree.
   */
  private async performCrashRecovery(
    projectId: string,
    repoPath: string,
    taskId: string,
    branchName: string,
    worktreePath?: string | null,
  ): Promise<void> {
    const state = this.getState(projectId);
    console.log(`[orchestrator] Recovery: crash recovery for task ${taskId} (branch ${branchName})`);

    // 1. Clear persisted state FIRST — breaks any restart loop
    await this.clearPersistedState(repoPath);

    // 2. Capture diff without checkout (for logging/archival)
    const diff = await this.branchManager.captureBranchDiff(repoPath, branchName);
    if (diff) {
      console.log(`[orchestrator] Recovery: captured ${diff.length} bytes of diff from ${branchName}`);
    }

    // 3. Clean up worktree (no main working tree changes)
    try {
      await this.branchManager.removeTaskWorktree(repoPath, taskId);
    } catch (err) {
      console.warn("[orchestrator] Recovery: worktree cleanup failed:", err);
    }

    // 4. Delete the task branch (safe: main WT stays on main)
    try {
      await this.branchManager.deleteBranch(repoPath, branchName);
    } catch {
      // Branch may not exist or may have already been deleted
    }

    // 5. Add failure comment to the task
    try {
      await this.beads.comment(
        repoPath,
        taskId,
        "Agent process crashed (backend restart). Worktree cleaned up, task requeued.",
      );
    } catch (err) {
      console.warn("[orchestrator] Recovery: failed to add comment:", err);
    }

    // 6. Requeue the task (set back to open/unassigned)
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
    const { recovered } = orphanResult;
    if (recovered.length > 0) {
      console.warn(
        `[orchestrator] Recovered ${recovered.length} orphaned task(s) on startup: ${recovered.join(", ")}`,
      );
    }

    // Crash recovery: check for persisted state from a previous run
    if (persisted && persisted.currentTaskId) {
      await this.recoverFromPersistedState(projectId, repoPath, persisted);
    } else if (persisted) {
      // Persisted state exists but no active task — restore counters and clean up
      state.status.totalCompleted = persisted.totalCompleted;
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
    return this.getState(projectId).status;
  }

  /**
   * Get active agents for the project (Build phase agents from orchestrator state).
   * Returns the current task when one is running (coding or review phase).
   */
  async getActiveAgents(projectId: string): Promise<ActiveAgent[]> {
    await this.projectService.getProject(projectId);
    const state = this.getState(projectId);
    const { currentTask, currentPhase } = state.status;
    if (!currentTask || !currentPhase) return [];
    return [
      {
        id: currentTask,
        phase: currentPhase,
        label: state.activeTaskTitle ?? currentTask,
        startedAt: state.startedAt || new Date().toISOString(),
        branchName: state.activeBranchName ?? undefined,
      },
    ];
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
      readyTasks = readyTasks.filter((t) => !this.beads.hasLabel(t, "blocked"));

      state.status.queueDepth = readyTasks.length;

      if (readyTasks.length === 0) {
        console.log("[orchestrator] No ready tasks, going idle", { projectId });
        state.loopActive = false;
        broadcastToProject(projectId, {
          type: "build.status",
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
          type: "build.status",
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
        type: "build.status",
        currentTask: task.id,
        currentPhase: "coding",
        queueDepth: readyTasks.length - 1,
      });

      broadcastToProject(projectId, {
        type: "agent.started",
        taskId: task.id,
        phase: "coding",
        branchName: `opensprint/${task.id}`,
      });

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
    retryContext?: RetryContext,
  ): Promise<void> {
    const state = this.getState(projectId);
    const settings = await this.projectService.getSettings(projectId);
    const branchName = `opensprint/${task.id}`;

    try {
      // Create an isolated worktree for the agent (no checkout in main WT)
      const wtPath = await this.branchManager.createTaskWorktree(repoPath, task.id);
      state.activeWorktreePath = wtPath;

      // Context assembly: read from main repo (PRD, plans, deps), write prompt to worktree
      const context = await this.contextAssembler.buildContext(repoPath, task.id, this.beads, this.branchManager);

      const config: ActiveTaskConfig = {
        taskId: task.id,
        repoPath: wtPath,
        branch: branchName,
        testCommand: (() => {
          const cmd = getTestCommandForFramework(settings.testFramework);
          return cmd || 'echo "No test command configured"';
        })(),
        attempt: state.attempt,
        phase: "coding",
        previousFailure: retryContext?.previousFailure ?? null,
        reviewFeedback: retryContext?.reviewFeedback ?? null,
      };

      // Write prompt/config to worktree, read context from main repo
      await this.contextAssembler.assembleTaskDirectory(wtPath, task.id, config, context);

      state.startedAt = new Date().toISOString();
      state.outputLog = [];
      state.lastOutputTime = Date.now();

      // Spawn the coding agent in the worktree
      const taskDir = this.sessionManager.getActiveDir(wtPath, task.id);
      const promptPath = path.join(taskDir, "prompt.md");

      state.activeProcess = agentService.invokeCodingAgent(promptPath, settings.codingAgent, {
        cwd: wtPath,
        agentRole: 'coder',
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

          await this.handleCodingComplete(projectId, repoPath, task, branchName, code);
        },
      });

      // Persist state with agent PID for crash recovery (PRDv2 §5.8)
      await this.persistState(projectId, repoPath);

      // Start inactivity monitoring (commit WIP in worktree before killing)
      state.inactivityTimer = setInterval(() => {
        const elapsed = Date.now() - state.lastOutputTime;
        if (elapsed > AGENT_INACTIVITY_TIMEOUT_MS) {
          console.warn(`Agent timeout for task ${task.id}: ${elapsed}ms of inactivity`);
          if (state.activeProcess) {
            this.branchManager.commitWip(wtPath, task.id)
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
      await this.handleTaskFailure(projectId, repoPath, task, branchName, String(error), null);
    }
  }

  private async handleCodingComplete(
    projectId: string,
    repoPath: string,
    task: BeadsIssue,
    branchName: string,
    exitCode: number | null,
  ): Promise<void> {
    const state = this.getState(projectId);
    const wtPath = state.activeWorktreePath ?? repoPath;

    // Check for result.json (in worktree where agent wrote it)
    const result = (await this.sessionManager.readResult(wtPath, task.id)) as CodingAgentResult | null;

    // Normalize status: agents sometimes write "completed"/"done" instead of "success"
    if (result && result.status) {
      const normalized = result.status.toLowerCase().trim();
      if (["completed", "complete", "done", "passed"].includes(normalized)) {
        (result as { status: string }).status = "success";
      }
    }

    if (result && result.status === "success") {
      // Get diff without checkout (works across worktree boundaries)
      state.lastCodingDiff = await this.branchManager.captureBranchDiff(repoPath, branchName);
      state.lastCodingSummary = result.summary ?? "";

      // Run tests in the worktree
      const settings = await this.projectService.getSettings(projectId);
      const testCommand = getTestCommandForFramework(settings.testFramework) || undefined;
      const testResults = await this.testRunner.runTests(wtPath, testCommand);
      if (testResults.failed > 0) {
        await this.handleTaskFailure(
          projectId,
          repoPath,
          task,
          branchName,
          `Tests failed: ${testResults.failed} failed, ${testResults.passed} passed`,
          testResults,
        );
        return;
      }

      state.lastTestResults = testResults;

      // Commit any uncommitted changes in worktree before review
      await this.branchManager.commitWip(wtPath, task.id);

      // Move to review phase (coding-to-review transition)
      state.status.currentPhase = "review";

      // Persist state: coding → review transition (PRDv2 §5.8)
      await this.persistState(projectId, repoPath);

      broadcastToProject(projectId, {
        type: "task.updated",
        taskId: task.id,
        status: "in_progress",
        assignee: "agent-1",
      });
      broadcastToProject(projectId, {
        type: "build.status",
        currentTask: task.id,
        currentPhase: "review",
        queueDepth: state.status.queueDepth,
      });

      await this.executeReviewPhase(projectId, repoPath, task, branchName);
    } else {
      // Coding failed
      const reason = result?.summary || `Agent exited with code ${exitCode}`;
      await this.handleTaskFailure(projectId, repoPath, task, branchName, reason, null);
    }
  }

  private async executeReviewPhase(
    projectId: string,
    repoPath: string,
    task: BeadsIssue,
    branchName: string,
  ): Promise<void> {
    const state = this.getState(projectId);
    const settings = await this.projectService.getSettings(projectId);
    const wtPath = state.activeWorktreePath ?? repoPath;

    try {
      // Update config for review phase (written to worktree)
      const config: ActiveTaskConfig = {
        taskId: task.id,
        repoPath: wtPath,
        branch: branchName,
        testCommand: (() => {
          const cmd = getTestCommandForFramework(settings.testFramework);
          return cmd || 'echo "No test command configured"';
        })(),
        attempt: state.attempt,
        phase: "review",
        previousFailure: null,
        reviewFeedback: null,
      };

      const taskDir = this.sessionManager.getActiveDir(wtPath, task.id);
      await fs.writeFile(path.join(taskDir, "config.json"), JSON.stringify(config, null, 2));

      // Generate review prompt (read context from main repo, write to worktree)
      const context = await this.contextAssembler.buildContext(repoPath, task.id, this.beads, this.branchManager);
      await this.contextAssembler.assembleTaskDirectory(wtPath, task.id, config, context);

      state.startedAt = new Date().toISOString();
      state.outputLog = [];
      state.lastOutputTime = Date.now();

      broadcastToProject(projectId, {
        type: "agent.started",
        taskId: task.id,
        phase: "review",
        branchName,
      });

      const promptPath = path.join(taskDir, "prompt.md");

      state.activeProcess = agentService.invokeReviewAgent(
        promptPath,
        settings.codingAgent,
        {
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

            await this.handleReviewComplete(projectId, repoPath, task, branchName, code);
          },
        },
      );

      // Persist state with review agent PID for crash recovery (PRDv2 §5.8)
      await this.persistState(projectId, repoPath);

      // Start inactivity monitoring (commit WIP in worktree before killing)
      state.inactivityTimer = setInterval(() => {
        const elapsed = Date.now() - state.lastOutputTime;
        if (elapsed > AGENT_INACTIVITY_TIMEOUT_MS) {
          console.warn(`Agent timeout for task ${task.id}: ${elapsed}ms of inactivity`);
          if (state.activeProcess) {
            this.branchManager.commitWip(wtPath, task.id)
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
      await this.handleTaskFailure(projectId, repoPath, task, branchName, String(error), null);
    }
  }

  private async handleReviewComplete(
    projectId: string,
    repoPath: string,
    task: BeadsIssue,
    branchName: string,
    exitCode: number | null,
  ): Promise<void> {
    const state = this.getState(projectId);
    const wtPath = state.activeWorktreePath ?? repoPath;
    const result = (await this.sessionManager.readResult(wtPath, task.id)) as ReviewAgentResult | null;

    if (result && result.status === "approved") {
      // Wait for any lingering git operations in the worktree to finish
      await this.branchManager.waitForGitReady(wtPath);

      // Commit any remaining changes in worktree before merge
      await this.branchManager.commitWip(wtPath, task.id);

      // Merge to main from the main working tree (no checkout needed)
      try {
        await this.branchManager.mergeToMain(repoPath, branchName);
      } catch (mergeErr) {
        console.warn("[orchestrator] Merge to main failed:", mergeErr);
        // Verify merge didn't happen at all before treating as failure
        const merged = await this.branchManager.verifyMerge(repoPath, branchName);
        if (!merged) {
          await this.handleTaskFailure(
            projectId,
            repoPath,
            task,
            branchName,
            `Merge to main failed: ${mergeErr}`,
            null,
          );
          return;
        }
      }

      // Close the task in beads
      await this.beads.close(repoPath, task.id, result.summary || "Implemented and reviewed");

      // Archive session from worktree to main repo sessions dir
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

      // Push main to remote so completed work reaches origin
      await this.branchManager.pushMain(repoPath).catch((err) => {
        console.warn("[orchestrator] pushMain failed after merge:", err);
      });

      state.status.totalCompleted += 1;
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

      broadcastToProject(projectId, {
        type: "agent.completed",
        taskId: task.id,
        status: "approved",
        testResults: state.lastTestResults,
      });

      // Trigger deployment after Build completion (PRD §6.4)
      deploymentService.deploy(projectId).catch((err) => {
        console.warn(`Deployment trigger failed for project ${projectId}:`, err);
      });

      // Mark loop as idle, then re-trigger after a short delay to let git settle
      state.loopActive = false;
      state.loopTimer = setTimeout(() => this.nudge(projectId), 3000);
    } else if (result && result.status === "rejected") {
      // Review rejected — treat as a failure for progressive backoff (PRDv2 §9.1)
      const reason = `Review rejected: ${result.issues?.join("; ") || result.summary}`;
      const reviewFeedback = [result.summary, ...(result.issues ?? [])].filter(Boolean).join("\n");

      // Archive rejection session before handling failure
      const session = await this.sessionManager.createSession(repoPath, {
        taskId: task.id,
        attempt: state.attempt,
        agentType: (await this.projectService.getSettings(projectId)).codingAgent.type,
        agentModel: (await this.projectService.getSettings(projectId)).codingAgent.model || "",
        gitBranch: branchName,
        status: "rejected",
        outputLog: state.outputLog.join(""),
        failureReason: result.summary,
        startedAt: state.startedAt,
      });
      await this.sessionManager.archiveSession(repoPath, task.id, state.attempt, session, wtPath);

      // Delegate to progressive backoff handler (which will retry, demote, or block)
      await this.handleTaskFailure(projectId, repoPath, task, branchName, reason, null);
    } else {
      // No result.json or unexpected status
      await this.handleTaskFailure(
        projectId,
        repoPath,
        task,
        branchName,
        `Review agent exited with code ${exitCode} without producing a valid result`,
        null,
      );
    }
  }

  /**
   * Progressive backoff error handler (PRDv2 §9.1).
   *
   * No checkout operations are performed on the main working tree.
   * The worktree is cleaned up and the branch is deleted.
   *
   * Backoff cadence:
   *   - Attempts where (cumulative % 3 !== 0): immediate retry with failure context
   *   - Every 3rd failure: deprioritize the task (beads priority += 1)
   *   - At priority 4 on a 3rd failure: add `blocked` label, emit `task.blocked`
   */
  private async handleTaskFailure(
    projectId: string,
    repoPath: string,
    task: BeadsIssue,
    branchName: string,
    reason: string,
    testResults?: TestResults | null,
  ): Promise<void> {
    const state = this.getState(projectId);
    const cumulativeAttempts = state.attempt;
    const wtPath = state.activeWorktreePath;

    console.error(`Task ${task.id} failed (cumulative attempt ${cumulativeAttempts}): ${reason}`);

    // Clean up worktree (no main working tree changes)
    if (wtPath) {
      await this.branchManager.removeTaskWorktree(repoPath, task.id);
      state.activeWorktreePath = null;
    }

    // Delete branch (safe: main WT stays on main)
    await this.branchManager.deleteBranch(repoPath, branchName);

    // Archive failure session (to main repo sessions dir)
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
      startedAt: state.startedAt,
    });
    await this.sessionManager.archiveSession(repoPath, task.id, cumulativeAttempts, session);

    // Persist cumulative attempt count on the bead issue (PRDv2 §9.1)
    await this.beads.setCumulativeAttempts(repoPath, task.id, cumulativeAttempts);

    // Add failure comment for audit trail
    await this.beads.comment(
      repoPath,
      task.id,
      `Attempt ${cumulativeAttempts} failed: ${reason.slice(0, 500)}`,
    ).catch((err) => console.warn("[orchestrator] Failed to add failure comment:", err));

    const isDemotionPoint = cumulativeAttempts % BACKOFF_FAILURE_THRESHOLD === 0;

    if (!isDemotionPoint) {
      // Immediate retry with failure context
      state.attempt = cumulativeAttempts + 1;
      console.log(`[orchestrator] Retrying ${task.id} (attempt ${state.attempt})`);

      // Persist state: retry attempt transition (PRDv2 §5.8)
      await this.persistState(projectId, repoPath);

      await this.executeCodingPhase(projectId, repoPath, task, {
        previousFailure: reason,
      });
    } else {
      // Demotion point: deprioritize or block
      const currentPriority = task.priority ?? 2;

      if (currentPriority >= MAX_PRIORITY_BEFORE_BLOCK) {
        // At max priority — block the task
        await this.blockTask(projectId, repoPath, task, cumulativeAttempts, reason);
      } else {
        // Deprioritize and requeue for later pickup
        const newPriority = currentPriority + 1;
        console.log(
          `[orchestrator] Demoting ${task.id} priority ${currentPriority} → ${newPriority} after ${cumulativeAttempts} failures`,
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

        // Clear persisted state: task returned to queue (PRDv2 §5.8)
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

        // Mark loop idle and schedule next iteration
        state.loopActive = false;
        state.loopTimer = setTimeout(() => this.nudge(projectId), 2000);
      }
    }
  }

  /**
   * Block a task after progressive backoff exhaustion (PRDv2 §9.1).
   * Adds the `blocked` label, emits `task.blocked`, and moves the task out of the active queue.
   */
  private async blockTask(
    projectId: string,
    repoPath: string,
    task: BeadsIssue,
    cumulativeAttempts: number,
    reason: string,
  ): Promise<void> {
    const state = this.getState(projectId);

    console.log(
      `[orchestrator] Blocking ${task.id} after ${cumulativeAttempts} cumulative failures at max priority`,
    );

    try {
      await this.beads.addLabel(repoPath, task.id, "blocked");
      await this.beads.update(repoPath, task.id, {
        status: "open",
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
      status: "open",
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
    state.loopTimer = setTimeout(() => this.nudge(projectId), 2000);
  }
}

/** Shared orchestrator instance for build routes and task list (kanban phase override) */
export const orchestratorService = new OrchestratorService();