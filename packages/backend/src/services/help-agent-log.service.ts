/**
 * Agent log service — past agent runs from agent_stats.
 * When projectId is provided, scope to that project and omit project column.
 * When null, return all projects with human-readable project names.
 * Default sort: most recent first (completed_at DESC).
 * Model column shows human-readable provider + model (e.g. "Cursor Composer 1.5"); "Unknown" when missing.
 */

import type { AgentLogEntry } from "@opensprint/shared";
import { AGENT_ROLE_LABELS } from "@opensprint/shared";
import type { AgentRole } from "@opensprint/shared";
import type { TaskExecutionOutcome, TaskExecutionPhase } from "@opensprint/shared";
import { taskStore } from "./task-store.service.js";
import { ProjectService } from "./project.service.js";
import { compactExecutionText } from "./task-execution-summary.js";

const DEFAULT_LIMIT = 500;

const projectService = new ProjectService();

type JsonRecord = Record<string, unknown>;

type AttemptVerdict = {
  phase?: TaskExecutionPhase;
  outcome?: TaskExecutionOutcome | null;
  summary?: string | null;
  failureType?: string | null;
};

/** Human-readable provider labels for agent_type */
const PROVIDER_LABELS: Record<string, string> = {
  cursor: "Cursor",
  claude: "Claude",
  "claude-cli": "Claude CLI",
  openai: "OpenAI",
  google: "Google",
  lmstudio: "LM Studio",
  ollama: "Ollama",
  custom: "Custom",
};

/** Default model display name when session has provider but model is empty or "unknown" */
const DEFAULT_MODEL_DISPLAY: Record<string, string> = {
  cursor: "Composer 1.5",
  claude: "Claude",
  "claude-cli": "Claude CLI",
  openai: "OpenAI",
  google: "Google",
  lmstudio: "LM Studio",
  ollama: "Ollama",
  custom: "Custom",
};

function isUnknownModel(value: string): boolean {
  return !value || value.toLowerCase() === "unknown";
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" ? (value as JsonRecord) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstNonEmptyLine(value: string | null | undefined): string | null {
  if (!value) return null;
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function extractQualityGateSummary(data: JsonRecord): string | null {
  const nested = asRecord(data.qualityGateDetail);
  const command =
    asString(data.failedGateCommand) ??
    asString(data.qualityGateCommand) ??
    asString(nested?.command);
  const reason = asString(data.failedGateReason) ?? asString(nested?.reason);
  const firstErrorLine =
    asString(data.qualityGateFirstErrorLine) ??
    asString(data.firstErrorLine) ??
    asString(nested?.firstErrorLine) ??
    firstNonEmptyLine(asString(data.failedGateOutputSnippet) ?? asString(nested?.outputSnippet)) ??
    firstNonEmptyLine(reason);
  if (!command && !firstErrorLine && !reason) return null;
  if (command && firstErrorLine) {
    return compactExecutionText(`${command}: ${firstErrorLine}`, 500);
  }
  return compactExecutionText(command ?? firstErrorLine ?? reason ?? "", 500) || null;
}

function phaseFromUnknown(value: unknown, fallback: TaskExecutionPhase): TaskExecutionPhase {
  if (value === "coding" || value === "review" || value === "merge" || value === "orchestrator") {
    return value;
  }
  return fallback;
}

function summarizeAttemptEvent(event: string, data: JsonRecord): AttemptVerdict | null {
  if (event === "task.completed") {
    const attempt = asNumber(data.attempt);
    return {
      phase: "merge",
      outcome: "completed",
      summary: attempt != null ? `Attempt ${attempt} completed` : "Attempt completed",
      failureType: null,
    };
  }

  if (event === "review.rejected") {
    return {
      phase: "review",
      outcome: "rejected",
      summary:
        asString(data.summary) ??
        asString(data.reason) ??
        "Review rejected with no details provided",
      failureType: asString(data.failureType),
    };
  }

  if (event === "task.failed") {
    return {
      phase: phaseFromUnknown(data.phase, "coding"),
      outcome: "failed",
      summary:
        extractQualityGateSummary(data) ??
        asString(data.summary) ??
        asString(data.reason) ??
        "Attempt failed",
      failureType: asString(data.failureType),
    };
  }

  if (event === "merge.failed") {
    return {
      phase: "merge",
      outcome: asString(data.resolvedBy) === "blocked" ? "blocked" : "requeued",
      summary:
        asString(data.summary) ??
        extractQualityGateSummary(data) ??
        asString(data.reason) ??
        "Merge failed",
      failureType: asString(data.failureType),
    };
  }

  if (event === "task.requeued") {
    return {
      phase: phaseFromUnknown(data.phase, "orchestrator"),
      outcome: "requeued",
      summary:
        extractQualityGateSummary(data) ??
        asString(data.summary) ??
        "Task requeued for another attempt",
      failureType: asString(data.failureType),
    };
  }

  if (event === "task.dispatch_deferred") {
    return {
      phase: phaseFromUnknown(data.phase, "orchestrator"),
      outcome: "requeued",
      summary:
        asString(data.reason) ??
        "Dispatch deferred: branch or worktree in use by another agent",
      failureType: asString(data.failureType),
    };
  }

  if (event === "task.demoted") {
    return {
      phase: phaseFromUnknown(data.phase, "orchestrator"),
      outcome: "demoted",
      summary: asString(data.summary) ?? "Task demoted after repeated failures",
      failureType: asString(data.failureType),
    };
  }

  if (event === "task.blocked") {
    return {
      phase: phaseFromUnknown(data.phase, "orchestrator"),
      outcome: "blocked",
      summary:
        extractQualityGateSummary(data) ??
        asString(data.summary) ??
        asString(data.reason) ??
        "Task blocked",
      failureType: asString(data.failureType),
    };
  }

  return null;
}

function roleToPhase(role: string | null | undefined): TaskExecutionPhase | undefined {
  switch (role) {
    case "coder":
      return "coding";
    case "reviewer":
      return "review";
    case "merger":
      return "merge";
    default:
      return undefined;
  }
}

function componentOutcomeFromAgentStats(outcome: string | null | undefined): "success" | "failed" {
  return outcome === "success" ? "success" : "failed";
}

function fallbackOutcomeFromSessionStatus(
  status: string | null | undefined
): TaskExecutionOutcome | null {
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
    default:
      return null;
  }
}

