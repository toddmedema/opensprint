import type { NotificationSource, ApiBlockedErrorCode } from "@opensprint/shared";

/** Poll interval (ms) for notifications dropdown. */
export const NOTIFICATION_POLL_INTERVAL_MS = 5000;

export const NOTIFICATION_SOURCE_LABELS: Record<NotificationSource, string> = {
  plan: "Plan",
  prd: "PRD/Sketch",
  execute: "Execute",
  eval: "Evaluate",
};

/** Human-readable labels for API-blocked error types. */
export const API_BLOCKED_LABELS: Record<ApiBlockedErrorCode, string> = {
  rate_limit: "Rate limit",
  auth: "Invalid API key",
  out_of_credit: "Out of credit",
};

export function truncatePreview(text: string, maxLen = 60): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trim() + "…";
}

export function formatNotificationTimestamp(createdAt: string): string {
  const date = new Date(createdAt);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}
