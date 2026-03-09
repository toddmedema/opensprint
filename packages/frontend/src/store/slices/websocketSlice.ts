import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export type DeliverToastVariant = "started" | "succeeded" | "failed";

export interface DeliverToast {
  message: string;
  variant: DeliverToastVariant;
}

/** Shown when a coding/review agent fails so the user sees the error without opening the task. */
export interface AgentFailureToast {
  taskId: string;
  reason: string;
}

export interface WebsocketState {
  connected: boolean;
  /** Global toast for deliver.started / deliver.completed (shown regardless of active tab) */
  deliverToast: DeliverToast | null;
  /** Toast when an agent run fails (reason is the surfaced error message) */
  agentFailureToast: AgentFailureToast | null;
}

const initialState: WebsocketState = {
  connected: false,
  deliverToast: null,
  agentFailureToast: null,
};

const websocketSlice = createSlice({
  name: "websocket",
  initialState,
  reducers: {
    setConnected(state, action: PayloadAction<boolean>) {
      state.connected = action.payload;
    },
    setDeliverToast(state, action: PayloadAction<DeliverToast | null>) {
      state.deliverToast = action.payload;
    },
    clearDeliverToast(state) {
      state.deliverToast = null;
    },
    setAgentFailureToast(state, action: PayloadAction<AgentFailureToast | null>) {
      state.agentFailureToast = action.payload;
    },
    clearAgentFailureToast(state) {
      state.agentFailureToast = null;
    },
    resetWebsocket() {
      return initialState;
    },
  },
});

export const {
  setConnected,
  setDeliverToast,
  clearDeliverToast,
  setAgentFailureToast,
  clearAgentFailureToast,
  resetWebsocket,
} = websocketSlice.actions;
export default websocketSlice.reducer;
