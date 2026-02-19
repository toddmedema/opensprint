import { createSlice, createAsyncThunk, type PayloadAction } from "@reduxjs/toolkit";
import type { DeploymentRecord, DeploymentConfig } from "@opensprint/shared";
import { api } from "../../api/client";

export interface DeliverStatusResponse {
  activeDeployId: string | null;
  currentDeploy: DeploymentRecord | null;
}

export interface DeliverState {
  history: DeploymentRecord[];
  currentDeploy: DeploymentRecord | null;
  activeDeployId: string | null;
  selectedDeployId: string | null;
  liveLog: string[];
  deliverLoading: boolean;
  statusLoading: boolean;
  historyLoading: boolean;
  rollbackLoading: boolean;
  settingsLoading: boolean;
  error: string | null;
}

const initialState: DeliverState = {
  history: [],
  currentDeploy: null,
  activeDeployId: null,
  selectedDeployId: null,
  liveLog: [],
  deliverLoading: false,
  statusLoading: false,
  historyLoading: false,
  rollbackLoading: false,
  settingsLoading: false,
  error: null,
};

const MAX_LIVE_LOG = 10000;

export const fetchDeliverStatus = createAsyncThunk(
  "deliver/fetchStatus",
  async (projectId: string) => {
    return api.deliver.status(projectId);
  }
);

export const fetchDeliverHistory = createAsyncThunk(
  "deliver/fetchHistory",
  async (projectId: string) => {
    return api.deliver.history(projectId);
  }
);

export const triggerDeliver = createAsyncThunk(
  "deliver/trigger",
  async ({ projectId, target }: { projectId: string; target?: string }, { dispatch }) => {
    const { deployId } = await api.deliver.deploy(projectId, target);
    dispatch(fetchDeliverStatus(projectId));
    dispatch(fetchDeliverHistory(projectId));
    return { deployId };
  }
);

export const rollbackDeliver = createAsyncThunk(
  "deliver/rollback",
  async ({ projectId, deployId }: { projectId: string; deployId: string }, { dispatch }) => {
    const result = await api.deliver.rollback(projectId, deployId);
    dispatch(fetchDeliverStatus(projectId));
    dispatch(fetchDeliverHistory(projectId));
    return result;
  }
);

export const updateDeliverSettings = createAsyncThunk(
  "deliver/updateSettings",
  async ({
    projectId,
    deployment,
  }: {
    projectId: string;
    deployment: Partial<DeploymentConfig>;
  }) => {
    return api.deliver.updateSettings(projectId, deployment);
  }
);

const deliverSlice = createSlice({
  name: "deliver",
  initialState,
  reducers: {
    setSelectedDeployId(state, action: PayloadAction<string | null>) {
      state.selectedDeployId = action.payload;
      state.liveLog = [];
    },
    appendDeliverOutput(state, action: PayloadAction<{ deployId: string; chunk: string }>) {
      if (
        action.payload.deployId === state.selectedDeployId ||
        action.payload.deployId === state.activeDeployId
      ) {
        state.liveLog.push(action.payload.chunk);
        if (state.liveLog.length > MAX_LIVE_LOG) {
          state.liveLog = state.liveLog.slice(-MAX_LIVE_LOG);
        }
      }
    },
    deliverStarted(state, action: PayloadAction<{ deployId: string }>) {
      state.activeDeployId = action.payload.deployId;
      state.selectedDeployId = action.payload.deployId;
      state.liveLog = [];
    },
    deliverCompleted(
      state,
      action: PayloadAction<{ deployId: string; success: boolean; fixEpicId?: string | null }>
    ) {
      if (state.activeDeployId === action.payload.deployId) {
        state.activeDeployId = null;
      }
      if (action.payload.fixEpicId) {
        const rec = state.history.find((r) => r.id === action.payload.deployId);
        if (rec) rec.fixEpicId = action.payload.fixEpicId;
      }
    },
    resetDeliver() {
      return initialState;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchDeliverStatus.pending, (state) => {
        state.statusLoading = true;
        state.error = null;
      })
      .addCase(fetchDeliverStatus.fulfilled, (state, action) => {
        state.currentDeploy = action.payload.currentDeploy;
        state.activeDeployId = action.payload.activeDeployId;
        state.statusLoading = false;
      })
      .addCase(fetchDeliverStatus.rejected, (state, action) => {
        state.statusLoading = false;
        state.error = action.error.message ?? "Failed to load deliver status";
      })
      .addCase(fetchDeliverHistory.pending, (state) => {
        state.historyLoading = true;
        state.error = null;
      })
      .addCase(fetchDeliverHistory.fulfilled, (state, action) => {
        state.history = action.payload;
        state.historyLoading = false;
      })
      .addCase(fetchDeliverHistory.rejected, (state, action) => {
        state.historyLoading = false;
        state.error = action.error.message ?? "Failed to load deliver history";
      })
      .addCase(triggerDeliver.pending, (state) => {
        state.deliverLoading = true;
        state.error = null;
      })
      .addCase(triggerDeliver.fulfilled, (state, action) => {
        state.deliverLoading = false;
        state.selectedDeployId = action.payload.deployId;
        state.liveLog = [];
      })
      .addCase(triggerDeliver.rejected, (state, action) => {
        state.deliverLoading = false;
        state.error = action.error.message ?? "Deliver failed";
      })
      .addCase(rollbackDeliver.pending, (state) => {
        state.rollbackLoading = true;
        state.error = null;
      })
      .addCase(rollbackDeliver.fulfilled, (state) => {
        state.rollbackLoading = false;
      })
      .addCase(rollbackDeliver.rejected, (state, action) => {
        state.rollbackLoading = false;
        state.error = action.error.message ?? "Rollback failed";
      })
      .addCase(updateDeliverSettings.pending, (state) => {
        state.settingsLoading = true;
        state.error = null;
      })
      .addCase(updateDeliverSettings.fulfilled, (state) => {
        state.settingsLoading = false;
      })
      .addCase(updateDeliverSettings.rejected, (state, action) => {
        state.settingsLoading = false;
        state.error = action.error.message ?? "Failed to update settings";
      });
  },
});

export const {
  setSelectedDeployId,
  appendDeliverOutput,
  deliverStarted,
  deliverCompleted,
  resetDeliver,
} = deliverSlice.actions;
export default deliverSlice.reducer;
