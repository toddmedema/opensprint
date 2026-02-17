/**
 * Utilities for parsing and serializing plan markdown content.
 * Plan content typically has a first-line heading (# Title) and body.
 */

export function parsePlanContent(content: string): { title: string; body: string } {
  if (!content?.trim()) {
    return { title: "", body: "" };
  }
  const lines = content.split("\n");
  const first = lines[0] ?? "";
  const titleMatch = first.match(/^#+\s*(.*)$/);
  const title = titleMatch ? titleMatch[1].trim() : first.trim();
  const body = titleMatch ? lines.slice(1).join("\n").trimStart() : lines.slice(1).join("\n").trimStart();
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
