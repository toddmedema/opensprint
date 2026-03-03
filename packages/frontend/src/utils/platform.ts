export type PlatformFamily = "windows" | "mac" | "linux" | "unknown";

/**
 * Detects the user's platform family for shell/UI differences.
 * Uses navigator.platform, navigator.userAgent, and navigator.userAgentData when available.
 */
export function getPlatformFamily(): PlatformFamily {
  if (typeof navigator === "undefined") return "unknown";
  const platform = navigator.platform?.toLowerCase() ?? "";
  const ua = navigator.userAgent?.toLowerCase() ?? "";
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const uaDataPlatform = uaData?.platform?.toLowerCase() ?? "";

  if (
    platform.includes("win") ||
    ua.includes("windows") ||
    uaDataPlatform === "windows"
  ) {
    return "windows";
  }

  if (platform.includes("mac") || ua.includes("mac") || uaDataPlatform === "macos") {
    return "mac";
  }

  if (
    platform.includes("linux") ||
    ua.includes("linux") ||
    uaDataPlatform === "linux"
  ) {
    return "linux";
  }

  return "unknown";
}

/**
 * Detects if the user is on macOS for keyboard shortcut display.
 */
export function isMac(): boolean {
  return getPlatformFamily() === "mac";
}

/**
 * Returns the keyboard shortcut label for submitting (multiline: Enter or Cmd/Ctrl+Enter; Shift+Enter for newline).
 * - macOS: "Enter or Cmd + Enter to submit · Shift+Enter for new line"
 * - Windows/Linux/other: "Enter or Ctrl + Enter to submit · Shift+Enter for new line"
 */
export function getSubmitShortcutLabel(): string {
  return isMac()
    ? "Enter or Cmd + Enter to submit · Shift+Enter for new line"
    : "Enter or Ctrl + Enter to submit · Shift+Enter for new line";
}
