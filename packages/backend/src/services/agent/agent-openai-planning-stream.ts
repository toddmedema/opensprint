import {
  toOpenAIResponsesInputMessage,
  type OpenAIResponsesInputContent,
  type OpenAIResponsesInputMessage,
} from "../../utils/openai-models.js";
import type { PlanningMessage } from "./agent-types.js";

export function buildOpenAIPlanningResponsesInput(
  messages: PlanningMessage[],
  images?: string[]
): OpenAIResponsesInputMessage[] {
  return messages.map((message, index) => {
    const isLastUserMessage = message.role === "user" && index === messages.length - 1;
    const hasImages = isLastUserMessage && images && images.length > 0;
    if (!hasImages) {
      return toOpenAIResponsesInputMessage(message.role, message.content);
    }

    const content: OpenAIResponsesInputContent[] = [{ type: "input_text", text: message.content }];
    for (const image of images) {
      content.push({
        type: "input_image",
        image_url: image.startsWith("data:") ? image : `data:image/png;base64,${image}`,
        detail: "auto",
      });
    }
    return { role: "user", content };
  });
}

export type OpenAIResponsesStreamEvent = {
  type?: string;
  delta?: string;
  message?: string;
  response?: {
    id?: string | null;
    status?: string;
    error?: { message?: string } | null;
    incomplete_details?: { reason?: string } | null;
    usage?: {
      input_tokens_details?: { cached_tokens?: number | null } | null;
    } | null;
  } | null;
};

export async function collectOpenAIResponsesStream(
  stream: AsyncIterable<OpenAIResponsesStreamEvent>,
  onChunk: (chunk: string) => void
): Promise<{
  content: string;
  responseId?: string;
  usage?: {
    input_tokens_details?: { cached_tokens?: number | null } | null;
  } | null;
}> {
  let fullContent = "";
  let completed = false;
  let responseId: string | undefined;
  let usage:
    | {
        input_tokens_details?: { cached_tokens?: number | null } | null;
      }
    | null
    | undefined;
  for await (const event of stream) {
    if (
      event.type === "error" ||
      event.type === "response.failed" ||
      event.type === "response.incomplete"
    ) {
      throw new Error(
        `OpenAI response did not complete: ${event.response?.error?.message ?? event.response?.incomplete_details?.reason ?? event.message ?? event.type}`
      );
    }
    if (event.type === "response.output_text.delta" && event.delta) {
      fullContent += event.delta;
      onChunk(event.delta);
    }
    if (event.type === "response.completed" && event.response) {
      if (event.response.status && event.response.status !== "completed") {
        throw new Error(`OpenAI response did not complete: ${event.response.status}`);
      }
      completed = true;
      responseId = event.response.id ?? undefined;
      usage = event.response.usage;
    }
  }
  if (!completed) throw new Error("OpenAI response stream ended before completion.");
  if (!fullContent.trim()) throw new Error("OpenAI response returned no final text.");
  return { content: fullContent, responseId, usage };
}
