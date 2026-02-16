import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import type { Project } from "@opensprint/shared";
import { api } from "../../api/client";

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
  return (await api.projects.get(projectId)) as Project;
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
        state.error = action.error.message ?? "Failed to load project";
      });
  },
});

export const { resetProject } = projectSlice.actions;
export default projectSlice.reducer;
