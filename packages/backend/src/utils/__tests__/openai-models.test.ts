import { describe, expect, it } from "vitest";
import { isOpenAIResponsesModel, isOpenAITextModel } from "../openai-models.js";

describe("OpenAI model API capabilities", () => {
  it.each([
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6.1-terra",
    "gpt-6-luna",
    "gpt-5.5",
    "gpt-5-mini",
    "gpt-5.3-codex",
    "o3-pro",
    "o1-pro",
  ])("routes modern model %s to Responses for agent tool support", (id) => {
    expect(isOpenAITextModel(id)).toBe(true);
    expect(isOpenAIResponsesModel(id)).toBe(true);
  });

  it.each(["gpt-4o", "gpt-4.1", "o3", null, undefined])("retains legacy routing for %s", (id) =>
    expect(isOpenAIResponsesModel(id)).toBe(false)
  );

  it.each([
    "gpt-transcribe",
    "gpt-live-1",
    "gpt-audio-1.5",
    "gpt-realtime-2.1",
    "chatgpt-image-latest",
    "gpt-image-2.5-sunburst",
    "gpt-3.5-turbo-instruct",
    "gpt-4o-search-preview",
    "o3-deep-research",
    "text-embedding-3-large",
  ])("does not offer specialized model %s as a general coding agent", (id) =>
    expect(isOpenAITextModel(id)).toBe(false)
  );
});
