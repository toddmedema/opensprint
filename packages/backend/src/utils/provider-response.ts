/** Reject provider terminal states that cannot represent completed agent work. */
export function assertAnthropicCompletion(response: { stop_reason?: string | null }): void {
  const reason = response.stop_reason;
  if (reason && !["end_turn", "stop_sequence", "tool_use"].includes(reason)) {
    throw new Error(`Anthropic response did not complete: ${reason}`);
  }
}

export interface GeminiResponseLike {
  promptFeedback?: { blockReason?: string };
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
  }>;
  text?: string | (() => string);
}

export function assertGeminiCompletion(response: GeminiResponseLike): void {
  const blocked = response.promptFeedback?.blockReason;
  if (blocked && blocked !== "BLOCK_REASON_UNSPECIFIED") {
    throw new Error(`Gemini blocked the prompt: ${blocked}`);
  }
  const reason = response.candidates?.[0]?.finishReason;
  if (reason && reason !== "STOP") {
    throw new Error(`Gemini response did not complete: ${reason}`);
  }
}

/** Keep thought summaries out of visible output while retaining raw signed parts in history. */
export function getGeminiResponseText(response: GeminiResponseLike): string {
  const parts = response.candidates?.[0]?.content?.parts;
  if (parts) {
    return parts
      .filter((part) => !part.thought && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
  }
  try {
    return typeof response.text === "function" ? (response.text() ?? "") : (response.text ?? "");
  } catch {
    return "";
  }
}
