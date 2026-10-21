import { createHash, randomUUID } from "node:crypto";
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
} from "@opensprint/shared";
import type { DbClient, DbRow } from "../db/client.js";
import { AppError } from "../middleware/error-handler.js";
import { taskStore } from "./task-store.service.js";

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
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
    })
    .strict(),
  z
    .object({
      commandId: id,
      type: z.literal("claim_control"),
      runId: id,
      expectedRevision: revision,
    })
    .strict(),
  z
    .object({
      commandId: id,
      type: z.literal("handoff_control"),
      runId: id,
      expectedRevision: revision,
      targetActorId: id.nullable(),
    })
    .strict(),
]);

export interface CollaborationStore {
  runWrite<T>(fn: (client: DbClient) => Promise<T>): Promise<T>;
  runRead<T>(fn: (client: DbClient) => Promise<T>): Promise<T>;
}

function forbidden(message: string): never {
  throw new AppError(403, "COLLABORATION_FORBIDDEN", message);
}
function conflict(message: string, details?: unknown): never {
  throw new AppError(409, "COLLABORATION_CONFLICT", message, details);
}
function runFromRow(row: DbRow): CollaborationRun {
  return {
    runId: String(row.run_id),
    controllerId: row.controller_id == null ? null : String(row.controller_id),
    revision: Number(row.revision),
  };
}
function messageFromRow(row: DbRow): CollaborationMessage {
  return {
    id: String(row.id),
    actorId: String(row.actor_id),
    displayName: String(row.display_name),
    content: String(row.content),
    createdAt: String(row.created_at),
    cursor: Number(row.cursor),
  };
}

export class CollaborationService {
  constructor(private readonly store: CollaborationStore = taskStore) {}

  async getRunControl(projectId: string, runId: string): Promise<CollaborationRun> {
    return this.store.runRead(async (tx) => {
      const row = await tx.queryOne(
        "SELECT * FROM collaboration_runs WHERE project_id = $1 AND run_id = $2",
        [projectId, runId]
      );
      return row ? runFromRow(row) : { runId, controllerId: null, revision: 0 };
    });
  }

  private async checkControl(
    tx: DbClient,
    projectId: string,
    principal: CollaborationPrincipal,
    runId: string
  ): Promise<number> {
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
    return this.store.runWrite(async (tx) => {
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

  async snapshot(
    projectId: string,
    principal: CollaborationPrincipal
  ): Promise<CollaborationSnapshot> {
    return this.store.runRead(async (tx) => {
      const state = await tx.queryOne(
        "SELECT cursor FROM collaboration_projects WHERE project_id = $1",
        [projectId]
      );
      const messages = await tx.query(
        "SELECT * FROM collaboration_messages WHERE project_id = $1 ORDER BY cursor DESC LIMIT 201",
        [projectId]
      );
      const runs = await tx.query(
        "SELECT * FROM collaboration_runs WHERE project_id = $1 ORDER BY run_id LIMIT 201",
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
    return this.store.runWrite(async (tx) => {
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
          "SELECT * FROM collaboration_runs WHERE project_id = $1 AND run_id = $2",
          [projectId, command.runId]
        );
        const run = previous
          ? runFromRow(previous)
          : { runId: command.runId, controllerId: null, revision: 0 };
        if (run.revision !== command.expectedRevision)
          conflict("Control revision changed. Refresh before retrying.", { run });
        if (command.type === "claim_control") {
          if (run.controllerId !== null && run.controllerId !== principal.actorId)
            conflict("This run already has a controller.", { run });
          run.controllerId = principal.actorId;
        } else {
          if (run.controllerId !== principal.actorId)
            forbidden("Only this run's current controller can hand off control.");
          if (command.targetActorId !== null && !canControlActor(command.targetActorId))
            forbidden("The handoff target must have controller permission in this project.");
          run.controllerId = command.targetActorId;
        }
        run.revision++;
        await tx.execute(
          "INSERT INTO collaboration_runs (project_id, run_id, controller_id, revision) VALUES ($1, $2, $3, $4) ON CONFLICT (project_id, run_id) DO UPDATE SET controller_id = excluded.controller_id, revision = excluded.revision",
          [projectId, run.runId, run.controllerId, run.revision]
        );
        result = {
          run,
          event: {
            projectId,
            cursor,
            actorId: principal.actorId,
            createdAt,
            type: command.type === "claim_control" ? "control_claimed" : "control_handed_off",
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
