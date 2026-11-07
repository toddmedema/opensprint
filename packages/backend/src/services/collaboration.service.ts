import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  CollaborationCommand,
  CollaborationCommandResult,
  CollaborationEvent,
  CollaborationMessage,
  CollaborationPrincipal,
  CollaborationReplay,
  CollaborationRun,
  CollaborationSnapshot,
  CollaborationInvite,
  CollaborationCreatedInvite,
  CollaborationPresence,
  CollaborationPreferences,
  CollaborationNotification,
} from "@opensprint/shared";
import type { DbClient, DbRow } from "../db/client.js";
import { assertCollaborationProjectWritable } from "../db/collaboration-lifecycle.js";
import { AppError } from "../middleware/error-handler.js";
import { taskStore } from "./task-store.service.js";

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const messageContext = z
  .object({
    kind: z.enum(["file", "diff", "event"]),
    label: z.string().trim().min(1).max(500),
    path: z.string().min(1).max(1000).optional(),
    line: z.number().int().min(1).max(10_000_000).optional(),
    eventCursor: revision.optional(),
    attemptId: id.optional(),
    attempt: z.number().int().min(1).max(1_000_000_000).optional(),
    diffRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
const runFields = { commandId: id, runId: id, expectedRevision: revision, taskId: id.optional() };
export const collaborationCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      commandId: id,
      type: z.literal("append_message"),
      content: z
        .string()
        .trim()
        .min(1)
        .max(10_000)
        .refine((v) => !v.includes("\u0000")),
      taskId: id.optional(),
      context: messageContext.optional(),
      mentionActorIds: z.array(id).max(32).optional(),
      decision: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      ...runFields,
      type: z.literal("claim_control"),
    })
    .strict(),
  z.object({ ...runFields, type: z.literal("reclaim_control") }).strict(),
  z
    .object({
      ...runFields,
      type: z.literal("handoff_control"),
      targetActorId: id.nullable(),
    })
    .strict(),
  z.object({ ...runFields, type: z.literal("request_control"), targetActorId: id }).strict(),
  z.object({ ...runFields, type: z.literal("respond_control"), accept: z.boolean() }).strict(),
  z.object({ ...runFields, type: z.literal("cancel_control_request") }).strict(),
]);

export interface CollaborationStore {
  runWrite<T>(fn: (client: DbClient) => Promise<T>): Promise<T>;
  runRead<T>(fn: (client: DbClient) => Promise<T>): Promise<T>;
}

/** Reject an operation without changing collaboration state. */
function forbidden(message: string): never {
  throw new AppError(403, "COLLABORATION_FORBIDDEN", message);
}
/** Report a stale revision or conflicting command identity with optional recovery context. */
function conflict(message: string, details?: unknown): never {
  throw new AppError(409, "COLLABORATION_CONFLICT", message, details);
}
const RUN_SELECT = `SELECT r.*, q.requested_by, q.target_actor_id, q.created_at AS request_created_at, c.task_id
 FROM collaboration_runs r LEFT JOIN collaboration_control_requests q ON q.project_id = r.project_id AND q.run_id = r.run_id
 LEFT JOIN collaboration_run_context c ON c.project_id = r.project_id AND c.run_id = r.run_id`;
const MESSAGE_SELECT = `SELECT m.*, c.task_id, c.context_json, c.mention_actor_ids, c.decision FROM collaboration_messages m
 LEFT JOIN collaboration_message_context c ON c.project_id = m.project_id AND c.message_id = m.id`;
/** Project invitation metadata without returning its persisted token hash. */
function inviteFromRow(row: DbRow): CollaborationInvite {
  return {
    id: String(row.id),
    actorId: String(row.actor_id),
    displayName: String(row.display_name),
    role: row.role as CollaborationInvite["role"],
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    revokedAt: row.revoked_at == null ? null : String(row.revoked_at),
  };
}
/** Rebuild attempt ownership with its current consent request and optional task binding. */
function runFromRow(row: DbRow): CollaborationRun {
  return {
    runId: String(row.run_id),
    controllerId: row.controller_id == null ? null : String(row.controller_id),
    revision: Number(row.revision),
    ...(row.requested_by
      ? {
          request: {
            requestedBy: String(row.requested_by),
            targetActorId: String(row.target_actor_id),
            createdAt: String(row.request_created_at),
          },
        }
      : {}),
    ...(row.task_id ? { taskId: String(row.task_id) } : {}),
  };
}
/** Restore attributed discussion and its optional context from the joined projection. */
function messageFromRow(row: DbRow): CollaborationMessage {
  return {
    id: String(row.id),
    actorId: String(row.actor_id),
    displayName: String(row.display_name),
    content: String(row.content),
    createdAt: String(row.created_at),
    cursor: Number(row.cursor),
    ...(row.task_id ? { taskId: String(row.task_id) } : {}),
    ...(row.context_json ? { context: JSON.parse(String(row.context_json)) } : {}),
    ...(row.mention_actor_ids
      ? { mentionActorIds: JSON.parse(String(row.mention_actor_ids)) }
      : {}),
    ...(Number(row.decision) ? { decision: true } : {}),
  };
}

