import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import type { Project, Task, FeedbackItem, PlanDependencyGraph } from "@opensprint/shared";
import { api } from "../../api/client";
import { setTasks } from "./executeSlice";
import { setFeedback } from "./evalSlice";
import { setPlansAndGraph } from "./planSlice";

export interface ProjectState {
  data: Project | null;
  loading: boolean;
  error: string | null;
}

const initialState: ProjectState = {
  data: null,
  loading: false,
  error: null,
};

export const fetchProject = createAsyncThunk("project/fetch", async (projectId: string) => {
  return api.projects.get(projectId);
});

/** Fetches tasks, feedback, and plans in parallel. UI hydrates when all three responses are available. No pagination. */
export const fetchTasksFeedbackPlans = createAsyncThunk<
  { tasks: Task[]; feedback: FeedbackItem[]; plansGraph: PlanDependencyGraph },
  string
>("project/fetchTasksFeedbackPlans", async (projectId, { dispatch }) => {
  const [tasksData, feedback, plansGraph] = await Promise.all([
    api.tasks.list(projectId),
    api.feedback.list(projectId),
    api.plans.list(projectId),
  ]);
  const tasks = Array.isArray(tasksData)
    ? tasksData
    : (tasksData as { items: Task[] })?.items ?? [];
  dispatch(setTasks(tasks));
  dispatch(setFeedback(feedback));
  dispatch(setPlansAndGraph({ plans: plansGraph.plans, dependencyGraph: plansGraph }));
  return { tasks, feedback, plansGraph };
});

const projectSlice = createSlice({
  name: "project",
  initialState,
  reducers: {
    resetProject() {
      return initialState;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchProject.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchProject.fulfilled, (state, action) => {
        state.data = action.payload;
        state.loading = false;
      })
      .addCase(fetchProject.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message || "Failed to load project";
      });
  },
});

export const { resetProject } = projectSlice.actions;
export default projectSlice.reducer;
