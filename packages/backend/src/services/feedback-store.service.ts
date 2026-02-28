/**
 * SQL-backed feedback and feedback inbox store.
 * Uses ~/.opensprint/tasks.db (feedback + feedback_inbox tables).
 * Images are stored under ~/.opensprint/feedback-assets/<project_id>/<feedback_id>/.
 */

import path from "path";
import fs from "fs/promises";
import type { FeedbackItem, ProposedTask } from "@opensprint/shared";
import { taskStore } from "./task-store.service.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { createLogger } from "../utils/logger.js";
import { toPgParams } from "../db/sql-params.js";

const log = createLogger("feedback-store");

function getFeedbackAssetsBaseDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return path.join(home, ".opensprint", "feedback-assets");
}

function getFeedbackAssetsDir(projectId: string, feedbackId: string): string {
  return path.join(getFeedbackAssetsBaseDir(), projectId, feedbackId);
}

function getFeedbackAssetsProjectDir(projectId: string): string {
  return path.join(getFeedbackAssetsBaseDir(), projectId);
}

/**
 * Delete all feedback asset images for a project from ~/.opensprint/feedback-assets/<project_id>/.
 * Call when deleting a project to remove all project-keyed data from global storage.
 */
export async function deleteFeedbackAssetsForProject(projectId: string): Promise<void> {
  const dir = getFeedbackAssetsProjectDir(projectId);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("Failed to delete feedback assets for project", { projectId, err });
    }
  }
}

/** Ensure status is pending, resolved, or cancelled. */
function ensureStatus(s: string): "pending" | "resolved" | "cancelled" {
  if (s === "resolved" || s === "cancelled") return s;
  return "pending";
}

/** Row from feedback table (snake_case). */
interface FeedbackRow {
  id: string;
  project_id: string;
  text: string;
  category: string;
  mapped_plan_id: string | null;
  created_task_ids: string;
  status: string;
  created_at: string;
  task_titles: string | null;
  proposed_tasks: string | null;
  mapped_epic_id: string | null;
  is_scope_change: number | null;
  feedback_source_task_id: string | null;
  parent_id: string | null;
  depth: number | null;
  user_priority: number | null;
  image_paths: string | null;
  extra: string | null;
}

function rowToItem(row: FeedbackRow): FeedbackItem {
  const createdTaskIds: string[] = JSON.parse(row.created_task_ids || "[]");
  const taskTitles = row.task_titles ? (JSON.parse(row.task_titles) as string[]) : undefined;
  const proposedTasks = row.proposed_tasks
    ? (JSON.parse(row.proposed_tasks) as ProposedTask[])
    : undefined;
  const extra = row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : undefined;

  return {
    id: row.id,
    text: row.text,
    category: row.category as FeedbackItem["category"],
    mappedPlanId: row.mapped_plan_id ?? null,
    createdTaskIds,
    status: ensureStatus(row.status),
    createdAt: row.created_at,
    ...(taskTitles?.length && { taskTitles }),
    ...(proposedTasks?.length && { proposedTasks }),
    ...(row.mapped_epic_id != null && { mappedEpicId: row.mapped_epic_id }),
    ...(row.is_scope_change != null && { isScopeChange: Boolean(row.is_scope_change) }),
    ...(row.feedback_source_task_id && { feedbackSourceTaskId: row.feedback_source_task_id }),
    parent_id: row.parent_id ?? null,
    ...(row.depth != null && { depth: row.depth }),
    ...(row.user_priority != null && { userPriority: row.user_priority }),
    ...(extra && Object.keys(extra).length > 0 && { ...extra }),
  };
}

function itemToRow(item: FeedbackItem, projectId: string): Record<string, unknown> {
  return {
    id: item.id,
    project_id: projectId,
    text: item.text,
    category: item.category,
    mapped_plan_id: item.mappedPlanId ?? null,
    created_task_ids: JSON.stringify(item.createdTaskIds ?? []),
    status: item.status,
    created_at: item.createdAt,
    task_titles: item.taskTitles ? JSON.stringify(item.taskTitles) : null,
    proposed_tasks: item.proposedTasks ? JSON.stringify(item.proposedTasks) : null,
    mapped_epic_id: item.mappedEpicId ?? null,
    is_scope_change: item.isScopeChange != null ? (item.isScopeChange ? 1 : 0) : null,
    feedback_source_task_id: item.feedbackSourceTaskId ?? null,
    parent_id: item.parent_id ?? null,
    depth: item.depth ?? null,
    user_priority: item.userPriority ?? null,
    extra:
      item.linkInvalidRetryCount != null
        ? JSON.stringify({ linkInvalidRetryCount: item.linkInvalidRetryCount })
        : "{}",
  };
}

/**
 * Write base64 image data to feedback-assets dir and return relative filenames.
 * images: array of data URLs or raw base64.
 */