/** Persist project discussion, invitations, presence, and attempt control under one transactional cursor. */
export class CollaborationService {
  constructor(private readonly store: CollaborationStore = taskStore) {}

  /** Reject retired IDs inside the same durable lock as project deletion and the entire mutation. */
  private async runProjectWrite<T>(
    projectId: string,
    action: (tx: DbClient) => Promise<T>
  ): Promise<T> {
    return this.store.runWrite(async (tx) => {
      await assertCollaborationProjectWritable(tx, projectId);
      return action(tx);
    });
  }

  /** Resolve a hashed invitation only while its project membership is current. */
  async resolveInvite(projectId: string, token: string): Promise<CollaborationPrincipal | null> {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    return this.store.runRead(async (tx) => {
      const row = await tx.queryOne(
        "SELECT * FROM collaboration_invites WHERE project_id = $1 AND token_hash = $2 AND revoked_at IS NULL AND expires_at > $3",
        [projectId, tokenHash, new Date().toISOString()]
      );
      return row
        ? {
            actorId: String(row.actor_id),
            displayName: String(row.display_name),
            role: row.role as CollaborationPrincipal["role"],
          }
        : null;
    });
  }

  /** Keep invitation administration exclusive to the trusted installation host. */
  private assertHost(principal: CollaborationPrincipal): void {
    if (principal.actorId !== "local-user")
      forbidden("Only this installation's host can manage invitations.");
  }

  /** Recheck dynamic invitation authority inside the same transaction as a mutation. */
  private async assertCurrentMembership(
    tx: DbClient,
    projectId: string,
    principal: CollaborationPrincipal
  ): Promise<void> {
    const invitation = await tx.queryOne(
      "SELECT role,expires_at,revoked_at FROM collaboration_invites WHERE project_id = $1 AND actor_id = $2",
      [projectId, principal.actorId]
    );
    if (
      invitation &&
      (invitation.revoked_at != null ||
        String(invitation.expires_at) <= new Date().toISOString() ||
        invitation.role !== principal.role)
    )
      forbidden("This invitation is expired or revoked. Join again with current project access.");
  }

  /** Return a bounded host-only invitation list without reusable credential material. */
  async listInvites(
    projectId: string,
    principal: CollaborationPrincipal
  ): Promise<CollaborationInvite[]> {
    this.assertHost(principal);
    return this.store.runRead(async (tx) =>
      (
        await tx.query(
          "SELECT * FROM collaboration_invites WHERE project_id = $1 ORDER BY created_at DESC LIMIT 200",
          [projectId]
        )
      ).map(inviteFromRow)
    );
  }

