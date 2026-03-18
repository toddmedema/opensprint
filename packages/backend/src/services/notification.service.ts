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
  kind?: "open_question" | "api_blocked" | "hil_approval" | "agent_failed";
  errorCode?: ApiBlockedErrorCode;
  /** For hil_approval + scopeChanges: proposed PRD updates for diff display */
  scopeChangeMetadata?: ScopeChangeMetadata;
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

export interface CreateAgentFailedInput {
  projectId: string;
  source: NotificationSource;
  sourceId: string;
  message: string;
}

export interface ScopeChangeProposedUpdate {
  section: string;
  changeLogEntry?: string;
  content: string;
}

export interface ScopeChangeMetadata {
  scopeChangeSummary: string;
  scopeChangeProposedUpdates: ScopeChangeProposedUpdate[];
}

export interface CreateHilApprovalInput {
  projectId: string;
  source: NotificationSource;
  sourceId: string;
  description: string;
  category: string;
  scopeChangeMetadata?: ScopeChangeMetadata;
}

function generateId(): string {
  return "oq-" + crypto.randomBytes(4).toString("hex");
}

export interface NotificationResponseItem {
  questionId: string;
  answer: string;
}

function rowToNotification(row: Record<string, unknown>): Notification {
  const questions: OpenQuestionItem[] = JSON.parse((row.questions as string) || "[]");
  const kind =
    (row.kind as "open_question" | "api_blocked" | "hil_approval" | "agent_failed") ||
    "open_question";
  const errorCode = row.error_code as ApiBlockedErrorCode | undefined;
  const scopeChangeMetadataRaw = row.scope_change_metadata as string | undefined;
  const scopeChangeMetadata = scopeChangeMetadataRaw
    ? (JSON.parse(scopeChangeMetadataRaw) as ScopeChangeMetadata)
    : undefined;
  const responsesRaw = row.responses as string | undefined;
  const responses: NotificationResponseItem[] | undefined = responsesRaw
    ? (JSON.parse(responsesRaw) as NotificationResponseItem[])
    : undefined;
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
    scopeChangeMetadata,
    ...(responses?.length ? { responses } : {}),
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

    await taskStore.runWrite(async (client) => {
      await client.execute(
        `INSERT INTO open_questions (id, project_id, source, source_id, questions, status, created_at, kind)
         VALUES ($1, $2, $3, $4, $5, 'open', $6, 'open_question')`,
        [id, input.projectId, input.source, input.sourceId, JSON.stringify(questions), createdAt]
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

    const existing = await taskStore.runWrite(async (writeClient) => {
      const existingRows = await writeClient.query(
        `SELECT *
           FROM open_questions
          WHERE project_id = $1
            AND source = $2
            AND source_id = $3
            AND status = 'open'
            AND kind = 'api_blocked'
            AND error_code = $4
          ORDER BY created_at DESC
          LIMIT 1`,
        [input.projectId, input.source, input.sourceId, input.errorCode]
      );
      const row = existingRows[0] as Record<string, unknown> | undefined;
      if (row) {
        return rowToNotification(row);
      }

      await writeClient.execute(
        `INSERT INTO open_questions (id, project_id, source, source_id, questions, status, created_at, kind, error_code)
         VALUES ($1, $2, $3, $4, $5, 'open', $6, 'api_blocked', $7)`,
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
      return null;
    });

    if (existing) return existing;

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
   * Create an agent-failed notification (coding/review run failed with surfaced error).
   * Displayed in the notification bell so the user sees the error without opening the task.
   */
  async createAgentFailed(input: CreateAgentFailedInput): Promise<Notification> {
    const id = "af-" + crypto.randomBytes(4).toString("hex");
    const createdAt = new Date().toISOString();
    const questions: OpenQuestionItem[] = [
      {
        id: `q-${id}`,
        text: input.message.slice(0, 2000),
        createdAt,
      },
    ];

    await taskStore.runWrite(async (client) => {
      await client.execute(
        `INSERT INTO open_questions (id, project_id, source, source_id, questions, status, created_at, kind)
         VALUES ($1, $2, $3, $4, $5, 'open', $6, 'agent_failed')`,
        [id, input.projectId, input.source, input.sourceId, JSON.stringify(questions), createdAt]
      );
    });

    log.info("Created agent-failed notification", {
      id,
      projectId: input.projectId,
      source: input.source,
      sourceId: input.sourceId,
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
      kind: "agent_failed",
    };
  }

  /**
   * Create an HIL approval notification (scope change, architecture, etc.).
   * Surfaces in the notification bell; user approves/rejects via Approve/Reject UI.
   * When scopeChangeMetadata is provided, it is persisted for diff display in the frontend.
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
    const scopeChangeMetadataJson = input.scopeChangeMetadata
      ? JSON.stringify(input.scopeChangeMetadata)
      : null;

    await taskStore.runWrite(async (client) => {
      await client.execute(
        `INSERT INTO open_questions (id, project_id, source, source_id, questions, status, created_at, kind, scope_change_metadata)
         VALUES ($1, $2, $3, $4, $5, 'open', $6, 'hil_approval', $7)`,
        [
          id,
          input.projectId,
          input.source,
          input.sourceId,
          JSON.stringify(questions),
          createdAt,
          scopeChangeMetadataJson,
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
      scopeChangeMetadata: input.scopeChangeMetadata,
    };
  }

  /**
   * Returns true if the project has any open HIL approval request that is PRD/SPEC scope
   * (Harmonizer or scope-change proposed SPEC.md updates). Used by the orchestrator to
   * block task assignment until the user approves or closes the request.
   */
  async hasOpenPrdSpecHilApproval(projectId: string): Promise<boolean> {
    const client = await taskStore.getDb();
    const rows = await client.query(
      `SELECT 1 FROM open_questions
       WHERE project_id = $1 AND status = 'open' AND kind = 'hil_approval'
       AND scope_change_metadata IS NOT NULL
       LIMIT 1`,
      [projectId]
    );
    return rows.length > 0;
  }

  /**
   * List unresolved notifications for a project.
   */
  async listByProject(projectId: string): Promise<Notification[]> {
    const client = await taskStore.getDb();
    const rows = await client.query(
      "SELECT * FROM open_questions WHERE project_id = $1 AND status = 'open' ORDER BY created_at DESC",
      [projectId]
    );
    return rows.map((r) => rowToNotification(r as Record<string, unknown>));
  }

  /**
   * List unresolved notifications across all projects (global).
   */
  async listGlobal(): Promise<Notification[]> {
    const client = await taskStore.getDb();
    const rows = await client.query(
      "SELECT * FROM open_questions WHERE status = 'open' ORDER BY created_at DESC"
    );
    return rows.map((r) => rowToNotification(r as Record<string, unknown>));
  }

  /**
   * Resolve all open rate-limit notifications for a project.
   * Called when the system is demonstrably working (e.g. review agent starts, retry succeeds).
   * Returns the list of resolved notification IDs for broadcasting.
   */
  async resolveRateLimitNotifications(
    projectId: string
  ): Promise<Array<{ id: string; source: NotificationSource; sourceId: string }>> {
    const client = await taskStore.getDb();
    const rows = await client.query(
      `SELECT id, source, source_id FROM open_questions
       WHERE project_id = $1 AND status = 'open' AND kind = 'api_blocked' AND error_code = 'rate_limit'`,
      [projectId]
    );

    if (rows.length === 0) {
      return [];
    }

    const resolvedAt = new Date().toISOString();
    await taskStore.runWrite(async (tx) => {
      await tx.execute(
        `UPDATE open_questions SET status = 'resolved', resolved_at = $1
         WHERE project_id = $2 AND status = 'open' AND kind = 'api_blocked' AND error_code = 'rate_limit'`,
        [resolvedAt, projectId]
      );
    });

    const resolved = rows.map((r) => ({
      id: r.id as string,
      source: r.source as NotificationSource,
      sourceId: r.source_id as string,
    }));
    log.info("Resolved rate limit notifications", {
      projectId,
      count: resolved.length,
      ids: resolved.map((r) => r.id),
    });
    return resolved;
  }

  /**
   * Get the most recently resolved open_question notification for a task (source=execute, sourceId=taskId)
   * that has persisted responses. Used by context assembler to inject user answers into the Coder prompt.
   */
  async getResolvedResponsesForTask(
    projectId: string,
    source: NotificationSource,
    sourceId: string
  ): Promise<NotificationResponseItem[] | null> {
    const client = await taskStore.getDb();
    const row = await client.queryOne(
      `SELECT responses FROM open_questions
       WHERE project_id = $1 AND source = $2 AND source_id = $3 AND status = 'resolved' AND kind = 'open_question' AND responses IS NOT NULL AND responses != ''
       ORDER BY resolved_at DESC LIMIT 1`,
      [projectId, source, sourceId]
    );
    if (!row?.responses) return null;
    try {
      const parsed = JSON.parse(row.responses as string) as NotificationResponseItem[];
      return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Get a notification by ID (read-only). Returns null when not found.
   * Used by the proposed-diff endpoint to fetch a hil_approval notification by requestId.
   */
  async getById(projectId: string, notificationId: string): Promise<Notification | null> {
    const client = await taskStore.getDb();
    const row = await client.queryOne(
      "SELECT * FROM open_questions WHERE id = $1 AND project_id = $2",
      [notificationId, projectId]
    );
    if (!row) return null;
    return rowToNotification(row as Record<string, unknown>);
  }

  /**
   * Resolve a notification by ID. Project ID is required for scoping.
   * When options.responses is provided (e.g. agent-question answer), persists and returns them.
   */
  async resolve(
    projectId: string,
    notificationId: string,
    options?: { approved?: boolean; responses?: NotificationResponseItem[] }
  ): Promise<Notification> {
    const client = await taskStore.getDb();
    const row = await client.queryOne(
      "SELECT * FROM open_questions WHERE id = $1 AND project_id = $2",
      [notificationId, projectId]
    );

    if (!row) {
      throw new AppError(
        404,
        ErrorCodes.NOTIFICATION_NOT_FOUND,
        `Notification '${notificationId}' not found`,
        { notificationId, projectId }
      );
    }

    const resolvedAt = new Date().toISOString();
    const responsesJson =
      options?.responses && options.responses.length > 0 ? JSON.stringify(options.responses) : null;

    await taskStore.runWrite(async (tx) => {
      if (responsesJson != null) {
        await tx.execute(
          "UPDATE open_questions SET status = 'resolved', resolved_at = $1, responses = $2 WHERE id = $3 AND project_id = $4",
          [resolvedAt, responsesJson, notificationId, projectId]
        );
      } else {
        await tx.execute(
          "UPDATE open_questions SET status = 'resolved', resolved_at = $1 WHERE id = $2 AND project_id = $3",
          [resolvedAt, notificationId, projectId]
        );
      }
    });

    log.info("Resolved notification", {
      notificationId,
      projectId,
      withResponses: (options?.responses?.length ?? 0) > 0,
    });

    const notification = rowToNotification(row);
    const persistedResponses = options?.responses ?? undefined;
    return {
      ...notification,
      status: "resolved",
      resolvedAt,
      ...(persistedResponses?.length ? { responses: persistedResponses } : {}),
    };
  }

  /**
   * Delete all open notifications for a project.
   * Used by Clear all in project-scoped notification dropdown.
   * Returns the number of rows deleted.
   */
  async deleteByProject(projectId: string): Promise<number> {
    const db = await taskStore.getDb();
    const row = await db.queryOne(
      "SELECT COUNT(*)::int as cnt FROM open_questions WHERE project_id = $1",
      [projectId]
    );
    const count = (row?.cnt as number) ?? 0;

    if (count === 0) {
      return 0;
    }

    await taskStore.runWrite(async (tx) => {
      await tx.execute("DELETE FROM open_questions WHERE project_id = $1", [projectId]);
    });

    log.info("Deleted project notifications", { projectId, deletedCount: count });
    return count;
  }

  /**
   * Delete all HIL notifications (open_questions) from storage.
   * Manual utility for testing/cleanup. Returns the number of rows deleted.
   */
  async deleteAll(): Promise<number> {
    const db = await taskStore.getDb();
    const row = await db.queryOne("SELECT COUNT(*)::int as cnt FROM open_questions");
    const count = (row?.cnt as number) ?? 0;

    if (count === 0) {
      return 0;
    }

    await taskStore.runWrite(async (db) => {
      await db.execute("DELETE FROM open_questions");
    });

    log.info("Deleted all HIL notifications", { deletedCount: count });
    return count;
  }
}

export const notificationService = new NotificationService();
