import { createSlice } from "@reduxjs/toolkit";
import type { ProjectPhase } from "@opensprint/shared";

export interface RouteState {
  /** Currently viewed project ID, or null when on home/settings/help or no project. */
  projectId: string | null;
  /** Active phase when on a phase route (plan | sketch | execute | eval | deliver), or null when on home, settings, or help. */
  phase: ProjectPhase | null;
}

const initialState: RouteState = {
  projectId: null,
  phase: null,
};

export const routeSlice = createSlice({
  name: "route",
  initialState,
  reducers: {
    /** Sync current project and phase from the router (e.g. from ProjectShell). */
    setRoute(
      state,
      action: {
        payload: { projectId: string | null; phase: ProjectPhase | null };
      }
    ) {
      state.projectId = action.payload.projectId;
      state.phase = action.payload.phase;
    },
  },
});

export const { setRoute } = routeSlice.actions;
export default routeSlice.reducer;
