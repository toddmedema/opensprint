import type {
  AgentSession,
  TaskExecutionAttemptItem,
  TaskExecutionDiagnostics,
  TaskExecutionEventItem,
  TaskExecutionOutcome,
  TaskExecutionPhase,
} from "@opensprint/shared";
import type { ProjectService } from "./project.service.js";
import type { SessionManager } from "./session-manager.js";
import type { StoredTask, TaskStoreService } from "./task-store.service.js";
import { eventLogService, type OrchestratorEvent } from "./event-log.service.js";
import { compactExecutionText, parseTaskLastExecutionSummary } from "./task-execution-summary.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" ? (value as JsonRecord) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function extractMergeStageFromTask(task: StoredTask): string | null {
  const labels = Array.isArray(task.labels) ? task.labels : [];
  const label = labels.find((item) => item.startsWith("merge_stage:"));
  return label ? label.slice("merge_stage:".length) : null;
}

function extractConflictFilesFromTask(task: StoredTask): string[] {
  const labels = Array.isArray(task.labels) ? task.labels : [];
  const label = labels.find((item) => item.startsWith("conflict_files:"));
  if (!label) return [];
  try {
    const parsed = JSON.parse(label.slice("conflict_files:".length));
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function labelForPhase(phase: TaskExecutionPhase): string {
  switch (phase) {
    case "coding":
      return "Coding";
    case "review":
      return "Review";
    case "merge":
      return "Merge";
    case "orchestrator":
      return "Orchestrator";
  }
}

function phaseFromUnknown(value: unknown, fallback: TaskExecutionPhase): TaskExecutionPhase {
  if (value === "coding" || value === "review" || value === "merge" || value === "orchestrator") {
    return value;
  }
  return fallback;
}

function outcomeFromSessionStatus(status: AgentSession["status"]): TaskExecutionOutcome {
  switch (status) {
    case "approved":
    case "success":
      return "completed";
    case "rejected":
      return "rejected";
    case "failed":
    case "timeout":
    case "cancelled":
      return "failed";
  }
}

function defaultNextAction(outcome: TaskExecutionOutcome): string | null {
  switch (outcome) {
    case "requeued":
      return "Requeued for retry";
    case "demoted":
      return "Demoted and returned to queue";
    case "blocked":
      return "Blocked pending investigation";
    default:
      return null;
  }
}

function titleForOutcome(phase: TaskExecutionPhase, outcome: TaskExecutionOutcome): string {
  if (outcome === "running") return `${labelForPhase(phase)} started`;
  if (outcome === "suspended") return `${labelForPhase(phase)} suspended`;
  if (outcome === "failed") return `${labelForPhase(phase)} failed`;
  if (outcome === "rejected") return "Review rejected";
  if (outcome === "requeued") return phase === "merge" ? "Merge failed" : "Task requeued";
  if (outcome === "demoted") return "Task demoted";
  if (outcome === "blocked") return "Task blocked";
  return `${labelForPhase(phase)} completed`;
}

function extractOutputHint(outputLog: string): string | null {
  const compact = outputLog.replace(/\r/g, "");
  const agentError = compact.match(/\[Agent error:\s*([^\]]+)\]/i);
  if (agentError?.[1]) return compactExecutionText(agentError[1], 240);

  const lines = compact
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("{"));
  if (lines.length === 0) return null;
  return compactExecutionText(lines[0], 240);
}

