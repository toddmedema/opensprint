import { createSlice, createAsyncThunk, type PayloadAction } from "@reduxjs/toolkit";
import type { AgentSession, Task, Plan, KanbanColumn } from "@opensprint/shared";
import { api } from "../../api/client";

interface TaskCard {
  id: string;
  title: string;
  kanbanColumn: KanbanColumn;
  priority: number;
  assignee: string | null;
  epicId: string | null;
  testResults?: { passed: number; failed: number; skipped: number; total: number } | null;
}

export interface BuildState {
  tasks: TaskCard[];
  plans: Plan[];
  orchestratorRunning: boolean;
  awaitingApproval: boolean;
  selectedTaskId: string | null;
  taskDetail: Task | null;
  taskDetailLoading: boolean;
  agentOutput: string[];
  completionState: {
    status: string;
    testResults: { passed: number; failed: number; skipped: number; total: number } | null;
  } | null;
  archivedSessions: AgentSession[];
  archivedLoading: boolean;
  markCompleteLoading: boolean;
  loading: boolean;
  error: string | null;
}

const initialState: BuildState = {
  tasks: [],
  plans: [],
  orchestratorRunning: false,
  awaitingApproval: false,
  selectedTaskId: null,
  taskDetail: null,
  taskDetailLoading: false,
  agentOutput: [],
  completionState: null,
  archivedSessions: [],
  archivedLoading: false,
  markCompleteLoading: false,
  loading: false,
  error: null,
};

export const fetchTasks = createAsyncThunk("build/fetchTasks", async (projectId: string) => {
  return (await api.tasks.list(projectId)) as TaskCard[];
});

export const fetchBuildPlans = createAsyncThunk("build/fetchPlans", async (projectId: string) => {
  return (await api.plans.list(projectId)) as Plan[];
});

export const fetchBuildStatus = createAsyncThunk("build/fetchStatus", async (projectId: string) => {
  return (await api.build.status(projectId)) as { running: boolean };
});

export const fetchTaskDetail = createAsyncThunk(
  "build/fetchTaskDetail",
  async ({ projectId, taskId }: { projectId: string; taskId: string }) => {
    return (await api.tasks.get(projectId, taskId)) as Task;
  },
);

export const fetchArchivedSessions = createAsyncThunk(
  "build/fetchArchivedSessions",
  async ({ projectId, taskId }: { projectId: string; taskId: string }) => {
    return ((await api.tasks.sessions(projectId, taskId)) as AgentSession[]) ?? [];
  },
);

export const startBuild = createAsyncThunk("build/start", async (projectId: string) => {
  await api.build.start(projectId);
});

export const pauseBuild = createAsyncThunk("build/pause", async (projectId: string) => {
  await api.build.pause(projectId);
});

export const markTaskComplete = createAsyncThunk(
  "build/markTaskComplete",
  async ({ projectId, taskId }: { projectId: string; taskId: string }) => {
    await api.tasks.markComplete(projectId, taskId);
    const [tasksData, plansData] = await Promise.all([api.tasks.list(projectId), api.plans.list(projectId)]);
    return {
      tasks: (tasksData as TaskCard[]) ?? [],
      plans: (plansData as Plan[]) ?? [],
    };
  },
);

const MAX_AGENT_OUTPUT = 5000;

const buildSlice = createSlice({
  name: "build",
  initialState,
  reducers: {
    setSelectedTaskId(state, action: PayloadAction<string | null>) {
      state.selectedTaskId = action.payload;
      state.completionState = null;
      state.archivedSessions = [];
      state.taskDetail = null;
      state.agentOutput = [];
    },
    appendAgentOutput(state, action: PayloadAction<{ taskId: string; chunk: string }>) {
      if (action.payload.taskId === state.selectedTaskId) {
        state.completionState = null;
        state.agentOutput.push(action.payload.chunk);
        if (state.agentOutput.length > MAX_AGENT_OUTPUT) {
          state.agentOutput = state.agentOutput.slice(-MAX_AGENT_OUTPUT);
        }
      }
    },
    setOrchestratorRunning(state, action: PayloadAction<boolean>) {
      state.orchestratorRunning = action.payload;
    },
    setAwaitingApproval(state, action: PayloadAction<boolean>) {
      state.awaitingApproval = action.payload;
    },
    setCompletionState(
      state,
      action: PayloadAction<{
        taskId: string;
        status: string;
        testResults: { passed: number; failed: number; skipped: number; total: number } | null;
      }>,
    ) {
      if (action.payload.taskId === state.selectedTaskId) {
        state.completionState = {
          status: action.payload.status,
          testResults: action.payload.testResults,
        };
      }
    },
    setTasks(state, action: PayloadAction<TaskCard[]>) {
      state.tasks = action.payload;
    },
    setBuildError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    resetBuild() {
      return initialState;
    },
  },
  extraReducers: (builder) => {
    builder
      // fetchTasks
      .addCase(fetchTasks.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchTasks.fulfilled, (state, action) => {
        state.tasks = action.payload;
        state.loading = false;
      })
      .addCase(fetchTasks.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message ?? "Failed to load tasks";
      })
      // fetchBuildPlans
      .addCase(fetchBuildPlans.fulfilled, (state, action) => {
        state.plans = action.payload;
      })
      // fetchBuildStatus
      .addCase(fetchBuildStatus.fulfilled, (state, action) => {
        state.orchestratorRunning = action.payload?.running ?? false;
      })
      // fetchTaskDetail
      .addCase(fetchTaskDetail.pending, (state) => {
        state.taskDetailLoading = true;
      })
      .addCase(fetchTaskDetail.fulfilled, (state, action) => {
        state.taskDetail = action.payload;
        state.taskDetailLoading = false;
      })
      .addCase(fetchTaskDetail.rejected, (state) => {
        state.taskDetail = null;
        state.taskDetailLoading = false;
      })
      // fetchArchivedSessions
      .addCase(fetchArchivedSessions.pending, (state) => {
        state.archivedLoading = true;
      })
      .addCase(fetchArchivedSessions.fulfilled, (state, action) => {
        state.archivedSessions = action.payload;
        state.archivedLoading = false;
      })
      .addCase(fetchArchivedSessions.rejected, (state) => {
        state.archivedSessions = [];
        state.archivedLoading = false;
      })
      // startBuild
      .addCase(startBuild.fulfilled, (state) => {
        state.orchestratorRunning = true;
      })
      .addCase(startBuild.rejected, (state, action) => {
        state.error = action.error.message ?? "Failed to start build";
      })
      // pauseBuild
      .addCase(pauseBuild.fulfilled, (state) => {
        state.orchestratorRunning = false;
      })
      .addCase(pauseBuild.rejected, (state, action) => {
        state.error = action.error.message ?? "Failed to pause build";
      })
      // markTaskComplete
      .addCase(markTaskComplete.pending, (state) => {
        state.markCompleteLoading = true;
        state.error = null;
      })
      .addCase(markTaskComplete.fulfilled, (state, action) => {
        state.tasks = action.payload.tasks;
        state.plans = action.payload.plans;
        state.markCompleteLoading = false;
      })
      .addCase(markTaskComplete.rejected, (state, action) => {
        state.markCompleteLoading = false;
        state.error = action.error.message ?? "Failed to mark complete";
      });
  },
});

export const {
  setSelectedTaskId,
  appendAgentOutput,
  setOrchestratorRunning,
  setAwaitingApproval,
  setCompletionState,
  setTasks,
  setBuildError,
  resetBuild,
} = buildSlice.actions;
export default buildSlice.reducer;
