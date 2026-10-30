import { describe, it, expect, vi } from "vitest";
import {
  OpenAIAgenticAdapter,
  GeminiAgenticAdapter,
  PendingMessageQueue,
  runAgenticLoop,
  type AgenticLoopAdapter,
} from "../services/agentic-loop.js";

describe("agentic-loop", () => {
  it("includes injected guidance with OpenAI tool results in the provider request", async () => {
    const requests: unknown[] = [];
    const create = vi.fn().mockImplementation(async (request) => {
      requests.push(structuredClone(request));
      return { choices: [{ message: { content: "done", tool_calls: [] }, finish_reason: "stop" }] };
    });
    const adapter = new OpenAIAgenticAdapter(
      { chat: { completions: { create } } } as never,
      "model"
    );
    await adapter.send("task");
    await adapter.send("Please preserve the tests", [{ id: "tool-1", content: "tool output" }]);
    expect(requests[1]).toMatchObject({
      messages: expect.arrayContaining([
        { role: "tool", tool_call_id: "tool-1", content: "tool output" },
        { role: "user", content: "Please preserve the tests" },
      ]),
    });
  });

  it("includes injected guidance with Gemini function responses", async () => {
    const requests: unknown[] = [];
    const generateContent = vi.fn().mockImplementation(async (request) => {
      requests.push(structuredClone(request));
      return { candidates: [{ content: { parts: [{ text: "done" }] } }] };
    });
    const adapter = new GeminiAgenticAdapter({ models: { generateContent } } as never, "model");
    await adapter.send("task");
    await adapter.send("Please preserve the tests", [{ id: "tool-1", content: "tool output" }]);
    expect(requests[1]).toMatchObject({
      contents: expect.arrayContaining([
        {
          role: "user",
          parts: [
            { functionResponse: { name: "tool-1", response: { result: "tool output" } } },
            { text: "Please preserve the tests" },
          ],
        },
      ]),
    });
  });
  it("runAgenticLoop returns text and exits when adapter returns no tool calls", async () => {
    const adapter: AgenticLoopAdapter = {
      send: vi.fn().mockResolvedValue({
        text: "Done.",
        toolCalls: [],
        state: undefined,
      }),
    };
    const result = await runAgenticLoop(adapter, "Task: say done", {
      cwd: "/tmp",
    });
    expect(result.content).toBe("Done.");
    expect(result.turnCount).toBe(1);
    expect(adapter.send).toHaveBeenCalledWith("Task: say done", undefined, undefined);
  });

  it("runAgenticLoop calls onChunk with text", async () => {
    const onChunk = vi.fn();
    const adapter: AgenticLoopAdapter = {
      send: vi.fn().mockResolvedValue({
        text: "chunk1",
        toolCalls: [],
        state: undefined,
      }),
    };
    await runAgenticLoop(adapter, "Task", {
      cwd: "/tmp",
      onChunk,
    });
    expect(onChunk).toHaveBeenCalledWith("chunk1");
  });

  it("runAgenticLoop respects abortSignal", async () => {
    const abortSignal = { aborted: false };
    const adapter: AgenticLoopAdapter = {
      send: vi.fn().mockImplementation(async () => {
        abortSignal.aborted = true;
        return { text: "partial", toolCalls: [], state: undefined };
      }),
    };
    const result = await runAgenticLoop(adapter, "Task", {
      cwd: "/tmp",
      abortSignal,
    });
    expect(result.content).toBe("partial");
    expect(result.turnCount).toBe(1);
  });

  it("runAgenticLoop runs multiple turns when adapter returns tool calls then text", async () => {
    const adapter: AgenticLoopAdapter = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          text: "",
          toolCalls: [{ id: "1", name: "read_file", args: { path: "README.md" } }],
          state: undefined,
        })
        .mockResolvedValueOnce({
          text: "final",
          toolCalls: [],
          state: undefined,
        }),
    };
    const result = await runAgenticLoop(adapter, "Task", {
      cwd: "/tmp",
      maxTurns: 5,
    });
    expect(result.turnCount).toBe(2);
    expect(result.content).toContain("final");
    expect(adapter.send).toHaveBeenCalledTimes(2);
  });

  it("OpenAIAgenticAdapter retries reasoning-only final turns before returning text", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        choices: [
          {
            message: { content: "", reasoning: "thinking", tool_calls: [] },
            finish_reason: "length",
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: "final", tool_calls: [] }, finish_reason: "stop" }],
      });
    const client = {
      chat: {
        completions: {
          create,
        },
      },
    };

    const adapter = new OpenAIAgenticAdapter(client as never, "local-model");
    const response = await adapter.send("Task");

    expect(create).toHaveBeenCalledTimes(2);
    expect(response.text).toBe("final");
    expect(response.toolCalls).toEqual([]);
  });
});

