import { createListenerMiddleware, isFulfilled } from "@reduxjs/toolkit";
import { planTasks, generateTasksForPlan } from "../slices/planSlice";
import { fetchTasks } from "../slices/executeSlice";

/**
 * When plan tasks are created (planTasks or generateTasksForPlan), refresh the global
 * task store so plan cards and Execute phase show the new tasks in real time.
 * Plan cards use selectTasksForEpic from execute slice; without this refresh,
 * they would not update until a manual refresh or websocket plan.updated.
 */
export const planTasksListener = createListenerMiddleware();

planTasksListener.startListening({
  predicate: (action): action is ReturnType<typeof planTasks.fulfilled> =>
    isFulfilled(action) && planTasks.fulfilled.match(action),
  effect: (action, listenerApi) => {
    const { projectId } = action.meta.arg;
    listenerApi.dispatch(fetchTasks(projectId));
  },
});

planTasksListener.startListening({
  predicate: (action): action is ReturnType<typeof generateTasksForPlan.fulfilled> =>
    isFulfilled(action) && generateTasksForPlan.fulfilled.match(action),
  effect: (action, listenerApi) => {
    const { projectId } = action.meta.arg;
    listenerApi.dispatch(fetchTasks(projectId));
  },
});
