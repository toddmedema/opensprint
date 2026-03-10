import type { DbClient } from "../db/client.js";
import { toPgParams } from "../db/sql-params.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import type { DrizzlePg } from "../db/app-db.js";
import { plansTable } from "../db/drizzle-schema-pg.js";
import { and, eq } from "drizzle-orm";

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
  current_version_number: number;
  last_executed_version_number: number | null;
}

export interface PlanInsertData {
  epic_id: string;
  gate_task_id?: string | null;
  re_execute_gate_task_id?: string | null;
  content: string;
  metadata?: Record<string, unknown> | string | null;
}

export type PlanGetResult = {
  content: string;
  metadata: Record<string, unknown>;
  shipped_content: string | null;
  updated_at: string;
  current_version_number: number;
  last_executed_version_number: number | null;
};

export type PlanGetByEpicIdResult = {
  plan_id: string;
  content: string;
  metadata: Record<string, unknown>;
  shipped_content: string | null;
  updated_at: string;
  current_version_number: number;
  last_executed_version_number: number | null;
};

export class PlanStore {
  constructor(
    private getClient: () => DbClient,
    private getDrizzle?: () => Promise<DrizzlePg | null>
  ) {}

  private serializeMetadata(metadata: PlanInsertData["metadata"]): string {
    if (metadata == null) return "{}";
    if (typeof metadata === "string") return metadata;
    return JSON.stringify(metadata);
  }