  /** Create an expiring named credential; persist its hash and return the secret exactly once. */
  async createInvite(
    projectId: string,
    principal: CollaborationPrincipal,
    input: { displayName: string; role: CollaborationPrincipal["role"]; expiresInHours: number }
  ): Promise<CollaborationCreatedInvite> {
    this.assertHost(principal);
    const parsed = z
      .object({
        displayName: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .refine((v) => !v.includes("\u0000")),
        role: z.enum(["viewer", "participant", "controller"]),
        expiresInHours: z.number().int().min(1).max(168),
      })
      .strict()
      .safeParse(input);
    if (!parsed.success)
      throw new AppError(
        400,
        "INVALID_COLLABORATION_INVITE",
        "An invitation needs a name, role and expiration between 1 and 168 hours."
      );
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const invite: CollaborationInvite = {
      id: randomUUID(),
      actorId: `guest-${randomUUID()}`,
      displayName: parsed.data.displayName,
      role: parsed.data.role,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + parsed.data.expiresInHours * 3600000).toISOString(),
      revokedAt: null,
    };
    await this.runProjectWrite(projectId, async (tx) => {
      await tx.execute(
        "INSERT INTO collaboration_invites (project_id,id,actor_id,display_name,role,token_hash,created_at,expires_at,revoked_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL)",
        [
          projectId,
          invite.id,
          invite.actorId,
          invite.displayName,
          invite.role,
          createHash("sha256").update(token).digest("hex"),
          invite.createdAt,
          invite.expiresAt,
        ]
      );
    });
    return { invite, token };
  }

  /** Revoke future access and remove presence while retaining durable ownership and history. */
  async revokeInvite(
    projectId: string,
    principal: CollaborationPrincipal,
    inviteId: string
  ): Promise<void> {
    this.assertHost(principal);
    await this.runProjectWrite(projectId, async (tx) => {
      const invite = await tx.queryOne(
        "SELECT * FROM collaboration_invites WHERE project_id = $1 AND id = $2",
        [projectId, inviteId]
      );
      if (!invite) throw new AppError(404, "COLLABORATION_NOT_FOUND", "Invitation not found.");
      await tx.execute(
        "UPDATE collaboration_invites SET revoked_at = $3 WHERE project_id = $1 AND id = $2",
        [projectId, inviteId, new Date().toISOString()]
      );
      await tx.execute(
        "DELETE FROM collaboration_presence WHERE project_id = $1 AND actor_id = $2",
        [projectId, invite.actor_id]
      );
    });
  }

  /** List recent browsers whose invitation membership has not expired or been revoked. */
  async presence(projectId: string): Promise<CollaborationPresence[]> {
    return this.store.runRead(async (tx) =>
      (
        await tx.query(
          `SELECT p.* FROM collaboration_presence p LEFT JOIN collaboration_invites i ON i.project_id = p.project_id AND i.actor_id = p.actor_id WHERE p.project_id = $1 AND p.last_seen_at > $2 AND (i.id IS NULL OR (i.revoked_at IS NULL AND i.expires_at > $3)) ORDER BY p.display_name, p.client_id LIMIT 200`,
          [projectId, new Date(Date.now() - 90_000).toISOString(), new Date().toISOString()]
        )
      ).map((row) => ({
        actorId: String(row.actor_id),
        clientId: String(row.client_id),
        displayName: String(row.display_name),
        role: row.role as CollaborationPrincipal["role"],
        taskId: row.task_id == null ? null : String(row.task_id),
        lastSeenAt: String(row.last_seen_at),
      }))
    );
  }

  /** Refresh only the authenticated actor's browser presence and prune expired entries. */
  async heartbeat(
    projectId: string,
    principal: CollaborationPrincipal,
    clientId: string,
    taskId: string | null
  ): Promise<void> {
    await this.runProjectWrite(projectId, async (tx) => {
      await this.assertCurrentMembership(tx, projectId, principal);
      await tx.execute("DELETE FROM collaboration_presence WHERE last_seen_at <= $1", [
        new Date(Date.now() - 90_000).toISOString(),
      ]);
      await tx.execute(
        "INSERT INTO collaboration_presence (project_id,actor_id,client_id,display_name,role,task_id,last_seen_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (project_id,actor_id,client_id) DO UPDATE SET display_name=excluded.display_name,role=excluded.role,task_id=excluded.task_id,last_seen_at=excluded.last_seen_at",
        [
          projectId,
          principal.actorId,
          clientId,
          principal.displayName,
          principal.role,
          taskId,
          new Date().toISOString(),
        ]
      );
    });
  }

  /** Remove one actor-owned browser without releasing attempt control or stopping execution. */
  async leave(
    projectId: string,
    principal: CollaborationPrincipal,
    clientId: string
  ): Promise<void> {
    await this.runProjectWrite(projectId, (tx) =>
      tx
        .execute(
          "DELETE FROM collaboration_presence WHERE project_id = $1 AND actor_id = $2 AND client_id = $3",
          [projectId, principal.actorId, clientId]
        )
        .then(() => undefined)
    );
  }

  /** Read actor-specific catch-up and subscription state, defaulting to an unread project. */
  async preferences(
    projectId: string,
    principal: CollaborationPrincipal
  ): Promise<CollaborationPreferences> {
    return this.store.runRead(async (tx) => {
      const row = await tx.queryOne(
        "SELECT * FROM collaboration_preferences WHERE project_id = $1 AND actor_id = $2",
        [projectId, principal.actorId]
      );
      return row
        ? {
            seenCursor: Number(row.seen_cursor),
            subscribedTaskIds: JSON.parse(String(row.subscribed_task_ids)),
            seenAt: row.seen_at == null ? null : String(row.seen_at),
          }
        : { seenCursor: 0, subscribedTaskIds: [], seenAt: null };
    });
  }

  /** Advance reads monotonically; cursor-only writes retain subscriptions under the project lock. */
  async updatePreferences(
    projectId: string,
    principal: CollaborationPrincipal,
    preferences: Pick<CollaborationPreferences, "seenCursor"> &
      Partial<Pick<CollaborationPreferences, "subscribedTaskIds">> & {
        markSeen?: boolean;
        markSeenAt?: string;
      }
  ): Promise<CollaborationPreferences> {
    const parsed = z
      .object({
        seenCursor: revision,
        subscribedTaskIds: z.array(id).max(200).optional(),
        markSeen: z.boolean().optional(),
        markSeenAt: z.iso.datetime().optional(),
      })
      .strict()
      .safeParse(preferences);
    if (!parsed.success)
      throw new AppError(
        400,
        "INVALID_COLLABORATION_PREFERENCES",
        "Invalid notification preferences."
      );
    if (
      parsed.data.markSeenAt &&
      (!parsed.data.markSeen || Date.parse(parsed.data.markSeenAt) > Date.now())
    )
      throw new AppError(
        400,
        "INVALID_COLLABORATION_PREFERENCES",
        "The seen timestamp must belong to an observed past snapshot."
      );
    return this.runProjectWrite(projectId, async (tx) => {
      await this.assertCurrentMembership(tx, projectId, principal);
      await tx.execute(
        "INSERT INTO collaboration_projects (project_id,cursor) VALUES ($1,0) ON CONFLICT (project_id) DO NOTHING",
        [projectId]
      );
      const state = await tx.queryOne(
        "UPDATE collaboration_projects SET cursor = cursor WHERE project_id = $1 RETURNING cursor",
        [projectId]
      );
      if (parsed.data.seenCursor > Number(state?.cursor ?? 0))
        conflict("The seen cursor is ahead of this project.");
      const previous = await tx.queryOne(
        "SELECT seen_cursor,subscribed_task_ids,seen_at FROM collaboration_preferences WHERE project_id = $1 AND actor_id = $2",
        [projectId, principal.actorId]
      );
      const next = {
        seenCursor: Math.max(Number(previous?.seen_cursor ?? 0), parsed.data.seenCursor),
        subscribedTaskIds:
          parsed.data.subscribedTaskIds === undefined
            ? (JSON.parse(String(previous?.subscribed_task_ids ?? "[]")) as string[])
            : [...new Set(parsed.data.subscribedTaskIds)],
        seenAt: parsed.data.markSeen
          ? [
              previous?.seen_at == null ? "" : String(previous.seen_at),
              parsed.data.markSeenAt ?? new Date().toISOString(),
            ]
              .sort()
              .at(-1)!
          : previous?.seen_at == null
            ? null
            : String(previous.seen_at),
      };
      await tx.execute(
        "INSERT INTO collaboration_preferences (project_id,actor_id,seen_cursor,subscribed_task_ids,seen_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (project_id,actor_id) DO UPDATE SET seen_cursor=excluded.seen_cursor,subscribed_task_ids=excluded.subscribed_task_ids,seen_at=excluded.seen_at",
        [
          projectId,
          principal.actorId,
          next.seenCursor,
          JSON.stringify(next.subscribedTaskIds),
          next.seenAt,
        ]
      );
      return next;
    });
  }

  /** Select relevant unread events before limiting results, and suppress obsolete control requests. */
  async notifications(
    projectId: string,
    principal: CollaborationPrincipal,
    isActiveRun?: (taskId: string, runId: string) => boolean | Promise<boolean>
  ): Promise<CollaborationNotification[]> {
    return this.store.runRead(async (tx) => {
      const row = await tx.queryOne(
        "SELECT * FROM collaboration_preferences WHERE project_id = $1 AND actor_id = $2",
        [projectId, principal.actorId]
      );
      const subscriptions: string[] = row ? JSON.parse(String(row.subscribed_task_ids)) : [];
      const seenCursor = Number(row?.seen_cursor ?? 0);
      // Actor IDs are validated ASCII identifiers without quotes. Match the complete
      // quoted token in our normalized JSON array, escaping LIKE metacharacters.
      // Filtering recipients BEFORE LIMIT preserves old unread mentions even when
      // thousands of unrelated discussion events have arrived since the last visit.
      const mention = `%"${principal.actorId.replace(/[!%_]/g, (value) => `!${value}`)}"%`;
      const parameters = [projectId, seenCursor, principal.actorId, mention, ...subscriptions];
      const taskCondition = subscriptions.length
        ? ` OR c.task_id IN (${subscriptions.map((_, index) => `$${index + 5}`).join(",")})`
        : "";
      const messages = await tx.query(
        `${MESSAGE_SELECT} WHERE m.project_id = $1 AND m.cursor > $2 AND m.actor_id <> $3 AND (c.mention_actor_ids LIKE $4 ESCAPE '!'${taskCondition}) ORDER BY m.cursor DESC LIMIT 200`,
        parameters
      );
      const notifications: CollaborationNotification[] = messages.map((row) => {
        const message = messageFromRow(row);
        return {
          id: `event-${message.cursor}`,
          cursor: message.cursor,
          taskId: message.taskId ?? null,
          actorId: message.actorId,
          createdAt: message.createdAt,
          kind: message.mentionActorIds?.includes(principal.actorId)
            ? "mention"
            : "task_discussion",
          content: message.content,
        };
      });
      // A pending-request index points to the durable event that created CURRENT
      // state. Resolved/replaced requests remain in activity but cease being actions.
      const pending = await tx.query(
        `SELECT q.*,r.controller_id,c.task_id,e.event_cursor FROM collaboration_control_requests q
        JOIN collaboration_runs r ON r.project_id=q.project_id AND r.run_id=q.run_id
        JOIN collaboration_control_request_events e ON e.project_id=q.project_id AND e.run_id=q.run_id
        LEFT JOIN collaboration_run_context c ON c.project_id=q.project_id AND c.run_id=q.run_id
        LEFT JOIN collaboration_invites owner ON owner.project_id=q.project_id AND owner.actor_id=r.controller_id
        LEFT JOIN collaboration_invites target ON target.project_id=q.project_id AND target.actor_id=q.target_actor_id
        WHERE q.project_id=$1 AND e.event_cursor>$2 AND q.requested_by<>$3
        AND ((q.requested_by=r.controller_id AND q.target_actor_id=$3) OR (q.requested_by<>r.controller_id AND r.controller_id=$3))
        AND (owner.id IS NULL OR (owner.revoked_at IS NULL AND owner.expires_at>$4))
        AND (target.id IS NULL OR (target.revoked_at IS NULL AND target.expires_at>$4))
        ORDER BY e.event_cursor DESC LIMIT 200`,
        [projectId, seenCursor, principal.actorId, new Date().toISOString()]
      );
      for (const request of pending) {
        const taskId = request.task_id == null ? null : String(request.task_id);
        const runId = String(request.run_id);
        if (isActiveRun && (!taskId || !(await isActiveRun(taskId, runId)))) continue;
        const cursor = Number(request.event_cursor);
        notifications.push({
          id: `event-${cursor}`,
          cursor,
          taskId,
          actorId: String(request.requested_by),
          createdAt: String(request.created_at),
          kind: "control_request",
          content: "A control request needs your response.",
        });
      }
      return notifications.sort((a, b) => b.cursor - a.cursor).slice(0, 200);
    });
  }

  /** Read attempt ownership and consent state; unknown attempts begin unclaimed at revision zero. */
  async getRunControl(projectId: string, runId: string): Promise<CollaborationRun> {
    return this.store.runRead(async (tx) => {
      const row = await tx.queryOne(`${RUN_SELECT} WHERE r.project_id = $1 AND r.run_id = $2`, [
        projectId,
        runId,
      ]);
      return row ? runFromRow(row) : { runId, controllerId: null, revision: 0 };
    });
  }

  /** Validate current membership and ownership for guidance, retaining local legacy compatibility. */
  private async checkControl(
    tx: DbClient,
    projectId: string,
    principal: CollaborationPrincipal,
    runId: string
  ): Promise<number> {
    await this.assertCurrentMembership(tx, projectId, principal);
    if (principal.role !== "controller")
      forbidden("Controller permission is required to guide a run.");
    const row = await tx.queryOne(
      "SELECT * FROM collaboration_runs WHERE project_id = $1 AND run_id = $2",
      [projectId, runId]
    );
    const owner = row ? row.controller_id : "local-user";
    if (owner !== principal.actorId)
      forbidden("Claim control of this run before sending guidance.");
    return Number(row?.revision ?? 0);
  }

  /** Check existing ownership; callers delivering guidance should use withControl. */
  async assertControl(
    projectId: string,
    principal: CollaborationPrincipal,
    runId: string
  ): Promise<number> {
    return this.store.runRead((tx) => this.checkControl(tx, projectId, principal, runId));
  }

  /** Hold the same row lock as claim/handoff while the durable action is accepted. */
  async withControl<T>(
    projectId: string,
    principal: CollaborationPrincipal,
    runId: string,
    action: (revision: number) => Promise<T>
  ): Promise<T> {
    return this.runProjectWrite(projectId, async (tx) => {
      await tx.execute(
        "INSERT INTO collaboration_projects (project_id, cursor) VALUES ($1, 0) ON CONFLICT (project_id) DO NOTHING",
        [projectId]
      );
      await tx.queryOne(
        "UPDATE collaboration_projects SET cursor = cursor WHERE project_id = $1 RETURNING cursor",
        [projectId]
      );
      return action(await this.checkControl(tx, projectId, principal, runId));
    });
  }

  /** Read a coherent bounded history projection with the durable replay cursor and current actor. */
  async snapshot(
    projectId: string,
    principal: CollaborationPrincipal
  ): Promise<CollaborationSnapshot> {
    return this.store.runRead(async (tx) => {
      const state = await tx.queryOne(
        "SELECT cursor FROM collaboration_projects WHERE project_id = $1",
        [projectId]
      );
      await this.assertCurrentMembership(tx, projectId, principal);
      const messages = await tx.query(
        `${MESSAGE_SELECT} WHERE m.project_id = $1 ORDER BY m.cursor DESC LIMIT 201`,
        [projectId]
      );
      const runs = await tx.query(
        `${RUN_SELECT} WHERE r.project_id = $1 ORDER BY r.run_id LIMIT 201`,
        [projectId]
      );
      return {
        projectId,
        sessionId: "default",
        cursor: Number(state?.cursor ?? 0),
        messages: messages.slice(0, 200).reverse().map(messageFromRow),
        messagesHasMore: messages.length > 200,
        runs: runs.slice(0, 200).map(runFromRow),
        runsHasMore: runs.length > 200,
        principal,
      };
    });
  }

  /** Page committed events after a validated cursor; future cursors require a fresh snapshot. */
  async replay(projectId: string, after = 0, limit = 100): Promise<CollaborationReplay> {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200
    ) {
      throw new AppError(
        400,
        "INVALID_COLLABORATION_CURSOR",
        "after must be a nonnegative integer and limit must be between 1 and 200."
      );
    }
    return this.store.runRead(async (tx) => {
      const state = await tx.queryOne(
        "SELECT cursor FROM collaboration_projects WHERE project_id = $1",
        [projectId]
      );
      if (after > Number(state?.cursor ?? 0)) {
        conflict(
          "The replay cursor is ahead of this project. Reload its snapshot before replaying.",
          { resetRequired: true, cursor: Number(state?.cursor ?? 0) }
        );
      }
      const rows = await tx.query(
        "SELECT event FROM collaboration_events WHERE project_id = $1 AND cursor > $2 ORDER BY cursor LIMIT $3",
        [projectId, after, limit + 1]
      );
      const events = rows
        .slice(0, limit)
        .map((r) => JSON.parse(String(r.event)) as CollaborationEvent);
      return { events, nextCursor: events.at(-1)?.cursor ?? after, hasMore: rows.length > limit };
    });
  }

  /** Deduplicate an actor-bound command and atomically commit its authorized state transition and event. */
  async command(
    projectId: string,
    principal: CollaborationPrincipal,
    input: CollaborationCommand,
    canControlActor: (actorId: string) => boolean = (actorId) => actorId === principal.actorId
  ): Promise<CollaborationCommandResult> {
    const parsed = collaborationCommandSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError(
        400,
        "INVALID_COLLABORATION_COMMAND",
        "Invalid collaboration command.",
        parsed.error.issues
      );
    const command = parsed.data;
    if (principal.role !== "participant" && principal.role !== "controller")
      forbidden("This project role cannot submit commands.");
    if (command.type !== "append_message" && principal.role !== "controller")
      forbidden("Controller permission is required.");
    const fingerprint = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    return this.runProjectWrite(projectId, async (tx) => {
      await tx.execute(
        "INSERT INTO collaboration_projects (project_id, cursor) VALUES ($1, 0) ON CONFLICT (project_id) DO NOTHING",
        [projectId]
      );
      // This row lock serializes the entire project command (including dedupe).
      // A second Postgres connection cannot allocate a cursor before this commits.
      const state = await tx.queryOne(
        "UPDATE collaboration_projects SET cursor = cursor WHERE project_id = $1 RETURNING cursor",
        [projectId]
      );
      const existing = await tx.queryOne(
        "SELECT actor_id, fingerprint, result FROM collaboration_commands WHERE project_id = $1 AND command_id = $2",
        [projectId, command.commandId]
      );
      await this.assertCurrentMembership(tx, projectId, principal);
      if (existing) {
        if (existing.actor_id !== principal.actorId || existing.fingerprint !== fingerprint)
          conflict("This command ID was already used for another actor or payload.");
        return JSON.parse(String(existing.result)) as CollaborationCommandResult;
      }
      const cursor = Number(state!.cursor) + 1;
      if (!Number.isSafeInteger(cursor)) conflict("Project event cursor exhausted.");
      const createdAt = new Date().toISOString();
      let result: CollaborationCommandResult;
      if (command.type === "append_message") {
        const message: CollaborationMessage = {
          id: randomUUID(),
          actorId: principal.actorId,
          displayName: principal.displayName,
          content: command.content,
          createdAt,
          cursor,
          ...(command.taskId ? { taskId: command.taskId } : {}),
          ...(command.context ? { context: command.context } : {}),
          ...(command.mentionActorIds?.length
            ? { mentionActorIds: [...new Set(command.mentionActorIds)] }
            : {}),
          ...(command.decision ? { decision: true } : {}),
        };
        await tx.execute(
          "INSERT INTO collaboration_messages (project_id, id, actor_id, display_name, content, created_at, cursor) VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [
            projectId,
            message.id,
            message.actorId,
            message.displayName,
            message.content,
            createdAt,
            cursor,
          ]
        );
        if (message.taskId || message.context || message.mentionActorIds || message.decision) {
          await tx.execute(
            "INSERT INTO collaboration_message_context (project_id,message_id,task_id,context_json,mention_actor_ids,decision) VALUES ($1,$2,$3,$4,$5,$6)",
            [
              projectId,
              message.id,
              message.taskId ?? null,
              message.context ? JSON.stringify(message.context) : null,
              JSON.stringify(message.mentionActorIds ?? []),
              message.decision ? 1 : 0,
            ]
          );
        }
        result = {
          message,
          event: {
            projectId,
            cursor,
            actorId: principal.actorId,
            createdAt,
            type: "message_appended",
            payload: message,
          },
        };
      } else {
        const previous = await tx.queryOne(
          `${RUN_SELECT} WHERE r.project_id = $1 AND r.run_id = $2`,
          [projectId, command.runId]
        );
        const run: CollaborationRun = previous
          ? runFromRow(previous)
          : { runId: command.runId, controllerId: null, revision: 0 };
        if (run.revision !== command.expectedRevision)
          conflict("Control revision changed. Refresh before retrying.", { run });
        /** Check configured or unexpired invitation-based controller authority before a handoff. */
        const mayControl = async (actorId: string) => {
          if (canControlActor(actorId)) return true;
          return Boolean(
            await tx.queryOne(
              "SELECT id FROM collaboration_invites WHERE project_id = $1 AND actor_id = $2 AND role = 'controller' AND revoked_at IS NULL AND expires_at > $3",
              [projectId, actorId, new Date().toISOString()]
            )
          );
        };
        let eventType: CollaborationEvent["type"] = "control_request_resolved";
        if (command.taskId) {
          if (run.taskId && run.taskId !== command.taskId)
            conflict("This run belongs to another task.");
          run.taskId = command.taskId;
          await tx.execute(
            "INSERT INTO collaboration_run_context (project_id,run_id,task_id) VALUES ($1,$2,$3) ON CONFLICT (project_id,run_id) DO NOTHING",
            [projectId, run.runId, command.taskId]
          );
        }
        if (command.type === "claim_control" || command.type === "reclaim_control") {
          if (command.type === "reclaim_control" && principal.actorId !== "local-user")
            forbidden("Only the installation host can reclaim control.");
          if (
            command.type !== "reclaim_control" &&
            run.controllerId !== null &&
            run.controllerId !== principal.actorId
          )
            conflict("This run already has a controller.", { run });
          run.controllerId = principal.actorId;
          delete run.request;
          eventType = "control_claimed";
        } else if (
          command.type === "request_control" ||
          (command.type === "handoff_control" && command.targetActorId !== null)
        ) {
          const targetActorId = command.targetActorId!;
          if (command.type === "handoff_control" && run.controllerId !== principal.actorId)
            forbidden("Only the current controller can offer a handoff.");
          if (!run.controllerId)
            conflict("This run is unclaimed. Claim it before requesting a transfer.");
          if (run.request) conflict("A control request is already pending.", { run });
          if (targetActorId === run.controllerId) conflict("The target already controls this run.");
          if (principal.actorId !== run.controllerId && targetActorId !== principal.actorId)
            forbidden("Only the current controller can offer control to another person.");
          if (!(await mayControl(targetActorId)))
            forbidden("The handoff target must have active controller permission in this project.");
          run.request = { requestedBy: principal.actorId, targetActorId, createdAt };
          eventType = "control_requested";
        } else if (command.type === "respond_control") {
          const pending = run.request;
          if (!pending) conflict("There is no pending control request.");
          const recipient =
            pending.requestedBy === run.controllerId ? pending.targetActorId : run.controllerId;
          if (principal.actorId !== recipient)
            forbidden("Only the recipient can respond to this control request.");
          if (command.accept) {
            if (
              !(await mayControl(pending.targetActorId)) ||
              !run.controllerId ||
              !(await mayControl(run.controllerId))
            )
              forbidden(
                "Both parties must retain controller permission before control can transfer."
              );
            run.controllerId = pending.targetActorId;
            eventType = "control_handed_off";
          }
          delete run.request;
        } else if (command.type === "cancel_control_request") {
          if (!run.request) conflict("There is no pending control request.");
          if (principal.actorId !== run.request.requestedBy)
            forbidden("Only the requester can cancel this request.");
          delete run.request;
        } else {
          if (run.controllerId !== principal.actorId)
            forbidden("Only this run's current controller can release control.");
          run.controllerId = null;
          delete run.request;
          eventType = "control_handed_off";
        }
        run.revision++;
        await tx.execute(
          "INSERT INTO collaboration_runs (project_id, run_id, controller_id, revision) VALUES ($1, $2, $3, $4) ON CONFLICT (project_id, run_id) DO UPDATE SET controller_id = excluded.controller_id, revision = excluded.revision",
          [projectId, run.runId, run.controllerId, run.revision]
        );
        await tx.execute(
          "DELETE FROM collaboration_control_requests WHERE project_id = $1 AND run_id = $2",
          [projectId, run.runId]
        );
        await tx.execute(
          "DELETE FROM collaboration_control_request_events WHERE project_id = $1 AND run_id = $2",
          [projectId, run.runId]
        );
        if (run.request)
          await tx.execute(
            "INSERT INTO collaboration_control_requests (project_id,run_id,requested_by,target_actor_id,created_at,task_id) VALUES ($1,$2,$3,$4,$5,$6)",
            [
              projectId,
              run.runId,
              run.request.requestedBy,
              run.request.targetActorId,
              run.request.createdAt,
              run.taskId ?? null,
            ]
          );
        if (run.request)
          await tx.execute(
            "INSERT INTO collaboration_control_request_events (project_id,run_id,event_cursor) VALUES ($1,$2,$3)",
            [projectId, run.runId, cursor]
          );
        result = {
          run,
          event: {
            projectId,
            cursor,
            actorId: principal.actorId,
            createdAt,
            type: eventType,
            payload: run,
          },
        };
      }
      await tx.execute("UPDATE collaboration_projects SET cursor = $2 WHERE project_id = $1", [
        projectId,
        cursor,
      ]);
      await tx.execute(
        "INSERT INTO collaboration_events (project_id, cursor, event) VALUES ($1, $2, $3)",
        [projectId, cursor, JSON.stringify(result.event)]
      );
      await tx.execute(
        "INSERT INTO collaboration_commands (project_id, command_id, actor_id, fingerprint, result) VALUES ($1, $2, $3, $4, $5)",
        [projectId, command.commandId, principal.actorId, fingerprint, JSON.stringify(result)]
      );
      return result;
    });
  }
}
