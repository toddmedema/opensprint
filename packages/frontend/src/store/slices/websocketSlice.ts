import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { HilRequestEvent } from "@opensprint/shared";

export interface WebsocketState {
  connected: boolean;
  hilRequest: HilRequestEvent | null;
  hilNotification: HilRequestEvent | null;
}

const initialState: WebsocketState = {
  connected: false,
  hilRequest: null,
  hilNotification: null,
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
  resetWebsocket,
} = websocketSlice.actions;
export default websocketSlice.reducer;
