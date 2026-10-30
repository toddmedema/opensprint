import type { Notification, ReviewCase } from "@opensprint/shared";

export function getGovernanceCaseId(notification: Notification): string {
  const metadata = notification.scopeChangeMetadata;
  return metadata && "caseId" in metadata && typeof metadata.caseId === "string"
    ? metadata.caseId
    : notification.sourceId;
}

export const OPEN_GOVERNANCE_CASE_STATES = new Set<ReviewCase["state"]>([
  "awaiting_reconsideration",
  "awaiting_judge",
  "awaiting_human",
  "evidence_requested",
  "stale",
]);

export const GOVERNANCE_CASE_LABELS: Record<ReviewCase["state"], string> = {
  awaiting_reconsideration: "Reviewer reconsidering",
  awaiting_judge: "With the judge",
  awaiting_human: "Waiting for your decision",
  evidence_requested: "More evidence requested",
  allowed: "Exception allowed",
  fix_required: "Fix required",
  cancelled: "Cancelled",
  stale: "Changed since review",
};
export function governanceCaseLabel(item: ReviewCase): string {
  return item.publishedRemediationOnly
    ? "Published · remediation required"
    : GOVERNANCE_CASE_LABELS[item.state];
}

export function formatGovernanceDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
