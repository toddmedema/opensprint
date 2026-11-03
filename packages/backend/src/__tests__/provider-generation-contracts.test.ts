import { describe, expect, it, vi } from "vitest";
import { AnthropicAgenticAdapter, GeminiAgenticAdapter } from "../services/agentic-loop.js";

// Current wire contracts: https://aistudio.google.com/api-reference/generate-content
// https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons

describe("provider generation contracts", () => {
  it("matches repeated Gemini tool calls by provider ID and replays signed parts unchanged", async () => {
    const parts = [
      {
        functionCall: { id: "call-a", name: "read_file", args: { path: "a.ts" } },
        thoughtSignature: "opaque-signature-a",
      },
      { functionCall: { id: "call-b", name: "read_file", args: { path: "b.ts" } } },
    ];
    const requests: unknown[] = [];
    const generateContent = vi.fn().mockImplementation(async (request) => {
      requests.push(structuredClone(request));
      return requests.length === 1
        ? { candidates: [{ finishReason: "STOP", content: { role: "model", parts } }] }
        : {
            candidates: [
              { finishReason: "STOP", content: { role: "model", parts: [{ text: "done" }] } },
            ],
          };
    });
    const adapter = new GeminiAgenticAdapter(
      { models: { generateContent } } as never,
      "gemini-4-argon"
    );

    const first = await adapter.send("Read both files");
    expect(first.toolCalls.map((call) => call.id)).toEqual(["call-a", "call-b"]);
    await adapter.send("Continue.", [
      { id: "call-a", content: "file a" },
      { id: "call-b", content: "file b" },
    ]);

    expect(requests[1]).toMatchObject({
      contents: expect.arrayContaining([
        { role: "model", parts },
        {
          role: "user",
          parts: expect.arrayContaining([
            {
              functionResponse: { id: "call-a", name: "read_file", response: { result: "file a" } },
            },
            {
              functionResponse: { id: "call-b", name: "read_file", response: { result: "file b" } },
            },
          ]),
        },
      ]),
    });
  });

  it("does not expose Gemini thought-summary parts as the final agent response", async () => {
    const generateContent = vi.fn().mockResolvedValue({
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              { text: "internal summary", thought: true, thoughtSignature: "opaque-signature" },
              { text: "final answer" },
            ],
          },
        },
      ],
    });
    const adapter = new GeminiAgenticAdapter(
      { models: { generateContent } } as never,
      "gemini-4-argon"
    );

    expect((await adapter.send("task")).text).toBe("final answer");
  });

  it.each(["MAX_TOKENS", "SAFETY", "MALFORMED_FUNCTION_CALL", "CONTINUATION"])(
    "does not accept Gemini %s output as a completed coding turn",
    async (finishReason) => {
      const generateContent = vi.fn().mockResolvedValue({
        candidates: [{ finishReason, content: { parts: [{ text: "partial result" }] } }],
      });
      const adapter = new GeminiAgenticAdapter(
        { models: { generateContent } } as never,
        "gemini-4-argon"
      );

      await expect(adapter.send("task")).rejects.toThrow();
    }
  );

  it("reports Gemini prompt blocking rather than silently completing with no content", async () => {
    const generateContent = vi
      .fn()
      .mockResolvedValue({ promptFeedback: { blockReason: "SAFETY" } });
    const adapter = new GeminiAgenticAdapter(
      { models: { generateContent } } as never,
      "gemini-4-argon"
    );

    await expect(adapter.send("task")).rejects.toThrow();
  });

  it("rejects malformed Gemini function arguments before tool execution", async () => {
    const generateContent = vi.fn().mockResolvedValue({
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [{ functionCall: { id: "call-a", name: "read_file", args: "not an object" } }],
          },
        },
      ],
    });
    const adapter = new GeminiAgenticAdapter(
      { models: { generateContent } } as never,
      "gemini-4-argon"
    );

    await expect(adapter.send("task")).rejects.toThrow();
  });

  it("sends Anthropic tool results without adding a synthetic user text turn", async () => {
    const requests: unknown[] = [];
    const stream = vi.fn().mockImplementation((request) => {
      requests.push(structuredClone(request));
      return {
        finalMessage: async () =>
          requests.length === 1
            ? {
                stop_reason: "tool_use",
                content: [
                  { type: "tool_use", id: "tool-a", name: "read_file", input: { path: "a.ts" } },
                ],
              }
            : { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
      };
    });
    const adapter = new AnthropicAgenticAdapter(
      { messages: { stream } } as never,
      "claude-sonnet-5-5"
    );

    const first = await adapter.send("task");
    await adapter.send("Continue.", [{ id: "tool-a", content: "file a" }], first.state);

    expect(requests[1]).toMatchObject({
      messages: expect.arrayContaining([
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-a", content: "file a" }],
        },
      ]),
    });
  });

  it.each(["max_tokens", "refusal", "model_context_window_exceeded"])(
    "does not accept Anthropic %s output as a completed coding turn",
    async (stopReason) => {
      const stream = vi.fn().mockReturnValue({
        finalMessage: async () => ({
          stop_reason: stopReason,
          content: [{ type: "text", text: "partial result" }],
        }),
      });
      const adapter = new AnthropicAgenticAdapter(
        { messages: { stream } } as never,
        "claude-sonnet-5-5"
      );

      await expect(adapter.send("task")).rejects.toThrow();
    }
  );
});
