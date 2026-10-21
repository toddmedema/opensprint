import { randomUUID } from "node:crypto";
import type { Conversation, ConversationMessage } from "@opensprint/shared";
import type { DbClient } from "../db/client.js";
import { AppError } from "../middleware/error-handler.js";
import { taskStore } from "./task-store.service.js";
import { appendProjectEvent, lockProject, stableFingerprint } from "./project-event.service.js";
import { getRequestContext } from "./request-context.js";

interface Store {
  runWrite<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
}
/** Messages are individually identified append-only records; stale prompt snapshots cannot overwrite them. */
export class ConversationStore {
  constructor(private readonly store: Store = taskStore) {}

  private async importLegacy(
    tx: DbClient,
    projectId: string,
    context: string,
    raw: unknown
  ): Promise<void> {
    let messages: unknown;
    try {
      messages = JSON.parse(String(raw ?? "[]"));
    } catch {
      throw new AppError(500, "CONVERSATION_CORRUPT", "The legacy conversation cannot be decoded.");
    }
    if (!Array.isArray(messages))
      throw new AppError(
        500,
        "CONVERSATION_CORRUPT",
        "The legacy conversation must contain messages."
      );
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i] as ConversationMessage;
      if (
        !message ||
        !["user", "assistant"].includes(message.role) ||
        typeof message.content !== "string" ||
        typeof message.timestamp !== "string"
      )
        continue;
      const id = `legacy-${stableFingerprint({ i, message })}`;
      const normalized = { ...message, id };
      await tx.execute(
        "INSERT INTO conversation_messages (project_id, context, id, position, message, created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        [projectId, context, id, i + 1, JSON.stringify(normalized), message.timestamp]
      );
    }
    // Clear only after every normalized row is durable in this transaction.
    if (messages.length)
      await tx.execute(
        "UPDATE project_conversations SET messages = '[]' WHERE project_id = $1 AND context = $2",
        [projectId, context]
      );
  }

  async read(projectId: string, context: string): Promise<Conversation | null> {
    return this.store.runWrite(async (tx) => {
      await lockProject(tx, projectId);
      const row = await tx.queryOne(
        "SELECT conversation_id, messages FROM project_conversations WHERE project_id = $1 AND context = $2",
        [projectId, context]
      );
      if (!row) return null;
      await this.importLegacy(tx, projectId, context, row.messages);
      const messages = await tx.query(
        "SELECT message FROM conversation_messages WHERE project_id = $1 AND context = $2 ORDER BY position",
        [projectId, context]
      );
      return {
        id: String(row.conversation_id),
        context: context as Conversation["context"],
        messages: messages.map((m) => JSON.parse(String(m.message)) as ConversationMessage),
      };
    });
  }

  async append(
    projectId: string,
    conversation: Conversation,
    additions: ConversationMessage[]
  ): Promise<string> {
    return this.store.runWrite(async (tx) => {
      await lockProject(tx, projectId);
      const now = new Date().toISOString();
      await tx.execute(
        "INSERT INTO project_conversations (project_id, context, conversation_id, messages, created_at, updated_at) VALUES ($1,$2,$3,'[]',$4,$4) ON CONFLICT (project_id, context) DO NOTHING",
        [projectId, conversation.context, conversation.id, now]
      );
      const header = (await tx.queryOne(
        "SELECT conversation_id, messages FROM project_conversations WHERE project_id = $1 AND context = $2",
        [projectId, conversation.context]
      ))!;
      await this.importLegacy(tx, projectId, conversation.context, header.messages);
      const last = await tx.queryOne(
        "SELECT MAX(position) AS position FROM conversation_messages WHERE project_id = $1 AND context = $2",
        [projectId, conversation.context]
      );
      let position = Number(last?.position ?? 0);
      for (const message of additions) {
        const request = getRequestContext();
        const normalized = {
          ...message,
          id: message.id ?? randomUUID(),
          ...(message.role === "user" && request
            ? { actorId: request.principal.actorId, requestId: request.requestId }
            : {}),
        };
        const existing = await tx.queryOne(
          "SELECT message FROM conversation_messages WHERE project_id = $1 AND context = $2 AND id = $3",
          [projectId, conversation.context, normalized.id]
        );
        if (existing) {
          if (
            stableFingerprint(JSON.parse(String(existing.message))) !==
            stableFingerprint(normalized)
          )
            throw new AppError(
              409,
              "MESSAGE_ID_REUSED",
              "This message ID belongs to another message."
            );
          continue;
        }
        await tx.execute(
          "INSERT INTO conversation_messages (project_id, context, id, position, message, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
          [
            projectId,
            conversation.context,
            normalized.id,
            ++position,
            JSON.stringify(normalized),
            message.timestamp,
          ]
        );
        message.id = normalized.id;
        await appendProjectEvent(tx, {
          projectId,
          actorId: normalized.actorId,
          type: "conversation_message_appended",
          payload: { context: conversation.context, message: normalized },
        });
      }
      await tx.execute(
        "UPDATE project_conversations SET updated_at = $3 WHERE project_id = $1 AND context = $2",
        [projectId, conversation.context, now]
      );
      return String(header.conversation_id);
    });
  }
}
export const conversationStore = new ConversationStore();
