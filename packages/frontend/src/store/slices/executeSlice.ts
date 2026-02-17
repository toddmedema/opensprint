import { createSlice, createAsyncThunk, type PayloadAction } from "@reduxjs/toolkit";
import type { AgentSession, Task, KanbanColumn, Plan } from "@opensprint/shared";
import { api } from "../../api/client";
import { setPlansAndGraph } from "./planSlice";
import {
  filterAgentOutputChunk,
  resetAgentOutputFilter,
} from "../../utils/agentOutputFilter";

/** Task display shape for kanban (subset of Task) */
export type TaskCard = Pick<
  Task,
  "id" | "title" | "kanbanColumn" | "priority" | "assignee" | "epicId" | "testResults"
>;

export interface ExecuteState {
  tasks: Task[];
  plans: Plan[];
  orchestratorRunning: boolean;
  awaitingApproval: boolean;
  /** Task ID currently being worked on by orchestrator */
  currentTaskId: string | null;
  /** Sub-phase: coding or review */
  currentPhase: "coding" | "review" | null;
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
  unblockLoading: boolean;
  statusLoading: boolean;
  loading: boolean;
  error: string | null;
}

const initialState: ExecuteState = {
  tasks: [],
  plans: [],
  orchestratorRunning: false,
  awaitingApproval: false,
  currentTaskId: null,
  currentPhase: null,
  selectedTaskId: null,
  taskDetail: null,
  taskDetailLoading: false,
  agentOutput: [],
  completionState: null,
  archivedSessions: [],
  archivedLoading: false,
  markDoneLoading: false,
  unblockLoading: false,
  statusLoading: false,
  loading: false,
  error: null,
};

export const fetchTasks = createAsyncThunk("execute/fetchTasks", async (projectId: string) => {
  return api.tasks.list(projectId);
});

export const fetchExecutePlans = createAsyncThunk(
  "execute/fetchExecutePlans",
  async (projectId: string, { dispatch }) => {
    const graph = await api.plans.list(projectId);
    dispatch(setPlansAndGraph({ plans: graph.plans, dependencyGraph: graph }));
    return graph.plans;
  },
);

export const fetchExecuteStatus = createAsyncThunk(
  "execute/fetchExecuteStatus",
  async (projectId: string) => {
    return api.execute.status(projectId);
  },
);

export const fetchTaskDetail = createAsyncThunk(
  "execute/fetchTaskDetail",
  async ({ projectId, taskId }: { projectId: string; taskId: string }) => {
    return api.tasks.get(projectId, taskId);
  },
);

export const fetchArchivedSessions = createAsyncThunk(
  "execute/fetchArchivedSessions",
  async ({ projectId, taskId }: { projectId: string; taskId: string }) => {
    return (await api.tasks.sessions(projectId, taskId)) ?? [];
  },
);

export const markTaskDone = createAsyncThunk(
  "execute/markTaskDone",
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

export const unblockTask = createAsyncThunk(
  "execute/unblockTask",
  async (
    { projectId, taskId, resetAttempts }: { projectId: string; taskId: string; resetAttempts?: boolean },
    { dispatch },
  ) => {
    await api.tasks.unblock(projectId, taskId, { resetAttempts });
    const [tasksData, plansGraph] = await Promise.all([
      api.tasks.list(projectId),
      api.plans.list(projectId),
    ]);
    dispatch(setPlansAndGraph({ plans: plansGraph.plans, dependencyGraph: plansGraph }));
    return { tasks: tasksData ?? [], taskId };
  },
);

const MAX_AGENT_OUTPUT = 5000;

const executeSlice = createSlice({
  name: "execute",
  initialState,
  reducers: {
    setSelectedTaskId(state, action: PayloadAction<string | null>) {
      state.selectedTaskId = action.payload;
      state.completionState = null;
      state.archivedSessions = [];
      state.taskDetail = null;
      state.agentOutput = [];
      resetAgentOutputFilter();
    },
    appendAgentOutput(state, action: PayloadAction<{ taskId: string; chunk: string }>) {
      if (action.payload.taskId === state.selectedTaskId) {
        state.completionState = null;
        const filtered = filterAgentOutputChunk(action.payload.chunk);
        if (filtered) {
          state.agentOutput.push(filtered);
          if (state.agentOutput.length > MAX_AGENT_OUTPUT) {
            state.agentOutput = state.agentOutput.slice(-MAX_AGENT_OUTPUT);
          }
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
      if (state.taskDetail?.id === action.payload.taskId && action.payload.status !== undefined) {
        state.taskDetail.kanbanColumn = mapStatusToKanban(action.payload.status);
      }
    },
    setTasks(state, action: PayloadAction<Task[]>) {
      state.tasks = action.payload;
    },
    setExecuteError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setCurrentTaskAndPhase(
      state,
      action: PayloadAction<{ currentTaskId: string | null; currentPhase: "coding" | "review" | null }>,
    ) {
      state.currentTaskId = action.payload.currentTaskId;
      state.currentPhase = action.payload.currentPhase;
    },
    resetExecute() {
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
      // fetchExecutePlans
      .addCase(fetchExecutePlans.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchExecutePlans.fulfilled, (state, action) => {
        state.plans = action.payload;
        state.loading = false;
      })
      .addCase(fetchExecutePlans.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message ?? "Failed to load plans";
      })
      // fetchExecuteStatus
      .addCase(fetchExecuteStatus.pending, (state) => {
        state.statusLoading = true;
        state.error = null;
      })
      .addCase(fetchExecuteStatus.fulfilled, (state, action) => {
        state.orchestratorRunning = action.payload.currentTask !== null || action.payload.queueDepth > 0;
        state.awaitingApproval = action.payload.awaitingApproval ?? false;
        state.currentTaskId = action.payload.currentTask ?? null;
        state.currentPhase = action.payload.currentPhase ?? null;
        state.statusLoading = false;
      })
      .addCase(fetchExecuteStatus.rejected, (state, action) => {
        state.statusLoading = false;
        state.error = action.error.message ?? "Failed to load execute status";
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
      })
      // unblockTask
      .addCase(unblockTask.pending, (state) => {
        state.unblockLoading = true;
        state.error = null;
      })
      .addCase(unblockTask.fulfilled, (state, action) => {
        state.tasks = action.payload.tasks;
        state.taskDetail =
          state.taskDetail?.id === action.payload.taskId
            ? action.payload.tasks.find((t) => t.id === action.payload.taskId) ?? state.taskDetail
            : state.taskDetail;
        state.unblockLoading = false;
      })
      .addCase(unblockTask.rejected, (state, action) => {
        state.unblockLoading = false;
        state.error = action.error.message ?? "Failed to unblock";
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
    case "blocked":
      return "blocked";
    default:
      return "backlog";
  }
}

export const {
  setSelectedTaskId,
  appendAgentOutput,
  setOrchestratorRunning,
  setAwaitingApproval,
  setCurrentTaskAndPhase,
  setCompletionState,
  taskUpdated,
  setTasks,
  setExecuteError,
  resetExecute,
} = executeSlice.actions;
export default executeSlice.reducer;
