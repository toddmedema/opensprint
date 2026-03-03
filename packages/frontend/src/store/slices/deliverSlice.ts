import { createSlice, createAsyncThunk, type PayloadAction } from "@reduxjs/toolkit";
import type { DeploymentRecord, DeploymentConfig } from "@opensprint/shared";
import { api } from "../../api/client";
import { DEDUP_SKIP } from "../dedup";
import { createInitialAsyncStates, createAsyncHandlers, type AsyncStates } from "../asyncHelpers";

export interface DeliverStatusResponse {
  activeDeployId: string | null;
  currentDeploy: DeploymentRecord | null;
}

const STATUS_IN_FLIGHT_KEY = "statusInFlightCount" as const;
const HISTORY_IN_FLIGHT_KEY = "historyInFlightCount" as const;

const DELIVER_ASYNC_KEYS = [
  "status",
  "history",
  "trigger",
  "expoDeploy",
  "rollback",
  "settings",
] as const;
type DeliverAsyncKey = (typeof DELIVER_ASYNC_KEYS)[number];

export interface DeliverState {
  history: DeploymentRecord[];
  currentDeploy: DeploymentRecord | null;
  activeDeployId: string | null;
  selectedDeployId: string | null;
  liveLog: string[];
  [STATUS_IN_FLIGHT_KEY]: number;
  [HISTORY_IN_FLIGHT_KEY]: number;
  async: AsyncStates<DeliverAsyncKey>;
  /** Last error from any async operation (backward compat) */
  error: string | null;
}

const initialState: DeliverState = {
  history: [],
  currentDeploy: null,
  activeDeployId: null,
  selectedDeployId: null,
  liveLog: [],
  [STATUS_IN_FLIGHT_KEY]: 0,
  [HISTORY_IN_FLIGHT_KEY]: 0,
  async: createInitialAsyncStates(DELIVER_ASYNC_KEYS),
  error: null,
};

const MAX_LIVE_LOG = 10000;

export const fetchDeliverStatus = createAsyncThunk(
  "deliver/fetchStatus",
  async (projectId: string, { getState, rejectWithValue }) => {
    const root = getState() as { deliver: DeliverState };
    const inFlight = root.deliver[STATUS_IN_FLIGHT_KEY] ?? 0;
    if (inFlight > 1) {
      return rejectWithValue(DEDUP_SKIP);
    }
    return api.deliver.status(projectId);
  }
);

