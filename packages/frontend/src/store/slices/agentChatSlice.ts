import { createSlice, createAsyncThunk, type PayloadAction } from "@reduxjs/toolkit";
import { api } from "../../api/client";
import type { AgentChatStatus } from "@opensprint/shared";

export interface AgentChatMessageEntry {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  delivered?: boolean;
  clientMessageId?: string;
  attemptId?: string;
  status?: AgentChatStatus | "sending" | "unknown";
  error?: string;
}

export interface AgentChatState {
  messagesByTaskId: Record<string, AgentChatMessageEntry[]>;
  sendingByTaskId: Record<string, boolean>;
  supportByTaskId: Record<string, { supported: boolean; reason?: string }>;
}

export const initialAgentChatState: AgentChatState = {
  messagesByTaskId: {},
  sendingByTaskId: {},
  supportByTaskId: {},
};

export const fetchAgentChatHistory = createAsyncThunk(
  "agentChat/fetchHistory",
  async ({ projectId, taskId }: { projectId: string; taskId: string }) => {
    const response = await api.tasks.chatHistory(projectId, taskId);
    return { taskId, messages: response.messages, chatSupported: response.chatSupported };
  }
);

export const fetchAgentChatSupport = createAsyncThunk(
  "agentChat/fetchSupport",
  async ({ projectId, taskId }: { projectId: string; taskId: string }) => {
    const response = await api.tasks.chatSupport(projectId, taskId);
    return { taskId, supported: response.supported, reason: response.reason };
  }
);

