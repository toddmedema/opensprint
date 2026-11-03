/**
 * Agentic loop: run a coding task with tool calling for API-based providers.
 * Sends the task to the model; when the model returns tool calls, executes them
 * and sends results back until the model returns only text or max turns is reached.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import {
  executeTool,
  toAnthropicTools,
  toOpenAITools,
  toGeminiTools,
  type AgentToolsContext,
} from "./agent-tools.js";
import {
  buildOpenAIPromptCacheKey,
  extractAnthropicCacheUsage,
  extractOpenAICacheUsage,
  fingerprintJson,
  fingerprintPrompt,
  toAnthropicTextBlock,
  type AgentCacheUsageMetrics,
  type PromptCacheContext,
} from "../utils/prompt-cache.js";
import { isReasoningOnlyCompletion } from "../utils/local-openai-provider.js";
import {
  assertAnthropicCompletion,
  assertGeminiCompletion,
  getGeminiResponseText,
} from "../utils/provider-response.js";

const DEFAULT_MAX_TURNS = 100;
const SYSTEM_PROMPT =
  "You are a coding agent. Execute the task described in the user message. Use the provided tools to read and edit files, run commands, and list or search files. When done, write a result.json file (or report success/failure in your final message).";

function isReasoningOnlyAgentTurn(
  choice: OpenAI.Chat.Completions.ChatCompletion.Choice | undefined
): boolean {
  const message = choice?.message;
  if ((message?.tool_calls ?? []).length > 0) return false;
  return isReasoningOnlyCompletion({
    content: message?.content ?? "",
    finishReason: choice?.finish_reason,
    reasoningSource: message,
  });
}

/**
 * Bounded queue for injecting user messages into the agentic loop between turns.
 *
 * Push from any async context (e.g. WebSocket handler); the loop drains between
 * turns after tool execution completes.  On agent completion, any undrained
 * messages remain in the queue — the caller is responsible for handling them.
 */
export interface PendingMessage {
  message: string;
  timestamp: Date;
  messageId?: string;
  onIncluded?: () => void;
  onRunEnded?: () => void;
}

export class PendingMessageQueue {
  private readonly items: PendingMessage[] = [];
  private closed = false;
  readonly capacity: number;

  constructor(capacity = 10) {
    this.capacity = capacity;
  }

  /** Push a message. Returns true if accepted, false if the queue is at capacity. */
  push(
    message: string,
    timestamp?: Date,
    metadata?: Omit<PendingMessage, "message" | "timestamp">
  ): boolean {
    if (this.closed || this.items.length >= this.capacity) return false;
    this.items.push({ message, timestamp: timestamp ?? new Date(), ...metadata });
    return true;
  }

  /** Drain all pending messages, returning them in insertion order. */
  drain(): PendingMessage[] {
    for (const item of this.items) item.onIncluded?.();
    return this.items.splice(0);
  }

