/**
 * Utilities for parsing and serializing plan markdown content.
 * Plan content typically has a first-line heading (# Title) and body.
 * Per PRD §7.2.3, only a single # (level-1 heading) is the plan title;
 * ## and ### are section headers (Overview, Acceptance Criteria, etc.) and must not
 * be used as the plan title.
 */

export function parsePlanContent(content: string): { title: string; body: string } {
  const trimmed = content?.trim() ?? "";
  if (!trimmed) {
    return { title: "", body: "" };
  }
  const lines = trimmed.split("\n");
  const first = lines[0] ?? "";
  // Only match single # (level-1 heading) as plan title; ## Overview etc. are section headers
  const titleMatch = first.match(/^#\s+(.*)$/);
  let title: string;
  let body: string;
  if (titleMatch) {
    title = titleMatch[1].trim();
    body = lines.slice(1).join("\n").trimStart();
  } else if (first.match(/^#+\s/)) {
    // ## or ### etc. — section header, not plan title; fall back to empty so caller uses formatPlanIdAsTitle
    title = "";
    body = lines.join("\n").trimStart();
  } else {
    title = first.trim();
    body = lines.slice(1).join("\n").trimStart();
  }
  return { title, body };
}

/** Extract display title from plan content (first heading) or fallback to planId. */
export function getEpicTitleFromPlan(plan: {
  content: string;
  metadata: { planId: string };
}): string {
  const firstLine = plan.content.split("\n")[0] ?? "";
  const heading = firstLine.replace(/^#+\s*/, "").trim();
  if (heading) return heading;
  return plan.metadata.planId.replace(/-/g, " ");
}

/**
 * Returns a short overview from plan content: first maxSentences sentences of the body.
 * Used as subtext when all tasks are done (e.g. on the Evaluate plan review card).
 * Strips leading markdown headers (e.g. "## Overview") and returns empty string if no body.
 */
export function getPlanOverview(content: string, maxSentences = 2): string {
  const { body } = parsePlanContent(content ?? "");
  const trimmed = body.trim();
  if (!trimmed) return "";
  // Strip leading ## / ### lines so we get prose, not section headers
  const withoutLeadingHeaders = trimmed.replace(/^(#+\s+[^\n]*\n?)+/, "").trim();
  const prose = withoutLeadingHeaders || trimmed;
  // Split on sentence boundaries (. ! ? followed by space or end)
  const sentences = prose.match(/[^.!?]+[.!?]?\s*/g) ?? [];
  const selected = sentences.slice(0, maxSentences);
  const overview = selected.join("").trim();
  return overview || trimmed.slice(0, 200).trim();
}

export function serializePlanContent(title: string, body: string): string {
  const trimmedTitle = title.trim();
  const trimmedBody = body.trim();
  if (!trimmedTitle && !trimmedBody) return "";
  if (!trimmedTitle) return trimmedBody;
  if (!trimmedBody) return `# ${trimmedTitle}`;
  return `# ${trimmedTitle}\n\n${trimmedBody}`;
}

/** Section from plan body: ## Title and its content (no leading ## line in content). */
export interface PlanBodySection {
  title: string;
  content: string;
}

/**
 * Splits plan body by ## section headers. Content before the first ## goes into an "Overview" section.
 * If there are no ## headers, returns a single section with title "Overview" and the full body.
 */
export function parsePlanBodySections(body: string): PlanBodySection[] {
  const trimmed = (body ?? "").trim();
  if (!trimmed) {
    return [{ title: "Overview", content: "" }];
  }
  const sections: PlanBodySection[] = [];
  const lines = trimmed.split("\n");
  let currentTitle = "Overview";
  let currentLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = line.match(/^##\s+(.+)$/);
    if (match) {
      if (currentLines.length > 0) {
        sections.push({
          title: currentTitle,
          content: currentLines.join("\n").trim(),
        });
      }
      currentTitle = match[1].trim() || "Section";
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  sections.push({
    title: currentTitle,
    content: currentLines.join("\n").trim(),
  });
  return sections;
}

/**
 * Joins section titles and content back into plan body (## Title\n\ncontent).
 */
export function serializePlanBodySections(sections: PlanBodySection[]): string {
  return sections
    .map((s) => {
      const t = s.title.trim() || "Section";
      const c = (s.content ?? "").trim();
      return c ? `## ${t}\n\n${c}` : `## ${t}`;
    })
    .join("\n\n");
}
