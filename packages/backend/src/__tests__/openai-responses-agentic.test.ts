import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  OpenAIResponsesAgenticAdapter,
  OpenAIAgenticAdapter,
  PendingMessageQueue,
  runAgenticLoop,
} from "../services/agentic-loop.js";

const finalMessage = {
  id: "response-done",
  status: "completed",
  output_text: "Done.",
  output: [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
  ],
};

describe("OpenAI Responses coding adapter", () => {
  it.each(["length", "content_filter"])(
    "rejects partial legacy coding output with terminal reason %s",
    async (finish_reason) => {
      const create = vi.fn().mockResolvedValue({
        choices: [{ finish_reason, message: { content: "partial implementation" } }],
      });
      const adapter = new OpenAIAgenticAdapter(
        { chat: { completions: { create } } } as never,
        "gpt-4.1"
      );
      await expect(adapter.send("Task")).rejects.toThrow(/did not complete/);
    }
  );

  it("rejects malformed legacy tool arguments before tool execution", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "write_file", arguments: "{" },
              },
            ],
          },
        },
      ],
    });
    const adapter = new OpenAIAgenticAdapter(
      { chat: { completions: { create } } } as never,
      "gpt-4.1"
    );
    await expect(adapter.send("Task")).rejects.toThrow(/invalid JSON for tool write_file/);
  });

  it("executes a file tool and replays reasoning, call IDs, outputs and user guidance", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opensprint-responses-"));
    const reasoning = { type: "reasoning", id: "reasoning-1", encrypted_content: "encrypted" };
    const call = {
      type: "function_call",
      id: "function-1",
      call_id: "call-1",
      name: "write_file",
      arguments: JSON.stringify({ path: "result.txt", content: "implemented" }),
    };
    const requests: unknown[] = [];
    const create = vi.fn().mockImplementation(async (request) => {
      requests.push(structuredClone(request));
      return requests.length === 1
        ? { id: "response-tools", status: "completed", output_text: "", output: [reasoning, call] }
        : finalMessage;
    });
    const adapter = new OpenAIResponsesAgenticAdapter(
      { responses: { create } } as never,
      "gpt-6.1-sol"
    );
    const queue = new PendingMessageQueue();
    queue.push("Preserve existing behavior.");
    try {
      const result = await runAgenticLoop(adapter, "Implement the task", {
        cwd: directory,
        pendingMessages: queue,
      });
      expect(await readFile(path.join(directory, "result.txt"), "utf8")).toBe("implemented");
      expect(result.content).toBe("Done.");
      expect(result.turnCount).toBe(2);
      expect(requests[0]).toMatchObject({
        model: "gpt-6.1-sol",
        tools: expect.arrayContaining([
          expect.objectContaining({ type: "function", name: "write_file", strict: false }),
        ]),
        store: false,
        include: ["reasoning.encrypted_content"],
      });
      expect(requests[1]).toMatchObject({
        input: [
          { role: "user", content: "Implement the task" },
          reasoning,
          call,
          { type: "function_call_output", call_id: "call-1", output: "Wrote result.txt" },
          { role: "user", content: "Preserve existing behavior." },
        ],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retries token-limited responses once without accepting incomplete work", async () => {
    const create = vi.fn().mockResolvedValue({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [],
      output_text: "partial",
    });
    const adapter = new OpenAIResponsesAgenticAdapter(
      { responses: { create } } as never,
      "gpt-6-astra"
    );
    await expect(adapter.send("Task")).rejects.toThrow(/did not complete.*max_output_tokens/);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0].max_output_tokens).toBe(32768);
  });

  it("rejects malformed tool arguments instead of executing an empty argument object", async () => {
    const create = vi.fn().mockResolvedValue({
      status: "completed",
      output_text: "",
      output: [{ type: "function_call", name: "write_file", call_id: "call-1", arguments: "{" }],
    });
    const adapter = new OpenAIResponsesAgenticAdapter(
      { responses: { create } } as never,
      "gpt-6.1-sol"
    );
    await expect(adapter.send("Task")).rejects.toThrow(/invalid JSON for tool write_file/);
  });

  it("rejects responses that contain neither tools nor final text", async () => {
    const create = vi.fn().mockResolvedValue({ status: "completed", output_text: "", output: [] });
    const adapter = new OpenAIResponsesAgenticAdapter(
      { responses: { create } } as never,
      "gpt-5.6-sol"
    );
    await expect(adapter.send("Task")).rejects.toThrow(/neither final content nor tool calls/);
  });

  it("uses current completion limits for OpenAI while preserving local server compatibility", async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: "done" } }] });
    const client = { chat: { completions: { create } } } as never;
    await new OpenAIAgenticAdapter(client, "gpt-4.1").send("Task");
    expect(create.mock.calls[0][0]).toMatchObject({ max_completion_tokens: 16384 });
    expect(create.mock.calls[0][0]).not.toHaveProperty("max_tokens");
    await new OpenAIAgenticAdapter(client, "local", undefined, undefined, "max_tokens").send(
      "Task"
    );
    expect(create.mock.calls[1][0]).toMatchObject({ max_tokens: 16384 });
    expect(create.mock.calls[1][0]).not.toHaveProperty("max_completion_tokens");
  });
});
