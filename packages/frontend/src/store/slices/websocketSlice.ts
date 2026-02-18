import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { HilRequestEvent } from "@opensprint/shared";

export type DeliverToastVariant = "started" | "succeeded" | "failed";

export interface DeliverToast {
  message: string;
  variant: DeliverToastVariant;
}

export interface WebsocketState {
  connected: boolean;
  hilRequest: HilRequestEvent | null;
  hilNotification: HilRequestEvent | null;
  /** Global toast for deliver.started / deliver.completed (shown regardless of active tab) */
  deliverToast: DeliverToast | null;
}

const initialState: WebsocketState = {
  connected: false,
  hilRequest: null,
  hilNotification: null,
  deliverToast: null,
};

const websocketSlice = createSlice({
  name: "websocket",
  initialState,
  reducers: {
    setConnected(state, action: PayloadAction<boolean>) {
      state.connected = action.payload;
    },
    setHilRequest(state, action: PayloadAction<HilRequestEvent | null>) {
      state.hilRequest = action.payload;
    },
    setHilNotification(state, action: PayloadAction<HilRequestEvent | null>) {
      state.hilNotification = action.payload;
    },
    clearHilRequest(state) {
      state.hilRequest = null;
    },
    clearHilNotification(state) {
      state.hilNotification = null;
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

export const {
  setConnected,
  setHilRequest,
  setHilNotification,
  clearHilRequest,
  clearHilNotification,
  setDeliverToast,
  clearDeliverToast,
  resetWebsocket,
} = websocketSlice.actions;
export default websocketSlice.reducer;
