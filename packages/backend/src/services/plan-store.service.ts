import type { DbClient } from "../db/client.js";
import { toPgParams } from "../db/sql-params.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";

/** Plan row returned from plans table (metadata is JSON string; parse as PlanMetadata). */
export interface StoredPlan {
  project_id: string;
  plan_id: string;
  epic_id: string;
  gate_task_id: string | null;
  re_execute_gate_task_id: string | null;
  content: string;
  metadata: string;
  shipped_content: string | null;
  updated_at: string;
}

export interface PlanInsertData {
  epic_id: string;
  gate_task_id?: string | null;
  re_execute_gate_task_id?: string | null;
  content: string;
  metadata?: string | null;
}

export type PlanGetResult = {
  content: string;
  metadata: Record<string, unknown>;
  shipped_content: string | null;
  updated_at: string;
};

export type PlanGetByEpicIdResult = {
  plan_id: string;
  content: string;
  metadata: Record<string, unknown>;
  shipped_content: string | null;
  updated_at: string;
};

export class PlanStore {
  constructor(private getClient: () => DbClient) {}

  async planInsert(projectId: string, planId: string, data: PlanInsertData): Promise<void> {
    const client = this.getClient();
    const now = new Date().toISOString();
    await client.execute(
      toPgParams(
        `INSERT INTO plans (project_id, plan_id, epic_id, gate_task_id, re_execute_gate_task_id, content, metadata, shipped_content, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`
      ),
      [
        projectId,
        planId,
        data.epic_id,
        data.gate_task_id ?? null,
        data.re_execute_gate_task_id ?? null,
        data.content,
        data.metadata ?? null,
        now,
      ]
    );
  }

  async planGet(projectId: string, planId: string): Promise<PlanGetResult | null> {
    const client = this.getClient();
    const row = await client.queryOne(
      toPgParams(
        "SELECT content, metadata, shipped_content, updated_at FROM plans WHERE project_id = ? AND plan_id = ?"
      ),
      [projectId, planId]
    );
    if (!row) return null;
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse((row.metadata as string) || "{}") as Record<string, unknown>;
    } catch {
      metadata = {};
    }
    return {
      content: (row.content as string) ?? "",
      metadata,
      shipped_content: (row.shipped_content as string) ?? null,
      updated_at: (row.updated_at as string) ?? "",
    };
  }

  async planGetByEpicId(
    projectId: string,
    epicId: string
  ): Promise<PlanGetByEpicIdResult | null> {
    const client = this.getClient();
    const row = await client.queryOne(
      toPgParams(
        "SELECT plan_id, content, metadata, shipped_content, updated_at FROM plans WHERE project_id = ? AND epic_id = ?"
      ),
      [projectId, epicId]
    );
    if (!row) return null;
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse((row.metadata as string) || "{}") as Record<string, unknown>;
    } catch {
      metadata = {};
    }
    return {
      plan_id: (row.plan_id as string) ?? "",
      content: (row.content as string) ?? "",
      metadata,
      shipped_content: (row.shipped_content as string) ?? null,
      updated_at: (row.updated_at as string) ?? "",
    };
  }

  async planListIds(projectId: string): Promise<string[]> {
    const client = this.getClient();
    const rows = await client.query(
      toPgParams("SELECT plan_id FROM plans WHERE project_id = ? ORDER BY updated_at ASC"),
      [projectId]
    );
    return rows.map((r) => r.plan_id as string);
  }

  async planUpdateContent(projectId: string, planId: string, content: string): Promise<void> {
    const client = this.getClient();
    const existing = await client.queryOne(
      toPgParams("SELECT 1 FROM plans WHERE project_id = ? AND plan_id = ?"),
      [projectId, planId]
    );
    if (!existing) {
      throw new AppError(404, ErrorCodes.PLAN_NOT_FOUND, `Plan ${planId} not found`, { planId });
    }
    const now = new Date().toISOString();
    await client.execute(
      toPgParams("UPDATE plans SET content = ?, updated_at = ? WHERE project_id = ? AND plan_id = ?"),
      [content, now, projectId, planId]
    );
  }

  async planUpdateMetadata(
    projectId: string,
    planId: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    const client = this.getClient();
    const existing = await client.queryOne(
      toPgParams("SELECT 1 FROM plans WHERE project_id = ? AND plan_id = ?"),
      [projectId, planId]
    );
    if (!existing) {
      throw new AppError(404, ErrorCodes.PLAN_NOT_FOUND, `Plan ${planId} not found`, { planId });
    }
    const metaJson = JSON.stringify(metadata);
    const now = new Date().toISOString();
    await client.execute(
      toPgParams("UPDATE plans SET metadata = ?, updated_at = ? WHERE project_id = ? AND plan_id = ?"),
      [metaJson, now, projectId, planId]
    );
  }

  async planSetShippedContent(
    projectId: string,
    planId: string,
    shippedContent: string
  ): Promise<void> {
    const client = this.getClient();
    const existing = await client.queryOne(
      toPgParams("SELECT 1 FROM plans WHERE project_id = ? AND plan_id = ?"),
      [projectId, planId]
    );
    if (!existing) {
      throw new AppError(404, ErrorCodes.PLAN_NOT_FOUND, `Plan ${planId} not found`, { planId });
    }
    await client.execute(
      toPgParams("UPDATE plans SET shipped_content = ? WHERE project_id = ? AND plan_id = ?"),
      [shippedContent, projectId, planId]
    );
  }

  async planGetShippedContent(projectId: string, planId: string): Promise<string | null> {
    const client = this.getClient();
    const row = await client.queryOne(
      toPgParams("SELECT shipped_content FROM plans WHERE project_id = ? AND plan_id = ?"),
      [projectId, planId]
    );
    return (row?.shipped_content as string) ?? null;
  }

  async planDelete(projectId: string, planId: string): Promise<boolean> {
    const client = this.getClient();
    const existing = await client.queryOne(
      toPgParams("SELECT 1 FROM plans WHERE project_id = ? AND plan_id = ?"),
      [projectId, planId]
    );
    if (!existing) return false;
    const modified = await client.execute(
      toPgParams("DELETE FROM plans WHERE project_id = ? AND plan_id = ?"),
      [projectId, planId]
    );
    return modified > 0;
  }

  async planDeleteAllForProject(projectId: string): Promise<void> {
    const client = this.getClient();
    await client.execute(toPgParams("DELETE FROM plans WHERE project_id = ?"), [projectId]);
  }
}
