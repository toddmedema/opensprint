import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electron", {
  isElectron: true,
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
  onFindResult: (callback: (result: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean }) => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      result: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean }
    ) => callback(result);
    ipcRenderer.on("find-result", handler);
    return () => ipcRenderer.removeListener("find-result", handler);
  },
  findInPage: (text: string, options?: { forward?: boolean; findNext?: boolean; caseSensitive?: boolean }) =>
    ipcRenderer.invoke("find-in-page", text, options ?? {}),
  stopFindInPage: (action: "clearSelection" | "keepSelection" | "activateSelection") =>
    ipcRenderer.invoke("stop-find-in-page", action),
  refreshTray: () => ipcRenderer.invoke("refresh-tray"),
});
