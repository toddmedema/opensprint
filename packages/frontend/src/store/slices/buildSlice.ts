import { createSlice, createAsyncThunk, type PayloadAction } from "@reduxjs/toolkit";
import type { AgentSession, Task, KanbanColumn, Plan } from "@opensprint/shared";
import { api } from "../../api/client";
import { setPlansAndGraph } from "./planSlice";

/** Task display shape for kanban (subset of Task) */
export type TaskCard = Pick<
  Task,
  "id" | "title" | "kanbanColumn" | "priority" | "assignee" | "epicId" | "testResults"
>;

export interface BuildState {
  tasks: Task[];
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
  markDoneLoading: boolean;
  statusLoading: boolean;
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
  markDoneLoading: false,
  statusLoading: false,
  loading: false,
  error: null,
};

export const fetchTasks = createAsyncThunk("build/fetchTasks", async (projectId: string) => {
  return api.tasks.list(projectId);
});

export const fetchBuildPlans = createAsyncThunk(
  "build/fetchBuildPlans",
  async (projectId: string, { dispatch }) => {
    const graph = await api.plans.list(projectId);
    dispatch(setPlansAndGraph({ plans: graph.plans, dependencyGraph: graph }));
    return graph.plans;
  },
);

export const fetchBuildStatus = createAsyncThunk(
  "build/fetchBuildStatus",
  async (projectId: string) => {
    return api.build.status(projectId);
  },
);

export const fetchTaskDetail = createAsyncThunk(
  "build/fetchTaskDetail",
  async ({ projectId, taskId }: { projectId: string; taskId: string }) => {
    return api.tasks.get(projectId, taskId);
  },
);

export const fetchArchivedSessions = createAsyncThunk(
  "build/fetchArchivedSessions",
  async ({ projectId, taskId }: { projectId: string; taskId: string }) => {
    return (await api.tasks.sessions(projectId, taskId)) ?? [];
  },
);

export const markTaskDone = createAsyncThunk(
  "build/markTaskDone",
  async ({ projectId, taskId }: { projectId: string; taskId: string }, { dispatch }) => {
    await api.tasks.markDone(projectId, taskId);
    const [tasksData, plansGraph] = await Promise.all([
      api.tasks.list(projectId),
      api.plans.list(projectId),
    ]);
    dispatch(setPlansAndGraph({ plans: plansGraph.plans, dependencyGraph: plansGraph }));
    return { tasks: tasksData ?? [] };
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
    taskUpdated(
      state,
      action: PayloadAction<{ taskId: string; status?: string; assignee?: string | null }>,
    ) {
      const task = state.tasks.find((t) => t.id === action.payload.taskId);
      if (task) {
        if (action.payload.status !== undefined) {
          task.kanbanColumn = mapStatusToKanban(action.payload.status);
        }
        if (action.payload.assignee !== undefined) {
          task.assignee = action.payload.assignee;
        }
      }
    },
    setTasks(state, action: PayloadAction<Task[]>) {
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
      .addCase(fetchBuildPlans.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchBuildPlans.fulfilled, (state, action) => {
        state.plans = action.payload;
        state.loading = false;
      })
      .addCase(fetchBuildPlans.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message ?? "Failed to load plans";
      })
      // fetchBuildStatus
      .addCase(fetchBuildStatus.pending, (state) => {
        state.statusLoading = true;
        state.error = null;
      })
      .addCase(fetchBuildStatus.fulfilled, (state, action) => {
        state.orchestratorRunning = action.payload.currentTask !== null || action.payload.queueDepth > 0;
        state.awaitingApproval = action.payload.awaitingApproval ?? false;
        state.statusLoading = false;
      })
      .addCase(fetchBuildStatus.rejected, (state, action) => {
        state.statusLoading = false;
        state.error = action.error.message ?? "Failed to load build status";
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
      // markTaskDone
      .addCase(markTaskDone.pending, (state) => {
        state.markDoneLoading = true;
        state.error = null;
      })
      .addCase(markTaskDone.fulfilled, (state, action) => {
        state.tasks = action.payload.tasks;
        state.markDoneLoading = false;
      })
      .addCase(markTaskDone.rejected, (state, action) => {
        state.markDoneLoading = false;
        state.error = action.error.message ?? "Failed to mark done";
      });
  },
});

function mapStatusToKanban(status: string): KanbanColumn {
  switch (status) {
    case "open":
      return "backlog";
    case "in_progress":
      return "in_progress";
    case "closed":
      return "done";
    default:
      return "backlog";
  }
}

export const {
  setSelectedTaskId,
  appendAgentOutput,
  setOrchestratorRunning,
  setAwaitingApproval,
  setCompletionState,
  taskUpdated,
  setTasks,
  setBuildError,
  resetBuild,
} = buildSlice.actions;
export default buildSlice.reducer;
