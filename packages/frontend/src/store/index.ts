import { configureStore } from "@reduxjs/toolkit";
import { useDispatch, useSelector } from "react-redux";
import projectReducer from "./slices/projectSlice";
import websocketReducer from "./slices/websocketSlice";
import dreamReducer from "./slices/dreamSlice";
import planReducer from "./slices/planSlice";
import buildReducer from "./slices/buildSlice";
import verifyReducer from "./slices/verifySlice";
import { websocketMiddleware } from "./middleware/websocketMiddleware";

export const store = configureStore({
  reducer: {
    project: projectReducer,
    websocket: websocketReducer,
    dream: dreamReducer,
    plan: planReducer,
    build: buildReducer,
    verify: verifyReducer,
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
