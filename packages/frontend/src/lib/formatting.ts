/**
 * Generic formatting utilities for the frontend.
 */

/**
 * Converts snake_case to Title Case.
 * @example formatSectionKey("executive_summary") => "Executive Summary"
 */
export function formatSectionKey(key: string): string {
  return key
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Formats a timestamp as relative time ("5m ago", "2h ago") or locale date string.
 * @param ts ISO 8601 timestamp string
 */
/**
 * Formats elapsed time since startedAt as human-readable uptime (e.g., "2m 34s", "1h 2m 34s").
 * @param startedAt ISO 8601 timestamp string when the agent started
 * @param now Optional reference time (defaults to now). Used for live updates.
 */
export function formatUptime(startedAt: string, now: Date = new Date()): string {
  const start = new Date(startedAt).getTime();
  const diffMs = Math.max(0, now.getTime() - start);
  const totalSeconds = Math.floor(diffMs / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

/**
 * Formats a timestamp as relative time ("5m ago", "2h ago") or locale date string.
 * @param ts ISO 8601 timestamp string
 */
export function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}
