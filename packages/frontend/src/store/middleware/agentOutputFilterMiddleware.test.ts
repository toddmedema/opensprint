import { describe, it, expect, vi, beforeEach } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import { agentOutputFilterMiddleware } from "./agentOutputFilterMiddleware";
import executeReducer, {
  appendAgentOutput,
  setSelectedTaskId,
} from "../slices/executeSlice";
import planReducer from "../slices/planSlice";
import websocketReducer from "../slices/websocketSlice";

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

  it("flushes on setSelectedTaskId without waiting for batch window", () => {
    const store = createStore();
    store.dispatch(setSelectedTaskId("task-1"));

    store.dispatch(appendAgentOutput({ taskId: "task-1", chunk: '{"type":"text","text":"x"}\n' }));
    store.dispatch(appendAgentOutput({ taskId: "task-1", chunk: '{"type":"text","text":"y"}\n' }));

    store.dispatch(setSelectedTaskId("task-2"));

    expect(store.getState().execute.agentOutput["task-1"]).toEqual(["xy"]);
  });

  it("does not lose content when flushing on setSelectedTaskId", () => {
    const store = createStore();
    store.dispatch(setSelectedTaskId("task-1"));

    store.dispatch(appendAgentOutput({ taskId: "task-1", chunk: "first\n" }));
    store.dispatch(setSelectedTaskId("task-2"));
    expect(store.getState().execute.agentOutput["task-1"]).toEqual(["first\n"]);

    store.dispatch(setSelectedTaskId("task-1"));
    store.dispatch(appendAgentOutput({ taskId: "task-1", chunk: "second\n" }));
    store.dispatch(setSelectedTaskId(null));
    expect(store.getState().execute.agentOutput["task-1"]).toEqual(["first\n", "second\n"]);
  });
});
