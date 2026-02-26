import { describe, it, expect, vi } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import evalReducer, {
  updateFeedbackItem,
  updateFeedbackItemResolved,
  fetchFeedbackItem,
  cancelFeedback,
  type EvalState,
} from "./evalSlice";
import type { FeedbackItem } from "@opensprint/shared";

vi.mock("../../api/client", () => ({
  api: {
    feedback: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      submit: vi.fn(),
      recategorize: vi.fn(),
      resolve: vi.fn(),
      cancel: vi.fn(),
    },
  },
}));

function createStore(initialState?: Partial<EvalState>) {
  return configureStore({
    reducer: { eval: evalReducer },
    preloadedState: initialState ? { eval: initialState } : undefined,
  });
}

const baseItem: FeedbackItem = {
  id: "fb-1",
  text: "Original text",
  category: "bug",
  mappedPlanId: null,
  createdTaskIds: [],
  status: "pending",
  createdAt: "2024-01-01T00:00:00Z",
};

describe("evalSlice", () => {
  describe("updateFeedbackItem", () => {
    it("updates an existing feedback item in place by id", () => {
      const store = createStore({
        feedback: [baseItem, { ...baseItem, id: "fb-2", text: "Second" }],
        loading: false,
        submitting: false,
        error: null,
      });

      const updated: FeedbackItem = {
        ...baseItem,
        status: "pending",
        category: "feature",
        mappedPlanId: "plan-1",
        createdTaskIds: ["task-1"],
      };

      store.dispatch(updateFeedbackItem(updated));

      const state = store.getState().eval;
      expect(state.feedback).toHaveLength(2);
      expect(state.feedback[0]).toEqual(updated);
      expect(state.feedback[1]).toEqual({ ...baseItem, id: "fb-2", text: "Second" });
    });

    it("prepends item when not in list (e.g. WebSocket event before list load)", () => {
      const store = createStore({
        feedback: [baseItem],
        loading: false,
        submitting: false,
        error: null,
      });

      const otherItem: FeedbackItem = {
        ...baseItem,
        id: "fb-other",
        text: "From another tab",
        status: "resolved",
      };

      store.dispatch(updateFeedbackItem(otherItem));

      const state = store.getState().eval;
      expect(state.feedback).toHaveLength(2);
      expect(state.feedback[0]).toEqual(otherItem);
      expect(state.feedback[1]).toEqual(baseItem);
    });

    it("preserves list order and other items when updating one", () => {
      const store = createStore({
        feedback: [
          { ...baseItem, id: "fb-a" },
          { ...baseItem, id: "fb-b", text: "B" },
          { ...baseItem, id: "fb-c", text: "C" },
        ],
        loading: false,
        submitting: false,
        error: null,
      });

      store.dispatch(
        updateFeedbackItem({
          ...baseItem,
          id: "fb-b",
          text: "B updated",
          status: "resolved",
        })
      );

      const state = store.getState().eval;
      expect(state.feedback[0].id).toBe("fb-a");
      expect(state.feedback[1].id).toBe("fb-b");
      expect(state.feedback[1].text).toBe("B updated");
      expect(state.feedback[1].status).toBe("resolved");
      expect(state.feedback[2].id).toBe("fb-c");
    });

    it("updates feedbackItemCache when item is in cache", () => {
      const store = createStore({
        feedback: [baseItem],
        feedbackItemCache: { "fb-1": baseItem },
      });

      const updated: FeedbackItem = {
        ...baseItem,
        createdTaskIds: ["task-1"],
        category: "feature",
      };
      store.dispatch(updateFeedbackItem(updated));

      const state = store.getState().eval;
      expect(state.feedbackItemCache["fb-1"]).toEqual(updated);
    });
  });

  describe("updateFeedbackItemResolved", () => {
    it("sets status to resolved for existing feedback item by id", () => {
      const store = createStore({
        feedback: [{ ...baseItem, id: "fb-x", status: "pending" }],
      });

      store.dispatch(updateFeedbackItemResolved("fb-x"));

      const state = store.getState().eval;
      expect(state.feedback[0].status).toBe("resolved");
      expect(state.feedback[0].id).toBe("fb-x");
    });

    it("leaves list unchanged when feedback id is not in the list", () => {
      const store = createStore({
        feedback: [{ ...baseItem, id: "fb-x", status: "pending" }],
      });

      store.dispatch(updateFeedbackItemResolved("fb-missing"));

      const state = store.getState().eval;
      expect(state.feedback[0].status).toBe("pending");
    });
  });

  describe("fetchFeedbackItem", () => {
    it("stores feedback item in cache on fulfilled", async () => {
      const item: FeedbackItem = {
        ...baseItem,
        id: "fb-single",
        text: "Single feedback",
        status: "pending",
      };
      const { api } = await import("../../api/client");
      vi.mocked(api.feedback.get).mockResolvedValue(item);
      const store = createStore();
      await store.dispatch(fetchFeedbackItem({ projectId: "proj-1", feedbackId: "fb-single" }));
      const state = store.getState().eval;
      expect(state.feedbackItemCache["fb-single"]).toEqual(item);
      expect(state.feedbackItemLoadingId).toBeNull();
      expect(state.async.feedbackItem.error).toBeNull();
    });

    it("sets error on rejected", async () => {
      const { api } = await import("../../api/client");
      vi.mocked(api.feedback.get).mockRejectedValue(new Error("Not found"));
      const store = createStore();
      await store.dispatch(fetchFeedbackItem({ projectId: "proj-1", feedbackId: "fb-missing" }));
      const state = store.getState().eval;
      expect(state.feedbackItemLoadingId).toBeNull();
      expect(state.async.feedbackItem.error).toBe("Not found");
      expect(state.feedbackItemErrorId).toBe("fb-missing");
    });
  });

  describe("cancelFeedback", () => {
    it("sets status to cancelled on fulfilled", async () => {
      const cancelledItem: FeedbackItem = {
        ...baseItem,
        id: "fb-x",
        status: "cancelled",
      };
      const { api } = await import("../../api/client");
      vi.mocked(api.feedback.cancel).mockResolvedValue(cancelledItem);
      const store = createStore({
        feedback: [{ ...baseItem, id: "fb-x", status: "pending" }],
      });
      await store.dispatch(cancelFeedback({ projectId: "proj-1", feedbackId: "fb-x" }));
      const state = store.getState().eval;
      expect(state.feedback[0].status).toBe("cancelled");
    });

    it("reverts to pending on rejected", async () => {
      const { api } = await import("../../api/client");
      vi.mocked(api.feedback.cancel).mockRejectedValue(new Error("Cancel failed"));
      const store = createStore({
        feedback: [{ ...baseItem, id: "fb-x", status: "pending" }],
      });
      await store.dispatch(cancelFeedback({ projectId: "proj-1", feedbackId: "fb-x" }));
      const state = store.getState().eval;
      expect(state.feedback[0].status).toBe("pending");
      expect(state.error).toBe("Cancel failed");
    });
  });
});
