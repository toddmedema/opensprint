import type { PayloadAction } from "@reduxjs/toolkit";
import type { ActionReducerMapBuilder } from "@reduxjs/toolkit";
import type { BaselineRuntimeStatus, MergeValidationRuntimeStatus } from "@opensprint/shared";
import type { ExecuteState } from "./executeTypes";
import type { ActiveTaskInfo } from "./executeTypes";
import { fetchExecuteStatus } from "./executeThunks";
import { ensureAsync } from "./executeThunks";
import { createAsyncHandlers } from "../asyncHelpers";

/**
 * When `merge_quality_gate_paused_until` has passed, the server derives null pause / no
 * `blocked_on_baseline` without a DB write — so no `task.updated` is emitted. Orchestrator
 * `execute.status` ticks still arrive; sweep in-memory tasks so merge-gate UI clears live.
 */
export function sweepExpiredBaselineMergePause(state: ExecuteState): void {
  const { tasksById } = state;
  if (!tasksById || Object.keys(tasksById).length === 0) return;
  const now = Date.now();
  for (const task of Object.values(tasksById)) {
    if (!task?.mergePausedUntil) continue;
    const ms = Date.parse(task.mergePausedUntil);
    if (!Number.isFinite(ms) || ms > now) continue;
    task.mergePausedUntil = null;
    task.mergeWaitingOnMain = false;
    if (task.mergeGateState === "blocked_on_baseline") {
      delete task.mergeGateState;
    }
  }
}

export const statusReducers = {
  setOrchestratorRunning(state: ExecuteState, action: PayloadAction<boolean>) {
    state.orchestratorRunning = action.payload;
  },
  setAwaitingApproval(state: ExecuteState, action: PayloadAction<boolean>) {
    state.awaitingApproval = action.payload;
  },
  setActiveTasks(state: ExecuteState, action: PayloadAction<ActiveTaskInfo[]>) {
    state.activeTasks = action.payload;
  },
  /** Sync from TanStack Query useExecuteStatus (replaces fetchExecuteStatus.fulfilled). */
  setExecuteStatusPayload(
    state: ExecuteState,
    action: PayloadAction<{
      activeTasks?: ActiveTaskInfo[];
      queueDepth?: number;
      awaitingApproval?: boolean;
      totalDone?: number;
      totalFailed?: number;
      baselineStatus?: BaselineRuntimeStatus;
      baselineCheckedAt?: string | null;
      baselineFailureSummary?: string | null;
      mergeValidationStatus?: MergeValidationRuntimeStatus;
      mergeValidationFailureSummary?: string | null;
      dispatchPausedReason?: string | null;
      selfImprovementRunInProgress?: boolean;
    }>
  ) {
    const p = action.payload;
    const activeTasks = p.activeTasks ?? [];
    state.activeTasks = activeTasks;
    state.orchestratorRunning = activeTasks.length > 0 || (p.queueDepth ?? 0) > 0;
    state.awaitingApproval = p.awaitingApproval ?? false;
    state.totalDone = p.totalDone ?? 0;
    state.totalFailed = p.totalFailed ?? 0;
    state.queueDepth = p.queueDepth ?? 0;
    if (p.baselineStatus !== undefined) {
      state.baselineStatus = p.baselineStatus;
    }
    if (p.baselineCheckedAt !== undefined) {
      state.baselineCheckedAt = p.baselineCheckedAt;
    }
    if (p.baselineFailureSummary !== undefined) {
      state.baselineFailureSummary = p.baselineFailureSummary;
    }
    if (p.mergeValidationStatus !== undefined) {
      state.mergeValidationStatus = p.mergeValidationStatus;
    }
    if (p.mergeValidationFailureSummary !== undefined) {
      state.mergeValidationFailureSummary = p.mergeValidationFailureSummary;
    }
    if (p.dispatchPausedReason !== undefined) {
      state.dispatchPausedReason = p.dispatchPausedReason;
    }
    if (p.selfImprovementRunInProgress !== undefined) {
      state.selfImprovementRunInProgress = p.selfImprovementRunInProgress;
    }
    sweepExpiredBaselineMergePause(state);
  },
  setSelfImprovementRunInProgress(state: ExecuteState, action: PayloadAction<boolean>) {
    state.selfImprovementRunInProgress = action.payload;
  },
};

export function addStatusExtraReducers(builder: ActionReducerMapBuilder<ExecuteState>): void {
  createAsyncHandlers("status", fetchExecuteStatus, builder, {
    ensureState: ensureAsync,
    onPending: (state) => {
      state.error = null;
    },
    onFulfilled: (state, action) => {
      const payload = action.payload as {
        activeTasks?: ActiveTaskInfo[];
        queueDepth?: number;
        awaitingApproval?: boolean;
        totalDone?: number;
        totalFailed?: number;
        baselineStatus?: BaselineRuntimeStatus;
        baselineCheckedAt?: string | null;
        baselineFailureSummary?: string | null;
        mergeValidationStatus?: MergeValidationRuntimeStatus;
        mergeValidationFailureSummary?: string | null;
        dispatchPausedReason?: string | null;
        selfImprovementRunInProgress?: boolean;
      };
      const activeTasks = payload.activeTasks ?? [];
      state.activeTasks = activeTasks;
      state.orchestratorRunning = activeTasks.length > 0 || (payload.queueDepth ?? 0) > 0;
      state.awaitingApproval = payload.awaitingApproval ?? false;
      state.totalDone = payload.totalDone ?? 0;
      state.totalFailed = payload.totalFailed ?? 0;
      state.queueDepth = payload.queueDepth ?? 0;
      if (payload.baselineStatus !== undefined) {
        state.baselineStatus = payload.baselineStatus;
      }
      if (payload.baselineCheckedAt !== undefined) {
        state.baselineCheckedAt = payload.baselineCheckedAt;
      }
      if (payload.baselineFailureSummary !== undefined) {
        state.baselineFailureSummary = payload.baselineFailureSummary;
      }
      if (payload.mergeValidationStatus !== undefined) {
        state.mergeValidationStatus = payload.mergeValidationStatus;
      }
      if (payload.mergeValidationFailureSummary !== undefined) {
        state.mergeValidationFailureSummary = payload.mergeValidationFailureSummary;
      }
      if (payload.dispatchPausedReason !== undefined) {
        state.dispatchPausedReason = payload.dispatchPausedReason;
      }
      if (payload.selfImprovementRunInProgress !== undefined) {
        state.selfImprovementRunInProgress = payload.selfImprovementRunInProgress;
      }
      sweepExpiredBaselineMergePause(state);
    },
    onRejected: (state, action) => {
      state.error = action.error?.message ?? "Failed to load execute status";
    },
    defaultError: "Failed to load execute status",
  });
}
