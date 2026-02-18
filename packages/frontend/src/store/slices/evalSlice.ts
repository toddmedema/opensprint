import { createSlice, createAsyncThunk, type PayloadAction } from "@reduxjs/toolkit";
import type { FeedbackItem } from "@opensprint/shared";
import { api } from "../../api/client";

export interface EvalState {
  feedback: FeedbackItem[];
  loading: boolean;
  submitting: boolean;
  error: string | null;
}

const initialState: EvalState = {
  feedback: [],
  loading: false,
  submitting: false,
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
  }: {
    projectId: string;
    text: string;
    images?: string[];
    parentId?: string | null;
  }) => {
    return api.feedback.submit(projectId, text, images, parentId);
  },
);

export const recategorizeFeedback = createAsyncThunk(
  "eval/recategorizeFeedback",
  async ({ projectId, feedbackId }: { projectId: string; feedbackId: string }) => {
    return api.feedback.recategorize(projectId, feedbackId);
  },
);

export const resolveFeedback = createAsyncThunk(
  "eval/resolveFeedback",
  async ({ projectId, feedbackId }: { projectId: string; feedbackId: string }) => {
    return api.feedback.resolve(projectId, feedbackId);
  },
);

/** Prefix for optimistic feedback IDs; replaced when API returns */
const OPTIMISTIC_ID_PREFIX = "temp-";

const evalSlice = createSlice({
  name: "eval",
  initialState,
  reducers: {
    setFeedback(state, action: PayloadAction<FeedbackItem[]>) {
      state.feedback = action.payload;
    },
    setEvalError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    resetEval() {
      return initialState;
    },
  },
  extraReducers: (builder) => {
    builder
      // fetchFeedback
      .addCase(fetchFeedback.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchFeedback.fulfilled, (state, action) => {
        state.feedback = action.payload;
        state.loading = false;
      })
      .addCase(fetchFeedback.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message ?? "Failed to load feedback";
      })
      // submitFeedback — optimistic: show feedback immediately, replace on fulfilled, remove on rejected
      .addCase(submitFeedback.pending, (state, action) => {
        state.submitting = true;
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
      })
      .addCase(submitFeedback.fulfilled, (state, action) => {
        state.submitting = false;
        const requestId = action.meta.requestId;
        const tempId = `${OPTIMISTIC_ID_PREFIX}${requestId}`;
        const idx = state.feedback.findIndex((f) => f.id === tempId);
        if (idx !== -1) {
          state.feedback[idx] = action.payload;
        } else {
          state.feedback.unshift(action.payload);
        }
      })
      .addCase(submitFeedback.rejected, (state, action) => {
        state.submitting = false;
        state.error = action.error.message ?? "Failed to submit feedback";
        const requestId = action.meta.requestId;
        const tempId = `${OPTIMISTIC_ID_PREFIX}${requestId}`;
        const idx = state.feedback.findIndex((f) => f.id === tempId);
        if (idx !== -1) {
          state.feedback.splice(idx, 1);
        }
      })
      // recategorizeFeedback
      .addCase(recategorizeFeedback.fulfilled, (state, action) => {
        const idx = state.feedback.findIndex((f) => f.id === action.payload.id);
        if (idx !== -1) state.feedback[idx] = action.payload;
      })
      .addCase(recategorizeFeedback.rejected, (state, action) => {
        state.error = action.error.message ?? "Failed to recategorize feedback";
      })
      // resolveFeedback — optimistic: set status to resolved immediately
      .addCase(resolveFeedback.pending, (state, action) => {
        const { feedbackId } = action.meta.arg;
        const idx = state.feedback.findIndex((f) => f.id === feedbackId);
        if (idx !== -1) state.feedback[idx].status = "resolved";
      })
      .addCase(resolveFeedback.fulfilled, (state, action) => {
        const idx = state.feedback.findIndex((f) => f.id === action.payload.id);
        if (idx !== -1) state.feedback[idx] = action.payload;
      })
      .addCase(resolveFeedback.rejected, (state, action) => {
        state.error = action.error.message ?? "Failed to resolve feedback";
        // Revert optimistic update: set status back to mapped
        const { feedbackId } = action.meta.arg;
        const idx = state.feedback.findIndex((f) => f.id === feedbackId);
        if (idx !== -1) state.feedback[idx].status = "mapped";
      });
  },
});

export const { setFeedback, setEvalError, resetEval } = evalSlice.actions;
export default evalSlice.reducer;
