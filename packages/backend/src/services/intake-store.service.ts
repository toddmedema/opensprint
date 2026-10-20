/**
 * SQL-backed store for intake_items table.
 * Provides CRUD, filtering, and idempotent upsert for normalized intake items.
 */

import { randomUUID } from "node:crypto";
import type {
  IntegrationProvider,
  IntakeItem,
  IntakeTriageStatus,
  IntakeTriageSuggestion,
  IntakeListFilters,
} from "@opensprint/shared";
import { taskStore } from "./task-store.service.js";

interface IntakeItemRow {
  id: string;
  project_id: string;
  provider: string;
  external_item_id: string;
  source_ref: string | null;
  title: string;
  body: string | null;
  author: string | null;
  labels: string;
  triage_status: string;
  triage_suggestion: string | null;
  converted_feedback_id: string | null;
  converted_task_id: string | null;
  external_created_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToItem(row: IntakeItemRow): IntakeItem {
  let labels: string[] = [];
  try {
    labels = JSON.parse(row.labels);
  } catch {
    /* default empty */
  }

  let suggestion: IntakeTriageSuggestion | null = null;
  if (row.triage_suggestion) {
    try {
      suggestion = JSON.parse(row.triage_suggestion) as IntakeTriageSuggestion;
    } catch {
      /* null */
    }
  }

  return {
    id: row.id,
    project_id: row.project_id,
    provider: row.provider as IntegrationProvider,
    external_item_id: row.external_item_id,
    source_ref: row.source_ref,
    title: row.title,
    body: row.body,
    author: row.author,
    labels,
    triage_status: row.triage_status as IntakeTriageStatus,
    triage_suggestion: suggestion,
    converted_feedback_id: row.converted_feedback_id,
    converted_task_id: row.converted_task_id,
    external_created_at: row.external_created_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class IntakeStoreService {
  /**
   * Upsert an intake item. Returns the item and whether it was newly created.
   * Duplicate items (same project+provider+external_item_id) are skipped.
   */
  async upsertItem(data: {
    project_id: string;
    provider: IntegrationProvider;
    external_item_id: string;
    title: string;
    body?: string | null;
    author?: string | null;
    labels?: string[];
    source_ref?: string | null;
    external_created_at?: string | null;
  }): Promise<{ item: IntakeItem; created: boolean }> {
    const now = new Date().toISOString();
    const id = randomUUID();
    let created = false;
    let result: IntakeItem | null = null;

    await taskStore.runWrite(async (client) => {
      const existing = await client.queryOne(
        `SELECT * FROM intake_items
         WHERE project_id = $1 AND provider = $2 AND external_item_id = $3`,
        [data.project_id, data.provider, data.external_item_id]
      );

      if (existing) {
        result = rowToItem(existing as unknown as IntakeItemRow);
        created = false;
        return;
      }

      await client.execute(
        `INSERT INTO intake_items (
          id, project_id, provider, external_item_id, source_ref,
          title, body, author, labels, triage_status,
          external_created_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          id,
          data.project_id,
          data.provider,
          data.external_item_id,
          data.source_ref ?? null,
          data.title,
          data.body ?? null,
          data.author ?? null,
          JSON.stringify(data.labels ?? []),
          "new",
          data.external_created_at ?? null,
          now,
          now,
        ]
      );

      const inserted = await client.queryOne("SELECT * FROM intake_items WHERE id = $1", [id]);
      result = inserted ? rowToItem(inserted as unknown as IntakeItemRow) : null;
      created = true;
    });

    if (!result) throw new Error("Failed to upsert intake item");
    return { item: result, created };
  }

  async getItemForProject(projectId: string, id: string): Promise<IntakeItem | null> {
    const client = await taskStore.getDb();
    const row = await client.queryOne(
      "SELECT * FROM intake_items WHERE id = $1 AND project_id = $2",
      [id, projectId]
    );
    return row ? rowToItem(row as unknown as IntakeItemRow) : null;
  }

  async getItem(id: string): Promise<IntakeItem | null> {
    const client = await taskStore.getDb();
    const row = await client.queryOne("SELECT * FROM intake_items WHERE id = $1", [id]);
    return row ? rowToItem(row as unknown as IntakeItemRow) : null;
  }

  async listItems(
    projectId: string,
    filters?: IntakeListFilters
  ): Promise<{ items: IntakeItem[]; total: number }> {
    const client = await taskStore.getDb();
    const conditions: string[] = ["project_id = $1"];
    const params: unknown[] = [projectId];
    let paramIdx = 2;

    if (filters?.provider) {
      conditions.push(`provider = $${paramIdx}`);
      params.push(filters.provider);
      paramIdx++;
    }

    if (filters?.triageStatus) {
      conditions.push(`triage_status = $${paramIdx}`);
      params.push(filters.triageStatus);
      paramIdx++;
    }

    if (filters?.search) {
      conditions.push(`(title LIKE $${paramIdx} OR body LIKE $${paramIdx})`);
      params.push(`%${filters.search}%`);
      paramIdx++;
    }

    const where = conditions.join(" AND ");

    const countRow = await client.queryOne(
      `SELECT COUNT(*) as cnt FROM intake_items WHERE ${where}`,
      params
    );
    const total = Number((countRow as { cnt: number | string })?.cnt ?? 0);

    const limit = filters?.limit ?? 50;
    const offset = filters?.offset ?? 0;

    const rows = await client.query(
      `SELECT * FROM intake_items WHERE ${where}
       ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    );

    return {
      items: (rows as unknown as IntakeItemRow[]).map(rowToItem),
      total,
    };
  }

  async updateTriageStatusForProject(
    projectId: string,
    id: string,
    status: IntakeTriageStatus
  ): Promise<IntakeItem | null> {
    return this.updateTriageStatus(id, status, undefined, projectId);
  }

  async updateTriageStatus(
    id: string,
    status: IntakeTriageStatus,
    extra?: {
      converted_feedback_id?: string;
      converted_task_id?: string;
    },
    projectId?: string
  ): Promise<IntakeItem | null> {
    const now = new Date().toISOString();
    await taskStore.runWrite(async (client) => {
      await client.execute(
        `UPDATE intake_items SET
          triage_status = $1,
          converted_feedback_id = COALESCE($2, converted_feedback_id),
          converted_task_id = COALESCE($3, converted_task_id),
          updated_at = $4
        WHERE id = $5${projectId === undefined ? "" : " AND project_id = $6"}`,
        [
          status,
          extra?.converted_feedback_id ?? null,
          extra?.converted_task_id ?? null,
          now,
          id,
          ...(projectId === undefined ? [] : [projectId]),
        ]
      );
    });
    return projectId === undefined ? this.getItem(id) : this.getItemForProject(projectId, id);
  }

  async updateTriageSuggestion(
    id: string,
    suggestion: IntakeTriageSuggestion
  ): Promise<IntakeItem | null> {
    const now = new Date().toISOString();
    await taskStore.runWrite(async (client) => {
      await client.execute(
        `UPDATE intake_items SET
          triage_suggestion = $1,
          triage_status = CASE WHEN triage_status = 'new' THEN 'triaged' ELSE triage_status END,
          updated_at = $2
        WHERE id = $3`,
        [JSON.stringify(suggestion), now, id]
      );
    });
    return this.getItem(id);
  }
}

export const intakeStore = new IntakeStoreService();
