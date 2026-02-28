import { createSlice, createAsyncThunk, type PayloadAction } from "@reduxjs/toolkit";
import type { Notification } from "@opensprint/shared";
import { api } from "../../api/client";

export interface OpenQuestionsState {
  /** Notifications by project ID (project-scoped view) */
  byProject: Record<string, Notification[]>;
  /** All unresolved notifications (global/home view) */
  global: Notification[];
  async: {
    project: Record<string, { loading: boolean }>;
    global: { loading: boolean };
  };
}

const initialState: OpenQuestionsState = {
  byProject: {},
  global: [],
  async: {
    project: {},
    global: { loading: false },
  },
};

export const fetchProjectNotifications = createAsyncThunk(
  "openQuestions/fetchProject",
  async (projectId: string): Promise<Notification[]> => {
    return api.notifications.listByProject(projectId);
  }
);

export const fetchGlobalNotifications = createAsyncThunk(
  "openQuestions/fetchGlobal",
  async (): Promise<Notification[]> => {
    return api.notifications.listGlobal();
  }
);

const openQuestionsSlice = createSlice({
  name: "openQuestions",
  initialState,
  reducers: {
    /** Add notification (from WebSocket notification.added) */
    addNotification(state, action: PayloadAction<Notification>) {
      const n = action.payload;
      if (!state.byProject[n.projectId]) {
        state.byProject[n.projectId] = [];
      }
      const projectList = state.byProject[n.projectId];
      if (!projectList.some((x) => x.id === n.id)) {
        projectList.unshift(n);
      }
      if (!state.global.some((x) => x.id === n.id)) {
        state.global.unshift(n);
      }
    },
    /** Remove notification (from WebSocket notification.resolved) */
    removeNotification(
      state,
      action: PayloadAction<{ projectId: string; notificationId: string }>
    ) {
      const { projectId, notificationId } = action.payload;
      if (state.byProject[projectId]) {
        state.byProject[projectId] = state.byProject[projectId].filter(
          (x) => x.id !== notificationId
        );
      }
      state.global = state.global.filter((x) => x.id !== notificationId);
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchProjectNotifications.pending, (state, action) => {
        const id = action.meta.arg;
        if (!state.async.project[id]) state.async.project[id] = { loading: false };
        state.async.project[id].loading = true;
      })
      .addCase(fetchProjectNotifications.fulfilled, (state, action) => {
        const id = action.meta.arg;
        state.byProject[id] = action.payload ?? [];
        if (state.async.project[id]) state.async.project[id].loading = false;
      })
      .addCase(fetchProjectNotifications.rejected, (state, action) => {
        const id = action.meta.arg;
        if (state.async.project[id]) state.async.project[id].loading = false;
      })
      .addCase(fetchGlobalNotifications.pending, (state) => {
        state.async.global.loading = true;
      })
      .addCase(fetchGlobalNotifications.fulfilled, (state, action) => {
        state.global = action.payload ?? [];
        state.async.global.loading = false;
      })
      .addCase(fetchGlobalNotifications.rejected, (state) => {
        state.async.global.loading = false;
      });
  },
});

export const { addNotification, removeNotification } = openQuestionsSlice.actions;
export default openQuestionsSlice.reducer;
