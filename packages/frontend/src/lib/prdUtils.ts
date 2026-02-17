/**
 * PRD-related utility functions.
 */

import { PRD_SECTION_ORDER } from "./constants";

/**
 * Parses PRD API response into a flat Record<sectionKey, content>.
 */
export function parsePrdSections(prd: unknown): Record<string, string> {
  const data = prd as { sections?: Record<string, { content: string }> };
  const content: Record<string, string> = {};
  if (data?.sections) {
    for (const [key, section] of Object.entries(data.sections)) {
      content[key] = section.content;
    }
  }
  return content;
}

/**
 * Returns section keys in canonical order, with unknown sections appended.
 */
export function getOrderedSections(prdContent: Record<string, string>): string[] {
  const orderSet = new Set<string>(PRD_SECTION_ORDER);
  const ordered = PRD_SECTION_ORDER.filter((k) => prdContent[k]);
  const rest = Object.keys(prdContent).filter((k) => !orderSet.has(k));
  return [...ordered, ...rest];
}
