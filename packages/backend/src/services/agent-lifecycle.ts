import fs from "fs/promises";
import path from "path";
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
import { agentService } from "./agent.service.js";
import type { CodingAgentHandle } from "./agent.service.js";
import { heartbeatService } from "./heartbeat.service.js";
import { BranchManager } from "./branch-manager.js";
import { eventLogService } from "./event-log.service.js";
import { broadcastToProject, sendAgentOutputToProject } from "../websocket/index.js";
import { TimerRegistry } from "./timer-registry.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("agent-lifecycle");

/** Poll interval for tailing agent output file after GUPP recovery (must match agent-client for consistency) */
const OUTPUT_POLL_MS = 150;
/** Allow long-running shell/tool execution (e.g. npm test) to finish and report back before inactivity kills the agent. */
const ACTIVE_TOOL_CALL_TIMEOUT_MS = 15 * 60 * 1000;
const RECOVERY_TAIL_BYTES = 256 * 1024;

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
  startedAt: string;
  exitHandled: boolean;
  killedDueToTimeout: boolean;
  lifecycleState: AgentRuntimeState;
  suspendedAtIso?: string;
  suspendReason?: AgentSuspendReason;
  suspendDeadlineMs?: number;
  /** Stop output file tail (used after GUPP recovery); cleared when tail is stopped */
  outputTailStop?: () => void;
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
}

/**
 * Manages the common agent execution lifecycle: spawning, output streaming,
 * heartbeat writing, inactivity monitoring, dead-process detection, and
 * cleanup. Eliminates duplication between coding and review phases.
 */
export class AgentLifecycleManager {
  private branchManager = new BranchManager();

  /**
   * Spawn an agent process with full monitoring (heartbeat + inactivity).
   * The caller's onDone callback is invoked exactly once when the agent
   * finishes (either normally via onExit, or via dead-process detection).
   */
  run(params: AgentRunParams, runState: AgentRunState, timers: TimerRegistry): void {
    const {
      projectId,
      taskId,
      phase,
      wtPath,
      branchName,
      promptPath,
      agentConfig,
      agentLabel: _agentLabel,
      role,
      onDone,
    } = params;

    runState.killedDueToTimeout = false;
    runState.exitHandled = false;
    // Preserve startedAt if already set (e.g. by phase-executor before spawn) so getActiveAgents shows correct elapsed time from first frame
    runState.startedAt = runState.startedAt || new Date().toISOString();
    runState.outputLog = [];
    runState.outputLogBytes = 0;
    runState.outputParseBuffer = "";
    runState.activeToolCallIds.clear();
    runState.activeToolCallSummaries.clear();
    this.setRunningState(runState, Date.now());
    runState.lastOutputAtIso = undefined;

    const outputLogPath = path.join(
      wtPath,
      OPENSPRINT_PATHS.active,
      taskId,
      OPENSPRINT_PATHS.agentOutputLog
    );

    broadcastToProject(projectId, {
      type: "agent.started",
      taskId,
      phase,
      branchName,
      startedAt: runState.startedAt,
    });

    const invoke =
      role === "coder"
        ? agentService.invokeCodingAgent.bind(agentService)
        : agentService.invokeReviewAgent.bind(agentService);

    runState.activeProcess = invoke(promptPath, agentConfig, {
      cwd: wtPath,
      agentRole: role === "coder" ? "coder" : "code reviewer",
      outputLogPath,
      projectId,
      onOutput: (chunk: string) => {
        const toolEvents = ingestOutputChunk(runState, chunk);
        this.recordToolActivity(params, toolEvents);
        void this.recordOutputActivity(params, runState, Date.now());
        sendAgentOutputToProject(projectId, taskId, chunk);
      },
      onExit: async (code: number | null) => {
        if (runState.exitHandled) return;
        runState.exitHandled = true;
        runState.activeProcess = null;
        this.cleanupTimers(timers);
        await heartbeatService.deleteHeartbeat(wtPath, taskId);
        try {
          await onDone(code);
        } catch (err) {
          log.error("onDone failed", { taskId, exitCode: code, err });
        }
      },
    });

    this.startHeartbeat(runState, wtPath, taskId, timers);
    this.startInactivityMonitor(runState, wtPath, taskId, branchName, timers, onDone, params);
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
    const { projectId, wtPath, taskId, branchName, onDone } = params;
    runState.activeProcess = handle;
    runState.outputLog = [];
    runState.outputLogBytes = 0;
    runState.outputParseBuffer = "";
    runState.activeToolCallIds.clear();
    runState.activeToolCallSummaries.clear();
    runState.exitHandled = false;
    runState.killedDueToTimeout = false;
    runState.lifecycleState = "running";
    runState.suspendedAtIso = undefined;
    runState.suspendReason = undefined;
    runState.suspendDeadlineMs = undefined;

    const outputLogPath = path.join(
      wtPath,
      OPENSPRINT_PATHS.active,
      taskId,
      OPENSPRINT_PATHS.agentOutputLog
    );
    await this.primeRecoveredRunState(outputLogPath, runState, options?.recoveredLastOutputTimeMs);
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
      runState.outputTailStop?.();
      runState.outputTailStop = undefined;
      await onDone(code);
    };

