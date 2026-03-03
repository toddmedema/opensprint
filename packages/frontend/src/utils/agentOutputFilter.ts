/**
 * Filters live agent output to display only messages/content, hiding extra metadata.
 * Supports:
 * - Cursor agent stream-json (NDJSON): extracts text from message_delta, text, content_block_delta
 * - Plain text (Claude CLI, custom agents): passes through unchanged
 */

/**
 * Extract text from a content array (message.content or similar).
 */
function extractTextFromContentArray(content: unknown[]): string | null {
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
      const t = (block as Record<string, unknown>).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}

/**
 * Extract displayable content from a single JSON event.
 * Returns the text to show, or null if the event should be hidden (metadata only).
 */
function extractContentFromEvent(obj: unknown): string | null {
  if (obj === null || typeof obj !== "object") return null;

  const o = obj as Record<string, unknown>;
  const nestedError =
    o.error && typeof o.error === "object" ? (o.error as Record<string, unknown>) : null;
  const explicitErrorMessage =
    typeof o.message === "string"
      ? o.message
      : typeof o.error === "string"
        ? o.error
        : nestedError && typeof nestedError.message === "string"
          ? nestedError.message
          : typeof o.detail === "string"
            ? o.detail
            : null;

  if (
    ((o.type === "error" || o.subtype === "error") && explicitErrorMessage) ||
    (o.status === "error" && explicitErrorMessage)
  ) {
    return `[Agent error: ${explicitErrorMessage}]\n`;
  }

  // Cursor/Anthropic: {"type":"text","text":"..."}
  if (o.type === "text" && typeof o.text === "string") {
    return o.text;
  }

  // message_delta: {"type":"message_delta","delta":{"content":"..."}}
  if (
    o.type === "message_delta" &&
    o.delta &&
    typeof (o.delta as Record<string, unknown>).content === "string"
  ) {
    return (o.delta as Record<string, unknown>).content as string;
  }

  // content_block_delta: {"type":"content_block_delta","delta":{"text":"..."}} or delta.thinking
  if (o.type === "content_block_delta" && o.delta) {
    const delta = o.delta as Record<string, unknown>;
    if (delta.type === "thinking" && typeof delta.thinking === "string") {
      return delta.thinking;
    }
    if (typeof delta.text === "string") {
      return delta.text;
    }
  }

  // message: {"type":"message","content":[{"type":"text","text":"..."}]}
  if (o.type === "message" && Array.isArray(o.content)) {
    return extractTextFromContentArray(o.content);
  }

  // Cursor Composer: {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}
  if (o.type === "assistant" && o.message && typeof o.message === "object") {
    const msg = o.message as Record<string, unknown>;
    if (Array.isArray(msg.content)) {
      return extractTextFromContentArray(msg.content);
    }
  }

  // content_block_start with text: {"type":"content_block_start","content_block":{"type":"text","text":"..."}}
  if (o.type === "content_block_start" && o.content_block) {
    const block = o.content_block as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }

  // thinking: {"type":"thinking","content":"..."} or {"type":"thinking","thinking":"..."} or {"type":"thinking","subtype":"delta","text":"..."} (Cursor Composer)
  if (o.type === "thinking") {
    const content =
      typeof o.content === "string"
        ? o.content
        : typeof o.thinking === "string"
          ? o.thinking
          : typeof o.text === "string"
            ? o.text
            : null;
    return content ? content + "\n" : null;
  }

  // Generic: {"content":"..."} or {"text":"..."}
  if (typeof o.content === "string") return o.content;
  if (typeof o.text === "string") return o.text;

  // Metadata events (tool_use, tool_result, etc.) - hide
  return null;
}

export interface AgentOutputFilter {
  filter(chunk: string): string;
  reset(): void;
}

/**
 * Creates an isolated agent output filter instance.
 * Each instance has its own line buffer - use one per stream to avoid state leaking.
 *
 * @returns Filter instance with filter() and reset() methods
 */
export function createAgentOutputFilter(): AgentOutputFilter {
  let lineBuffer = "";

  return {
    filter(chunk: string): string {
      if (!chunk) return "";

      lineBuffer += chunk;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? ""; // Keep incomplete line in buffer

      const results: string[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const obj = JSON.parse(trimmed) as unknown;
          const content = extractContentFromEvent(obj);
          if (content) {
            results.push(content);
          }
        } catch {
          // Not valid JSON - treat as plain text and pass through
          results.push(line + "\n");
        }
      }

      return results.join("");
    },
    reset(): void {
      lineBuffer = "";
    },
  };
}

/**
 * Filters full NDJSON text (or plain text) in one pass.
 * Use for backfill and archived output; keep streaming filter for live chunks.
 *
 * @param raw - Full NDJSON text or plain text
 * @returns Filtered displayable text
 */
export function filterAgentOutput(raw: string): string {
  if (!raw) return "";
  const f = createAgentOutputFilter();
  let result = f.filter(raw);
  if (!raw.endsWith("\n")) {
    result += f.filter("\n"); // flush incomplete line
  }
  return result;
}
