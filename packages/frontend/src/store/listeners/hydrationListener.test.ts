import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { configureStore } from "@reduxjs/toolkit";
import { hydrationListener } from "./hydrationListener";
import executeReducer, { fetchTasks, fetchMoreTasks, selectTasks } from "../slices/executeSlice";
import evalReducer, { fetchFeedback, fetchMoreFeedback } from "../slices/evalSlice";
import planReducer from "../slices/planSlice";
import websocketReducer from "../slices/websocketSlice";
import type { Task, FeedbackItem } from "@opensprint/shared";

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      tasks: { list: vi.fn(), get: vi.fn(), sessions: vi.fn(), markDone: vi.fn(), unblock: vi.fn(), updatePriority: vi.fn() },
      plans: { list: vi.fn() },
      execute: { status: vi.fn(), liveOutput: vi.fn() },
      agents: { active: vi.fn() },
      feedback: { list: vi.fn(), get: vi.fn(), submit: vi.fn(), recategorize: vi.fn(), resolve: vi.fn(), cancel: vi.fn() },
    },
  };
});

import { api } from "../../api/client";

const mockTask: Task = {
  id: "task-1",
  title: "Task 1",
  description: "",
  type: "task",
  status: "open",
  priority: 1,
  assignee: null,
  labels: [],
  dependencies: [],
  epicId: "epic-1",
  kanbanColumn: "backlog",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const mockFeedback: FeedbackItem = {
  id: "fb-1",
  text: "Feedback 1",
  category: "bug",
  mappedPlanId: null,
  createdTaskIds: [],
  status: "pending",
  createdAt: "2024-01-01T00:00:00Z",
};

function createStore() {
  return configureStore({
    reducer: {
      execute: executeReducer,
      eval: evalReducer,
      plan: planReducer,
      websocket: websocketReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().prepend(hydrationListener.middleware),
  });
}

describe("hydrationListener", () => {
  beforeEach(() => {
    vi.mocked(api.tasks.list).mockReset();
    vi.mocked(api.feedback.list).mockReset();
  });

  describe("tasks", () => {
    it("auto-dispatches fetchMoreTasks when fetchTasks fulfills with hasMoreTasks", async () => {
      const task2 = { ...mockTask, id: "task-2", title: "Task 2" };
      vi.mocked(api.tasks.list)
        .mockResolvedValueOnce({ items: [mockTask], total: 2 } as never)
        .mockResolvedValueOnce({ items: [task2], total: 2 } as never);
      const store = createStore();
      await store.dispatch(fetchTasks({ projectId: "proj-1", limit: 100, offset: 0 }));
      await waitFor(() => expect(selectTasks(store.getState())).toHaveLength(2));
      expect(api.tasks.list).toHaveBeenCalledTimes(2);
      expect(api.tasks.list).toHaveBeenNthCalledWith(1, "proj-1", { limit: 100, offset: 0 });
      expect(api.tasks.list).toHaveBeenNthCalledWith(2, "proj-1", { limit: 100, offset: 1 });
    });

    it("does not dispatch fetchMoreTasks when hasMoreTasks is false", async () => {
      vi.mocked(api.tasks.list).mockResolvedValue({ items: [mockTask], total: 1 } as never);
      const store = createStore();
      await store.dispatch(fetchTasks({ projectId: "proj-1", limit: 100, offset: 0 }));
      expect(api.tasks.list).toHaveBeenCalledTimes(1);
    });

    it("chains fetchMoreTasks until all loaded", async () => {
      const batches = [
        Array.from({ length: 100 }, (_, i) => ({ ...mockTask, id: `task-${i}`, title: `Task ${i}` })),
        Array.from({ length: 50 }, (_, i) => ({ ...mockTask, id: `task-${100 + i}`, title: `Task ${100 + i}` })),
      ];
      vi.mocked(api.tasks.list)
        .mockResolvedValueOnce({ items: batches[0], total: 150 } as never)
        .mockResolvedValueOnce({ items: batches[1], total: 150 } as never);
      const store = createStore();
      await store.dispatch(fetchTasks({ projectId: "proj-1", limit: 100, offset: 0 }));
      await waitFor(() => expect(selectTasks(store.getState())).toHaveLength(150));
      const state = store.getState().execute;
      expect(state.hasMoreTasks).toBe(false);
      expect(api.tasks.list).toHaveBeenCalledTimes(2);
    });
  });

  describe("feedback", () => {
    it("auto-dispatches fetchMoreFeedback when fetchFeedback fulfills with hasMoreFeedback", async () => {
      const fb2 = { ...mockFeedback, id: "fb-2", text: "Feedback 2" };
      vi.mocked(api.feedback.list)
        .mockResolvedValueOnce({ items: [mockFeedback], total: 2 } as never)
        .mockResolvedValueOnce({ items: [fb2], total: 2 } as never);
      const store = createStore();
      await store.dispatch(fetchFeedback({ projectId: "proj-1", limit: 100, offset: 0 }));
      await waitFor(() => expect(store.getState().eval.feedback).toHaveLength(2));
      expect(api.feedback.list).toHaveBeenCalledTimes(2);
      expect(api.feedback.list).toHaveBeenNthCalledWith(1, "proj-1", { limit: 100, offset: 0 });
      expect(api.feedback.list).toHaveBeenNthCalledWith(2, "proj-1", { limit: 100, offset: 1 });
    });

    it("does not dispatch fetchMoreFeedback when hasMoreFeedback is false", async () => {
      vi.mocked(api.feedback.list).mockResolvedValue({ items: [mockFeedback], total: 1 } as never);
      const store = createStore();
      await store.dispatch(fetchFeedback({ projectId: "proj-1", limit: 100, offset: 0 }));
      expect(api.feedback.list).toHaveBeenCalledTimes(1);
    });
  });
});
