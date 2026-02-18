import { describe, it, expect, vi, beforeEach } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import evalReducer, {
  setFeedback,
  setEvalError,
  resetEval,
  fetchFeedback,
  submitFeedback,
  recategorizeFeedback,
  resolveFeedback,
  type EvalState,
} from "./evalSlice";
import type { FeedbackItem } from "@opensprint/shared";

vi.mock("../../api/client", () => ({
  api: {
    feedback: {
      list: vi.fn(),
      submit: vi.fn(),
      recategorize: vi.fn(),
      resolve: vi.fn(),
    },
  },
}));

import { api } from "../../api/client";

const mockFeedback: FeedbackItem = {
  id: "fb-1",
  text: "Great feature",
  category: "feature",
  mappedPlanId: null,
  createdTaskIds: [],
  status: "pending",
  images: [],
  createdAt: "2025-01-01T00:00:00Z",
};

describe("evalSlice", () => {
  beforeEach(() => {
    vi.mocked(api.feedback.list).mockReset();
    vi.mocked(api.feedback.submit).mockReset();
    vi.mocked(api.feedback.recategorize).mockReset();
    vi.mocked(api.feedback.resolve).mockReset();
  });

  function createStore() {
    return configureStore({ reducer: { eval: evalReducer } });
  }

  describe("initial state", () => {
    it("has correct initial state", () => {
      const store = createStore();
      const state = store.getState().eval as EvalState;
      expect(state.feedback).toEqual([]);
      expect(state.loading).toBe(false);
      expect(state.submitting).toBe(false);
      expect(state.error).toBeNull();
    });
  });

  describe("reducers", () => {
    it("setFeedback sets feedback array", () => {
      const store = createStore();
      const feedback = [mockFeedback];
      store.dispatch(setFeedback(feedback));
      expect(store.getState().eval.feedback).toEqual(feedback);
    });

    it("setEvalError sets error", () => {
      const store = createStore();
      store.dispatch(setEvalError("Something went wrong"));
      expect(store.getState().eval.error).toBe("Something went wrong");
      store.dispatch(setEvalError(null));
      expect(store.getState().eval.error).toBeNull();
    });

    it("resetEval resets to initial state", () => {
      const store = createStore();
      store.dispatch(setFeedback([mockFeedback]));
      store.dispatch(setEvalError("error"));

      store.dispatch(resetEval());
      const state = store.getState().eval as EvalState;
      expect(state.feedback).toEqual([]);
      expect(state.loading).toBe(false);
      expect(state.submitting).toBe(false);
      expect(state.error).toBeNull();
    });
  });

  describe("fetchFeedback thunk", () => {
    it("sets loading true on pending", async () => {
      let resolveApi: (v: FeedbackItem[]) => void;
      const apiPromise = new Promise<FeedbackItem[]>((r) => {
        resolveApi = r;
      });
      vi.mocked(api.feedback.list).mockReturnValue(apiPromise as never);
      const store = createStore();
      const dispatchPromise = store.dispatch(fetchFeedback("proj-1"));

      expect(store.getState().eval.loading).toBe(true);
      expect(store.getState().eval.error).toBeNull();

      resolveApi!([mockFeedback]);
      await dispatchPromise;
    });

    it("stores feedback on fulfilled", async () => {
      vi.mocked(api.feedback.list).mockResolvedValue([mockFeedback] as never);
      const store = createStore();
      await store.dispatch(fetchFeedback("proj-1"));

      expect(store.getState().eval.feedback).toEqual([mockFeedback]);
      expect(store.getState().eval.loading).toBe(false);
      expect(api.feedback.list).toHaveBeenCalledWith("proj-1");
    });

    it("sets error on rejected", async () => {
      vi.mocked(api.feedback.list).mockRejectedValue(new Error("Network error"));
      const store = createStore();
      await store.dispatch(fetchFeedback("proj-1"));

      expect(store.getState().eval.loading).toBe(false);
      expect(store.getState().eval.error).toBe("Network error");
    });

    it("uses fallback error message when error has no message", async () => {
      vi.mocked(api.feedback.list).mockRejectedValue(new Error());
      const store = createStore();
      await store.dispatch(fetchFeedback("proj-1"));

      expect(store.getState().eval.error).toBe("Failed to load feedback");
    });
  });

  describe("submitFeedback thunk", () => {
    it("sets submitting true on pending", async () => {
      let resolveApi: (v: FeedbackItem) => void;
      const apiPromise = new Promise<FeedbackItem>((r) => {
        resolveApi = r;
      });
      vi.mocked(api.feedback.submit).mockReturnValue(apiPromise as never);
      const store = createStore();
      const dispatchPromise = store.dispatch(
        submitFeedback({ projectId: "proj-1", text: "Great work!" }),
      );

      expect(store.getState().eval.submitting).toBe(true);
      expect(store.getState().eval.error).toBeNull();

      resolveApi!(mockFeedback);
      await dispatchPromise;
    });

    it("shows feedback immediately (optimistically) before API returns", async () => {
      let resolveApi: (v: FeedbackItem) => void;
      const apiPromise = new Promise<FeedbackItem>((r) => {
        resolveApi = r;
      });
      vi.mocked(api.feedback.submit).mockReturnValue(apiPromise as never);
      const store = createStore();
      const dispatchPromise = store.dispatch(
        submitFeedback({ projectId: "proj-1", text: "Bug in login" }),
      );

      const stateBeforeResolve = store.getState().eval;
      expect(stateBeforeResolve.feedback).toHaveLength(1);
      expect(stateBeforeResolve.feedback[0].text).toBe("Bug in login");
      expect(stateBeforeResolve.feedback[0].status).toBe("pending");
      expect(stateBeforeResolve.feedback[0].id).toMatch(/^temp-/);

      resolveApi!(mockFeedback);
      await dispatchPromise;

      const stateAfterResolve = store.getState().eval;
      expect(stateAfterResolve.feedback[0].id).toBe("fb-1");
      expect(stateAfterResolve.feedback[0].text).toBe("Great feature");
    });

    it("prepends new feedback and clears submitting on fulfilled", async () => {
      const existingFeedback: FeedbackItem = {
        ...mockFeedback,
        id: "fb-2",
        text: "Older feedback",
      };
      const newFeedback: FeedbackItem = {
        ...mockFeedback,
        id: "fb-3",
        text: "New feedback",
      };
      vi.mocked(api.feedback.submit).mockResolvedValue(newFeedback as never);
      const store = createStore();
      store.dispatch(setFeedback([existingFeedback]));
      await store.dispatch(
        submitFeedback({ projectId: "proj-1", text: "New feedback" }),
      );

      const state = store.getState().eval;
      expect(state.submitting).toBe(false);
      expect(state.feedback).toHaveLength(2);
      expect(state.feedback[0]).toEqual(newFeedback);
      expect(state.feedback[1]).toEqual(existingFeedback);
      expect(api.feedback.submit).toHaveBeenCalledWith("proj-1", "New feedback", undefined, undefined);
    });

    it("passes parentId to API and includes parent_id and depth in optimistic payload", async () => {
      const parentFeedback: FeedbackItem = {
        ...mockFeedback,
        id: "fb-parent",
        text: "Original",
        parent_id: null,
        depth: 0,
      };
      const replyFeedback: FeedbackItem = {
        ...mockFeedback,
        id: "fb-reply",
        text: "Reply text",
        parent_id: "fb-parent",
        depth: 1,
      };
      vi.mocked(api.feedback.submit).mockResolvedValue(replyFeedback as never);
      const store = createStore();
      store.dispatch(setFeedback([parentFeedback]));

      const dispatchPromise = store.dispatch(
        submitFeedback({ projectId: "proj-1", text: "Reply text", parentId: "fb-parent" }),
      );

      const stateBeforeResolve = store.getState().eval;
      const optimistic = stateBeforeResolve.feedback.find((f) => f.text === "Reply text");
      expect(optimistic).toBeDefined();
      expect(optimistic!.parent_id).toBe("fb-parent");
      expect(optimistic!.depth).toBe(1);

      await dispatchPromise;
      expect(api.feedback.submit).toHaveBeenCalledWith("proj-1", "Reply text", undefined, "fb-parent");
    });

    it("sets error on rejected", async () => {
      vi.mocked(api.feedback.submit).mockRejectedValue(new Error("Submit failed"));
      const store = createStore();
      await store.dispatch(
        submitFeedback({ projectId: "proj-1", text: "Feedback" }),
      );

      expect(store.getState().eval.submitting).toBe(false);
      expect(store.getState().eval.error).toBe("Submit failed");
    });

    it("removes optimistic feedback when submit is rejected", async () => {
      vi.mocked(api.feedback.submit).mockRejectedValue(new Error("Submit failed"));
      const store = createStore();
      const dispatchPromise = store.dispatch(
        submitFeedback({ projectId: "proj-1", text: "Failed feedback" }),
      );

      expect(store.getState().eval.feedback).toHaveLength(1);
      expect(store.getState().eval.feedback[0].text).toBe("Failed feedback");

      await dispatchPromise;

      expect(store.getState().eval.feedback).toHaveLength(0);
    });

    it("uses fallback error message when error has no message", async () => {
      vi.mocked(api.feedback.submit).mockRejectedValue(new Error());
      const store = createStore();
      await store.dispatch(
        submitFeedback({ projectId: "proj-1", text: "Feedback" }),
      );

      expect(store.getState().eval.error).toBe("Failed to submit feedback");
    });
  });

  describe("recategorizeFeedback thunk", () => {
    it("updates feedback item in array on fulfilled", async () => {
      const updatedFeedback: FeedbackItem = {
        ...mockFeedback,
        category: "bug" as const,
      };
      vi.mocked(api.feedback.recategorize).mockResolvedValue(updatedFeedback as never);
      const store = createStore();
      store.dispatch(setFeedback([mockFeedback]));
      await store.dispatch(
        recategorizeFeedback({ projectId: "proj-1", feedbackId: "fb-1" }),
      );

      expect(store.getState().eval.feedback[0].category).toBe("bug");
      expect(api.feedback.recategorize).toHaveBeenCalledWith("proj-1", "fb-1");
    });

    it("does not add item when not found in array", async () => {
      const otherFeedback: FeedbackItem = {
        ...mockFeedback,
        id: "fb-other",
        category: "bug" as const,
      };
      vi.mocked(api.feedback.recategorize).mockResolvedValue(otherFeedback as never);
      const store = createStore();
      store.dispatch(setFeedback([mockFeedback]));
      await store.dispatch(
        recategorizeFeedback({ projectId: "proj-1", feedbackId: "fb-other" }),
      );

      expect(store.getState().eval.feedback).toHaveLength(1);
      expect(store.getState().eval.feedback[0].id).toBe("fb-1");
    });

    it("sets error on rejected", async () => {
      vi.mocked(api.feedback.recategorize).mockRejectedValue(new Error("Recategorize failed"));
      const store = createStore();
      store.dispatch(setFeedback([mockFeedback]));
      await store.dispatch(
        recategorizeFeedback({ projectId: "proj-1", feedbackId: "fb-1" }),
      );

      expect(store.getState().eval.error).toBe("Recategorize failed");
    });
  });

  describe("resolveFeedback thunk", () => {
    it("updates feedback item status to resolved optimistically on pending", async () => {
      let resolveApi: (v: FeedbackItem) => void;
      const apiPromise = new Promise<FeedbackItem>((r) => {
        resolveApi = r;
      });
      vi.mocked(api.feedback.resolve).mockReturnValue(apiPromise as never);
      const store = createStore();
      store.dispatch(setFeedback([{ ...mockFeedback, id: "fb-1", status: "mapped" }]));
      const dispatchPromise = store.dispatch(
        resolveFeedback({ projectId: "proj-1", feedbackId: "fb-1" }),
      );

      expect(store.getState().eval.feedback[0].status).toBe("resolved");
      resolveApi!({ ...mockFeedback, id: "fb-1", status: "resolved" });
      await dispatchPromise;
      expect(store.getState().eval.feedback[0].status).toBe("resolved");
    });

    it("updates feedback item status to resolved on fulfilled", async () => {
      const resolvedFeedback: FeedbackItem = {
        ...mockFeedback,
        status: "resolved" as const,
      };
      vi.mocked(api.feedback.resolve).mockResolvedValue(resolvedFeedback as never);
      const store = createStore();
      store.dispatch(setFeedback([{ ...mockFeedback, status: "mapped" }]));
      await store.dispatch(
        resolveFeedback({ projectId: "proj-1", feedbackId: "fb-1" }),
      );

      expect(store.getState().eval.feedback[0].status).toBe("resolved");
      expect(api.feedback.resolve).toHaveBeenCalledWith("proj-1", "fb-1");
    });

    it("sets error and reverts status to mapped on rejected", async () => {
      vi.mocked(api.feedback.resolve).mockRejectedValue(new Error("Resolve failed"));
      const store = createStore();
      store.dispatch(setFeedback([{ ...mockFeedback, status: "mapped" }]));
      await store.dispatch(
        resolveFeedback({ projectId: "proj-1", feedbackId: "fb-1" }),
      );

      expect(store.getState().eval.error).toBe("Resolve failed");
      expect(store.getState().eval.feedback[0].status).toBe("mapped");
    });
  });
});
