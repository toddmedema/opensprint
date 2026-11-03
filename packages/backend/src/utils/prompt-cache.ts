import crypto from "crypto";

export const PROMPT_CACHE_VERSION = "v1";

export type PromptCacheProvider = "openai" | "anthropic";
export type PromptCacheFlow = "plan" | "task" | "loop";

export interface PromptEnvelope {
  stablePrefix: string;
  dynamicContext?: string;
  turnState?: string;
}

export interface PromptCacheContext {
  provider: PromptCacheProvider;
  model: string | null | undefined;
  flow: PromptCacheFlow;
  projectId?: string | null;
  role?: string | null;
  contextType?: string | null;
  conversationId?: string | null;
  taskId?: string | null;
  promptVersion?: string | null;
  instructionsFingerprint?: string | null;
  toolSchemaVersion?: string | null;
}

export interface AgentCacheUsageMetrics {
  provider: PromptCacheProvider;
  flow: PromptCacheFlow;
  promptFingerprint: string;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** All input tokens the provider billed, cached ones included. Absent when it did not report them. */
  inputTokens?: number;
  outputTokens?: number;
  promptCacheKey?: string;
  responseId?: string | null;
}

export interface OpenAIResponseChainState {
  responseId: string;
  systemPromptFingerprint: string;
}

const ANTHROPIC_EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" } as const;

export interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export function getAnthropicEphemeralCacheControl(): { type: "ephemeral" } {
  return ANTHROPIC_EPHEMERAL_CACHE_CONTROL;
}

export function toAnthropicTextBlock(text: string, cacheable: boolean = false): AnthropicTextBlock {
  return cacheable
    ? { type: "text", text, cache_control: getAnthropicEphemeralCacheControl() }
    : { type: "text", text };
}

export function normalizePromptText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export function joinPromptSections(...sections: Array<string | null | undefined | false>): string {
  return sections
    .map((section) => (section ? normalizePromptText(section) : ""))
    .filter((section) => section.length > 0)
    .join("\n\n");
}

export function buildPromptEnvelope(envelope: PromptEnvelope): string {
  return joinPromptSections(envelope.stablePrefix, envelope.dynamicContext, envelope.turnState);
}

export function fingerprintPrompt(text: string): string {
  return crypto.createHash("sha256").update(normalizePromptText(text)).digest("hex").slice(0, 16);
}

export function fingerprintJson(value: unknown): string {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

export function buildOpenAIPromptCacheKey(context: PromptCacheContext): string {
  const base = [
    "opensprint",
    PROMPT_CACHE_VERSION,
    "openai",
    sanitizeComponent(context.model),
    sanitizeComponent(context.flow),
    sanitizeComponent(context.projectId),
  ];

  switch (context.flow) {
    case "plan":
      return [
        ...base,
        sanitizeComponent(context.contextType),
        sanitizeComponent(context.conversationId),
        sanitizeComponent(context.instructionsFingerprint),
      ].join(":");
    case "loop":
      return [
        ...base,
        sanitizeComponent(context.taskId),
        sanitizeComponent(context.toolSchemaVersion),
        sanitizeComponent(context.instructionsFingerprint),
      ].join(":");
    case "task":
    default:
      return [
        ...base,
        sanitizeComponent(context.role),
        sanitizeComponent(context.promptVersion),
        sanitizeComponent(context.instructionsFingerprint),
      ].join(":");
  }
}

export function extractOpenAICacheUsage(params: {
  response:
    | {
        id?: string | null;
        usage?: {
          input_tokens?: number | null;
          output_tokens?: number | null;
          prompt_tokens?: number | null;
          completion_tokens?: number | null;
          input_tokens_details?: { cached_tokens?: number | null } | null;
          prompt_tokens_details?: { cached_tokens?: number | null } | null;
        } | null;
      }
    | null
    | undefined;
  flow: PromptCacheFlow;
  promptFingerprint: string;
  promptCacheKey?: string;
}): AgentCacheUsageMetrics {
  const usage = params.response?.usage;
  const cachedTokens =
    usage?.input_tokens_details?.cached_tokens ??
    usage?.prompt_tokens_details?.cached_tokens ??
    null;

  const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens;
  const outputTokens = usage?.output_tokens ?? usage?.completion_tokens;
  return {
    provider: "openai",
    flow: params.flow,
    promptFingerprint: params.promptFingerprint,
    ...(inputTokens != null && outputTokens != null
      ? { inputTokens: Number(inputTokens), outputTokens: Number(outputTokens) }
      : {}),
    cacheReadTokens: cachedTokens == null ? null : Number(cachedTokens),
    cacheWriteTokens: null,
    promptCacheKey: params.promptCacheKey,
    responseId: params.response?.id ?? null,
  };
}

export function extractAnthropicCacheUsage(params: {
  response:
    | {
        usage?: {
          input_tokens?: number | null;
          output_tokens?: number | null;
          cache_creation_input_tokens?: number | null;
          cache_read_input_tokens?: number | null;
        } | null;
      }
    | null
    | undefined;
  flow: PromptCacheFlow;
  promptFingerprint: string;
}): AgentCacheUsageMetrics {
  const usage = params.response?.usage;
  return {
    provider: "anthropic",
    flow: params.flow,
    promptFingerprint: params.promptFingerprint,
    ...(usage?.input_tokens != null && usage.output_tokens != null
      ? {
          inputTokens:
            Number(usage.input_tokens) +
            Number(usage.cache_read_input_tokens ?? 0) +
            Number(usage.cache_creation_input_tokens ?? 0),
          outputTokens: Number(usage.output_tokens),
        }
      : {}),
    cacheReadTokens:
      usage?.cache_read_input_tokens == null ? null : Number(usage.cache_read_input_tokens),
    cacheWriteTokens:
      usage?.cache_creation_input_tokens == null ? null : Number(usage.cache_creation_input_tokens),
  };
}

function sanitizeComponent(value: string | null | undefined): string {
  const normalized = String(value ?? "none")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "none";
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(",")}}`;
}