function summarizeEvent(event: OrchestratorEvent): TaskExecutionEventItem | null {
  const data = asRecord(event.data) ?? {};
  const attempt = asNumber(data.attempt);

  if (event.event === "transition.start_task") {
    return {
      at: event.timestamp,
      attempt,
      phase: "coding",
      outcome: "running",
      title: "Attempt started",
      summary: attempt != null ? `Attempt ${attempt} started` : "Attempt started",
    };
  }

  if (event.event === "transition.enter_review") {
    return {
      at: event.timestamp,
      attempt,
      phase: "review",
      outcome: "running",
      title: "Review started",
      summary: attempt != null ? `Attempt ${attempt} entered review` : "Review started",
    };
  }

  if (event.event === "agent.spawned") {
    const phase = phaseFromUnknown(data.phase, "coding");
    const model = asString(data.model);
    return {
      at: event.timestamp,
      attempt,
      phase,
      outcome: "running",
      title: titleForOutcome(phase, "running"),
      summary: compactExecutionText(
        `${labelForPhase(phase)} agent spawned${model ? ` (${model})` : ""}`,
        240
      ),
      model,
    };
  }

  if (event.event === "agent.waiting_on_tool" || event.event === "agent.tool_completed") {
    const phase = phaseFromUnknown(data.phase, "coding");
    const toolSummary = asString(data.summary);
    const waiting = event.event === "agent.waiting_on_tool";
    return {
      at: event.timestamp,
      attempt,
      phase,
      outcome: "running",
      title: waiting ? "Waiting on tool" : "Tool completed",
      summary: compactExecutionText(
        waiting
          ? `${labelForPhase(phase)} waiting on ${toolSummary ?? "a tool call"}`
          : `${labelForPhase(phase)} tool completed${toolSummary ? `: ${toolSummary}` : ""}`,
        240
      ),
      nextAction: waiting ? "Awaiting tool completion" : "Agent resuming after tool output",
    };
  }

  if (event.event === "agent.suspended") {
    const phase = phaseFromUnknown(data.phase, "coding");
    const reason = asString(data.reason);
    return {
      at: event.timestamp,
      attempt,
      phase,
      outcome: "suspended",
      title: titleForOutcome(phase, "suspended"),
      summary:
        asString(data.summary) ??
        compactExecutionText(
          `${labelForPhase(phase)} suspended: ${
            reason === "heartbeat_gap"
              ? "heartbeat gap after host sleep or backend pause"
              : reason === "backend_restart"
                ? "backend restarted while agent was still running"
                : "no agent output within inactivity window"
          }`,
          240
        ),
      nextAction: "Waiting for reconnect or new output",
    };
  }

  if (event.event === "agent.resumed") {
    const phase = phaseFromUnknown(data.phase, "coding");
    return {
      at: event.timestamp,
      attempt,
      phase,
      outcome: "running",
      title: `${labelForPhase(phase)} resumed`,
      summary:
        asString(data.summary) ??
        compactExecutionText(`${labelForPhase(phase)} resumed after reconnect`, 240),
      nextAction: "Agent running",
    };
  }

  if (event.event === "task.failed") {
    const phase = phaseFromUnknown(data.phase, "coding");
    const reason = asString(data.reason);
    const summary =
      asString(data.summary) ??
      (reason ? `${labelForPhase(phase)} failed: ${compactExecutionText(reason, 360)}` : null) ??
      `${labelForPhase(phase)} failed`;
    return {
      at: event.timestamp,
      attempt,
      phase,
      outcome: "failed",
      title: titleForOutcome(phase, "failed"),
      summary,
      failureType: asString(data.failureType),
      model: asString(data.model),
      nextAction: asString(data.nextAction) ?? defaultNextAction("requeued"),
    };
  }

  if (event.event === "review.rejected") {
    return {
      at: event.timestamp,
      attempt,
      phase: "review",
      outcome: "rejected",
      title: "Review rejected",
      summary:
        asString(data.summary) ??
        asString(data.reason) ??
        "Review rejected with no details provided",
      failureType: asString(data.failureType),
      model: asString(data.model),
      nextAction: asString(data.nextAction) ?? "Retry coding with review feedback",
    };
  }

  if (event.event === "merge.failed") {
    const resolvedBy = asString(data.resolvedBy);
    const outcome: TaskExecutionOutcome = resolvedBy === "blocked" ? "blocked" : "requeued";
    const mergeStage = asString(data.stage);
    const reason = asString(data.reason);
    const summary =
      asString(data.summary) ??
      compactExecutionText(
        `Merge failed${mergeStage ? ` during ${mergeStage}` : ""}${reason ? `: ${reason}` : ""}`,
        500
      );
    return {
      at: event.timestamp,
      attempt,
      phase: "merge",
      outcome,
      title: titleForOutcome("merge", outcome),
      summary,
      blockReason: outcome === "blocked" ? "Merge Failure" : null,
      mergeStage,
      conflictedFiles: asStringArray(data.conflictedFiles),
      nextAction: asString(data.nextAction) ?? defaultNextAction(outcome),
    };
  }

  if (event.event === "task.requeued") {
    const phase = phaseFromUnknown(data.phase, "orchestrator");
    return {
      at: event.timestamp,
      attempt,
      phase,
      outcome: "requeued",
      title: "Task requeued",
      summary: asString(data.summary) ?? "Task requeued for another attempt",
      failureType: asString(data.failureType),
      blockReason: asString(data.blockReason),
      nextAction: asString(data.nextAction) ?? defaultNextAction("requeued"),
    };
  }

  if (event.event === "task.demoted") {
    const phase = phaseFromUnknown(data.phase, "orchestrator");
    return {
      at: event.timestamp,
      attempt,
      phase,
      outcome: "demoted",
      title: "Task demoted",
      summary: asString(data.summary) ?? "Task priority lowered after repeated failures",
      failureType: asString(data.failureType),
      nextAction: asString(data.nextAction) ?? defaultNextAction("demoted"),
    };
  }

  if (event.event === "task.blocked") {
    const phase = phaseFromUnknown(data.phase, "orchestrator");
    return {
      at: event.timestamp,
      attempt,
      phase,
      outcome: "blocked",
      title: "Task blocked",
      summary: asString(data.summary) ?? asString(data.reason) ?? "Task blocked",
      failureType: asString(data.failureType),
      blockReason: asString(data.blockReason),
      mergeStage: asString(data.mergeStage),
      conflictedFiles: asStringArray(data.conflictedFiles),
      nextAction: asString(data.nextAction) ?? defaultNextAction("blocked"),
    };
  }

  return null;
}

