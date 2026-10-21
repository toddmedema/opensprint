import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import type {
  AgentConfig,
  AgentPhase,
  AgentRuntimeState,
  AgentSuspendReason,
} from "@opensprint/shared";
import {
  AGENT_INACTIVITY_TIMEOUT_MS,
  AGENT_SUSPEND_GRACE_MS,
  HEARTBEAT_INTERVAL_MS,
  OPENSPRINT_PATHS,
} from "@opensprint/shared";
import {
  acquireGlobalAgentSlot,
  trackExistingGlobalAgentSlot,
} from "./agent-global-concurrency.service.js";
import { agentService } from "./agent.service.js";
import type { CodingAgentHandle } from "./agent.service.js";
import { activeAgentsService } from "./active-agents.service.js";
import { heartbeatService } from "./heartbeat.service.js";
import { BranchManager } from "./branch-manager.js";
import { eventLogService } from "./event-log.service.js";
import { broadcastToProject, sendAgentOutputToProject } from "../websocket/index.js";
import { TimerRegistry } from "./timer-registry.js";
import { createLogger } from "../utils/logger.js";
import { createAgentOutputFilter } from "../utils/agent-output-filter.js";
import type { AgentOutputFilter } from "../utils/agent-output-filter.js";
import { fireAndForget } from "../utils/fire-and-forget.js";
import { AgentRunner } from "./agent/agent-runner.js";
import {
  executionOwnershipService,
  projectLeadershipService,
  withExecutionFence,
  withoutExecutionFence,
  type ExecutionFence,
} from "./execution-ownership.service.js";
import { executionOutputService } from "./execution-output.service.js";

const log = createLogger("agent-lifecycle");

