const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(token|password|secret|authorization)\b\s*[:=]\s*\S+/gi,
  /Bearer\s+\S+/gi,
];

export function redactText(text: string, secrets: string[] = []): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    redacted = redacted.split(secret).join("[redacted]");
  }
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[redacted]");
  }
  if (redacted.length > 2000) return `${redacted.slice(0, 2000)}…`;
  return redacted;
}

export const STRIPPED_ENV = [
  "TOKEN_ENCRYPTION_KEY",
  "OPENSPRINT_OWNER_KEY",
  "OPENSPRINT_SESSION_SECRET",
  "OPENSPRINT_REPLAY_IMAGE",
] as const;

export function sanitizedEnv(
  base: NodeJS.ProcessEnv,
  secrets: string[],
  extra: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv {
  const secretValues = new Set(secrets.filter((value) => value.length > 0));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value !== "string") continue;
    if ((STRIPPED_ENV as readonly string[]).includes(key)) continue;
    if (secretValues.has(value)) continue;
    env[key] = value;
  }
  for (const key of STRIPPED_ENV) delete env[key];
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    if ((STRIPPED_ENV as readonly string[]).includes(key)) continue;
    env[key] = value;
  }
  return env;
}
