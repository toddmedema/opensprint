import { createListenerMiddleware, isAnyOf } from "@reduxjs/toolkit";
import {
  clearAllByProject,
  clearAllGlobal,
  removeNotification,
} from "../slices/openQuestionsSlice";

/** Call Electron tray refresh when running in desktop so the menu bar icon dot updates immediately. */
function requestTrayRefresh(): void {
  if (typeof window !== "undefined" && window.electron?.refreshTray) {
    void window.electron.refreshTray();
  }
}

export const trayRefreshListener = createListenerMiddleware();

/** When user clears all notifications (by project or global), force-refresh the Mac menu bar tray icon so the dot is removed. */
trayRefreshListener.startListening({
  matcher: isAnyOf(
    clearAllByProject.fulfilled,
    clearAllGlobal.fulfilled
  ),
  effect: () => {
    requestTrayRefresh();
  },
});

/** When the last notification is removed (e.g. dismissed), force-refresh the tray icon so the dot is removed. */
trayRefreshListener.startListening({
  actionCreator: removeNotification,
  effect: (_action, listenerApi) => {
    const state = listenerApi.getState() as { openQuestions?: { global: unknown[] } };
    const global = state.openQuestions?.global ?? [];
    if (global.length === 0) {
      requestTrayRefresh();
    }
  },
});