/** Poll interval for tailing agent output file after GUPP recovery (must match agent-client for consistency) */
const OUTPUT_POLL_MS = 150;
/** Poll for terminal result.json in case the agent writes completion but process/external callback lags or wedges. */
const RESULT_POLL_MS = (() => {
  const raw = Number(process.env.OPENSPRINT_RESULT_POLL_MS ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : 500;
})();
/** Allow long-running shell/tool execution (e.g. npm test) to finish and report back before inactivity kills the agent. */
const ACTIVE_TOOL_CALL_TIMEOUT_MS = 15 * 60 * 1000;
/** Require at least this extra quiet period beyond inactivity timeout before marking suspended. */
const SUSPEND_TRANSITION_DELAY_MS = 60 * 1000;
const RECOVERY_TAIL_BYTES = 256 * 1024;
const RESULT_TERMINAL_STATUSES = new Set(["success", "failed", "approved", "rejected"]);

/** Check whether a PID is still running */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Max total bytes retained in outputLog before oldest chunks are dropped */
const MAX_OUTPUT_LOG_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Mutable run state shared between the lifecycle manager and the orchestrator.
 * The orchestrator owns and reads/writes these fields; the lifecycle manager
 * updates them during agent execution.
 */
export interface AgentRunState {
  /** Durable database fence; a PID is never a substitute for this ownership. */
  executionFence?: ExecutionFence;
  /** Local invocation identity; callbacks from earlier generations must not mutate this run. */
  attemptId?: string;
  runner?: AgentRunner;
  /** Tombstone for a removed slot, including removal before run() was entered. */
  cancelled?: boolean;
  activeProcess: CodingAgentHandle | null;
  lastOutputTime: number;
  lastOutputAtIso?: string;
  outputLog: string[];
  outputLogBytes: number;
  /** Buffer for NDJSON-style agent output so tool-call lifecycle can be parsed across chunk boundaries. */
  outputParseBuffer: string;
  /** Active tool call ids inferred from structured agent output (primarily Cursor/Codex NDJSON). */
  activeToolCallIds: Set<string>;
  /** Best-effort tool summaries keyed by call id (e.g. "npm test"). */
  activeToolCallSummaries: Map<string, string | null>;
  /** Tool call start times for duration metrics. */
  activeToolCallStartedAtMs: Map<string, number>;
  startedAt: string;
  /** First filtered output timestamp for startup latency diagnostics. */
  firstOutputAtIso?: string;
  exitHandled: boolean;
  killedDueToTimeout: boolean;
  lifecycleState: AgentRuntimeState;
  suspendedAtIso?: string;
  suspendReason?: AgentSuspendReason;
  suspendDeadlineMs?: number;
  /** Stop output file tail (used after GUPP recovery); cleared when tail is stopped */
  outputTailStop?: () => void;
  /** Stateful filter for live/persisted output (tool-call and code-context noise removed). */
  outputFilter?: AgentOutputFilter;
}

export interface AgentRunParams {
  projectId: string;
  taskId: string;
  repoPath: string;
  phase: AgentPhase;
  wtPath: string;
  branchName: string;
  promptPath: string;
  agentConfig: AgentConfig;
  attempt: number;
  agentLabel: string;
  /** "coder" uses invokeCodingAgent; "reviewer" uses invokeReviewAgent */
  role: "coder" | "reviewer";
  /** Called when agent exits (normally or via dead-process detection) */
  onDone: (exitCode: number | null) => Promise<void>;
  /** Called when runtime state changes (running <-> suspended). */
  onStateChange?: () => void | Promise<void>;
  /**
   * Override output log path. When multiple agents run in parallel (e.g. angle-specific reviewers),
   * each needs a distinct path to avoid overwriting. Default: .opensprint/active/<taskId>/agent-output.log
   */
  outputLogPath?: string;
  /**
   * Subpath for heartbeat file. When provided, heartbeat is written to
   * .opensprint/active/<taskId>/<subpath>/heartbeat.json. Used for parallel angle reviewers.
   */
  heartbeatSubpath?: string;
  /** Revalidate the owning slot after admission waits and preparation awaits. */
  isStillActive?: () => boolean;
}

/**
 * Manages the common agent execution lifecycle: spawning, output streaming,
 * heartbeat writing, inactivity monitoring, dead-process detection, and
 * cleanup. Eliminates duplication between coding and review phases.
 */
export class AgentLifecycleManager {
  private branchManager = new BranchManager();

  private assertPromptPathMatchesWorktree(
    wtPath: string,
    taskId: string,
    promptPath: string
  ): void {
    const resolvedWorktree = path.resolve(wtPath);
    const resolvedPrompt = path.resolve(promptPath);
    const expectedTaskRoot = path.resolve(resolvedWorktree, OPENSPRINT_PATHS.active, taskId);
    const promptBase = path.basename(resolvedPrompt);
    const insideTaskRoot =
      resolvedPrompt === expectedTaskRoot ||
      resolvedPrompt.startsWith(`${expectedTaskRoot}${path.sep}`);

    if (!insideTaskRoot || promptBase !== "prompt.md") {
      throw new Error(
        `Prompt path does not match task worktree layout: prompt=${resolvedPrompt}, expectedRoot=${expectedTaskRoot}, taskId=${taskId}`
      );
    }
  }

  /**
   * Spawn an agent process with full monitoring (heartbeat + inactivity).
   * The caller's onDone callback is invoked exactly once when the agent
   * finishes (either normally via onExit, or via dead-process detection).
   */
  async run(params: AgentRunParams, runState: AgentRunState, timers: TimerRegistry): Promise<void> {
    return withoutExecutionFence(() => this.runOwned(params, runState, timers));
  }
  private async runOwned(
    params: AgentRunParams,
    runState: AgentRunState,
    timers: TimerRegistry
  ): Promise<void> {
    if (runState.cancelled || params.isStillActive?.() === false) return;
    if (
      runState.activeProcess?.ownership === "recovered_unverified" ||
      runState.runner?.observe().state === "uncertain"
    )
      throw new Error("Unverified recovered execution remains quarantined");
    const {
      projectId,
      taskId,
      phase,
      wtPath,
      branchName,
      promptPath,
      agentConfig,
      agentLabel,
      role,
      onDone,
    } = params;
    this.assertPromptPathMatchesWorktree(wtPath, taskId, promptPath);

    const previousState = runState.runner?.observe().state;
    const previousFence =
      previousState === "completed" || previousState === "stopped"
        ? runState.executionFence
        : undefined;
    const runKey = `${taskId}:${phase}:${params.heartbeatSubpath ?? role}`;
    const supersedes = previousFence?.runKey === runKey ? previousFence : undefined;
    if (previousFence && previousFence.runKey !== runKey)
      await executionOwnershipService.transition(previousFence, "completed");
    runState.runner?.cancel();
    const runner = new AgentRunner(`${taskId}:${phase}:${params.attempt}:${randomUUID()}`);
    runState.runner = runner;
    runState.attemptId = runner.attemptId;
    const ownsRun = () =>
      runState.attemptId === runner.attemptId &&
      !runState.cancelled &&
      params.isStillActive?.() !== false;
    // A queued invocation is cancellable through the same handle used by slot removal.
    runState.activeProcess = { kill: () => runner.cancel(), pid: null };

    runState.killedDueToTimeout = false;
    runState.exitHandled = false;
    // Preserve startedAt if already set (e.g. by phase-executor before spawn) so getActiveAgents shows correct elapsed time from first frame
    runState.startedAt = runState.startedAt || new Date().toISOString();
    runState.outputLog = [];
    runState.outputLogBytes = 0;
    runState.outputParseBuffer = "";
    runState.activeToolCallIds.clear();
    runState.activeToolCallSummaries.clear();
    runState.activeToolCallStartedAtMs.clear();
    runState.outputFilter = createAgentOutputFilter();
    this.setRunningState(runState, Date.now());
    runState.lastOutputAtIso = undefined;
    runState.firstOutputAtIso = undefined;

    const outputLogPath =
      params.outputLogPath ??
      path.join(wtPath, OPENSPRINT_PATHS.active, taskId, OPENSPRINT_PATHS.agentOutputLog);
    const heartbeatSubpath = params.heartbeatSubpath;

    const invoke =
      role === "coder"
        ? agentService.invokeCodingAgent.bind(agentService)
        : agentService.invokeReviewAgent.bind(agentService);

    const executionFence = await executionOwnershipService.acquire({
      projectId,
      taskId,
      runKey,
      attemptId: runner.attemptId,
      leaderGeneration: projectLeadershipService.getFence(projectId)?.generation,
      supersedes,
    });
    if (!executionFence) throw new Error("Another backend owns this execution attempt");
    runState.executionFence = executionFence;
    const stopQueued = async () => {
      if (runState.attemptId === runner.attemptId) timers.clear("executionFence");
      if (ownsRun()) runState.activeProcess = null;
      try {
        if (ownsRun() && runner.notifyCompletionOnCancel)
          await withExecutionFence(executionFence, () => onDone(null));
      } finally {
        await executionOwnershipService.transition(executionFence, "stopped").catch(() => {});
      }
    };
    if (!ownsRun() || runner.controller.signal.aborted) {
      await stopQueued();
      return;
    }
    runner.controller.signal.addEventListener(
      "abort",
      () => {
        fireAndForget(
          executionOwnershipService.transition(executionFence, "stop_requested"),
          "agent-lifecycle:stop-requested"
        );
      },
      { once: true }
    );
    // Queued work is durable and controllable from another backend before FIFO admission.
    timers.setInterval(
      "executionFence",
      () => {
        fireAndForget(
          (async () => {
            if (!(await executionOwnershipService.heartbeat(executionFence))) {
              runner.cancel();
              return;
            }
            const current = (await executionOwnershipService.observe(projectId, taskId)).find(
              (item) => item.attemptId === executionFence.attemptId
            );
            if (current?.state === "stop_requested") runner.cancel(true);
          })().catch((err) => {
            runner.cancel();
            throw err;
          }),
          "agent-lifecycle:execution-fence"
        );
      },
      10_000
    );
    let releaseGlobalSlot: () => void;
    try {
      releaseGlobalSlot = await acquireGlobalAgentSlot(projectId, runner.controller.signal);
    } catch (err) {
      if (runner.controller.signal.aborted) {
        await stopQueued();
        return;
      }
      await stopQueued();
      throw err;
    }
    if (!ownsRun() || runner.controller.signal.aborted || runState.exitHandled) {
      releaseGlobalSlot();
      runner.cancel();
      await stopQueued();
      return;
    }
    const releaseSlotOnce = (() => {
      let done = false;
      return () => {
        if (done) return;
        done = true;
        releaseGlobalSlot();
      };
    })();
    const wrappedOnDone = async (code: number | null) => {
      releaseSlotOnce();
      runner.complete();
      if (!ownsRun() || (runner.controller.signal.aborted && !runner.notifyCompletionOnCancel))
        return;
      {
        await executionOwnershipService.assertCurrent(executionFence);
        try {
          await withExecutionFence(executionFence, () => onDone(code));
        } finally {
          // onDone may synchronously launch the next attempt into this same slot/timer registry.
          if (runState.attemptId === runner.attemptId) {
            await executionOwnershipService.transition(
              executionFence,
              runner.controller.signal.aborted ? "stopped" : "completed"
            );
            timers.clear("executionFence");
          }
        }
      }
    };
    try {
      const fence = executionFence;
      if (!ownsRun() || runner.controller.signal.aborted) {
        await executionOwnershipService.transition(fence, "stopped");
        releaseSlotOnce();
        return;
      }
      await executionOwnershipService.transition(fence, "running");
      // Admission and every awaited preparation may race with cancellation or a lease takeover.
      await executionOwnershipService.assertCurrent(fence);
      if (!ownsRun() || runner.controller.signal.aborted) {
        await executionOwnershipService.transition(fence, "stopped");
        releaseSlotOnce();
        return;
      }
      let outputPersistence = Promise.resolve();
      broadcastToProject(projectId, {
        type: "agent.started",
        taskId,
        phase,
        branchName,
        startedAt: runState.startedAt,
      });
      const handle = await executionOwnershipService.launch(fence, () =>
        runner.start(() =>
          invoke(promptPath, agentConfig, {
            cwd: wtPath,
            agentRole: role === "coder" ? "coder" : "code reviewer",
            outputLogPath,
            projectId,
            executionFence: fence,
            tracking: {
              id: taskId,
              projectId,
              phase,
              role,
              label: agentLabel,
              branchName,
              attempt: params.attempt,
              attemptId: runner.attemptId,
            },
            onOutput: (chunk: string) => {
              if (!ownsRun() || runner.controller.signal.aborted || runState.exitHandled) return;
              const toolEvents = updateToolCallState(runState, chunk);
              this.recordToolActivity(params, toolEvents);
              const filtered = runState.outputFilter!.filter(chunk);
              if (filtered) appendOutputLog(runState, filtered);
              if (filtered) {
                outputPersistence = outputPersistence
                  .then(async () => {
                    await executionOutputService.append(fence, filtered);
                    if (ownsRun()) sendAgentOutputToProject(projectId, taskId, filtered);
                  })
                  .catch((err) =>
                    log.warn("Attempt output rejected", { taskId, attemptId: fence.attemptId, err })
                  );
              }
              void this.recordOutputActivity(params, runState, Date.now());
            },
            onUncertain: (reason: string) => {
              if (!ownsRun()) return;
              runner.markUncertain();
              log.warn("Execution quarantined after uncertain container observation", {
                taskId,
                attemptId: fence.attemptId,
                reason,
              });
              void executionOwnershipService.transition(fence, "uncertain").catch(() => {});
              void params.onStateChange?.();
            },
            onExit: async (code: number | null) => {
              releaseSlotOnce();
              runner.complete();
              await outputPersistence;
              if (
                runner.controller.signal.aborted &&
                (!ownsRun() || !runner.notifyCompletionOnCancel)
              ) {
                await executionOwnershipService.transition(fence, "stopped").catch(() => {});
                if (runState.attemptId === runner.attemptId) timers.clear("executionFence");
              }
              if (!ownsRun() || runState.exitHandled) return;
              runState.exitHandled = true;
              runState.activeProcess = null;
              this.cleanupTimers(timers);
              if (runner.controller.signal.aborted && !runner.notifyCompletionOnCancel) return;
              const startedAtMs = Date.parse(runState.startedAt ?? "");
              const durationMs = Number.isFinite(startedAtMs)
                ? Math.max(0, Date.now() - startedAtMs)
                : null;
              fireAndForget(
                eventLogService.append(params.repoPath, {
                  timestamp: new Date().toISOString(),
                  projectId: params.projectId,
                  taskId: params.taskId,
                  event: "agent.process_exited",
                  data: {
                    attempt: params.attempt,
                    phase: params.phase,
                    exitCode: code,
                    durationMs,
                  },
                }),
                "agent-lifecycle:process-exited"
              );
              await heartbeatService.deleteHeartbeat(wtPath, taskId, params.heartbeatSubpath);
              try {
                await wrappedOnDone(code);
              } catch (err) {
                log.error("onDone failed", {
                  projectId: params.projectId,
                  taskId,
                  phase: params.phase,
                  attempt: params.attempt,
                  exitCode: code,
                  err,
                });
              }
            },
          })
        )
      );
      if (!handle || !ownsRun() || runState.exitHandled) {
        releaseSlotOnce();
        if (!handle && runner.observe().state === "stopped") {
          await executionOwnershipService.transition(fence, "stopped").catch(() => {});
          if (runState.attemptId === runner.attemptId) timers.clear("executionFence");
        }
        return;
      }
      // Keep cancellation attached to admission ownership after the real handle exists.
      runState.activeProcess = {
        kill: () => handle.kill(),
        get pid() {
          return handle.pid;
        },
        pendingMessages: handle.pendingMessages,
      };

      this.startHeartbeat(runState, wtPath, taskId, timers, heartbeatSubpath);
      this.startResultMonitor(
        params,
        promptPath,
        runState,
        wtPath,
        taskId,
        timers,
        wrappedOnDone,
        heartbeatSubpath
      );
      this.startInactivityMonitor(
        runState,
        wtPath,
        taskId,
        branchName,
        timers,
        wrappedOnDone,
        params,
        heartbeatSubpath
      );
    } catch (err) {
      releaseSlotOnce();
      runner.complete();
      if (ownsRun()) runState.activeProcess = null;
      if (executionFence)
        await executionOwnershipService.transition(executionFence, "stopped").catch(() => {});
      if (runState.attemptId === runner.attemptId) timers.clear("executionFence");
      throw err;
    }
  }

  /**
   * Re-attach to an existing agent process after backend restart (GUPP recovery).
   * Sets runState.activeProcess to the handle, starts heartbeat + inactivity monitoring,
   * and tails the agent output file so live output continues to stream to subscribed clients.
   * When the process exits (detected via isPidAlive), onDone is invoked and the tail is stopped.
   */
  async resumeMonitoring(
    handle: CodingAgentHandle,
    params: AgentRunParams,
    runState: AgentRunState,
    timers: TimerRegistry,
    options?: {
      initialSuspendReason?: AgentSuspendReason;
      recoveredLastOutputTimeMs?: number;
    }
  ): Promise<void> {
    if (runState.cancelled || params.isStillActive?.() === false) return;
    const { projectId, wtPath, taskId, branchName, onDone, agentConfig } = params;
    this.assertPromptPathMatchesWorktree(wtPath, taskId, params.promptPath);
    runState.runner?.cancel();
    const runner = new AgentRunner(`${taskId}:${params.phase}:${params.attempt}:${randomUUID()}`);
    runner.start(() => handle);
    if (handle.ownership === "recovered_unverified") runner.markUncertain();
    runState.runner = runner;
    runState.attemptId = runner.attemptId;
    runState.activeProcess = handle;
    const releaseGlobalSlot = trackExistingGlobalAgentSlot(projectId);
    if (handle.pendingMessages) {
      activeAgentsService.registerChannel(taskId, handle.pendingMessages, agentConfig.type, {
        projectId,
        attempt: params.attempt,
        attemptId: runner.attemptId,
      });
    }
    runState.outputLog = [];
    runState.outputLogBytes = 0;
    runState.outputParseBuffer = "";
    runState.activeToolCallIds.clear();
    runState.activeToolCallSummaries.clear();
    runState.activeToolCallStartedAtMs.clear();
    runState.outputFilter = createAgentOutputFilter();
    runState.exitHandled = false;
    runState.killedDueToTimeout = false;
    runState.lifecycleState = "running";
    runState.suspendedAtIso = undefined;
    runState.suspendReason = undefined;
    runState.suspendDeadlineMs = undefined;
    runState.firstOutputAtIso = undefined;

    let monitoringInstalled = false;
    try {
      const outputLogPath =
        params.outputLogPath ??
        path.join(wtPath, OPENSPRINT_PATHS.active, taskId, OPENSPRINT_PATHS.agentOutputLog);
      await this.primeRecoveredRunState(
        outputLogPath,
        runState,
        options?.recoveredLastOutputTimeMs,
        () => runState.attemptId === runner.attemptId && !runner.controller.signal.aborted
      );
      if (runState.attemptId !== runner.attemptId || runner.controller.signal.aborted) return;
      const outputTailStop = this.startOutputTail(
        outputLogPath,
        params,
        runState,
        projectId,
        taskId,
        timers
      );
      runState.outputTailStop = outputTailStop;

      const wrappedOnDone = async (code: number | null) => {
        releaseGlobalSlot();
        runner.complete();
        if (runState.attemptId !== runner.attemptId || runner.controller.signal.aborted) return;
        runState.outputTailStop?.();
        runState.outputTailStop = undefined;
        if (handle.pendingMessages) {
          activeAgentsService.unregister(taskId, runner.attemptId);
        }
        await onDone(code);
      };

      this.startHeartbeat(runState, wtPath, taskId, timers);
      if (handle.ownership !== "recovered_unverified")
        this.startResultMonitor(
          params,
          params.promptPath,
          runState,
          wtPath,
          taskId,
          timers,
          wrappedOnDone
        );
      this.startInactivityMonitor(
        runState,
        wtPath,
        taskId,
        branchName,
        timers,
        wrappedOnDone,
        params
      );
      monitoringInstalled = true;
      if (options?.initialSuspendReason) {
        await this.markSuspended(params, runState, options.initialSuspendReason);
      }
    } finally {
      // Recovery only owns this admission after it installs completion monitoring.
      // Cancellation, replacement, and initialization errors must not leak a slot.
      if (!monitoringInstalled) releaseGlobalSlot();
    }
  }

  async markSuspended(
    params: AgentRunParams,
    runState: AgentRunState,
    reason: AgentSuspendReason
  ): Promise<void> {
    if (runState.lifecycleState === "suspended" && runState.suspendReason === reason) {
      return;
    }
    const now = Date.now();
    const suspendedAtIso = new Date(now).toISOString();
    runState.lifecycleState = "suspended";
    runState.suspendedAtIso = suspendedAtIso;
    runState.suspendReason = reason;
    runState.suspendDeadlineMs = now + AGENT_SUSPEND_GRACE_MS;
    const summary = describeSuspendReason(reason);

    fireAndForget(
      eventLogService.append(params.repoPath, {
        timestamp: suspendedAtIso,
        projectId: params.projectId,
        taskId: params.taskId,
        event: "agent.suspended",
        data: {
          attempt: params.attempt,
          phase: params.phase,
          reason,
          summary,
        },
      }),
      "agent-lifecycle:agent-suspended"
    );

    broadcastToProject(params.projectId, {
      type: "agent.activity",
      taskId: params.taskId,
      phase: params.phase,
      activity: "suspended",
      summary,
    });
    await params.onStateChange?.();
  }

  private startResultMonitor(
    params: AgentRunParams,
    promptPath: string,
    runState: AgentRunState,
    wtPath: string,
    taskId: string,
    timers: TimerRegistry,
    onDone: (exitCode: number | null) => Promise<void>,
    heartbeatSubpath?: string
  ): void {
    const resultPath = path.join(path.dirname(promptPath), "result.json");
    let checkInFlight = false;
    let terminationRequested = false;
    const attemptId = runState.attemptId;

    timers.setInterval(
      "result",
      () => {
        if (
          runState.attemptId !== attemptId ||
          runState.runner?.controller.signal.aborted ||
          runState.exitHandled ||
          checkInFlight
        )
          return;
        checkInFlight = true;
        fs.readFile(resultPath, "utf-8")
          .then(async (raw) => {
            const parsed = JSON.parse(raw) as { status?: string };
            const status = typeof parsed?.status === "string" ? parsed.status.toLowerCase() : "";
            if (
              !RESULT_TERMINAL_STATUSES.has(status) ||
              runState.exitHandled ||
              runState.attemptId !== attemptId ||
              runState.runner?.controller.signal.aborted
            )
              return;

            if (
              runState.activeProcess?.ownership === "recovered_unverified" ||
              runState.runner?.observe().state === "uncertain"
            )
              return;
            if (runState.executionFence)
              await executionOwnershipService.assertCurrent(runState.executionFence);
            if (runState.attemptId !== attemptId || runState.runner?.controller.signal.aborted)
              return;

            const exitCode = status === "success" || status === "approved" ? 0 : 1;
            const activeProcess = runState.activeProcess;
            if (activeProcess && (activeProcess.pid == null || isPidAlive(activeProcess.pid))) {
              if (!terminationRequested) {
                terminationRequested = true;
                if (runState.executionFence)
                  await executionOwnershipService.transition(
                    runState.executionFence,
                    "stop_requested"
                  );
                activeProcess.kill();
              }
              return;
            }
            runState.exitHandled = true;
            runState.activeProcess = null;
            this.cleanupTimers(timers);
            log.info("Terminal result.json detected by lifecycle monitor", {
              taskId,
              resultPath,
              status,
            });
            const startedAtMs = Date.parse(runState.startedAt ?? "");
            const durationMs = Number.isFinite(startedAtMs)
              ? Math.max(0, Date.now() - startedAtMs)
              : null;
            fireAndForget(
              eventLogService.append(params.repoPath, {
                timestamp: new Date().toISOString(),
                projectId: params.projectId,
                taskId: params.taskId,
                event: "agent.result_detected",
                data: {
                  attempt: params.attempt,
                  phase: params.phase,
                  status,
                  durationMs,
                  resultPath,
                },
              }),
              "agent-lifecycle:result-detected"
            );
            await heartbeatService
              .deleteHeartbeat(wtPath, taskId, heartbeatSubpath)
              .catch((err: unknown) => {
                log.warn("heartbeat delete failed", {
                  err: err instanceof Error ? err.message : String(err),
                });
              });
            await onDone(exitCode);
          })
          .catch(() => {
            // Missing result, invalid JSON, or missing terminal status — keep polling.
          })
          .finally(() => {
            checkInFlight = false;
          });
      },
      RESULT_POLL_MS
    );
  }

  /**
   * Tail the agent output file and stream new bytes to WebSocket clients and runState.
   * Used after GUPP recovery when we re-attach to a running process (no spawn, so no pipe).
   * Returns a stop function that clears the poll and performs one final drain.
   */
  private startOutputTail(
    outputLogPath: string,
    params: AgentRunParams,
    runState: AgentRunState,
    projectId: string,
    taskId: string,
    timers: TimerRegistry
  ): () => void {
    let readOffset = 0;
    let initialized = false;
    const TAIL_TIMER_NAME = "outputTail";
    const MAX_CHUNK = 256 * 1024;
    const attemptId = runState.attemptId;
    const ownsRun = () =>
      runState.attemptId === attemptId && !runState.runner?.controller.signal.aborted;

    const drain = async (): Promise<void> => {
      try {
        if (!ownsRun()) return;
        const s = await fs.stat(outputLogPath);
        if (!initialized) {
          readOffset = s.size;
          initialized = true;
          return;
        }
        if (s.size <= readOffset) return;
        const toRead = Math.min(s.size - readOffset, MAX_CHUNK);
        const fh = await fs.open(outputLogPath, "r");
        try {
          const buf = Buffer.alloc(toRead);
          const { bytesRead } = await fh.read(buf, 0, toRead, readOffset);
          if (bytesRead > 0 && ownsRun()) {
            readOffset += bytesRead;
            const chunk = buf.subarray(0, bytesRead).toString();
            const toolEvents = updateToolCallState(runState, chunk);
            this.recordToolActivity(params, toolEvents);
            const filtered = runState.outputFilter!.filter(chunk);
            if (filtered) appendOutputLog(runState, filtered);
            if (filtered) sendAgentOutputToProject(projectId, taskId, filtered);
            void this.recordOutputActivity(params, runState, s.mtimeMs || Date.now());
          }
        } finally {
          await fh.close();
        }
      } catch {
        // File may not exist yet or transient I/O error
      }
    };

    timers.setInterval(
      TAIL_TIMER_NAME,
      () => {
        fireAndForget(drain(), "agent-lifecycle:output-drain");
      },
      OUTPUT_POLL_MS
    );
    setImmediate(() => fireAndForget(drain(), "agent-lifecycle:output-drain"));

    return () => {
      timers.clear(TAIL_TIMER_NAME);
      fireAndForget(drain(), "agent-lifecycle:output-drain");
    };
  }

  private startHeartbeat(
    runState: AgentRunState,
    wtPath: string,
    taskId: string,
    timers: TimerRegistry,
    heartbeatSubpath?: string
  ): void {
    const attemptId = runState.attemptId;
    const writeHeartbeat = () => {
      if (
        runState.attemptId !== attemptId ||
        runState.runner?.controller.signal.aborted ||
        !runState.activeProcess
      )
        return;
      fireAndForget(
        heartbeatService.writeHeartbeat(
          wtPath,
          taskId,
          {
            // Execute agents run detached, so the child PID is the process-group leader.
            processGroupLeaderPid: runState.activeProcess.pid ?? 0,
            lastOutputTimestamp: runState.lastOutputTime,
            heartbeatTimestamp: Date.now(),
          },
          heartbeatSubpath
        ),
        "agent-lifecycle:heartbeat-write"
      );
    };

    // Emit a heartbeat immediately so recovery does not treat freshly spawned
    // slots as dead before the first interval tick.
    writeHeartbeat();

    timers.setInterval("heartbeat", writeHeartbeat, HEARTBEAT_INTERVAL_MS);
  }

  private startInactivityMonitor(
    runState: AgentRunState,
    wtPath: string,
    taskId: string,
    branchName: string,
    timers: TimerRegistry,
    onDone: (exitCode: number | null) => Promise<void>,
    params?: AgentRunParams,
    heartbeatSubpath?: string
  ): void {
    const attemptId = runState.attemptId;
    timers.setInterval(
      "inactivity",
      () => {
        if (
          runState.attemptId !== attemptId ||
          runState.runner?.controller.signal.aborted ||
          runState.exitHandled
        )
          return;
        const elapsed = Date.now() - runState.lastOutputTime;
        const hasActiveToolCalls = runState.activeToolCallIds.size > 0;
        const effectiveTimeout = hasActiveToolCalls
          ? ACTIVE_TOOL_CALL_TIMEOUT_MS
          : AGENT_INACTIVITY_TIMEOUT_MS;
        const proc = runState.activeProcess;
        // A disappeared PID is still not proof that this backend owned that process or its result.
        if (
          proc?.ownership === "recovered_unverified" ||
          runState.runner?.observe().state === "uncertain"
        )
          return;
        const pidDead = proc && proc.pid !== null && !isPidAlive(proc.pid);

        if (pidDead) {
          if (runState.exitHandled) return;
          runState.exitHandled = true;
          log.warn("Agent process dead, recovering immediately", {
            projectId: params?.projectId,
            taskId,
            phase: params?.phase,
            attempt: params?.attempt,
            pid: proc.pid,
          });
          if (params) {
            fireAndForget(
              eventLogService.append(params.repoPath, {
                timestamp: new Date().toISOString(),
                projectId: params.projectId,
                taskId,
                event: "agent.process_dead",
                data: {
                  attempt: params.attempt,
                  phase: params.phase,
                  pid: proc.pid,
                },
              }),
              "agent-lifecycle:process-dead"
            );
          }
          runState.activeProcess = null;
          this.cleanupTimers(timers);
          fireAndForget(
            heartbeatService.deleteHeartbeat(wtPath, taskId, heartbeatSubpath),
            "agent-lifecycle:heartbeat-delete"
          );
          this.branchManager
            .commitWip(wtPath, taskId)
            .then(() => onDone(null))
            .catch((err) => {
              log.error("Post-death handler failed", {
                projectId: params?.projectId,
                taskId,
                phase: params?.phase,
                attempt: params?.attempt,
                err,
              });
              return onDone(null);
            })
            .catch((err) => {
              log.error("onDone fallback also failed", {
                projectId: params?.projectId,
                taskId,
                phase: params?.phase,
                err,
              });
            });
          return;
        }

        if (elapsed > effectiveTimeout) {
          if (hasActiveToolCalls) {
            if (runState.lifecycleState === "suspended") {
              const previousReason = runState.suspendReason;
              runState.lifecycleState = "running";
              runState.suspendedAtIso = undefined;
              runState.suspendReason = undefined;
              runState.suspendDeadlineMs = undefined;
              const summary = "Agent is waiting on an active tool call";

              if (params) {
                fireAndForget(
                  eventLogService.append(params.repoPath, {
                    timestamp: new Date().toISOString(),
                    projectId: params.projectId,
                    taskId,
                    event: "agent.resumed",
                    data: {
                      attempt: params.attempt,
                      phase: params.phase,
                      reason: previousReason ?? "output_gap",
                      summary,
                    },
                  }),
                  "agent-lifecycle:agent-resumed"
                );
                broadcastToProject(params.projectId, {
                  type: "agent.activity",
                  taskId: params.taskId,
                  phase: params.phase,
                  activity: "resumed",
                  summary,
                });
                void params.onStateChange?.();
              }
            }
          }

          const suspendThresholdMs = effectiveTimeout + SUSPEND_TRANSITION_DELAY_MS;
          if (elapsed <= suspendThresholdMs) {
            return;
          }
          const beyondSuspendGrace = elapsed > AGENT_SUSPEND_GRACE_MS;
          if (!beyondSuspendGrace && runState.lifecycleState !== "suspended" && params) {
            log.warn("Agent suspended due to inactivity", {
              projectId: params?.projectId,
              taskId,
              phase: params?.phase,
              attempt: params?.attempt,
              elapsedMs: elapsed,
              effectiveTimeoutMs: effectiveTimeout,
              suspendTransitionDelayMs: SUSPEND_TRANSITION_DELAY_MS,
              activeToolCallCount: runState.activeToolCallIds.size,
            });
            void this.markSuspended(params, runState, "output_gap");
            return;
          }
          if (
            runState.lifecycleState === "suspended" &&
            runState.suspendDeadlineMs != null &&
            Date.now() < runState.suspendDeadlineMs
          ) {
            return;
          }
          log.warn("Agent timeout", {
            projectId: params?.projectId,
            taskId,
            phase: params?.phase,
            attempt: params?.attempt,
            elapsedMs: elapsed,
            effectiveTimeoutMs: effectiveTimeout,
            activeToolCallCount: runState.activeToolCallIds.size,
            suspendedAtIso: runState.suspendedAtIso,
          });
          if (runState.activeProcess) {
            runState.killedDueToTimeout = true;
            this.branchManager
              .commitWip(wtPath, taskId)
              .then(() => {
                if (runState.attemptId === attemptId && runState.activeProcess === proc)
                  proc?.kill();
              })
              .catch((err) => {
                log.error("Inactivity handler failed", {
                  projectId: params?.projectId,
                  taskId,
                  phase: params?.phase,
                  err,
                });
                if (runState.attemptId === attemptId && runState.activeProcess === proc)
                  proc?.kill();
              });
          }
        }
      },
      30000
    );
  }

  private cleanupTimers(timers: TimerRegistry): void {
    timers.clear("heartbeat");
    timers.clear("inactivity");
    timers.clear("result");
  }

  private setRunningState(runState: AgentRunState, atMs: number): void {
    runState.lastOutputTime = atMs;
    runState.lastOutputAtIso = new Date(atMs).toISOString();
    runState.lifecycleState = "running";
    runState.suspendedAtIso = undefined;
    runState.suspendReason = undefined;
    runState.suspendDeadlineMs = undefined;
  }

  private async recordOutputActivity(
    params: AgentRunParams,
    runState: AgentRunState,
    atMs: number
  ): Promise<void> {
    if (!runState.firstOutputAtIso) {
      runState.firstOutputAtIso = new Date(atMs).toISOString();
      const startedAtMs = Date.parse(runState.startedAt ?? "");
      const startupDurationMs = Number.isFinite(startedAtMs)
        ? Math.max(0, atMs - startedAtMs)
        : null;
      fireAndForget(
        eventLogService.append(params.repoPath, {
          timestamp: runState.firstOutputAtIso,
          projectId: params.projectId,
          taskId: params.taskId,
          event: "agent.first_output",
          data: {
            attempt: params.attempt,
            phase: params.phase,
            startupDurationMs,
          },
        }),
        "agent-lifecycle:first-output"
      );
    }
    const previousReason = runState.suspendReason;
    const wasSuspended = runState.lifecycleState === "suspended";
    this.setRunningState(runState, atMs);
    if (!wasSuspended) return;
    const summary = describeResumeReason(previousReason);

    fireAndForget(
      eventLogService.append(params.repoPath, {
        timestamp: new Date(atMs).toISOString(),
        projectId: params.projectId,
        taskId: params.taskId,
        event: "agent.resumed",
        data: {
          attempt: params.attempt,
          phase: params.phase,
          reason: previousReason ?? "output_gap",
          summary,
        },
      }),
      "agent-lifecycle:agent-resumed"
    );

    broadcastToProject(params.projectId, {
      type: "agent.activity",
      taskId: params.taskId,
      phase: params.phase,
      activity: "resumed",
      summary,
    });
    await params.onStateChange?.();
  }

  private async primeRecoveredRunState(
    outputLogPath: string,
    runState: AgentRunState,
    fallbackLastOutputTimeMs?: number,
    ownsRun: () => boolean = () => true
  ): Promise<void> {
    let primedTime = fallbackLastOutputTimeMs ?? Date.now();
    try {
      const stat = await fs.stat(outputLogPath);
      primedTime = Math.max(primedTime, stat.mtimeMs || 0);
      if (stat.size > 0) {
        const start = Math.max(0, stat.size - RECOVERY_TAIL_BYTES);
        const fh = await fs.open(outputLogPath, "r");
        try {
          const buf = Buffer.alloc(stat.size - start);
          const { bytesRead } = await fh.read(buf, 0, buf.length, start);
          if (bytesRead > 0 && ownsRun()) {
            updateToolCallState(runState, buf.subarray(0, bytesRead).toString());
          }
        } finally {
          await fh.close();
        }
      }
    } catch {
      // File may not exist yet; fall back to heartbeat timestamp when available.
    }
    if (ownsRun()) this.setRunningState(runState, primedTime);
  }

  private recordToolActivity(params: AgentRunParams, toolEvents: ToolCallLifecycleEvent[]): void {
    if (toolEvents.length === 0) return;

    for (const event of toolEvents) {
      const summary = formatToolSummary(event.summary);
      const logEvent = event.kind === "started" ? "agent.waiting_on_tool" : "agent.tool_completed";
      fireAndForget(
        eventLogService.append(params.repoPath, {
          timestamp: new Date().toISOString(),
          projectId: params.projectId,
          taskId: params.taskId,
          event: logEvent,
          data: {
            attempt: params.attempt,
            phase: params.phase,
            toolCallId: event.callId,
            summary,
            toolStatus: event.toolStatus,
            durationMs: event.durationMs,
          },
        }),
        "agent-lifecycle:tool-activity"
      );

      broadcastToProject(params.projectId, {
        type: "agent.activity",
        taskId: params.taskId,
        phase: params.phase,
        activity: event.kind === "started" ? "waiting_on_tool" : "tool_completed",
        ...(event.kind === "completed" ? { toolStatus: event.toolStatus } : {}),
        ...(summary ? { summary } : {}),
      });
    }
  }
}

/** Append a chunk to outputLog, evicting oldest entries when the size cap is exceeded. */
function appendOutputLog(state: AgentRunState, chunk: string): void {
  state.outputLog.push(chunk);
  state.outputLogBytes += chunk.length;
  while (state.outputLogBytes > MAX_OUTPUT_LOG_BYTES && state.outputLog.length > 1) {
    const dropped = state.outputLog.shift()!;
    state.outputLogBytes -= dropped.length;
  }
}

interface ToolCallLifecycleEvent {
  kind: "started" | "completed";
  callId: string;
  summary: string | null;
  toolStatus: "started" | "completed" | "failed" | "cancelled";
  durationMs: number | null;
}

function updateToolCallState(state: AgentRunState, chunk: string): ToolCallLifecycleEvent[] {
  state.outputParseBuffer += chunk;
  const lines = state.outputParseBuffer.split("\n");
  state.outputParseBuffer = lines.pop() ?? "";
  const toolEvents: ToolCallLifecycleEvent[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    try {
      const parsed = JSON.parse(trimmed) as {
        type?: string;
        subtype?: string;
        call_id?: string;
        tool_call?: Record<string, unknown>;
      };
      if (parsed.type !== "tool_call" || typeof parsed.call_id !== "string") continue;

      const summary = extractToolCallSummary(parsed.tool_call);

      if (parsed.subtype === "started") {
        state.activeToolCallIds.add(parsed.call_id);
        state.activeToolCallSummaries.set(parsed.call_id, summary);
        state.activeToolCallStartedAtMs.set(parsed.call_id, Date.now());
        toolEvents.push({
          kind: "started",
          callId: parsed.call_id,
          summary,
          toolStatus: "started",
          durationMs: null,
        });
      } else if (
        parsed.subtype === "completed" ||
        parsed.subtype === "failed" ||
        parsed.subtype === "cancelled"
      ) {
        state.activeToolCallIds.delete(parsed.call_id);
        const knownSummary = summary ?? state.activeToolCallSummaries.get(parsed.call_id) ?? null;
        const startedAtMs = state.activeToolCallStartedAtMs.get(parsed.call_id) ?? null;
        const durationMs =
          startedAtMs != null && Number.isFinite(startedAtMs)
            ? Math.max(0, Date.now() - startedAtMs)
            : null;
        state.activeToolCallSummaries.delete(parsed.call_id);
        state.activeToolCallStartedAtMs.delete(parsed.call_id);
        toolEvents.push({
          kind: "completed",
          callId: parsed.call_id,
          summary: knownSummary,
          toolStatus:
            parsed.subtype === "failed"
              ? "failed"
              : parsed.subtype === "cancelled"
                ? "cancelled"
                : "completed",
          durationMs,
        });
      }
    } catch {
      // Non-JSON or partial JSON lines are normal for non-Cursor agents; ignore.
    }
  }

  return toolEvents;
}

function extractToolCallSummary(toolCall: Record<string, unknown> | undefined): string | null {
  if (!toolCall || typeof toolCall !== "object") return null;

  const shellToolCall =
    "shellToolCall" in toolCall &&
    toolCall.shellToolCall &&
    typeof toolCall.shellToolCall === "object"
      ? (toolCall.shellToolCall as Record<string, unknown>)
      : null;
  const shellArgs =
    shellToolCall?.args && typeof shellToolCall.args === "object"
      ? (shellToolCall.args as Record<string, unknown>)
      : null;
  if (typeof shellArgs?.command === "string" && shellArgs.command.trim()) {
    return shellArgs.command.trim();
  }

  const toolName = Object.keys(toolCall).find(Boolean);
  return toolName ?? null;
}

function formatToolSummary(summary: string | null): string | undefined {
  if (!summary) return undefined;
  return summary.length > 160 ? `${summary.slice(0, 157)}...` : summary;
}

function describeSuspendReason(reason: AgentSuspendReason): string {
  switch (reason) {
    case "heartbeat_gap":
      return "Heartbeat gap after host sleep or backend pause";
    case "backend_restart":
      return "Backend restarted while agent was still running";
    case "output_gap":
    default:
      return "No agent output within inactivity window";
  }
}

function describeResumeReason(reason?: AgentSuspendReason): string {
  switch (reason) {
    case "heartbeat_gap":
      return "Agent output resumed after reconnect";
    case "backend_restart":
      return "Monitoring resumed after backend restart";
    case "output_gap":
    default:
      return "Agent output resumed";
  }
}
