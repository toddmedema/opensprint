import { describe, it, expect, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { configureStore } from "@reduxjs/toolkit";
import { rootReducer } from "./index";
import { transientReducer, serverStateMiddleware } from "./serverState";
import executeReducer, {
  setTasks,
  appendAgentOutput,
  setSelectedTaskId,
} from "./slices/executeSlice";
import { fetchTasks } from "./slices/executeThunks";
import { setQueryClient } from "../queryClient";
import { queryKeys } from "../api/queryKeys";
import type { Task } from "@opensprint/shared";
describe("application server-state ownership", () => {
  const task = {
    id: "task",
    title: "Canonical task",
    status: "open",
    kanbanColumn: "ready",
    priority: 2,
  } as Task;
  it("keeps task objects only in Query while preserving local selection and output", () => {
    const qc = new QueryClient();
    setQueryClient(qc);
    qc.setQueryData(queryKeys.tasks.list("A"), [task]);
    let state = rootReducer(undefined, { type: "init" });
    state = rootReducer(state, setTasks([task]));
    state = rootReducer(state, setSelectedTaskId("task"));
    state = rootReducer(state, appendAgentOutput({ taskId: "task", chunk: "live output" }));
    expect(state.execute.tasksById).toEqual({});
    expect(state.execute.taskIdsOrder).toEqual([]);
    expect(state.execute.selectedTaskId).toBe("task");
    expect(state.execute.agentOutput.task).toContain("live output");
    expect(qc.getQueryData(queryKeys.tasks.list("A"))).toEqual([task]);
    qc.clear();
  });
  it("refreshes the authoritative cache after a legacy thunk without accepting its stale server snapshot", () => {
    const qc = new QueryClient();
    setQueryClient(qc);
    qc.setQueryData(queryKeys.tasks.list("A"), [task]);
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const store = configureStore({
      reducer: { execute: transientReducer(executeReducer, ["tasksById", "taskIdsOrder"]) },
      middleware: (getDefault) => getDefault().concat(serverStateMiddleware),
    });
    store.dispatch(fetchTasks.fulfilled([{ ...task, title: "Old snapshot" }], "old-request", "A"));
    expect(store.getState().execute.tasksById).toEqual({});
    expect(qc.getQueryData(queryKeys.tasks.list("A"))).toEqual([task]);
    expect(invalidate).toHaveBeenCalled();
    qc.clear();
  });
});
