import { describe, it, expect, vi, beforeEach } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import validateReducer, {
  fetchFeedback,
  submitFeedback,
  resetValidate,
  setFeedback,
  setValidateError,
  type ValidateState,
} from "./validateSlice";
import type { FeedbackItem } from "@opensprint/shared";

const mockFeedbackItem: FeedbackItem = {
  id: "fb-1",
  text: "Test feedback",
  category: "bug",
  mappedPlanId: null,
  createdTaskIds: [],
  status: "pending",
  createdAt: "2025-01-01T00:00:00Z",
};

vi.mock("../../api/client", () => ({
  api: {
    feedback: {
      list: vi.fn(),
      submit: vi.fn(),
    },
  },
}));

import { api } from "../../api/client";

describe("validateSlice", () => {
  beforeEach(() => {
    vi.mocked(api.feedback.list).mockReset();
    vi.mocked(api.feedback.submit).mockReset();
  });

  describe("initial state", () => {
    it("has correct initial state", () => {
      const store = configureStore({ reducer: { validate: validateReducer } });
      const state = store.getState().validate as ValidateState;
      expect(state.feedback).toEqual([]);
      expect(state.loading).toBe(false);
      expect(state.submitting).toBe(false);
      expect(state.error).toBeNull();
    });
  });

  describe("reducers", () => {
    it("setFeedback updates feedback array", () => {
      const store = configureStore({ reducer: { validate: validateReducer } });
      store.dispatch(setFeedback([mockFeedbackItem]));

      const state = store.getState().validate as ValidateState;
      expect(state.feedback).toEqual([mockFeedbackItem]);
    });

    it("setValidateError updates error", () => {
      const store = configureStore({ reducer: { validate: validateReducer } });
      store.dispatch(setValidateError("Something went wrong"));

      const state = store.getState().validate as ValidateState;
      expect(state.error).toBe("Something went wrong");
    });

    it("resetValidate restores initial state", () => {
      const store = configureStore({ reducer: { validate: validateReducer } });
      store.dispatch(setFeedback([mockFeedbackItem]));
      store.dispatch(setValidateError("Error"));

      store.dispatch(resetValidate());

      const state = store.getState().validate as ValidateState;
      expect(state.feedback).toEqual([]);
      expect(state.loading).toBe(false);
      expect(state.submitting).toBe(false);
      expect(state.error).toBeNull();
    });
  });

  describe("fetchFeedback thunk", () => {
    it("sets loading true and clears error on pending", async () => {
      let resolveApi: (v: FeedbackItem[]) => void;
      const apiPromise = new Promise<FeedbackItem[]>((r) => {
        resolveApi = r;
      });
      vi.mocked(api.feedback.list).mockReturnValue(apiPromise as never);
      const store = configureStore({ reducer: { validate: validateReducer } });
      const dispatchPromise = store.dispatch(fetchFeedback("proj-1"));

      const state = store.getState().validate as ValidateState;
      expect(state.loading).toBe(true);
      expect(state.error).toBeNull();
      expect(state.feedback).toEqual([]);

      resolveApi!([mockFeedbackItem]);
      await dispatchPromise;
    });

    it("stores feedback and clears loading on fulfilled", async () => {
      vi.mocked(api.feedback.list).mockResolvedValue([mockFeedbackItem]);
      const store = configureStore({ reducer: { validate: validateReducer } });
      await store.dispatch(fetchFeedback("proj-1"));

      const state = store.getState().validate as ValidateState;
      expect(state.feedback).toEqual([mockFeedbackItem]);
      expect(state.loading).toBe(false);
      expect(state.error).toBeNull();
    });

    it("calls api.feedback.list with projectId", async () => {
      vi.mocked(api.feedback.list).mockResolvedValue([]);
      const store = configureStore({ reducer: { validate: validateReducer } });
      await store.dispatch(fetchFeedback("proj-abc-123"));

      expect(api.feedback.list).toHaveBeenCalledWith("proj-abc-123");
    });

    it("sets error and clears loading on rejected", async () => {
      vi.mocked(api.feedback.list).mockRejectedValue(new Error("Network error"));
      const store = configureStore({ reducer: { validate: validateReducer } });
      await store.dispatch(fetchFeedback("proj-1"));

      const state = store.getState().validate as ValidateState;
      expect(state.loading).toBe(false);
      expect(state.error).toBe("Network error");
      expect(state.feedback).toEqual([]);
    });

    it("uses fallback error message when error has no message", async () => {
      vi.mocked(api.feedback.list).mockRejectedValue(new Error());
      const store = configureStore({ reducer: { validate: validateReducer } });
      await store.dispatch(fetchFeedback("proj-1"));

      const state = store.getState().validate as ValidateState;
      expect(state.error).toBe("Failed to load feedback");
    });
  });

  describe("submitFeedback thunk", () => {
    it("sets submitting true on pending", async () => {
      let resolveApi: (v: FeedbackItem) => void;
      const apiPromise = new Promise<FeedbackItem>((r) => {
        resolveApi = r;
      });
      vi.mocked(api.feedback.submit).mockReturnValue(apiPromise as never);
      const store = configureStore({ reducer: { validate: validateReducer } });
      const dispatchPromise = store.dispatch(
        submitFeedback({ projectId: "proj-1", text: "Bug report" }),
      );

      const state = store.getState().validate as ValidateState;
      expect(state.submitting).toBe(true);
      expect(state.error).toBeNull();

      resolveApi!(mockFeedbackItem);
      await dispatchPromise;
    });

    it("prepends new feedback and clears submitting on fulfilled", async () => {
      vi.mocked(api.feedback.submit).mockResolvedValue(mockFeedbackItem);
      const store = configureStore({ reducer: { validate: validateReducer } });
      store.dispatch(setFeedback([{ ...mockFeedbackItem, id: "fb-0", text: "Existing" }]));

      await store.dispatch(submitFeedback({ projectId: "proj-1", text: "New feedback" }));

      const state = store.getState().validate as ValidateState;
      expect(state.feedback).toHaveLength(2);
      expect(state.feedback[0]).toEqual(mockFeedbackItem);
      expect(state.feedback[1].text).toBe("Existing");
      expect(state.submitting).toBe(false);
    });

    it("calls api.feedback.submit with projectId, text, and optional images", async () => {
      vi.mocked(api.feedback.submit).mockResolvedValue(mockFeedbackItem);
      const store = configureStore({ reducer: { validate: validateReducer } });
      await store.dispatch(
        submitFeedback({
          projectId: "proj-1",
          text: "Bug with screenshot",
          images: ["data:image/png;base64,abc"],
        }),
      );

      expect(api.feedback.submit).toHaveBeenCalledWith(
        "proj-1",
        "Bug with screenshot",
        ["data:image/png;base64,abc"],
      );
    });

    it("sets error and clears submitting on rejected", async () => {
      vi.mocked(api.feedback.submit).mockRejectedValue(new Error("Submit failed"));
      const store = configureStore({ reducer: { validate: validateReducer } });
      await store.dispatch(submitFeedback({ projectId: "proj-1", text: "Feedback" }));

      const state = store.getState().validate as ValidateState;
      expect(state.submitting).toBe(false);
      expect(state.error).toBe("Submit failed");
    });
  });
});
