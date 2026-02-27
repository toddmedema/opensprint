/** localStorage key for "Don't show kill agent confirmation again" preference */
export const KILL_AGENT_CONFIRM_STORAGE_KEY = "opensprint.killAgentConfirmDisabled";

/** Returns true if user chose to skip the kill-agent confirmation dialog. */
export function getKillAgentConfirmDisabled(): boolean {
  if (typeof window === "undefined") return false;
  const stored = localStorage.getItem(KILL_AGENT_CONFIRM_STORAGE_KEY);
  return stored === "true";
}

/** Persists the preference to skip (true) or show (false) the kill-agent confirmation dialog. */
export function setKillAgentConfirmDisabled(disabled: boolean): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(KILL_AGENT_CONFIRM_STORAGE_KEY, String(disabled));
}
