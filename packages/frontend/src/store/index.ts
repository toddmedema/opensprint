import { configureStore } from "@reduxjs/toolkit";
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
import routeReducer from "./slices/routeSlice";
import { websocketMiddleware } from "./middleware/websocketMiddleware";
import { agentOutputFilterMiddleware } from "./middleware/agentOutputFilterMiddleware";
import { notificationListener } from "./listeners/notificationListener";
import { planTasksListener } from "./listeners/planTasksListener";
import { executeListeners } from "./listeners/executeListeners";

export const store = configureStore({
  reducer: {
    project: projectReducer,
    global: globalReducer,
    websocket: websocketReducer,
    connection: connectionReducer,
    sketch: sketchReducer,
    plan: planReducer,
    execute: executeReducer,
    eval: evalReducer,
    deliver: deliverReducer,
    notification: notificationReducer,
    openQuestions: openQuestionsReducer,
    route: routeReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: ["ws/connect", "ws/disconnect", "ws/send"],
      },
    })
      .concat(websocketMiddleware, agentOutputFilterMiddleware)
      .prepend(
        notificationListener.middleware,
        planTasksListener.middleware,
        executeListeners.middleware
      ),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();
