import { createSlice, createAsyncThunk, type PayloadAction } from "@reduxjs/toolkit";
import type { FeedbackItem } from "@opensprint/shared";
import { api } from "../../api/client";
import { createInitialAsyncStates, createAsyncHandlers, type AsyncStates } from "../asyncHelpers";

const EVAL_ASYNC_KEYS = ["feedback", "submit", "feedbackItem"] as const;
type EvalAsyncKey = (typeof EVAL_ASYNC_KEYS)[number];

export interface EvalState {
  feedback: FeedbackItem[];
  /** Cache of single feedback items fetched by id (e.g. for SourceFeedbackSection) */
  feedbackItemCache: Record<string, FeedbackItem>;
  /** feedbackId that failed (so we know which request the error belongs to) */
  feedbackItemErrorId: string | null;
  /** feedbackId currently being loaded (for per-item loading UI) */
  feedbackItemLoadingId: string | null;
  async: AsyncStates<EvalAsyncKey>;
  /** Last error from any async operation (backward compat) */
  error: string | null;
}

const initialState: EvalState = {
  feedback: [],
  feedbackItemCache: {},
  feedbackItemErrorId: null,
  feedbackItemLoadingId: null,
  async: createInitialAsyncStates(EVAL_ASYNC_KEYS),
  error: null,
};

export const fetchFeedback = createAsyncThunk("eval/fetchFeedback", async (projectId: string) => {
  return api.feedback.list(projectId);
});

export const submitFeedback = createAsyncThunk(
  "eval/submitFeedback",
  async ({
    projectId,
    text,
    images,
    parentId,
    priority,
  }: {
    projectId: string;
    text: string;
    images?: string[];
    parentId?: string | null;
    priority?: number | null;
  }) => {
    return api.feedback.submit(projectId, text, images, parentId, priority);
  }
);

export const recategorizeFeedback = createAsyncThunk(
  "eval/recategorizeFeedback",
  async ({ projectId, feedbackId }: { projectId: string; feedbackId: string }) => {
    return api.feedback.recategorize(projectId, feedbackId);
  }
);

export const resolveFeedback = createAsyncThunk(
  "eval/resolveFeedback",
  async ({ projectId, feedbackId }: { projectId: string; feedbackId: string }) => {
    return api.feedback.resolve(projectId, feedbackId);
  }
);

export const cancelFeedback = createAsyncThunk(
  "eval/cancelFeedback",
  async ({ projectId, feedbackId }: { projectId: string; feedbackId: string }) => {
    return api.feedback.cancel(projectId, feedbackId);
  }
);

export const fetchFeedbackItem = createAsyncThunk(
  "eval/fetchFeedbackItem",
  async ({ projectId, feedbackId }: { projectId: string; feedbackId: string }) => {
    return api.feedback.get(projectId, feedbackId);
  }
);

/** Prefix for optimistic feedback IDs; replaced when API returns */
const OPTIMISTIC_ID_PREFIX = "temp-";

/** Ensures state.async exists when tests use partial preloadedState */
function ensureAsync(state: EvalState): void {
  if (!state.async) {
    state.async = createInitialAsyncStates(EVAL_ASYNC_KEYS);
  }
}

