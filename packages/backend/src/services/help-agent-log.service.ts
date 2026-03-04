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
      ? `SELECT agent_id, model, duration_ms, completed_at
         FROM agent_stats
         WHERE project_id = $1
         ORDER BY completed_at DESC
         LIMIT $2`
      : `SELECT agent_id, model, duration_ms, completed_at, project_id
         FROM agent_stats
         ORDER BY completed_at DESC
         LIMIT $1`;

  const params = projectId != null ? [projectId, DEFAULT_LIMIT] : [DEFAULT_LIMIT];
  const rows = await client.query(sql, params);

  let projectNameMap: Map<string, string> = new Map();
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
