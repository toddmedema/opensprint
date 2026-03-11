function containsKeyDeep(value: unknown, requiredKey: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsKeyDeep(item, requiredKey));
  }

  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, requiredKey)) {
    return true;
  }

  return Object.values(record).some((item) => containsKeyDeep(item, requiredKey));
}

function escapeUnescapedControlCharsInStrings(input: string): string {
  let output = "";
  let inString = false;
  let escaping = false;
  let changed = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (!inString) {
      output += ch;
      if (ch === '"') {
        inString = true;
      }
      continue;
    }

    if (escaping) {
      output += ch;
      escaping = false;
      continue;
    }

    if (ch === "\\") {
      output += ch;
      escaping = true;
      continue;
    }

    if (ch === '"') {
      output += ch;
      inString = false;
      continue;
    }

    if (ch === "\n") {
      output += "\\n";
      changed = true;
      continue;
    }
    if (ch === "\r") {
      output += "\\r";
      changed = true;
      continue;
    }
    if (ch === "\t") {
      output += "\\t";
      changed = true;
      continue;
    }

    const code = ch.charCodeAt(0);
    if (code >= 0 && code <= 0x1f) {
      output += `\\u${code.toString(16).padStart(4, "0")}`;
      changed = true;
      continue;
    }

    output += ch;
  }

  return changed ? output : input;
}

function parseJsonCandidate<T>(candidate: string): T | null {
  try {
    return JSON.parse(candidate) as T;
  } catch {
    // Some agents emit JSON-like objects with raw newlines in string values.
    const repaired = escapeUnescapedControlCharsInStrings(candidate);
    if (repaired === candidate) return null;
    try {
      return JSON.parse(repaired) as T;
    } catch {
      return null;
    }
  }
}

/**
 * Extract and parse a JSON object from AI agent response content.
 * Scans left-to-right for balanced JSON object candidates and parses each
 * candidate in encounter order, ignoring braces that appear inside strings.
 */
export function extractJsonFromAgentResponse<T>(content: string, requiredKey?: string): T | null {
  if (!content) return null;

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];

    if (start >= 0) {
      if (escaping) {
        escaping = false;
        continue;
      }

      if (ch === "\\") {
        if (inString) escaping = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === "{") {
        depth += 1;
        continue;
      }

      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = content.slice(start, i + 1);
          const parsed = parseJsonCandidate<T>(candidate);
          if (parsed && (!requiredKey || containsKeyDeep(parsed, requiredKey))) {
            return parsed;
          }
          start = -1;
          inString = false;
          escaping = false;
        }
        continue;
      }

      continue;
    }

    if (ch === "{") {
      start = i;
      depth = 1;
      inString = false;
      escaping = false;
    }
  }

  return null;
}

/**
 * Extract and parse a JSON array from AI agent response content.
 * Scans left-to-right for balanced JSON array candidates, ignoring brackets inside strings.
 * Use when the agent returns an array with leading/trailing text (e.g. "Here are the items:\n[...]").
 */
export function extractJsonArrayFromAgentResponse<T>(content: string): T[] | null {
  if (!content) return null;

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];

    if (start >= 0) {
      if (escaping) {
        escaping = false;
        continue;
      }

      if (ch === "\\") {
        if (inString) escaping = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === "[" || ch === "{") {
        depth += 1;
        continue;
      }

      if (ch === "]" || ch === "}") {
        depth -= 1;
        if (depth === 0 && content[start] === "[") {
          const candidate = content.slice(start, i + 1);
          const parsed = parseJsonCandidate<T[]>(candidate);
          if (parsed && Array.isArray(parsed)) {
            return parsed;
          }
          start = -1;
          inString = false;
          escaping = false;
        }
        continue;
      }

      continue;
    }

    if (ch === "[") {
      start = i;
      depth = 1;
      inString = false;
      escaping = false;
    }
  }

  return null;
}
