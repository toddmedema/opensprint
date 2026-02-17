import { configureStore } from "@reduxjs/toolkit";
import { useDispatch, useSelector } from "react-redux";
import projectReducer from "./slices/projectSlice";
import websocketReducer from "./slices/websocketSlice";
import specReducer from "./slices/specSlice";
import planReducer from "./slices/planSlice";
import executeReducer from "./slices/executeSlice";
import ensureReducer from "./slices/ensureSlice";
import deployReducer from "./slices/deploySlice";
import { websocketMiddleware } from "./middleware/websocketMiddleware";

export const store = configureStore({
  reducer: {
    project: projectReducer,
    websocket: websocketReducer,
    spec: specReducer,
    plan: planReducer,
    execute: executeReducer,
    ensure: ensureReducer,
    deploy: deployReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: ["ws/connect", "ws/disconnect", "ws/send"],
      },
    }).concat(websocketMiddleware),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();
