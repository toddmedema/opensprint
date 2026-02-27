import { describe, it, expect, vi, beforeEach } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import projectReducer, {
  fetchProject,
  fetchTasksFeedbackPlans,
  resetProject,
  type ProjectState,
} from "./projectSlice";
import planReducer from "./planSlice";
import executeReducer from "./executeSlice";
import evalReducer from "./evalSlice";
import type { Project, Task, FeedbackItem, PlanDependencyGraph } from "@opensprint/shared";

const mockProject: Project = {
  id: "proj-1",
  name: "Test Project",
  repoPath: "/path/to/repo",
  currentPhase: "sketch",
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

vi.mock("../../api/client", () => ({
  api: {
    projects: { get: vi.fn() },
    tasks: { list: vi.fn() },
    feedback: { list: vi.fn() },
    plans: { list: vi.fn() },
  },
}));

import { api } from "../../api/client";

function createFullStore() {
  return configureStore({
    reducer: {
      project: projectReducer,
      plan: planReducer,
      execute: executeReducer,
      eval: evalReducer,
    },
  });
}

describe("projectSlice", () => {
  beforeEach(() => {
    vi.mocked(api.projects.get).mockReset();
    vi.mocked(api.tasks.list).mockReset();
    vi.mocked(api.feedback.list).mockReset();
    vi.mocked(api.plans.list).mockReset();
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

  describe("fetchTasksFeedbackPlans thunk", () => {
    const mockTasks: Task[] = [
      {
        id: "task-1",
        title: "Task 1",
        description: "",
        type: "task",
        status: "open",
        priority: 1,
        assignee: null,
        labels: [],
        dependencies: [],
        epicId: null,
        kanbanColumn: "backlog",
        createdAt: "",
        updatedAt: "",
      },
    ];
    const mockFeedback: FeedbackItem[] = [
      {
        id: "fb-1",
        text: "Bug report",
        category: "bug",
        mappedPlanId: null,
        createdTaskIds: [],
        status: "pending",
        createdAt: "",
      },
    ];
    const mockPlansGraph: PlanDependencyGraph = { plans: [], edges: [] };

    it("issues three distinct API calls for tasks, feedback, plans concurrently", async () => {
      vi.mocked(api.tasks.list).mockResolvedValue(mockTasks);
      vi.mocked(api.feedback.list).mockResolvedValue(mockFeedback);
      vi.mocked(api.plans.list).mockResolvedValue(mockPlansGraph);

      const store = createFullStore();
      await store.dispatch(fetchTasksFeedbackPlans("proj-1"));

      expect(api.tasks.list).toHaveBeenCalledWith("proj-1");
      expect(api.feedback.list).toHaveBeenCalledWith("proj-1");
      expect(api.plans.list).toHaveBeenCalledWith("proj-1");
      expect(api.tasks.list).toHaveBeenCalledTimes(1);
      expect(api.feedback.list).toHaveBeenCalledTimes(1);
      expect(api.plans.list).toHaveBeenCalledTimes(1);
    });

    it("hydrates execute, eval, and plan slices when all three responses are available", async () => {
      vi.mocked(api.tasks.list).mockResolvedValue(mockTasks);
      vi.mocked(api.feedback.list).mockResolvedValue(mockFeedback);
      vi.mocked(api.plans.list).mockResolvedValue(mockPlansGraph);

      const store = createFullStore();
      await store.dispatch(fetchTasksFeedbackPlans("proj-1"));

      expect(store.getState().execute.tasksById["task-1"]).toEqual(mockTasks[0]);
      expect(store.getState().eval.feedback).toEqual(mockFeedback);
      expect(store.getState().plan.plans).toEqual([]);
      expect(store.getState().plan.dependencyGraph).toEqual(mockPlansGraph);
    });

    it("does not pass pagination params (no limit/offset)", async () => {
      vi.mocked(api.tasks.list).mockResolvedValue([]);
      vi.mocked(api.feedback.list).mockResolvedValue([]);
      vi.mocked(api.plans.list).mockResolvedValue({ plans: [], edges: [] });

      const store = createFullStore();
      await store.dispatch(fetchTasksFeedbackPlans("proj-1"));

      expect(api.tasks.list).toHaveBeenCalledWith("proj-1");
      expect(api.feedback.list).toHaveBeenCalledWith("proj-1");
      expect(api.plans.list).toHaveBeenCalledWith("proj-1");
    });
  });
});
