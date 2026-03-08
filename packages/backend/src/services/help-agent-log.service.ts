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
import { taskStore } from "./task-store.service.js";
import { ProjectService } from "./project.service.js";

const DEFAULT_LIMIT = 500;

const projectService = new ProjectService();

/** Human-readable provider labels for agent_type */
const PROVIDER_LABELS: Record<string, string> = {
  cursor: "Cursor",
  claude: "Claude",
  "claude-cli": "Claude CLI",
  openai: "OpenAI",
  google: "Google",
  custom: "Custom",
};

/** Default model display name when session has provider but model is empty or "unknown" */
const DEFAULT_MODEL_DISPLAY: Record<string, string> = {
  cursor: "Composer 1.5",
  claude: "Claude",
  "claude-cli": "Claude CLI",
  openai: "OpenAI",
  google: "Google",
  custom: "Custom",
};

function isUnknownModel(value: string): boolean {
  return !value || value.toLowerCase() === "unknown";
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
      PROVIDER_LABELS[rawType] ?? (rawType.toLowerCase() === "unknown" ? "Unknown" : rawType) ?? "Unknown";
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
      ? `SELECT s.agent_id, s.role, s.model, s.duration_ms, s.completed_at,
                sess.id AS session_id,
                sess.agent_type AS session_agent_type,
                sess.agent_model AS session_agent_model,
                (sess.output_log IS NOT NULL AND sess.output_log != '') AS session_has_log
         FROM agent_stats s
         LEFT JOIN agent_sessions sess ON s.project_id = sess.project_id
           AND s.task_id = sess.task_id
           AND s.attempt = sess.attempt
         WHERE s.project_id = $1
         ORDER BY s.completed_at DESC
         LIMIT $2`
      : `SELECT s.agent_id, s.role, s.model, s.duration_ms, s.completed_at, s.project_id,
                sess.id AS session_id,
                sess.agent_type AS session_agent_type,
                sess.agent_model AS session_agent_model,
                (sess.output_log IS NOT NULL AND sess.output_log != '') AS session_has_log
         FROM agent_stats s
         LEFT JOIN agent_sessions sess ON s.project_id = sess.project_id
           AND s.task_id = sess.task_id
           AND s.attempt = sess.attempt
         ORDER BY s.completed_at DESC
         LIMIT $1`;

  const params = projectId != null ? [projectId, DEFAULT_LIMIT] : [DEFAULT_LIMIT];
  const rows = await client.query(sql, params);

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
    const role = storedRole
      ? formatRoleName(storedRole)
      : formatRoleName(agentId);
    const modelLabel = formatModelLabel(
      r.session_agent_type as string | null | undefined,
      r.session_agent_model as string | null | undefined,
      r.model as string | null | undefined
    );
    const entry: AgentLogEntry = {
      model: modelLabel,
      role,
      durationMs: r.duration_ms as number,
      endTime: r.completed_at as string,
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
  const rows = await client.query(
    "SELECT output_log FROM agent_sessions WHERE id = $1",
    [sessionId]
  );
  const row = rows[0];
  if (!row || row.output_log == null || row.output_log === "") {
    return null;
  }
  return row.output_log as string;
}