function getAttemptNumbers(
  task: StoredTask,
  sessions: AgentSession[],
  timeline: TaskExecutionEventItem[]
): number[] {
  const all = new Set<number>();
  const cumulative = Array.isArray(task.labels)
    ? task.labels
        .filter((label) => /^attempts:\d+$/.test(label))
        .map((label) => parseInt(label.split(":")[1] ?? "", 10))
        .reduce<number | null>(
          (max, value) => (Number.isNaN(value) ? max : Math.max(max ?? 0, value)),
          null
        )
    : null;
  if (typeof cumulative === "number") {
    for (let attempt = 1; attempt <= cumulative; attempt += 1) {
      all.add(attempt);
    }
  }
  for (const session of sessions) all.add(session.attempt);
  for (const item of timeline) {
    if (item.attempt != null) all.add(item.attempt);
  }
  return [...all].sort((a, b) => b - a);
}

function finalAttemptFromSessions(
  sessions: AgentSession[]
): Pick<
  TaskExecutionAttemptItem,
  "finalPhase" | "finalOutcome" | "finalSummary" | "sessionAttemptStatuses"
> | null {
  if (sessions.length === 0) return null;
  const statuses = [...new Set(sessions.map((session) => session.status))];
  const last = sessions[sessions.length - 1]!;
  const outputHint = extractOutputHint(last.outputLog);
  return {
    finalPhase: last.status === "rejected" ? "review" : "coding",
    finalOutcome: outcomeFromSessionStatus(last.status),
    finalSummary:
      last.failureReason ?? last.summary ?? outputHint ?? `Attempt ${last.attempt} ${last.status}`,
    sessionAttemptStatuses: statuses,
  };
}

function buildAttemptItem(
  attempt: number,
  sessions: AgentSession[],
  attemptEvents: TaskExecutionEventItem[]
): TaskExecutionAttemptItem {
  const terminalEvent = [...attemptEvents].reverse().find((event) => event.outcome !== "running");
  const sessionDerived = finalAttemptFromSessions(sessions);
  const codingModel =
    attemptEvents.find((event) => event.phase === "coding" && event.model)?.model ?? null;
  const reviewModel =
    attemptEvents.find((event) => event.phase === "review" && event.model)?.model ?? null;

  return {
    attempt,
    startedAt:
      sessions[0]?.startedAt ??
      attemptEvents.find((event) => event.outcome === "running")?.at ??
      null,
    completedAt: sessions[sessions.length - 1]?.completedAt ?? terminalEvent?.at ?? null,
    codingModel,
    reviewModel,
    finalPhase: terminalEvent?.phase ?? sessionDerived?.finalPhase ?? "orchestrator",
    finalOutcome: terminalEvent?.outcome ?? sessionDerived?.finalOutcome ?? "running",
    finalSummary:
      terminalEvent?.summary ??
      sessionDerived?.finalSummary ??
      `Attempt ${attempt} has no recorded terminal outcome`,
    failureType: terminalEvent?.failureType ?? null,
    blockReason: terminalEvent?.blockReason ?? null,
    mergeStage: terminalEvent?.mergeStage ?? null,
    conflictedFiles: terminalEvent?.conflictedFiles ?? [],
    sessionAttemptStatuses: sessionDerived?.sessionAttemptStatuses ?? [],
  };
}

