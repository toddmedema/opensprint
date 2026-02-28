import type { DbClient } from "../db/client.js";

/** Default threshold (100KB) when no existing entries to compute 95th percentile. */
export const DEFAULT_LOG_DIFF_THRESHOLD = 102_400;

/** Minimum threshold (1KB) to avoid over-aggressive truncation. */
const MIN_THRESHOLD = 1024;

/**
 * Compute the 95th percentile of output_log and git_diff sizes from agent_sessions.
 * Uses combined sizes from both columns. Returns default when table is empty.
 */
export async function computeLogDiff95thPercentile(client: DbClient): Promise<number> {
  const sizes: number[] = [];

  const outputRows = await client.query(
    "SELECT LENGTH(output_log)::int as len FROM agent_sessions WHERE output_log IS NOT NULL AND output_log != ''"
  );
  for (const row of outputRows) {
    const len = row.len as number;
    if (typeof len === "number" && len > 0) sizes.push(len);
  }

  const diffRows = await client.query(
    "SELECT LENGTH(git_diff)::int as len FROM agent_sessions WHERE git_diff IS NOT NULL AND git_diff != ''"
  );
  for (const row of diffRows) {
    const len = row.len as number;
    if (typeof len === "number" && len > 0) sizes.push(len);
  }

  if (sizes.length === 0) return DEFAULT_LOG_DIFF_THRESHOLD;

  sizes.sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil(0.95 * sizes.length) - 1);
  const p95 = sizes[idx] ?? DEFAULT_LOG_DIFF_THRESHOLD;
  return Math.max(p95, MIN_THRESHOLD);
}

const TRUNCATION_SUFFIX = "\n\n... [truncated]";

/**
 * Truncate a string to the given character threshold. Returns null for null/undefined.
 * When truncated, appends a suffix indicating truncation.
 */
export function truncateToThreshold(
  value: string | null | undefined,
  threshold: number
): string | null {
  if (value == null || value === "") return value === "" ? "" : null;
  if (value.length <= threshold) return value;
  return value.slice(0, threshold) + TRUNCATION_SUFFIX;
}
