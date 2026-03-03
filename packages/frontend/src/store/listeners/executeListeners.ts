import { createListenerMiddleware, isFulfilled } from "@reduxjs/toolkit";
import { updateTaskPriority } from "../slices/executeSlice";
import { getQueryClient } from "../../queryClient";
import { queryKeys } from "../../api/queryKeys";

/**
 * When priority update succeeds:
 * - Update task detail cache in place (do NOT invalidate) so the sidebar does not
 *   refetch and show loading state. Only the priority component re-renders.
 * - Do NOT invalidate the tasks list: that triggers a refetch → setTasks → full Redux
 *   replace → ExecutePhase cascade re-renders and sidebar flicker. Redux is already
 *   updated in place by updateTaskPriority.fulfilled; list order will sync on next
 *   natural refetch (e.g. websocket, navigation).
 */
export const executeListeners = createListenerMiddleware();

executeListeners.startListening({
  predicate: (action): action is ReturnType<typeof updateTaskPriority.fulfilled> =>
    isFulfilled(action) && updateTaskPriority.fulfilled.match(action),
  effect: (action) => {
    try {
      const qc = getQueryClient();
      const { task, taskId } = action.payload;
      const projectId = action.meta.arg.projectId;
      qc.setQueryData(queryKeys.tasks.detail(projectId, taskId), task);
    } catch {
      // QueryClient may not be set in tests
    }
  },
});
