/**
 * Protected Path Policy — guards sensitive integration, OAuth, and token-handling
 * surfaces from unscoped modifications by Execute agents.
 *
 * Time: O(P * F) where P = number of protected patterns and F = number of changed files.
 * Space: O(1) auxiliary beyond input/output.
 */

export interface ProtectedPathPattern {
  /** Substring or prefix matched against file paths (case-insensitive). */
  pattern: string;
  /** Human-readable label for diagnostics. */
  label: string;
}

export interface ProtectedPathViolation {
  file: string;
  matchedPattern: ProtectedPathPattern;
}

export interface AuditResult {
  allowed: boolean;
  violations: ProtectedPathViolation[];
  /** True when the task scope explicitly unlocks protected paths. */
  scopeUnlocked: boolean;
}

export const PROTECTED_PATH_PATTERNS: ProtectedPathPattern[] = [
  { pattern: "routes/integrations-", label: "Integration routes" },
  { pattern: "integration-store", label: "Integration store service" },
  { pattern: "token-encryption", label: "Token encryption service" },
  { pattern: "routes/oauth", label: "OAuth routes" },
  { pattern: "todoist-sync", label: "Todoist sync service" },
];

/**
 * Scope values that unlock protected path edits. The open-ended ones are stems (`token-encrypt`
 * covers token-encryption); the rest match whole words, so "disintegration" unlocks nothing.
 */
export const SCOPE_UNLOCK_KEYWORDS: string[] = [
  "integration",
  "oauth",
  "todoist",
  "token-encrypt",
  "api-key-stor",
  "third-party-auth",
  "external-service",
  "connection-service",
  "connect-service",
];

const OPEN_ENDED_KEYWORDS = new Set(["token-encrypt", "api-key-stor", "third-party-auth"]);
const keywordPatterns = SCOPE_UNLOCK_KEYWORDS.map((keyword) => {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const end = OPEN_ENDED_KEYWORDS.has(keyword) ? "" : "s?(?![a-z])";
  return new RegExp(`(?<![a-z0-9])${escaped}${end}`);
});

function findProtectedPaths(changedFiles: string[]): ProtectedPathViolation[] {
  const violations: ProtectedPathViolation[] = [];
  for (const file of changedFiles) {
    const lower = file.toLowerCase();
    for (const pat of PROTECTED_PATH_PATTERNS) {
      if (lower.includes(pat.pattern)) {
        violations.push({ file, matchedPattern: pat });
        break;
      }
    }
  }
  return violations;
}

/** Mutable task wording, used where no enforced authority is at stake. */
export function auditProtectedPaths(
  changedFiles: string[],
  taskTitle: string,
  taskDescription: string
): AuditResult {
  const scopeText = `${taskTitle}\n${taskDescription}`.toLowerCase();
  const scopeUnlocked = keywordPatterns.some((pattern) => pattern.test(scopeText));
  const violations = findProtectedPaths(changedFiles);
  return { allowed: scopeUnlocked || violations.length === 0, violations, scopeUnlocked };
}

/**
 * Enforced authority: a human grant is a comma- or newline-separated list of exact scope values.
 * Prose never matches, so wording copied into a grant cannot widen it by containing a keyword.
 */
export function auditProtectedPathsForGrant(changedFiles: string[], grant: string): AuditResult {
  const values = new Set(grant.split(/[,\n]/).map((value) => value.trim().toLowerCase()));
  const scopeUnlocked = SCOPE_UNLOCK_KEYWORDS.some((keyword) => values.has(keyword));
  const violations = findProtectedPaths(changedFiles);
  return { allowed: scopeUnlocked || violations.length === 0, violations, scopeUnlocked };
}

/**
 * Build a human-readable summary of protected-path violations for prompt injection
 * or reviewer feedback.
 */
export function formatViolationSummary(violations: ProtectedPathViolation[]): string {
  if (violations.length === 0) return "";
  const lines = violations.map(
    (v) => `- \`${v.file}\` — matches protected pattern "${v.matchedPattern.label}"`
  );
  return (
    "The following files are protected by the Protected Path Policy and " +
    "should not be modified unless the task explicitly scopes integration or OAuth work:\n" +
    lines.join("\n")
  );
}
