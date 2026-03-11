import { describe, it, expect, beforeEach, vi } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import { waitFor } from "@testing-library/react";
import notificationReducer, { addNotification } from "../slices/notificationSlice";
import connectionReducer, { setConnectionError, dbStatusRestored } from "../slices/connectionSlice";
import websocketReducer, { setDeliverToast } from "../slices/websocketSlice";
import openQuestionsReducer from "../slices/openQuestionsSlice";
import {
  notificationListener,
  CONNECTION_TOAST_MESSAGE_PATTERN,
  getApiErrorHint,
} from "./notificationListener";
import { DB_STATUS_QUERY_KEY } from "../../api/hooks/db-status";

const mockIsConnectionError = vi.fn();
const mockListByProject = vi.fn();
const mockInvalidateQueries = vi.fn();

vi.mock("../../api/client", () => ({
  api: {
    notifications: {
      listByProject: (...args: unknown[]) => mockListByProject(...args),
    },
  },
  isConnectionError: (...args: unknown[]) => mockIsConnectionError(...args),
}));

vi.mock("../../queryClient", () => ({
  getQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}));

function createStore(preloadedState?: { connection?: { connectionError: boolean; lastRecoveredAt: number | null } }) {
  return configureStore({
    reducer: {
      notification: notificationReducer,
      connection: connectionReducer,
      websocket: websocketReducer,
      openQuestions: openQuestionsReducer,
    },
    preloadedState,
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().prepend(notificationListener.middleware),
  });
}

describe("getApiErrorHint", () => {
  it("returns Global Settings copy for ANTHROPIC_API_KEY_MISSING", () => {
    expect(getApiErrorHint("ANTHROPIC_API_KEY_MISSING")).toBe(
      "Add Anthropic API key in Global Settings → API keys."
    );
  });
});

