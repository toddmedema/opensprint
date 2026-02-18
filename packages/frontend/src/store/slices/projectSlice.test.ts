import { describe, it, expect, vi, beforeEach } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import projectReducer, {
  fetchProject,
  resetProject,
  type ProjectState,
} from "./projectSlice";
import type { Project } from "@opensprint/shared";

const mockProject: Project = {
  id: "proj-1",
  name: "Test Project",
  description: "A test project",
  repoPath: "/path/to/repo",
  currentPhase: "sketch",
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

vi.mock("../../api/client", () => ({
  api: {
    projects: {
      get: vi.fn(),
    },
  },
}));

import { api } from "../../api/client";

describe("projectSlice", () => {
  beforeEach(() => {
    vi.mocked(api.projects.get).mockReset();
  });

  describe("initial state", () => {
    it("has correct initial state", () => {
      const store = configureStore({ reducer: { project: projectReducer } });
      const state = store.getState().project as ProjectState;
      expect(state.data).toBeNull();
      expect(state.loading).toBe(false);
      expect(state.error).toBeNull();
    });
  });

  describe("resetProject", () => {
    it("resets state to initial values", () => {
      const store = configureStore({ reducer: { project: projectReducer } });
      store.dispatch({
        type: "project/fetch/fulfilled",
        payload: mockProject,
      });
      expect(store.getState().project.data).toEqual(mockProject);

      store.dispatch(resetProject());
      const state = store.getState().project as ProjectState;
      expect(state.data).toBeNull();
      expect(state.loading).toBe(false);
      expect(state.error).toBeNull();
    });
  });

  describe("fetchProject thunk", () => {
    it("sets loading true and clears error on pending", async () => {
      let resolveApi: (v: Project) => void;
      const apiPromise = new Promise<Project>((r) => {
        resolveApi = r;
      });
      vi.mocked(api.projects.get).mockReturnValue(apiPromise as never);
      const store = configureStore({ reducer: { project: projectReducer } });
      const dispatchPromise = store.dispatch(fetchProject("proj-1"));

      const state = store.getState().project as ProjectState;
      expect(state.loading).toBe(true);
      expect(state.error).toBeNull();
      expect(state.data).toBeNull();

      resolveApi!(mockProject);
      await dispatchPromise;
    });

    it("stores project and clears loading on fulfilled", async () => {
      vi.mocked(api.projects.get).mockResolvedValue(mockProject);
      const store = configureStore({ reducer: { project: projectReducer } });
      await store.dispatch(fetchProject("proj-1"));

      const state = store.getState().project as ProjectState;
      expect(state.data).toEqual(mockProject);
      expect(state.loading).toBe(false);
      expect(state.error).toBeNull();
    });

    it("calls api.projects.get with projectId", async () => {
      vi.mocked(api.projects.get).mockResolvedValue(mockProject);
      const store = configureStore({ reducer: { project: projectReducer } });
      await store.dispatch(fetchProject("proj-abc-123"));

      expect(api.projects.get).toHaveBeenCalledWith("proj-abc-123");
    });

    it("sets error and clears loading on rejected", async () => {
      vi.mocked(api.projects.get).mockRejectedValue(new Error("Network error"));
      const store = configureStore({ reducer: { project: projectReducer } });
      await store.dispatch(fetchProject("proj-1"));

      const state = store.getState().project as ProjectState;
      expect(state.loading).toBe(false);
      expect(state.error).toBe("Network error");
      expect(state.data).toBeNull();
    });

    it("uses fallback error message when error has no message", async () => {
      vi.mocked(api.projects.get).mockRejectedValue(new Error());
      const store = configureStore({ reducer: { project: projectReducer } });
      await store.dispatch(fetchProject("proj-1"));

      const state = store.getState().project as ProjectState;
      expect(state.error).toBe("Failed to load project");
    });
  });
});