async function loadAttemptVerdicts(
  client: Awaited<ReturnType<typeof taskStore.getDb>>,
  rows: Array<Record<string, unknown>>
): Promise<Map<string, AttemptVerdict>> {
  const rowsByProject = new Map<string, Set<string>>();
  for (const row of rows) {
    const projectId = asString(row.project_id);
    const taskId = asString(row.task_id);
    if (!projectId || !taskId) continue;
    let taskIds = rowsByProject.get(projectId);
    if (!taskIds) {
      taskIds = new Set<string>();
      rowsByProject.set(projectId, taskIds);
    }
    taskIds.add(taskId);
  }

  const verdicts = new Map<string, AttemptVerdict>();
  for (const [projectId, taskIds] of rowsByProject.entries()) {
    if (taskIds.size === 0) continue;
    const taskIdList = [...taskIds];
    const taskIdPlaceholders = taskIdList.map((_, index) => `$${index + 2}`).join(", ");
    const eventRows = await client.query(
      `SELECT task_id, timestamp, event, data
         FROM orchestrator_events
        WHERE project_id = $1
          AND task_id IN (${taskIdPlaceholders})
        ORDER BY id ASC`,
      [projectId, ...taskIdList]
    );

    for (const eventRow of eventRows) {
      const taskId = asString(eventRow.task_id);
      const data = eventRow.data ? (JSON.parse(eventRow.data as string) as JsonRecord) : {};
      const attempt = asNumber(data.attempt);
      if (!taskId || attempt == null) continue;
      const summary = summarizeAttemptEvent(eventRow.event as string, data);
      if (!summary) continue;
      verdicts.set(`${projectId}:${taskId}:${attempt}`, summary);
    }
  }

  return verdicts;
}

/**
 * Build human-readable provider + model label. Prefer session agent_type/agent_model when present.
 * When provider is known but model is missing/unknown, use default display (e.g. Cursor → "Composer 1.5").
 * Fallback for genuinely unknown: "Unknown" or provider-only.
 */
function formatModelLabel(
  sessionAgentType: string | null | undefined,
  sessionAgentModel: string | null | undefined,
  statsModel: string | null | undefined
): string {
  const stats = (statsModel ?? "").trim();
  const hasSession = (sessionAgentType ?? "").trim() !== "";
  if (hasSession) {
    const rawType = (sessionAgentType as string) ?? "";
    const provider =
      PROVIDER_LABELS[rawType] ??
      (rawType.toLowerCase() === "unknown" ? "Unknown" : rawType) ??
      "Unknown";
    const sessionModel = (sessionAgentModel ?? "").trim();
    let modelPart: string;
    if (sessionModel && !isUnknownModel(sessionModel)) {
      modelPart = sessionModel;
    } else if (stats && !isUnknownModel(stats)) {
      modelPart = stats;
    } else {
      modelPart = DEFAULT_MODEL_DISPLAY[rawType] ?? "Unknown";
    }
    return `${provider} ${modelPart}`;
  }
  if (stats !== "" && !isUnknownModel(stats)) {
    return stats;
  }
  return "Unknown";
}

/**
 * Get agent log entries. Project-scoped when projectId is set; global when null.
 * In global context, includes projectName; in project context, omits it.
 */