  close(): void {
    this.closed = true;
    const pending = this.items.splice(0);
    const errors: unknown[] = [];
    for (const item of pending) {
      try {
        item.onRunEnded?.();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Could not persist guidance disposition");
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get size(): number {
    return this.items.length;
  }
}

export interface AgenticLoopOptions {
  cwd: string;
  maxTurns?: number;
  onChunk?: (text: string) => void;
  abortSignal?: { aborted: boolean };
  /**
   * Optional bounded queue for live user messages injected between turns.
   * When present, the loop drains pending messages after tool execution
   * and uses them as the next user turn instead of `"Continue."`.
   */
  pendingMessages?: PendingMessageQueue;
}

export interface AgenticLoopResult {
  content: string;
  turnCount: number;
  cacheMetrics: AgentCacheUsageMetrics[];
}

/** Tool call from the model (provider-agnostic). */
interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Response from one adapter call. */
interface AdapterResponse {
  text: string;
  toolCalls: ToolCall[];
  /** Opaque state to pass back when sending tool results (e.g. last message id / content). */
  state?: unknown;
  cacheMetrics?: AgentCacheUsageMetrics;
}

/** Adapter interface: stateful so it can send tool results after an assistant turn with tool_use. */
export interface AgenticLoopAdapter {
  /** Send the initial user task (or user message + optional tool results). Returns text, tool calls, and state. */
  send(
    userMessage: string,
    toolResults?: Array<{ id: string; content: string }>,
    state?: unknown
  ): Promise<AdapterResponse>;
}

/** Anthropic adapter. */
export class AnthropicAgenticAdapter implements AgenticLoopAdapter {
  private readonly promptCacheContext: Partial<PromptCacheContext>;

  constructor(
    private client: Anthropic,
    private model: string,
    private systemPrompt: string = SYSTEM_PROMPT,
    promptCacheContext?: Partial<PromptCacheContext>
  ) {
    this.promptCacheContext = promptCacheContext ?? {};
  }

  async send(
    userMessage: string,
    toolResults?: Array<{ id: string; content: string }>,
    state?: unknown
  ): Promise<AdapterResponse> {
    type AnthropicState = { messages: Anthropic.MessageParam[] };
    const promptFingerprint = fingerprintPrompt(this.systemPrompt);
    const prev = state as AnthropicState | undefined;
    const messages: Anthropic.MessageParam[] = prev?.messages ?? [
      { role: "user", content: [toAnthropicTextBlock(userMessage, true)] },
    ];

    if (toolResults?.length) {
      messages.push({
        role: "user",
        content: [
          ...toolResults.map((r) => ({
            type: "tool_result" as const,
            tool_use_id: r.id,
            content: r.content,
          })),
          ...(userMessage === "Continue." ? [] : [{ type: "text" as const, text: userMessage }]),
        ],
      });
    }

    // Anthropic requires streaming for requests that may exceed ~10 minutes; tool loops qualify.
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 16384,
      system: [toAnthropicTextBlock(this.systemPrompt, true)],
      tools: toAnthropicTools() as Anthropic.Tool[],
      messages,
    });
    const response = await stream.finalMessage();
    assertAnthropicCompletion(response);

    const content = response.content ?? [];
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const block of content) {
      if (block.type === "text") {
        text += (block as { text?: string }).text ?? "";
      }
      if (block.type === "tool_use") {
        const t = block as { id?: string; name?: string; input?: Record<string, unknown> };
        toolCalls.push({
          id: t.id ?? "",
          name: t.name ?? "",
          args: t.input ?? {},
        });
      }
    }
    const nextMessages: Anthropic.MessageParam[] = [
      ...messages,
      {
        role: "assistant",
        content: Array.isArray(content) ? content : [{ type: "text" as const, text }],
      },
    ];
    const cacheMetrics = extractAnthropicCacheUsage({
      response,
      flow: this.promptCacheContext.flow ?? "loop",
      promptFingerprint,
    });
    return { text, toolCalls, state: { messages: nextMessages }, cacheMetrics };
  }
}

/** OpenAI adapter. */
export class OpenAIAgenticAdapter implements AgenticLoopAdapter {
  private messageHistory: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  private readonly promptCacheContext: Partial<PromptCacheContext>;

  constructor(
    private client: OpenAI,
    private model: string,
    private systemPrompt: string = SYSTEM_PROMPT,
    promptCacheContext?: Partial<PromptCacheContext>,
    private tokenLimitField: "max_tokens" | "max_completion_tokens" = "max_completion_tokens"
  ) {
    this.promptCacheContext = promptCacheContext ?? {};
  }

