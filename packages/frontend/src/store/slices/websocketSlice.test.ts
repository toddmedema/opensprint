import { describe, it, expect } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import websocketReducer, {
  setConnected,
  setDeliverToast,
  clearDeliverToast,
  resetWebsocket,
  type WebsocketState,
} from "./websocketSlice";

describe("websocketSlice", () => {
  describe("initial state", () => {
    it("has correct initial state", () => {
      const store = configureStore({ reducer: { websocket: websocketReducer } });
      const state = store.getState().websocket as WebsocketState;
      expect(state.connected).toBe(false);
      expect(state.deliverToast).toBeNull();
    });
  });

  describe("setConnected", () => {
    it("sets connected to true", () => {
      const store = configureStore({ reducer: { websocket: websocketReducer } });
      store.dispatch(setConnected(true));
      expect(store.getState().websocket.connected).toBe(true);
    });

    it("sets connected to false", () => {
      const store = configureStore({ reducer: { websocket: websocketReducer } });
      store.dispatch(setConnected(true));
      store.dispatch(setConnected(false));
      expect(store.getState().websocket.connected).toBe(false);
    });
  });

  describe("setDeliverToast", () => {
    it("stores deliver toast", () => {
      const store = configureStore({ reducer: { websocket: websocketReducer } });
      store.dispatch(setDeliverToast({ message: "Delivery started", variant: "started" }));
      expect(store.getState().websocket.deliverToast).toEqual({
        message: "Delivery started",
        variant: "started",
      });
    });

    it("clears deliver toast when null passed", () => {
      const store = configureStore({ reducer: { websocket: websocketReducer } });
      store.dispatch(setDeliverToast({ message: "Delivery succeeded", variant: "succeeded" }));
      store.dispatch(setDeliverToast(null));
      expect(store.getState().websocket.deliverToast).toBeNull();
    });
  });

  describe("clearDeliverToast", () => {
    it("clears deliverToast to null", () => {
      const store = configureStore({ reducer: { websocket: websocketReducer } });
      store.dispatch(setDeliverToast({ message: "Delivery failed", variant: "failed" }));
      store.dispatch(clearDeliverToast());
      expect(store.getState().websocket.deliverToast).toBeNull();
    });
  });

  describe("resetWebsocket", () => {
    it("resets all state to initial values", () => {
      const store = configureStore({ reducer: { websocket: websocketReducer } });
      store.dispatch(setConnected(true));
      store.dispatch(setDeliverToast({ message: "Delivery started", variant: "started" }));

      store.dispatch(resetWebsocket());

      const state = store.getState().websocket as WebsocketState;
      expect(state.connected).toBe(false);
      expect(state.deliverToast).toBeNull();
    });
  });
});
