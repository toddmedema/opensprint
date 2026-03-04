/**
 * Auditor run store — persists final review Auditor execution records with planId.
 * Enables plan-centric lookup and deep-linking.
 */

import type { DbClient } from "../db/client.js";
import { toPgParams } from "../db/sql-params.js";

export interface AuditorRunRecord {
  id: number;
  projectId: string;
  planId: string;
  epicId: string;
  startedAt: string;
  completedAt: string;
  status: string;
  assessment: string | null;
}

export interface AuditorRunInsert {
  projectId: string;
  planId: string;
  epicId: string;
  startedAt: string;
  completedAt: string;
  status: string;
  assessment?: string | null;
}

export class AuditorRunStore {
  constructor(private getClient: () => DbClient) {}

  async insert(record: AuditorRunInsert): Promise<AuditorRunRecord> {
    const client = this.getClient();
    const row = await client.queryOne(
      toPgParams(
        `INSERT INTO auditor_runs (project_id, plan_id, epic_id, started_at, completed_at, status, assessment)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING id, project_id, plan_id, epic_id, started_at, completed_at, status, assessment`
      ),
      [
        record.projectId,
        record.planId,
        record.epicId,
        record.startedAt,
        record.completedAt,
        record.status,
        record.assessment ?? null,
      ]
    );
    return rowToRecord(row as Record<string, unknown>);
  }

  async listByPlanId(projectId: string, planId: string): Promise<AuditorRunRecord[]> {
    const client = this.getClient();
    const rows = await client.query(
      toPgParams(
        "SELECT id, project_id, plan_id, epic_id, started_at, completed_at, status, assessment FROM auditor_runs WHERE project_id = ? AND plan_id = ? ORDER BY completed_at DESC"
      ),
      [projectId, planId]
    );
    return rows.map((r) => rowToRecord(r as Record<string, unknown>));
  }
}

function rowToRecord(row: Record<string, unknown>): AuditorRunRecord {
  return {
    id: row.id as number,
    projectId: row.project_id as string,
    planId: row.plan_id as string,
    epicId: row.epic_id as string,
    startedAt: row.started_at as string,
    completedAt: row.completed_at as string,
    status: row.status as string,
    assessment: (row.assessment as string) ?? null,
  };
}
