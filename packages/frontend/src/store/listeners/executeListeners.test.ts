import { describe, it, expect, vi, beforeEach } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import executeReducer from "../slices/executeSlice";
import projectReducer from "../slices/projectSlice";
import websocketReducer from "../slices/websocketSlice";
import { executeListeners } from "./executeListeners";
import { updateTaskPriority, updateTaskAssignee } from "../slices/executeSlice";
import { getQueryClient } from "../../queryClient";
import { queryKeys } from "../../api/queryKeys";

vi.mock("../../queryClient", () => ({
  getQueryClient: vi.fn(),
}));

function createStore() {
  return configureStore({
    reducer: {
      execute: executeReducer,
      project: projectReducer,
      websocket: websocketReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().prepend(executeListeners.middleware),
  });
}

describe("executeListeners", () => {
  const mockSetQueryData = vi.fn();
  const mockInvalidateQueries = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.mocked(getQueryClient).mockReturnValue({
      setQueryData: mockSetQueryData,
      invalidateQueries: mockInvalidateQueries,
    } as never);
    mockSetQueryData.mockClear();
    mockInvalidateQueries.mockClear();
  });

  it("updates task detail cache in place and does NOT invalidate tasks list when updateTaskPriority.fulfilled", () => {
    const store = createStore();
    const task = {
      id: "task-1",
      title: "Test task",
      priority: 0,
      kanbanColumn: "ready" as const,
      type: "task" as const,
      status: "open" as const,
      description: "",
      assignee: null,
      labels: [],
      dependencies: [],
      epicId: null,
      createdAt: "",
      updatedAt: "",
      startedAt: null,
      completedAt: null,
    };

    store.dispatch(
      updateTaskPriority.fulfilled(
        { task, taskId: "task-1" },
        "",
        { projectId: "proj-1", taskId: "task-1", priority: 0, previousPriority: 1 }
      )
    );

    expect(mockSetQueryData).toHaveBeenCalledWith(
      queryKeys.tasks.detail("proj-1", "task-1"),
      task
    );
    // Must NOT invalidate tasks list — that triggers refetch → setTasks → full Redux replace → sidebar flicker
    expect(mockInvalidateQueries).not.toHaveBeenCalled();
  });

  it("does not invalidate task detail query (avoids sidebar reload)", () => {
    const store = createStore();
    const task = {
      id: "task-2",
      title: "Another task",
      priority: 2,
      kanbanColumn: "in_line" as const,
      type: "task" as const,
      status: "open" as const,
      description: "",
      assignee: null,
      labels: [],
      dependencies: [],
      epicId: null,
      createdAt: "",
      updatedAt: "",
      startedAt: null,
      completedAt: null,
    };

    store.dispatch(
      updateTaskPriority.fulfilled(
        { task, taskId: "task-2" },
        "",
        { projectId: "proj-2", taskId: "task-2", priority: 2, previousPriority: 1 }
      )
    );

    const invalidateCalls = mockInvalidateQueries.mock.calls;
    const taskDetailInvalidated = invalidateCalls.some(
      (call) =>
        Array.isArray(call[0]?.queryKey) &&
        call[0].queryKey[0] === "tasks" &&
        call[0].queryKey[1] === "proj-2" &&
        call[0].queryKey[2] === "task-2"
    );
    expect(taskDetailInvalidated).toBe(false);
  });

  it("updates task detail cache and invalidates tasks list when updateTaskAssignee.fulfilled", () => {
    const store = createStore();
    const task = {
      id: "task-1",
      title: "Test task",
      priority: 1,
      assignee: "Alice",
      kanbanColumn: "ready" as const,
      type: "task" as const,
      status: "open" as const,
      description: "",
      labels: [],
      dependencies: [],
      epicId: null,
      createdAt: "",
      updatedAt: "",
      startedAt: null,
      completedAt: null,
    };

    store.dispatch(
      updateTaskAssignee.fulfilled(
        { task, taskId: "task-1" },
        "",
        { projectId: "proj-1", taskId: "task-1", assignee: "Alice" }
      )
    );

    expect(mockSetQueryData).toHaveBeenCalledWith(
      queryKeys.tasks.detail("proj-1", "task-1"),
      task
    );
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.tasks.list("proj-1"),
    });
  });
});
