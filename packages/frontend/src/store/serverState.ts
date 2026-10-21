import type { Middleware, Reducer, UnknownAction } from "@reduxjs/toolkit";
import { getQueryClient } from "../queryClient";
import { queryKeys } from "../api/queryKeys";
import type { Notification, FeedbackItem } from "@opensprint/shared";

/** Legacy action names remain compatible; the application store retains only their UI fields. */
export function transientReducer<S>(reducer: Reducer<S>, fields: (keyof S)[]): Reducer<S> {
  const empty = reducer(undefined, { type: "@@server-state/empty" });
  return (state, action) => {
    const next = reducer(state, action);
    if (!fields.some((field) => next[field] !== empty[field])) return next;
    const ui = { ...next };
    for (const field of fields) ui[field] = empty[field];
    return ui;
  };
}

/** Legacy async commands notify the sole server cache; their replies never become a Redux cache. */
export const serverStateMiddleware: Middleware = () => (next) => (action) => {
  const result = next(action);
  const event = action as UnknownAction & { meta?: { arg?: unknown }; payload?: unknown };
  if (typeof event.type !== "string") return result;
  try {
    const qc = getQueryClient();
    if (
      /^eval\/(submitFeedback|resolveFeedback|cancelFeedback|recategorizeFeedback)\/fulfilled$/.test(
        event.type
      )
    ) {
      const item = event.payload as FeedbackItem;
      const arg = event.meta?.arg as { projectId?: string } | undefined;
      if (item?.id && arg?.projectId)
        qc.setQueryData<FeedbackItem[]>(queryKeys.feedback.list(arg.projectId), (old) => [
          ...(old ?? []).filter((existing) => existing.id !== item.id),
          item,
        ]);
    }
    if (
      event.type.endsWith("/fulfilled") &&
      /^(execute|plan|sketch|eval|deliver|openQuestions|agentChat|global)\//.test(event.type)
    ) {
      const arg = event.meta?.arg;
      const projectId =
        typeof arg === "string"
          ? arg
          : arg && typeof arg === "object" && "projectId" in arg
            ? String(arg.projectId)
            : undefined;
      if (projectId && /\/fetch/.test(event.type)) {
        const taskId = arg && typeof arg === "object" && "taskId" in arg ? String(arg.taskId) : "";
        const reads: Record<string, readonly unknown[]> = {
          "plan/fetchPlanStatus/fulfilled": queryKeys.plans.status(projectId),
          "plan/fetchPlans/fulfilled": queryKeys.plans.list(projectId),
          "execute/fetchTasks/fulfilled": queryKeys.tasks.list(projectId),
          "execute/fetchExecutePlans/fulfilled": queryKeys.plans.list(projectId),
          "execute/fetchExecuteStatus/fulfilled": queryKeys.execute.status(projectId),
          "execute/fetchActiveAgents/fulfilled": queryKeys.agents.active(projectId),
          "execute/fetchTaskDetail/fulfilled": queryKeys.tasks.detail(projectId, taskId),
          "execute/fetchArchivedSessions/fulfilled": queryKeys.tasks.sessions(projectId, taskId),
          "sketch/fetchPrd/fulfilled": queryKeys.prd.detail(projectId),
          "sketch/fetchPrdHistory/fulfilled": queryKeys.prd.history(projectId),
          "sketch/fetchChat/fulfilled": queryKeys.chat.history(projectId, "sketch"),
          "eval/fetchFeedback/fulfilled": queryKeys.feedback.list(projectId),
          "deliver/fetchStatus/fulfilled": queryKeys.deliver.status(projectId),
          "deliver/fetchHistory/fulfilled": queryKeys.deliver.history(projectId),
          "openQuestions/fetchProject/fulfilled": queryKeys.notifications.project(projectId),
          "agentChat/fetchHistory/fulfilled": queryKeys.tasks.chatHistory(projectId, taskId),
          "agentChat/fetchSupport/fulfilled": queryKeys.tasks.chatSupport(projectId, taskId),
        };
        const key = reads[event.type];
        if (key) void qc.invalidateQueries({ queryKey: key });
        return result;
      }
      if (projectId)
        void qc.invalidateQueries({
          predicate: (query) =>
            query.queryKey.includes(projectId) &&
            !["presence", "access"].includes(String(query.queryKey[0])),
        });
      else if (event.type.startsWith("openQuestions/"))
        void qc.invalidateQueries({ queryKey: queryKeys.notifications.global() });
      else if (event.type.startsWith("global/"))
        void qc.invalidateQueries({ queryKey: queryKeys.agents.global() });
    }
    if (
      ["openQuestions/addNotification", "openQuestions/updateNotification"].includes(event.type)
    ) {
      const item = event.payload as Notification;
      const update = (old: Notification[] | undefined) => [
        item,
        ...(old ?? []).filter((n) => n.id !== item.id),
      ];
      qc.setQueryData(queryKeys.notifications.project(item.projectId), update);
      qc.setQueryData(queryKeys.notifications.global(), update);
    }
    if (event.type === "openQuestions/removeNotification") {
      const item = event.payload as { projectId: string; notificationId: string };
      const update = (old: Notification[] | undefined) =>
        old?.filter((n) => n.id !== item.notificationId);
      qc.setQueryData(queryKeys.notifications.project(item.projectId), update);
      qc.setQueryData(queryKeys.notifications.global(), update);
    }
  } catch {
    /* A standalone reducer test or early bootstrap has no QueryClient. */
  }
  return result;
};
