/**
 * Markdown ↔ HTML conversion for WYSIWYG PRD section editing.
 * Contenteditable uses HTML; API stores markdown.
 */

import { marked } from "marked";
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

/**
 * Converts markdown to HTML for display in contenteditable.
 * Marked v15+ returns Promise; we support both sync (legacy) and async.
 */
export async function markdownToHtml(md: string): Promise<string> {
  if (!md?.trim()) return "";
  const result = await marked.parse(md.trim());
  const html = typeof result === "string" ? result : "";
  // Trim leading/trailing whitespace to avoid spurious blank space at top of rendered content
  return html.trim();
}

/**
 * Converts HTML from contenteditable to markdown for API save.
 */
export function htmlToMarkdown(html: string): string {
  if (!html?.trim()) return "";
  return turndown.turndown(html.trim());
}