    this.startHeartbeat(runState, wtPath, taskId, timers);
    this.startInactivityMonitor(
      runState,
      wtPath,
      taskId,
      branchName,
      timers,
      wrappedOnDone,
      params
    );
    if (options?.initialSuspendReason) {
      await this.markSuspended(params, runState, options.initialSuspendReason);
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

    eventLogService
      .append(params.repoPath, {
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
      })
      .catch(() => {});

    broadcastToProject(params.projectId, {
      type: "agent.activity",
      taskId: params.taskId,
      phase: params.phase,
      activity: "suspended",
      summary,
    });
    await params.onStateChange?.();
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

    const drain = async (): Promise<void> => {
      try {
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
          if (bytesRead > 0) {
            readOffset += bytesRead;
            const chunk = buf.subarray(0, bytesRead).toString();
            const toolEvents = ingestOutputChunk(runState, chunk);
            this.recordToolActivity(params, toolEvents);
            void this.recordOutputActivity(params, runState, s.mtimeMs || Date.now());
            sendAgentOutputToProject(projectId, taskId, chunk);
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
        drain().catch(() => {});
      },
      OUTPUT_POLL_MS
    );
    setImmediate(() => drain().catch(() => {}));

    return () => {
      timers.clear(TAIL_TIMER_NAME);
      drain().catch(() => {});
    };
  }

  private startHeartbeat(
    runState: AgentRunState,
    wtPath: string,
    taskId: string,
    timers: TimerRegistry
  ): void {
    timers.setInterval(
      "heartbeat",
      () => {
        if (!runState.activeProcess) return;
        heartbeatService
          .writeHeartbeat(wtPath, taskId, {
            // Execute agents run detached, so the child PID is the process-group leader.
            processGroupLeaderPid: runState.activeProcess.pid ?? 0,
            lastOutputTimestamp: runState.lastOutputTime,
            heartbeatTimestamp: Date.now(),
          })
          .catch(() => {});
      },
      HEARTBEAT_INTERVAL_MS
    );
  }

  private startInactivityMonitor(
    runState: AgentRunState,
    wtPath: string,
    taskId: string,
    branchName: string,
    timers: TimerRegistry,
    onDone: (exitCode: number | null) => Promise<void>,
    params?: AgentRunParams
  ): void {
    timers.setInterval(
      "inactivity",
      () => {
        if (runState.exitHandled) return;
        const elapsed = Date.now() - runState.lastOutputTime;
        const hasActiveToolCalls = runState.activeToolCallIds.size > 0;
        const effectiveTimeout = hasActiveToolCalls
          ? ACTIVE_TOOL_CALL_TIMEOUT_MS
          : AGENT_INACTIVITY_TIMEOUT_MS;
        const proc = runState.activeProcess;
        const pidDead = proc && proc.pid !== null && !isPidAlive(proc.pid);

        if (pidDead) {
          if (runState.exitHandled) return;
          runState.exitHandled = true;
          log.warn("Agent process dead, recovering immediately", { taskId, pid: proc.pid });
          runState.activeProcess = null;
          this.cleanupTimers(timers);
          heartbeatService.deleteHeartbeat(wtPath, taskId).catch(() => {});
          this.branchManager
            .commitWip(wtPath, taskId)
            .then(() => onDone(null))
            .catch((err) => {
              log.error("Post-death handler failed", { taskId, err });
              return onDone(null);
            })
            .catch((err) => {
              log.error("onDone fallback also failed", { taskId, err });
            });
          return;
        }

        if (elapsed > effectiveTimeout) {
          const beyondSuspendGrace = elapsed > AGENT_SUSPEND_GRACE_MS;
          if (!beyondSuspendGrace && runState.lifecycleState !== "suspended" && params) {
            log.warn("Agent suspended due to inactivity", {
              taskId,
              elapsedMs: elapsed,
              effectiveTimeoutMs: effectiveTimeout,
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
            taskId,
            elapsedMs: elapsed,
            effectiveTimeoutMs: effectiveTimeout,
            activeToolCallCount: runState.activeToolCallIds.size,
            suspendedAtIso: runState.suspendedAtIso,
          });
          if (runState.activeProcess) {
            runState.killedDueToTimeout = true;
            this.branchManager
              .commitWip(wtPath, taskId)
              .then(() => runState.activeProcess?.kill())
              .catch((err) => {
                log.error("Inactivity handler failed", { taskId, err });
                runState.activeProcess?.kill();
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
    const previousReason = runState.suspendReason;
    const wasSuspended = runState.lifecycleState === "suspended";
    this.setRunningState(runState, atMs);
    if (!wasSuspended) return;
    const summary = describeResumeReason(previousReason);

    eventLogService
      .append(params.repoPath, {
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
      })
      .catch(() => {});

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
    fallbackLastOutputTimeMs?: number
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
          if (bytesRead > 0) {
            ingestOutputChunk(runState, buf.subarray(0, bytesRead).toString());
          }
        } finally {
          await fh.close();
        }
      }
    } catch {
      // File may not exist yet; fall back to heartbeat timestamp when available.
    }
    this.setRunningState(runState, primedTime);
  }

  private recordToolActivity(params: AgentRunParams, toolEvents: ToolCallLifecycleEvent[]): void {
    if (toolEvents.length === 0) return;

    for (const event of toolEvents) {
      const summary = formatToolSummary(event.summary);
      const logEvent = event.kind === "started" ? "agent.waiting_on_tool" : "agent.tool_completed";
      eventLogService
        .append(params.repoPath, {
          timestamp: new Date().toISOString(),
          projectId: params.projectId,
          taskId: params.taskId,
          event: logEvent,
          data: {
            attempt: params.attempt,
            phase: params.phase,
            toolCallId: event.callId,
            summary,
          },
        })
        .catch(() => {});

      broadcastToProject(params.projectId, {
        type: "agent.activity",
        taskId: params.taskId,
        phase: params.phase,
        activity: event.kind === "started" ? "waiting_on_tool" : "tool_completed",
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
}

function ingestOutputChunk(state: AgentRunState, chunk: string): ToolCallLifecycleEvent[] {
  appendOutputLog(state, chunk);
  return updateToolCallState(state, chunk);
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
        toolEvents.push({ kind: "started", callId: parsed.call_id, summary });
      } else if (
        parsed.subtype === "completed" ||
        parsed.subtype === "failed" ||
        parsed.subtype === "cancelled"
      ) {
        state.activeToolCallIds.delete(parsed.call_id);
        const knownSummary = summary ?? state.activeToolCallSummaries.get(parsed.call_id) ?? null;
        state.activeToolCallSummaries.delete(parsed.call_id);
        toolEvents.push({ kind: "completed", callId: parsed.call_id, summary: knownSummary });
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
