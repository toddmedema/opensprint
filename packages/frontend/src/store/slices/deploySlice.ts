import { createSlice, createAsyncThunk, type PayloadAction } from "@reduxjs/toolkit";
import type { DeploymentRecord, DeploymentConfig } from "@opensprint/shared";
import { api } from "../../api/client";

export interface DeployStatusResponse {
  activeDeployId: string | null;
  currentDeploy: DeploymentRecord | null;
}

export interface DeployState {
  history: DeploymentRecord[];
  currentDeploy: DeploymentRecord | null;
  activeDeployId: string | null;
  selectedDeployId: string | null;
  liveLog: string[];
  deployLoading: boolean;
  statusLoading: boolean;
  historyLoading: boolean;
  rollbackLoading: boolean;
  settingsLoading: boolean;
  error: string | null;
}

const initialState: DeployState = {
  history: [],
  currentDeploy: null,
  activeDeployId: null,
  selectedDeployId: null,
  liveLog: [],
  deployLoading: false,
  statusLoading: false,
  historyLoading: false,
  rollbackLoading: false,
  settingsLoading: false,
  error: null,
};

const MAX_LIVE_LOG = 10000;

export const fetchDeployStatus = createAsyncThunk(
  "deploy/fetchStatus",
  async (projectId: string) => {
    return api.deliver.status(projectId);
  }
);

export const fetchDeployHistory = createAsyncThunk(
  "deploy/fetchHistory",
  async (projectId: string) => {
    return api.deliver.history(projectId);
  }
);

export const triggerDeploy = createAsyncThunk(
  "deploy/trigger",
  async ({ projectId, target }: { projectId: string; target?: string }, { dispatch }) => {
    const { deployId } = await api.deliver.deploy(projectId, target);
    dispatch(fetchDeployStatus(projectId));
    dispatch(fetchDeployHistory(projectId));
    return { deployId };
  }
);

export const rollbackDeploy = createAsyncThunk(
  "deploy/rollback",
  async ({ projectId, deployId }: { projectId: string; deployId: string }, { dispatch }) => {
    const result = await api.deliver.rollback(projectId, deployId);
    dispatch(fetchDeployStatus(projectId));
    dispatch(fetchDeployHistory(projectId));
    return result;
  }
);

export const updateDeploySettings = createAsyncThunk(
  "deploy/updateSettings",
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

const deploySlice = createSlice({
  name: "deploy",
  initialState,
  reducers: {
    setSelectedDeployId(state, action: PayloadAction<string | null>) {
      state.selectedDeployId = action.payload;
      state.liveLog = [];
    },
    appendDeployOutput(state, action: PayloadAction<{ deployId: string; chunk: string }>) {
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
    deployStarted(state, action: PayloadAction<{ deployId: string }>) {
      state.activeDeployId = action.payload.deployId;
      state.selectedDeployId = action.payload.deployId;
      state.liveLog = [];
    },
    deployCompleted(
      state,
      action: PayloadAction<{ deployId: string; success: boolean; fixEpicId?: string | null }>
    ) {
      if (state.activeDeployId === action.payload.deployId) {
        state.activeDeployId = null;
      }
      // Update history record with fixEpicId when present (for immediate UI update before refetch)
      if (action.payload.fixEpicId) {
        const rec = state.history.find((r) => r.id === action.payload.deployId);
        if (rec) rec.fixEpicId = action.payload.fixEpicId;
      }
    },
    resetDeploy() {
      return initialState;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchDeployStatus.pending, (state) => {
        state.statusLoading = true;
        state.error = null;
      })
      .addCase(fetchDeployStatus.fulfilled, (state, action) => {
        state.currentDeploy = action.payload.currentDeploy;
        state.activeDeployId = action.payload.activeDeployId;
        state.statusLoading = false;
      })
      .addCase(fetchDeployStatus.rejected, (state, action) => {
        state.statusLoading = false;
        state.error = action.error.message ?? "Failed to load deploy status";
      })
      .addCase(fetchDeployHistory.pending, (state) => {
        state.historyLoading = true;
        state.error = null;
      })
      .addCase(fetchDeployHistory.fulfilled, (state, action) => {
        state.history = action.payload;
        state.historyLoading = false;
      })
      .addCase(fetchDeployHistory.rejected, (state, action) => {
        state.historyLoading = false;
        state.error = action.error.message ?? "Failed to load deploy history";
      })
      .addCase(triggerDeploy.pending, (state) => {
        state.deployLoading = true;
        state.error = null;
      })
      .addCase(triggerDeploy.fulfilled, (state, action) => {
        state.deployLoading = false;
        state.selectedDeployId = action.payload.deployId;
        state.liveLog = [];
      })
      .addCase(triggerDeploy.rejected, (state, action) => {
        state.deployLoading = false;
        state.error = action.error.message ?? "Deliver failed";
      })
      .addCase(rollbackDeploy.pending, (state) => {
        state.rollbackLoading = true;
        state.error = null;
      })
      .addCase(rollbackDeploy.fulfilled, (state) => {
        state.rollbackLoading = false;
      })
      .addCase(rollbackDeploy.rejected, (state, action) => {
        state.rollbackLoading = false;
        state.error = action.error.message ?? "Rollback failed";
      })
      .addCase(updateDeploySettings.pending, (state) => {
        state.settingsLoading = true;
        state.error = null;
      })
      .addCase(updateDeploySettings.fulfilled, (state) => {
        state.settingsLoading = false;
      })
      .addCase(updateDeploySettings.rejected, (state, action) => {
        state.settingsLoading = false;
        state.error = action.error.message ?? "Failed to update settings";
      });
  },
});

export const {
  setSelectedDeployId,
  appendDeployOutput,
  deployStarted,
  deployCompleted,
  resetDeploy,
} = deploySlice.actions;
export default deploySlice.reducer;
