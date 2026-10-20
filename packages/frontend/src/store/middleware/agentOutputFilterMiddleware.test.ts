import { describe, it, expect, vi, beforeEach } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import { agentOutputFilterMiddleware } from "./agentOutputFilterMiddleware";
import executeReducer, {
  appendAgentOutput,
  setAgentOutputBackfill,
  setSelectedTaskId,
  resetExecute,
  fetchLiveOutputBackfill,
} from "../slices/executeSlice";
import planReducer from "../slices/planSlice";
import websocketReducer from "../slices/websocketSlice";
import { api } from "../../api/client";

describe("agentOutputFilterMiddleware", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  function createStore() {
    return configureStore({
      reducer: { execute: executeReducer, plan: planReducer, websocket: websocketReducer },
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(agentOutputFilterMiddleware),
    });
  }

  it("batches multiple appendAgentOutput actions within window", () => {
    vi.useFakeTimers();
    const store = createStore();
    store.dispatch(setSelectedTaskId("task-1"));

    store.dispatch(appendAgentOutput({ taskId: "task-1", chunk: '{"type":"text","text":"a"}\n' }));
    store.dispatch(appendAgentOutput({ taskId: "task-1", chunk: '{"type":"text","text":"b"}\n' }));
    store.dispatch(appendAgentOutput({ taskId: "task-1", chunk: '{"type":"text","text":"c"}\n' }));

    expect(store.getState().execute.agentOutput["task-1"]).toBeUndefined();

    vi.advanceTimersByTime(200);

    expect(store.getState().execute.agentOutput["task-1"]).toEqual(["abc"]);
    vi.useRealTimers();
  });

  it("flushes buffered output when requestAnimationFrame runs before the max-wait timer", () => {
    vi.useFakeTimers();
    const rafCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const store = createStore();
    store.dispatch(setSelectedTaskId("task-1"));
    store.dispatch(appendAgentOutput({ taskId: "task-1", chunk: '{"type":"text","text":"x"}\n' }));

    expect(store.getState().execute.agentOutput["task-1"]).toBeUndefined();
    expect(rafCallbacks).toHaveLength(1);

    rafCallbacks[0]!(performance.now());
    expect(store.getState().execute.agentOutput["task-1"]).toEqual(["x"]);

    vi.advanceTimersByTime(500);
    expect(store.getState().execute.agentOutput["task-1"]).toEqual(["x"]);

    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("flushes on setSelectedTaskId without waiting for batch window", () => {
    const store = createStore();
    store.dispatch(setSelectedTaskId("task-1"));

    store.dispatch(appendAgentOutput({ taskId: "task-1", chunk: '{"type":"text","text":"x"}\n' }));
    store.dispatch(appendAgentOutput({ taskId: "task-1", chunk: '{"type":"text","text":"y"}\n' }));

    store.dispatch(setSelectedTaskId("task-2"));

    expect(store.getState().execute.agentOutput["task-1"]).toBeUndefined();
  });

  it("does not lose content when flushing on setSelectedTaskId (switch tasks)", () => {
    const store = createStore();
    store.dispatch(setSelectedTaskId("task-1"));

    store.dispatch(appendAgentOutput({ taskId: "task-1", chunk: "first\n" }));
    store.dispatch(setSelectedTaskId("task-2"));
    expect(store.getState().execute.agentOutput["task-1"]).toBeUndefined();

    store.dispatch(setSelectedTaskId("task-1"));
    store.dispatch(appendAgentOutput({ taskId: "task-1", chunk: "second\n" }));
    store.dispatch(setSelectedTaskId(null));
    // Closing sidebar clears agentOutput for previous task to free memory
    expect(store.getState().execute.agentOutput["task-1"]).toBeUndefined();
  });

  it("batches and flushes plain text fragments without newline", () => {
    vi.useFakeTimers();
    const store = createStore();
    store.dispatch(setSelectedTaskId("task-1"));

    store.dispatch(appendAgentOutput({ taskId: "task-1", chunk: "Restoring baseline" }));
    store.dispatch(appendAgentOutput({ taskId: "task-1", chunk: " quality gates on main" }));

    expect(store.getState().execute.agentOutput["task-1"]).toBeUndefined();
    vi.advanceTimersByTime(200);
    expect(store.getState().execute.agentOutput["task-1"]).toEqual([
      "Restoring baseline quality gates on main",
    ]);
    vi.useRealTimers();
  });

  it("discards buffered chunks when setAgentOutputBackfill arrives (prevents duplicate trailing text)", () => {
    vi.useFakeTimers();
    const store = createStore();
    store.dispatch(setSelectedTaskId("task-1"));

    // NDJSON chunks go through the filter and land in the middleware batch buffer
    store.dispatch(
      appendAgentOutput({ taskId: "task-1", chunk: '{"type":"text","text":"hello "}\n' })
    );
    store.dispatch(
      appendAgentOutput({ taskId: "task-1", chunk: '{"type":"text","text":"world"}\n' })
    );

    // Chunks are still in the middleware buffer, not yet in the store
    expect(store.getState().execute.agentOutput["task-1"]).toBeUndefined();

    // Backfill arrives (includes everything up to and including the buffered chunks).
    // filterAgentOutput processes full NDJSON, so use the same format.
    store.dispatch(
      setAgentOutputBackfill({
        taskId: "task-1",
        output: '{"type":"text","text":"hello "}\n{"type":"text","text":"world"}\n',
      })
    );
    expect(store.getState().execute.agentOutput["task-1"]).toEqual(["hello world"]);

    // Advance past the batch window — stale buffer must NOT flush
    vi.advanceTimersByTime(500);
    expect(store.getState().execute.agentOutput["task-1"]).toEqual(["hello world"]);
    vi.useRealTimers();
  });

  it("keeps buffer for other tasks when backfill clears one task", () => {
    vi.useFakeTimers();
    const store = createStore();
    // Before subscription selection is established, generic output actions remain supported.

    store.dispatch(appendAgentOutput({ taskId: "task-1", chunk: '{"type":"text","text":"a1"}\n' }));
    store.dispatch(appendAgentOutput({ taskId: "task-2", chunk: '{"type":"text","text":"b1"}\n' }));

    // Backfill only task-1 — task-2 buffer should be preserved
    store.dispatch(
      setAgentOutputBackfill({
        taskId: "task-1",
        output: '{"type":"text","text":"a1 full"}\n',
      })
    );

    vi.advanceTimersByTime(500);

    expect(store.getState().execute.agentOutput["task-1"]).toEqual(["a1 full"]);
    expect(store.getState().execute.agentOutput["task-2"]).toEqual(["b1"]);
    vi.useRealTimers();
  });

  it("accepts new chunks after backfill without duplication", () => {
    vi.useFakeTimers();
    const store = createStore();
    store.dispatch(setSelectedTaskId("task-1"));

    store.dispatch(
      appendAgentOutput({ taskId: "task-1", chunk: '{"type":"text","text":"old"}\n' })
    );
    store.dispatch(
      setAgentOutputBackfill({
        taskId: "task-1",
        output: '{"type":"text","text":"old content"}\n',
      })
    );

    // New chunk arrives after backfill
    store.dispatch(
      appendAgentOutput({ taskId: "task-1", chunk: '{"type":"text","text":" plus new"}\n' })
    );
    vi.advanceTimersByTime(500);

    expect(store.getState().execute.agentOutput["task-1"]).toEqual(["old content", " plus new"]);
    vi.useRealTimers();
  });

  it("skips stale backfill that would rewind state behind live chunks (prevents duplicate tail)", () => {
    vi.useFakeTimers();
    const store = createStore();
    store.dispatch(setSelectedTaskId("task-1"));

    // WS backfill arrives first with full output
    store.dispatch(
      setAgentOutputBackfill({
        taskId: "task-1",
        output: '{"type":"text","text":"Hello world. "}\n',
      })
    );
    expect(store.getState().execute.agentOutput["task-1"]).toEqual(["Hello world. "]);

    // Live chunk extends the output
    store.dispatch(
      appendAgentOutput({ taskId: "task-1", chunk: '{"type":"text","text":"New sentence."}\n' })
    );
    vi.advanceTimersByTime(200);
    expect(store.getState().execute.agentOutput["task-1"]).toEqual([
      "Hello world. ",
      "New sentence.",
    ]);

    // Stale REST backfill arrives late with only the older content — must be skipped
    store.dispatch(
      setAgentOutputBackfill({
        taskId: "task-1",
        output: '{"type":"text","text":"Hello world. "}\n',
      })
    );

    // State should NOT have been rewound
    expect(store.getState().execute.agentOutput["task-1"]).toEqual([
      "Hello world. ",
      "New sentence.",
    ]);

    // Further live chunks should still append normally
    store.dispatch(
      appendAgentOutput({ taskId: "task-1", chunk: '{"type":"text","text":" More text."}\n' })
    );
    vi.advanceTimersByTime(200);
    expect(store.getState().execute.agentOutput["task-1"]).toEqual([
      "Hello world. ",
      "New sentence.",
      " More text.",
    ]);
    vi.useRealTimers();
  });

  it("accepts fresher backfill that has more content than current state", () => {
    vi.useFakeTimers();
    const store = createStore();
    store.dispatch(setSelectedTaskId("task-1"));

    // Small initial backfill
    store.dispatch(
      setAgentOutputBackfill({
        taskId: "task-1",
        output: '{"type":"text","text":"A"}\n',
      })
    );
    expect(store.getState().execute.agentOutput["task-1"]).toEqual(["A"]);

    // Fresher backfill with more content should be accepted
    store.dispatch(
      setAgentOutputBackfill({
        taskId: "task-1",
        output: '{"type":"text","text":"A"}\n{"type":"text","text":"BCD"}\n',
      })
    );
    expect(store.getState().execute.agentOutput["task-1"]).toEqual(["ABCD"]);
    vi.useRealTimers();
  });
});

it("evicts direct task switches and ignores late/buffered output without losing current output", () => {
  vi.useFakeTimers();
  const store = configureStore({
    reducer: { execute: executeReducer },
    middleware: (defaults) => defaults().concat(agentOutputFilterMiddleware),
  });
  store.dispatch(setSelectedTaskId("A"));
  store.dispatch(setAgentOutputBackfill({ taskId: "A", output: "A output" }));
  store.dispatch(appendAgentOutput({ taskId: "A", chunk: "pending" }));
  store.dispatch(setSelectedTaskId("B"));
  expect(store.getState().execute.agentOutput.A).toBeUndefined();
  expect(store.getState().execute.agentOutputLastReceivedAt.A).toBeUndefined();
  store.dispatch(appendAgentOutput({ taskId: "A", chunk: "late" }));
  store.dispatch(setAgentOutputBackfill({ taskId: "A", output: "late backfill" }));
  store.dispatch(setAgentOutputBackfill({ taskId: "B", output: "B output" }));
  store.dispatch(setSelectedTaskId("B"));
  expect(store.getState().execute.agentOutput.B).toEqual(["B output"]);
  vi.advanceTimersByTime(200);
  expect(store.getState().execute.agentOutput.A).toBeUndefined();
  store.dispatch(setSelectedTaskId(null));
  expect(store.getState().execute.agentOutput.B).toBeUndefined();
  expect(store.getState().execute.agentOutputLastReceivedAt.B).toBeUndefined();
  store.dispatch(setAgentOutputBackfill({ taskId: "B", output: "late after close" }));
  expect(store.getState().execute.agentOutput.B).toBeUndefined();
  vi.useRealTimers();
});

it("discards buffered prior-project output on reset and preserves the next project's selected output", () => {
  vi.useFakeTimers();
  const store = configureStore({
    reducer: { execute: executeReducer },
    middleware: (defaults) => defaults().concat(agentOutputFilterMiddleware),
  });
  store.dispatch(setSelectedTaskId("old-A"));
  store.dispatch(appendAgentOutput({ taskId: "old-A", chunk: "buffered old project output\n" }));
  store.dispatch(resetExecute());
  vi.advanceTimersByTime(200);
  expect(store.getState().execute.agentOutput).toEqual({});
  expect(store.getState().execute.agentOutputLastReceivedAt).toEqual({});
  store.dispatch(appendAgentOutput({ taskId: "old-A", chunk: "late live output\n" }));
  store.dispatch(setAgentOutputBackfill({ taskId: "old-A", output: "late WebSocket backfill" }));
  store.dispatch(
    fetchLiveOutputBackfill.fulfilled(
      { taskId: "old-A", output: "late REST backfill" },
      "old-request",
      { projectId: "old", taskId: "old-A" }
    )
  );
  vi.advanceTimersByTime(200);
  expect(store.getState().execute.agentOutput).toEqual({});
  store.dispatch(setSelectedTaskId("new-B"));
  store.dispatch(setAgentOutputBackfill({ taskId: "new-B", output: "new backfill " }));
  store.dispatch(appendAgentOutput({ taskId: "new-B", chunk: "new live output\n" }));
  vi.advanceTimersByTime(200);
  expect(store.getState().execute.agentOutput["new-B"]).toEqual([
    "new backfill ",
    "new live output\n",
  ]);
  expect(store.getState().execute.agentOutput["old-A"]).toBeUndefined();
  vi.useRealTimers();
});

it.each(["reset", "switch"] as const)(
  "rejects obsolete REST output after %s and reselection of the same task ID",
  async (boundary) => {
    let resolveOld!: (value: { output: string }) => void;
    const request = vi
      .spyOn(api.execute, "liveOutput")
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve;
        })
      )
      .mockResolvedValueOnce({ output: "current project output" });
    try {
      const store = configureStore({
        reducer: { execute: executeReducer },
        middleware: (defaults) => defaults().concat(agentOutputFilterMiddleware),
      });
      store.dispatch(setSelectedTaskId("X"));
      const old = store.dispatch(fetchLiveOutputBackfill({ projectId: "A", taskId: "X" }));
      if (boundary === "reset") store.dispatch(resetExecute());
      else store.dispatch(setSelectedTaskId("Y"));
      store.dispatch(setSelectedTaskId("X"));
      await store.dispatch(fetchLiveOutputBackfill({ projectId: "B", taskId: "X" }));
      resolveOld({
        output: "obsolete prior-session output that is longer than the current output",
      });
      await old;
      expect(store.getState().execute.agentOutput.X).toEqual(["current project output"]);
    } finally {
      request.mockRestore();
    }
  }
);

it("preserves a pending current REST request through same-ID reselection", async () => {
  let resolveCurrent!: (value: { output: string }) => void;
  const request = vi.spyOn(api.execute, "liveOutput").mockReturnValueOnce(
    new Promise((resolve) => {
      resolveCurrent = resolve;
    })
  );
  try {
    const store = configureStore({
      reducer: { execute: executeReducer },
      middleware: (defaults) => defaults().concat(agentOutputFilterMiddleware),
    });
    store.dispatch(setSelectedTaskId("X"));
    const pending = store.dispatch(fetchLiveOutputBackfill({ projectId: "A", taskId: "X" }));
    store.dispatch(setSelectedTaskId("X"));
    resolveCurrent({ output: "valid current output" });
    await pending;
    expect(store.getState().execute.agentOutput.X).toEqual(["valid current output"]);
  } finally {
    request.mockRestore();
  }
});
