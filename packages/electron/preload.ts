import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electron", {
  isElectron: true,
  platform: process.platform,
  onNavigateHelp: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("navigate-help", handler);
    return () => ipcRenderer.removeListener("navigate-help", handler);
  },
  onNavigateSettings: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("navigate-settings", handler);
    return () => ipcRenderer.removeListener("navigate-settings", handler);
  },
  onOpenFindBar: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("open-find-bar", handler);
    return () => ipcRenderer.removeListener("open-find-bar", handler);
  },
  onFindResult: (
    callback: (result: {
      activeMatchOrdinal: number;
      matches: number;
      finalUpdate: boolean;
    }) => void
  ) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      result: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean }
    ) => callback(result);
    ipcRenderer.on("find-result", handler);
    return () => ipcRenderer.removeListener("find-result", handler);
  },
  findInPage: (
    text: string,
    options?: { forward?: boolean; findNext?: boolean; caseSensitive?: boolean }
  ) => ipcRenderer.invoke("find-in-page", text, options ?? {}),
  stopFindInPage: (action: "clearSelection" | "keepSelection" | "activateSelection") =>
    ipcRenderer.invoke("stop-find-in-page", action),
  refreshTray: () => ipcRenderer.invoke("refresh-tray"),
  restartApp: () => ipcRenderer.invoke("restart-app"),
  checkPrerequisitesFresh: () =>
    ipcRenderer.invoke("prerequisites:checkFresh") as Promise<{
      missing: string[];
      path?: string;
      platform: string;
    }>,
  restartBackendWithPath: (pathOverride?: string) =>
    ipcRenderer.invoke("backend:restartWithPath", pathOverride) as Promise<void>,
  checkForUpdates: () =>
    ipcRenderer.invoke("updater:checkForUpdates") as Promise<{
      lastCheckTimestamp: string | null;
    }>,
  getUpdateStatus: () =>
    ipcRenderer.invoke("updater:getStatus") as Promise<{
      version: string;
      lastCheckTimestamp: string | null;
    }>,
  minimizeWindow: () => ipcRenderer.invoke("window-minimize"),
  maximizeWindow: () => ipcRenderer.invoke("window-maximize"),
  closeWindow: () => ipcRenderer.invoke("window-close"),
  getWindowMaximized: () => ipcRenderer.invoke("window-is-maximized") as Promise<boolean>,
  onWindowMaximized: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("window-maximized", handler);
    return () => ipcRenderer.removeListener("window-maximized", handler);
  },
  onWindowUnmaximized: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("window-unmaximized", handler);
    return () => ipcRenderer.removeListener("window-unmaximized", handler);
  },
});