export const fetchDeliverHistory = createAsyncThunk(
  "deliver/fetchHistory",
  async (projectId: string, { getState, rejectWithValue }) => {
    const root = getState() as { deliver: DeliverState };
    const inFlight = root.deliver[HISTORY_IN_FLIGHT_KEY] ?? 0;
    if (inFlight > 1) {
      return rejectWithValue(DEDUP_SKIP);
    }
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

export const deployExpo = createAsyncThunk(
  "deliver/expoDeploy",
  async ({ projectId, variant }: { projectId: string; variant: "beta" | "prod" }, { dispatch }) => {
    const { deployId } = await api.deliver.expoDeploy(projectId, variant);
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
    /** Sync from TanStack Query useDeliverStatus. */
    setDeliverStatusPayload(
      state,
      action: PayloadAction<{
        activeDeployId: string | null;
        currentDeploy: DeploymentRecord | null;
      }>
    ) {
      state.currentDeploy = action.payload.currentDeploy;
      state.activeDeployId = action.payload.activeDeployId;
    },
    /** Sync from TanStack Query useDeliverHistory. */
    setDeliverHistoryPayload(state, action: PayloadAction<DeploymentRecord[]>) {
      state.history = action.payload;
    },
    resetDeliver() {
      return initialState;
    },
  },
  extraReducers: (builder) => {
    // fetchDeliverStatus — custom in-flight + status merge
    builder
      .addCase(fetchDeliverStatus.pending, (state) => {
        state[STATUS_IN_FLIGHT_KEY] = (state[STATUS_IN_FLIGHT_KEY] ?? 0) + 1;
        state.async.status.loading = true;
        state.async.status.error = null;
        state.error = null;
      })
      .addCase(fetchDeliverStatus.fulfilled, (state, action) => {
        state.currentDeploy = action.payload.currentDeploy;
        state.activeDeployId = action.payload.activeDeployId;
        state.async.status.loading = false;
        state[STATUS_IN_FLIGHT_KEY] = Math.max(0, (state[STATUS_IN_FLIGHT_KEY] ?? 1) - 1);
      })
      .addCase(fetchDeliverStatus.rejected, (state, action) => {
        state[STATUS_IN_FLIGHT_KEY] = Math.max(0, (state[STATUS_IN_FLIGHT_KEY] ?? 1) - 1);
        if (action.payload === DEDUP_SKIP) return;
        state.async.status.loading = false;
        state.async.status.error = action.error.message ?? "Failed to load deliver status";
        state.error = action.error.message ?? "Failed to load deliver status";
      });

    // fetchDeliverHistory — custom in-flight
    builder
      .addCase(fetchDeliverHistory.pending, (state) => {
        state[HISTORY_IN_FLIGHT_KEY] = (state[HISTORY_IN_FLIGHT_KEY] ?? 0) + 1;
        state.async.history.loading = true;
        state.async.history.error = null;
        state.error = null;
      })
      .addCase(fetchDeliverHistory.fulfilled, (state, action) => {
        state.history = action.payload;
        state.async.history.loading = false;
        state[HISTORY_IN_FLIGHT_KEY] = Math.max(0, (state[HISTORY_IN_FLIGHT_KEY] ?? 1) - 1);
      })
      .addCase(fetchDeliverHistory.rejected, (state, action) => {
        state[HISTORY_IN_FLIGHT_KEY] = Math.max(0, (state[HISTORY_IN_FLIGHT_KEY] ?? 1) - 1);
        if (action.payload === DEDUP_SKIP) return;
        state.async.history.loading = false;
        state.async.history.error = action.error.message ?? "Failed to load deliver history";
        state.error = action.error.message ?? "Failed to load deliver history";
      });

    createAsyncHandlers("trigger", triggerDeliver, builder, {
      onPending: (state) => {
        state.error = null;
      },
      onFulfilled: (state, action) => {
        state.selectedDeployId = (action.payload as { deployId: string }).deployId;
        state.liveLog = [];
      },
      onRejected: (state, action) => {
        state.error = action.error?.message ?? "Deliver failed";
      },
      defaultError: "Deliver failed",
    });

    createAsyncHandlers("expoDeploy", deployExpo, builder, {
      onPending: (state) => {
        state.error = null;
      },
      onFulfilled: (state, action) => {
        state.selectedDeployId = (action.payload as { deployId: string }).deployId;
        state.liveLog = [];
      },
      onRejected: (state, action) => {
        state.error = action.error?.message ?? "Expo deploy failed";
      },
      defaultError: "Expo deploy failed",
    });

    createAsyncHandlers("rollback", rollbackDeliver, builder, {
      onPending: (state) => {
        state.error = null;
      },
      onRejected: (state, action) => {
        state.error = action.error?.message ?? "Rollback failed";
      },
      defaultError: "Rollback failed",
    });

    createAsyncHandlers("settings", updateDeliverSettings, builder, {
      onPending: (state) => {
        state.error = null;
      },
      onRejected: (state, action) => {
        state.error = action.error?.message ?? "Failed to update settings";
      },
      defaultError: "Failed to update settings",
    });
  },
});

export const {
  setSelectedDeployId,
  appendDeliverOutput,
  deliverStarted,
  deliverCompleted,
  setDeliverStatusPayload,
  setDeliverHistoryPayload,
  resetDeliver,
} = deliverSlice.actions;
export default deliverSlice.reducer;
