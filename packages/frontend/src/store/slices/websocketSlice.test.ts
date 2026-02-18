import { describe, it, expect } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import websocketReducer, {
  setConnected,
  setHilRequest,
  setHilNotification,
  clearHilRequest,
  clearHilNotification,
  setDeployToast,
  clearDeployToast,
  resetWebsocket,
  type WebsocketState,
} from "./websocketSlice";
import type { HilRequestEvent } from "@opensprint/shared";

const mockHilRequest: HilRequestEvent = {
  type: "hil.request",
  requestId: "req-1",
  category: "scopeChanges",
  description: "Approve scope change",
  options: [
    { id: "opt-1", label: "Approve", description: "Approve the change" },
  ],
  blocking: true,
};

const mockHilNotification: HilRequestEvent = {
  type: "hil.request",
  requestId: "req-2",
  category: "architectureDecisions",
  description: "Architecture decision",
  options: [
    { id: "opt-2", label: "OK", description: "Acknowledge" },
  ],
  blocking: false,
};

describe("websocketSlice", () => {
  describe("initial state", () => {
    it("has correct initial state", () => {
      const store = configureStore({ reducer: { websocket: websocketReducer } });
      const state = store.getState().websocket as WebsocketState;
      expect(state.connected).toBe(false);
      expect(state.hilRequest).toBeNull();
      expect(state.hilNotification).toBeNull();
      expect(state.deployToast).toBeNull();
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

  describe("setHilRequest", () => {
    it("stores HIL request event", () => {
      const store = configureStore({ reducer: { websocket: websocketReducer } });
      store.dispatch(setHilRequest(mockHilRequest));
      expect(store.getState().websocket.hilRequest).toEqual(mockHilRequest);
    });

    it("clears HIL request when null passed", () => {
      const store = configureStore({ reducer: { websocket: websocketReducer } });
      store.dispatch(setHilRequest(mockHilRequest));
      store.dispatch(setHilRequest(null));
      expect(store.getState().websocket.hilRequest).toBeNull();
    });
  });

  describe("setHilNotification", () => {
    it("stores HIL notification event", () => {
      const store = configureStore({ reducer: { websocket: websocketReducer } });
      store.dispatch(setHilNotification(mockHilNotification));
      expect(store.getState().websocket.hilNotification).toEqual(
        mockHilNotification
      );
    });

    it("clears HIL notification when null passed", () => {
      const store = configureStore({ reducer: { websocket: websocketReducer } });
      store.dispatch(setHilNotification(mockHilNotification));
      store.dispatch(setHilNotification(null));
      expect(store.getState().websocket.hilNotification).toBeNull();
    });
  });

  describe("clearHilRequest", () => {
    it("clears hilRequest to null", () => {
      const store = configureStore({ reducer: { websocket: websocketReducer } });
      store.dispatch(setHilRequest(mockHilRequest));
      store.dispatch(clearHilRequest());
      expect(store.getState().websocket.hilRequest).toBeNull();
    });
  });

  describe("clearHilNotification", () => {
    it("clears hilNotification to null", () => {
      const store = configureStore({ reducer: { websocket: websocketReducer } });
      store.dispatch(setHilNotification(mockHilNotification));
      store.dispatch(clearHilNotification());
      expect(store.getState().websocket.hilNotification).toBeNull();
    });
  });

  describe("setDeployToast", () => {
    it("stores deploy toast", () => {
      const store = configureStore({ reducer: { websocket: websocketReducer } });
      store.dispatch(setDeployToast({ message: "Deployment started", variant: "started" }));
      expect(store.getState().websocket.deployToast).toEqual({
        message: "Deployment started",
        variant: "started",
      });
    });

    it("clears deploy toast when null passed", () => {
      const store = configureStore({ reducer: { websocket: websocketReducer } });
      store.dispatch(setDeployToast({ message: "Deployment succeeded", variant: "succeeded" }));
      store.dispatch(setDeployToast(null));
      expect(store.getState().websocket.deployToast).toBeNull();
    });
  });

  describe("clearDeployToast", () => {
    it("clears deployToast to null", () => {
      const store = configureStore({ reducer: { websocket: websocketReducer } });
      store.dispatch(setDeployToast({ message: "Deployment failed", variant: "failed" }));
      store.dispatch(clearDeployToast());
      expect(store.getState().websocket.deployToast).toBeNull();
    });
  });

  describe("resetWebsocket", () => {
    it("resets all state to initial values", () => {
      const store = configureStore({ reducer: { websocket: websocketReducer } });
      store.dispatch(setConnected(true));
      store.dispatch(setHilRequest(mockHilRequest));
      store.dispatch(setHilNotification(mockHilNotification));
      store.dispatch(setDeployToast({ message: "Deployment started", variant: "started" }));

      store.dispatch(resetWebsocket());

      const state = store.getState().websocket as WebsocketState;
      expect(state.connected).toBe(false);
      expect(state.hilRequest).toBeNull();
      expect(state.hilNotification).toBeNull();
      expect(state.deployToast).toBeNull();
    });
  });
});
