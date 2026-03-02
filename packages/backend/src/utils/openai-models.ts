export const OPENAI_EXCLUDED_MODEL_PATTERNS = [
  /^text-embedding-/,
  /^text-moderation-/,
  /^omni-moderation-/,
  /^whisper-/,
  /^tts-/,
  /^dall-e-/,
  /^gpt-image-/,
  /^gpt-realtime/,
  /^gpt-audio/,
  /^gpt-4o-(?:audio|mini-audio|realtime|mini-realtime|transcribe)/,
];

const OPENAI_CHAT_PATTERNS = [/^chatgpt-/, /^gpt-/, /^o(?:1|3|4)(?:$|-)/];

export type OpenAIResponsesInputContent =
  | {
      type: "input_text";
      text: string;
    }
  | {
      type: "input_image";
      image_url: string;
      detail: "auto";
    };

export interface OpenAIResponsesInputMessage {
  role: "user" | "assistant" | "system" | "developer";
  content: string | OpenAIResponsesInputContent[];
  type?: "message";
  phase?: "commentary" | "final_answer";
}

export function isOpenAIResponsesModel(model: string | null | undefined): boolean {
  if (!model) return false;
  return model.toLowerCase().includes("codex");
}

export function isOpenAITextModel(id: string): boolean {
  if (!id) return false;
  if (OPENAI_EXCLUDED_MODEL_PATTERNS.some((pattern) => pattern.test(id))) {
    return false;
  }
  return OPENAI_CHAT_PATTERNS.some((pattern) => pattern.test(id)) || isOpenAIResponsesModel(id);
}

export function toOpenAIResponsesInputMessage(
  role: "user" | "assistant",
  content: string
): OpenAIResponsesInputMessage {
  return role === "assistant"
    ? { role, content, phase: "final_answer" }
    : { role, content };
}
