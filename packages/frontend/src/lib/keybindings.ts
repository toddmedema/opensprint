import { isMac } from "../utils/platform";

export interface KeyboardShortcutEntry {
  /** Human-readable action name */
  action: string;
  /** Key combination(s) to display (e.g. "1", "2", "Ctrl + Enter") */
  keys: string;
  /** Optional context when shortcut applies (e.g. "When in a project") */
  context?: string;
}

/**
 * Returns all keyboard shortcuts for display in Help and elsewhere.
 * Sourced from the same bindings used by GlobalKeyboardShortcuts and useSubmitShortcut
 * so the list stays accurate.
 */
export function getKeyboardShortcuts(): KeyboardShortcutEntry[] {
  const submitKeys = isMac()
    ? "Enter or ⌘ + Enter to submit · Shift+Enter for new line"
    : "Enter or Ctrl + Enter to submit · Shift+Enter for new line";

  return [
    { action: "Go to Sketch", keys: "1", context: "When in a project" },
    { action: "Go to Plan", keys: "2", context: "When in a project" },
    { action: "Go to Execute", keys: "3", context: "When in a project" },
    { action: "Go to Evaluate", keys: "4", context: "When in a project" },
    { action: "Go to Deliver", keys: "5", context: "When in a project" },
    { action: "Go to Home", keys: "` or ~" },
    { action: "Open Settings", keys: "Escape", context: "When no modal is open (Escape closes modal first)" },
    { action: "Open Help", keys: "? or F1" },
    { action: "Submit message", keys: submitKeys, context: "In chat or feedback input" },
  ];
}
