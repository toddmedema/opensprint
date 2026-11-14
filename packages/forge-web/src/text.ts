export function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function str(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

export function strOrNull(value: unknown): string | null {
  if (value == null) return null;
  const text = str(value).trim();
  return text ? text : null;
}

export function numOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

export function num(value: unknown, fallback = 0): number {
  return numOrNull(value) ?? fallback;
}

export function bool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

export function textList(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (typeof item === "number" || typeof item === "boolean") return String(item);
      const record = asRecord(item);
      for (const key of ["text", "prompt", "detail", "summary", "message", "body", "question"]) {
        const candidate = record[key];
        if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
      }
      return "";
    })
    .filter((item) => item.length > 0);
}

export function linesToList(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function parseJsonObject(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Proposal document must be JSON.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Proposal document must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "Time not reported";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

type ProbeRow = { command: string; exitCode: number; excerpt: string };

function probeRows(value: unknown): ProbeRow[] {
  if (Array.isArray(value)) return value.flatMap((item) => probeRows(item));
  const record = asRecord(value);
  if (Array.isArray(record.evidence)) return probeRows(record.evidence);
  const command = typeof record.command === "string" ? record.command.trim() : "";
  const exitRaw = record.exitCode;
  const exitCode =
    typeof exitRaw === "number" && Number.isFinite(exitRaw)
      ? exitRaw
      : typeof exitRaw === "string" && exitRaw.trim() && Number.isFinite(Number(exitRaw))
        ? Number(exitRaw)
        : null;
  const excerpt = typeof record.excerpt === "string" ? record.excerpt.trim() : "";
  if (!command || exitCode == null) return [];
  return [{ command, exitCode, excerpt }];
}

function probeSentence(row: ProbeRow): string {
  const sentence = `${row.command} exited ${row.exitCode}.`;
  if (!row.excerpt) return sentence;
  return row.excerpt.includes("\n") ? `${sentence}\n${row.excerpt}` : `${sentence} ${row.excerpt}`;
}

export function formatProbe(probe: unknown): string {
  if (probe == null || probe === "") return "No probe recorded.";
  if (typeof probe === "string") {
    const trimmed = probe.trim();
    return trimmed || "Probe could not be displayed.";
  }
  const rows = probeRows(probe);
  if (rows.length > 0) return rows.map(probeSentence).join("\n");
  const record = asRecord(probe);
  const parts: string[] = [];
  if (typeof record.ok === "boolean") parts.push(record.ok ? "Probe ok." : "Probe failed.");
  if (typeof record.status === "string" && record.status.trim()) parts.push(record.status.trim());
  if (typeof record.message === "string" && record.message.trim()) parts.push(record.message.trim());
  if (typeof record.summary === "string" && record.summary.trim()) parts.push(record.summary.trim());
  if (parts.length > 0) return parts.join(" ");
  return "Probe could not be displayed.";
}

export function questionSummary(summary: string): string {
  const trimmed = summary.trim();
  if (!trimmed.startsWith("{")) return summary;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return summary;
  }
  const record = asRecord(parsed);
  if (Array.isArray(parsed) || Object.keys(record).length === 0) return summary;
  const questions = textList(record.questions ?? record.question);
  const extras = Object.entries(record).filter(([key, value]) => {
    if (key === "questions" || key === "question") return false;
    if (value == null) return false;
    if (typeof value === "string") return value.trim().length > 0;
    if (typeof value === "number" || typeof value === "boolean") return true;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(asRecord(value)).length > 0;
    return false;
  });
  if (questions.length > 0 && extras.length === 0) return questions.join(" ");
  return summary;
}

export function prettyJson(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

export function cap(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function plural(name: string, count = 2): string {
  const word = name.trim();
  if (!word || count === 1) return word;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `key-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function toneForStatus(status: string): "tag-alert" | "tag-ok" | "tag-idle" {
  const text = status.trim().toLowerCase();
  if (["failed", "failure", "blocked", "error", "rejected", "reject"].includes(text)) {
    return "tag-alert";
  }
  if (
    [
      "passed",
      "pass",
      "ok",
      "clear",
      "cleared",
      "ready",
      "shipped",
      "done",
      "allowed",
      "allow_once",
      "unlocked",
      "merged",
      "success",
      "succeeded",
      "responding",
    ].includes(text)
  ) {
    return "tag-ok";
  }
  return "tag-idle";
}

const BLANK_FACT = new Set(["", "none", "nothing", "unassigned", "null", "undefined"]);

export function isBlankFact(value: string | null | undefined): boolean {
  if (value == null) return true;
  return BLANK_FACT.has(value.trim().toLowerCase());
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function diffGitPath(header: string): string | null {
  const line = header.trim();
  const marker = "diff --git ";
  if (!line.startsWith(marker)) return null;
  const sides = gitSides(line.slice(marker.length).trim());
  if (!sides) return null;
  const b = gitSidePath(sides[1], "b");
  const a = gitSidePath(sides[0], "a");
  if (b && !isDevNull(b)) return b;
  if (a && !isDevNull(a)) return a;
  return null;
}

function gitSides(body: string): [string, string] | null {
  const tokens = body.startsWith('"') ? quotedGitTokens(body) : body.split(/\s+/);
  if (tokens.length !== 2 || !tokens[0] || !tokens[1]) return null;
  return [tokens[0], tokens[1]];
}

function quotedGitTokens(body: string): string[] {
  return [...body.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((match) => unescapeGit(match[1] ?? ""));
}

function unescapeGit(value: string): string {
  return value.replace(/\\(.)/g, (_full, char: string) => {
    if (char === "n") return "\n";
    if (char === "t") return "\t";
    if (char === "r") return "\r";
    return char;
  });
}

function gitSidePath(token: string, side: "a" | "b"): string {
  if (token === "/dev/null") return token;
  const lead = `${side}/`;
  return token.startsWith(lead) ? token.slice(lead.length) : token;
}

function isDevNull(path: string): boolean {
  return path === "/dev/null" || path === "dev/null";
}
