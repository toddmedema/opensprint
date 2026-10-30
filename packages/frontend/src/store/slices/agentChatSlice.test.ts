import { describe, it, expect } from "vitest";
import reducer, {
  addOptimisticUserMessage,
  chatMessageReceived,
  chatConnectionLost,
  chatUnsupported,
  fetchAgentChatHistory,
} from "./agentChatSlice";

describe("guidance receipt correlation", () => {
  const pending = () =>
    reducer(
      undefined,
      addOptimisticUserMessage({ taskId: "task", tempId: "alice", content: "Alice guidance" })
    );
  it("never acknowledges another sender's optimistic message", () => {
    const state = reducer(
      pending(),
      chatMessageReceived({
        taskId: "task",
        messageId: "server-bob",
        clientMessageId: "bob",
        timestamp: "now",
        status: "queued",
      })
    );
    expect(state.messagesByTaskId.task[0]).toMatchObject({ id: "alice", status: "sending" });
    expect(state.sendingByTaskId.task).toBe(true);
  });
  it("clears receipt wait on queue acceptance and preserves exact attempt inclusion", () => {
    let state = reducer(
      pending(),
      chatMessageReceived({
        taskId: "task",
        messageId: "server-alice",
        clientMessageId: "alice",
        timestamp: "now",
        attemptId: "run-1",
        status: "queued",
      })
    );
    expect(state.sendingByTaskId.task).toBe(false);
    state = reducer(
      state,
      chatMessageReceived({
        taskId: "task",
        messageId: "server-alice",
        clientMessageId: "alice",
        timestamp: "now",
        attemptId: "run-2",
        status: "included",
      })
    );
    expect(state.messagesByTaskId.task[0].status).toBe("queued");
    state = reducer(
      state,
      chatMessageReceived({
        taskId: "task",
        messageId: "server-alice",
        clientMessageId: "alice",
        timestamp: "now",
        attemptId: "run-1",
        status: "included",
      })
    );
    expect(state.messagesByTaskId.task[0].status).toBe("included");
  });
  it("makes lost receipts uncertain and reconciles history by client ID without duplicates", () => {
    let state = reducer(pending(), chatConnectionLost());
    expect(state.messagesByTaskId.task[0].status).toBe("unknown");
    expect(state.sendingByTaskId.task).toBe(false);
    state = reducer(
      state,
      fetchAgentChatHistory.fulfilled(
        {
          taskId: "task",
          chatSupported: true,
          messages: [
            {
              id: "server-alice",
              clientMessageId: "alice",
              timestamp: "now",
              role: "user",
              content: "Alice guidance",
              attempt: 1,
              status: "queued",
            },
          ],
        },
        "request",
        { projectId: "project", taskId: "task" }
      )
    );
    expect(state.messagesByTaskId.task).toHaveLength(1);
    expect(state.messagesByTaskId.task[0]).toMatchObject({ id: "server-alice", status: "queued" });
  });
  it("correlates rejection without disabling chat for a capacity error", () => {
    const state = reducer(
      pending(),
      chatUnsupported({ taskId: "task", clientMessageId: "alice", reason: "Queue full" })
    );
    expect(state.messagesByTaskId.task[0]).toMatchObject({ status: "failed", error: "Queue full" });
    expect(state.supportByTaskId.task).toBeUndefined();
    expect(state.sendingByTaskId.task).toBe(false);
  });
});
