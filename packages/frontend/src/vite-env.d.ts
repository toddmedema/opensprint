/// <reference types="vite/client" />

declare global {
  interface Window {
    /** Injected inline into index.html by the desktop backend (CSP nonce; OPENSPRINT_DESKTOP). */
    __OPENSPRINT_LOCAL_SESSION__?: string;
    /** Set by the dedicated guest listener; changes routing only and grants no authority. */
    __OPENSPRINT_COLLABORATION_GUEST__?: boolean;
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
      openInEditor?: (
        folderPath: string,
        editor?: "vscode" | "cursor" | "auto"
      ) => Promise<{
        success: boolean;
        editor: string;
        method: "cli" | "uri";
        error?: string;
      }>;
    };
  }
}

export {};
