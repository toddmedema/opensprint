/**
 * Serialize/deserialize the Sketch phase output (SPEC.md) to/from the Prd type.
 * SPEC.md is a flat markdown file at repo root with standard section headers.
 */

import type { Prd, PrdSection, PrdChangeLogEntry } from "./types/prd.js";

/** Map section keys to display headers in SPEC.md */
const SECTION_HEADERS: Record<string, string> = {
  executive_summary: "Executive Summary",
  problem_statement: "Problem Statement",
  user_personas: "User Personas",
  goals_and_metrics: "Goals and Success Metrics",
  feature_list: "Feature List",
  technical_architecture: "Technical Architecture",
  data_model: "Data Model",
  api_contracts: "API Contracts",
  non_functional_requirements: "Non-Functional Requirements",
  open_questions: "Open Questions",
};

/** Convert snake_case section key to display header (for dynamic sections). */
function sectionKeyToHeader(key: string): string {
  return SECTION_HEADERS[key] ?? key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Convert display header back to snake_case section key. */
function headerToSectionKey(header: string): string {
  const normalized = header.trim().toLowerCase().replace(/\s+/g, "_");
  const reverseMap: Record<string, string> = {};
  for (const [key, value] of Object.entries(SECTION_HEADERS)) {
    reverseMap[value.toLowerCase().replace(/\s+/g, "_")] = key;
  }
  return reverseMap[normalized] ?? normalized;
}

/** Serialize Prd to SPEC.md markdown. */
export function prdToSpecMarkdown(prd: Prd): string {
  const lines: string[] = ["# Product Specification", ""];
  const orderedKeys = Object.keys(prd.sections).sort((a, b) => {
    const order = Object.keys(SECTION_HEADERS);
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.localeCompare(b);
  });
  for (const key of orderedKeys) {
    const section = prd.sections[key];
    if (!section) continue;
    const content = (section.content ?? "").trim();
    lines.push(`## ${sectionKeyToHeader(key)}`, "");
    lines.push(content || "_No content yet_", "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Parse SPEC.md markdown into Prd. Sections are extracted by ## headers. */
export function specMarkdownToPrd(
  markdown: string,
  metadata?: { version: number; changeLog: PrdChangeLogEntry[] }
): Prd {
  const sections: Record<string, PrdSection> = {};
  const now = new Date().toISOString();

  // Split by ## headers (but not ###)
  const headerRe = /^##\s+(.+)$/gm;
  let lastIndex = 0;
  let lastKey: string | null = null;

  const normalizeContent = (raw: string): string =>
    raw.trim() === "_No content yet_" ? "" : raw.trim();

  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(markdown)) !== null) {
    if (lastKey !== null) {
      const content = normalizeContent(markdown.slice(lastIndex, match.index));
      sections[lastKey] = {
        content,
        version: 1,
        updatedAt: now,
      };
    }
    lastKey = headerToSectionKey(match[1]!);
    lastIndex = match.index + match[0].length;
  }
  if (lastKey !== null) {
    const content = normalizeContent(markdown.slice(lastIndex));
    sections[lastKey] = {
      content,
      version: 1,
      updatedAt: now,
    };
  }

  return {
    version: metadata?.version ?? 0,
    sections,
    changeLog: metadata?.changeLog ?? [],
  };
}
