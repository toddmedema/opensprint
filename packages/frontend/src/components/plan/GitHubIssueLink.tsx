import type { PlanMetadata } from "@opensprint/shared";

/** Source links are constrained to the issue recorded in the plan's provenance. */
export function GitHubIssueLink({
  issue,
  compact = false,
}: {
  issue: PlanMetadata["githubIssue"];
  compact?: boolean;
}) {
  if (
    !issue ||
    !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(issue.repository) ||
    !Number.isSafeInteger(issue.number) ||
    issue.number < 1
  ) {
    return null;
  }
  const href = `https://github.com/${issue.repository}/issues/${issue.number}`;
  if (issue.url !== href) return null;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      className={
        compact
          ? "shrink-0 rounded bg-theme-surface-muted px-1.5 py-0.5 text-xs text-brand-600 hover:underline"
          : "text-sm text-brand-600 hover:underline break-all"
      }
      title={`Source: ${issue.repository} #${issue.number}`}
      aria-label={`GitHub ${issue.repository} #${issue.number} (opens in a new tab)`}
    >
      {compact ? `GitHub #${issue.number}` : `GitHub ${issue.repository} #${issue.number}`}
    </a>
  );
}
