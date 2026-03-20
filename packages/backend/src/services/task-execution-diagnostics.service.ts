import { getFailureTypeTitle, getQualityGateTitle } from "@opensprint/shared";
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
type QualityGateDetail = {
  command?: string | null;
  reason?: string | null;
  outputSnippet?: string | null;
  worktreePath?: string | null;
  firstErrorLine?: string | null;
  category?: "quality_gate" | "environment_setup" | null;
  validationWorkspace?: "baseline" | "merged_candidate" | "task_worktree" | "repo_root" | null;
  repairAttempted?: boolean;
  repairSucceeded?: boolean;
  executable?: string | null;
  cwd?: string | null;
  exitCode?: number | null;
  signal?: string | null;
};
type TaskExecutionEventItemWithQualityGate = TaskExecutionEventItem & {
  qualityGateDetail?: QualityGateDetail | null;
};
type TaskExecutionAttemptItemWithQualityGate = TaskExecutionAttemptItem & {
  qualityGateDetail?: QualityGateDetail | null;
};
type TaskExecutionDiagnosticsWithQualityGate = TaskExecutionDiagnostics & {
  latestQualityGateDetail?: QualityGateDetail | null;
};

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

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function firstNonEmptyLine(value: string | null): string | null {
  if (!value) return null;
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
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

function extractQualityGateDetail(data: JsonRecord): QualityGateDetail | null {
  const nested = asRecord(data.qualityGateDetail);
  const command =
    asString(data.failedGateCommand) ??
    asString(data.qualityGateCommand) ??
    asString(nested?.command);
  const reason = asString(data.failedGateReason) ?? asString(nested?.reason);
  const outputSnippet = asString(data.failedGateOutputSnippet) ?? asString(nested?.outputSnippet);
  const worktreePath = asString(data.worktreePath) ?? asString(nested?.worktreePath);
  const firstErrorLine =
    asString(data.qualityGateFirstErrorLine) ??
    asString(data.firstErrorLine) ??
    asString(nested?.firstErrorLine) ??
    firstNonEmptyLine(outputSnippet) ??
    firstNonEmptyLine(reason);
  const category =
    data.qualityGateCategory === "environment_setup" || data.qualityGateCategory === "quality_gate"
      ? data.qualityGateCategory
      : nested?.category === "environment_setup" || nested?.category === "quality_gate"
        ? nested.category
        : null;
  const validationWorkspace =
    data.qualityGateValidationWorkspace === "baseline" ||
    data.qualityGateValidationWorkspace === "merged_candidate" ||
    data.qualityGateValidationWorkspace === "task_worktree" ||
    data.qualityGateValidationWorkspace === "repo_root"
      ? data.qualityGateValidationWorkspace
      : nested?.validationWorkspace === "baseline" ||
          nested?.validationWorkspace === "merged_candidate" ||
          nested?.validationWorkspace === "task_worktree" ||
          nested?.validationWorkspace === "repo_root"
        ? nested.validationWorkspace
        : null;
  const repairAttempted =
    asBoolean(data.qualityGateAutoRepairAttempted) ?? asBoolean(nested?.repairAttempted) ?? null;
  const repairSucceeded =
    asBoolean(data.qualityGateAutoRepairSucceeded) ?? asBoolean(nested?.repairSucceeded) ?? null;
  const executable = asString(data.qualityGateExecutable) ?? asString(nested?.executable);
  const cwd = asString(data.qualityGateCwd) ?? asString(nested?.cwd);
  const exitCode = asNumber(data.qualityGateExitCode) ?? asNumber(nested?.exitCode);
  const signal = asString(data.qualityGateSignal) ?? asString(nested?.signal);
  if (
    !command &&
    !reason &&
    !outputSnippet &&
    !worktreePath &&
    !firstErrorLine &&
    !category &&
    !validationWorkspace &&
    repairAttempted == null &&
    repairSucceeded == null &&
    !executable &&
    !cwd &&
    exitCode == null &&
    !signal
  ) {
    return null;
  }
  return {
    command: command ?? null,
    reason: reason ?? null,
    outputSnippet: outputSnippet ?? null,
    worktreePath: worktreePath ?? null,
    firstErrorLine: firstErrorLine ?? null,
    category,
    validationWorkspace,
    repairAttempted: repairAttempted ?? undefined,
    repairSucceeded: repairSucceeded ?? undefined,
    executable: executable ?? null,
    cwd: cwd ?? null,
    exitCode: exitCode ?? null,
    signal: signal ?? null,
  };
}

function withQualityGateDetail(
  item: TaskExecutionEventItem,
  detail: QualityGateDetail | null
): TaskExecutionEventItem {
  if (!detail) return item;
  (item as TaskExecutionEventItemWithQualityGate).qualityGateDetail = detail;
  return item;
}

function eventQualityGateDetail(event: TaskExecutionEventItem | null): QualityGateDetail | null {
  if (!event) return null;
  return (event as TaskExecutionEventItemWithQualityGate).qualityGateDetail ?? null;
}

function withAttemptQualityGateDetail(
  item: TaskExecutionAttemptItem,
  detail: QualityGateDetail | null
): TaskExecutionAttemptItem {
  if (!detail) return item;
  (item as TaskExecutionAttemptItemWithQualityGate).qualityGateDetail = detail;
  return item;
}

function attemptQualityGateDetail(
  attempt: TaskExecutionAttemptItem | null
): QualityGateDetail | null {
  if (!attempt) return null;
  return (attempt as TaskExecutionAttemptItemWithQualityGate).qualityGateDetail ?? null;
}

function buildActionableFailureSummary(
  detail: QualityGateDetail | null,
  options?: {
    autoRepairAttempted?: boolean;
    autoRepairSucceeded?: boolean;
    autoRepairCommands?: string[];
    category?: string | null;
  }
): string | null {
  const command = detail?.command ?? null;
  const errorMessage = detail?.firstErrorLine ?? detail?.reason ?? null;
  if (!command && !errorMessage) return null;
  const summaryParts: string[] = [];

  if (command && errorMessage) {
    summaryParts.push(`${command}: ${compactExecutionText(errorMessage, 220)}`);
  } else if (command) {
    summaryParts.push(command);
  } else if (errorMessage) {
    summaryParts.push(compactExecutionText(errorMessage, 220));
  }

  if (options?.autoRepairAttempted ?? detail?.repairAttempted) {
    const commands =
      (options?.autoRepairCommands ?? []).length > 0
        ? (options?.autoRepairCommands ?? []).join(" -> ")
        : "auto-repair";
    const repairSucceeded = (options?.autoRepairSucceeded ?? detail?.repairSucceeded) === true;
    const status = repairSucceeded ? "succeeded" : "failed";
    summaryParts.push(`repair: ${commands} (${status})`);
  }
  if ((options?.category ?? detail?.category) === "environment_setup") {
    summaryParts.push("category: environment_setup");
  }
  if (detail?.validationWorkspace) {
    summaryParts.push(`workspace: ${detail.validationWorkspace}`);
  }

  return compactExecutionText(summaryParts.join(" | "), 500);
}

function buildActionableFailureSummaryFromData(data: JsonRecord): string | null {
  return buildActionableFailureSummary(extractQualityGateDetail(data), {
    autoRepairAttempted: asBoolean(data.qualityGateAutoRepairAttempted) === true,
    autoRepairSucceeded: asBoolean(data.qualityGateAutoRepairSucceeded) === true,
    autoRepairCommands: asStringArray(data.qualityGateAutoRepairCommands),
    category: asString(data.qualityGateCategory),
  });
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

function mergeBlockReasonForStage(
  mergeStage: string | null,
  fallback: string | null
): string | null {
  if (fallback) return fallback;
  return mergeStage === "quality_gate" ? "Quality Gate Failure" : "Merge Failure";
}

function mergeFailureTypeForStage(
  mergeStage: string | null,
  fallback: string | null
): string | null {
  if (fallback) return fallback;
  return mergeStage === "quality_gate" ? "merge_quality_gate" : "merge_conflict";
}

function summarizeMergeFailure(params: {
  mergeStage: string | null;
  reason: string | null;
  qualityGateSummary: string | null;
  summary: string | null;
}): string {
  if (params.qualityGateSummary) return params.qualityGateSummary;
  if (params.summary) return params.summary;
  if (params.mergeStage === "quality_gate") {
    return compactExecutionText(
      `${getFailureTypeTitle("quality_gate")}${params.reason ? `: ${params.reason}` : ""}`,
      500
    );
  }
  return compactExecutionText(
    `Merge failed${params.mergeStage ? ` during ${params.mergeStage}` : ""}${params.reason ? `: ${params.reason}` : ""}`,
    500
  );
}

function titleForMergeFailure(
  outcome: Extract<TaskExecutionOutcome, "requeued" | "blocked">,
  mergeStage: string | null
): string {
  if (mergeStage !== "quality_gate") return titleForOutcome("merge", outcome);
  return getQualityGateTitle(outcome === "blocked");
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
  // Prefer last line that looks like a user-facing error/instruction (matches failure-handler extraction)
  const errorLike =
    /not available|please|switch to|error|invalid|required|cannot|unable|try |failed|rate limit|authentication|api key/i;
  const lastMessageLike = [...lines].reverse().find((line) => {
    if (line.length > 400) return false;
    if (errorLike.test(line)) return true;
    return /[.?]$/.test(line) || (line.length < 150 && !/^[\s\S]*[\d{"]$/.test(line));
  });
  const toSummarize = lastMessageLike ?? lines[lines.length - 1];
  return toSummarize
    ? compactExecutionText(toSummarize.replace(/^\s*[A-Z]:\s*/i, "").trim(), 240)
    : null;
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
    const qualityGateDetail = extractQualityGateDetail(data);
    const summary =
      buildActionableFailureSummary(qualityGateDetail) ??
      asString(data.summary) ??
      (reason ? `${labelForPhase(phase)} failed: ${compactExecutionText(reason, 360)}` : null) ??
      `${labelForPhase(phase)} failed`;
    return withQualityGateDetail(
      {
        at: event.timestamp,
        attempt,
        phase,
        outcome: "failed",
        title: titleForOutcome(phase, "failed"),
        summary,
        failureType: asString(data.failureType),
        model: asString(data.model),
        nextAction: asString(data.nextAction) ?? defaultNextAction("requeued"),
      },
      qualityGateDetail
    );
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
    const qualityGateDetail = extractQualityGateDetail(data);
    const qualityGateSummary = buildActionableFailureSummaryFromData(data);
    const blockReason =
      outcome === "blocked"
        ? mergeBlockReasonForStage(mergeStage, asString(data.blockReason))
        : null;
    const failureType = mergeFailureTypeForStage(mergeStage, asString(data.failureType));
    const summary = summarizeMergeFailure({
      mergeStage,
      reason,
      qualityGateSummary,
      summary: asString(data.summary),
    });
    return withQualityGateDetail(
      {
        at: event.timestamp,
        attempt,
        phase: "merge",
        outcome,
        title:
          outcome === "requeued" || outcome === "blocked"
            ? titleForMergeFailure(outcome, mergeStage)
            : titleForOutcome("merge", outcome),
        summary,
        failureType,
        blockReason,
        mergeStage,
        conflictedFiles: asStringArray(data.conflictedFiles),
        nextAction: asString(data.nextAction) ?? defaultNextAction(outcome),
      },
      qualityGateDetail
    );
  }

  if (event.event === "task.requeued") {
    const phase = phaseFromUnknown(data.phase, "orchestrator");
    const qualityGateDetail = extractQualityGateDetail(data);
    return withQualityGateDetail(
      {
        at: event.timestamp,
        attempt,
        phase,
        outcome: "requeued",
        title: "Task requeued",
        summary:
          buildActionableFailureSummary(qualityGateDetail) ??
          asString(data.summary) ??
          "Task requeued for another attempt",
        failureType: asString(data.failureType),
        blockReason: asString(data.blockReason),
        nextAction: asString(data.nextAction) ?? defaultNextAction("requeued"),
      },
      qualityGateDetail
    );
  }

  if (event.event === "task.demoted") {
    const phase = phaseFromUnknown(data.phase, "orchestrator");
    const qualityGateDetail = extractQualityGateDetail(data);
    return withQualityGateDetail(
      {
        at: event.timestamp,
        attempt,
        phase,
        outcome: "demoted",
        title: "Task demoted",
        summary:
          buildActionableFailureSummary(qualityGateDetail) ??
          asString(data.summary) ??
          "Task priority lowered after repeated failures",
        failureType: asString(data.failureType),
        nextAction: asString(data.nextAction) ?? defaultNextAction("demoted"),
      },
      qualityGateDetail
    );
  }

  if (event.event === "task.blocked") {
    const phase = phaseFromUnknown(data.phase, "orchestrator");
    const qualityGateDetail = extractQualityGateDetail(data);
    return withQualityGateDetail(
      {
        at: event.timestamp,
        attempt,
        phase,
        outcome: "blocked",
        title: "Task blocked",
        summary:
          buildActionableFailureSummary(qualityGateDetail) ??
          asString(data.summary) ??
          asString(data.reason) ??
          "Task blocked",
        failureType: asString(data.failureType),
        blockReason: asString(data.blockReason),
        mergeStage: asString(data.mergeStage),
        conflictedFiles: asStringArray(data.conflictedFiles),
        nextAction: asString(data.nextAction) ?? defaultNextAction("blocked"),
      },
      qualityGateDetail
    );
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
  const latestAttemptDetail =
    eventQualityGateDetail(terminalEvent ?? null) ??
    [...attemptEvents]
      .reverse()
      .map((event) => eventQualityGateDetail(event))
      .find((detail): detail is QualityGateDetail => detail != null) ??
    null;
  const codingModel =
    attemptEvents.find((event) => event.phase === "coding" && event.model)?.model ?? null;
  const reviewModel =
    attemptEvents.find((event) => event.phase === "review" && event.model)?.model ?? null;

  const finalOutcome = terminalEvent?.outcome ?? sessionDerived?.finalOutcome ?? "running";
  const noTerminalFallback =
    finalOutcome === "running"
      ? `Attempt ${attempt} is in progress`
      : `Attempt ${attempt} has no recorded terminal outcome`;

  const item: TaskExecutionAttemptItem = {
    attempt,
    startedAt:
      sessions[0]?.startedAt ??
      attemptEvents.find((event) => event.outcome === "running")?.at ??
      null,
    completedAt: sessions[sessions.length - 1]?.completedAt ?? terminalEvent?.at ?? null,
    codingModel,
    reviewModel,
    finalPhase: terminalEvent?.phase ?? sessionDerived?.finalPhase ?? "orchestrator",
    finalOutcome,
    finalSummary:
      (eventQualityGateDetail(terminalEvent ?? null)
        ? terminalEvent?.summary
        : buildActionableFailureSummary(latestAttemptDetail)) ??
      terminalEvent?.summary ??
      sessionDerived?.finalSummary ??
      noTerminalFallback,
    failureType: terminalEvent?.failureType ?? null,
    blockReason: terminalEvent?.blockReason ?? null,
    mergeStage: terminalEvent?.mergeStage ?? null,
    conflictedFiles: terminalEvent?.conflictedFiles ?? [],
    sessionAttemptStatuses: sessionDerived?.sessionAttemptStatuses ?? [],
  };
  return withAttemptQualityGateDetail(item, latestAttemptDetail);
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
        (task.block_reason === "Merge Failure" || task.block_reason === "Quality Gate Failure")
      ) {
        latestAttempt.finalPhase = "merge";
        latestAttempt.finalOutcome = "blocked";
        latestAttempt.blockReason = task.block_reason;
        latestAttempt.failureType =
          lastExecution?.failureType ??
          mergeFailureTypeForStage(fallbackMergeStage, latestAttempt.failureType ?? null);
        latestAttempt.finalSummary =
          lastExecution?.summary ??
          compactExecutionText(
            fallbackMergeStage === "quality_gate"
              ? `Attempt ${latestAttempt.attempt} quality gate failed`
              : `Attempt ${latestAttempt.attempt} merge failed${fallbackMergeStage ? ` during ${fallbackMergeStage}` : ""}`,
            500
          );
      }
    }

    const latestTimelineEvent = timeline.at(-1) ?? null;
    const latestEvent =
      [...timeline].reverse().find((event) => event.outcome !== "running") ?? null;
    const latestRunningEvent =
      latestTimelineEvent?.outcome === "running" ? latestTimelineEvent : null;
    const taskQualityGateDetail = extractQualityGateDetail(asRecord(task) ?? {});

    const diagnostics: TaskExecutionDiagnostics = {
      taskId,
      taskStatus: task.status,
      blockReason: task.block_reason ?? null,
      cumulativeAttempts,
      latestSummary:
        latestRunningEvent?.summary ??
        latestAttempt?.finalSummary ??
        latestTimelineEvent?.summary ??
        latestEvent?.summary ??
        lastExecution?.summary ??
        null,
      latestFailureType:
        latestAttempt?.failureType ??
        latestTimelineEvent?.failureType ??
        latestEvent?.failureType ??
        lastExecution?.failureType ??
        null,
      latestOutcome:
        latestRunningEvent?.outcome ??
        latestAttempt?.finalOutcome ??
        latestTimelineEvent?.outcome ??
        latestEvent?.outcome ??
        lastExecution?.outcome ??
        null,
      latestNextAction:
        latestRunningEvent?.nextAction ??
        latestTimelineEvent?.nextAction ??
        latestEvent?.nextAction ??
        defaultNextAction(latestAttempt?.finalOutcome ?? lastExecution?.outcome ?? "failed"),
      attempts,
      timeline,
    };
    const latestQualityGateDetail =
      attemptQualityGateDetail(latestAttempt ?? null) ??
      eventQualityGateDetail(latestTimelineEvent) ??
      eventQualityGateDetail(latestEvent) ??
      (timeline.length === 0 ? taskQualityGateDetail : null) ??
      null;
    if (latestQualityGateDetail) {
      (diagnostics as TaskExecutionDiagnosticsWithQualityGate).latestQualityGateDetail =
        latestQualityGateDetail;
    }
    return diagnostics;
  }
}
