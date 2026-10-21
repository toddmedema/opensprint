/** Durable Execute guidance journal. Queue acceptance and model-turn inclusion are distinct. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import os from "node:os";
import { taskStore } from "./task-store.service.js";
import type { DbClient } from "../db/client.js";
import { AppError } from "../middleware/error-handler.js";
import { appendProjectEvent, lockProject } from "./project-event.service.js";
import { createLogger } from "../utils/logger.js";
import { databaseNow } from "../db/database-clock.js";
const log = createLogger("agent-chat");
import type { AgentType, AgentChatStatus } from "@opensprint/shared";
import {
  ActiveAgentsService,
  activeAgentsService as defaultActiveAgentsService,
} from "./active-agents.service.js";

export interface ChatMessage {
  id: string;
  timestamp: string;
  /** Server-owned project event position: acceptance order is independent of wall clocks and UUIDs. */
  sequence?: number;
  role: "user" | "assistant";
  content: string;
  attempt: number;
  projectId?: string;
  taskId?: string;
  clientMessageId?: string;
  attemptId?: string;
  actorId?: string;
  status?: AgentChatStatus;
  error?: string;
}
export interface SupportsChatResult {
  supported: boolean;
  backend: string | null;
  reason: string | null;
}
export interface SendMessageResult {
  messageId: string;
  timestamp: string;
  /** Compatibility field: true means durably queued, never delivered to a model. */
  delivered: boolean;
  clientMessageId?: string;
  attemptId?: string;
  status?: AgentChatStatus;
  error?: string;
}
const CLI_BACKENDS: ReadonlySet<AgentType> = new Set(["claude-cli", "cursor", "custom"]);
const API_BACKENDS: ReadonlySet<AgentType> = new Set([
  "claude",
  "openai",
  "google",
  "lmstudio",
  "ollama",
]);
const UNSUPPORTED_REASON =
  "Chat is not available for CLI-based agent backends. Switch to API mode (Project Settings → Agent Config) to chat with running agents.";

export class AgentChatService {
  private transitions = new Set<Promise<unknown>>();
  private statusListener?: (message: ChatMessage) => void;
  constructor(
    private activeAgents: ActiveAgentsService = defaultActiveAgentsService,
    private basePath?: string,
    private store: {
      runWrite<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
      runRead<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
      afterCommit?(action: () => void): void;
    } = taskStore
  ) {}

