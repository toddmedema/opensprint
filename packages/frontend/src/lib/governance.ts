import type {
  GovernanceSummary,
  Notification,
  PolicyRelease,
  ReviewCaseSummary,
} from "@opensprint/shared";

export function getGovernanceCaseId(notification: Notification): string {
  const metadata = notification.scopeChangeMetadata;
  return metadata && "caseId" in metadata && typeof metadata.caseId === "string"
    ? metadata.caseId
    : notification.sourceId;
}

export const OPEN_GOVERNANCE_CASE_STATES = new Set<ReviewCaseSummary["state"]>([
  "awaiting_reconsideration",
  "awaiting_judge",
  "awaiting_human",
  "evidence_requested",
  "stale",
]);

/** Open states that wait on a person. Other open states are still with an agent. */
const HUMAN_ACTIONABLE_CASE_STATES = new Set<ReviewCaseSummary["state"]>([
  "awaiting_human",
  "evidence_requested",
  "stale",
]);
export function isHumanActionableCase(item: ReviewCaseSummary): boolean {
  return Boolean(item.humanCancelled) || HUMAN_ACTIONABLE_CASE_STATES.has(item.state);
}
export function isAgentHeldCase(item: ReviewCaseSummary): boolean {
  return OPEN_GOVERNANCE_CASE_STATES.has(item.state) && !isHumanActionableCase(item);
}

/** Optimistic-concurrency failures only. Validation and other conflicts never match. */
const GOVERNANCE_STALE_ERROR_CODES = new Set(["GOVERNANCE_STALE_VERSION", "GOVERNANCE_STALE_CODE"]);
export function isGovernanceStaleError(error: { code: string }): boolean {
  return GOVERNANCE_STALE_ERROR_CODES.has(error.code);
}
export function governanceAuthorityReason(details: unknown): string | undefined {
  return details !== null &&
    typeof details === "object" &&
    "reason" in details &&
    typeof details.reason === "string"
    ? details.reason
    : undefined;
}

export function revokedGovernanceReleaseIds(summary: GovernanceSummary): Set<string> {
  return new Set(
    summary.events
      .filter((event) => event.kind === "release_revoked")
      .map((event) => String(event.payload.releaseId))
  );
}
/** Mirrors the server: a rollback target was activated before and has not been revoked. */
export function restorableGovernanceReleases(summary: GovernanceSummary): PolicyRelease[] {
  const revoked = revokedGovernanceReleaseIds(summary);
  const activated = new Set(
    summary.events
      .filter((event) => event.kind === "release_activated")
      .map((event) => String(event.payload.releaseId))
  );
  return summary.releases.filter(
    (release) =>
      release.id !== summary.activeReleaseId &&
      activated.has(release.id) &&
      !revoked.has(release.id)
  );
}
/** Published but never activated, newest first. Release IDs are random, so order by createdAt. */
export function pendingInitialReleases(summary: GovernanceSummary): PolicyRelease[] {
  const revoked = revokedGovernanceReleaseIds(summary);
  return summary.releases
    .filter((release) => release.id !== summary.activeReleaseId && !revoked.has(release.id))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export const GOVERNANCE_CASE_LABELS: Record<ReviewCaseSummary["state"], string> = {
  awaiting_reconsideration: "In progress · reviewer reconsidering",
  awaiting_judge: "In progress · with the judge",
  awaiting_human: "Waiting for your decision",
  evidence_requested: "More evidence requested",
  allowed: "Exception allowed",
  fix_required: "Fix required",
  cancelled: "Cancelled",
  stale: "Changed since review",
};
export function governanceCaseLabel(item: ReviewCaseSummary): string {
  return item.publishedRemediationOnly
    ? "Published · remediation required"
    : GOVERNANCE_CASE_LABELS[item.state];
}

export function formatGovernanceDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
