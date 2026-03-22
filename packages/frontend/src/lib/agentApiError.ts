export interface AgentApiFailureDetails {
  kind: "rate_limit" | "auth" | "out_of_credit" | "scope_compliance";
  agentType:
    | "claude"
    | "claude-cli"
    | "cursor"
    | "custom"
    | "openai"
    | "google"
    | "lmstudio"
    | "ollama";
  raw: string;
  userMessage: string;
  notificationMessage: string;
  isLimitError: boolean;
  retryAfterSeconds?: number;
  allKeysExhausted?: boolean;
}

const ACTIONABLE_AGENT_ERROR_CODES = new Set([
  "AGENT_INVOKE_FAILED",
  "ANTHROPIC_API_KEY_MISSING",
  "CURSOR_API_ERROR",
  "OPENAI_API_ERROR",
  "GOOGLE_API_ERROR",
]);

const RATE_LIMIT_PATTERNS = [
  /rate\s*limit/i,
  /quota\s+exceeded/i,
  /resource\s+exhausted/i,
  /too\s+many\s+requests/i,
];

const AUTH_PATTERNS = [/api\s*key/i, /unauthorized/i, /authentication/i, /invalid\s*token/i];
const OUT_OF_CREDIT_PATTERNS = [/out\s*of\s*credit/i, /billing/i, /insufficient\s*(quota|credit)/i];
const SCOPE_COMPLIANCE_PATTERNS = [/scope\s*compliance/i, /scope_compliance/i];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object";
}

function asFailureDetails(value: unknown): AgentApiFailureDetails | null {
  if (!isRecord(value)) return null;
  const { kind, agentType, raw, userMessage, notificationMessage, isLimitError } = value;
  if (
    (kind === "rate_limit" ||
      kind === "auth" ||
      kind === "out_of_credit" ||
      kind === "scope_compliance") &&
    (agentType === "claude" ||
      agentType === "claude-cli" ||
      agentType === "cursor" ||
      agentType === "custom" ||
      agentType === "openai" ||
      agentType === "google" ||
      agentType === "lmstudio" ||
      agentType === "ollama") &&
    typeof raw === "string" &&
    typeof userMessage === "string" &&
    typeof notificationMessage === "string" &&
    typeof isLimitError === "boolean"
  ) {
    return {
      kind,
      agentType,
      raw,
      userMessage,
      notificationMessage,
      isLimitError,
      ...(typeof value.retryAfterSeconds === "number"
        ? { retryAfterSeconds: value.retryAfterSeconds }
        : {}),
      ...(typeof value.allKeysExhausted === "boolean"
        ? { allKeysExhausted: value.allKeysExhausted }
        : {}),
    };
  }
  return null;
}

export function getAgentApiFailureDetails(value: unknown): AgentApiFailureDetails | null {
  const direct = asFailureDetails(value);
  if (direct) return direct;
  if (!isRecord(value)) return null;
  return asFailureDetails(value.details) ?? asFailureDetails(value.error) ?? null;
}

export function classifyAgentApiErrorMessage(
  message: string | null | undefined
): AgentApiFailureDetails["kind"] | null {
  if (!message) return null;
  if (SCOPE_COMPLIANCE_PATTERNS.some((pattern) => pattern.test(message))) {
    return "scope_compliance";
  }
  if (OUT_OF_CREDIT_PATTERNS.some((pattern) => pattern.test(message))) {
    return "out_of_credit";
  }
  if (AUTH_PATTERNS.some((pattern) => pattern.test(message))) {
    return "auth";
  }
  if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(message))) {
    return "rate_limit";
  }
  return null;
}

export function isNotificationManagedAgentFailure(value: unknown): boolean {
  const details = getAgentApiFailureDetails(value);
  if (details) return true;
  if (!isRecord(value)) return false;

  const code = typeof value.code === "string" ? value.code : undefined;
  const message = typeof value.message === "string" ? value.message : undefined;
  if (!code || !ACTIONABLE_AGENT_ERROR_CODES.has(code)) return false;
  return classifyAgentApiErrorMessage(message) != null;
}

export function getRejectedActionProjectId(action: unknown): string | null {
  if (!isRecord(action) || !isRecord(action.meta)) return null;
  const arg = action.meta.arg;
  if (typeof arg === "string") return arg;
  if (isRecord(arg) && typeof arg.projectId === "string") return arg.projectId;
  return null;
}
