/**
 * Plan version store — persists plan version snapshots (on execute or explicit save).
 * Supports SQLite and Postgres via DbClient / toPgParams.
 */

import type { DbClient } from "../db/client.js";
import { toPgParams } from "../db/sql-params.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";

/** Stored row from plan_versions (id may be number; is_executed_version normalized to boolean). */
export interface PlanVersionRow {
  id: number;
  project_id: string;
  plan_id: string;
  version_number: number;
  title: string | null;
  content: string;
  metadata: string | null;
  created_at: string;
  is_executed_version: boolean;
}

/** List item for version dropdown (subset of row). */
export interface PlanVersionListItem {
  id: number;
  project_id: string;
  plan_id: string;
  version_number: number;
  title: string | null;
  created_at: string;
  is_executed_version: boolean;
}

export interface PlanVersionInsert {
  project_id: string;
  plan_id: string;
  version_number: number;
  title?: string | null;
  content: string;
  metadata?: string | null;
  is_executed_version?: boolean;
}

function toBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  return false;
}

function rowToStored(row: Record<string, unknown>): PlanVersionRow {
  return {
    id: Number(row.id),
    project_id: String(row.project_id ?? ""),
    plan_id: String(row.plan_id ?? ""),
    version_number: Number(row.version_number),
    title: row.title != null ? String(row.title) : null,
    content: String(row.content ?? ""),
    metadata: row.metadata != null ? String(row.metadata) : null,
    created_at: String(row.created_at ?? ""),
    is_executed_version: toBool(row.is_executed_version),
  };
}

function rowToListItem(row: Record<string, unknown>): PlanVersionListItem {
  return {
    id: Number(row.id),
    project_id: String(row.project_id ?? ""),
    plan_id: String(row.plan_id ?? ""),
    version_number: Number(row.version_number),
    title: row.title != null ? String(row.title) : null,
    created_at: String(row.created_at ?? ""),
    is_executed_version: toBool(row.is_executed_version),
  };
}

export class PlanVersionStore {
  constructor(private getClient: () => DbClient) {}

  async insert(data: PlanVersionInsert): Promise<PlanVersionRow> {
    const client = this.getClient();
    const now = new Date().toISOString();
    const title = data.title ?? null;
    const metadata = data.metadata != null ? String(data.metadata) : null;
    const isExec = data.is_executed_version === true ? 1 : 0;

    const row = await client.queryOne(
      toPgParams(
        `INSERT INTO plan_versions (project_id, plan_id, version_number, title, content, metadata, created_at, is_executed_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id, project_id, plan_id, version_number, title, content, metadata, created_at, is_executed_version`
      ),
      [
        data.project_id,
        data.plan_id,
        data.version_number,
        title,
        data.content,
        metadata,
        now,
        isExec,
      ]
    );
    if (!row) throw new AppError(500, ErrorCodes.INTERNAL_ERROR, "Plan version insert did not return row");
    return rowToStored(row as Record<string, unknown>);
  }

  /** List versions for a plan ordered by version_number DESC. */
  async list(projectId: string, planId: string): Promise<PlanVersionListItem[]> {
    const client = this.getClient();
    const rows = await client.query(
      toPgParams(
        `SELECT id, project_id, plan_id, version_number, title, created_at, is_executed_version
         FROM plan_versions
         WHERE project_id = ? AND plan_id = ?
         ORDER BY version_number DESC`
      ),
      [projectId, planId]
    );
    return rows.map((r) => rowToListItem(r as Record<string, unknown>));
  }

  /** Get a single version by (project_id, plan_id, version_number). Throws 404 if not found. */
  async getByVersionNumber(
    projectId: string,
    planId: string,
    versionNumber: number
  ): Promise<PlanVersionRow> {
    const client = this.getClient();
    const row = await client.queryOne(
      toPgParams(
        `SELECT id, project_id, plan_id, version_number, title, content, metadata, created_at, is_executed_version
         FROM plan_versions
         WHERE project_id = ? AND plan_id = ? AND version_number = ?`
      ),
      [projectId, planId, versionNumber]
    );
    if (!row) {
      throw new AppError(
        404,
        ErrorCodes.PLAN_VERSION_NOT_FOUND,
        `Plan version ${versionNumber} not found`,
        { projectId, planId, versionNumber }
      );
    }
    return rowToStored(row as Record<string, unknown>);
  }

  /** Set is_executed_version=true for the given version and false for all other versions of the same plan. */
  async setExecutedVersion(
    projectId: string,
    planId: string,
    versionNumber: number
  ): Promise<void> {
    const client = this.getClient();
    const one = 1;
    const zero = 0;
    await client.execute(
      toPgParams(
        `UPDATE plan_versions SET is_executed_version = ? WHERE project_id = ? AND plan_id = ? AND version_number != ?`
      ),
      [zero, projectId, planId, versionNumber]
    );
    const updated = await client.execute(
      toPgParams(
        `UPDATE plan_versions SET is_executed_version = ? WHERE project_id = ? AND plan_id = ? AND version_number = ?`
      ),
      [one, projectId, planId, versionNumber]
    );
    if (updated === 0) {
      throw new AppError(
        404,
        ErrorCodes.PLAN_VERSION_NOT_FOUND,
        `Plan version ${versionNumber} not found`,
        { projectId, planId, versionNumber }
      );
    }
  }
}