  private async createCompletion(
    promptCacheKey: string
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const request = {
      model: this.model,
      messages: this.messageHistory,
      ...(this.tokenLimitField === "max_tokens"
        ? { max_tokens: 16384 }
        : { max_completion_tokens: 16384 }),
      tools: toOpenAITools() as OpenAI.Chat.Completions.ChatCompletionTool[],
      prompt_cache_key: promptCacheKey,
      prompt_cache_retention: "in-memory" as const,
    };
    const response = await this.client.chat.completions.create(request);
    if (!isReasoningOnlyAgentTurn(response.choices?.[0])) {
      return response;
    }

    const fallback = await this.client.chat.completions.create({
      ...request,
      ...(this.tokenLimitField === "max_tokens"
        ? { max_tokens: 32768 }
        : { max_completion_tokens: 32768 }),
    });
    if (isReasoningOnlyAgentTurn(fallback.choices?.[0])) {
      throw new Error(
        "Provider returned reasoning without final content before hitting the response token limit."
      );
    }

    return fallback;
  }

  async send(
    userMessage: string,
    toolResults?: Array<{ id: string; content: string }>,
    _state?: unknown
  ): Promise<AdapterResponse> {
    const promptFingerprint = fingerprintPrompt(this.systemPrompt);
    if (this.messageHistory.length === 0) {
      this.messageHistory = [
        { role: "system", content: this.systemPrompt },
        { role: "user", content: userMessage },
      ];
    } else if (toolResults?.length) {
      for (const r of toolResults) {
        this.messageHistory.push({
          role: "tool",
          content: r.content,
          tool_call_id: r.id,
        });
      }
      this.messageHistory.push({ role: "user", content: userMessage });
    }

    const promptCacheKey = buildOpenAIPromptCacheKey({
      provider: "openai",
      model: this.model,
      flow: this.promptCacheContext.flow ?? "loop",
      projectId: this.promptCacheContext.projectId,
      taskId: this.promptCacheContext.taskId,
      toolSchemaVersion:
        this.promptCacheContext.toolSchemaVersion ?? fingerprintJson(toOpenAITools()),
      instructionsFingerprint: this.promptCacheContext.instructionsFingerprint ?? promptFingerprint,
    });
    const response = await this.createCompletion(promptCacheKey);

    const choice = response.choices?.[0];
    const msg = choice?.message;
    if (!msg) throw new Error("OpenAI-compatible provider returned no message.");
    if (
      msg.refusal ||
      (choice?.finish_reason && !["stop", "tool_calls"].includes(choice.finish_reason))
    ) {
      throw new Error(
        `OpenAI-compatible response did not complete: ${msg.refusal ?? choice?.finish_reason}`
      );
    }

    this.messageHistory.push({
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: msg.tool_calls,
    });

    const text = msg.content ?? "";
    const toolCalls: ToolCall[] = [];
    const rawCalls = msg.tool_calls ?? [];
    for (const tc of rawCalls) {
      const id = tc.id ?? "";
      const fn = "function" in tc ? tc.function : undefined;
      const name = fn?.name ?? "";
      if (!id || !name)
        throw new Error("OpenAI-compatible provider returned an invalid function call.");
      let args: unknown;
      try {
        const raw = fn && "arguments" in fn ? fn.arguments : undefined;
        args = typeof raw === "string" ? JSON.parse(raw) : {};
      } catch {
        throw new Error(`OpenAI-compatible provider returned invalid JSON for tool ${name}.`);
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error(`OpenAI-compatible provider returned invalid arguments for tool ${name}.`);
      }
      toolCalls.push({ id, name, args: args as Record<string, unknown> });
    }
    if (!text && toolCalls.length === 0)
      throw new Error("OpenAI-compatible provider returned no final content or tool calls.");
    const cacheMetrics = extractOpenAICacheUsage({
      response,
      flow: this.promptCacheContext.flow ?? "loop",
      promptFingerprint,
      promptCacheKey,
    });
    return { text, toolCalls, cacheMetrics };
  }
}

/** Responses adapter for current OpenAI reasoning/coding models and Codex API models. */
export class OpenAIResponsesAgenticAdapter implements AgenticLoopAdapter {
  private input: OpenAI.Responses.ResponseInputItem[] = [];

  constructor(
    private client: OpenAI,
    private model: string,
    private systemPrompt: string = SYSTEM_PROMPT,
    private promptCacheContext: Partial<PromptCacheContext> = {}
  ) {}

