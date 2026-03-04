/** Truncate output_log and git_diff at this size (100KB). */
export const LOG_DIFF_TRUNCATE_AT_CHARS = 102_400;

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
