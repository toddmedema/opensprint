import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { HilRequestEvent } from "@opensprint/shared";

export type DeployToastVariant = "started" | "succeeded" | "failed";

export interface DeployToast {
  message: string;
  variant: DeployToastVariant;
}

export interface WebsocketState {
  connected: boolean;
  hilRequest: HilRequestEvent | null;
  hilNotification: HilRequestEvent | null;
  /** Global toast for deploy.started / deploy.completed (shown regardless of active tab) */
  deployToast: DeployToast | null;
}

const initialState: WebsocketState = {
  connected: false,
  hilRequest: null,
  hilNotification: null,
  deployToast: null,
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
    setDeployToast(state, action: PayloadAction<DeployToast | null>) {
      state.deployToast = action.payload;
    },
    clearDeployToast(state) {
      state.deployToast = null;
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
  setDeployToast,
  clearDeployToast,
  resetWebsocket,
} = websocketSlice.actions;
export default websocketSlice.reducer;