describe("notificationListener", () => {
  beforeEach(() => {
    mockIsConnectionError.mockReset();
    mockListByProject.mockReset();
    mockListByProject.mockResolvedValue([]);
    mockInvalidateQueries.mockReset();
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

  it("dismisses connection/PostgreSQL error toasts when connection is restored (API thunk succeeds)", async () => {
    const store = createStore();
    store.dispatch(setConnectionError(true));
    store.dispatch(
      addNotification({
        message: "Reconnecting to PostgreSQL...",
        severity: "error",
      })
    );
    expect(store.getState().notification.items).toHaveLength(1);

    store.dispatch({
      type: "plan/fetchPlans/fulfilled",
      meta: { requestStatus: "fulfilled", requestId: "req-recovery" },
      payload: {},
    });

    await waitFor(() => {
      expect(store.getState().connection.connectionError).toBe(false);
      expect(store.getState().notification.items).toHaveLength(0);
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: DB_STATUS_QUERY_KEY });
  });

  it("dismisses 'Connecting to Postgres' toast when connection is restored", async () => {
    expect(CONNECTION_TOAST_MESSAGE_PATTERN.test("Connecting to Postgres")).toBe(true);
    expect(CONNECTION_TOAST_MESSAGE_PATTERN.test("Connecting to database...")).toBe(true);
    const store = createStore();
    store.dispatch(setConnectionError(true));
    store.dispatch(
      addNotification({
        message: "Connecting to Postgres",
        severity: "error",
      })
    );
    expect(store.getState().notification.items).toHaveLength(1);

    store.dispatch({
      type: "execute/fetchTasks/fulfilled",
      meta: { requestStatus: "fulfilled", requestId: "req-db" },
      payload: {},
    });

    await waitFor(() => {
      expect(store.getState().connection.connectionError).toBe(false);
      expect(store.getState().notification.items).toHaveLength(0);
    });
  });

  it("dismisses connection toasts when dbStatusRestored is dispatched (health check returned ok)", async () => {
    const store = createStore();
    store.dispatch(setConnectionError(true));
    store.dispatch(
      addNotification({
        message: "Connecting to Postgres",
        severity: "error",
      })
    );
    expect(store.getState().notification.items).toHaveLength(1);

    store.dispatch(dbStatusRestored());

    await waitFor(() => {
      expect(store.getState().connection.connectionError).toBe(false);
      expect(store.getState().notification.items).toHaveLength(0);
    });
  });

  it("dismisses database connection error toast when connection is restored", async () => {
    const msg =
      "OpenSprint could not connect to the database; check that the server is running and your connection settings are correct.";
    expect(CONNECTION_TOAST_MESSAGE_PATTERN.test(msg)).toBe(true);
    const store = createStore();
    store.dispatch(setConnectionError(true));
    store.dispatch(
      addNotification({
        message: msg,
        severity: "error",
      })
    );
    expect(store.getState().notification.items).toHaveLength(1);

    store.dispatch(dbStatusRestored());

    await waitFor(() => {
      expect(store.getState().connection.connectionError).toBe(false);
      expect(store.getState().notification.items).toHaveLength(0);
    });
  });

  it("does not dismiss non-connection toasts when connection is restored", async () => {
    const store = createStore();
    store.dispatch(setConnectionError(true));
    store.dispatch(
      addNotification({
        message: "Failed to load plans. Refresh the page or try again.",
        severity: "error",
      })
    );
    expect(store.getState().notification.items).toHaveLength(1);

    store.dispatch({
      type: "plan/fetchPlans/fulfilled",
      meta: { requestStatus: "fulfilled", requestId: "req-other" },
      payload: {},
    });

    await waitFor(() => {
      expect(store.getState().connection.connectionError).toBe(false);
    });
    expect(store.getState().notification.items).toHaveLength(1);
  });

  it("does not re-show connection banner when connection error occurs within debounce after recovery", async () => {
    const store = createStore({
      connection: { connectionError: false, lastRecoveredAt: Date.now() - 500 },
    });
    mockIsConnectionError.mockReturnValue(true);

    store.dispatch({
      type: "plan/fetchPlans/rejected",
      meta: { requestStatus: "rejected", requestId: "req-flicker" },
      error: { message: "Failed to fetch" },
    });

    await waitFor(() => {
      expect(mockIsConnectionError).toHaveBeenCalled();
    });
    expect(store.getState().connection.connectionError).toBe(false);
  });

  it("does not add toast for DATABASE_UNAVAILABLE (banner handles it; deduplicate)", async () => {
    const store = createStore();
    mockIsConnectionError.mockReturnValue(false);

    store.dispatch({
      type: "execute/fetchTasks/rejected",
      meta: { requestStatus: "rejected", requestId: "req-db-unavail" },
      error: { message: "Rejected" },
      payload: {
        message: "Connecting to database...",
        code: "DATABASE_UNAVAILABLE",
      },
    });

    await waitFor(() => {
      expect(mockIsConnectionError).toHaveBeenCalled();
    });
    expect(store.getState().notification.items).toHaveLength(0);
  });

  it("does not add toast for connection-pattern messages (banner handles it; deduplicate)", async () => {
    const store = createStore();
    mockIsConnectionError.mockReturnValue(false);

    store.dispatch({
      type: "plan/fetchPlans/rejected",
      meta: { requestStatus: "rejected", requestId: "req-conn-msg" },
      error: { message: "Reconnecting to PostgreSQL..." },
    });

    await waitFor(() => {
      expect(mockIsConnectionError).toHaveBeenCalled();
    });
    expect(store.getState().notification.items).toHaveLength(0);
  });

  it("re-shows connection banner when connection error occurs after debounce window", async () => {
    const store = createStore({
      connection: { connectionError: false, lastRecoveredAt: Date.now() - 3000 },
    });
    mockIsConnectionError.mockReturnValue(true);

    store.dispatch({
      type: "plan/fetchPlans/rejected",
      meta: { requestStatus: "rejected", requestId: "req-after-debounce" },
      error: { message: "Failed to fetch" },
    });

    await waitFor(() => {
      expect(store.getState().connection.connectionError).toBe(true);
    });
  });

  it("shows server message for updateTaskAssignee/rejected when payload is ASSIGNEE_LOCKED", async () => {
    const store = createStore();
    mockIsConnectionError.mockReturnValue(false);

    store.dispatch({
      type: "execute/updateTaskAssignee/rejected",
      meta: { requestStatus: "rejected", requestId: "req-assignee" },
      error: { message: "Rejected" },
      payload: {
        message: "Cannot change assignee while task is in progress",
        code: "ASSIGNEE_LOCKED",
      },
    });

    await waitFor(() => {
      expect(store.getState().notification.items).toHaveLength(1);
      expect(store.getState().notification.items[0].message).toBe(
        "Cannot change assignee while task is in progress"
      );
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
