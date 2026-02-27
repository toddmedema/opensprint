import { createListenerMiddleware, isRejected, isFulfilled } from "@reduxjs/toolkit";
import type { SerializedError } from "@reduxjs/toolkit";
import { DEDUP_SKIP } from "../dedup";
import { addNotification } from "../slices/notificationSlice";
import { setConnectionError } from "../slices/connectionSlice";
import { clearDeliverToast } from "../slices/websocketSlice";
import { isConnectionError } from "../../api/client";

/** One-line actionable hints for known API error codes (backend ErrorCodes). */
export function getApiErrorHint(code: string | undefined): string | null {
  if (!code) return null;
  const hints: Record<string, string> = {
    NO_GATE_TASK: "Generate tasks first or add a gating task in Plan.",
    NO_EPIC: "Plan has no epic. Use Plan Tasks to generate tasks first.",
    AGENT_INVOKE_FAILED: "Check agent login or Project Settings → Agent Config.",
    AGENT_CLI_REQUIRED: "Install the agent CLI (see Project Settings → Agent Config).",
    CURSOR_API_ERROR: "Check Cursor agent login or API key in Project Settings.",
    ANTHROPIC_API_KEY_MISSING: "Add ANTHROPIC_API_KEY in Project Settings or .env.",
    ISSUE_NOT_FOUND: "Task or session may have been removed.",
    SESSION_NOT_FOUND: "Task or session may have been removed.",
    PROJECT_NOT_FOUND: "Project may have been removed.",
    PLAN_NOT_FOUND: "Plan may have been removed.",
  };
  return hints[code] ?? null;
}

/** Hints for errors identified by message content (e.g. git worktree conflicts). */
export function getMessageBasedHint(message: string): string | null {
  if (message.includes("active agent") && message.includes("worktree")) {
    return "Another task's agent is still using that branch. Wait for it to finish or restart the backend.";
  }
  if (message.includes("already used by worktree")) {
    return "Retry the task; the app will clean up the conflicting worktree. If it persists, restart the backend.";
  }
  return null;
}

/** Error codes for missing resources — do not flood the UI; show inline/error state instead. */
const QUIET_NOT_FOUND_CODES = new Set([
  "ISSUE_NOT_FOUND",
  "SESSION_NOT_FOUND",
  "PROJECT_NOT_FOUND",
  "PRD_NOT_FOUND",
]);

/** Clearer messages for thunks that reject with rejectWithValue (RTK default message is "Rejected"). */
const REJECTED_ACTION_MESSAGES: Record<string, string> = {
  "execute/updateTaskPriority/rejected":
    "Failed to update task priority. The change was reverted. Check the network and try again.",
  "execute/fetchTasks/rejected": "Failed to load tasks. Refresh the page or try again.",
  "project/fetchTasksFeedbackPlans/rejected":
    "Failed to load tasks, feedback, or plans. Refresh the page or try again.",
  "execute/fetchExecuteStatus/rejected":
    "Failed to load execute status. Refresh the page or try again.",
  "plan/fetchPlans/rejected": "Failed to load plans. Refresh the page or try again.",
  "deliver/fetchDeliverStatus/rejected":
    "Failed to load deliver status. Refresh the page or try again.",
  "deliver/fetchDeliverHistory/rejected":
    "Failed to load deliver history. Refresh the page or try again.",
};

/** Listens for rejected thunks and adds error notifications. */
export const notificationListener = createListenerMiddleware();

/** Thunk action type prefixes that perform API calls (fulfilled = server reachable). */
const API_THUNK_PREFIXES = [
  "project/",
  "sketch/",
  "plan/",
  "execute/",
  "eval/",
  "deliver/",
  "global/",
  "spec/",
  "prd/",
];

notificationListener.startListening({
  predicate: isRejected,
  effect: (action, listenerApi) => {
    // Skip dedup skips: not an error, just "another request already in flight"
    if (action.payload === DEDUP_SKIP) return;

    const error = action.error as SerializedError | undefined;
    const msg =
      error?.message ??
      (typeof action.payload === "string" ? action.payload : null) ??
      "An error occurred";
    const code = error?.code as string | undefined;
    const actionType = (action as { type?: string }).type;

    // Connection errors → single global banner, no per-request notifications
    if (isConnectionError(error ?? { message: msg })) {
      listenerApi.dispatch(setConnectionError(true));
      listenerApi.dispatch(clearDeliverToast());
      return;
    }

    // Skip notifications for missing task/session/project — common after archiving or reconciliation; would flood the UI.
    if (code && QUIET_NOT_FOUND_CODES.has(code)) return;
    if (typeof msg === "string" && /Issue .+ not found/.test(msg)) return;

    // Replace generic "Rejected" with an actionable message when we know the thunk
    const displayBase =
      msg === "Rejected" && actionType && REJECTED_ACTION_MESSAGES[actionType]
        ? REJECTED_ACTION_MESSAGES[actionType]
        : msg === "Rejected"
          ? "Something went wrong. Try again or refresh the page."
          : msg;
    const hint = getApiErrorHint(code) ?? getMessageBasedHint(msg);
    const displayMessage = hint && displayBase === msg ? `${msg} ${hint}` : displayBase;
    listenerApi.dispatch(addNotification({ message: displayMessage, severity: "error" }));
  },
});

/** Clear connection error when any API thunk succeeds (server is reachable). */
notificationListener.startListening({
  predicate: (action): boolean => {
    if (!isFulfilled(action)) return false;
    const type = (action as { type?: string }).type ?? "";
    return API_THUNK_PREFIXES.some((p) => type.startsWith(p));
  },
  effect: (_, listenerApi) => {
    listenerApi.dispatch(setConnectionError(false));
  },
});
