import { describe, it, expect, beforeEach, vi } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import { waitFor } from "@testing-library/react";
import notificationReducer from "../slices/notificationSlice";
import connectionReducer, { setConnectionError } from "../slices/connectionSlice";
import websocketReducer, { setDeliverToast } from "../slices/websocketSlice";
import openQuestionsReducer from "../slices/openQuestionsSlice";
import { notificationListener } from "./notificationListener";

const mockIsConnectionError = vi.fn();
const mockListByProject = vi.fn();

vi.mock("../../api/client", () => ({
  api: {
    notifications: {
      listByProject: (...args: unknown[]) => mockListByProject(...args),
    },
  },
  isConnectionError: (...args: unknown[]) => mockIsConnectionError(...args),
}));

function createStore() {
  return configureStore({
    reducer: {
      notification: notificationReducer,
      connection: connectionReducer,
      websocket: websocketReducer,
      openQuestions: openQuestionsReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().prepend(notificationListener.middleware),
  });
}

describe("notificationListener", () => {
  beforeEach(() => {
    mockIsConnectionError.mockReset();
    mockListByProject.mockReset();
    mockListByProject.mockResolvedValue([]);
  });

  it("keeps not-found rejections quiet", () => {
    const store = createStore();
    store.dispatch({
      type: "execute/fetchTasks/rejected",
      meta: { requestStatus: "rejected", requestId: "req-1" },
      error: { message: "Task missing", code: "ISSUE_NOT_FOUND" },
    });

    expect(store.getState().notification.items).toHaveLength(0);
  });

  it("turns connection errors into the global banner and clears deliver toast", async () => {
    const store = createStore();
    store.dispatch(setDeliverToast({ message: "Delivering", variant: "started" }));
    mockIsConnectionError.mockReturnValue(true);

    store.dispatch({
      type: "plan/fetchPlans/rejected",
      meta: { requestStatus: "rejected", requestId: "req-2" },
      error: { message: "Network down" },
    });

    await waitFor(() => {
      expect(store.getState().connection.connectionError).toBe(true);
      expect(store.getState().websocket.deliverToast).toBeNull();
      expect(store.getState().notification.items).toHaveLength(0);
    });
  });

  it("maps generic rejected actions to actionable notification text", async () => {
    const store = createStore();
    mockIsConnectionError.mockReturnValue(false);

    store.dispatch({
      type: "plan/fetchPlans/rejected",
      meta: { requestStatus: "rejected", requestId: "req-3" },
      error: { message: "Rejected" },
    });

    await waitFor(() => {
      expect(store.getState().notification.items).toHaveLength(1);
      expect(store.getState().notification.items[0].message).toBe(
        "Failed to load plans. Refresh the page or try again."
      );
    });
  });

  it("clears the connection banner when an API thunk succeeds", async () => {
    const store = createStore();
    store.dispatch(setConnectionError(true));

    store.dispatch({
      type: "plan/fetchPlans/fulfilled",
      meta: { requestStatus: "fulfilled", requestId: "req-4" },
      payload: {},
    });

    await waitFor(() => {
      expect(store.getState().connection.connectionError).toBe(false);
    });
  });

  it("suppresses toast notifications and refetches project notifications for api-blocked failures", async () => {
    const store = createStore();
    mockIsConnectionError.mockReturnValue(false);

    store.dispatch({
      type: "sketch/sendMessage/rejected",
      meta: {
        requestStatus: "rejected",
        requestId: "req-5",
        arg: { projectId: "proj-1", message: "hello" },
      },
      error: { message: "Google Gemini hit a rate limit", code: "AGENT_INVOKE_FAILED" },
    });

    await waitFor(() => {
      expect(store.getState().notification.items).toHaveLength(0);
      expect(mockListByProject).toHaveBeenCalledWith("proj-1");
    });
  });
});
