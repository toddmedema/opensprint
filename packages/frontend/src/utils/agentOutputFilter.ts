/**
 * Filters live agent output to display only messages/content, hiding extra metadata.
 * Supports:
 * - Cursor agent stream-json (NDJSON): extracts text from message_delta, text, content_block_delta
 * - Plain text (Claude CLI, custom agents): passes through unchanged
 */

export interface AgentOutputFilter {
  /** Filter a chunk of agent output to extract only displayable content. */
  filter(chunk: string): string;
  /** Reset the line buffer. Call when switching tasks or starting a new stream. */
  reset(): void;
}

/**
 * Extract displayable content from a single JSON event.
 * Returns the text to show, or null if the event should be hidden (metadata only).
 */
function extractContentFromEvent(obj: unknown): string | null {
  if (obj === null || typeof obj !== "object") return null;

  const o = obj as Record<string, unknown>;

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

  // content_block_delta: {"type":"content_block_delta","delta":{"text":"..."}}
  if (
    o.type === "content_block_delta" &&
    o.delta &&
    typeof (o.delta as Record<string, unknown>).text === "string"
  ) {
    return (o.delta as Record<string, unknown>).text as string;
  }

  // message: {"type":"message","content":[{"type":"text","text":"..."}]}
  if (o.type === "message" && Array.isArray(o.content)) {
    const parts: string[] = [];
    for (const block of o.content) {
      if (
        block &&
        typeof block === "object" &&
        (block as Record<string, unknown>).type === "text"
      ) {
        const t = (block as Record<string, unknown>).text;
        if (typeof t === "string") parts.push(t);
      }
    }
    return parts.length > 0 ? parts.join("") : null;
  }

  // content_block_start with text: {"type":"content_block_start","content_block":{"type":"text","text":"..."}}
  if (o.type === "content_block_start" && o.content_block) {
    const block = o.content_block as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }

  // Generic: {"content":"..."} or {"text":"..."}
  if (typeof o.content === "string") return o.content;
  if (typeof o.text === "string") return o.text;

  // Metadata events (tool_use, tool_result, etc.) - hide
  return null;
}

/**
 * Factory: creates an isolated agent output filter with its own line buffer.
 * Each consumer should create its own instance to avoid shared mutable state.
 */
export function createAgentOutputFilter(): AgentOutputFilter {
  let lineBuffer = "";

  return {
    filter(chunk: string): string {
      if (!chunk) return "";

      lineBuffer += chunk;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";

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
