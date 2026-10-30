import { configureStore } from "@reduxjs/toolkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import reducer, {
  addOptimisticUserMessage,
  chatMessageReceived,
} from "../store/slices/agentChatSlice";
import { awaitGuidanceReceipt } from "./awaitGuidanceReceipt";

describe("awaitGuidanceReceipt", () => {
  afterEach(() => vi.useRealTimers());
  const makeStore = () => {
    const store = configureStore({ reducer: { agentChat: reducer } });
    store.dispatch(
      addOptimisticUserMessage({ taskId: "task", tempId: "alice", content: "Recoverable text" })
    );
    return store;
  };
  it("resolves only after the sender's durable receipt, not an optimistic dispatch", async () => {
    const store = makeStore();
    const finish = vi.fn();
    const receipt = awaitGuidanceReceipt(store, "task", "alice", () => {});
    void receipt.then(finish);
    store.dispatch(
      chatMessageReceived({
        taskId: "task",
        messageId: "bob",
        clientMessageId: "bob",
        timestamp: "now",
        status: "queued",
      })
    );
    await Promise.resolve();
    expect(finish).not.toHaveBeenCalled();
    store.dispatch(
      chatMessageReceived({
        taskId: "task",
        messageId: "server-alice",
        clientMessageId: "alice",
        timestamp: "now",
        status: "queued",
      })
    );
    await expect(receipt).resolves.toBe(true);
  });
  it("keeps a timed-out receipt uncertain so the composer can restore the draft", async () => {
    vi.useFakeTimers();
    const store = makeStore();
    const receipt = awaitGuidanceReceipt(store, "task", "alice", () => {});
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(receipt).resolves.toBe(false);
    expect(store.getState().agentChat.messagesByTaskId.task[0].status).toBe("unknown");
    expect(store.getState().agentChat.sendingByTaskId.task).toBe(false);
  });
});
