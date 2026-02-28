/**
 * NotificationService — manages open questions (agent clarification requests)
 * and API-blocked human notifications (rate limit, auth, out of credit).
 * Persisted in ~/.opensprint/tasks.db (open_questions table).
 */

import crypto from "crypto";
import { taskStore } from "./task-store.service.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { createLogger } from "../utils/logger.js";
import type { ApiBlockedErrorCode } from "@opensprint/shared";

const log = createLogger("notification");

export type NotificationSource = "plan" | "prd" | "execute" | "eval";

export interface OpenQuestionItem {
  id: string;
  text: string;
  createdAt: string;
}

export interface Notification {
  id: string;
  projectId: string;
  source: NotificationSource;
  sourceId: string;
  questions: OpenQuestionItem[];
  status: "open" | "resolved";
  createdAt: string;
  resolvedAt: string | null;
  kind?: "open_question" | "api_blocked" | "hil_approval";
  errorCode?: ApiBlockedErrorCode;
}

export interface CreateNotificationInput {
  projectId: string;
  source: NotificationSource;
  sourceId: string;
  questions: Array<{ id: string; text: string; createdAt?: string }>;
}

export interface CreateApiBlockedInput {
  projectId: string;
  source: NotificationSource;
  sourceId: string;
  message: string;
  errorCode: ApiBlockedErrorCode;
}

export interface CreateHilApprovalInput {
  projectId: string;
  source: NotificationSource;
  sourceId: string;
  description: string;
  category: string;
}

function generateId(): string {
  return "oq-" + crypto.randomBytes(4).toString("hex");
}

function rowToNotification(row: Record<string, unknown>): Notification {
  const questions: OpenQuestionItem[] = JSON.parse((row.questions as string) || "[]");
  const kind = (row.kind as "open_question" | "api_blocked" | "hil_approval") || "open_question";
  const errorCode = row.error_code as ApiBlockedErrorCode | undefined;
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    source: row.source as NotificationSource,
    sourceId: row.source_id as string,
    questions,
    status: (row.status as "open" | "resolved") || "open",
    createdAt: row.created_at as string,
    resolvedAt: (row.resolved_at as string) ?? null,
    kind,
    errorCode,
  };
}

export class NotificationService {
  /**
   * Create a new notification (open question) for an agent clarification request.
   */
  async create(input: CreateNotificationInput): Promise<Notification> {
    const id = generateId();
    const createdAt = new Date().toISOString();
    const questions: OpenQuestionItem[] = input.questions.map((q) => ({
      id: q.id,
      text: q.text,
      createdAt: q.createdAt ?? createdAt,
    }));

    await taskStore.runWrite(async (db) => {
      db.run(
        `INSERT INTO open_questions (id, project_id, source, source_id, questions, status, created_at, kind)
         VALUES (?, ?, ?, ?, ?, 'open', ?, 'open_question')`,
        [
          id,
          input.projectId,
          input.source,
          input.sourceId,
          JSON.stringify(questions),
          createdAt,
        ]
      );
    });

    log.info("Created notification", {
      id,
      projectId: input.projectId,
      source: input.source,
      sourceId: input.sourceId,
      questionCount: questions.length,
    });

    return {
      id,
      projectId: input.projectId,
      source: input.source,
      sourceId: input.sourceId,
      questions,
      status: "open",
      createdAt,
      resolvedAt: null,
      kind: "open_question",
    };
  }

  /**
   * Create an API-blocked notification (human-blocked: rate limit, auth, out of credit).
   * Displayed in the notification bell with distinct styling.
   */
  async createApiBlocked(input: CreateApiBlockedInput): Promise<Notification> {
    const id = "ab-" + crypto.randomBytes(4).toString("hex");
    const createdAt = new Date().toISOString();
    const questions: OpenQuestionItem[] = [
      {
        id: `q-${id}`,
        text: input.message,
        createdAt,
      },
    ];

    await taskStore.runWrite(async (db) => {
      db.run(
        `INSERT INTO open_questions (id, project_id, source, source_id, questions, status, created_at, kind, error_code)
         VALUES (?, ?, ?, ?, ?, 'open', ?, 'api_blocked', ?)`,
        [
          id,
          input.projectId,
          input.source,
          input.sourceId,
          JSON.stringify(questions),
          createdAt,
          input.errorCode,
        ]
      );
    });

    log.info("Created API-blocked notification", {
      id,
      projectId: input.projectId,
      source: input.source,
      sourceId: input.sourceId,
      errorCode: input.errorCode,
    });

    return {
      id,
      projectId: input.projectId,
      source: input.source,
      sourceId: input.sourceId,
      questions,
      status: "open",
      createdAt,
      resolvedAt: null,
      kind: "api_blocked",
      errorCode: input.errorCode,
    };
  }

