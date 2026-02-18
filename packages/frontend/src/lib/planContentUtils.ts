/**
 * Utilities for parsing and serializing plan markdown content.
 * Plan content typically has a first-line heading (# Title) and body.
 * Per PRD §7.2.3, only a single # (level-1 heading) is the plan title;
 * ## and ### are section headers (Overview, Acceptance Criteria, etc.) and must not
 * be used as the plan title.
 */

export function parsePlanContent(content: string): { title: string; body: string } {
  if (!content?.trim()) {
    return { title: "", body: "" };
  }
  const lines = content.split("\n");
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

export function serializePlanContent(title: string, body: string): string {
  const trimmedTitle = title.trim();
  const trimmedBody = body.trim();
  if (!trimmedTitle && !trimmedBody) return "";
  if (!trimmedTitle) return trimmedBody;
  if (!trimmedBody) return `# ${trimmedTitle}`;
  return `# ${trimmedTitle}\n\n${trimmedBody}`;
}