  setStatusListener(listener: ((message: ChatMessage) => void) | undefined): void {
    this.statusListener = listener;
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.transitions]);
  }
  private backgroundTransition(
    message: ChatMessage,
    status: AgentChatStatus,
    error?: string
  ): void {
    const pending = this.transition(message, status, error).catch((error) =>
      log.error("Guidance status persistence failed", { messageId: message.id, error })
    );
    this.transitions.add(pending);
    void pending.finally(() => this.transitions.delete(pending));
  }

  private chatLogPath(taskId: string, projectId?: string): string {
    const base = this.basePath ?? path.join(os.homedir(), ".opensprint", "guidance");
    // Hash untrusted identifiers; project/task IDs never become filesystem paths.
    const key = crypto
      .createHash("sha256")
      .update(JSON.stringify([projectId ?? "", taskId]))
      .digest("hex");
    return path.join(base, key, "chat-log.jsonl");
  }

  async appendMessage(
    taskId: string,
    message: ChatMessage,
    projectId = message.projectId
  ): Promise<ChatMessage> {
    if (!projectId) throw new Error("Guidance history requires a project identity.");
    return this.store.runWrite((tx) => this.appendInTransaction(tx, projectId, taskId, message));
  }

  private async appendInTransaction(
    tx: DbClient,
    projectId: string,
    taskId: string,
    message: ChatMessage
  ): Promise<ChatMessage> {
    const cursor = await lockProject(tx, projectId);
    const previous = await tx.queryOne(
      "SELECT * FROM guidance_messages WHERE project_id = $1 AND actor_id = $2 AND client_message_id = $3",
      [projectId, message.actorId ?? "system", message.clientMessageId ?? message.id]
    );
    if (previous) {
      if (previous.content !== message.content || previous.task_id !== taskId)
        throw new AppError(
          409,
          "GUIDANCE_ID_REUSED",
          "clientMessageId already used for different guidance."
        );
      return JSON.parse(String(previous.message)) as ChatMessage;
    }
    // The project row is locked through commit. This is the cursor of the event below,
    // so concurrent actors and messages sharing a timestamp still have one durable order.
    const accepted = { ...message, sequence: cursor + 1 };
    await tx.execute(
      "INSERT INTO guidance_messages (project_id, task_id, id, actor_id, client_message_id, attempt_id, content, status, message, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (project_id, id) DO NOTHING",
      [
        projectId,
        taskId,
        accepted.id,
        accepted.actorId ?? "system",
        accepted.clientMessageId ?? accepted.id,
        accepted.attemptId ?? "legacy",
        accepted.content,
        accepted.status ?? "included",
        JSON.stringify(accepted),
        accepted.timestamp,
      ]
    );
    await appendProjectEvent(tx, {
      projectId,
      actorId: accepted.actorId,
      type: "guidance_changed",
      payload: accepted,
    });
    return accepted;
  }

  private async readHistory(projectId: string, taskId: string): Promise<ChatMessage[]> {
    // Import the old fsynced journal idempotently, retaining receipts across upgrades.
    try {
      const content = await fs.readFile(this.chatLogPath(taskId, projectId), "utf8");
      const latest = new Map<string, ChatMessage>();
      for (const line of content.split("\n")) {
        try {
          const m = JSON.parse(line) as ChatMessage;
          if (m.id && m.projectId === projectId && m.taskId === taskId) latest.set(m.id, m);
        } catch {
          /* interrupted last append */
        }
      }
      await this.store.runWrite(async (tx) => {
        await lockProject(tx, projectId);
        for (const message of latest.values())
          await this.appendInTransaction(tx, projectId, taskId, message);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return this.store.runRead(async (tx) =>
      (
        await tx.query(
          "SELECT message FROM guidance_messages WHERE project_id = $1 AND task_id = $2 ORDER BY created_at, id",
          [projectId, taskId]
        )
      )
        .map((row) => JSON.parse(String(row.message)) as ChatMessage)
        .sort(
          (a, b) =>
            (a.sequence ?? 0) - (b.sequence ?? 0) ||
            a.timestamp.localeCompare(b.timestamp) ||
            a.id.localeCompare(b.id)
        )
    );
  }

  private async transition(
    message: ChatMessage,
    status: AgentChatStatus,
    error?: string
  ): Promise<ChatMessage> {
    const next = { ...message, status, ...(error ? { error } : {}) };
    const changed = await this.store.runWrite(async (tx) => {
      await lockProject(tx, message.projectId!);
      const count = await tx.execute(
        "UPDATE guidance_messages SET status = $3, message = $4 WHERE project_id = $1 AND id = $2 AND status IN ('accepted','queued')",
        [message.projectId!, message.id, status, JSON.stringify(next)]
      );
      if (count)
        await appendProjectEvent(tx, {
          projectId: message.projectId!,
          actorId: message.actorId,
          type: "guidance_changed",
          payload: next,
        });
      return count;
    });
    if (changed) this.statusListener?.(next);
    return next;
  }

  async getHistory(projectId: string, taskId: string, attempt?: number): Promise<ChatMessage[]> {
    const channel = this.activeAgents.getChannel(taskId);
    const messages = await this.readHistory(projectId, taskId);
    return Promise.all(
      messages
        .filter((message) => attempt === undefined || message.attempt === attempt)
        .map(async (message) => {
          if (
            (message.status === "accepted" || message.status === "queued") &&
            (channel?.projectId !== projectId ||
              channel?.attemptId !== message.attemptId ||
              channel?.pendingMessages.isClosed)
          ) {
            const lease = await this.store.runRead((tx) =>
              tx.queryOne(
                "SELECT state, expires_ms FROM execution_leases WHERE project_id = $1 AND task_id = $2 AND attempt_id = $3",
                [projectId, taskId, message.attemptId]
              )
            );
            const localEnded =
              channel?.projectId === projectId &&
              channel.attemptId === message.attemptId &&
              channel.pendingMessages.isClosed;
            if (localEnded || lease?.state === "stopped" || lease?.state === "completed")
              return this.transition(
                message,
                "run-ended",
                "Run ended before this guidance was included."
              );
            if (
              lease &&
              Number(lease.expires_ms) > (await this.store.runRead(databaseNow)) &&
              ["queued", "running", "stop_requested"].includes(String(lease.state))
            )
              return message;
            // A read on another replica cannot prove execution ended. Keep acceptance durable.
            return {
              ...message,
              error: "Execution ownership is uncertain; inclusion has not been confirmed.",
            };
          }
          return message;
        })
    );
  }

  supportsChat(taskId: string, projectId?: string): SupportsChatResult {
    const channel = this.activeAgents.getChannel(taskId);
    if (
      !channel ||
      channel.pendingMessages.isClosed ||
      (projectId !== undefined && channel.projectId !== projectId)
    ) {
      return { supported: false, backend: null, reason: "No active agent found for this task." };
    }
    const backend = channel.backendType as AgentType;
    if (CLI_BACKENDS.has(backend)) return { supported: false, backend, reason: UNSUPPORTED_REASON };
    if (API_BACKENDS.has(backend)) return { supported: true, backend, reason: null };
    return { supported: false, backend, reason: `Unknown agent backend: ${backend}` };
  }

  getAttemptId(taskId: string): string | undefined {
    return this.activeAgents.getChannel(taskId)?.attemptId;
  }

  getActiveRun(
    projectId: string,
    taskId: string
  ): {
    taskId: string;
    attemptId: string;
    attempt: number;
    supported: boolean;
    backend: string | null;
    reason: string | null;
  } | null {
    const channel = this.activeAgents.getChannel(taskId);
    if (!channel || channel.projectId !== projectId || channel.pendingMessages.isClosed)
      return null;
    return {
      taskId,
      attemptId: channel.attemptId,
      attempt: channel.attempt,
      ...this.supportsChat(taskId, projectId),
    };
  }

  async sendMessage(
    projectId: string,
    taskId: string,
    content: string,
    attempt?: number,
    options?: { clientMessageId?: string; actorId?: string }
  ): Promise<SendMessageResult> {
    const clientMessageId = options?.clientMessageId ?? crypto.randomUUID();
    const actorId = options?.actorId ?? "local-user";
    const previous = (await this.getHistory(projectId, taskId)).find(
      (message) => message.clientMessageId === clientMessageId && message.actorId === actorId
    );
    if (previous) {
      if (previous.content !== content)
        throw new AppError(
          409,
          "GUIDANCE_ID_REUSED",
          "clientMessageId already used for different guidance"
        );
      return {
        messageId: previous.id,
        timestamp: previous.timestamp,
        clientMessageId,
        attemptId: previous.attemptId,
        status: previous.status,
        delivered: previous.status === "queued" || previous.status === "included",
        error: previous.error,
      };
    }
    const support = this.supportsChat(taskId, projectId);
    const channel = this.activeAgents.getChannel(taskId);
    if (!support.supported || !channel) {
      return {
        messageId: "",
        timestamp: new Date().toISOString(),
        clientMessageId,
        status: "failed",
        delivered: false,
        error: support.reason ?? "Chat not supported",
      };
    }
    let message: ChatMessage = {
      id: `msg-${crypto.randomUUID()}`,
      timestamp: new Date().toISOString(),
      role: "user",
      content,
      attempt: attempt ?? channel.attempt,
      attemptId: channel.attemptId,
      projectId,
      taskId,
      clientMessageId,
      actorId,
      status: "accepted",
    };
    // No receipt can be emitted until the acceptance record has reached stable storage.
    const accepted = await this.appendMessage(taskId, message, projectId);
    if (accepted.id !== message.id)
      return {
        messageId: accepted.id,
        timestamp: accepted.timestamp,
        clientMessageId,
        attemptId: accepted.attemptId,
        status: accepted.status,
        delivered: accepted.status === "queued" || accepted.status === "included",
        error: accepted.error,
      };
    message = accepted;
    const available =
      !channel.pendingMessages.isClosed &&
      channel.pendingMessages.size < channel.pendingMessages.capacity;
    const error = available
      ? undefined
      : "Too many pending messages — wait for a model turn before sending more.";
    // Persist queue intent before making it available to the model loop.
    await this.transition(message, available ? "queued" : "failed", error);
    if (!available)
      return {
        messageId: message.id,
        timestamp: message.timestamp,
        delivered: false,
        clientMessageId,
        attemptId: message.attemptId,
        status: "failed",
        error,
      };
    const publish = () => {
      const queued = channel.pendingMessages.push(content, new Date(message.timestamp), {
        messageId: message.id,
        onIncluded: () => {
          this.backgroundTransition(message, "included");
        },
        onRunEnded: () => {
          this.backgroundTransition(
            message,
            "run-ended",
            "Run ended before this guidance was included."
          );
        },
      });
      if (!queued)
        this.backgroundTransition(message, "failed", "Run ended before queue acceptance.");
    };
    // withControl may own an outer transaction. The model queue must not see uncommitted guidance.
    if (this.store.afterCommit) this.store.afterCommit(publish);
    else publish();
    return {
      messageId: message.id,
      timestamp: message.timestamp,
      delivered: true,
      clientMessageId,
      attemptId: message.attemptId,
      status: "queued",
      error,
    };
  }

  async appendAssistantMessage(
    taskId: string,
    content: string,
    attempt = 1,
    projectId?: string
  ): Promise<ChatMessage> {
    const channel = this.activeAgents.getChannel(taskId);
    const message: ChatMessage = {
      id: `msg-${crypto.randomUUID()}`,
      timestamp: new Date().toISOString(),
      role: "assistant",
      content,
      attempt,
      projectId: projectId ?? channel?.projectId,
      taskId,
      attemptId: channel?.attemptId,
    };
    return this.appendMessage(taskId, message, message.projectId);
  }
}
export const agentChatService = new AgentChatService();
