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

const DEFAULT_MAX_TURNS = 100;
const SYSTEM_PROMPT =
  "You are a coding agent. Execute the task described in the user message. Use the provided tools to read and edit files, run commands, and list or search files. When done, write a result.json file (or report success/failure in your final message).";

export interface AgenticLoopOptions {
  cwd: string;
  maxTurns?: number;
  onChunk?: (text: string) => void;
  abortSignal?: { aborted: boolean };
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
          { type: "text" as const, text: "Continue." },
        ],
      });
    }

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 16384,
      system: [toAnthropicTextBlock(this.systemPrompt, true)],
      tools: toAnthropicTools() as Anthropic.Tool[],
      messages,
    });

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
    promptCacheContext?: Partial<PromptCacheContext>
  ) {
    this.promptCacheContext = promptCacheContext ?? {};
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
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: this.messageHistory,
      max_tokens: 16384,
      tools: toOpenAITools() as OpenAI.Chat.Completions.ChatCompletionTool[],
      prompt_cache_key: promptCacheKey,
      prompt_cache_retention: "in-memory",
    });

    const choice = response.choices?.[0];
    const msg = choice?.message;
    if (!msg) return { text: "", toolCalls: [] };

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
      let args: Record<string, unknown> = {};
      try {
        const raw = fn && "arguments" in fn ? fn.arguments : undefined;
        args = typeof raw === "string" ? JSON.parse(raw) : {};
      } catch {
        // ignore
      }
      toolCalls.push({ id, name, args });
    }
    const cacheMetrics = extractOpenAICacheUsage({
      response,
      flow: this.promptCacheContext.flow ?? "loop",
      promptFingerprint,
      promptCacheKey,
    });
    return { text, toolCalls, cacheMetrics };
  }
}

/** Gemini adapter. */
type GeminiPart = {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
};

export class GeminiAgenticAdapter implements AgenticLoopAdapter {
  private contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }> = [];

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
        parts: toolResults.map((r) => ({
          functionResponse: { name: r.id, response: { result: r.content } },
        })) as GeminiPart[],
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

    const response = result as {
      candidates?: Array<{ content?: { parts?: unknown[] } }>;
      text?: string;
    };
    const candidates = response.candidates;
    const parts =
      candidates?.[0]?.content?.parts ?? (response.text ? [{ text: response.text }] : []);
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const part of Array.isArray(parts) ? parts : []) {
      if (typeof part === "object" && part !== null) {
        if ("text" in part && typeof (part as { text?: string }).text === "string") {
          text += (part as { text: string }).text;
        }
        if ("functionCall" in part && (part as { functionCall?: unknown }).functionCall) {
          const fc = (part as { functionCall: { name?: string; args?: Record<string, unknown> } })
            .functionCall;
          toolCalls.push({
            id: fc.name ?? "",
            name: fc.name ?? "",
            args: fc.args ?? {},
          });
        }
      }
    }
    this.contents.push({
      role: "model",
      parts: (Array.isArray(parts) ? parts : [{ text }]) as GeminiPart[],
    });
    return { text, toolCalls };
  }
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

  while (turnCount < maxTurns) {
    if (abortSignal?.aborted) break;
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
    userMessage = "Continue.";
  }

  return { content: fullText, turnCount, cacheMetrics };
}