const evalSlice = createSlice({
  name: "eval",
  initialState,
  reducers: {
    setFeedback(state, action: PayloadAction<FeedbackItem[]>) {
      state.feedback = action.payload;
    },
    /** Update a single feedback item in place (e.g. from WebSocket feedback.mapped/feedback.updated/feedback.resolved). Preserves list order and other items. Adds item if not in list (e.g. WebSocket event before list load). */
    updateFeedbackItem(state, action: PayloadAction<FeedbackItem>) {
      const item = action.payload;
      const idx = state.feedback.findIndex((f) => f.id === item.id);
      if (idx !== -1) {
        state.feedback[idx] = item;
      } else {
        state.feedback.unshift(item);
      }
      if (state.feedbackItemCache && state.feedbackItemCache[item.id]) {
        state.feedbackItemCache[item.id] = item;
      }
    },
    /** Set a feedback item's status to resolved by id (e.g. when feedback.resolved has no item). Avoids fetchFeedback which causes scroll jump. */
    updateFeedbackItemResolved(state, action: PayloadAction<string>) {
      const feedbackId = action.payload;
      const idx = state.feedback.findIndex((f) => f.id === feedbackId);
      if (idx !== -1) {
        state.feedback[idx].status = "resolved";
      }
    },
    /** Remove feedback item and all descendants from list (e.g. after collapse animation completes) */
    removeFeedbackItem(state, action: PayloadAction<string>) {
      const removeId = action.payload;
      const toRemove = new Set<string>([removeId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const f of state.feedback) {
          if (f.parent_id && toRemove.has(f.parent_id) && !toRemove.has(f.id)) {
            toRemove.add(f.id);
            changed = true;
          }
        }
      }
      state.feedback = state.feedback.filter((f) => !toRemove.has(f.id));
    },
    setEvalError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    resetEval() {
      return initialState;
    },
  },
  extraReducers: (builder) => {
    createAsyncHandlers("feedback", fetchFeedback, builder, {
      ensureState: ensureAsync,
      onFulfilled: (state, action) => {
        state.feedback = action.payload as FeedbackItem[];
      },
      onRejected: (state, action) => {
        state.error = action.error?.message ?? "Failed to load feedback";
      },
      defaultError: "Failed to load feedback",
    });
    // submitFeedback — optimistic: show feedback immediately, replace on fulfilled, remove on rejected
    builder.addCase(submitFeedback.pending, (state, action) => {
      ensureAsync(state);
      state.async.submit.loading = true;
      state.async.submit.error = null;
      state.error = null;
      const { text, images, parentId } = action.meta.arg;
      const requestId = action.meta.requestId;
      const parent = parentId ? state.feedback.find((f) => f.id === parentId) : null;
      const depth = parent ? (parent.depth ?? 0) + 1 : 0;
      const optimistic: FeedbackItem = {
        id: `${OPTIMISTIC_ID_PREFIX}${requestId}`,
        text,
        category: "bug",
        mappedPlanId: null,
        createdTaskIds: [],
        status: "pending",
        createdAt: new Date().toISOString(),
        ...(images?.length ? { images } : {}),
        parent_id: parentId ?? null,
        depth,
      };
      state.feedback.unshift(optimistic);
    });
    builder.addCase(submitFeedback.fulfilled, (state, action) => {
      ensureAsync(state);
      state.async.submit.loading = false;
      const requestId = action.meta.requestId;
      const tempId = `${OPTIMISTIC_ID_PREFIX}${requestId}`;
      const idx = state.feedback.findIndex((f) => f.id === tempId);
      if (idx !== -1) {
        state.feedback[idx] = action.payload;
      } else {
        state.feedback.unshift(action.payload);
      }
    });
    builder.addCase(submitFeedback.rejected, (state, action) => {
      ensureAsync(state);
      state.async.submit.loading = false;
      state.error = action.error.message ?? "Failed to submit feedback";
      const requestId = action.meta.requestId;
      const tempId = `${OPTIMISTIC_ID_PREFIX}${requestId}`;
      const idx = state.feedback.findIndex((f) => f.id === tempId);
      if (idx !== -1) {
        state.feedback.splice(idx, 1);
      }
    });

    builder.addCase(recategorizeFeedback.fulfilled, (state, action) => {
      const idx = state.feedback.findIndex((f) => f.id === action.payload.id);
      if (idx !== -1) state.feedback[idx] = action.payload;
    });
    builder.addCase(recategorizeFeedback.rejected, (state, action) => {
      state.error = action.error.message ?? "Failed to recategorize feedback";
    });
    // resolveFeedback — optimistic: set status to resolved immediately
    builder.addCase(resolveFeedback.pending, (state, action) => {
      const { feedbackId } = action.meta.arg;
      const idx = state.feedback.findIndex((f) => f.id === feedbackId);
      if (idx !== -1) state.feedback[idx].status = "resolved";
    });
    builder.addCase(resolveFeedback.fulfilled, (state, action) => {
      const idx = state.feedback.findIndex((f) => f.id === action.payload.id);
      if (idx !== -1) state.feedback[idx] = action.payload;
    });
    builder.addCase(resolveFeedback.rejected, (state, action) => {
      state.error = action.error.message ?? "Failed to resolve feedback";
      // Revert optimistic update: set status back to pending
      const { feedbackId } = action.meta.arg;
      const idx = state.feedback.findIndex((f) => f.id === feedbackId);
      if (idx !== -1) state.feedback[idx].status = "pending";
    });
    // cancelFeedback — optimistic: set status to cancelled immediately
    builder.addCase(cancelFeedback.pending, (state, action) => {
      const { feedbackId } = action.meta.arg;
      const idx = state.feedback.findIndex((f) => f.id === feedbackId);
      if (idx !== -1) state.feedback[idx].status = "cancelled";
    });
    builder.addCase(cancelFeedback.fulfilled, (state, action) => {
      const idx = state.feedback.findIndex((f) => f.id === action.payload.id);
      if (idx !== -1) state.feedback[idx] = action.payload;
    });
    builder.addCase(cancelFeedback.rejected, (state, action) => {
      state.error = action.error.message ?? "Failed to cancel feedback";
      const { feedbackId } = action.meta.arg;
      const idx = state.feedback.findIndex((f) => f.id === feedbackId);
      if (idx !== -1) state.feedback[idx].status = "pending";
    });

    // fetchFeedbackItem — requires feedbackItemLoadingId for per-item loading UI
    builder
      .addCase(fetchFeedbackItem.pending, (state, action) => {
        ensureAsync(state);
        state.feedbackItemLoadingId = action.meta.arg.feedbackId;
        state.async.feedbackItem.loading = true;
        state.async.feedbackItem.error = null;
        state.feedbackItemErrorId = null;
      })
      .addCase(fetchFeedbackItem.fulfilled, (state, action) => {
        ensureAsync(state);
        state.feedbackItemLoadingId = null;
        state.async.feedbackItem.loading = false;
        if (action.payload) {
          state.feedbackItemCache[action.payload.id] = action.payload;
        }
      })
      .addCase(fetchFeedbackItem.rejected, (state, action) => {
        ensureAsync(state);
        state.feedbackItemLoadingId = null;
        state.async.feedbackItem.loading = false;
        state.async.feedbackItem.error = action.error.message ?? "Failed to load feedback";
        state.feedbackItemErrorId = action.meta.arg.feedbackId;
      });
  },
});

export const {
  setFeedback,
  setEvalError,
  resetEval,
  removeFeedbackItem,
  updateFeedbackItem,
  updateFeedbackItemResolved,
} = evalSlice.actions;
export default evalSlice.reducer;