  /**
   * Metadata is stored as JSON text. Older rows can be double-encoded
   * (`"{\"planId\":\"...\"}"`) due to a previous write bug, so decode up to 2 layers.
   */
  private parseMetadata(raw: unknown): Record<string, unknown> {
    let value: unknown = raw ?? "{}";
    for (let i = 0; i < 2; i++) {
      if (typeof value === "string") {
        const text = value.trim();
        if (!text) return {};
        try {
          value = JSON.parse(text);
        } catch {
          return {};
        }
        continue;
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
      return {};
    }
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  async planInsert(projectId: string, planId: string, data: PlanInsertData): Promise<void> {
    const db = this.getDrizzle ? await this.getDrizzle() : null;
    const now = new Date().toISOString();
    const metadataJson = this.serializeMetadata(data.metadata);
    if (db) {
      await db.insert(plansTable).values({
        projectId,
        planId,
        epicId: data.epic_id,
        gateTaskId: data.gate_task_id ?? null,
        reExecuteGateTaskId: data.re_execute_gate_task_id ?? null,
        content: data.content,
        metadata: metadataJson,
        shippedContent: null,
        updatedAt: now,
        currentVersionNumber: 1,
        lastExecutedVersionNumber: null,
      });
      return;
    }
    const client = this.getClient();
    await client.execute(
      toPgParams(
        `INSERT INTO plans (project_id, plan_id, epic_id, gate_task_id, re_execute_gate_task_id, content, metadata, shipped_content, updated_at, current_version_number, last_executed_version_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, NULL)`
      ),
      [
        projectId,
        planId,
        data.epic_id,
        data.gate_task_id ?? null,
        data.re_execute_gate_task_id ?? null,
        data.content,
        metadataJson,
        now,
      ]
    );
  }

  async planGet(projectId: string, planId: string): Promise<PlanGetResult | null> {
    const db = this.getDrizzle ? await this.getDrizzle() : null;
    if (db) {
      const rows = await db
        .select({
          content: plansTable.content,
          metadata: plansTable.metadata,
          shippedContent: plansTable.shippedContent,
          updatedAt: plansTable.updatedAt,
          currentVersionNumber: plansTable.currentVersionNumber,
          lastExecutedVersionNumber: plansTable.lastExecutedVersionNumber,
        })
        .from(plansTable)
        .where(and(eq(plansTable.projectId, projectId), eq(plansTable.planId, planId)))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      const metadata = this.parseMetadata(row.metadata);
      return {
        content: row.content ?? "",
        metadata,
        shipped_content: row.shippedContent ?? null,
        updated_at: row.updatedAt ?? "",
        current_version_number: row.currentVersionNumber ?? 1,
        last_executed_version_number: row.lastExecutedVersionNumber ?? null,
      };
    }
    const client = this.getClient();
    const row = await client.queryOne(
      toPgParams(
        "SELECT content, metadata, shipped_content, updated_at, current_version_number, last_executed_version_number FROM plans WHERE project_id = ? AND plan_id = ?"
      ),
      [projectId, planId]
    );
    if (!row) return null;
    const metadata = this.parseMetadata(row.metadata);
    return {
      content: (row.content as string) ?? "",
      metadata,
      shipped_content: (row.shipped_content as string) ?? null,
      updated_at: (row.updated_at as string) ?? "",
      current_version_number: row.current_version_number != null ? Number(row.current_version_number) : 1,
      last_executed_version_number: row.last_executed_version_number != null ? Number(row.last_executed_version_number) : null,
    };
  }

  async planGetByEpicId(projectId: string, epicId: string): Promise<PlanGetByEpicIdResult | null> {
    const db = this.getDrizzle ? await this.getDrizzle() : null;
    if (db) {
      const rows = await db
        .select({
          planId: plansTable.planId,
          content: plansTable.content,
          metadata: plansTable.metadata,
          shippedContent: plansTable.shippedContent,
          updatedAt: plansTable.updatedAt,
          currentVersionNumber: plansTable.currentVersionNumber,
          lastExecutedVersionNumber: plansTable.lastExecutedVersionNumber,
        })
        .from(plansTable)
        .where(and(eq(plansTable.projectId, projectId), eq(plansTable.epicId, epicId)))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      const metadata = this.parseMetadata(row.metadata);
      return {
        plan_id: row.planId ?? "",
        content: row.content ?? "",
        metadata,
        shipped_content: row.shippedContent ?? null,
        updated_at: row.updatedAt ?? "",
        current_version_number: row.currentVersionNumber ?? 1,
        last_executed_version_number: row.lastExecutedVersionNumber ?? null,
      };
    }
    const client = this.getClient();
    const row = await client.queryOne(
      toPgParams(
        "SELECT plan_id, content, metadata, shipped_content, updated_at, current_version_number, last_executed_version_number FROM plans WHERE project_id = ? AND epic_id = ?"
      ),
      [projectId, epicId]
    );
    if (!row) return null;
    const metadata = this.parseMetadata(row.metadata);
    return {
      plan_id: (row.plan_id as string) ?? "",
      content: (row.content as string) ?? "",
      metadata,
      shipped_content: (row.shipped_content as string) ?? null,
      updated_at: (row.updated_at as string) ?? "",
      current_version_number: row.current_version_number != null ? Number(row.current_version_number) : 1,
      last_executed_version_number: row.last_executed_version_number != null ? Number(row.last_executed_version_number) : null,
    };
  }

  async planListIds(projectId: string): Promise<string[]> {
    const db = this.getDrizzle ? await this.getDrizzle() : null;
    if (db) {
      const rows = await db
        .select({ planId: plansTable.planId })
        .from(plansTable)
        .where(eq(plansTable.projectId, projectId))
        .orderBy(plansTable.updatedAt);
      return rows.map((r) => r.planId);
    }
    const client = this.getClient();
    const rows = await client.query(
      toPgParams("SELECT plan_id FROM plans WHERE project_id = ? ORDER BY updated_at ASC"),
      [projectId]
    );
    return rows.map((r) => r.plan_id as string);
  }

  async planUpdateContent(
    projectId: string,
    planId: string,
    content: string,
    currentVersionNumber?: number
  ): Promise<void> {
    const db = this.getDrizzle ? await this.getDrizzle() : null;
    const now = new Date().toISOString();
    if (db) {
      const setPayload: { content: string; updatedAt: string; currentVersionNumber?: number } = {
        content,
        updatedAt: now,
      };
      if (currentVersionNumber != null) {
        setPayload.currentVersionNumber = currentVersionNumber;
      }
      const result = await db
        .update(plansTable)
        .set(setPayload)
        .where(and(eq(plansTable.projectId, projectId), eq(plansTable.planId, planId)));
      if (result.rowCount === 0) {
        throw new AppError(404, ErrorCodes.PLAN_NOT_FOUND, `Plan ${planId} not found`, { planId });
      }
      return;
    }
    const client = this.getClient();
    const existing = await client.queryOne(
      toPgParams("SELECT 1 FROM plans WHERE project_id = ? AND plan_id = ?"),
      [projectId, planId]
    );
    if (!existing) {
      throw new AppError(404, ErrorCodes.PLAN_NOT_FOUND, `Plan ${planId} not found`, { planId });
    }
    if (currentVersionNumber != null) {
      await client.execute(
        toPgParams(
          "UPDATE plans SET content = ?, updated_at = ?, current_version_number = ? WHERE project_id = ? AND plan_id = ?"
        ),
        [content, now, currentVersionNumber, projectId, planId]
      );
    } else {
      await client.execute(
        toPgParams(
          "UPDATE plans SET content = ?, updated_at = ? WHERE project_id = ? AND plan_id = ?"
        ),
        [content, now, projectId, planId]
      );
    }
  }

  async planUpdateMetadata(
    projectId: string,
    planId: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    const db = this.getDrizzle ? await this.getDrizzle() : null;
    if (db) {
      const result = await db
        .update(plansTable)
        .set({
          metadata: JSON.stringify(metadata),
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(plansTable.projectId, projectId), eq(plansTable.planId, planId)));
      if (result.rowCount === 0) {
        throw new AppError(404, ErrorCodes.PLAN_NOT_FOUND, `Plan ${planId} not found`, { planId });
      }
      return;
    }
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
      toPgParams(
        "UPDATE plans SET metadata = ?, updated_at = ? WHERE project_id = ? AND plan_id = ?"
      ),
      [metaJson, now, projectId, planId]
    );
  }

  /** Update current_version_number and/or last_executed_version_number. Only provided fields are updated. */
  async planUpdateVersionNumbers(
    projectId: string,
    planId: string,
    updates: { current_version_number?: number; last_executed_version_number?: number | null }
  ): Promise<void> {
    const existing = await this.planGet(projectId, planId);
    if (!existing) {
      throw new AppError(404, ErrorCodes.PLAN_NOT_FOUND, `Plan ${planId} not found`, { planId });
    }
    const current_version_number =
      updates.current_version_number !== undefined
        ? updates.current_version_number
        : existing.current_version_number;
    const last_executed_version_number =
      updates.last_executed_version_number !== undefined
        ? updates.last_executed_version_number
        : existing.last_executed_version_number;

    const db = this.getDrizzle ? await this.getDrizzle() : null;
    if (db) {
      const result = await db
        .update(plansTable)
        .set({
          currentVersionNumber: current_version_number,
          lastExecutedVersionNumber: last_executed_version_number,
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(plansTable.projectId, projectId), eq(plansTable.planId, planId)));
      if (result.rowCount === 0) {
        throw new AppError(404, ErrorCodes.PLAN_NOT_FOUND, `Plan ${planId} not found`, { planId });
      }
      return;
    }
    const client = this.getClient();
    await client.execute(
      toPgParams(
        "UPDATE plans SET current_version_number = ?, last_executed_version_number = ?, updated_at = ? WHERE project_id = ? AND plan_id = ?"
      ),
      [current_version_number, last_executed_version_number, new Date().toISOString(), projectId, planId]
    );
  }

  async planSetShippedContent(
    projectId: string,
    planId: string,
    shippedContent: string
  ): Promise<void> {
    const db = this.getDrizzle ? await this.getDrizzle() : null;
    if (db) {
      const result = await db
        .update(plansTable)
        .set({ shippedContent })
        .where(and(eq(plansTable.projectId, projectId), eq(plansTable.planId, planId)));
      if (result.rowCount === 0) {
        throw new AppError(404, ErrorCodes.PLAN_NOT_FOUND, `Plan ${planId} not found`, { planId });
      }
      return;
    }
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
    const db = this.getDrizzle ? await this.getDrizzle() : null;
    if (db) {
      const rows = await db
        .select({ shippedContent: plansTable.shippedContent })
        .from(plansTable)
        .where(and(eq(plansTable.projectId, projectId), eq(plansTable.planId, planId)))
        .limit(1);
      return rows[0]?.shippedContent ?? null;
    }
    const client = this.getClient();
    const row = await client.queryOne(
      toPgParams("SELECT shipped_content FROM plans WHERE project_id = ? AND plan_id = ?"),
      [projectId, planId]
    );
    return (row?.shipped_content as string) ?? null;
  }

  async planDelete(projectId: string, planId: string): Promise<boolean> {
    const db = this.getDrizzle ? await this.getDrizzle() : null;
    if (db) {
      const result = await db
        .delete(plansTable)
        .where(and(eq(plansTable.projectId, projectId), eq(plansTable.planId, planId)));
      return (result.rowCount ?? 0) > 0;
    }
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
    const db = this.getDrizzle ? await this.getDrizzle() : null;
    if (db) {
      await db.delete(plansTable).where(eq(plansTable.projectId, projectId));
      return;
    }
    const client = this.getClient();
    await client.execute(toPgParams("DELETE FROM plans WHERE project_id = ?"), [projectId]);
  }
}