export async function writeFeedbackImages(
  projectId: string,
  feedbackId: string,
  images: string[]
): Promise<string[]> {
  if (images.length === 0) return [];
  const dir = getFeedbackAssetsDir(projectId, feedbackId);
  await fs.mkdir(dir, { recursive: true });
  const filenames: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i]!;
    let buf: Buffer;
    let ext = "png";
    if (img.startsWith("data:")) {
      const match = img.match(/^data:image\/(\w+);base64,/);
      if (match) ext = match[1]!.replace("jpeg", "jpg");
      const base64 = img.includes(",") ? img.split(",")[1] : img;
      buf = Buffer.from(base64!, "base64");
    } else {
      buf = Buffer.from(img, "base64");
    }
    const filename = `${i}.${ext}`;
    await fs.writeFile(path.join(dir, filename), buf);
    filenames.push(filename);
  }
  return filenames;
}

/**
 * Load image files from feedback-assets dir and return as data URLs for FeedbackItem.images.
 */
export async function loadFeedbackImages(
  projectId: string,
  feedbackId: string,
  imagePaths: string[] | null
): Promise<string[]> {
  if (!imagePaths?.length) return [];
  const dir = getFeedbackAssetsDir(projectId, feedbackId);
  const out: string[] = [];
  for (const rel of imagePaths) {
    try {
      const full = path.join(dir, rel);
      const buf = await fs.readFile(full);
      const ext = path.extname(rel).slice(1).replace("jpg", "jpeg");
      out.push(`data:image/${ext};base64,${buf.toString("base64")}`);
    } catch {
      // Skip missing/corrupt file
    }
  }
  return out;
}

export class FeedbackStoreService {
  /** Generate unique feedback ID (check DB for collision). */
  async generateUniqueFeedbackId(projectId: string): Promise<string> {
    const { generateShortFeedbackId } = await import("../utils/feedback-id.js");
    const MAX_RETRIES = 10;
    for (let i = 0; i < MAX_RETRIES; i++) {
      const id = generateShortFeedbackId();
      const client = await taskStore.getDb();
      const row = await client.queryOne(
        toPgParams("SELECT 1 FROM feedback WHERE id = ? AND project_id = ? LIMIT 1"),
        [id, projectId]
      );
      if (!row) return id;
    }
    throw new Error("Failed to generate unique feedback ID after retries");
  }