export async function getAgentLog(projectId: string | null): Promise<AgentLogEntry[]> {
  const client = await taskStore.getDb();

  const sql =
    projectId != null
      ? `SELECT s.project_id, s.task_id, s.attempt, s.outcome, s.agent_id, s.role, s.model, s.duration_ms, s.completed_at,
                sess.id AS session_id,
                sess.agent_type AS session_agent_type,
                sess.agent_model AS session_agent_model,
                sess.status AS session_status,
                sess.failure_reason AS session_failure_reason,
                sess.summary AS session_summary,
                (sess.output_log IS NOT NULL AND sess.output_log != '') AS session_has_log
         FROM agent_stats s
         LEFT JOIN agent_sessions sess ON sess.id = (
           SELECT picked.id
             FROM agent_sessions picked
            WHERE picked.project_id = s.project_id
              AND picked.task_id = s.task_id
              AND picked.attempt = s.attempt
            ORDER BY picked.completed_at DESC, picked.id DESC
            LIMIT 1
         )
         WHERE s.project_id = $1
         ORDER BY s.completed_at DESC
         LIMIT $2`
      : `SELECT s.project_id, s.task_id, s.attempt, s.outcome, s.agent_id, s.role, s.model, s.duration_ms, s.completed_at,
                sess.id AS session_id,
                sess.agent_type AS session_agent_type,
                sess.agent_model AS session_agent_model,
                sess.status AS session_status,
                sess.failure_reason AS session_failure_reason,
                sess.summary AS session_summary,
                (sess.output_log IS NOT NULL AND sess.output_log != '') AS session_has_log
         FROM agent_stats s
         LEFT JOIN agent_sessions sess ON sess.id = (
           SELECT picked.id
             FROM agent_sessions picked
            WHERE picked.project_id = s.project_id
              AND picked.task_id = s.task_id
              AND picked.attempt = s.attempt
            ORDER BY picked.completed_at DESC, picked.id DESC
            LIMIT 1
         )
         ORDER BY s.completed_at DESC
         LIMIT $1`;

  const params = projectId != null ? [projectId, DEFAULT_LIMIT] : [DEFAULT_LIMIT];
  const rows = await client.query(sql, params);
  const verdicts = await loadAttemptVerdicts(client, rows as Array<Record<string, unknown>>);

  const projectNameMap = new Map<string, string>();
  if (projectId == null) {
    const projects = await projectService.listProjects();
    for (const p of projects) {
      projectNameMap.set(p.id, p.name);
    }
  }

  return rows.map((r) => {
    const storedRole = r.role as string | null | undefined;
    const agentId = r.agent_id as string;
    const role = storedRole ? formatRoleName(storedRole) : formatRoleName(agentId);
    const taskId = asString(r.task_id) ?? undefined;
    const attempt = asNumber(r.attempt) ?? undefined;
    const verdictKey =
      taskId != null && attempt != null && asString(r.project_id)
        ? `${asString(r.project_id)}:${taskId}:${attempt}`
        : null;
    const verdict = verdictKey ? verdicts.get(verdictKey) : undefined;
    const modelLabel = formatModelLabel(
      r.session_agent_type as string | null | undefined,
      r.session_agent_model as string | null | undefined,
      r.model as string | null | undefined
    );
    const componentPhase = roleToPhase(storedRole ?? agentId);
    const fallbackSummary =
      asString(r.session_failure_reason) ??
      asString(r.session_summary) ??
      (attempt != null ? `Attempt ${attempt} ${r.outcome as string}` : null);
    const entry: AgentLogEntry = {
      model: modelLabel,
      role,
      durationMs: r.duration_ms as number,
      endTime: r.completed_at as string,
      ...(taskId ? { taskId } : {}),
      ...(attempt != null ? { attempt } : {}),
      ...(componentPhase ? { phase: componentPhase } : {}),
      componentOutcome: componentOutcomeFromAgentStats(asString(r.outcome)),
      attemptOutcome:
        verdict?.outcome ?? fallbackOutcomeFromSessionStatus(asString(r.session_status)),
      summary: verdict?.summary ?? fallbackSummary,
      failureType: verdict?.failureType ?? null,
    };
    if (projectId == null && r.project_id) {
      const pid = r.project_id as string;
      entry.projectName = projectNameMap.get(pid) ?? pid;
    }
    const sessionId = r.session_id as number | null | undefined;
    const hasLog = r.session_has_log === true || r.session_has_log === "t";
    if (sessionId != null && sessionId > 0 && hasLog) {
      entry.sessionId = sessionId;
    }
    return entry;
  });
}

/** Format agent_id to human-readable role/name. Use AGENT_ROLE_LABELS when it matches a known role. */
function formatRoleName(agentId: string): string {
  if (agentId in AGENT_ROLE_LABELS) {
    return AGENT_ROLE_LABELS[agentId as AgentRole];
  }
  return agentId;
}

/**
 * Get raw session log by agent_sessions.id. Returns null when session not found or has no output_log.
 */
export async function getSessionLog(sessionId: number): Promise<string | null> {
  const client = await taskStore.getDb();
  const rows = await client.query("SELECT output_log FROM agent_sessions WHERE id = $1", [
    sessionId,
  ]);
  const row = rows[0];
  if (!row || row.output_log == null || row.output_log === "") {
    return null;
  }
  return row.output_log as string;
}