  async send(
    userMessage: string,
    toolResults?: Array<{ id: string; content: string }>
  ): Promise<AdapterResponse> {
    for (const result of toolResults ?? []) {
      this.input.push({ type: "function_call_output", call_id: result.id, output: result.content });
    }
    this.input.push({ role: "user", content: userMessage });

    const promptFingerprint = fingerprintPrompt(this.systemPrompt);
    const tools: OpenAI.Responses.FunctionTool[] = toOpenAITools().map((tool) => ({
      type: "function",
      ...tool.function,
      // Preserve optional tool arguments instead of implicitly requiring every field.
      strict: false,
    }));
    const promptCacheKey = buildOpenAIPromptCacheKey({
      provider: "openai",
      model: this.model,
      flow: this.promptCacheContext.flow ?? "loop",
      projectId: this.promptCacheContext.projectId,
      taskId: this.promptCacheContext.taskId,
      toolSchemaVersion: this.promptCacheContext.toolSchemaVersion ?? fingerprintJson(tools),
      instructionsFingerprint: this.promptCacheContext.instructionsFingerprint ?? promptFingerprint,
    });
    const request: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
      model: this.model,
      instructions: this.systemPrompt,
      input: [...this.input],
      tools,
      max_output_tokens: 16384,
      store: false,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: promptCacheKey,
      prompt_cache_retention: "in-memory",
    };
    let response = await this.client.responses.create(request);
    if (
      response.status === "incomplete" &&
      response.incomplete_details?.reason === "max_output_tokens"
    ) {
      response = await this.client.responses.create({ ...request, max_output_tokens: 32768 });
    }
    if (response.status && response.status !== "completed") {
      throw new Error(
        `OpenAI response did not complete: ${response.error?.message ?? response.incomplete_details?.reason ?? response.status}`
      );
    }

    const toolCalls: ToolCall[] = [];
    let text = "";
    for (const item of response.output ?? []) {
      if (item.type === "message") {
        for (const content of item.content) {
          if (content.type === "output_text") text += content.text;
        }
      }
      if (item.type !== "function_call") continue;
      if (!item.call_id || !item.name) throw new Error("OpenAI returned an invalid function call.");
      let args: unknown;
      try {
        args = JSON.parse(item.arguments);
      } catch {
        throw new Error(`OpenAI returned invalid JSON for tool ${item.name}.`);
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error(`OpenAI returned invalid arguments for tool ${item.name}.`);
      }
      toolCalls.push({ id: item.call_id, name: item.name, args: args as Record<string, unknown> });
    }
    text = response.output_text || text;
    if (!text && toolCalls.length === 0) {
      throw new Error("OpenAI returned neither final content nor tool calls.");
    }
    // Reasoning items must be replayed with their associated function calls and outputs.
    this.input.push(...(response.output ?? []));
    return {
      text,
      toolCalls,
      cacheMetrics: extractOpenAICacheUsage({
        response,
        flow: this.promptCacheContext.flow ?? "loop",
        promptFingerprint,
        promptCacheKey,
      }),
    };
  }
}

/** Gemini adapter. */
type GeminiPart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: unknown };
};

