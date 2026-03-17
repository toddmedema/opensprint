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

const EMPTY_NOTIFICATIONS: Notification[] = [];

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

export const clearAllByProject = createAsyncThunk(
  "openQuestions/clearAllByProject",
  async (projectId: string): Promise<{ deletedCount: number }> => {
    return api.notifications.clearAllByProject(projectId);
  }
);

export const clearAllGlobal = createAsyncThunk(
  "openQuestions/clearAllGlobal",
  async (): Promise<{ deletedCount: number }> => {
    return api.notifications.clearAllGlobal();
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
    /** Update notification (e.g. after resolve with responses so UI can show reply) */
    updateNotification(state, action: PayloadAction<Notification>) {
      const n = action.payload;
      if (!state.byProject[n.projectId]) {
        state.byProject[n.projectId] = [];
      }
      const projectList = state.byProject[n.projectId];
      const idx = projectList.findIndex((x) => x.id === n.id);
      if (idx >= 0) {
        projectList[idx] = n;
      } else {
        projectList.unshift(n);
      }
      const globalIdx = state.global.findIndex((x) => x.id === n.id);
      if (globalIdx >= 0) {
        state.global[globalIdx] = n;
      } else {
        state.global.unshift(n);
      }
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
        const fromApi = action.payload ?? [];
        const current = state.byProject[id] ?? [];
        const resolvedInState = current.filter((n) => n.status === "resolved");
        const apiIds = new Set(fromApi.map((n) => n.id));
        const keptResolved = resolvedInState.filter((n) => !apiIds.has(n.id));
        state.byProject[id] = [...fromApi, ...keptResolved];
        state.global = state.global
          .filter((n) => n.projectId !== id)
          .concat(state.byProject[id]);
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
      })
      .addCase(clearAllByProject.fulfilled, (state, action) => {
        const projectId = action.meta.arg;
        if (action.payload.deletedCount > 0 && state.byProject[projectId]) {
          const ids = new Set(state.byProject[projectId].map((n) => n.id));
          state.global = state.global.filter((x) => !ids.has(x.id));
          state.byProject[projectId] = [];
        }
      })
      .addCase(clearAllGlobal.fulfilled, (state, action) => {
        if (action.payload.deletedCount > 0) {
          state.byProject = {};
          state.global = [];
        }
      });
  },
});

export const { addNotification, removeNotification, updateNotification } =
  openQuestionsSlice.actions;
export const selectProjectNotifications = (
  state: { openQuestions?: OpenQuestionsState },
  projectId: string | null | undefined
): Notification[] => {
  if (!projectId) return EMPTY_NOTIFICATIONS;
  return state.openQuestions?.byProject?.[projectId] ?? EMPTY_NOTIFICATIONS;
};

export const selectProjectNotificationsLoading = (
  state: { openQuestions?: OpenQuestionsState },
  projectId: string | null | undefined
): boolean => {
  if (!projectId) return false;
  return state.openQuestions?.async.project?.[projectId]?.loading ?? false;
};

export default openQuestionsSlice.reducer;
