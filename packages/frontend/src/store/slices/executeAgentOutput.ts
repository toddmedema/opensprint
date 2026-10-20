import type { PayloadAction } from "@reduxjs/toolkit";
import type { ActionReducerMapBuilder } from "@reduxjs/toolkit";
import type { AgentSession } from "@opensprint/shared";
import type { ExecuteState } from "./executeTypes";
import { MAX_AGENT_OUTPUT } from "./executeTypes";
import { fetchArchivedSessions, fetchLiveOutputBackfill, ensureAsync } from "./executeThunks";
import { filterAgentOutput } from "../../utils/agentOutputFilter";
import { createAsyncHandlers } from "../asyncHelpers";

function touchAgentOutputLastReceived(state: ExecuteState, taskId: string): void {
  if (!state.agentOutputLastReceivedAt) state.agentOutputLastReceivedAt = {};
  state.agentOutputLastReceivedAt[taskId] = new Date().toISOString();
}

export const agentOutputReducers = {
  setSelectedTaskId(state: ExecuteState, action: PayloadAction<string | null>) {
    ensureAsync(state);
    if (!state.agentOutput) state.agentOutput = {};
    const next = action.payload;
    const prev = state.selectedTaskId;
    const changed = prev !== next;
    state.selectedTaskId = next;
    state.archivedSessions = [];
    if (changed) state.async.taskDetail.error = null;
    if (changed && prev) {
      delete state.agentOutput[prev];
      if (state.agentOutputLastReceivedAt?.[prev]) {
        delete state.agentOutputLastReceivedAt[prev];
      }
    }
  },
  appendAgentOutput(
    state: ExecuteState,
    action: PayloadAction<{ taskId: string; chunk: string; preserveCompletion?: boolean }>
  ) {
    if (!state.agentOutput) state.agentOutput = {};
    const { taskId, chunk, preserveCompletion } = action.payload;
    if (chunk) {
      if (!state.agentOutput[taskId]) {
        state.agentOutput[taskId] = [];
      }
      state.agentOutput[taskId].push(chunk);
      touchAgentOutputLastReceived(state, taskId);
      if (state.agentOutput[taskId].length > MAX_AGENT_OUTPUT) {
        state.agentOutput[taskId] = state.agentOutput[taskId].slice(-MAX_AGENT_OUTPUT);
      }
    }
    if (taskId === state.selectedTaskId && !preserveCompletion) {
      delete state.completionStateByTaskId[taskId];
    }
  },
  /** Replace agent output for a task (e.g. backfill on subscribe). */
  setAgentOutputBackfill(
    state: ExecuteState,
    action: PayloadAction<{ taskId: string; output: string }>
  ) {
    if (!state.agentOutput) state.agentOutput = {};
    const { taskId, output } = action.payload;
    if (output.length > 0) {
      state.agentOutput[taskId] = [output];
      touchAgentOutputLastReceived(state, taskId);
    }
  },
  setCompletionState(
    state: ExecuteState,
    action: PayloadAction<{
      taskId: string;
      status: string;
      testResults: { passed: number; failed: number; skipped: number; total: number } | null;
      reason?: string | null;
    }>
  ) {
    if (!state.completionStateByTaskId) state.completionStateByTaskId = {};
    state.completionStateByTaskId[action.payload.taskId] = {
      status: action.payload.status,
      testResults: action.payload.testResults,
      reason: action.payload.reason ?? null,
    };
  },
  /** Sync from TanStack Query useArchivedSessions. */
  setArchivedSessions(state: ExecuteState, action: PayloadAction<AgentSession[]>) {
    state.archivedSessions = action.payload;
  },
};

export function addAgentOutputExtraReducers(builder: ActionReducerMapBuilder<ExecuteState>): void {
  createAsyncHandlers("archived", fetchArchivedSessions, builder, {
    ensureState: ensureAsync,
    onFulfilled: (state, action) => {
      state.archivedSessions = action.payload as AgentSession[];
    },
    onRejected: (state) => {
      state.archivedSessions = [];
    },
  });

  builder.addCase(fetchLiveOutputBackfill.fulfilled, (state, action) => {
    if (!state.agentOutput) state.agentOutput = {};
    const taskId = action.payload.taskId;
    const filtered = filterAgentOutput(action.payload.output ?? "");
    // Skip stale backfills that would rewind state behind live chunks
    const current = state.agentOutput[taskId];
    if (current) {
      const currentLen = current.reduce((sum, c) => sum + c.length, 0);
      if (currentLen > filtered.length) return;
    }
    state.agentOutput[taskId] = [filtered];
    if (filtered.length > 0) {
      touchAgentOutputLastReceived(state, taskId);
    }
  });
}
