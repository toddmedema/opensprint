import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export type DeliverToastVariant = "started" | "succeeded" | "failed";

export interface DeliverToast {
  message: string;
  variant: DeliverToastVariant;
}

export interface WebsocketState {
  connected: boolean;
  /** Global toast for deliver.started / deliver.completed (shown regardless of active tab) */
  deliverToast: DeliverToast | null;
}

const initialState: WebsocketState = {
  connected: false,
  deliverToast: null,
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
    resetWebsocket() {
      return initialState;
    },
  },
});

export const { setConnected, setDeliverToast, clearDeliverToast, resetWebsocket } =
  websocketSlice.actions;
export default websocketSlice.reducer;
