/// <reference types="vite/client" />

declare global {
  interface Window {
    electron?: {
      isElectron: true;
      platform?: string;
      onNavigateHelp: (callback: () => void) => () => void;
      onNavigateSettings: (callback: () => void) => () => void;
      onOpenFindBar: (callback: () => void) => () => void;
      onFindResult: (
        callback: (result: {
          activeMatchOrdinal: number;
          matches: number;
          finalUpdate: boolean;
        }) => void
      ) => () => void;
      findInPage: (
        text: string,
        options?: { forward?: boolean; findNext?: boolean; caseSensitive?: boolean }
      ) => Promise<void>;
      stopFindInPage: (
        action: "clearSelection" | "keepSelection" | "activateSelection"
      ) => Promise<void>;
      refreshTray?: () => Promise<void>;
      restartApp?: () => Promise<void>;
      checkPrerequisitesFresh?: () => Promise<{
        missing: string[];
        path?: string;
        platform: string;
      }>;
      restartBackendWithPath?: (pathOverride?: string) => Promise<void>;
      checkForUpdates?: () => Promise<{ lastCheckTimestamp: string | null }>;
      getUpdateStatus?: () => Promise<{
        version: string;
        lastCheckTimestamp: string | null;
      }>;
      minimizeWindow?: () => Promise<void>;
      maximizeWindow?: () => Promise<void>;
      closeWindow?: () => Promise<void>;
      getWindowMaximized?: () => Promise<boolean>;
      onWindowMaximized?: (callback: () => void) => () => void;
      onWindowUnmaximized?: (callback: () => void) => () => void;
    };
  }
}

export {};
