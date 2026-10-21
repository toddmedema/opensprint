import { chatReceiptTimedOut, type AgentChatRootState } from "../store/slices/agentChatSlice";
interface ReceiptStore {
  getState(): AgentChatRootState;
  subscribe(listener: () => void): () => void;
  dispatch(action: ReturnType<typeof chatReceiptTimedOut>): unknown;
}
/** Keep the recoverable composer draft until this exact message has a durable receipt. */
export function awaitGuidanceReceipt(
  store: ReceiptStore,
  taskId: string,
  clientMessageId: string,
  send: () => unknown
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      if (timeout) clearTimeout(timeout);
      resolve(accepted);
    };
    const check = () => {
      const message = store
        .getState()
        .agentChat?.messagesByTaskId[taskId]?.find((m) => m.clientMessageId === clientMessageId);
      if (!message || message.status === "sending") return;
      finish(
        message.status === "queued" ||
          message.status === "included" ||
          message.status === "accepted"
      );
    };
    unsubscribe = store.subscribe(check);
    const timeout = setTimeout(() => {
      store.dispatch(chatReceiptTimedOut({ taskId, clientMessageId }));
      finish(false);
    }, 15_000);
    try {
      send();
      check();
    } catch {
      finish(false);
    }
  });
}
