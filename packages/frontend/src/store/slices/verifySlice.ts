import { createSlice, createAsyncThunk, type PayloadAction } from "@reduxjs/toolkit";
import type { FeedbackItem } from "@opensprint/shared";
import { api } from "../../api/client";

export interface VerifyState {
  feedback: FeedbackItem[];
  loading: boolean;
  submitting: boolean;
  error: string | null;
}

const initialState: VerifyState = {
  feedback: [],
  loading: false,
  submitting: false,
  error: null,
};

export const fetchFeedback = createAsyncThunk("verify/fetchFeedback", async (projectId: string) => {
  return (await api.feedback.list(projectId)) as FeedbackItem[];
});

export const submitFeedback = createAsyncThunk(
  "verify/submitFeedback",
  async ({ projectId, text }: { projectId: string; text: string }) => {
    return (await api.feedback.submit(projectId, text)) as FeedbackItem;
  },
);

const verifySlice = createSlice({
  name: "verify",
  initialState,
  reducers: {
    setFeedback(state, action: PayloadAction<FeedbackItem[]>) {
      state.feedback = action.payload;
    },
    setVerifyError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    resetVerify() {
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
      // submitFeedback
      .addCase(submitFeedback.pending, (state) => {
        state.submitting = true;
        state.error = null;
      })
      .addCase(submitFeedback.fulfilled, (state, action) => {
        state.submitting = false;
        state.feedback.unshift(action.payload);
      })
      .addCase(submitFeedback.rejected, (state, action) => {
        state.submitting = false;
        state.error = action.error.message ?? "Failed to submit feedback";
      });
  },
});

export const { setFeedback, setVerifyError, resetVerify } = verifySlice.actions;
export default verifySlice.reducer;
