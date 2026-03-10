/// <reference types="vite/client" />

declare global {
  interface Window {
    electron?: {
      isElectron: true;
      onOpenFindBar: (callback: () => void) => () => void;
      onFindResult: (callback: (result: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean }) => void) => () => void;
      findInPage: (text: string, options?: { forward?: boolean; findNext?: boolean; caseSensitive?: boolean }) => Promise<void>;
      stopFindInPage: (action: "clearSelection" | "keepSelection" | "activateSelection") => Promise<void>;
      refreshTray?: () => Promise<void>;
    };
  }
}

export {};
