/** Durable Execute guidance journal. Queue acceptance and model-turn inclusion are distinct. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import os from "node:os";
import type { AgentType, AgentChatStatus } from "@opensprint/shared";
import {
  ActiveAgentsService,
  activeAgentsService as defaultActiveAgentsService,
} from "./active-agents.service.js";

export interface ChatMessage {
  id: string;
  timestamp: string;
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
  private statusListener?: (message: ChatMessage) => void;
  constructor(
    private activeAgents: ActiveAgentsService = defaultActiveAgentsService,
    private basePath?: string
  ) {}

  setStatusListener(listener: ((message: ChatMessage) => void) | undefined): void {
    this.statusListener = listener;
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

  appendMessage(taskId: string, message: ChatMessage, projectId = message.projectId): void {
    const logPath = this.chatLogPath(taskId, projectId);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const fd = fs.openSync(logPath, "a+");
    try {
      const size = fs.fstatSync(fd).size;
      if (size > 0) {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 10) fs.writeSync(fd, "\n");
      }
      fs.writeFileSync(fd, JSON.stringify(message) + "\n", "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private readHistory(projectId: string, taskId: string): ChatMessage[] {
    const logPath = this.chatLogPath(taskId, projectId);
    if (!fs.existsSync(logPath)) return [];
    const byId = new Map<string, ChatMessage>();
    for (const line of fs.readFileSync(logPath, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as ChatMessage;
        if (
          typeof message.id === "string" &&
          message.projectId === projectId &&
          message.taskId === taskId
        ) {
          byId.set(message.id, message);
        }
      } catch {
        // An interrupted final append does not hide earlier durable entries.
      }
    }
    return [...byId.values()];
  }

  private transition(message: ChatMessage, status: AgentChatStatus, error?: string): ChatMessage {
    const next = { ...message, status, ...(error ? { error } : {}) };
    this.appendMessage(message.taskId!, next, message.projectId);
    this.statusListener?.(next);
    return next;
  }

  getHistory(projectId: string, taskId: string, attempt?: number): ChatMessage[] {
    const channel = this.activeAgents.getChannel(taskId);
    return this.readHistory(projectId, taskId)
      .map((message) => {
        // A restarted service cannot prove that a previous process submitted its queue.
        // Keep the record and make the uncertain disposition explicit; never replay into a new run.
        if (
          (message.status === "accepted" || message.status === "queued") &&
          (channel?.attemptId !== message.attemptId || channel?.pendingMessages.isClosed)
        ) {
          return this.transition(
            message,
            "run-ended",
            "Run ended before inclusion could be confirmed; resend guidance if needed."
          );
        }
        return message;
      })
      .filter((message) => attempt === undefined || message.attempt === attempt);
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

  sendMessage(
    projectId: string,
    taskId: string,
    content: string,
    attempt?: number,
    options?: { clientMessageId?: string; actorId?: string }
  ): SendMessageResult {
    const clientMessageId = options?.clientMessageId ?? crypto.randomUUID();
    const actorId = options?.actorId ?? "local-user";
    const previous = this.getHistory(projectId, taskId).find(
      (message) => message.clientMessageId === clientMessageId && message.actorId === actorId
    );
    if (previous) {
      if (previous.content !== content)
        throw new Error("clientMessageId already used for different guidance");
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
    const message: ChatMessage = {
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
    this.appendMessage(taskId, message, projectId);
    const available =
      !channel.pendingMessages.isClosed &&
      channel.pendingMessages.size < channel.pendingMessages.capacity;
    const error = available
      ? undefined
      : "Too many pending messages — wait for a model turn before sending more.";
    // Persist queue intent before making it available to the model loop.
    this.transition(message, available ? "queued" : "failed", error);
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
    const queued = channel.pendingMessages.push(content, new Date(message.timestamp), {
      messageId: message.id,
      onIncluded: () => this.transition(message, "included"),
      onRunEnded: () =>
        this.transition(message, "run-ended", "Run ended before this guidance was included."),
    });
    const status: AgentChatStatus = queued ? "queued" : "failed";
    if (!queued) this.transition(message, "failed", "Run ended before queue acceptance.");
    return {
      messageId: message.id,
      timestamp: message.timestamp,
      delivered: queued,
      clientMessageId,
      attemptId: message.attemptId,
      status,
      error,
    };
  }

  appendAssistantMessage(
    taskId: string,
    content: string,
    attempt = 1,
    projectId?: string
  ): ChatMessage {
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
    this.appendMessage(taskId, message, message.projectId);
    return message;
  }
}
export const agentChatService = new AgentChatService();