const agentChatSlice = createSlice({
  name: "agentChat",
  initialState: initialAgentChatState,
  reducers: {
    addOptimisticUserMessage(
      state,
      action: PayloadAction<{ taskId: string; tempId: string; content: string }>
    ) {
      const { taskId, tempId, content } = action.payload;
      if (!state.messagesByTaskId[taskId]) state.messagesByTaskId[taskId] = [];
      state.messagesByTaskId[taskId].push({
        id: tempId,
        role: "user",
        content,
        timestamp: new Date().toISOString(),
        delivered: false,
        clientMessageId: tempId,
        status: "sending",
      });
      state.sendingByTaskId[taskId] = true;
    },

    chatMessageReceived(
      state,
      action: PayloadAction<{
        taskId: string;
        messageId: string;
        timestamp: string;
        clientMessageId?: string;
        attemptId?: string;
        status?: AgentChatStatus;
        error?: string;
      }>
    ) {
      const { taskId, messageId, timestamp, clientMessageId, attemptId, status, error } =
        action.payload;
      const msgs = state.messagesByTaskId[taskId];
      if (!msgs) return;
      const optimistic = msgs.find(
        (m) =>
          m.id === messageId ||
          (clientMessageId !== undefined && m.clientMessageId === clientMessageId)
      );
      if (optimistic) {
        if (optimistic.attemptId && attemptId && optimistic.attemptId !== attemptId) return;
        optimistic.id = messageId;
        optimistic.timestamp = timestamp;
        optimistic.attemptId = attemptId;
        optimistic.status = status ?? "queued";
        optimistic.error = error;
        state.sendingByTaskId[taskId] = msgs.some((m) => m.status === "sending");
      }
    },

    chatResponseReceived(
      state,
      action: PayloadAction<{ taskId: string; messageId: string; content: string }>
    ) {
      const { taskId } = action.payload;
      state.sendingByTaskId[taskId] = false;
    },

    reconcileChatHistory(
      state,
      action: PayloadAction<{
        taskId: string;
        messages: Array<{ id: string; clientMessageId?: string }>;
      }>
    ) {
      const { taskId, messages } = action.payload;
      const ids = new Set(messages.map((message) => message.id));
      const clientIds = new Set(messages.map((message) => message.clientMessageId).filter(Boolean));
      state.messagesByTaskId[taskId] = (state.messagesByTaskId[taskId] ?? []).filter(
        (message) =>
          message.role === "user" && !ids.has(message.id) && !clientIds.has(message.clientMessageId)
      );
      state.sendingByTaskId[taskId] = state.messagesByTaskId[taskId].some(
        (message) => message.status === "sending"
      );
    },

    chatUnsupported(
      state,
      action: PayloadAction<{ taskId: string; reason: string; clientMessageId?: string }>
    ) {
      const { taskId, reason, clientMessageId } = action.payload;
      if (clientMessageId) {
        const message = state.messagesByTaskId[taskId]?.find(
          (m) => m.clientMessageId === clientMessageId
        );
        if (!message) return;
        message.status = "failed";
        message.error = reason;
      } else state.supportByTaskId[taskId] = { supported: false, reason };
      state.sendingByTaskId[taskId] = clientMessageId
        ? (state.messagesByTaskId[taskId]?.some((m) => m.status === "sending") ?? false)
        : false;
    },

    setChatSupport(
      state,
      action: PayloadAction<{ taskId: string; supported: boolean; reason?: string }>
    ) {
      const { taskId, supported, reason } = action.payload;
      state.supportByTaskId[taskId] = { supported, reason };
    },

    resetChatSending(state, action: PayloadAction<{ taskId: string }>) {
      state.sendingByTaskId[action.payload.taskId] = false;
    },

    chatConnectionLost(state) {
      for (const [taskId, messages] of Object.entries(state.messagesByTaskId)) {
        for (const message of messages) {
          if (message.status === "sending") {
            message.status = "unknown";
            message.error = "Connection lost before receipt. Check history before resending.";
          }
        }
        state.sendingByTaskId[taskId] = false;
      }
    },

    chatReceiptTimedOut(state, action: PayloadAction<{ taskId: string; clientMessageId: string }>) {
      const { taskId, clientMessageId } = action.payload;
      const message = state.messagesByTaskId[taskId]?.find(
        (m) => m.clientMessageId === clientMessageId
      );
      if (message?.status === "sending") {
        message.status = "unknown";
        message.error = "Receipt timed out. Check history before resending.";
      }
      state.sendingByTaskId[taskId] =
        state.messagesByTaskId[taskId]?.some((m) => m.status === "sending") ?? false;
    },

    clearChatForTask(state, action: PayloadAction<{ taskId: string }>) {
      delete state.messagesByTaskId[action.payload.taskId];
      delete state.sendingByTaskId[action.payload.taskId];
      delete state.supportByTaskId[action.payload.taskId];
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchAgentChatHistory.fulfilled, (state, action) => {
        const { taskId, messages } = action.payload;
        const existing = state.messagesByTaskId[taskId] ?? [];
        const serverIds = new Set(messages.map((m) => m.id));
        const clientIds = new Set(messages.map((m) => m.clientMessageId).filter(Boolean));
        const localOnly = existing.filter(
          (m) => m.role === "user" && !serverIds.has(m.id) && !clientIds.has(m.clientMessageId)
        );
        state.messagesByTaskId[taskId] = localOnly;
        state.sendingByTaskId[taskId] = localOnly.some((m) => m.status === "sending");
      })
      .addCase(fetchAgentChatSupport.fulfilled, () => {});
  },
});

export const {
  addOptimisticUserMessage,
  chatMessageReceived,
  chatResponseReceived,
  chatUnsupported,
  setChatSupport,
  resetChatSending,
  chatConnectionLost,
  chatReceiptTimedOut,
  clearChatForTask,
  reconcileChatHistory,
} = agentChatSlice.actions;

export type AgentChatRootState = { agentChat?: AgentChatState };

export const selectChatMessages = (state: AgentChatRootState, taskId: string) =>
  state.agentChat?.messagesByTaskId?.[taskId] ?? [];

export const selectChatSending = (state: AgentChatRootState, taskId: string) =>
  state.agentChat?.sendingByTaskId?.[taskId] ?? false;

export const selectChatSupport = (state: AgentChatRootState, taskId: string) =>
  state.agentChat?.supportByTaskId?.[taskId] ?? { supported: true };

export default agentChatSlice.reducer;