  async insertFeedback(
    projectId: string,
    item: FeedbackItem,
    imagePaths: string[] | null
  ): Promise<void> {
    const row = itemToRow(item, projectId) as Record<string, unknown> & {
      image_paths: string | null;
    };
    row.image_paths = imagePaths ? JSON.stringify(imagePaths) : null;

    await taskStore.runWrite(async (client) => {
      await client.execute(
        toPgParams(
          `INSERT INTO feedback (
          id, project_id, text, category, mapped_plan_id, created_task_ids, status, created_at,
          task_titles, proposed_tasks, mapped_epic_id, is_scope_change, feedback_source_task_id,
          parent_id, depth, user_priority, image_paths, extra
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ),
        [
          row.id,
          row.project_id,
          row.text,
          row.category,
          row.mapped_plan_id,
          row.created_task_ids,
          row.status,
          row.created_at,
          row.task_titles,
          row.proposed_tasks,
          row.mapped_epic_id,
          row.is_scope_change,
          row.feedback_source_task_id,
          row.parent_id,
          row.depth,
          row.user_priority,
          row.image_paths,
          row.extra ?? "{}",
        ]
      );
    });
  }

  async updateFeedback(projectId: string, item: FeedbackItem): Promise<void> {
    const row = itemToRow(item, projectId);
    const client = await taskStore.getDb();
    await client.queryOne(
      toPgParams("SELECT image_paths FROM feedback WHERE id = ? AND project_id = ?"),
      [item.id, projectId]
    );

    await taskStore.runWrite(async (tx) => {
      await tx.execute(
        toPgParams(
          `UPDATE feedback SET
          text = ?, category = ?, mapped_plan_id = ?, created_task_ids = ?, status = ?,
          task_titles = ?, proposed_tasks = ?, mapped_epic_id = ?, is_scope_change = ?,
          feedback_source_task_id = ?, parent_id = ?, depth = ?, user_priority = ?, extra = ?
        WHERE id = ? AND project_id = ?`
        ),
        [
          row.text,
          row.category,
          row.mapped_plan_id,
          row.created_task_ids,
          row.status,
          row.task_titles,
          row.proposed_tasks,
          row.mapped_epic_id,
          row.is_scope_change,
          row.feedback_source_task_id,
          row.parent_id,
          row.depth,
          row.user_priority,
          row.extra ?? "{}",
          item.id,
          projectId,
        ]
      );
    });
  }

  async getFeedbackRow(projectId: string, feedbackId: string): Promise<FeedbackRow | null> {
    const client = await taskStore.getDb();
    const row = await client.queryOne(
      toPgParams("SELECT * FROM feedback WHERE id = ? AND project_id = ?"),
      [feedbackId, projectId]
    );
    return row ? (row as unknown as FeedbackRow) : null;
  }

  async getFeedback(projectId: string, feedbackId: string): Promise<FeedbackItem> {
    const row = await this.getFeedbackRow(projectId, feedbackId);
    if (!row) {
      throw new AppError(404, ErrorCodes.FEEDBACK_NOT_FOUND, `Feedback '${feedbackId}' not found`, {
        feedbackId,
      });
    }
    const item = rowToItem(row);
    const paths: string[] = row.image_paths ? JSON.parse(row.image_paths) : [];
    item.images = await loadFeedbackImages(projectId, feedbackId, paths.length ? paths : null);
    return item;
  }

  async listFeedback(projectId: string): Promise<FeedbackItem[]>;
  async listFeedback(
    projectId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<FeedbackItem[] | { items: FeedbackItem[]; total: number }>;
  async listFeedback(
    projectId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<FeedbackItem[] | { items: FeedbackItem[]; total: number }> {
    const client = await taskStore.getDb();
    const limit = options?.limit;
    const offset = options?.offset ?? 0;

    if (limit != null) {
      const countRow = await client.queryOne(
        toPgParams("SELECT COUNT(*)::int as cnt FROM feedback WHERE project_id = ?"),
        [projectId]
      );
      const total = (countRow?.cnt as number) ?? 0;

      const safeLimit = Math.max(1, Math.min(500, limit));
      const safeOffset = Math.max(0, offset);
      const rows = await client.query(
        toPgParams("SELECT * FROM feedback WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"),
        [projectId, safeLimit, safeOffset]
      );

      const items: FeedbackItem[] = [];
      for (const row of rows as unknown as FeedbackRow[]) {
        const item = rowToItem(row);
        const paths: string[] = row.image_paths ? JSON.parse(row.image_paths) : [];
        item.images = await loadFeedbackImages(projectId, row.id, paths.length ? paths : null);
        items.push(item);
      }
      return { items, total };
    }

    const rows = await client.query(
      toPgParams("SELECT * FROM feedback WHERE project_id = ? ORDER BY created_at DESC"),
      [projectId]
    );

    const items: FeedbackItem[] = [];
    for (const row of rows as unknown as FeedbackRow[]) {
      const item = rowToItem(row);
      const paths: string[] = row.image_paths ? JSON.parse(row.image_paths) : [];
      item.images = await loadFeedbackImages(projectId, row.id, paths.length ? paths : null);
      items.push(item);
    }
    return items;
  }

  // ─── Inbox ───

  async enqueueForCategorization(projectId: string, feedbackId: string): Promise<void> {
    const existing = await this.listPendingFeedbackIds(projectId);
    if (existing.includes(feedbackId)) return;
    await taskStore.runWrite(async (client) => {
      await client.execute(
        toPgParams(
          "INSERT INTO feedback_inbox (project_id, feedback_id, enqueued_at) VALUES (?, ?, ?) ON CONFLICT (project_id, feedback_id) DO NOTHING"
        ),
        [projectId, feedbackId, new Date().toISOString()]
      );
    });
    log.info("Enqueued feedback for Analyst", { projectId, feedbackId });
  }

  async getNextPendingFeedbackId(projectId: string): Promise<string | null> {
    const client = await taskStore.getDb();
    const row = await client.queryOne(
      toPgParams(
        "SELECT feedback_id FROM feedback_inbox WHERE project_id = ? ORDER BY enqueued_at ASC LIMIT 1"
      ),
      [projectId]
    );
    return row ? (row.feedback_id as string) : null;
  }

  /**
   * Atomically claim and remove the next pending feedback from the inbox.
   * Returns the feedback_id if one was claimed, null if inbox empty.
   * Prevents duplicate processing when multiple orchestrator loops race to process the same feedback.
   */
  async claimNextPendingFeedbackId(projectId: string): Promise<string | null> {
    let claimedId: string | null = null;
    await taskStore.runWrite(async (client) => {
      const row = await client.queryOne(
        toPgParams(
          "SELECT feedback_id FROM feedback_inbox WHERE project_id = ? ORDER BY enqueued_at ASC LIMIT 1"
        ),
        [projectId]
      );
      if (row) {
        claimedId = row.feedback_id as string;
        await client.execute(
          toPgParams("DELETE FROM feedback_inbox WHERE project_id = ? AND feedback_id = ?"),
          [projectId, claimedId]
        );
        log.info("Claimed feedback from inbox for Analyst", { projectId, feedbackId: claimedId });
      }
    });
    return claimedId;
  }

  async removeFromInbox(projectId: string, feedbackId: string): Promise<void> {
    await taskStore.runWrite(async (client) => {
      await client.execute(
        toPgParams("DELETE FROM feedback_inbox WHERE project_id = ? AND feedback_id = ?"),
        [projectId, feedbackId]
      );
    });
    log.info("Removed feedback from inbox (processed)", { projectId, feedbackId });
  }

  async listPendingFeedbackIds(projectId: string): Promise<string[]> {
    const client = await taskStore.getDb();
    const rows = await client.query(
      toPgParams("SELECT feedback_id FROM feedback_inbox WHERE project_id = ? ORDER BY enqueued_at ASC"),
      [projectId]
    );
    return rows.map((r) => r.feedback_id as string);
  }
}

export const feedbackStore = new FeedbackStoreService();