  /**
   * Create an HIL approval notification (scope change, architecture, etc.).
   * Surfaces in the notification bell; user approves/rejects via Approve/Reject UI.
   */
  async createHilApproval(input: CreateHilApprovalInput): Promise<Notification> {
    const id = "hil-" + crypto.randomBytes(4).toString("hex");
    const createdAt = new Date().toISOString();
    const questions: OpenQuestionItem[] = [
      {
        id: `q-${id}`,
        text: input.description,
        createdAt,
      },
    ];

    await taskStore.runWrite(async (db) => {
      db.run(
        `INSERT INTO open_questions (id, project_id, source, source_id, questions, status, created_at, kind)
         VALUES (?, ?, ?, ?, ?, 'open', ?, 'hil_approval')`,
        [
          id,
          input.projectId,
          input.source,
          input.sourceId,
          JSON.stringify(questions),
          createdAt,
        ]
      );
    });

    log.info("Created HIL approval notification", {
      id,
      projectId: input.projectId,
      source: input.source,
      sourceId: input.sourceId,
      category: input.category,
    });

    return {
      id,
      projectId: input.projectId,
      source: input.source,
      sourceId: input.sourceId,
      questions,
      status: "open",
      createdAt,
      resolvedAt: null,
      kind: "hil_approval",
    };
  }

  /**
   * List unresolved notifications for a project.
   */
  async listByProject(projectId: string): Promise<Notification[]> {
    const db = await taskStore.getDb();
    const stmt = db.prepare(
      "SELECT * FROM open_questions WHERE project_id = ? AND status = 'open' ORDER BY created_at DESC"
    );
    stmt.bind([projectId]);
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as Record<string, unknown>);
    }
    stmt.free();
    return rows.map(rowToNotification);
  }

  /**
   * List unresolved notifications across all projects (global).
   */
  async listGlobal(): Promise<Notification[]> {
    const db = await taskStore.getDb();
    const stmt = db.prepare(
      "SELECT * FROM open_questions WHERE status = 'open' ORDER BY created_at DESC"
    );
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as Record<string, unknown>);
    }
    stmt.free();
    return rows.map(rowToNotification);
  }

  /**
   * Resolve a notification by ID. Project ID is required for scoping.
   */
  async resolve(projectId: string, notificationId: string): Promise<Notification> {
    const db = await taskStore.getDb();
    const stmt = db.prepare(
      "SELECT * FROM open_questions WHERE id = ? AND project_id = ?"
    );
    stmt.bind([notificationId, projectId]);
    const row = stmt.step() ? (stmt.getAsObject() as Record<string, unknown>) : null;
    stmt.free();

    if (!row) {
      throw new AppError(
        404,
        ErrorCodes.NOTIFICATION_NOT_FOUND,
        `Notification '${notificationId}' not found`,
        { notificationId, projectId }
      );
    }

    const resolvedAt = new Date().toISOString();

    await taskStore.runWrite(async (db) => {
      db.run(
        "UPDATE open_questions SET status = 'resolved', resolved_at = ? WHERE id = ? AND project_id = ?",
        [resolvedAt, notificationId, projectId]
      );
    });

    log.info("Resolved notification", { notificationId, projectId });

    const notification = rowToNotification(row);
    return {
      ...notification,
      status: "resolved",
      resolvedAt,
    };
  }

  /**
   * Delete all HIL notifications (open_questions) from storage.
   * Manual utility for testing/cleanup. Returns the number of rows deleted.
   */
  async deleteAll(): Promise<number> {
    const db = await taskStore.getDb();
    const countStmt = db.prepare("SELECT COUNT(*) as cnt FROM open_questions");
    countStmt.step();
    const count = (countStmt.getAsObject() as { cnt: number }).cnt;
    countStmt.free();

    if (count === 0) {
      return 0;
    }

    await taskStore.runWrite(async (db) => {
      db.run("DELETE FROM open_questions");
    });

    log.info("Deleted all HIL notifications", { deletedCount: count });
    return count;
  }
}

export const notificationService = new NotificationService();
