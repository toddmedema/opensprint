import { describe, expect, it, vi } from "vitest";
import {
  collectOpenAIResponsesStream,
  type OpenAIResponsesStreamEvent,
} from "../services/agent/agent-openai-planning-stream.js";

// https://developers.openai.com/api/reference/resources/responses/streaming-events

function events(...items: OpenAIResponsesStreamEvent[]) {
  return (async function* () {
    yield* items;
  })();
}

describe("OpenAI planning stream completion", () => {
  it("only returns successful text after the response.completed event", async () => {
    const onChunk = vi.fn();
    const result = await collectOpenAIResponsesStream(
      events(
        { type: "response.output_text.delta", delta: "complete plan" },
        {
          type: "response.completed",
          response: { id: "response-a", usage: { input_tokens_details: { cached_tokens: 40 } } },
        }
      ),
      onChunk
    );

    expect(result).toEqual({
      content: "complete plan",
      responseId: "response-a",
      usage: { input_tokens_details: { cached_tokens: 40 } },
    });
    expect(onChunk).toHaveBeenCalledWith("complete plan");
  });

  it.each(["response.failed", "response.incomplete", "error"])(
    "does not accept partial text followed by %s",
    async (type) => {
      await expect(
        collectOpenAIResponsesStream(
          events({ type: "response.output_text.delta", delta: "partial plan" }, { type }),
          vi.fn()
        )
      ).rejects.toThrow();
    }
  );

  it("does not accept disconnected streams as completed plans", async () => {
    await expect(
      collectOpenAIResponsesStream(
        events({ type: "response.output_text.delta", delta: "partial plan" }),
        vi.fn()
      )
    ).rejects.toThrow();
  });

  it("does not accept an empty completed response as a useful plan", async () => {
    await expect(
      collectOpenAIResponsesStream(
        events({ type: "response.completed", response: { id: "empty-response" } }),
        vi.fn()
      )
    ).rejects.toThrow();
  });
});