export class TaskExecutionDiagnosticsService {
  constructor(
    private projectService: ProjectService,
    private taskStore: TaskStoreService,
    private sessionManager: SessionManager
  ) {}

  async getDiagnostics(projectId: string, taskId: string): Promise<TaskExecutionDiagnostics> {
    const project = await this.projectService.getProject(projectId);
    const [task, sessions, events] = await Promise.all([
      this.taskStore.show(projectId, taskId),
      this.sessionManager.listSessions(project.repoPath, taskId),
      eventLogService.readForTask(project.repoPath, taskId),
    ]);

    const timeline = events
      .map((event) => summarizeEvent(event))
      .filter((event): event is TaskExecutionEventItem => event != null)
      .sort((a, b) => a.at.localeCompare(b.at));
    const cumulativeAttempts = this.taskStore.getCumulativeAttemptsFromIssue(task);
    const lastExecution = parseTaskLastExecutionSummary(
      (task as StoredTask & { last_execution_summary?: unknown }).last_execution_summary
    );
    const fallbackMergeStage = extractMergeStageFromTask(task);
    const fallbackConflictedFiles = extractConflictFilesFromTask(task);
    const attempts = getAttemptNumbers(task, sessions, timeline).map((attempt) =>
      buildAttemptItem(
        attempt,
        sessions.filter((session) => session.attempt === attempt),
        timeline.filter((event) => event.attempt === attempt)
      )
    );
    const latestAttempt = attempts.find((attempt) => attempt.attempt === cumulativeAttempts);
    if (latestAttempt) {
      if (!latestAttempt.mergeStage && fallbackMergeStage) {
        latestAttempt.mergeStage = fallbackMergeStage;
      }
      if (
        (latestAttempt.conflictedFiles ?? []).length === 0 &&
        fallbackConflictedFiles.length > 0
      ) {
        latestAttempt.conflictedFiles = fallbackConflictedFiles;
      }
      if (
        latestAttempt.finalOutcome === "running" &&
        task.status === "blocked" &&
        task.block_reason === "Merge Failure"
      ) {
        latestAttempt.finalPhase = "merge";
        latestAttempt.finalOutcome = "blocked";
        latestAttempt.blockReason = task.block_reason;
        latestAttempt.finalSummary =
          lastExecution?.summary ??
          compactExecutionText(
            `Attempt ${latestAttempt.attempt} merge failed${fallbackMergeStage ? ` during ${fallbackMergeStage}` : ""}`,
            500
          );
      }
    }

    const latestTimelineEvent = timeline.at(-1) ?? null;
    const latestEvent =
      [...timeline].reverse().find((event) => event.outcome !== "running") ?? null;

    return {
      taskId,
      taskStatus: task.status,
      blockReason: task.block_reason ?? null,
      cumulativeAttempts,
      latestSummary:
        lastExecution?.summary ?? latestTimelineEvent?.summary ?? latestEvent?.summary ?? null,
      latestFailureType:
        lastExecution?.failureType ??
        latestTimelineEvent?.failureType ??
        latestEvent?.failureType ??
        null,
      latestOutcome:
        lastExecution?.outcome ?? latestTimelineEvent?.outcome ?? latestEvent?.outcome ?? null,
      latestNextAction:
        latestTimelineEvent?.nextAction ??
        latestEvent?.nextAction ??
        defaultNextAction(lastExecution?.outcome ?? "failed"),
      attempts,
      timeline,
    };
  }
}
