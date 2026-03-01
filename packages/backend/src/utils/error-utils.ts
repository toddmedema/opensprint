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

/** Limit-error patterns for Anthropic, Cursor, and OpenAI (429, rate_limit_exceeded, rate limit, RateLimitError, quota_exceeded, insufficient_quota, overloaded, add more tokens). */
const LIMIT_ERROR_PATTERNS = [
  /429/,
  /rate_limit_exceeded/i,
  /rate\s*limit/i,
  /ratelimiterror/i,
  /overloaded/i,
  /add\s+more\s+tokens/i,
  /quota\s+exceeded/i,
  /quota_exceeded/i,
  /insufficient_quota/i,
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
    if (typeof o.code === "string") strings.push(o.code);
    if (typeof o.error === "string") strings.push(o.error);
    if (o.error && typeof o.error === "object") {
      const errObj = o.error as Record<string, unknown>;
      if (typeof errObj.message === "string") strings.push(errObj.message);
      if (typeof errObj.code === "string") strings.push(errObj.code);
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

/** Auth-error patterns (401, invalid token, unauthorized, authentication). */
const AUTH_ERROR_PATTERNS = [
  /401/,
  /api\s*key.*invalid|invalid.*api\s*key/i,
  /unauthorized/i,
  /authentication\s*required/i,
  /invalid\s*token/i,
  /authentication\s*failed/i,
];

/**
 * Detect auth-related API errors (401, invalid token, unauthorized).
 * Used to surface human-blocked notifications for API key / token issues.
 */
export function isAuthError(err: unknown): boolean {
  if (err == null) return false;

  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    const status = o.status ?? o.statusCode;
    if (status === 401 || status === "401") return true;
  }

  const toCheck = getErrorStrings(err).join(" ");
  if (!toCheck) return false;

  const lower = toCheck.toLowerCase();
  return AUTH_ERROR_PATTERNS.some((re) => re.test(lower));
}

/** Out-of-credit / quota patterns (distinct from rate limit — requires user to add credits). */
const OUT_OF_CREDIT_PATTERNS = [
  /out\s*of\s*credit/i,
  /insufficient\s*(quota|credit|balance)/i,
  /payment\s*required/i,
  /billing/i,
  /credit\s*balance/i,
  /add\s+more\s+tokens/i,
];

/**
 * Detect out-of-credit / billing-related API errors.
 * Used to surface human-blocked notifications when user needs to add credits.
 */
export function isOutOfCreditError(err: unknown): boolean {
  if (err == null) return false;

  const toCheck = getErrorStrings(err).join(" ");
  if (!toCheck) return false;

  const lower = toCheck.toLowerCase();
  return OUT_OF_CREDIT_PATTERNS.some((re) => re.test(lower));
}

/** Classification for agent API failures — used for human-blocked notifications. */
export type AgentApiErrorKind = "rate_limit" | "auth" | "out_of_credit";

/**
 * Classify an error as an agent API failure type.
 * Returns the kind for human-blocked notifications, or null if not API-related.
 * Order: auth first (invalid token), then out_of_credit, then rate_limit.
 */
export function classifyAgentApiError(err: unknown): AgentApiErrorKind | null {
  if (err == null) return null;
  if (isAuthError(err)) return "auth";
  if (isOutOfCreditError(err)) return "out_of_credit";
  if (isLimitError(err)) return "rate_limit";
  return null;
}
