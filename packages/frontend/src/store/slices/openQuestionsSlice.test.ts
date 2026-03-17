import { describe, it, expect, vi, beforeEach } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import openQuestionsReducer, {
  addNotification,
  removeNotification,
  updateNotification,
  fetchProjectNotifications,
  fetchGlobalNotifications,
  clearAllByProject,
  clearAllGlobal,
} from "./openQuestionsSlice";

const mockListByProject = vi.fn();
const mockListGlobal = vi.fn();
const mockClearAllByProject = vi.fn();
const mockClearAllGlobal = vi.fn();
vi.mock("../../api/client", () => ({
  api: {
    notifications: {
      listByProject: (...args: unknown[]) => mockListByProject(...args),
      listGlobal: (...args: unknown[]) => mockListGlobal(...args),
      clearAllByProject: (...args: unknown[]) => mockClearAllByProject(...args),
      clearAllGlobal: (...args: unknown[]) => mockClearAllGlobal(...args),
    },
  },
}));

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

beforeEach(() => {
  mockListByProject.mockResolvedValue([]);
  mockListGlobal.mockResolvedValue([]);
  mockClearAllByProject.mockResolvedValue({ deletedCount: 1 });
  mockClearAllGlobal.mockResolvedValue({ deletedCount: 1 });
});

describe("openQuestionsSlice", () => {
  it("has initial state", () => {
    const store = configureStore({ reducer: { openQuestions: openQuestionsReducer } });
    const state = store.getState().openQuestions;
    expect(state.byProject).toEqual({});
    expect(state.global).toEqual([]);
  });

  it("addNotification adds to byProject and global", () => {
    const store = configureStore({ reducer: { openQuestions: openQuestionsReducer } });
    store.dispatch(addNotification(sampleNotification));
    const state = store.getState().openQuestions;
    expect(state.byProject["proj-1"]).toHaveLength(1);
    expect(state.byProject["proj-1"][0].id).toBe("oq-1");
    expect(state.global).toHaveLength(1);
    expect(state.global[0].id).toBe("oq-1");
  });

  it("addNotification does not duplicate when same id already exists", () => {
    const store = configureStore({ reducer: { openQuestions: openQuestionsReducer } });
    store.dispatch(addNotification(sampleNotification));
    store.dispatch(addNotification(sampleNotification));
    const state = store.getState().openQuestions;
    expect(state.byProject["proj-1"]).toHaveLength(1);
    expect(state.global).toHaveLength(1);
  });

  it("removeNotification removes from byProject and global", () => {
    const store = configureStore({ reducer: { openQuestions: openQuestionsReducer } });
    store.dispatch(addNotification(sampleNotification));
    store.dispatch(removeNotification({ projectId: "proj-1", notificationId: "oq-1" }));
    const state = store.getState().openQuestions;
    expect(state.byProject["proj-1"]).toHaveLength(0);
    expect(state.global).toHaveLength(0);
  });

  it("updateNotification updates existing notification (e.g. after resolve with responses)", () => {
    const store = configureStore({ reducer: { openQuestions: openQuestionsReducer } });
    store.dispatch(addNotification(sampleNotification));
    const resolved = {
      ...sampleNotification,
      status: "resolved" as const,
      resolvedAt: "2025-01-01T00:02:00Z",
      responses: [{ questionId: "q1", answer: "Web and mobile" }],
    };
    store.dispatch(updateNotification(resolved));
    const state = store.getState().openQuestions;
    expect(state.byProject["proj-1"]).toHaveLength(1);
    expect(state.byProject["proj-1"][0].status).toBe("resolved");
    expect(state.byProject["proj-1"][0].responses).toEqual([
      { questionId: "q1", answer: "Web and mobile" },
    ]);
    expect(state.global[0].status).toBe("resolved");
  });

  it("fetchProjectNotifications keeps resolved notifications in state when refetching", async () => {
    const resolved = {
      ...sampleNotification,
      id: "oq-resolved",
      status: "resolved" as const,
      resolvedAt: "2025-01-01T00:02:00Z",
      responses: [{ questionId: "q1", answer: "Done" }],
    };
    const store = configureStore({ reducer: { openQuestions: openQuestionsReducer } });
    store.dispatch(addNotification(resolved));
    mockListByProject.mockResolvedValue([{ ...sampleNotification, id: "oq-2" }]);
    await store.dispatch(fetchProjectNotifications("proj-1"));
    const state = store.getState().openQuestions;
    expect(state.byProject["proj-1"].map((n) => n.id)).toContain("oq-resolved");
    expect(state.byProject["proj-1"].map((n) => n.id)).toContain("oq-2");
    expect(state.byProject["proj-1"]).toHaveLength(2);
  });

  it("fetchProjectNotifications populates byProject", async () => {
    mockListByProject.mockResolvedValue([sampleNotification]);
    const store = configureStore({ reducer: { openQuestions: openQuestionsReducer } });
    await store.dispatch(fetchProjectNotifications("proj-1"));
    const state = store.getState().openQuestions;
    expect(state.byProject["proj-1"]).toHaveLength(1);
    expect(state.byProject["proj-1"][0].id).toBe("oq-1");
  });

  it("fetchGlobalNotifications populates global", async () => {
    mockListGlobal.mockResolvedValue([sampleNotification]);
    const store = configureStore({ reducer: { openQuestions: openQuestionsReducer } });
    await store.dispatch(fetchGlobalNotifications());
    const state = store.getState().openQuestions;
    expect(state.global).toHaveLength(1);
    expect(state.global[0].id).toBe("oq-1");
  });

  it("clearAllByProject clears project notifications from state", async () => {
    const store = configureStore({ reducer: { openQuestions: openQuestionsReducer } });
    store.dispatch(addNotification(sampleNotification));
    mockClearAllByProject.mockResolvedValue({ deletedCount: 1 });

    await store.dispatch(clearAllByProject("proj-1"));

    const state = store.getState().openQuestions;
    expect(state.byProject["proj-1"]).toHaveLength(0);
    expect(state.global).toHaveLength(0);
  });

  it("clearAllGlobal clears all notifications from state", async () => {
    const store = configureStore({ reducer: { openQuestions: openQuestionsReducer } });
    store.dispatch(addNotification(sampleNotification));
    mockClearAllGlobal.mockResolvedValue({ deletedCount: 1 });

    await store.dispatch(clearAllGlobal());

    const state = store.getState().openQuestions;
    expect(state.byProject).toEqual({});
    expect(state.global).toHaveLength(0);
  });
});
