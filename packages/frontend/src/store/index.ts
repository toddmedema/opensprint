import { configureStore, combineReducers } from "@reduxjs/toolkit";
import { useDispatch, useSelector } from "react-redux";
import projectReducer from "./slices/projectSlice";
import globalReducer from "./slices/globalSlice";
import websocketReducer from "./slices/websocketSlice";
import connectionReducer from "./slices/connectionSlice";
import sketchReducer from "./slices/sketchSlice";
import planReducer from "./slices/planSlice";
import executeReducer from "./slices/executeSlice";
import evalReducer from "./slices/evalSlice";
import deliverReducer from "./slices/deliverSlice";
import notificationReducer from "./slices/notificationSlice";
import openQuestionsReducer from "./slices/openQuestionsSlice";
import unreadPhaseReducer from "./slices/unreadPhaseSlice";
import agentChatReducer from "./slices/agentChatSlice";
import { websocketMiddleware } from "./middleware/websocketMiddleware";
import { agentOutputFilterMiddleware } from "./middleware/agentOutputFilterMiddleware";
import { notificationListener } from "./listeners/notificationListener";
import { planTasksListener } from "./listeners/planTasksListener";
import { executeListeners } from "./listeners/executeListeners";
import { trayRefreshListener } from "./listeners/trayRefreshListener";
import { transientReducer, serverStateMiddleware } from "./serverState";

export const rootReducer = combineReducers({
  project: projectReducer,
  global: transientReducer(globalReducer, ["globalActiveAgents", "hasProjects"]),
  websocket: websocketReducer,
  connection: connectionReducer,
  sketch: transientReducer(sketchReducer, ["messages", "prdContent", "prdHistory"]),
  plan: transientReducer(planReducer, [
    "plans",
    "planHierarchyCache",
    "dependencyGraph",
    "chatMessages",
    "planStatus",
  ]),
  execute: transientReducer(executeReducer, [
    "tasksById",
    "taskIdsOrder",
    "orchestratorRunning",
    "awaitingApproval",
    "activeTasks",
    "activeAgents",
    "taskIdToStartedAt",
    "totalDone",
    "totalFailed",
    "queueDepth",
    "baselineStatus",
    "baselineCheckedAt",
    "baselineFailureSummary",
    "mergeValidationStatus",
    "mergeValidationFailureSummary",
    "dispatchPausedReason",
    "selfImprovementRunInProgress",
    "selfImprovementRunMode",
    "gitMergeQueue",
    "archivedSessions",
  ]),
  eval: transientReducer(evalReducer, ["feedback", "feedbackItemCache"]),
  deliver: transientReducer(deliverReducer, ["history", "currentDeploy", "activeDeployId"]),
  notification: notificationReducer,
  openQuestions: transientReducer(openQuestionsReducer, ["byProject", "global"]),
  unreadPhase: unreadPhaseReducer,
  agentChat: agentChatReducer,
});
export const store = configureStore({
  reducer: rootReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: ["ws/connect", "ws/disconnect", "ws/send"],
      },
    })
      .concat(serverStateMiddleware, websocketMiddleware, agentOutputFilterMiddleware)
      .prepend(
        notificationListener.middleware,
        planTasksListener.middleware,
        executeListeners.middleware,
        trayRefreshListener.middleware
      ),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();
