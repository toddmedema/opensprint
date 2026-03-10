import { describe, it, expect, beforeEach, vi } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import openQuestionsReducer, {
  addNotification,
  clearAllByProject,
  clearAllGlobal,
  removeNotification,
} from "../slices/openQuestionsSlice";
import { trayRefreshListener } from "./trayRefreshListener";

const mockRefreshTray = vi.fn();
const mockClearAllByProject = vi.fn();
const mockClearAllGlobal = vi.fn();

vi.mock("../../api/client", () => ({
  api: {
    notifications: {
      clearAllByProject: (...args: unknown[]) => mockClearAllByProject(...args),
      clearAllGlobal: (...args: unknown[]) => mockClearAllGlobal(...args),
    },
  },
}));
const originalWindow = globalThis.window;

function mockElectron() {
  (globalThis as unknown as { window: { electron?: { refreshTray: () => Promise<void> } } }).window = {
    ...originalWindow,
    electron: { refreshTray: mockRefreshTray, isElectron: true as const },
  };
}

function unmockElectron() {
  (globalThis as unknown as { window: Window }).window = originalWindow;
}

function createStore() {
  return configureStore({
    reducer: { openQuestions: openQuestionsReducer },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().prepend(trayRefreshListener.middleware),
  });
}

const sampleNotification = {
  id: "oq-1",
  projectId: "proj-1",
  source: "plan" as const,
  sourceId: "plan-1",
  questions: [{ id: "q1", text: "What is the scope?", createdAt: "2025-01-01T00:00:00Z" }],
  status: "open" as const,
  createdAt: "2025-01-01T00:00:00Z",
  resolvedAt: null,
};

describe("trayRefreshListener", () => {
  beforeEach(() => {
    mockRefreshTray.mockReset();
    mockClearAllByProject.mockResolvedValue({ deletedCount: 1 });
    mockClearAllGlobal.mockResolvedValue({ deletedCount: 1 });
    mockElectron();
  });

  it("calls refreshTray when clearAllByProject is fulfilled", async () => {
    const store = createStore();
    await store.dispatch(clearAllByProject("proj-1"));
    expect(mockRefreshTray).toHaveBeenCalledTimes(1);
    unmockElectron();
  });

  it("calls refreshTray when clearAllGlobal is fulfilled", async () => {
    const store = createStore();
    await store.dispatch(clearAllGlobal());
    expect(mockRefreshTray).toHaveBeenCalledTimes(1);
    unmockElectron();
  });

  it("calls refreshTray when last notification is removed via removeNotification", () => {
    const store = createStore();
    store.dispatch(addNotification(sampleNotification));
    store.dispatch(removeNotification({ projectId: "proj-1", notificationId: "oq-1" }));
    expect(mockRefreshTray).toHaveBeenCalledTimes(1);
    unmockElectron();
  });

  it("does not call refreshTray when removeNotification leaves notifications", () => {
    const store = createStore();
    const second = { ...sampleNotification, id: "oq-2" };
    store.dispatch(addNotification(sampleNotification));
    store.dispatch(addNotification(second));
    store.dispatch(removeNotification({ projectId: "proj-1", notificationId: "oq-1" }));
    expect(mockRefreshTray).not.toHaveBeenCalled();
    unmockElectron();
  });
});
