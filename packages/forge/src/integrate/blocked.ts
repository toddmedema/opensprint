const PLATFORM_PATTERNS = [
  /(^|\/)\.env$/,
  /(^|\/)\.env\.[^/]+$/,
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)id_rsa$/,
  /(^|\/)id_ed25519$/,
  /(^|\/)credentials\.json$/i,
  /(^|\/)routes\/integrations-/,
  /integration-store/,
  /token-encryption/,
  /(^|\/)routes\/oauth(\/|$)/,
  /todoist-sync/,
];

export const SEEDED_RULE_PATHS = [
  ".env",
  ".env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa",
  "**/id_ed25519",
  "**/credentials.json",
  "**/routes/integrations-*",
  "**/integration-store*",
  "**/token-encryption*",
  "**/routes/oauth/**",
  "**/todoist-sync*",
];

export function globToRegExp(pattern: string): RegExp {
  let source = "^";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 3;
        continue;
      }
      source += ".*";
      index += 2;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      index += 1;
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    index += 1;
  }
  source += "$";
  return new RegExp(source);
}

export function pathMatches(file: string, pattern: string): boolean {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  return globToRegExp(pattern).test(normalized);
}

export function isPlatformProtected(file: string): boolean {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  return PLATFORM_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isBlockedPath(file: string, runbookPatterns: string[]): boolean {
  return isPlatformProtected(file) || runbookPatterns.some((pattern) => pathMatches(file, pattern));
}

export function redactDiff(diff: string, patterns: string[]): string {
  const lines = diff.split("\n");
  const output: string[] = [];
  let redacting = false;
  for (const line of lines) {
    const fileHeader = /^diff --git a\/(.+?) b\//.exec(line);
    if (fileHeader) {
      redacting = isBlockedPath(fileHeader[1] ?? "", patterns);
      output.push(line);
      if (redacting) output.push("[redacted]");
      continue;
    }
    if (!redacting) output.push(line);
  }
  return output.join("\n");
}