export class GeminiAgenticAdapter implements AgenticLoopAdapter {
  private contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }> = [];
  private calls = new Map<string, { name: string; providerId?: string }>();
  private nextCallId = 0;

  constructor(
    private ai: GoogleGenAI,
    private model: string,
    private systemPrompt: string = SYSTEM_PROMPT
  ) {}

  async send(
    userMessage: string,
    toolResults?: Array<{ id: string; content: string }>,
    _state?: unknown
  ): Promise<AdapterResponse> {
    if (this.contents.length === 0) {
      this.contents = [{ role: "user", parts: [{ text: userMessage }] }];
    } else if (toolResults?.length) {
      this.contents.push({
        role: "user",
        parts: [
          ...toolResults.map((r) => {
            const call = this.calls.get(r.id);
            return {
              functionResponse: {
                ...(call?.providerId ? { id: call.providerId } : {}),
                name: call?.name ?? r.id,
                response: { result: r.content },
              },
            };
          }),
          { text: userMessage },
        ] as GeminiPart[],
      });
    }

    const tools = toGeminiTools();
    const result = await this.ai.models.generateContent({
      model: this.model,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      contents: this.contents as any,
      config: {
        systemInstruction: this.systemPrompt,
        tools: [{ functionDeclarations: tools }],
      },
    });

    const response = result;
    assertGeminiCompletion(response);
    const candidates = response.candidates;
    const parts =
      candidates?.[0]?.content?.parts ?? (response.text ? [{ text: response.text }] : []);
    const text = getGeminiResponseText(response);
    const toolCalls: ToolCall[] = [];
    for (const part of Array.isArray(parts) ? parts : []) {
      if (typeof part === "object" && part !== null) {
        if ("functionCall" in part && (part as { functionCall?: unknown }).functionCall) {
          const fc = (part as { functionCall: { id?: string; name?: string; args?: unknown } })
            .functionCall;
          if (
            !fc.name ||
            (fc.args != null && (typeof fc.args !== "object" || Array.isArray(fc.args)))
          ) {
            throw new Error("Gemini returned an invalid function call.");
          }
          const id = fc.id ?? `gemini-call-${++this.nextCallId}`;
          this.calls.set(id, { name: fc.name, providerId: fc.id });
          toolCalls.push({
            id,
            name: fc.name,
            args: (fc.args ?? {}) as Record<string, unknown>,
          });
        }
      }
    }
    this.contents.push({
      role: "model",
      parts: (Array.isArray(parts) ? parts : [{ text }]) as GeminiPart[],
    });
    if (!text && toolCalls.length === 0)
      throw new Error("Gemini returned neither final content nor tool calls.");
    return { text, toolCalls };
  }
}

/**
 * Drain the pending-messages queue and build the next user-turn string.
 * Single message → used as-is. Multiple → concatenated with ISO timestamps and delimiters.
 * Empty / no queue → falls back to `"Continue."`.
 */
function drainPendingMessages(queue?: PendingMessageQueue): string {
  if (!queue) return "Continue.";
  const pending = queue.drain();
  if (pending.length === 0) return "Continue.";
  if (pending.length === 1) return pending[0].message;
  return pending.map((p) => `[${p.timestamp.toISOString()}] ${p.message}`).join("\n---\n");
}

/**
 * Run the agentic loop: send the task, then repeatedly handle tool calls until the model returns only text or max turns.
 */
export async function runAgenticLoop(
  adapter: AgenticLoopAdapter,
  taskContent: string,
  options: AgenticLoopOptions
): Promise<AgenticLoopResult> {
  const { cwd, maxTurns = DEFAULT_MAX_TURNS, onChunk, abortSignal } = options;
  const context: AgentToolsContext = { cwd };
  let fullText = "";
  let turnCount = 0;
  const cacheMetrics: AgentCacheUsageMetrics[] = [];
  let state: unknown;
  let userMessage = taskContent;
  let toolResults: Array<{ id: string; content: string }> | undefined;

  try {
    while (turnCount < maxTurns) {
      if (abortSignal?.aborted) break;
      if (turnCount > 0) userMessage = drainPendingMessages(options.pendingMessages);
      turnCount += 1;
      const response = await adapter.send(userMessage, toolResults, state);
      state = response.state;
      fullText += response.text;
      if (response.cacheMetrics) {
        cacheMetrics.push(response.cacheMetrics);
      }
      if (response.text) onChunk?.(response.text);
      if (abortSignal?.aborted) break;
      if (response.toolCalls.length === 0) break;
      toolResults = [];
      for (const tc of response.toolCalls) {
        const content = await executeTool(tc.name, tc.args, context);
        toolResults.push({ id: tc.id, content });
      }
    }

    return { content: fullText, turnCount, cacheMetrics };
  } finally {
    options.pendingMessages?.close();
  }
}
