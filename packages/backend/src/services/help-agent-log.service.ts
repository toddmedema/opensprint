/**
 * Agent log service — past agent runs from agent_stats.
 * When projectId is provided, scope to that project and omit project column.
 * When null, return all projects with human-readable project names.
 * Default sort: most recent first (completed_at DESC).
 */

import type { AgentLogEntry } from "@opensprint/shared";
import { AGENT_ROLE_LABELS } from "@opensprint/shared";
import type { AgentRole } from "@opensprint/shared";
import { taskStore } from "./task-store.service.js";
import { ProjectService } from "./project.service.js";

const DEFAULT_LIMIT = 500;

const projectService = new ProjectService();

/**
 * Get agent log entries. Project-scoped when projectId is set; global when null.
 * In global context, includes projectName; in project context, omits it.
 */
export async function getAgentLog(projectId: string | null): Promise<AgentLogEntry[]> {
  const client = await taskStore.getDb();

  const sql =
    projectId != null
      ? `SELECT s.agent_id, s.model, s.duration_ms, s.completed_at,
                sess.id AS session_id
         FROM agent_stats s
         LEFT JOIN agent_sessions sess ON s.project_id = sess.project_id
           AND s.task_id = sess.task_id
           AND s.attempt = sess.attempt
           AND sess.output_log IS NOT NULL
           AND sess.output_log != ''
         WHERE s.project_id = $1
         ORDER BY s.completed_at DESC
         LIMIT $2`
      : `SELECT s.agent_id, s.model, s.duration_ms, s.completed_at, s.project_id,
                sess.id AS session_id
         FROM agent_stats s
         LEFT JOIN agent_sessions sess ON s.project_id = sess.project_id
           AND s.task_id = sess.task_id
           AND s.attempt = sess.attempt
           AND sess.output_log IS NOT NULL
           AND sess.output_log != ''
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
    const agentId = r.agent_id as string;
    const role = formatRoleName(agentId);
    const entry: AgentLogEntry = {
      model: (r.model as string) ?? "",
      role,
      durationMs: r.duration_ms as number,
      endTime: r.completed_at as string,
    };
    if (projectId == null && r.project_id) {
      const pid = r.project_id as string;
      entry.projectName = projectNameMap.get(pid) ?? pid;
    }
    const sessionId = r.session_id as number | null | undefined;
    if (sessionId != null && sessionId > 0) {
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
