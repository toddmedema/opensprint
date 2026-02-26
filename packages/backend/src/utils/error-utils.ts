/**
 * Extract a human-readable error message from an unknown error value.
 * @param err - The caught error (Error, string, or other)
 * @param fallback - Optional fallback when err is not an Error instance
 * @returns The error message string
 */
export function getErrorMessage(err: unknown, fallback?: string): string {
  if (err instanceof Error) return err.message;
  return fallback !== undefined ? fallback : String(err);
}

/** Shape commonly seen from exec/spawn and child process errors */
export interface ExecErrorShape {
  message?: string;
  stderr?: string;
  killed?: boolean;
  signal?: string;
}

/** Type guard and accessor for exec/spawn-style errors (message, stderr, killed, signal). */
export function getExecErrorShape(err: unknown): ExecErrorShape {
  if (err == null) return {};
  if (typeof err !== "object") return { message: String(err) };
  const o = err as Record<string, unknown>;
  return {
    message: typeof o.message === "string" ? o.message : undefined,
    stderr: typeof o.stderr === "string" ? o.stderr : undefined,
    killed: typeof o.killed === "boolean" ? o.killed : undefined,
    signal: typeof o.signal === "string" ? o.signal : undefined,
  };
}

/** Limit-error patterns for Anthropic and Cursor (429, rate limit, overloaded, add more tokens, quota exceeded). */
const LIMIT_ERROR_PATTERNS = [
  /429/,
  /rate\s*limit/i,
  /overloaded/i,
  /add\s+more\s+tokens/i,
  /quota\s+exceeded/i,
  /too\s+many\s+requests/i,
  /resource\s+exhausted/i,
];

/** Extract all string content from an error for limit-pattern matching. */
function getErrorStrings(err: unknown): string[] {
  const strings: string[] = [];
  if (err == null) return strings;
  if (typeof err === "string") return [err];
  if (err instanceof Error) {
    strings.push(err.message);
    return strings;
  }
  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    if (typeof o.message === "string") strings.push(o.message);
    if (typeof o.stderr === "string") strings.push(o.stderr);
    if (typeof o.statusText === "string") strings.push(o.statusText);
    if (typeof o.error === "string") strings.push(o.error);
    if (o.error && typeof o.error === "object" && typeof (o.error as Record<string, unknown>).message === "string") {
      strings.push((o.error as Record<string, unknown>).message as string);
    }
  }
  return strings;
}

/**
 * Detect limit-related API errors (429, rate limit, overloaded, add more tokens, quota exceeded).
 * Used by agent error handling to decide when to retry with a different API key.
 * Supports Anthropic SDK errors, Cursor CLI stderr, and HTTP-style errors.
 */
export function isLimitError(err: unknown): boolean {
  if (err == null) return false;

  // HTTP status 429
  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    const status = o.status ?? o.statusCode;
    if (status === 429 || status === "429") return true;
  }

  const toCheck = getErrorStrings(err).join(" ");
  if (!toCheck) return false;

  const lower = toCheck.toLowerCase();
  return LIMIT_ERROR_PATTERNS.some((re) => re.test(lower));
}