describe("PendingMessageQueue", () => {
  it("clears all queued messages and attempts every terminal callback if persistence fails", () => {
    const q = new PendingMessageQueue();
    const second = vi.fn();
    q.push("first", undefined, {
      onRunEnded: () => {
        throw new Error("disk full");
      },
    });
    q.push("second", undefined, { onRunEnded: second });
    expect(() => q.close()).toThrow(/Could not persist/);
    expect(second).toHaveBeenCalledOnce();
    expect(q.size).toBe(0);
    expect(q.isClosed).toBe(true);
  });
  it("push accepts messages up to capacity and rejects beyond it", () => {
    const q = new PendingMessageQueue(3);
    expect(q.push("a")).toBe(true);
    expect(q.push("b")).toBe(true);
    expect(q.push("c")).toBe(true);
    expect(q.push("d")).toBe(false);
    expect(q.size).toBe(3);
  });

  it("drain returns all messages and empties the queue", () => {
    const q = new PendingMessageQueue();
    q.push("one");
    q.push("two");
    const drained = q.drain();
    expect(drained).toHaveLength(2);
    expect(drained[0].message).toBe("one");
    expect(drained[1].message).toBe("two");
    expect(q.size).toBe(0);
  });

  it("drain returns empty array when queue is empty", () => {
    const q = new PendingMessageQueue();
    expect(q.drain()).toEqual([]);
  });

  it("preserves custom timestamps", () => {
    const q = new PendingMessageQueue();
    const ts = new Date("2025-06-01T12:00:00Z");
    q.push("msg", ts);
    const [item] = q.drain();
    expect(item.timestamp).toBe(ts);
  });

  it("defaults capacity to 10", () => {
    const q = new PendingMessageQueue();
    expect(q.capacity).toBe(10);
    for (let i = 0; i < 10; i++) expect(q.push(`m${i}`)).toBe(true);
    expect(q.push("overflow")).toBe(false);
    expect(q.size).toBe(10);
  });
});

describe("agentic-loop pendingMessages integration", () => {
  function toolCallThenDone(): AgenticLoopAdapter {
    return {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          text: "",
          toolCalls: [{ id: "t1", name: "read_file", args: { path: "x" } }],
          state: "s1",
        })
        .mockResolvedValueOnce({
          text: "done",
          toolCalls: [],
          state: "s2",
        }),
    };
  }

  it("injects a single pending message as the next user turn", async () => {
    const adapter = toolCallThenDone();
    const q = new PendingMessageQueue();
    q.push("Please also fix the tests");

    const result = await runAgenticLoop(adapter, "Task", {
      cwd: "/tmp",
      maxTurns: 5,
      pendingMessages: q,
    });

    expect(result.turnCount).toBe(2);
    expect(adapter.send).toHaveBeenCalledTimes(2);
    const secondCall = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(secondCall[0]).toBe("Please also fix the tests");
  });

  it("concatenates multiple pending messages with timestamps and delimiters", async () => {
    const adapter = toolCallThenDone();
    const q = new PendingMessageQueue();
    const t1 = new Date("2025-06-01T10:00:00Z");
    const t2 = new Date("2025-06-01T10:01:00Z");
    q.push("First message", t1);
    q.push("Second message", t2);

    await runAgenticLoop(adapter, "Task", {
      cwd: "/tmp",
      maxTurns: 5,
      pendingMessages: q,
    });

    const secondCall = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[1];
    const msg: string = secondCall[0];
    expect(msg).toContain("[2025-06-01T10:00:00.000Z] First message");
    expect(msg).toContain("---");
    expect(msg).toContain("[2025-06-01T10:01:00.000Z] Second message");
  });

  it("falls back to 'Continue.' when the queue is empty", async () => {
    const adapter = toolCallThenDone();
    const q = new PendingMessageQueue();

    await runAgenticLoop(adapter, "Task", {
      cwd: "/tmp",
      maxTurns: 5,
      pendingMessages: q,
    });

    const secondCall = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(secondCall[0]).toBe("Continue.");
  });

  it("falls back to 'Continue.' when no pendingMessages option is provided", async () => {
    const adapter = toolCallThenDone();

    await runAgenticLoop(adapter, "Task", {
      cwd: "/tmp",
      maxTurns: 5,
    });

    const secondCall = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(secondCall[0]).toBe("Continue.");
  });

  it("drains the queue so messages are not re-sent on subsequent turns", async () => {
    const adapter: AgenticLoopAdapter = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          text: "",
          toolCalls: [{ id: "t1", name: "read_file", args: { path: "a" } }],
          state: "s1",
        })
        .mockResolvedValueOnce({
          text: "",
          toolCalls: [{ id: "t2", name: "read_file", args: { path: "b" } }],
          state: "s2",
        })
        .mockResolvedValueOnce({
          text: "done",
          toolCalls: [],
          state: "s3",
        }),
    };
    const q = new PendingMessageQueue();
    q.push("User hint");

    await runAgenticLoop(adapter, "Task", {
      cwd: "/tmp",
      maxTurns: 5,
      pendingMessages: q,
    });

    const calls = (adapter.send as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[1][0]).toBe("User hint");
    expect(calls[2][0]).toBe("Continue.");
  });

  it("closes undrained messages when the agent completes", async () => {
    const adapter: AgenticLoopAdapter = {
      send: vi.fn().mockResolvedValue({
        text: "done",
        toolCalls: [],
        state: undefined,
      }),
    };
    const q = new PendingMessageQueue();
    q.push("late message");

    await runAgenticLoop(adapter, "Task", {
      cwd: "/tmp",
      pendingMessages: q,
    });

    expect(q.size).toBe(0);
    expect(q.isClosed).toBe(true);
  });
});
