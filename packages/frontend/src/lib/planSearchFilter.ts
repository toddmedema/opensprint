import type { Plan } from "@opensprint/shared";
import { getEpicTitleFromPlan } from "./planContentUtils";

/**
 * Returns true if the plan matches the search query (case-insensitive).
 * Matches against plan/epic title (from content H1 or planId) and description (content).
 */
export function matchesPlanSearchQuery(plan: Plan, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const title = getEpicTitleFromPlan(plan).toLowerCase();
  const content = (plan.content ?? "").toLowerCase();
  const issue = plan.metadata.githubIssue;
  const source = issue ? `github ${issue.repository} #${issue.number}`.toLowerCase() : "";
  return title.includes(q) || content.includes(q) || source.includes(q);
}
